import { db } from "./db";
import { aiPredictions, aiAccuracyStats, tokenSnapshots, holdings } from "@shared/schema";
import { eq, and, gte, lte, isNotNull, isNull, desc, sql } from "drizzle-orm";

export interface PredictionData {
  tokenMint: string;
  tokenSymbol: string;
  snapshotId?: number;
  predictedScore: number;
  predictedOutcome: "bullish" | "bearish" | "neutral";
  confidenceLevel: number;
  reasoning?: string;
  redFlags?: string[];
  greenFlags?: string[];
  priceAtPrediction?: number;
  priceContext?: {
    marketCap?: number;
    liquidity?: number;
    volume24h?: number;
    heatScore?: number;
    whaleActivity?: boolean;
  };
  factorsSnapshot?: {
    priceChange?: number;
    timeDecay?: number;
    whaleActivity?: number;
    signalWalletStatus?: number;
    volumeTrend?: number;
  };
}

export async function recordPrediction(
  userId: number | null,
  data: PredictionData
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const [result] = await db.insert(aiPredictions).values({
    userId,
    tokenMint: data.tokenMint,
    tokenSymbol: data.tokenSymbol,
    snapshotId: data.snapshotId,
    predictedScore: data.predictedScore,
    predictedOutcome: data.predictedOutcome,
    confidenceLevel: data.confidenceLevel,
    reasoning: data.reasoning,
    redFlags: data.redFlags,
    greenFlags: data.greenFlags,
    priceAtPrediction: data.priceAtPrediction,
    priceContextAt: data.priceContext,
    factorsSnapshot: data.factorsSnapshot,
    predictedAt: now,
  }).returning({ id: aiPredictions.id });

  console.log(`[AIAccuracy] Recorded prediction #${result.id} for ${data.tokenSymbol}: ${data.predictedOutcome} (confidence: ${data.confidenceLevel.toFixed(2)})`);
  return result.id;
}

export async function resolvePrediction(
  predictionId: number,
  currentPrice: number,
  holdTimeMinutes?: number
): Promise<boolean> {
  const [prediction] = await db.select().from(aiPredictions)
    .where(eq(aiPredictions.id, predictionId))
    .limit(1);

  if (!prediction || prediction.resolvedAt) {
    return false;
  }

  const priceAtPrediction = prediction.priceAtPrediction || 0;
  if (priceAtPrediction <= 0) {
    console.log(`[AIAccuracy] Cannot resolve prediction #${predictionId} - no price at prediction`);
    return false;
  }

  const outcomeMultiplier = currentPrice / priceAtPrediction;
  
  let actualOutcome: "win" | "loss" | "breakeven";
  if (outcomeMultiplier >= 1.1) {
    actualOutcome = "win";
  } else if (outcomeMultiplier <= 0.9) {
    actualOutcome = "loss";
  } else {
    actualOutcome = "breakeven";
  }

  let wasAccurate = false;
  if (prediction.predictedOutcome === "bullish" && actualOutcome === "win") {
    wasAccurate = true;
  } else if (prediction.predictedOutcome === "bearish" && actualOutcome === "loss") {
    wasAccurate = true;
  } else if (prediction.predictedOutcome === "neutral" && actualOutcome === "breakeven") {
    wasAccurate = true;
  }

  const now = Math.floor(Date.now() / 1000);

  await db.update(aiPredictions)
    .set({
      actualOutcome,
      priceAtResolution: currentPrice,
      outcomeMultiplier,
      holdTimeMinutes,
      wasAccurate,
      resolvedAt: now,
    })
    .where(eq(aiPredictions.id, predictionId));

  console.log(`[AIAccuracy] Resolved prediction #${predictionId}: ${prediction.predictedOutcome} -> ${actualOutcome} (${outcomeMultiplier.toFixed(2)}x, accurate: ${wasAccurate})`);

  await updateAccuracyStats(prediction.userId);

  return true;
}

export async function resolveUnresolvedPredictions(
  tokenMint: string,
  currentPrice: number
): Promise<number> {
  const unresolvedPredictions = await db.select()
    .from(aiPredictions)
    .where(and(
      eq(aiPredictions.tokenMint, tokenMint),
      isNull(aiPredictions.resolvedAt),
      isNotNull(aiPredictions.priceAtPrediction)
    ));

  let resolvedCount = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const prediction of unresolvedPredictions) {
    const predictionAge = now - prediction.predictedAt;
    const minAgeMinutes = 60;

    if (predictionAge < minAgeMinutes * 60) continue;

    const holdTimeMinutes = Math.floor(predictionAge / 60);
    const resolved = await resolvePrediction(prediction.id, currentPrice, holdTimeMinutes);
    if (resolved) resolvedCount++;
  }

  return resolvedCount;
}

export async function resolvePredictionBySnapshotId(
  snapshotId: number,
  currentPrice: number,
  holdTimeMinutes?: number
): Promise<boolean> {
  const [prediction] = await db.select().from(aiPredictions)
    .where(and(
      eq(aiPredictions.snapshotId, snapshotId),
      isNull(aiPredictions.resolvedAt)
    ))
    .limit(1);

  if (!prediction) {
    return false;
  }

  return resolvePrediction(prediction.id, currentPrice, holdTimeMinutes);
}

/**
 * Resolve all unresolved predictions for a specific token when a position is closed
 * Called when a user sells their holdings of a token
 */
export async function resolvePredictionsOnPositionClose(
  tokenMint: string,
  exitPrice: number,
  holdTimeMinutes?: number,
  outcomeMultiplier?: number
): Promise<number> {
  // Find all unresolved predictions for this token (global predictions since they're token-level)
  const unresolvedPredictions = await db.select().from(aiPredictions)
    .where(and(
      eq(aiPredictions.tokenMint, tokenMint),
      isNull(aiPredictions.resolvedAt)
    ));

  if (unresolvedPredictions.length === 0) {
    return 0;
  }

  let resolvedCount = 0;
  for (const prediction of unresolvedPredictions) {
    const resolved = await resolvePrediction(prediction.id, exitPrice, holdTimeMinutes);
    if (resolved) resolvedCount++;
  }

  if (resolvedCount > 0) {
    console.log(`[AIAccuracy] Resolved ${resolvedCount} predictions on position close for token ${tokenMint}`);
    // Update global accuracy stats
    await updateAccuracyStats(null);
  }

  return resolvedCount;
}

export async function updateAccuracyStats(userId: number | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 60 * 60;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

  // Query predictions for this user (or null for global stats)
  let allPredictions;
  if (userId !== null) {
    allPredictions = await db.select().from(aiPredictions)
      .where(eq(aiPredictions.userId, userId));
  } else {
    allPredictions = await db.select().from(aiPredictions)
      .where(isNull(aiPredictions.userId));
  }

  const resolved = allPredictions.filter(p => p.resolvedAt);
  const accurate = resolved.filter(p => p.wasAccurate);
  const bullish = resolved.filter(p => p.predictedOutcome === "bullish");
  const bullishAccurate = bullish.filter(p => p.wasAccurate);
  const bearish = resolved.filter(p => p.predictedOutcome === "bearish");
  const bearishAccurate = bearish.filter(p => p.wasAccurate);

  const highConfidence = resolved.filter(p => (p.confidenceLevel || 0) > 0.7);
  const highConfidenceAccurate = highConfidence.filter(p => p.wasAccurate);
  const lowConfidence = resolved.filter(p => (p.confidenceLevel || 0) < 0.4);
  const lowConfidenceAccurate = lowConfidence.filter(p => p.wasAccurate);

  const last7d = resolved.filter(p => p.resolvedAt && p.resolvedAt > sevenDaysAgo);
  const last7dAccurate = last7d.filter(p => p.wasAccurate);
  const last30d = resolved.filter(p => p.resolvedAt && p.resolvedAt > thirtyDaysAgo);
  const last30dAccurate = last30d.filter(p => p.wasAccurate);

  const wins = resolved.filter(p => p.actualOutcome === "win" && p.outcomeMultiplier);
  const losses = resolved.filter(p => p.actualOutcome === "loss" && p.outcomeMultiplier);

  const avgMultiplierOnWins = wins.length > 0
    ? wins.reduce((sum, p) => sum + (p.outcomeMultiplier || 1), 0) / wins.length
    : null;
  const avgMultiplierOnLosses = losses.length > 0
    ? losses.reduce((sum, p) => sum + (p.outcomeMultiplier || 1), 0) / losses.length
    : null;

  const avgConfidence = resolved.length > 0
    ? resolved.reduce((sum, p) => sum + (p.confidenceLevel || 0.5), 0) / resolved.length
    : null;

  let existing;
  if (userId !== null) {
    [existing] = await db.select().from(aiAccuracyStats)
      .where(eq(aiAccuracyStats.userId, userId))
      .limit(1);
  } else {
    [existing] = await db.select().from(aiAccuracyStats)
      .where(isNull(aiAccuracyStats.userId))
      .limit(1);
  }

  const statsData = {
    userId,
    totalPredictions: allPredictions.length,
    resolvedPredictions: resolved.length,
    accuratePredictions: accurate.length,
    overallHitRate: resolved.length > 0 ? accurate.length / resolved.length : null,
    bullishPredictions: bullish.length,
    bullishAccurate: bullishAccurate.length,
    bearishPredictions: bearish.length,
    bearishAccurate: bearishAccurate.length,
    avgMultiplierOnWins,
    avgMultiplierOnLosses,
    avgConfidence,
    last7dHitRate: last7d.length > 0 ? last7dAccurate.length / last7d.length : null,
    last30dHitRate: last30d.length > 0 ? last30dAccurate.length / last30d.length : null,
    highConfidenceHitRate: highConfidence.length > 0 ? highConfidenceAccurate.length / highConfidence.length : null,
    lowConfidenceHitRate: lowConfidence.length > 0 ? lowConfidenceAccurate.length / lowConfidence.length : null,
    lastUpdated: now,
  };

  if (existing) {
    await db.update(aiAccuracyStats)
      .set(statsData)
      .where(eq(aiAccuracyStats.id, existing.id));
  } else {
    await db.insert(aiAccuracyStats).values(statsData);
  }

  console.log(`[AIAccuracy] Updated stats for user ${userId}: ${accurate.length}/${resolved.length} accurate (${((statsData.overallHitRate || 0) * 100).toFixed(1)}%)`);
}

export async function getAccuracyStats(userId: number | null): Promise<{
  totalPredictions: number;
  resolvedPredictions: number;
  overallHitRate: number;
  last7dHitRate: number | null;
  last30dHitRate: number | null;
  bullishHitRate: number | null;
  bearishHitRate: number | null;
  avgMultiplierOnWins: number | null;
  avgMultiplierOnLosses: number | null;
  confidenceCalibration: string;
} | null> {
  let stats;
  if (userId !== null) {
    [stats] = await db.select().from(aiAccuracyStats)
      .where(eq(aiAccuracyStats.userId, userId))
      .limit(1);
  } else {
    [stats] = await db.select().from(aiAccuracyStats)
      .where(isNull(aiAccuracyStats.userId))
      .limit(1);
  }

  if (!stats) {
    return null;
  }

  let confidenceCalibration = "unknown";
  if (stats.highConfidenceHitRate && stats.lowConfidenceHitRate) {
    const diff = stats.highConfidenceHitRate - stats.lowConfidenceHitRate;
    if (diff > 0.2) {
      confidenceCalibration = "well-calibrated";
    } else if (diff > 0) {
      confidenceCalibration = "slightly-calibrated";
    } else {
      confidenceCalibration = "overconfident";
    }
  }

  return {
    totalPredictions: stats.totalPredictions || 0,
    resolvedPredictions: stats.resolvedPredictions || 0,
    overallHitRate: stats.overallHitRate || 0,
    last7dHitRate: stats.last7dHitRate,
    last30dHitRate: stats.last30dHitRate,
    bullishHitRate: stats.bullishPredictions && stats.bullishPredictions > 0
      ? (stats.bullishAccurate || 0) / stats.bullishPredictions
      : null,
    bearishHitRate: stats.bearishPredictions && stats.bearishPredictions > 0
      ? (stats.bearishAccurate || 0) / stats.bearishPredictions
      : null,
    avgMultiplierOnWins: stats.avgMultiplierOnWins,
    avgMultiplierOnLosses: stats.avgMultiplierOnLosses,
    confidenceCalibration,
  };
}

export function getConfidenceAdjustment(overallHitRate: number | null): number {
  if (overallHitRate === null) return 1.0;

  if (overallHitRate >= 0.7) {
    return 1.2;
  } else if (overallHitRate >= 0.55) {
    return 1.1;
  } else if (overallHitRate >= 0.45) {
    return 1.0;
  } else if (overallHitRate >= 0.35) {
    return 0.9;
  } else {
    return 0.8;
  }
}

export async function getAccuracySummaryForChat(userId: number | null): Promise<string> {
  const stats = await getAccuracyStats(userId);

  if (!stats || stats.totalPredictions < 5) {
    return "I don't have enough prediction history yet to give you accuracy stats. Keep using me and I'll track my performance!";
  }

  const hitRatePercent = (stats.overallHitRate * 100).toFixed(1);
  const confidenceAdj = getConfidenceAdjustment(stats.overallHitRate);

  let performanceRating = "";
  if (stats.overallHitRate >= 0.6) {
    performanceRating = "I'm doing pretty well";
  } else if (stats.overallHitRate >= 0.45) {
    performanceRating = "I'm about average";
  } else {
    performanceRating = "I'm still learning";
  }

  let summary = `${performanceRating} - my overall hit rate is ${hitRatePercent}% across ${stats.resolvedPredictions} resolved predictions.\n\n`;

  if (stats.last7dHitRate !== null) {
    const last7d = (stats.last7dHitRate * 100).toFixed(0);
    summary += `Last 7 days: ${last7d}% hit rate\n`;
  }

  if (stats.bullishHitRate !== null) {
    summary += `Bullish calls: ${(stats.bullishHitRate * 100).toFixed(0)}%\n`;
  }
  if (stats.bearishHitRate !== null) {
    summary += `Bearish calls: ${(stats.bearishHitRate * 100).toFixed(0)}%\n`;
  }

  if (stats.avgMultiplierOnWins !== null) {
    summary += `\nWhen I'm right, avg gain: ${stats.avgMultiplierOnWins.toFixed(2)}x\n`;
  }
  if (stats.avgMultiplierOnLosses !== null) {
    summary += `When I'm wrong, avg loss: ${stats.avgMultiplierOnLosses.toFixed(2)}x\n`;
  }

  summary += `\nConfidence calibration: ${stats.confidenceCalibration}\n`;
  summary += `Confidence adjustment: ${confidenceAdj.toFixed(1)}x`;

  return summary;
}

export async function recordPredictionFromScore(
  userId: number | null,
  tokenMint: string,
  tokenSymbol: string,
  snapshotId: number,
  score: number,
  reasoning: string,
  redFlags: string[],
  greenFlags: string[],
  priceUsd?: number,
  marketCap?: number,
  liquidity?: number,
  volume24h?: number,
  factorsSnapshot?: {
    priceChange?: number;
    timeDecay?: number;
    whaleActivity?: number;
    signalWalletStatus?: number;
    volumeTrend?: number;
  }
): Promise<number> {
  let predictedOutcome: "bullish" | "bearish" | "neutral";
  if (score >= 70) {
    predictedOutcome = "bullish";
  } else if (score <= 30) {
    predictedOutcome = "bearish";
  } else {
    predictedOutcome = "neutral";
  }

  const normalizedScore = score / 100;
  const confidenceLevel = Math.abs(normalizedScore - 0.5) * 2;

  const stats = await getAccuracyStats(userId);
  const adjustment = getConfidenceAdjustment(stats?.overallHitRate ?? null);
  const adjustedConfidence = Math.min(1, Math.max(0, confidenceLevel * adjustment));

  return recordPrediction(userId, {
    tokenMint,
    tokenSymbol,
    snapshotId,
    predictedScore: score,
    predictedOutcome,
    confidenceLevel: adjustedConfidence,
    reasoning,
    redFlags,
    greenFlags,
    priceAtPrediction: priceUsd,
    priceContext: {
      marketCap,
      liquidity,
      volume24h,
    },
    factorsSnapshot,
  });
}
