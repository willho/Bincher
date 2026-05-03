import { db } from "./db";
import { activePositions, tokenSnapshots } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { calculateAllocation } from "./position-allocator";
import { getLearnedParameters, getDefaultTsl, getDefaultTrajectoryThreshold } from "./retrolearner-phase-d";

interface SnapshotForDispatch {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  priceUsd: number;
  capturedAt: number;
}

export async function onSnapshotCreated(snapshot: SnapshotForDispatch): Promise<void> {
  // For now, this is a stub that gets called when snapshots are created
  // In full implementation, this would:
  // 1. Match snapshot against token clusters
  // 2. Calculate confidence and trajectory score
  // 3. Decide to open position or exit existing position
  // 4. Record entry/exit metadata for retrolearner
  // 5. Update token leaderboard with trajectory scores

  // Stub implementation - placeholder for snapshot event handling
  try {
    // TODO: implement snapshot evaluation logic
    // Phase B Hook: Update token leaderboard once cluster matching is available
    // const outcomes = await matchAgainstClusters(snapshot);
    // if (outcomes) {
    //   const { updateTokenLeaderboard } = await import("./token-trajectory-scoring");
    //   await updateTokenLeaderboard(
    //     snapshot.tokenMint,
    //     snapshot.tokenSymbol,
    //     outcomes,
    //     snapshotCount,
    //     snapshot.priceUsd,
    //     ageSeconds
    //   );
    // }
  } catch (err) {
    console.error("[SnapshotDispatcher] Error in snapshot event handler:", err);
  }
}

export function calculateTrajectoryScore(
  outcomeDistribution: {
    pump_100x?: number;
    pump_50x?: number;
    pump_10x?: number;
    pump_5x?: number;
    pump_2x?: number;
    pump_2x_quick?: number;
    crash_fast?: number;
    slow_bleed?: number;
    deathbed?: number;
  }
): number {
  // Unbounded trajectory score favoring moonshot potential
  const score =
    (outcomeDistribution.pump_100x || 0) * 1.0 +
    (outcomeDistribution.pump_50x || 0) * 0.8 +
    (outcomeDistribution.pump_10x || 0) * 0.6 +
    (outcomeDistribution.pump_5x || 0) * 0.4 +
    (outcomeDistribution.pump_2x || 0) * 0.2 +
    (outcomeDistribution.pump_2x_quick || 0) * 0.1 -
    (outcomeDistribution.crash_fast || 0) * 0.5 -
    (outcomeDistribution.slow_bleed || 0) * 0.3 -
    (outcomeDistribution.deathbed || 0) * 0.2;

  return Math.max(0, score);
}

export function sumNegativeOutcomes(
  outcomeDistribution: {
    pump_100x?: number;
    pump_50x?: number;
    pump_10x?: number;
    pump_5x?: number;
    pump_2x?: number;
    pump_2x_quick?: number;
    crash_fast?: number;
    slow_bleed?: number;
    deathbed?: number;
  }
): number {
  return (outcomeDistribution.crash_fast || 0) + (outcomeDistribution.slow_bleed || 0) + (outcomeDistribution.deathbed || 0);
}

export async function evaluateOpenNewPosition(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  entrySol: number,
  entryPrice: number,
  clusterMatches: Array<{ cluster: string; confidence: number; trajectoryScore: number }>,
  aggregateConfidence: number,
  trajectoryScore: number,
  currentBalance: number,
  baseAllocationPerPosition: number,
  apeBudget: number
): Promise<{ opened: boolean; allocationSol?: number; reason: string }> {
  // Check if confidence and trajectory meet thresholds
  if (aggregateConfidence < 0.7 || trajectoryScore < 0.6) {
    return {
      opened: false,
      reason: `Confidence ${aggregateConfidence.toFixed(2)} or trajectory ${trajectoryScore.toFixed(2)} below threshold`,
    };
  }

  // Calculate allocation (with learned ape budget multiplier from primary cluster)
  const primaryClusterType = clusterMatches.length > 0 ? clusterMatches[0].cluster : undefined;
  const allocation = await calculateAllocation(
    userId,
    currentBalance,
    aggregateConfidence,
    trajectoryScore,
    baseAllocationPerPosition,
    apeBudget,
    primaryClusterType
  );

  if (allocation.allocationSol < 0.01) {
    return {
      opened: false,
      reason: "Allocation too small after budget constraints",
    };
  }

  // Create position record
  const now = Math.floor(Date.now() / 1000);

  // Get learned TSL from retrolearner, or use default based on primary cluster
  let learnedTsl = 15;
  if (clusterMatches.length > 0) {
    const primaryCluster = clusterMatches[0].cluster;
    const learned = await getLearnedParameters(primaryCluster);
    learnedTsl = learned.tslPercent;
  }

  try {
    await db.insert(activePositions).values({
      userId,
      tokenMint,
      tokenSymbol,
      entrySol: allocation.allocationSol,
      entryPrice,
      entryClusters: clusterMatches,
      currentConfidence: aggregateConfidence,
      currentTrajectoryScore: trajectoryScore,
      tslCurrentPercent: learnedTsl, // Use learned TSL from retrolearner
      highestPrice: entryPrice,
      openedAt: now,
      createdAt: now,
    });

    return {
      opened: true,
      allocationSol: allocation.allocationSol,
      reason: "Position opened based on cluster match and trajectory",
    };
  } catch (err) {
    console.error("[SnapshotDispatcher] Failed to create position:", err);
    return {
      opened: false,
      reason: "Database error creating position",
    };
  }
}

export async function evaluateOpenPosition(
  userId: number,
  positionId: number,
  tokenMint: string,
  negativeOutcomeProbability: number,
  currentPrice: number,
  newTrajectoryScore: number,
  newConfidence: number
): Promise<{ shouldExit: boolean; reason: string }> {
  // Get current position
  const position = await db
    .select()
    .from(activePositions)
    .where(eq(activePositions.id, positionId))
    .limit(1);

  if (position.length === 0) {
    return {
      shouldExit: false,
      reason: "Position not found",
    };
  }

  const pos = position[0];

  // Update highest price for TSL calculation
  if (currentPrice > (pos.highestPrice || 0)) {
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(activePositions)
      .set({
        highestPrice: currentPrice,
        currentTrajectoryScore: newTrajectoryScore,
        currentConfidence: newConfidence,
        lastSnapshotAt: now,
        updatedAt: now,
      })
      .where(eq(activePositions.id, positionId));
  }

  // Get learned trajectory threshold from retrolearner for this position's cluster
  let trajectoryExitThreshold = 0.5; // Default threshold
  if (pos.entryClusters && Array.isArray(pos.entryClusters)) {
    const clusters = pos.entryClusters as Array<{ cluster: string }>;
    if (clusters.length > 0) {
      const learned = await getLearnedParameters(clusters[0].cluster);
      trajectoryExitThreshold = learned.trajectoryThreshold;
    }
  }

  // Exit trigger: negative outcome probability exceeds learned threshold
  if (negativeOutcomeProbability > trajectoryExitThreshold) {
    return {
      shouldExit: true,
      reason: `Trajectory collapse: ${(negativeOutcomeProbability * 100).toFixed(0)}% negative outcome probability (threshold: ${(trajectoryExitThreshold * 100).toFixed(0)}%)`,
    };
  }

  return {
    shouldExit: false,
    reason: "Position trajectory acceptable, holding",
  };
}

export async function checkTSLExit(positionId: number, currentPrice: number): Promise<{ shouldExit: boolean; reason: string }> {
  const position = await db
    .select()
    .from(activePositions)
    .where(eq(activePositions.id, positionId))
    .limit(1);

  if (position.length === 0) {
    return {
      shouldExit: false,
      reason: "Position not found",
    };
  }

  const pos = position[0];
  const tslPercent = pos.tslCurrentPercent || 15;
  const tslLevel = (pos.highestPrice || 0) * (1 - tslPercent / 100);

  if (currentPrice < tslLevel) {
    return {
      shouldExit: true,
      reason: `TSL hit: price ${currentPrice.toFixed(6)} below TSL level ${tslLevel.toFixed(6)} (${tslPercent}%)`,
    };
  }

  return {
    shouldExit: false,
    reason: "Price above TSL level",
  };
}

export async function checkTimeStop(positionId: number, maxHoldMinutes: number): Promise<{ shouldExit: boolean; reason: string }> {
  const position = await db
    .select()
    .from(activePositions)
    .where(eq(activePositions.id, positionId))
    .limit(1);

  if (position.length === 0) {
    return {
      shouldExit: false,
      reason: "Position not found",
    };
  }

  const pos = position[0];
  const now = Math.floor(Date.now() / 1000);
  const holdSeconds = now - pos.openedAt;
  const holdMinutes = holdSeconds / 60;

  if (holdMinutes > maxHoldMinutes) {
    return {
      shouldExit: true,
      reason: `Time stop: held for ${holdMinutes.toFixed(0)} minutes, exceeds max ${maxHoldMinutes}`,
    };
  }

  return {
    shouldExit: false,
    reason: `Time check ok: ${holdMinutes.toFixed(0)} / ${maxHoldMinutes} minutes`,
  };
}

export async function checkTakeProfit(positionId: number, currentPrice: number, targetMultiplier: number = 5.0): Promise<{ shouldExit: boolean; reason: string }> {
  const position = await db
    .select()
    .from(activePositions)
    .where(eq(activePositions.id, positionId))
    .limit(1);

  if (position.length === 0) {
    return {
      shouldExit: false,
      reason: "Position not found",
    };
  }

  const pos = position[0];
  const entryPricePerToken = pos.entryPrice || 0;
  const currentMultiplier = currentPrice / entryPricePerToken;

  if (currentMultiplier >= targetMultiplier) {
    return {
      shouldExit: true,
      reason: `Take profit: ${currentMultiplier.toFixed(2)}x current (target ${targetMultiplier}x)`,
    };
  }

  return {
    shouldExit: false,
    reason: `Profit check ok: ${currentMultiplier.toFixed(2)}x current`,
  };
}
