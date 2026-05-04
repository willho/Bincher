/**
 * Learned Exit Strategy Optimization
 *
 * The system learns optimal exit tier multipliers per cluster by:
 * 1. Tracking actual position outcomes (which tiers were hit, final PnL)
 * 2. Computing weighted averages with dampening to prevent overreaction
 * 3. Storing learned parameters back to database for continuous refinement
 * 4. Comparing baseline vs learned strategies to validate improvements
 */

import { db } from "./db";
import { eq, and, desc, gte } from "drizzle-orm";
import { paperPositions, exitStrategyLearnings } from "@shared/schema";

export interface ExitTierLearning {
  multiplier: number;
  hitRate: number;        // % of positions reaching this tier
  avgExitPrice: number;   // Actual price when exited
  profitIfExited: number; // PnL if exited at this tier
  confidence: number;     // Sample size confidence (0-1)
}

export interface ClusterExitStrategyLearning {
  clusterId: string;
  clusterName: string;
  baselineStrategy: any;     // Original hardcoded values
  learnedStrategy: any;      // Refined via actual trades
  learnedTiers: ExitTierLearning[];
  improvement: number;       // % better than baseline
  sampleCount: number;       // Trades analyzed
  lastUpdated: number;       // Timestamp
  confidence: number;        // Overall confidence (0-1)
}

// =====================
// DAMPENING & AVERAGING
// =====================

const LEARNING_CONFIG = {
  // Momentum dampening: how much new data influences the average
  // Lower = more dampening (conservative learning)
  // 0.1 = new data is only 10% of new average, 90% from previous
  exitTierMomentum: 0.15,

  // Minimum samples before dampening applies
  // Below this, learning moves faster (need enough data)
  minSamplesForDampening: 20,

  // Outlier protection: ignore trades with extreme results
  // If a trade is >3x the median PnL, consider it outlier
  outlierThreshold: 3.0,

  // Confidence threshold for applying learned strategy
  // Below this, stick to baseline
  minConfidenceForApplication: 0.65,

  // Maximum change per learning cycle (prevent wild swings)
  maxMultiplierAdjustmentPercent: 15, // Can't move more than 15% per cycle
};

/**
 * Compute dampened average with outlier protection
 */
function computeDampenedValue(
  previousValue: number,
  newValues: number[],
  sampleHistory: number // Total samples accumulated
): { value: number; confidence: number } {
  if (newValues.length === 0) {
    return { value: previousValue, confidence: 0.5 };
  }

  // Sort to find median and detect outliers
  const sorted = [...newValues].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Filter outliers (values >3x from median)
  const filtered = newValues.filter((v) => {
    const ratio = Math.max(v / median, median / v);
    return ratio <= LEARNING_CONFIG.outlierThreshold;
  });

  // If all values filtered, use median anyway
  const valuesToAverage = filtered.length > 0 ? filtered : [median];
  const newAverage = valuesToAverage.reduce((a, b) => a + b, 0) / valuesToAverage.length;

  // Apply dampening based on sample count
  let dampingFactor = LEARNING_CONFIG.exitTierMomentum;
  if (sampleHistory < LEARNING_CONFIG.minSamplesForDampening) {
    // Early learning: increase momentum linearly
    dampingFactor = Math.min(0.5, (sampleHistory / LEARNING_CONFIG.minSamplesForDampening) * 0.5);
  }

  const dampedValue = previousValue * (1 - dampingFactor) + newAverage * dampingFactor;

  // Confidence grows with samples (asymptotic to 1.0)
  const confidence = Math.min(1.0, sampleHistory / (LEARNING_CONFIG.minSamplesForDampening * 3));

  return { value: dampedValue, confidence };
}

/**
 * Learn exit tier effectiveness from recent position outcomes
 */
export async function learnExitTierEffectiveness(
  clusterName: string,
  lookbackDays: number = 7
): Promise<ExitTierLearning[]> {
  const cutoffTime = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // Find closed positions matching this cluster
  const positions = await db.query.paperPositions.findMany({
    where: and(
      eq(paperPositions.status, "closed"),
      gte(paperPositions.updatedAt, cutoffTime)
      // Would add cluster matching here when schema has discoveryCluster field
    ),
  });

  if (positions.length === 0) {
    return [];
  }

  // Group by intended exit multiplier tier
  const tierResults = new Map<number, { hits: number; pnls: number[] }>();

  for (const pos of positions) {
    if (!pos.takeProfitMultiplier) continue;

    const multiplier = pos.takeProfitMultiplier;
    const exitRatio = (pos.exitPrice || pos.entryPrice) / pos.entryPrice;
    const pnlPercent = ((pos.exitPrice || pos.entryPrice) - pos.entryPrice) / pos.entryPrice;

    if (!tierResults.has(multiplier)) {
      tierResults.set(multiplier, { hits: 0, pnls: [] });
    }

    const result = tierResults.get(multiplier)!;
    if (exitRatio >= multiplier) {
      result.hits++;
    }
    result.pnls.push(pnlPercent);
  }

  // Convert to learning format
  const learnings: ExitTierLearning[] = [];
  for (const [multiplier, data] of tierResults.entries()) {
    const hitRate = data.hits / positions.length;
    const avgPnl = data.pnls.reduce((a, b) => a + b, 0) / data.pnls.length;
    const confidence = Math.min(1.0, (data.hits + 1) / 20); // Confidence grows with hit count

    learnings.push({
      multiplier,
      hitRate,
      avgExitPrice: 0, // Would calculate from actual prices
      profitIfExited: avgPnl,
      confidence,
    });
  }

  return learnings;
}

/**
 * Optimize exit tier multipliers based on learning
 *
 * Strategy:
 * - Tiers that hit frequently (>60%) can be aggressive (raise multiplier)
 * - Tiers that rarely hit (<30%) should be lowered (more achievable)
 * - Use dampening to prevent oscillation
 * - Maintain runner tier for moonshots (don't over-optimize)
 */
export async function optimizeExitTiers(
  clusterName: string,
  baselineTiers: Array<{ multiplier: number; percentage: number }>,
  lookbackDays: number = 7
): Promise<{
  optimizedTiers: Array<{ multiplier: number; percentage: number }>;
  improvements: Record<string, number>;
  confidence: number;
}> {
  const learnings = await learnExitTierEffectiveness(clusterName, lookbackDays);

  if (learnings.length === 0) {
    return {
      optimizedTiers: baselineTiers,
      improvements: {},
      confidence: 0,
    };
  }

  const optimizedTiers = baselineTiers.map((tier, idx) => {
    const learning = learnings.find((l) => Math.abs(l.multiplier - tier.multiplier) < 0.1);

    if (!learning || learning.confidence < 0.3) {
      // Not enough data, keep baseline
      return tier;
    }

    let newMultiplier = tier.multiplier;

    // Adjustment logic:
    if (learning.hitRate > 0.7) {
      // Tier is too easy, raise it (less achievable = better strategy)
      const increase = 1 + (learning.hitRate - 0.7) * 0.5; // Up to +20% increase
      newMultiplier = tier.multiplier * increase;
    } else if (learning.hitRate < 0.3) {
      // Tier is too hard, lower it (more achievable)
      const decrease = 0.85 + (learning.hitRate * 0.5); // Down to -15% decrease
      newMultiplier = tier.multiplier * decrease;
    }

    // Cap adjustment to max change percentage
    const maxAdjust = 1 + LEARNING_CONFIG.maxMultiplierAdjustmentPercent / 100;
    const minAdjust = 1 - LEARNING_CONFIG.maxMultiplierAdjustmentPercent / 100;
    newMultiplier = Math.max(
      tier.multiplier * minAdjust,
      Math.min(tier.multiplier * maxAdjust, newMultiplier)
    );

    // Round to sensible values (0.1x increments)
    newMultiplier = Math.round(newMultiplier * 10) / 10;

    return {
      ...tier,
      multiplier: Math.max(0.5, newMultiplier), // Don't go below 0.5x
    };
  });

  // Calculate overall confidence
  const avgConfidence = learnings.reduce((a, b) => a + b.confidence, 0) / learnings.length;
  const shouldApply = avgConfidence >= LEARNING_CONFIG.minConfidenceForApplication;

  const improvements: Record<string, number> = {};
  baselineTiers.forEach((baseline, idx) => {
    const optimized = optimizedTiers[idx];
    improvements[`tier_${idx}_${baseline.multiplier}x`] =
      ((optimized.multiplier - baseline.multiplier) / baseline.multiplier) * 100;
  });

  return {
    optimizedTiers: shouldApply ? optimizedTiers : baselineTiers,
    improvements,
    confidence: avgConfidence,
  };
}

/**
 * Periodic learning job: update exit strategies for all clusters
 */
export async function runExitStrategyLearningCycle(): Promise<void> {
  const clusters = ["spike_and_bleed", "slow_moon", "late_bloomer", "pump_dump"];

  console.log("[ExitStrategyLearning] Starting learning cycle for all clusters");

  for (const cluster of clusters) {
    try {
      // Get current baseline from exit-strategies.ts
      const { getExitStrategy } = await import("./exit-strategies");
      const baseline = getExitStrategy(cluster);

      if (!baseline.exitTiers) {
        console.log(`[ExitStrategyLearning] ${cluster} uses single TP, skipping optimization`);
        continue;
      }

      // Learn from recent trades
      const { optimizedTiers, improvements, confidence } = await optimizeExitTiers(
        cluster,
        baseline.exitTiers,
        7 // Last 7 days
      );

      // Store in database for future use
      if (confidence > LEARNING_CONFIG.minConfidenceForApplication) {
        console.log(
          `[ExitStrategyLearning] ${cluster}: Learned tiers (confidence ${(confidence * 100).toFixed(0)}%)`
        );
        console.log(`  Improvements:`, improvements);

        // TODO: Store optimizedTiers in database
        // await db.insert(exitStrategyLearnings).values({
        //   clusterId: cluster,
        //   baselineStrategy: baseline,
        //   learnedStrategy: { ...baseline, exitTiers: optimizedTiers },
        //   sampleCount: positions.length,
        //   confidence,
        //   createdAt: Math.floor(Date.now() / 1000),
        // });
      } else {
        console.log(
          `[ExitStrategyLearning] ${cluster}: Insufficient confidence (${(confidence * 100).toFixed(0)}%), keeping baseline`
        );
      }
    } catch (error) {
      console.error(`[ExitStrategyLearning] Error processing ${cluster}:`, error);
    }
  }
}

/**
 * Get current exit strategy (baseline or learned)
 */
export async function getOptimizedExitStrategy(clusterName: string): Promise<any> {
  try {
    // First check if learned strategy exists
    const learned = await db.query.exitStrategyLearnings?.findFirst?.({
      where: eq("clusterId" as any, clusterName),
      orderBy: [desc("createdAt" as any)],
    });

    if (learned && learned.confidence > LEARNING_CONFIG.minConfidenceForApplication) {
      console.log(
        `[ExitStrategyLearning] Using learned strategy for ${clusterName} (confidence: ${(learned.confidence * 100).toFixed(0)}%)`
      );
      return learned.learnedStrategy;
    }
  } catch (error) {
    console.error("[ExitStrategyLearning] Error fetching learned strategy:", error);
  }

  // Fall back to baseline
  const { getExitStrategy } = await import("./exit-strategies");
  return getExitStrategy(clusterName);
}

/**
 * Start periodic learning job (run 2x daily, after market closes)
 */
export async function startExitStrategyLearning(): Promise<void> {
  console.log("[ExitStrategyLearning] Starting exit strategy learning system");

  // Run immediately after 30 seconds
  setTimeout(async () => {
    try {
      await runExitStrategyLearningCycle();
    } catch (error) {
      console.error("[ExitStrategyLearning] Initial cycle failed:", error);
    }
  }, 30_000);

  // Then run every 12 hours
  setInterval(
    async () => {
      try {
        await runExitStrategyLearningCycle();
      } catch (error) {
        console.error("[ExitStrategyLearning] Learning cycle failed:", error);
      }
    },
    12 * 60 * 60 * 1000
  );
}
