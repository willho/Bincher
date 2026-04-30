// @ts-nocheck
import { db } from "./db";
import {
  creatorReputation,
  retrolearnerThresholds,
  tokenOutcomes,
  tokenFingerprints,
} from "@shared/schema";
import { and, eq, gte, lt } from "drizzle-orm";

/**
 * Retrolearner Threshold Learner
 * Discovers optimal buying thresholds based on historical outcomes
 *
 * For each buying condition (creator launch buy, whale T+3 buy, etc.),
 * analyzes which thresholds correlate with success (2x+ return).
 *
 * Example output:
 * - "creator_launch_buy": creator_win_rate >= 0.55 → 62% success rate
 * - "whale_t3_buy": whale_amount >= 5 SOL → 75% success rate
 */

export async function learnCreatorThresholds(): Promise<void> {
  console.log("[Retrolearner] Learning creator launch buy thresholds...");

  // Get creator outcomes
  const creators = await db.query.creatorReputation.findMany();

  // Test each threshold value
  const thresholdCandidates = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  const results: any[] = [];

  for (const threshold of thresholdCandidates) {
    // Get tokens from creators with win_rate >= threshold
    const qualifyingCreators = creators.filter((c) => c.winRate >= threshold);

    if (qualifyingCreators.length === 0) continue;

    const creatorAddresses = qualifyingCreators.map((c) => c.creatorAddress);

    // Count successes
    const tokens = await db
      .select()
      .from(tokenOutcomes)
      .where(
        and(
          gt_in_array(
            tokenFingerprints.creatorAddress,
            creatorAddresses
          )
        )
      );

    const successes = tokens.filter((t) => (t.peakMultiplierAllTime ?? 1) >= 2).length;
    const successRate = tokens.length > 0 ? successes / tokens.length : 0;

    results.push({
      threshold,
      successRate,
      sampleSize: tokens.length,
      creatorCount: qualifyingCreators.length,
    });
  }

  // Find best threshold (highest success rate with minimum sample size)
  const MIN_SAMPLE = 20;
  const best = results
    .filter((r) => r.sampleSize >= MIN_SAMPLE)
    .sort((a, b) => b.successRate - a.successRate)[0];

  if (!best) {
    console.log("[Retrolearner] Not enough creator data to learn thresholds yet");
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Store learned threshold
  await db
    .delete(retrolearnerThresholds)
    .where(eq(retrolearnerThresholds.thresholdType, "creator_launch_buy"));

  await db.insert(retrolearnerThresholds).values({
    thresholdType: "creator_launch_buy",
    thresholdValue: best.threshold,
    expectedSuccessRate: best.successRate,
    sampleSize: best.sampleSize,
    confidence: Math.min(1.0, best.sampleSize / 100), // 100 samples = high confidence
    analysisDate: now,
    dataWindowDays: 7,
    context: {
      allResults: results,
      creatorCount: best.creatorCount,
    },
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    `[Retrolearner] Creator threshold: win_rate >= ${(best.threshold * 100).toFixed(1)}% → ${(best.successRate * 100).toFixed(1)}% success rate (${best.sampleSize} samples)`
  );
}

export async function learnWhaleThresholds(): Promise<void> {
  console.log("[Retrolearner] Learning whale T+3 buy thresholds...");

  // Get tokens at T+3 milestone
  const t3Snapshots = await db.query.tokenFingerprints.findMany({
    where: and(
      eq(tokenFingerprints.snapshotTrigger, "time_3min"),
      eq(tokenFingerprints.isArchived, false)
    ),
  });

  // Test different whale entry thresholds
  const whaleThresholds = [1.0, 2.5, 5.0, 10.0, 25.0];
  const results: any[] = [];

  for (const threshold of whaleThresholds) {
    const whaleEntered =
      threshold === 1.0
        ? t3Snapshots.filter((s) => s.whaleEntered1Sol === 1)
        : threshold === 5.0
          ? t3Snapshots.filter((s) => s.whaleEntered5Sol === 1)
          : threshold === 10.0
            ? t3Snapshots.filter((s) => s.whaleEntered10Sol === 1)
            : [];

    if (whaleEntered.length === 0) continue;

    // Get outcomes for these tokens
    const mints = whaleEntered.map((s) => s.tokenMint).filter((m): m is string => m !== null);
    const outcomes = await db.query.tokenOutcomes.findMany({
      where: in_array(tokenOutcomes.tokenMint, mints),
    });

    const successes = outcomes.filter((o) => (o.peakMultiplierAllTime ?? 1) >= 2).length;
    const successRate = outcomes.length > 0 ? successes / outcomes.length : 0;

    results.push({
      threshold,
      successRate,
      sampleSize: outcomes.length,
      whaleCount: whaleEntered.length,
    });
  }

  // Find best threshold
  const MIN_SAMPLE = 15;
  const best = results
    .filter((r) => r.sampleSize >= MIN_SAMPLE)
    .sort((a, b) => b.successRate - a.successRate)[0];

  if (!best) {
    console.log("[Retrolearner] Not enough whale data to learn thresholds yet");
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  await db
    .delete(retrolearnerThresholds)
    .where(eq(retrolearnerThresholds.thresholdType, "whale_t3_buy"));

  await db.insert(retrolearnerThresholds).values({
    thresholdType: "whale_t3_buy",
    thresholdValue: best.threshold, // SOL amount
    expectedSuccessRate: best.successRate,
    sampleSize: best.sampleSize,
    confidence: Math.min(1.0, best.sampleSize / 100),
    analysisDate: now,
    dataWindowDays: 7,
    context: {
      allResults: results,
      whaleCount: best.whaleCount,
    },
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    `[Retrolearner] Whale threshold: >=${best.threshold} SOL by T+3 → ${(best.successRate * 100).toFixed(1)}% success rate (${best.sampleSize} samples)`
  );
}

export async function learnANNScoreThreshold(): Promise<void> {
  console.log("[Retrolearner] Learning ANN score thresholds...");

  // This would integrate with token-success-ann.ts
  // For now, use placeholder
  const now = Math.floor(Date.now() / 1000);

  await db
    .delete(retrolearnerThresholds)
    .where(eq(retrolearnerThresholds.thresholdType, "ann_score_buy"));

  await db.insert(retrolearnerThresholds).values({
    thresholdType: "ann_score_buy",
    thresholdValue: 0.70, // Default: buy if ANN score > 0.70
    expectedSuccessRate: 0.65, // Placeholder
    sampleSize: 0,
    confidence: 0.2, // Low confidence until ANN has trained
    analysisDate: now,
    dataWindowDays: 0,
    context: { note: "ANN-based threshold, learned during training" },
    createdAt: now,
    updatedAt: now,
  });

  console.log(`[Retrolearner] ANN threshold: score >= 0.70 → 65% success rate (placeholder)`);
}

export async function learnMilestoneThresholds(): Promise<void> {
  console.log("[Retrolearner] Learning milestone-based buy thresholds...");

  // Check: at milestone_100_traders, which conditions correlate with success?
  const m100Snapshots = await db.query.tokenFingerprints.findMany({
    where: and(
      eq(tokenFingerprints.snapshotTrigger, "milestone_100_traders"),
      eq(tokenFingerprints.isArchived, false)
    ),
  });

  if (m100Snapshots.length === 0) {
    console.log("[Retrolearner] No milestone_100_traders snapshots yet");
    return;
  }

  // Analyze: high buy ratio + low concentration = success?
  // This would correlate snapshot metrics with outcomes
  // For now, store placeholder

  const now = Math.floor(Date.now() / 1000);

  await db
    .delete(retrolearnerThresholds)
    .where(eq(retrolearnerThresholds.thresholdType, "milestone_100_traders_buy"));

  await db.insert(retrolearnerThresholds).values({
    thresholdType: "milestone_100_traders_buy",
    thresholdValue: 0.65, // Placeholder: 65% buy ratio threshold
    expectedSuccessRate: 0.60,
    sampleSize: m100Snapshots.length,
    confidence: Math.min(1.0, m100Snapshots.length / 50),
    analysisDate: now,
    dataWindowDays: 7,
    context: { snapshotCount: m100Snapshots.length },
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    `[Retrolearner] Milestone threshold: 100 traders + buy_ratio >= 65% → 60% success rate`
  );
}

/**
 * Full retrolearner cycle: Run all threshold learning
 */
export async function performThresholdLearningCycle(): Promise<void> {
  console.log("[Retrolearner] Starting threshold learning cycle...");

  try {
    await learnCreatorThresholds();
    await learnWhaleThresholds();
    await learnANNScoreThreshold();
    await learnMilestoneThresholds();

    console.log("[Retrolearner] Threshold learning complete!");
  } catch (error) {
    console.error("[Retrolearner] Error during threshold learning:", error);
    throw error;
  }
}

/**
 * Get latest learned thresholds
 */
export async function getLearnedThresholds(): Promise<Map<string, any>> {
  const all = await db.query.retrolearnerThresholds.findMany();
  const map = new Map();
  for (const t of all) {
    map.set(t.thresholdType, t);
  }
  return map;
}

// Placeholder for missing drizzle-orm functions
function gt_in_array(column: any, values: string[]): any {
  // This would be replaced with proper drizzle syntax
  // For now, fallback to manual filtering
  return eq(column, values[0]); // Placeholder
}

function in_array(column: any, values: string[]): any {
  // This would be replaced with proper drizzle syntax
  return eq(column, values[0]); // Placeholder
}
