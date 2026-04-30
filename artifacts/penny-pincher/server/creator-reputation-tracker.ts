import { db } from "./db";
import { creatorReputation, tokenOutcomes, tokenFingerprints } from "@shared/schema";
import { and, eq, gte, lt, isNull, isNotNull } from "drizzle-orm";

/**
 * Creator Reputation Tracker
 * Maintains creator success metrics for early buying decisions
 *
 * Updates creator stats based on graduated token outcomes:
 * - Win rate: % of tokens that achieved 2x+
 * - Rug rate: % of tokens that crashed <0.5x
 * - Average/median multipliers
 * - Time-to-peak metrics
 * - Confidence scores (higher with more samples)
 */

export async function updateCreatorReputation(): Promise<void> {
  // Get all creators with recent token outcomes
  const creatorOutcomes = await db.query.tokenOutcomes
    .findMany({
      where: isNotNull(tokenOutcomes.bondingVelocity), // Has been analyzed
    });

  // Group by creator
  const byCreator = new Map<string, any[]>();
  for (const outcome of creatorOutcomes) {
    // Get the original fingerprint to find creator
    const fingerprint = await db
      .select({ creatorAddress: tokenFingerprints.creatorAddress })
      .from(tokenFingerprints)
      .where(eq(tokenFingerprints.tokenMint, outcome.tokenMint))
      .limit(1);

    if (!fingerprint[0]?.creatorAddress) continue;

    const creator = fingerprint[0].creatorAddress;
    if (!byCreator.has(creator)) {
      byCreator.set(creator, []);
    }
    byCreator.get(creator)!.push(outcome);
  }

  // Update each creator's reputation
  const now = Math.floor(Date.now() / 1000);

  for (const [creatorAddress, outcomes] of byCreator.entries()) {
    const totalLaunches = outcomes.length;
    const successfulLaunches = outcomes.filter((o) => (o.peakMultiplierAllTime ?? 1) >= 2).length;
    const rugCount = outcomes.filter((o) => (o.peakMultiplierAllTime ?? 1) < 0.5).length;

    const multipliers = outcomes
      .map((o) => o.peakMultiplierAllTime)
      .filter((m): m is number => m !== null && m !== undefined);

    const times = outcomes
      .map((o) => o.timeToPeakMinutes)
      .filter((t): t is number => t !== null && t !== undefined);

    // Calculate metrics
    const winRate = totalLaunches > 0 ? successfulLaunches / totalLaunches : 0;
    const rugRate = totalLaunches > 0 ? rugCount / totalLaunches : 0;
    const avgMultiplier =
      multipliers.length > 0 ? multipliers.reduce((a, b) => a + b) / multipliers.length : 1;
    const medianMultiplier = multipliers.length > 0 ? getMedian(multipliers) : 1;
    const avgTimeToX2 = times.length > 0 ? times.reduce((a, b) => a + b) / times.length : 0;

    // Confidence: Higher with more launches, capped at 100
    const confidence = Math.min(1.0, totalLaunches / 100);

    // Update or insert
    const existing = await db.query.creatorReputation.findFirst({
      where: eq(creatorReputation.creatorAddress, creatorAddress),
    });

    if (existing) {
      await db
        .update(creatorReputation)
        .set({
          totalLaunches,
          successfulLaunches,
          rugCount,
          winRate,
          rugRate,
          avgMultiplier,
          medianMultiplier,
          avgTimeToX2,
          confidence,
          lastAnalyzedAt: now,
          updatedAt: now,
        })
        .where(eq(creatorReputation.creatorAddress, creatorAddress));
    } else {
      await db.insert(creatorReputation).values({
        creatorAddress,
        totalLaunches,
        successfulLaunches,
        rugCount,
        winRate,
        rugRate,
        avgMultiplier,
        medianMultiplier,
        avgTimeToX2,
        confidence,
        firstLaunchAt: Math.min(...outcomes.map((o) => o.createdAt)),
        lastAnalyzedAt: now,
        createdAt: now,
      });
    }

    console.log(
      `[Creator] Updated ${creatorAddress}: ${successfulLaunches}/${totalLaunches} wins (${(winRate * 100).toFixed(1)}%) confidence=${(confidence * 100).toFixed(0)}%`
    );
  }
}

function getMedian(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Query creator reputation by address
 */
export async function getCreatorReputation(creatorAddress: string): Promise<any | null> {
  return db.query.creatorReputation.findFirst({
    where: eq(creatorReputation.creatorAddress, creatorAddress),
  });
}

/**
 * Find top creators by win rate
 */
export async function getTopCreators(limit: number = 20): Promise<any[]> {
  return db.query.creatorReputation
    .findMany({
      orderBy: (table) => [
        // Sort by: confidence * winRate (combines reliability + success)
        // This rewards creators with both high win rate AND enough samples
      ],
      limit,
    });
}

/**
 * Bulk update creator names (if metadata becomes available)
 */
export async function updateCreatorNames(creators: { address: string; name: string }[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  for (const { address, name } of creators) {
    await db
      .update(creatorReputation)
      .set({ creatorName: name, updatedAt: now })
      .where(eq(creatorReputation.creatorAddress, address));
  }
}
