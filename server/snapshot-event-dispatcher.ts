import { db } from "./db";
import { activePositions, tokenSnapshots, positionBudgets } from "@shared/schema";
import { eq, desc, isNull, and } from "drizzle-orm";
import { calculateAllocation } from "./position-allocator";
import { getLearnedParameters, getDefaultTsl, getDefaultTrajectoryThreshold } from "./retrolearner-phase-d";
import { isAutoTradingEnabled } from "./warmup-gate";

interface SnapshotForDispatch {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  priceUsd: number;
  capturedAt: number;
}

export async function onSnapshotCreated(snapshot: SnapshotForDispatch): Promise<void> {
  try {
    // Get full snapshot record with fingerprint data
    const snapshotRecord = await db
      .select()
      .from(tokenSnapshots)
      .where(eq(tokenSnapshots.id, snapshot.id))
      .limit(1);

    if (!snapshotRecord.length) {
      console.warn(`[SnapshotDispatcher] Snapshot ${snapshot.id} not found in DB`);
      return;
    }

    const fullSnapshot = snapshotRecord[0];
    const fingerprint = fullSnapshot.fingerprintVector as number[];
    if (!fingerprint || fingerprint.length === 0) {
      console.warn(`[SnapshotDispatcher] No fingerprint vector for ${snapshot.tokenMint}`);
      return;
    }

    // Match snapshot to clusters
    const { clusterSnapshotToArchetype } = await import("./fingerprint-cluster-management");
    const clusterResult = await clusterSnapshotToArchetype({
      tokenMint: snapshot.tokenMint,
      fingerprintVector: fingerprint,
      tokenAgeMinutes: fullSnapshot.tokenAgeMinutes || 0,
      medianMultiplier: fullSnapshot.medianMultiplier || 1.0,
    });

    // Get cluster type from primary match for retrolearner tracking
    let clusterType = "unknown";
    if (clusterResult.matches.length > 0) {
      clusterType = clusterResult.matches[0].clusterId;
    }

    // Get trajectory score and negative outcome probability
    const trajectoryScore = calculateTrajectoryScore(clusterResult.blendedOutcomes);
    const negativeOutcomeProbability = sumNegativeOutcomes(clusterResult.blendedOutcomes);
    const aggregateConfidence = clusterResult.matches.length > 0
      ? (clusterResult.matches[0].similarity || 0.5) * (1 - clusterResult.confidencePenalty)
      : 0.3;

    console.log(
      `[SnapshotDispatcher] ${snapshot.tokenSymbol}: clusters=${clusterResult.matches.length}, ` +
      `confidence=${aggregateConfidence.toFixed(2)}, trajectory=${trajectoryScore.toFixed(2)}, negative=${negativeOutcomeProbability.toFixed(2)}`
    );

    // Determine which user to trade for (from env config, defaults to 1 for system picks)
    const userId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);

    // Check if position already exists for this token
    const existingPosition = await db
      .select()
      .from(activePositions)
      .where(eq(activePositions.tokenMint, snapshot.tokenMint))
      .limit(1);

    if (existingPosition.length > 0) {
      // SELL DECISION: Check if we should exit the existing position
      const position = existingPosition[0];
      const exitDecision = await evaluateOpenPosition(
        userId,
        position.id,
        snapshot.tokenMint,
        negativeOutcomeProbability,
        snapshot.priceUsd,
        trajectoryScore,
        aggregateConfidence
      );

      if (exitDecision.shouldExit) {
        // EXECUTE EXIT
        const { exitPosition } = await import("./position-exit-manager");
        let exitReason: "tsl_hit" | "trajectory_collapse" | "time_stop" | "profit_take" | "user_manual" = "trajectory_collapse";

        if (exitDecision.reason.includes("TSL")) exitReason = "tsl_hit";
        else if (exitDecision.reason.includes("Trajectory")) exitReason = "trajectory_collapse";
        else if (exitDecision.reason.includes("Time")) exitReason = "time_stop";

        const exitResult = await exitPosition(position.id, exitReason, snapshot.priceUsd, userId);
        console.log(`[SnapshotDispatcher] EXIT: ${snapshot.tokenSymbol} - ${exitResult.message}`);
      }
    } else {
      // OPEN DECISION: Check if we should open a new position

      // Check warm-up gate first
      const autoTradingEnabled = await isAutoTradingEnabled(userId);
      if (!autoTradingEnabled) {
        console.log(
          `[SnapshotDispatcher] SKIP: ${snapshot.tokenSymbol} - Auto-trading disabled (warm-up period in progress)`
        );
      } else {
        const budget = await db
          .select()
          .from(positionBudgets)
          .where(eq(positionBudgets.userId, userId))
          .limit(1);

        const baseAllocationPerPosition = budget.length > 0
          ? budget[0].baseAllocationPerPosition || 0.1
          : 0.1;
        const apeBudget = budget.length > 0
          ? budget[0].apeBudget || 0
          : 0;

        // Estimate current balance from budget forecast data
        // baseAllocationPerPosition = currentBalance / (expectedPositionsPerDay * 1.2)
        // So: currentBalance ≈ baseAllocationPerPosition * expectedPositionsPerDay * 1.2
        const expectedPosPerDay = budget.length > 0
          ? budget[0].expectedPositionsPerDay || 10
          : 10;
        const currentBalance = baseAllocationPerPosition * expectedPosPerDay * 1.2;

        const openDecision = await evaluateOpenNewPosition(
          userId,
          snapshot.tokenMint,
          snapshot.tokenSymbol,
          snapshot.priceUsd,
          snapshot.priceUsd,
          clusterResult.matches.map(m => ({ cluster: m.clusterId, confidence: m.similarity, trajectoryScore })),
          aggregateConfidence,
          trajectoryScore,
          currentBalance,
          baseAllocationPerPosition,
          apeBudget
        );

        if (openDecision.opened) {
          console.log(`[SnapshotDispatcher] OPEN: ${snapshot.tokenSymbol} - ${openDecision.reason}`);
          console.log(`  Allocation: ${openDecision.allocationSol?.toFixed(6)} SOL`);
        } else {
          console.log(`[SnapshotDispatcher] SKIP: ${snapshot.tokenSymbol} - ${openDecision.reason}`);
        }
      }
    }

    // Update token leaderboard with trajectory score
    try {
      const { updateTokenLeaderboard } = await import("./token-trajectory-scoring");
      const snapshotCount = (fullSnapshot.snapshotCount || 1) as number;
      const ageSeconds = Math.floor(Date.now() / 1000) - (fullSnapshot.capturedAt || 0);
      const ageMinutes = Math.max(1, ageSeconds / 60);
      const freshness = Math.max(0, Math.min(1.0, 1.0 - (ageMinutes / (72 * 60)))); // Decays over 72h

      await updateTokenLeaderboard(
        snapshot.tokenMint,
        snapshot.tokenSymbol,
        clusterResult.blendedOutcomes,
        snapshotCount,
        snapshot.priceUsd,
        freshness
      );
    } catch (err) {
      console.warn("[SnapshotDispatcher] Failed to update token leaderboard:", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    console.error("[SnapshotDispatcher] Error in snapshot event handler:", err instanceof Error ? err.message : err);
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

  // Check max concurrent positions (prevent fund fragmentation)
  const maxSimultaneousPositions = 50; // From SYSTEM_PICKS_CONFIG
  const openPositions = await db
    .select()
    .from(activePositions)
    .where(and(eq(activePositions.userId, userId), isNull(activePositions.closedAt)));

  if (openPositions.length >= maxSimultaneousPositions) {
    return {
      opened: false,
      reason: `Max concurrent positions reached (${openPositions.length}/${maxSimultaneousPositions})`,
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
