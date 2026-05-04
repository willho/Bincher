import { db } from "./db";
import { eq } from "drizzle-orm";
import { raydiumPoolDiscoveries, tokenDataPool } from "@shared/schema";

interface PoolQualityFactors {
  liquidity: number; // 0-25 points
  holderConcentration: number; // 0-25 points
  creatorReputation: number; // 0-25 points
  age: number; // 0-25 points
}

interface PoolQualityScore {
  score: number; // 0-100
  factors: PoolQualityFactors;
  grade: "A" | "B" | "C" | "D" | "F";
}

const QUALITY_THRESHOLDS = {
  excellentLiquidity: 100000, // $100k+
  goodLiquidity: 50000, // $50k+
  fairLiquidity: 10000, // $10k+
  poorLiquidity: 1000, // $1k+

  excellentHolders: 500, // 500+ holders
  goodHolders: 200, // 200+ holders
  fairHolders: 50, // 50+ holders

  lowConcentration: 0.1, // < 10% top holder
  mediumConcentration: 0.2, // < 20% top holder
  highConcentration: 0.5, // < 50% top holder

  minPoolAgeMinutes: 5, // Must be at least 5 minutes old
  optimalPoolAgeHours: 2, // Sweet spot is ~2 hours
};

/**
 * Score a Raydium pool based on quality factors
 */
export async function scoreRaydiumPool(poolAddress: string): Promise<PoolQualityScore> {
  try {
    const pool = await db.query.raydiumPoolDiscoveries.findFirst({
      where: eq(raydiumPoolDiscoveries.poolAddress, poolAddress),
    });

    if (!pool) {
      return {
        score: 0,
        factors: { liquidity: 0, holderConcentration: 0, creatorReputation: 0, age: 0 },
        grade: "F",
      };
    }

    // Calculate individual factors
    const liquidityScore = scoreLiquidity(pool.liquidityUsd || 0);
    const ageScore = scoreAge(pool.discoveredAt);

    // Try to find token data for holder analysis and creator reputation
    let holderScore = 0;
    let creatorScore = 0;

    if (pool.associatedTokenMint) {
      const tokenData = await db.query.tokenDataPool.findFirst({
        where: eq(tokenDataPool.tokenMint, pool.associatedTokenMint),
      });

      if (tokenData) {
        holderScore = scoreHolderConcentration(
          tokenData.raydiumHolderConcentration || 0,
          tokenData.raydiumTopHolderCount || 0
        );
        creatorScore = scoreCreatorReputation(tokenData.raydiumCreatorReputation || 0);
      }
    }

    const factors: PoolQualityFactors = {
      liquidity: liquidityScore,
      holderConcentration: holderScore,
      creatorReputation: creatorScore,
      age: ageScore,
    };

    const totalScore = liquidityScore + holderScore + creatorScore + ageScore;
    const grade = getGrade(totalScore);

    return {
      score: Math.round(totalScore),
      factors,
      grade,
    };
  } catch (error) {
    console.error(`[PoolQuality] Error scoring pool ${poolAddress}:`, error);
    return {
      score: 0,
      factors: { liquidity: 0, holderConcentration: 0, creatorReputation: 0, age: 0 },
      grade: "F",
    };
  }
}

/**
 * Score based on liquidity (0-25 points)
 */
function scoreLiquidity(liquidityUsd: number): number {
  if (liquidityUsd >= QUALITY_THRESHOLDS.excellentLiquidity) {
    return 25;
  } else if (liquidityUsd >= QUALITY_THRESHOLDS.goodLiquidity) {
    return 20;
  } else if (liquidityUsd >= QUALITY_THRESHOLDS.fairLiquidity) {
    return 15;
  } else if (liquidityUsd >= QUALITY_THRESHOLDS.poorLiquidity) {
    return 8;
  }
  return 0; // Too low liquidity
}

/**
 * Score based on holder concentration (0-25 points)
 * Lower concentration = better (more distributed)
 */
function scoreHolderConcentration(concentration: number, holderCount: number): number {
  // First check holder count
  let holderBonus = 0;
  if (holderCount >= QUALITY_THRESHOLDS.excellentHolders) {
    holderBonus = 8;
  } else if (holderCount >= QUALITY_THRESHOLDS.goodHolders) {
    holderBonus = 5;
  } else if (holderCount >= QUALITY_THRESHOLDS.fairHolders) {
    holderBonus = 2;
  }

  // Score concentration (expressed as decimal, e.g., 0.15 for 15%)
  let concentrationScore = 0;
  if (concentration <= QUALITY_THRESHOLDS.lowConcentration) {
    concentrationScore = 25; // Excellent distribution
  } else if (concentration <= QUALITY_THRESHOLDS.mediumConcentration) {
    concentrationScore = 18; // Good distribution
  } else if (concentration <= QUALITY_THRESHOLDS.highConcentration) {
    concentrationScore = 10; // Fair distribution
  } else {
    concentrationScore = 5; // Poor distribution
  }

  return concentrationScore;
}

/**
 * Score based on creator reputation (0-25 points)
 * This would integrate with whale-reputation.ts patterns
 */
function scoreCreatorReputation(reputationScore: number): number {
  // Reputation score is likely 0-100
  if (reputationScore >= 80) {
    return 25; // Excellent reputation
  } else if (reputationScore >= 60) {
    return 18; // Good reputation
  } else if (reputationScore >= 40) {
    return 10; // Fair reputation
  } else if (reputationScore >= 20) {
    return 5; // Poor reputation
  } else {
    return 0; // Unknown or suspicious
  }
}

/**
 * Score based on pool age (0-25 points)
 * Newer is better (fresh opportunity), but not too new (< 5 min)
 */
function scoreAge(discoveredAtUnix: number): number {
  const ageMinutes = (Date.now() / 1000 - discoveredAtUnix) / 60;

  // Too new - might be pump and dump
  if (ageMinutes < QUALITY_THRESHOLDS.minPoolAgeMinutes) {
    return 0;
  }

  // Sweet spot - 5 minutes to 2 hours old
  if (ageMinutes <= QUALITY_THRESHOLDS.optimalPoolAgeHours * 60) {
    // Linear scoring: 5 min = 10 points, 120 min = 25 points
    return Math.round(10 + (Math.min(ageMinutes, 120) / 120) * 15);
  }

  // Older pools get moderate score (missed the freshness window)
  if (ageMinutes <= 24 * 60) {
    return 15;
  }

  // Very old pools - less interesting as "new"
  return 5;
}

/**
 * Get letter grade from score
 */
function getGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * Update pool quality score in database
 */
export async function updatePoolQualityScore(poolAddress: string): Promise<PoolQualityScore> {
  try {
    const qualityScore = await scoreRaydiumPool(poolAddress);

    await db
      .update(raydiumPoolDiscoveries)
      .set({
        qualityScore: qualityScore.score,
        lastUpdatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(raydiumPoolDiscoveries.poolAddress, poolAddress));

    return qualityScore;
  } catch (error) {
    console.error(`[PoolQuality] Error updating quality score for ${poolAddress}:`, error);
    return {
      score: 0,
      factors: { liquidity: 0, holderConcentration: 0, creatorReputation: 0, age: 0 },
      grade: "F",
    };
  }
}

/**
 * Batch score multiple pools
 */
export async function batchScorePools(poolAddresses: string[]): Promise<Map<string, PoolQualityScore>> {
  const results = new Map<string, PoolQualityScore>();

  for (const address of poolAddresses) {
    const score = await scoreRaydiumPool(address);
    results.set(address, score);
  }

  return results;
}

/**
 * Get top-quality pools discovered recently
 */
export async function getTopQualityPools(limitMinutes: number = 60, limit: number = 10) {
  try {
    const cutoffTime = Math.floor((Date.now() - limitMinutes * 60 * 1000) / 1000);

    return await db.query.raydiumPoolDiscoveries.findMany({
      where: (pools, { gte, gt }) =>
        gte(pools.discoveredAt, cutoffTime),
      orderBy: (pools, { desc }) => desc(pools.qualityScore),
      limit,
    });
  } catch (error) {
    console.error("[PoolQuality] Error fetching top quality pools:", error);
    return [];
  }
}
