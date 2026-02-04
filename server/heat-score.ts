import { db } from "./db";
import { holdings, pendingBuys, tokenSnapshots, heatFactorConfig, discoverySources } from "@shared/schema";
import { eq, gte, and, or, desc, sql } from "drizzle-orm";
import { getHoldersCached } from "./price-aggregator";

export interface TokenHeatData {
  tokenMint: string;
  tokenSymbol: string;
  heatScore: number;
  heatTier: "hot" | "warm" | "cold";
  factors: {
    recentBuys: number;
    priceVolatility: number;
    userAttention: number;
    recency: number;
    whaleActivity: number;
    discoveryQuality: number;
  };
  weights: {
    recentBuys: number;
    volatility: number;
    userAttention: number;
    recency: number;
    whaleActivity: number;
    discoveryQuality: number;
  };
  lastUpdated: number;
}

export interface HeatFactorWeights {
  recentBuys: number;
  volatility: number;
  userAttention: number;
  recency: number;
  whaleActivity: number;
  discoveryQuality: number;
}

const heatCache = new Map<string, TokenHeatData>();
const CACHE_TTL_MS = 60 * 1000;

let weightsCache: HeatFactorWeights | null = null;
let weightsCacheTime = 0;
const WEIGHTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getHeatFactorWeights(): Promise<HeatFactorWeights> {
  if (weightsCache && Date.now() - weightsCacheTime < WEIGHTS_CACHE_TTL) {
    return weightsCache;
  }
  
  const config = await db.select()
    .from(heatFactorConfig)
    .where(eq(heatFactorConfig.configKey, "global"))
    .limit(1);
  
  if (!config[0]) {
    const now = Math.floor(Date.now() / 1000);
    await db.insert(heatFactorConfig).values({
      configKey: "global",
      createdAt: now
    });
    
    weightsCache = {
      recentBuys: 0.25,
      volatility: 0.20,
      userAttention: 0.20,
      recency: 0.15,
      whaleActivity: 0.20,
      discoveryQuality: 0
    };
    weightsCacheTime = Date.now();
    return weightsCache;
  }
  
  weightsCache = {
    recentBuys: config[0].recentBuysWeight || 0.25,
    volatility: config[0].volatilityWeight || 0.20,
    userAttention: config[0].userAttentionWeight || 0.20,
    recency: config[0].recencyWeight || 0.15,
    whaleActivity: config[0].whaleActivityWeight || 0.20,
    discoveryQuality: config[0].discoveryQualityWeight || 0
  };
  weightsCacheTime = Date.now();
  return weightsCache;
}

export function clearWeightsCache(): void {
  weightsCache = null;
  weightsCacheTime = 0;
}

export async function calculateTokenHeat(tokenMint: string): Promise<TokenHeatData> {
  const cached = heatCache.get(tokenMint);
  if (cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;
  const oneHourAgo = now - 3600;

  let tokenSymbol = tokenMint.slice(0, 6) + "...";
  let recentBuysScore = 0;
  let priceVolatilityScore = 0;
  let userAttentionScore = 0;
  let recencyScore = 0;
  let whaleActivityScore = 0;

  const recentHoldings = await db.select().from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      gte(holdings.buyTimestamp, oneDayAgo)
    ));

  if (recentHoldings.length > 0) {
    tokenSymbol = recentHoldings[0].tokenSymbol;
    recentBuysScore = Math.min(100, recentHoldings.length * 20);
    
    const latestBuy = Math.max(...recentHoldings.map(h => h.buyTimestamp));
    const hoursSinceBuy = (now - latestBuy) / 3600;
    recencyScore = Math.max(0, 100 - hoursSinceBuy * 4);
    
    const uniqueUsers = new Set(recentHoldings.map(h => h.userId)).size;
    userAttentionScore = Math.min(100, uniqueUsers * 25);
  }

  const recentPending = await db.select().from(pendingBuys)
    .where(and(
      eq(pendingBuys.tokenMint, tokenMint),
      gte(pendingBuys.detectedAt, oneDayAgo)
    ));

  if (recentPending.length > 0) {
    recentBuysScore = Math.min(100, recentBuysScore + recentPending.length * 15);
    
    const uniquePendingUsers = new Set(recentPending.map(p => p.userId)).size;
    userAttentionScore = Math.min(100, userAttentionScore + uniquePendingUsers * 20);
    
    const latestPending = Math.max(...recentPending.map(p => p.detectedAt));
    const hoursSincePending = (now - latestPending) / 3600;
    recencyScore = Math.max(recencyScore, 100 - hoursSincePending * 4);
  }

  const snapshots = await db.select().from(tokenSnapshots)
    .where(eq(tokenSnapshots.tokenMint, tokenMint))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(5);

  if (snapshots.length >= 2) {
    const priceChanges: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i].priceUsd || 0;
      const curr = snapshots[i - 1].priceUsd || 0;
      if (prev > 0) {
        priceChanges.push(Math.abs((curr - prev) / prev) * 100);
      }
    }
    const avgChange = priceChanges.reduce((a, b) => a + b, 0) / (priceChanges.length || 1);
    priceVolatilityScore = Math.min(100, avgChange * 2);
  } else if (snapshots.length === 1 && snapshots[0].priceChange24h) {
    priceVolatilityScore = Math.min(100, Math.abs(snapshots[0].priceChange24h) * 2);
  }

  // Whale activity score based on recent holder cache activity
  try {
    const holderData = await getHoldersCached(tokenMint);
    if (holderData && holderData.lastEventTriggerAt > 0) {
      // If there was a whale event in the last hour, boost whale score
      const hoursSinceWhaleEvent = (Date.now() - holderData.lastEventTriggerAt) / (1000 * 3600);
      if (hoursSinceWhaleEvent < 1) {
        // Very recent whale activity - high score
        whaleActivityScore = Math.max(0, 100 - hoursSinceWhaleEvent * 50);
      } else if (hoursSinceWhaleEvent < 24) {
        // Recent whale activity within a day - moderate score
        whaleActivityScore = Math.max(0, 50 - (hoursSinceWhaleEvent - 1) * 2);
      }
      
      // Boost score if top 10 holder concentration is high (indicates whale interest)
      if (holderData.holders.length >= 10) {
        const top10Percent = holderData.holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);
        if (top10Percent > 50) {
          whaleActivityScore = Math.min(100, whaleActivityScore + 25);
        } else if (top10Percent > 30) {
          whaleActivityScore = Math.min(100, whaleActivityScore + 10);
        }
      }
    }
  } catch (error) {
    // Don't fail heat calculation if holder cache fails
    console.warn("Failed to get holder data for heat score:", error);
  }

  // Calculate discovery quality score based on source performance
  let discoveryQualityScore = 0;
  try {
    const sources = await db.select()
      .from(discoverySources)
      .where(eq(discoverySources.isActive, true));
    
    // Check if this token was discovered by high-performing sources
    // This is a simplified check - in practice, would track source per token
    const avgSuccessRate = sources.length > 0 
      ? sources.reduce((sum, s) => sum + (s.successRate || 0), 0) / sources.length 
      : 0;
    discoveryQualityScore = Math.min(100, avgSuccessRate * 100);
  } catch (err) {
    // Don't fail if discovery sources unavailable
  }

  // Get dynamic weights
  const weights = await getHeatFactorWeights();

  const heatScore = Math.round(
    (recentBuysScore * weights.recentBuys) +
    (priceVolatilityScore * weights.volatility) +
    (userAttentionScore * weights.userAttention) +
    (recencyScore * weights.recency) +
    (whaleActivityScore * weights.whaleActivity) +
    (discoveryQualityScore * weights.discoveryQuality)
  );

  let heatTier: "hot" | "warm" | "cold";
  if (heatScore >= 60) {
    heatTier = "hot";
  } else if (heatScore >= 30) {
    heatTier = "warm";
  } else {
    heatTier = "cold";
  }

  const heatData: TokenHeatData = {
    tokenMint,
    tokenSymbol,
    heatScore,
    heatTier,
    factors: {
      recentBuys: recentBuysScore,
      priceVolatility: priceVolatilityScore,
      userAttention: userAttentionScore,
      recency: recencyScore,
      whaleActivity: whaleActivityScore,
      discoveryQuality: discoveryQualityScore,
    },
    weights,
    lastUpdated: Date.now(),
  };

  heatCache.set(tokenMint, heatData);
  return heatData;
}

export async function getHotTokens(): Promise<TokenHeatData[]> {
  const allTokenMints = new Set<string>();

  const recentHoldings = await db.select({ tokenMint: holdings.tokenMint })
    .from(holdings)
    .where(gte(holdings.buyTimestamp, Math.floor(Date.now() / 1000) - 86400 * 3));

  recentHoldings.forEach(h => allTokenMints.add(h.tokenMint));

  const activePending = await db.select({ tokenMint: pendingBuys.tokenMint })
    .from(pendingBuys)
    .where(or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused")));

  activePending.forEach(p => allTokenMints.add(p.tokenMint));

  const heatScores: TokenHeatData[] = [];
  for (const tokenMint of Array.from(allTokenMints)) {
    const heat = await calculateTokenHeat(tokenMint);
    heatScores.push(heat);
  }

  return heatScores.sort((a, b) => b.heatScore - a.heatScore);
}

export async function getTokensByTier(tier: "hot" | "warm" | "cold"): Promise<TokenHeatData[]> {
  const allTokens = await getHotTokens();
  return allTokens.filter(t => t.heatTier === tier);
}

export function clearHeatCache(): void {
  heatCache.clear();
}

// =====================
// HEAT FACTOR LEARNING
// =====================

import { vectorUpdates } from "@shared/schema";

/**
 * Record heat factor values at trade entry time for later learning
 */
export async function recordHeatFactorSnapshot(
  tokenMint: string,
  positionId: string
): Promise<{ snapshotId: string; factors: TokenHeatData["factors"] }> {
  const heat = await calculateTokenHeat(tokenMint);
  const now = Math.floor(Date.now() / 1000);
  const bucketId = getCurrentBucketId();
  
  // Store factor snapshot in vectorUpdates for later correlation
  await db.insert(vectorUpdates).values({
    vectorType: "heat_factor_snapshot",
    targetId: positionId,
    signalType: "entry_snapshot",
    signalData: {
      tokenMint,
      factors: heat.factors,
      weights: heat.weights,
      heatScore: heat.heatScore
    },
    weight: 1.0,
    bucketId,
    processed: false,
    createdAt: now
  });
  
  return { snapshotId: positionId, factors: heat.factors };
}

/**
 * Record trade outcome and correlate with heat factors
 */
export async function recordHeatFactorOutcome(
  positionId: string,
  outcome: {
    isWin: boolean;
    pnlPercent: number;
  }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const bucketId = getCurrentBucketId();
  
  // Find the entry snapshot
  const snapshot = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "heat_factor_snapshot"),
      eq(vectorUpdates.targetId, positionId),
      eq(vectorUpdates.signalType, "entry_snapshot")
    ))
    .limit(1);
  
  if (!snapshot[0]) return;
  
  const snapshotData = snapshot[0].signalData as {
    factors: TokenHeatData["factors"];
    weights: HeatFactorWeights;
    heatScore: number;
  };
  
  // Record outcome update for each factor
  // Map factor names to match bounds keys
  const factorMapping: Record<string, keyof typeof snapshotData.factors> = {
    "recentBuys": "recentBuys",
    "volatility": "priceVolatility", // align with bounds key
    "userAttention": "userAttention",
    "recency": "recency",
    "whaleActivity": "whaleActivity",
    "discoveryQuality": "discoveryQuality"
  };
  
  for (const [factorId, factorKey] of Object.entries(factorMapping)) {
    const factorValue = snapshotData.factors[factorKey];
    
    // Weight based on factor's contribution to the trade
    const contributionWeight = factorValue / 100; // 0-1 based on how high the factor was
    
    await db.insert(vectorUpdates).values({
      vectorType: "heat_factor",
      targetId: factorId,
      signalType: outcome.isWin ? "factor_win" : "factor_loss",
      signalData: {
        positionId,
        factorValue,
        pnlPercent: outcome.pnlPercent
      },
      weight: contributionWeight * (outcome.isWin ? 2.0 : 1.5),
      bucketId,
      processed: false,
      createdAt: now
    });
  }
  
  // Mark snapshot as processed
  await db.update(vectorUpdates)
    .set({ processed: true })
    .where(eq(vectorUpdates.id, snapshot[0].id));
}

function getCurrentBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

/**
 * Process heat factor updates - called during 8-hour aggregation
 * Uses same dampened learning pattern as discovery sources
 */
export async function processHeatFactorUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "heat_factor"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));
  
  if (updates.length === 0) return 0;
  
  // Aggregate updates per factor
  const factorUpdates = new Map<string, { wins: number; losses: number; totalWeight: number }>();
  
  for (const update of updates) {
    const factorId = update.targetId;
    const current = factorUpdates.get(factorId) || { wins: 0, losses: 0, totalWeight: 0 };
    
    if (update.signalType === "factor_win") {
      current.wins += update.weight || 1;
    } else {
      current.losses += update.weight || 1;
    }
    current.totalWeight += update.weight || 1;
    
    factorUpdates.set(factorId, current);
  }
  
  // Get current config
  const config = await db.select()
    .from(heatFactorConfig)
    .where(eq(heatFactorConfig.configKey, "global"))
    .limit(1);
  
  if (!config[0]) return 0;
  
  const currentPerf = (config[0].factorPerformance || {}) as Record<string, {
    winCorrelation: number;
    sampleCount: number;
    confidence: number;
  }>;
  
  const bounds = (config[0].weightBounds || {}) as Record<string, { min: number; max: number }>;
  
  const now = Math.floor(Date.now() / 1000);
  const weightUpdates: Record<string, number> = {};
  
  for (const [factorId, data] of Array.from(factorUpdates.entries())) {
    const current = currentPerf[factorId] || { winCorrelation: 0.5, sampleCount: 0, confidence: 0.5 };
    
    // Dampened learning: slower updates as sample count grows
    const dampening = 1 / (1 + Math.log10(Math.max(1, current.sampleCount)));
    
    const recentWinRate = data.wins / (data.wins + data.losses);
    const newWinCorrelation = current.winCorrelation + dampening * (recentWinRate - current.winCorrelation) * 0.1;
    
    currentPerf[factorId] = {
      winCorrelation: newWinCorrelation,
      sampleCount: current.sampleCount + data.wins + data.losses,
      confidence: Math.min(1, current.confidence + 0.02)
    };
    
    // Calculate new weight based on win correlation
    // Higher win correlation = higher weight (within bounds)
    const factorBounds = bounds[factorId] || { min: 0.05, max: 0.35 };
    const baseWeight = 0.15; // neutral weight
    const adjustment = (newWinCorrelation - 0.5) * 0.2; // max ±10% adjustment
    
    weightUpdates[factorId] = Math.min(
      factorBounds.max,
      Math.max(factorBounds.min, baseWeight + adjustment)
    );
  }
  
  // Build complete weight set (include all factors, not just updated ones)
  const allFactors = ["recentBuys", "volatility", "userAttention", "recency", "whaleActivity", "discoveryQuality"];
  
  // Standardized bounds (use these as source of truth)
  const standardBounds: Record<string, { min: number; max: number }> = {
    recentBuys: { min: 0.05, max: 0.40 },
    volatility: { min: 0.05, max: 0.35 },
    userAttention: { min: 0.05, max: 0.35 },
    recency: { min: 0.05, max: 0.30 },
    whaleActivity: { min: 0.05, max: 0.35 },
    discoveryQuality: { min: 0, max: 0.25 }
  };
  
  const currentWeights = {
    recentBuys: config[0].recentBuysWeight || 0.25,
    volatility: config[0].volatilityWeight || 0.20,
    userAttention: config[0].userAttentionWeight || 0.20,
    recency: config[0].recencyWeight || 0.15,
    whaleActivity: config[0].whaleActivityWeight || 0.20,
    discoveryQuality: config[0].discoveryQualityWeight || 0
  };
  
  // Merge updated weights with current weights
  const allWeights: Record<string, number> = { ...currentWeights };
  for (const [factorId, weight] of Object.entries(weightUpdates)) {
    allWeights[factorId] = weight;
  }
  
  // Bounded normalization: normalize to 1.0 while respecting min/max bounds
  // Uses iterative approach: clamp fixed factors, redistribute remainder
  const normalizeWithBounds = (
    weights: Record<string, number>, 
    bounds: Record<string, { min: number; max: number }>
  ): Record<string, number> => {
    const result = { ...weights };
    const factors = Object.keys(result);
    
    // Iterative bounded normalization (max 10 iterations to prevent infinite loops)
    for (let iter = 0; iter < 10; iter++) {
      const total = Object.values(result).reduce((sum, w) => sum + w, 0);
      if (Math.abs(total - 1.0) < 0.001) break; // Already normalized
      
      const scale = 1.0 / total;
      let fixed = new Set<string>();
      let remaining = 1.0;
      
      // First pass: scale and identify clamped factors
      for (const key of factors) {
        const scaled = result[key] * scale;
        const b = bounds[key] || { min: 0.05, max: 0.35 };
        
        if (scaled < b.min) {
          result[key] = b.min;
          fixed.add(key);
          remaining -= b.min;
        } else if (scaled > b.max) {
          result[key] = b.max;
          fixed.add(key);
          remaining -= b.max;
        }
      }
      
      // Second pass: distribute remaining budget among unfixed factors
      const unfixed = factors.filter(k => !fixed.has(k));
      if (unfixed.length === 0) break;
      
      const unfixedTotal = unfixed.reduce((sum, k) => sum + result[k], 0);
      if (unfixedTotal > 0) {
        const redistScale = remaining / unfixedTotal;
        for (const key of unfixed) {
          result[key] *= redistScale;
        }
      }
    }
    
    // Final validation: ensure sum is exactly 1.0
    const finalTotal = Object.values(result).reduce((sum, w) => sum + w, 0);
    if (finalTotal > 0 && Math.abs(finalTotal - 1.0) > 0.001) {
      const adjust = 1.0 / finalTotal;
      for (const key of factors) {
        result[key] *= adjust;
      }
    }
    
    return result;
  };
  
  const normalizedWeights = normalizeWithBounds(allWeights, standardBounds);
  Object.assign(allWeights, normalizedWeights);
  
  // Update config with normalized weights
  await db.update(heatFactorConfig)
    .set({
      recentBuysWeight: allWeights["recentBuys"],
      volatilityWeight: allWeights["volatility"],
      userAttentionWeight: allWeights["userAttention"],
      recencyWeight: allWeights["recency"],
      whaleActivityWeight: allWeights["whaleActivity"],
      discoveryQualityWeight: allWeights["discoveryQuality"],
      factorPerformance: currentPerf,
      updatedAt: now
    })
    .where(eq(heatFactorConfig.configKey, "global"));
  
  // Mark updates as processed
  for (const update of updates) {
    await db.update(vectorUpdates)
      .set({ processed: true })
      .where(eq(vectorUpdates.id, update.id));
  }
  
  // Clear weights cache to pick up new values
  clearWeightsCache();
  
  console.log(`[HeatScore] Processed ${updates.length} factor updates for bucket ${bucketId}`);
  return updates.length;
}
