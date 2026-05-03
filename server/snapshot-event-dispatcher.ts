import { db } from "./db";
import { eq, and, desc } from "drizzle-orm";
import {
  activePositions,
  tokenFingerprintSnapshots,
  tokenDataPool,
} from "@shared/schema";
import { calculateAllocation } from "./position-allocator";
import { positionExitManager } from "./position-exit-manager";

interface PositionDecision {
  action: "open" | "hold" | "adjust" | "sell";
  reason: string;
  allocation?: number;
  trajectoryScore?: number;
  confidence?: number;
}

/**
 * Handle snapshot event - evaluate if position should open/adjust/sell
 */
export async function onSnapshotCreated(
  tokenMint: string,
  userId: number
): Promise<PositionDecision | null> {
  try {
    // Get latest snapshot
    const snapshots = await db
      .select()
      .from(tokenFingerprintSnapshots)
      .where(eq(tokenFingerprintSnapshots.tokenMint, tokenMint))
      .orderBy(desc(tokenFingerprintSnapshots.timestamp))
      .limit(1);

    if (!snapshots || snapshots.length === 0) {
      return null;
    }

    const snapshot = snapshots[0];
    const trajectoryData = (snapshot.trajectoryAnchored || {}) as any;

    // Check if we already have a position open for this token
    const existingPosition = await db
      .select()
      .from(activePositions)
      .where(and(eq(activePositions.userId, userId), eq(activePositions.tokenMint, tokenMint)))
      .limit(1);

    if (existingPosition && existingPosition.length > 0) {
      // Position already open - evaluate if we should adjust or exit
      return await evaluateOpenPosition(existingPosition[0], snapshot, userId);
    } else {
      // No position yet - evaluate if we should open one
      return await evaluateOpenNewPosition(tokenMint, snapshot, userId);
    }
  } catch (error) {
    console.error(`[SnapshotDispatcher] Error processing snapshot for ${tokenMint}:`, error);
    return null;
  }
}

/**
 * Evaluate whether to open a new position
 */
async function evaluateOpenNewPosition(
  tokenMint: string,
  snapshot: any,
  userId: number
): Promise<PositionDecision | null> {
  try {
    const trajectoryData = (snapshot.trajectoryAnchored || {}) as any;

    // Extract key metrics from snapshot
    const clusterMatch = snapshot.clusterMatch || 0;
    const trajectoryScore = calculateTrajectoryScore(trajectoryData) as number;
    const confidence = snapshot.confidence || 0;

    // Decision thresholds
    const MIN_CONFIDENCE = 0.70;
    const MIN_TRAJECTORY = 0.6;
    const MIN_CLUSTER_MATCH = 0.70;

    // Check if we meet minimum thresholds
    if (clusterMatch < MIN_CLUSTER_MATCH) {
      return {
        action: "hold",
        reason: `Cluster match too low: ${(clusterMatch * 100).toFixed(0)}% < ${(MIN_CLUSTER_MATCH * 100).toFixed(0)}%`,
        confidence: clusterMatch,
        trajectoryScore,
      };
    }

    if (confidence < MIN_CONFIDENCE) {
      return {
        action: "hold",
        reason: `Confidence too low: ${(confidence * 100).toFixed(0)}% < ${(MIN_CONFIDENCE * 100).toFixed(0)}%`,
        confidence,
        trajectoryScore,
      };
    }

    if (trajectoryScore < MIN_TRAJECTORY) {
      return {
        action: "hold",
        reason: `Trajectory score too low: ${trajectoryScore.toFixed(2)} < ${MIN_TRAJECTORY.toFixed(2)}`,
        confidence,
        trajectoryScore,
      };
    }

    // Get user's current balance (from paper trading fund)
    const userFund = await getUserFund(userId);
    if (!userFund || userFund.balance <= 0) {
      return {
        action: "hold",
        reason: "Insufficient fund balance",
      };
    }

    // Calculate allocation
    const allocation = await calculateAllocation(
      userId,
      userFund.balance,
      clusterMatch,
      trajectoryScore
    );

    // Get token data for entry price
    const tokenData = await db
      .select()
      .from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, tokenMint))
      .limit(1);

    if (!tokenData || !tokenData[0]) {
      return {
        action: "hold",
        reason: "No token data available",
      };
    }

    const entryPrice = tokenData[0].priceUsd || 0;
    const tokenSymbol = tokenData[0].tokenSymbol || tokenMint.slice(0, 8);

    // Open position
    const positionId = await createPosition(
      userId,
      tokenMint,
      tokenSymbol,
      allocation.totalAllocation,
      entryPrice,
      clusterMatch,
      trajectoryScore,
      trajectoryData,
      snapshot
    );

    return {
      action: "open",
      reason: `Opening position: ${allocation.reason}`,
      allocation: allocation.totalAllocation,
      confidence: clusterMatch,
      trajectoryScore,
    };
  } catch (error) {
    console.error(
      `[SnapshotDispatcher] Error evaluating new position for ${tokenMint}:`,
      error
    );
    return null;
  }
}

/**
 * Evaluate open position - check if we should adjust TSL or exit
 */
async function evaluateOpenPosition(
  position: any,
  snapshot: any,
  userId: number
): Promise<PositionDecision> {
  try {
    const trajectoryData = (snapshot.trajectoryAnchored || {}) as any;
    const newTrajectoryScore = calculateTrajectoryScore(trajectoryData);

    // Check if trajectory has collapsed (>50% negative outcomes)
    const negativeOutcomes = sumNegativeOutcomes(trajectoryData);

    if (negativeOutcomes > 0.5) {
      // Exit with moonbag
      const result = await positionExitManager.exitPosition(
        position.id,
        "trajectory_collapse",
        snapshot.lastPrice || 0,
        userId
      );

      return {
        action: "sell",
        reason: `Trajectory collapse: ${(negativeOutcomes * 100).toFixed(0)}% probability of downtrend`,
      };
    }

    // Update position with new trajectory data (no TSL adjustment, just state update)
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(activePositions)
      .set({
        currentTrajectoryScore: newTrajectoryScore,
        currentConfidence: snapshot.confidence || position.currentConfidence,
        lastSnapshotAt: now,
        updatedAt: now,
      })
      .where(eq(activePositions.id, position.id));

    // Determine action based on trajectory change
    const trajectoryDelta = newTrajectoryScore - position.currentTrajectoryScore;

    if (trajectoryDelta > 0.1) {
      return {
        action: "adjust",
        reason: `Trajectory improved: +${trajectoryDelta.toFixed(2)}, holding`,
        trajectoryScore: newTrajectoryScore,
      };
    } else if (trajectoryDelta < -0.15) {
      return {
        action: "adjust",
        reason: `Trajectory degraded: ${trajectoryDelta.toFixed(2)}, monitoring closely`,
        trajectoryScore: newTrajectoryScore,
      };
    } else {
      return {
        action: "hold",
        reason: `Holding position, trajectory stable`,
        trajectoryScore: newTrajectoryScore,
      };
    }
  } catch (error) {
    console.error(`[SnapshotDispatcher] Error evaluating open position:`, error);
    return {
      action: "hold",
      reason: "Error evaluating position",
    };
  }
}

/**
 * Create a new active position
 */
async function createPosition(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  entrySol: number,
  entryPrice: number,
  clusterMatch: number,
  trajectoryScore: number,
  trajectoryData: any,
  snapshot: any
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .insert(activePositions)
    .values({
      userId,
      tokenMint,
      tokenSymbol,
      entrySol,
      entryPrice,
      entryMultiplier: 1.0,
      entryTokenAmount: entrySol / entryPrice,
      entryClusters: [
        {
          cluster: snapshot.primaryCluster || "unknown",
          confidence: clusterMatch,
          trajectoryScore,
        },
      ],
      entryTrajectorySummary: trajectoryData,
      currentConfidence: clusterMatch,
      currentTrajectoryScore: trajectoryScore,
      tslCurrentPercent: getClusterBaseTSL(snapshot.primaryCluster || "unknown"),
      highestPrice: entryPrice,
      highestPriceReachedAt: now,
      openedAt: now,
      lastSnapshotAt: now,
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: activePositions.id });

  console.log(
    `[SnapshotDispatcher] Opened position ${result[0].id} for ${tokenMint} (${entrySol.toFixed(4)} SOL)`
  );

  return result[0].id;
}

/**
 * Get cluster-specific base TSL percentage
 */
function getClusterBaseTSL(cluster: string): number {
  const tslMap: Record<string, number> = {
    spike_and_bleed: 15,
    slow_moon: 20,
    late_bloomer: 25,
    pump_dump: 10,
    shaky_climb: 18,
    organic_growth: 22,
  };

  return tslMap[cluster] || 15;
}

/**
 * Calculate trajectory score from outcome distribution
 */
function calculateTrajectoryScore(trajectoryData: Record<string, number>): number {
  if (!trajectoryData || typeof trajectoryData !== "object") return 0;

  const score =
    (trajectoryData.pump_100x || 0) * 1.0 +
    (trajectoryData.pump_10x || 0) * 0.5 +
    (trajectoryData.pump_5x || 0) * 0.3 +
    (trajectoryData.pump_2x_sustained || 0) * 0.2 +
    (trajectoryData.pump_2x_quick || 0) * 0.1 -
    ((trajectoryData.crash_fast || 0) + (trajectoryData.crash_90 || 0)) * 0.5;

  return Math.max(0, score);
}

/**
 * Sum negative outcome probabilities
 */
function sumNegativeOutcomes(trajectoryData: Record<string, number>): number {
  if (!trajectoryData || typeof trajectoryData !== "object") return 0;

  return (
    (trajectoryData.crash_fast || 0) +
    (trajectoryData.crash_90 || 0) +
    (trajectoryData.crash_95 || 0) +
    (trajectoryData.crash_99 || 0) +
    (trajectoryData.rug_pull || 0) +
    (trajectoryData.slow_bleed || 0) +
    (trajectoryData.deathbed_signal || 0)
  );
}

/**
 * Get user's fund balance
 */
async function getUserFund(userId: number): Promise<any> {
  // This should come from paper trading fund session
  // For now, return dummy data - would integrate with system-picks-fund.ts
  return {
    balance: 1.0, // placeholder
    sessionId: "default",
  };
}

export { PositionDecision };
