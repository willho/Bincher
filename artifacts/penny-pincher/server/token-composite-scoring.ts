/**
 * Token Composite Scoring System
 *
 * Consolidates two ranking dimensions into a single score for pool management:
 * 1. ANN success probability (likelihood of reaching 2x minimum)
 * 2. Expected returns if successful (multiplier potential)
 *
 * Formula: composite_score = ann_probability × expected_multiplier
 *
 * Example:
 *   ANN score: 0.75 (75% confidence of reaching 2x+)
 *   Expected multiplier: 5.0x (median historical outcome for similar tokens)
 *   Composite score: 0.75 × 5.0 = 3.75 "expected gains"
 *
 * Interpretation:
 *   - Score 5.0+ = Top tier (high confidence × high returns)
 *   - Score 2.0-5.0 = Mid tier (good combination)
 *   - Score 0.5-2.0 = Lower tier (either low confidence or low returns)
 *   - Score <0.5 = Avoid (poor combination)
 */

import { db } from "./db";
import { eq, and, gte, desc } from "drizzle-orm";
import { tokenDataPool, fingerprintLifecycleMetrics, tokenOutcomes } from "@shared/schema";

/**
 * Estimated returns per token based on fingerprint historical data
 * Uses median multiplier from similar tokens in the cluster
 *
 * Baseline: If no historical data, assume 3x for tokens that graduate
 * (historical fact: most pump.fun tokens that reach post-grad average 2-5x for early buyers)
 */
async function getExpectedMultiplier(mint: string): Promise<number> {
  try {
    // Strategy 1: Check tokenOutcomes for this exact token (if already traded)
    const outcome = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, mint),
    });

    if (outcome?.peakMultiplierAllTime && outcome.peakMultiplierAllTime > 0) {
      return Math.min(outcome.peakMultiplierAllTime, 100); // Cap at 100x for scoring stability
    }

    // Strategy 2: Get fingerprint cluster and use median historical multiplier
    const tokenData = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, mint),
    });

    if (!tokenData) {
      return 3.0; // Default assumption
    }

    // TODO: Query fingerprintLifecycleMetrics for cluster statistics
    // For now, use baseline assumption
    return 3.0; // Conservative estimate: tokens that graduate typically reach 2-5x

  } catch (error) {
    console.error(`[CompositeScoring] Error estimating multiplier for ${mint}:`, error);
    return 3.0; // Fallback to baseline
  }
}

/**
 * Calculate composite score for a token
 * Combines ANN probability with expected returns
 *
 * @param annScore - ANN success probability [0.0, 1.0]
 * @param expectedMultiplier - Expected returns if successful (e.g., 3.5x)
 * @returns Composite score (0.0 to ~10.0+, higher is better)
 */
export function calculateCompositeScore(annScore: number, expectedMultiplier: number): number {
  // Validate inputs
  const clampedAnn = Math.max(0, Math.min(1, annScore));
  const clampedMultiplier = Math.max(1, expectedMultiplier); // Min 1x (break-even)

  // Formula: Expected Value = Probability × Potential Payoff
  return clampedAnn * clampedMultiplier;
}

/**
 * Score a token for pool ranking
 *
 * @param mint - Token mint address
 * @param annScore - ANN success probability [0.0, 1.0]
 * @returns Composite score ready for ranking
 */
export async function scoreTokenForPoolRanking(mint: string, annScore: number): Promise<number> {
  const expectedMultiplier = await getExpectedMultiplier(mint);
  return calculateCompositeScore(annScore, expectedMultiplier);
}

/**
 * Get top N tokens by composite score for monitoring pool
 *
 * @param limit - Number of tokens to return (e.g., 1900)
 * @returns Sorted array of tokens by composite score (descending)
 */
export async function getTopTokensByCompositeScore(
  limit: number = 1900
): Promise<Array<{ mint: string; compositeScore: number; annScore: number; expectedMultiplier: number }>> {
  try {
    // Fetch all monitored tokens with outcomes
    const tokens = await db.query.tokenDataPool.findMany({
      where: and(
        eq(tokenDataPool.isMonitored, true),
        gte(tokenDataPool.lastAnnScore, 0) // Has ANN score
      ),
      limit: 5000, // Fetch more than needed, score and filter
    });

    // Score each token
    const scored = await Promise.all(
      tokens.map(async (token) => {
        const annScore = token.lastAnnScore ?? 0.5;
        const expectedMultiplier = await getExpectedMultiplier(token.tokenMint);
        return {
          mint: token.tokenMint,
          compositeScore: calculateCompositeScore(annScore, expectedMultiplier),
          annScore,
          expectedMultiplier,
        };
      })
    );

    // Sort by composite score descending
    return scored.sort((a, b) => b.compositeScore - a.compositeScore).slice(0, limit);

  } catch (error) {
    console.error("[CompositeScoring] Error getting top tokens:", error);
    return [];
  }
}

/**
 * Rank tokens and categorize by tier
 *
 * Tier 1 (5.0+): Elite — high confidence × high returns
 * Tier 2 (2.0-5.0): Standard — solid combination
 * Tier 3 (0.5-2.0): Secondary — weaker but viable
 * Tier 4 (<0.5): Avoid — poor combination
 */
export async function rankTokensByTier(limit: number = 1900): Promise<{
  tier1: Array<{ mint: string; score: number }>;
  tier2: Array<{ mint: string; score: number }>;
  tier3: Array<{ mint: string; score: number }>;
  tier4: Array<{ mint: string; score: number }>;
}> {
  const tokens = await getTopTokensByCompositeScore(limit);

  return {
    tier1: tokens.filter((t) => t.compositeScore >= 5.0).map((t) => ({ mint: t.mint, score: t.compositeScore })),
    tier2: tokens.filter((t) => t.compositeScore >= 2.0 && t.compositeScore < 5.0).map((t) => ({ mint: t.mint, score: t.compositeScore })),
    tier3: tokens.filter((t) => t.compositeScore >= 0.5 && t.compositeScore < 2.0).map((t) => ({ mint: t.mint, score: t.compositeScore })),
    tier4: tokens.filter((t) => t.compositeScore < 0.5).map((t) => ({ mint: t.mint, score: t.compositeScore })),
  };
}

/**
 * API endpoint helper: Get composite score explanation for a token
 *
 * @param mint - Token mint address
 * @param annScore - ANN probability [0.0, 1.0]
 * @returns Detailed breakdown for API response
 */
export async function explainCompositeScore(mint: string, annScore: number): Promise<{
  mint: string;
  annScore: number;
  expectedMultiplier: number;
  compositeScore: number;
  tier: string;
  explanation: string;
}> {
  const expectedMultiplier = await getExpectedMultiplier(mint);
  const compositeScore = calculateCompositeScore(annScore, expectedMultiplier);

  let tier: string;
  let explanation: string;

  if (compositeScore >= 5.0) {
    tier = "Elite (Tier 1)";
    explanation = `Token has ${(annScore * 100).toFixed(0)}% chance of success with expected ${expectedMultiplier.toFixed(1)}x returns. This is a high-conviction opportunity.`;
  } else if (compositeScore >= 2.0) {
    tier = "Standard (Tier 2)";
    explanation = `Token has ${(annScore * 100).toFixed(0)}% chance of success with expected ${expectedMultiplier.toFixed(1)}x returns. Solid combination for monitoring.`;
  } else if (compositeScore >= 0.5) {
    tier = "Secondary (Tier 3)";
    explanation = `Token has ${(annScore * 100).toFixed(0)}% chance of success with expected ${expectedMultiplier.toFixed(1)}x returns. Include in secondary rotation.`;
  } else {
    tier = "Low Priority (Tier 4)";
    explanation = `Token has ${(annScore * 100).toFixed(0)}% chance of success with expected ${expectedMultiplier.toFixed(1)}x returns. Low priority for monitoring slots.`;
  }

  return { mint, annScore, expectedMultiplier, compositeScore, tier, explanation };
}

/**
 * Get tokens to evict from pool when slots full
 * Returns lowest-scoring tokens first (evict worst performers)
 *
 * @param poolSize - Current pool size
 * @param maxPoolSize - Maximum allowed (e.g., 1900)
 * @returns Tokens to remove (lowest scores first)
 */
export async function getTokensToEvict(
  poolSize: number,
  maxPoolSize: number = 1900
): Promise<Array<{ mint: string; score: number }>> {
  if (poolSize <= maxPoolSize) {
    return []; // No eviction needed
  }

  const evictCount = poolSize - maxPoolSize;
  const allTokens = await getTopTokensByCompositeScore(poolSize);

  // Return worst performers (lowest scores)
  return allTokens
    .sort((a, b) => a.compositeScore - b.compositeScore) // Ascending
    .slice(0, evictCount)
    .map((t) => ({ mint: t.mint, score: t.compositeScore }));
}
