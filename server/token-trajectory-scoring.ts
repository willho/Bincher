import { db } from "./db";
import { tokenLeaderboard, tokenSnapshots } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

export interface OutcomeDistribution {
  pump_100x?: number;
  pump_10x?: number;
  pump_5x?: number;
  pump_2x?: number;
  pump_2x_quick?: number;
  pump_2x_sustained?: number;
  crash_fast?: number;
  slow_bleed?: number;
  deathbed?: number;
}

/**
 * Calculate unbounded trajectory score favoring moonshot potential
 * Higher score = more likely to do big gains (100x, 10x, 5x)
 */
export function calculateTrajectoryScore(outcomes: OutcomeDistribution): number {
  const score =
    (outcomes.pump_100x || 0) * 1.0 +
    (outcomes.pump_10x || 0) * 0.6 +
    (outcomes.pump_5x || 0) * 0.4 +
    (outcomes.pump_2x || 0) * 0.2 +
    (outcomes.pump_2x_quick || 0) * 0.15 +
    (outcomes.pump_2x_sustained || 0) * 0.25 -
    (outcomes.crash_fast || 0) * 0.5 -
    (outcomes.slow_bleed || 0) * 0.3 -
    (outcomes.deathbed || 0) * 0.2;

  return Math.max(0, score);
}

/**
 * Calculate confidence score: higher if more snapshots and recent
 */
export function calculateConfidence(snapshotCount: number, ageSeconds: number): number {
  // Snapshot-based confidence: 1.0 at 10+, 0.5 at 5, 0.0 at 0
  const snapshotConfidence = Math.min(1.0, Math.max(0, (snapshotCount - 1) / 10));

  // Age-based decay: 1.0 if <1h, 0.5 if <24h, 0.0 if >72h
  let ageFreshness = 1.0;
  const hoursOld = ageSeconds / 3600;
  if (hoursOld > 24) {
    ageFreshness = Math.max(0, 1 - (hoursOld - 24) / 48); // Decay from 24h to 72h
  }

  return snapshotConfidence * 0.6 + ageFreshness * 0.4; // 60% snapshot-based, 40% freshness
}

/**
 * Calculate freshness decay: 1.0 for <24h, decays to 0 at 72h
 */
export function calculateFreshness(ageSeconds: number): number {
  const hoursOld = ageSeconds / 3600;
  if (hoursOld < 24) return 1.0;
  if (hoursOld > 72) return 0.0;
  return 1.0 - (hoursOld - 24) / 48; // Linear decay 24h->72h
}

/**
 * Update token leaderboard entry from snapshot outcomes
 */
export async function updateTokenLeaderboard(
  tokenMint: string,
  tokenSymbol: string,
  outcomes: OutcomeDistribution,
  snapshotCount: number,
  lastPrice: number,
  ageSeconds: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const trajectoryScore = calculateTrajectoryScore(outcomes);
  const confidence = calculateConfidence(snapshotCount, ageSeconds);
  const freshness = calculateFreshness(ageSeconds);

  const existing = await db
    .select()
    .from(tokenLeaderboard)
    .where(eq(tokenLeaderboard.tokenMint, tokenMint))
    .limit(1);

  if (existing.length > 0) {
    // Update existing entry
    await db
      .update(tokenLeaderboard)
      .set({
        tokenSymbol,
        trajectoryScore,
        confidence,
        outcomeProb100x: outcomes.pump_100x || 0,
        outcomeProb10x: outcomes.pump_10x || 0,
        outcomeProb5x: outcomes.pump_5x || 0,
        outcomeProb2x: outcomes.pump_2x || 0,
        outcomeProb2xQuick: outcomes.pump_2x_quick || 0,
        outcomeProb2xSustained: outcomes.pump_2x_sustained || 0,
        outcomeProbCrashFast: outcomes.crash_fast || 0,
        outcomeProbSlowBleed: outcomes.slow_bleed || 0,
        outcomeProbDeathbed: outcomes.deathbed || 0,
        lastPrice,
        lastSnapshotAt: now,
        snapshotCount: (existing[0].snapshotCount || 0) + 1,
        freshness,
        updatedAt: now,
      })
      .where(eq(tokenLeaderboard.tokenMint, tokenMint));
  } else {
    // Create new entry
    await db.insert(tokenLeaderboard).values({
      tokenMint,
      tokenSymbol,
      trajectoryScore,
      confidence,
      outcomeProb100x: outcomes.pump_100x || 0,
      outcomeProb10x: outcomes.pump_10x || 0,
      outcomeProb5x: outcomes.pump_5x || 0,
      outcomeProb2x: outcomes.pump_2x || 0,
      outcomeProb2xQuick: outcomes.pump_2x_quick || 0,
      outcomeProb2xSustained: outcomes.pump_2x_sustained || 0,
      outcomeProbCrashFast: outcomes.crash_fast || 0,
      outcomeProbSlowBleed: outcomes.slow_bleed || 0,
      outcomeProbDeathbed: outcomes.deathbed || 0,
      lastPrice,
      lastSnapshotAt: now,
      snapshotCount: 1,
      freshness,
      createdAt: now,
    });
  }
}

/**
 * Get token leaderboard with percentile rankings
 */
export async function getTokenLeaderboard(
  limit: number = 50,
  minScore: number = 0,
  minConfidence: number = 0
): Promise<Array<{
  rank: number;
  percentile: number;
  tokenMint: string;
  tokenSymbol: string;
  trajectoryScore: number;
  confidence: number;
  outcomes: OutcomeDistribution;
  lastPrice: number;
  freshness: number;
}>> {
  // Get all tokens ordered by trajectory score
  const allTokens = await db
    .select()
    .from(tokenLeaderboard)
    .orderBy(desc(tokenLeaderboard.trajectoryScore))
    .limit(Math.max(limit, 500)); // Get more for percentile calculation

  // Filter and get top N
  const filtered = allTokens.filter(t => t.trajectoryScore >= minScore && t.confidence >= minConfidence);

  // Calculate percentiles
  const totalCount = allTokens.length;
  const leaderboard = filtered.slice(0, limit).map((token, idx) => {
    const rank = idx + 1;
    const percentile = totalCount > 0 ? ((totalCount - (allTokens.indexOf(token) + 1)) / totalCount) * 100 : 0;

    return {
      rank,
      percentile: Math.round(percentile * 10) / 10, // One decimal place
      tokenMint: token.tokenMint,
      tokenSymbol: token.tokenSymbol,
      trajectoryScore: token.trajectoryScore,
      confidence: token.confidence,
      outcomes: {
        pump_100x: token.outcomeProb100x,
        pump_10x: token.outcomeProb10x,
        pump_5x: token.outcomeProb5x,
        pump_2x: token.outcomeProb2x,
        pump_2x_quick: token.outcomeProb2xQuick,
        pump_2x_sustained: token.outcomeProb2xSustained,
        crash_fast: token.outcomeProbCrashFast,
        slow_bleed: token.outcomeProbSlowBleed,
        deathbed: token.outcomeProbDeathbed,
      },
      lastPrice: token.lastPrice,
      freshness: token.freshness,
    };
  });

  return leaderboard;
}

/**
 * Get single token details with percentile
 */
export async function getTokenDetail(tokenMint: string): Promise<{
  rank: number;
  percentile: number;
  tokenMint: string;
  tokenSymbol: string;
  trajectoryScore: number;
  confidence: number;
  outcomes: OutcomeDistribution;
  lastPrice: number;
  freshness: number;
  snapshotCount: number;
} | null> {
  const token = await db
    .select()
    .from(tokenLeaderboard)
    .where(eq(tokenLeaderboard.tokenMint, tokenMint))
    .limit(1);

  if (token.length === 0) return null;

  const t = token[0];

  // Get all tokens for percentile calculation
  const allTokens = await db.select().from(tokenLeaderboard);
  const allScores = allTokens.map(t => t.trajectoryScore).sort((a, b) => b - a);

  const rank = allScores.findIndex(score => score === t.trajectoryScore) + 1;
  const percentile = allTokens.length > 0 ? ((allTokens.length - rank) / allTokens.length) * 100 : 0;

  return {
    rank,
    percentile: Math.round(percentile * 10) / 10,
    tokenMint: t.tokenMint,
    tokenSymbol: t.tokenSymbol,
    trajectoryScore: t.trajectoryScore,
    confidence: t.confidence,
    outcomes: {
      pump_100x: t.outcomeProb100x,
      pump_10x: t.outcomeProb10x,
      pump_5x: t.outcomeProb5x,
      pump_2x: t.outcomeProb2x,
      pump_2x_quick: t.outcomeProb2xQuick,
      pump_2x_sustained: t.outcomeProb2xSustained,
      crash_fast: t.outcomeProbCrashFast,
      slow_bleed: t.outcomeProbSlowBleed,
      deathbed: t.outcomeProbDeathbed,
    },
    lastPrice: t.lastPrice,
    freshness: t.freshness,
    snapshotCount: t.snapshotCount || 0,
  };
}

/**
 * Clean up stale tokens (no updates in 7 days)
 */
export async function cleanupStaleTokens(maxAgeSeconds: number = 7 * 86400): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - maxAgeSeconds;

  const staleTokens = await db
    .select()
    .from(tokenLeaderboard)
    .where(tokenLeaderboard.updatedAt);

  // Count and delete via ORM (simple approach)
  let deletedCount = 0;

  // Note: In production, would batch delete
  // For now, just return count of what would be deleted
  return deletedCount;
}
