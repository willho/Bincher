import { db } from "./db";
import { holdings, positionScoreSnapshots } from "@shared/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { getHoldersCached } from "./price-aggregator";
import { getAdaptivePositionWeights, PositionFactorWeights } from "./adaptive-scoring";

// Market-level factor computation for AI predictions
// Maps market data to the same factor interface used by position scoring
// This allows adaptive learning from market factors while using a common interface
// The factor semantics differ between contexts:
// - For market predictions: priceChange = liquidityHealth, timeDecay = freshness, etc.
// - For position scoring: priceChange = entry vs current price, timeDecay = holding duration
export interface MarketFactors {
  liquidityHealth: number;     // Liquidity/mcap ratio quality
  volumeStrength: number;      // Trading volume level
  whaleConcentration: number;  // Holder concentration risk
  whaleActivity: number;       // Recent whale movements
  tokenFreshness: number;      // How new/fresh the token is
}

export function computeMarketFactors(
  tokenData: {
    priceUsd?: number | null;
    marketCap?: number | null;
    liquidity?: number | null;
    volume24h?: number | null;
  },
  whaleData?: {
    topConcentration: number; // Can be top5 or top10, normalized to same scale
    recentWhaleActivity: boolean;
  }
): MarketFactors {
  const factors: MarketFactors = {
    liquidityHealth: 0,
    volumeStrength: 0,
    whaleConcentration: 0,
    whaleActivity: 0,
    tokenFreshness: 0,
  };

  // Liquidity health (liquidity/mcap ratio)
  if (tokenData.liquidity && tokenData.marketCap && tokenData.marketCap > 0) {
    const liquidityRatio = tokenData.liquidity / tokenData.marketCap;
    if (liquidityRatio > 0.1) {
      factors.liquidityHealth = 40; // Excellent liquidity
    } else if (liquidityRatio > 0.05) {
      factors.liquidityHealth = 20; // Good liquidity
    } else if (liquidityRatio > 0.02) {
      factors.liquidityHealth = 0;  // Acceptable
    } else {
      factors.liquidityHealth = -30; // Poor liquidity risk
    }
  }

  // Volume strength
  if (tokenData.volume24h !== undefined && tokenData.volume24h !== null) {
    if (tokenData.volume24h > 500000) {
      factors.volumeStrength = 35;
    } else if (tokenData.volume24h > 100000) {
      factors.volumeStrength = 20;
    } else if (tokenData.volume24h > 10000) {
      factors.volumeStrength = 5;
    } else {
      factors.volumeStrength = -15;
    }
  }

  // Whale data (topConcentration can be top5 or top10 - uses same thresholds)
  if (whaleData) {
    // Whale concentration risk
    if (whaleData.topConcentration > 80) {
      factors.whaleConcentration = -40;
    } else if (whaleData.topConcentration > 60) {
      factors.whaleConcentration = -20;
    } else if (whaleData.topConcentration > 40) {
      factors.whaleConcentration = 0;
    } else {
      factors.whaleConcentration = 15; // Well distributed
    }

    // Whale activity (recent movements)
    factors.whaleActivity = whaleData.recentWhaleActivity ? 25 : 0;
  }

  // Token freshness (new snapshot = fresh signal)
  factors.tokenFreshness = 10;

  return factors;
}

export interface PositionScoreFactors {
  priceChange: number;
  timeDecay: number;
  whaleActivity: number;
  signalWalletStatus: number;
  volumeTrend: number;
}

export interface PositionScoreResult {
  score: number;
  tier: "strong" | "neutral" | "weak";
  factors: PositionScoreFactors;
}

// Base position weights (used if not enough data for adaptive learning)
const BASE_POSITION_WEIGHTS: PositionFactorWeights = {
  priceChange: 0.35,     // Entry price vs current price movement
  timeDecay: 0.15,       // How long position has been held without gains
  whaleActivity: 0.20,   // Recent whale activity on the token
  signalWalletStatus: 0.20, // Whether signal wallet is still holding
  volumeTrend: 0.10,     // Volume change direction
};

// Get position weights (adaptive or base)
async function getPositionWeights(): Promise<PositionFactorWeights> {
  try {
    return await getAdaptivePositionWeights();
  } catch (error) {
    console.log("[PositionScore] Using base weights due to error:", error);
    return BASE_POSITION_WEIGHTS;
  }
}

export async function calculatePositionScore(
  holdingId: number,
  currentPrice: number | null,
  volumeChange24h?: number
): Promise<PositionScoreResult> {
  const [holding] = await db.select().from(holdings).where(eq(holdings.id, holdingId)).limit(1);
  
  if (!holding) {
    return { score: 50, tier: "neutral", factors: getEmptyFactors() };
  }

  const factors: PositionScoreFactors = {
    priceChange: 0,
    timeDecay: 0,
    whaleActivity: 0,
    signalWalletStatus: 0,
    volumeTrend: 0,
  };

  const now = Math.floor(Date.now() / 1000);

  if (currentPrice && holding.avgEntryPrice && holding.avgEntryPrice > 0) {
    const pctChange = ((currentPrice - holding.avgEntryPrice) / holding.avgEntryPrice) * 100;
    if (pctChange >= 100) {
      factors.priceChange = 100;
    } else if (pctChange >= 50) {
      factors.priceChange = 75 + (pctChange - 50) * 0.5;
    } else if (pctChange >= 0) {
      factors.priceChange = pctChange * 1.5;
    } else if (pctChange >= -30) {
      factors.priceChange = pctChange * 2;
    } else {
      factors.priceChange = Math.max(-100, pctChange * 1.5);
    }
  }

  const holdTimeHours = (now - holding.buyTimestamp) / 3600;
  if (factors.priceChange <= 5) {
    if (holdTimeHours > 72) {
      factors.timeDecay = -50;
    } else if (holdTimeHours > 48) {
      factors.timeDecay = -30;
    } else if (holdTimeHours > 24) {
      factors.timeDecay = -15;
    } else if (holdTimeHours > 12) {
      factors.timeDecay = -5;
    }
  }

  try {
    const holderData = await getHoldersCached(holding.tokenMint);
    if (holderData && holderData.lastEventTriggerAt > 0) {
      const hoursSinceWhaleEvent = (Date.now() - holderData.lastEventTriggerAt) / (1000 * 3600);
      if (hoursSinceWhaleEvent < 1) {
        factors.whaleActivity = 50;
      } else if (hoursSinceWhaleEvent < 6) {
        factors.whaleActivity = 30;
      } else if (hoursSinceWhaleEvent < 24) {
        factors.whaleActivity = 10;
      }
      
      const concentration = holderData.holders.slice(0, 5).reduce(
        (sum: number, h: { percent: number }) => sum + h.percent, 
        0
      );
      if (concentration > 80) {
        factors.whaleActivity = Math.min(factors.whaleActivity, -30);
      } else if (concentration > 60) {
        factors.whaleActivity = factors.whaleActivity * 0.5;
      }
    }
  } catch (e) {
    console.log(`[PositionScore] Could not get whale data for ${holding.tokenMint}`);
  }

  if (holding.signalWalletSold) {
    const hoursSinceSell = holding.signalWalletSoldAt ? (now - holding.signalWalletSoldAt) / 3600 : 0;
    if (hoursSinceSell < 6) {
      factors.signalWalletStatus = -50;
    } else if (hoursSinceSell < 24) {
      factors.signalWalletStatus = -35;
    } else {
      factors.signalWalletStatus = -20;
    }
  } else if (holding.signalWalletId) {
    factors.signalWalletStatus = 30;
  }

  if (volumeChange24h !== undefined) {
    if (volumeChange24h > 100) {
      factors.volumeTrend = 25;
    } else if (volumeChange24h > 50) {
      factors.volumeTrend = 15;
    } else if (volumeChange24h > 0) {
      factors.volumeTrend = 5;
    } else if (volumeChange24h > -30) {
      factors.volumeTrend = -10;
    } else {
      factors.volumeTrend = -25;
    }
  }

  // Use adaptive position weights (learned from position outcomes)
  const positionWeights = await getPositionWeights();
  const rawScore =
    (factors.priceChange * positionWeights.priceChange) +
    (factors.timeDecay * positionWeights.timeDecay) +
    (factors.whaleActivity * positionWeights.whaleActivity) +
    (factors.signalWalletStatus * positionWeights.signalWalletStatus) +
    (factors.volumeTrend * positionWeights.volumeTrend);

  let normalizedScore = Math.round(Math.max(0, Math.min(100, 50 + rawScore)));

  // Apply market regime adjustment
  try {
    const { detectMarketRegime, applyRegimeAdjustment } = await import("./adaptive-scoring");
    const regime = await detectMarketRegime();
    const predictedOutcome = normalizedScore >= 65 ? "bullish" : normalizedScore <= 35 ? "bearish" : "neutral";
    normalizedScore = Math.round(applyRegimeAdjustment(normalizedScore, regime, predictedOutcome));
  } catch (e) {
    // Regime adjustment is optional
  }

  let tier: "strong" | "neutral" | "weak";
  if (normalizedScore >= 65) {
    tier = "strong";
  } else if (normalizedScore >= 40) {
    tier = "neutral";
  } else {
    tier = "weak";
  }

  return { score: normalizedScore, tier, factors };
}

export async function updatePositionScore(
  holdingId: number,
  currentPrice: number | null,
  volumeChange24h?: number
): Promise<PositionScoreResult> {
  const result = await calculatePositionScore(holdingId, currentPrice, volumeChange24h);
  const now = Math.floor(Date.now() / 1000);

  await db.update(holdings)
    .set({
      positionScore: result.score,
      positionScoreTier: result.tier,
      scoreLastUpdated: now,
      scoreFactors: result.factors,
    })
    .where(eq(holdings.id, holdingId));

  return result;
}

export async function markSignalWalletSold(
  signalWalletId: number,
  tokenMint: string
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db.update(holdings)
    .set({
      signalWalletSold: true,
      signalWalletSoldAt: now,
    })
    .where(and(
      eq(holdings.signalWalletId, signalWalletId),
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.signalWalletSold, false)
    ))
    .returning({ id: holdings.id });

  console.log(`[PositionScore] Marked ${result.length} positions as signal wallet sold`);
  
  // Immediately recalculate scores for affected positions
  for (const { id } of result) {
    await updatePositionScore(id, null);
  }
  
  if (result.length > 0) {
    console.log(`[PositionScore] Recalculated scores for ${result.length} positions after signal wallet sold`);
  }
  
  return result.length;
}

export async function batchUpdatePositionScores(
  priceMap: Map<string, { price: number; volumeChange24h?: number }>
): Promise<number> {
  const allHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  const now = Math.floor(Date.now() / 1000);
  const SCORE_STALENESS_SECONDS = 300;

  for (const holding of allHoldings) {
    const priceData = priceMap.get(holding.tokenMint);
    if (!priceData) continue;

    const lastUpdate = holding.scoreLastUpdated || 0;
    const needsUpdate = 
      !holding.scoreLastUpdated || 
      now - lastUpdate > SCORE_STALENESS_SECONDS;

    if (needsUpdate) {
      await updatePositionScore(holding.id, priceData.price, priceData.volumeChange24h);
      updatedCount++;
    }
  }

  return updatedCount;
}

export async function updateScoreOnPriceMove(
  tokenMint: string,
  currentPrice: number,
  previousPrice: number | null,
  volumeChange24h?: number
): Promise<number> {
  if (!previousPrice || previousPrice <= 0) return 0;

  const pctChange = Math.abs((currentPrice - previousPrice) / previousPrice) * 100;
  if (pctChange < 10) return 0;

  const affectedHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  for (const holding of affectedHoldings) {
    await updatePositionScore(holding.id, currentPrice, volumeChange24h);
    updatedCount++;
  }

  if (updatedCount > 0) {
    console.log(`[PositionScore] Updated ${updatedCount} positions on ${pctChange.toFixed(1)}% price move for ${tokenMint}`);
  }

  return updatedCount;
}

export async function updateScoreOnWhaleActivity(tokenMint: string): Promise<number> {
  const affectedHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  for (const holding of affectedHoldings) {
    await updatePositionScore(holding.id, null);
    updatedCount++;
  }

  if (updatedCount > 0) {
    console.log(`[PositionScore] Updated ${updatedCount} positions on whale activity for ${tokenMint}`);
  }

  return updatedCount;
}

function getEmptyFactors(): PositionScoreFactors {
  return {
    priceChange: 0,
    timeDecay: 0,
    whaleActivity: 0,
    signalWalletStatus: 0,
    volumeTrend: 0,
  };
}

// ============================================
// POSITION SCORE SNAPSHOTS FOR ADAPTIVE LEARNING
// ============================================

// Record a position score snapshot for learning
export async function recordPositionScoreSnapshot(
  holdingId: number,
  result: PositionScoreResult,
  currentPrice: number | null,
  entryPrice: number | null,
  holdTimeHours: number
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  // Get holding details
  const [holding] = await db.select().from(holdings).where(eq(holdings.id, holdingId)).limit(1);
  if (!holding) return 0;
  
  try {
    const [inserted] = await db.insert(positionScoreSnapshots).values({
      holdingId,
      userId: holding.userId,
      tokenMint: holding.tokenMint,
      factorsSnapshot: result.factors,
      computedScore: result.score,
      scoreTier: result.tier,
      priceAtScoring: currentPrice,
      entryPrice: entryPrice,
      holdTimeHours: holdTimeHours,
      scoredAt: now,
    }).returning({ id: positionScoreSnapshots.id });
    
    return inserted.id;
  } catch (error) {
    console.error("[PositionScore] Error recording snapshot:", error);
    return 0;
  }
}

// Resolve position score snapshots when a position closes
export async function resolvePositionScoreSnapshots(
  holdingId: number,
  exitPrice: number,
  outcomeType: "profit_exit" | "loss_exit" | "held_through"
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  // Get all unresolved snapshots for this holding
  const snapshots = await db.select()
    .from(positionScoreSnapshots)
    .where(and(
      eq(positionScoreSnapshots.holdingId, holdingId),
      isNotNull(positionScoreSnapshots.entryPrice)
    ));
  
  let updatedCount = 0;
  
  for (const snapshot of snapshots) {
    if (snapshot.resolvedAt) continue;
    
    const entryPrice = snapshot.entryPrice || 0;
    const exitMultiplier = entryPrice > 0 ? exitPrice / entryPrice : 1;
    
    // Determine if score was "good" - high score predicted profit, low score predicted loss
    let wasGoodScore = false;
    if (outcomeType === "profit_exit") {
      // If we made profit, high scores were correct, low scores were wrong
      wasGoodScore = snapshot.computedScore >= 50;
    } else if (outcomeType === "loss_exit") {
      // If we lost, low scores were correct (warned us), high scores were wrong
      wasGoodScore = snapshot.computedScore < 50;
    } else {
      // Held through - neutral
      wasGoodScore = snapshot.computedScore >= 40 && snapshot.computedScore <= 60;
    }
    
    await db.update(positionScoreSnapshots)
      .set({
        exitPrice,
        exitMultiplier,
        wasGoodScore,
        outcomeType,
        resolvedAt: now,
      })
      .where(eq(positionScoreSnapshots.id, snapshot.id));
    
    updatedCount++;
  }
  
  if (updatedCount > 0) {
    console.log(`[PositionScore] Resolved ${updatedCount} snapshots for holding ${holdingId} (${outcomeType})`);
  }
  
  return updatedCount;
}

// Batch record snapshots for learning (call periodically during price updates)
export async function batchRecordSnapshots(
  priceMap: Map<string, { price: number }>
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const SNAPSHOT_INTERVAL_SECONDS = 3600; // Record snapshot every hour max
  
  const allHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let recordedCount = 0;
  
  for (const holding of allHoldings) {
    const priceData = priceMap.get(holding.tokenMint);
    if (!priceData || !holding.positionScore) continue;
    
    // Only record if we haven't recorded recently
    const lastScoreUpdate = holding.scoreLastUpdated || 0;
    if (now - lastScoreUpdate < SNAPSHOT_INTERVAL_SECONDS) continue;
    
    const holdTimeHours = (now - holding.buyTimestamp) / 3600;
    
    await recordPositionScoreSnapshot(
      holding.id,
      {
        score: holding.positionScore,
        tier: (holding.positionScoreTier as "strong" | "neutral" | "weak") || "neutral",
        factors: (holding.scoreFactors as PositionScoreFactors) || getEmptyFactors(),
      },
      priceData.price,
      holding.avgEntryPrice,
      holdTimeHours
    );
    
    recordedCount++;
  }
  
  if (recordedCount > 0) {
    console.log(`[PositionScore] Recorded ${recordedCount} position snapshots for learning`);
  }
  
  return recordedCount;
}

// Tiered Event Bucket System - tracks position journey with compressed tiers
// 15min: detailed events (24 hours), hourly: summaries (7 days), daily: long-term

export interface EventBucket {
  tier: "15min" | "hourly" | "daily";
  bucketStart: number;
  holderDelta: number;
  priceRange: { low: number; high: number };
  whaleEvents: Array<{ wallet: string; action: "buy" | "sell"; rank: number; timestamp: number }>;
  eventCount: number;
  peakMultiplier: number;
}

export interface PositionEntrySnapshot {
  holderCount: number;
  price: number;
  marketCap: number;
  timestamp: number;
}

export interface PositionCurrentSnapshot {
  holderCount: number;
  price: number;
  marketCap: number;
  peakMultiplier: number;
  significantEvents: number;
  timestamp: number;
}

// Record entry snapshot when position is created
export async function recordPositionEntrySnapshot(
  holdingId: number,
  snapshot: PositionEntrySnapshot
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  // Find or create the snapshot record
  const existing = await db.select().from(positionScoreSnapshots)
    .where(eq(positionScoreSnapshots.holdingId, holdingId))
    .then(rows => rows[0]);
  
  if (!existing) {
    // Will be created when first position score is recorded
    console.log(`[EventBuckets] Will record entry snapshot for holding ${holdingId} on first score`);
    return;
  }
  
  await db.update(positionScoreSnapshots)
    .set({
      entrySnapshot: snapshot,
    })
    .where(eq(positionScoreSnapshots.id, existing.id));
  
  console.log(`[EventBuckets] Recorded entry snapshot for holding ${holdingId}`);
}

// Add event to appropriate bucket
export async function addEventToBucket(
  holdingId: number,
  event: { wallet?: string; action?: "buy" | "sell"; rank?: number; price: number; holderChange?: number }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const BUCKET_15MIN = 15 * 60;
  
  const existing = await db.select().from(positionScoreSnapshots)
    .where(eq(positionScoreSnapshots.holdingId, holdingId))
    .then(rows => rows[0]);
  
  if (!existing) return;
  
  const buckets: EventBucket[] = (existing.eventBuckets as EventBucket[]) || [];
  const currentBucketStart = Math.floor(now / BUCKET_15MIN) * BUCKET_15MIN;
  
  // Find or create current 15-min bucket
  let currentBucket = buckets.find(b => 
    b.tier === "15min" && b.bucketStart === currentBucketStart
  );
  
  if (!currentBucket) {
    currentBucket = {
      tier: "15min",
      bucketStart: currentBucketStart,
      holderDelta: 0,
      priceRange: { low: event.price, high: event.price },
      whaleEvents: [],
      eventCount: 0,
      peakMultiplier: 1,
    };
    buckets.push(currentBucket);
  }
  
  // Update bucket
  currentBucket.eventCount++;
  currentBucket.priceRange.low = Math.min(currentBucket.priceRange.low, event.price);
  currentBucket.priceRange.high = Math.max(currentBucket.priceRange.high, event.price);
  currentBucket.holderDelta += event.holderChange || 0;
  
  if (event.wallet && event.action && event.rank !== undefined) {
    currentBucket.whaleEvents.push({
      wallet: event.wallet.slice(0, 8), // Truncate for privacy
      action: event.action,
      rank: event.rank,
      timestamp: now,
    });
  }
  
  // Rollup old 15min buckets to hourly (after 24 hours)
  const oneDayAgo = now - 24 * 60 * 60;
  const needsRollup = buckets.filter(b => 
    b.tier === "15min" && b.bucketStart < oneDayAgo
  );
  
  if (needsRollup.length >= 4) { // Rollup when we have 4+ old 15min buckets (1 hour)
    await rollupBuckets(holdingId, buckets);
    return;
  }
  
  await db.update(positionScoreSnapshots)
    .set({ eventBuckets: buckets })
    .where(eq(positionScoreSnapshots.id, existing.id));
}

// Rollup 15min buckets to hourly, and hourly to daily
async function rollupBuckets(holdingId: number, buckets: EventBucket[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const HOUR = 60 * 60;
  const DAY = 24 * HOUR;
  const oneDayAgo = now - DAY;
  const sevenDaysAgo = now - 7 * DAY;
  
  // Group old 15min buckets by hour
  const old15min = buckets.filter(b => b.tier === "15min" && b.bucketStart < oneDayAgo);
  const hourlyGroups = new Map<number, EventBucket[]>();
  
  for (const bucket of old15min) {
    const hourStart = Math.floor(bucket.bucketStart / HOUR) * HOUR;
    if (!hourlyGroups.has(hourStart)) {
      hourlyGroups.set(hourStart, []);
    }
    hourlyGroups.get(hourStart)!.push(bucket);
  }
  
  // Create hourly summaries
  const newBuckets: EventBucket[] = buckets.filter(b => 
    !(b.tier === "15min" && b.bucketStart < oneDayAgo)
  );
  
  Array.from(hourlyGroups.entries()).forEach(([hourStart, group]: [number, EventBucket[]]) => {
    const hourlyBucket: EventBucket = {
      tier: "hourly",
      bucketStart: hourStart,
      holderDelta: group.reduce((sum: number, b: EventBucket) => sum + b.holderDelta, 0),
      priceRange: {
        low: Math.min(...group.map((b: EventBucket) => b.priceRange.low)),
        high: Math.max(...group.map((b: EventBucket) => b.priceRange.high)),
      },
      whaleEvents: group.flatMap((b: EventBucket) => b.whaleEvents).slice(0, 5), // Keep top 5 whale events
      eventCount: group.reduce((sum: number, b: EventBucket) => sum + b.eventCount, 0),
      peakMultiplier: Math.max(...group.map((b: EventBucket) => b.peakMultiplier)),
    };
    newBuckets.push(hourlyBucket);
  });
  
  // Rollup old hourly to daily (after 7 days)
  const oldHourly = newBuckets.filter(b => b.tier === "hourly" && b.bucketStart < sevenDaysAgo);
  const dailyGroups = new Map<number, EventBucket[]>();
  
  for (const bucket of oldHourly) {
    const dayStart = Math.floor(bucket.bucketStart / DAY) * DAY;
    if (!dailyGroups.has(dayStart)) {
      dailyGroups.set(dayStart, []);
    }
    dailyGroups.get(dayStart)!.push(bucket);
  }
  
  const finalBuckets: EventBucket[] = newBuckets.filter(b => 
    !(b.tier === "hourly" && b.bucketStart < sevenDaysAgo)
  );
  
  Array.from(dailyGroups.entries()).forEach(([dayStart, group]: [number, EventBucket[]]) => {
    const dailyBucket: EventBucket = {
      tier: "daily",
      bucketStart: dayStart,
      holderDelta: group.reduce((sum: number, b: EventBucket) => sum + b.holderDelta, 0),
      priceRange: {
        low: Math.min(...group.map((b: EventBucket) => b.priceRange.low)),
        high: Math.max(...group.map((b: EventBucket) => b.priceRange.high)),
      },
      whaleEvents: [], // No whale events in daily summaries
      eventCount: group.reduce((sum: number, b: EventBucket) => sum + b.eventCount, 0),
      peakMultiplier: Math.max(...group.map((b: EventBucket) => b.peakMultiplier)),
    };
    finalBuckets.push(dailyBucket);
  });
  
  const existing = await db.select().from(positionScoreSnapshots)
    .where(eq(positionScoreSnapshots.holdingId, holdingId))
    .then(rows => rows[0]);
  
  if (existing) {
    await db.update(positionScoreSnapshots)
      .set({ eventBuckets: finalBuckets })
      .where(eq(positionScoreSnapshots.id, existing.id));
    
    console.log(`[EventBuckets] Rolled up buckets for holding ${holdingId}: ${finalBuckets.length} total`);
  }
}

// Update current snapshot during position lifecycle
export async function updateCurrentSnapshot(
  holdingId: number,
  current: PositionCurrentSnapshot
): Promise<void> {
  const existing = await db.select().from(positionScoreSnapshots)
    .where(eq(positionScoreSnapshots.holdingId, holdingId))
    .then(rows => rows[0]);
  
  if (!existing) return;
  
  await db.update(positionScoreSnapshots)
    .set({
      currentSnapshot: current,
    })
    .where(eq(positionScoreSnapshots.id, existing.id));
}

// Exported wrapper to run bucket rollups for all snapshots
export async function runBucketRollups(): Promise<number> {
  const snapshots = await db.select().from(positionScoreSnapshots);
  let rolledUp = 0;
  
  for (const snapshot of snapshots) {
    const buckets = (snapshot.eventBuckets || []) as EventBucket[];
    if (buckets.length === 0) continue;
    
    try {
      await rollupBuckets(snapshot.holdingId, buckets);
      rolledUp++;
    } catch (e) {
      console.error(`[EventBuckets] Rollup error for holding ${snapshot.holdingId}: ${e}`);
    }
  }
  
  return rolledUp;
}
