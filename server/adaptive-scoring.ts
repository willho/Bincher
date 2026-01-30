import { db } from "./db";
import { aiPredictions, aiAccuracyStats, positionScoreSnapshots, discoveredFactors } from "@shared/schema";
import { eq, and, isNotNull, gte, lte, desc, sql, isNull } from "drizzle-orm";

// Market factors - used for AI predictions on new tokens
export interface MarketFactorWeights {
  liquidityHealth: number;
  volumeStrength: number;
  whaleConcentration: number;
  whaleActivity: number;
  tokenFreshness: number;
}

// Position factors - used for managing existing holdings
export interface PositionFactorWeights {
  priceChange: number;
  timeDecay: number;
  whaleActivity: number;
  signalWalletStatus: number;
  volumeTrend: number;
}

// Legacy alias for backward compatibility
export type AdaptiveWeights = PositionFactorWeights;

export interface MarketRegime {
  type: "bullish" | "bearish" | "sideways" | "volatile";
  confidence: number;
  detectedAt: number;
  indicators: {
    recentPriceDirection: number;
    volatility: number;
    whaleActivityLevel: number;
    avgHoldTime: number;
  };
}

export interface PatternInsight {
  pattern: string;
  occurrences: number;
  successRate: number;
  avgMultiplier: number;
  lastSeen: number;
}

// Base weights for market factors (AI predictions)
const BASE_MARKET_WEIGHTS: MarketFactorWeights = {
  liquidityHealth: 0.25,
  volumeStrength: 0.20,
  whaleConcentration: 0.20,
  whaleActivity: 0.15,
  tokenFreshness: 0.20,
};

// Base weights for position factors (holding decisions)
const BASE_POSITION_WEIGHTS: PositionFactorWeights = {
  priceChange: 0.35,
  timeDecay: 0.15,
  whaleActivity: 0.20,
  signalWalletStatus: 0.20,
  volumeTrend: 0.10,
};

// Legacy alias
const BASE_WEIGHTS = BASE_POSITION_WEIGHTS;

const WEIGHT_ADJUSTMENT_RATE = 0.1;
const MIN_SAMPLES_FOR_LEARNING = 10;
const PATTERN_MEMORY_DAYS = 30;

// Caches
let cachedMarketWeights: MarketFactorWeights | null = null;
let cachedPositionWeights: PositionFactorWeights | null = null;
let cachedMarketRegime: MarketRegime | null = null;
let cachedPatterns: PatternInsight[] = [];
let lastMarketWeightUpdate = 0;
let lastPositionWeightUpdate = 0;
let lastRegimeUpdate = 0;
let lastPatternUpdate = 0;

// Legacy
let cachedWeights: AdaptiveWeights | null = null;
let lastWeightUpdate = 0;

const WEIGHT_CACHE_TTL = 3600 * 1000;
const REGIME_CACHE_TTL = 900 * 1000;
const PATTERN_CACHE_TTL = 3600 * 1000;

// Global caches - adaptive scoring uses global market data, not user-specific
// Market factors (liquidity, volume, whale concentration) are global token properties
// Position factors are also global (we learn from all outcomes to help everyone)

// Legacy function for backward compatibility
export async function getAdaptiveWeights(): Promise<AdaptiveWeights> {
  return getAdaptivePositionWeights();
}

// Get adaptive weights for MARKET factors (AI predictions on new tokens)
export async function getAdaptiveMarketWeights(): Promise<MarketFactorWeights> {
  const now = Date.now();
  
  if (cachedMarketWeights && (now - lastMarketWeightUpdate) < WEIGHT_CACHE_TTL) {
    return cachedMarketWeights;
  }

  try {
    const weights = await calculateMarketFactorWeights();
    cachedMarketWeights = weights;
    lastMarketWeightUpdate = now;
    return weights;
  } catch (error) {
    console.error("[AdaptiveScoring] Error calculating market weights:", error);
    return BASE_MARKET_WEIGHTS;
  }
}

// Get adaptive weights for POSITION factors (managing existing holdings)
export async function getAdaptivePositionWeights(): Promise<PositionFactorWeights> {
  const now = Date.now();
  
  if (cachedPositionWeights && (now - lastPositionWeightUpdate) < WEIGHT_CACHE_TTL) {
    return cachedPositionWeights;
  }

  try {
    const weights = await calculatePositionFactorWeights();
    cachedPositionWeights = weights;
    lastPositionWeightUpdate = now;
    return weights;
  } catch (error) {
    console.error("[AdaptiveScoring] Error calculating position weights:", error);
    return BASE_POSITION_WEIGHTS;
  }
}

// Learn market factor weights from AI prediction outcomes
async function calculateMarketFactorWeights(): Promise<MarketFactorWeights> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  
  const recentPredictions = await db.select().from(aiPredictions)
    .where(and(
      isNotNull(aiPredictions.resolvedAt),
      isNotNull(aiPredictions.factorsSnapshot),
      gte(aiPredictions.predictedAt, thirtyDaysAgo)
    ))
    .orderBy(desc(aiPredictions.resolvedAt))
    .limit(200);

  if (recentPredictions.length < MIN_SAMPLES_FOR_LEARNING) {
    console.log(`[AdaptiveScoring] Not enough market predictions (${recentPredictions.length}), using base weights`);
    return BASE_MARKET_WEIGHTS;
  }

  const factorPerformance = {
    liquidityHealth: { totalWeight: 0, successWeight: 0 },
    volumeStrength: { totalWeight: 0, successWeight: 0 },
    whaleConcentration: { totalWeight: 0, successWeight: 0 },
    whaleActivity: { totalWeight: 0, successWeight: 0 },
    tokenFreshness: { totalWeight: 0, successWeight: 0 },
  };

  for (const prediction of recentPredictions) {
    const factors = (prediction.factorsSnapshot as Record<string, number>) || {};
    const wasSuccessful = prediction.wasAccurate;
    const multiplier = prediction.outcomeMultiplier || 1;

    for (const [key, value] of Object.entries(factors)) {
      if (key in factorPerformance) {
        const k = key as keyof typeof factorPerformance;
        const absValue = Math.abs(value || 0);
        factorPerformance[k].totalWeight += absValue;
        if (wasSuccessful) {
          factorPerformance[k].successWeight += absValue * multiplier;
        }
      }
    }
  }

  const adjustedWeights = { ...BASE_MARKET_WEIGHTS };

  for (const [factor, perf] of Object.entries(factorPerformance)) {
    if (perf.totalWeight > 0) {
      const successRate = perf.successWeight / perf.totalWeight;
      const baseWeight = BASE_MARKET_WEIGHTS[factor as keyof MarketFactorWeights];
      const adjustment = (successRate - 0.5) * WEIGHT_ADJUSTMENT_RATE;
      adjustedWeights[factor as keyof MarketFactorWeights] = Math.max(0.05, Math.min(0.50, baseWeight + adjustment));
    }
  }

  // Normalize to sum to 1
  const sum = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
  for (const factor of Object.keys(adjustedWeights)) {
    adjustedWeights[factor as keyof MarketFactorWeights] /= sum;
  }

  console.log("[AdaptiveScoring] Calculated adaptive market weights:", adjustedWeights);
  return adjustedWeights;
}

// Learn position factor weights from position scoring outcomes
async function calculatePositionFactorWeights(): Promise<PositionFactorWeights> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  
  const recentSnapshots = await db.select().from(positionScoreSnapshots)
    .where(and(
      isNotNull(positionScoreSnapshots.resolvedAt),
      isNotNull(positionScoreSnapshots.wasGoodScore),
      gte(positionScoreSnapshots.scoredAt, thirtyDaysAgo)
    ))
    .orderBy(desc(positionScoreSnapshots.resolvedAt))
    .limit(200);

  if (recentSnapshots.length < MIN_SAMPLES_FOR_LEARNING) {
    console.log(`[AdaptiveScoring] Not enough position snapshots (${recentSnapshots.length}), using base weights`);
    return BASE_POSITION_WEIGHTS;
  }

  const factorPerformance = {
    priceChange: { totalWeight: 0, successWeight: 0 },
    timeDecay: { totalWeight: 0, successWeight: 0 },
    whaleActivity: { totalWeight: 0, successWeight: 0 },
    signalWalletStatus: { totalWeight: 0, successWeight: 0 },
    volumeTrend: { totalWeight: 0, successWeight: 0 },
  };

  for (const snapshot of recentSnapshots) {
    const factors = snapshot.factorsSnapshot || {};
    const wasGood = snapshot.wasGoodScore;
    const multiplier = snapshot.exitMultiplier || 1;

    for (const [key, value] of Object.entries(factors)) {
      if (key in factorPerformance) {
        const k = key as keyof typeof factorPerformance;
        const absValue = Math.abs(value || 0);
        factorPerformance[k].totalWeight += absValue;
        if (wasGood) {
          factorPerformance[k].successWeight += absValue * multiplier;
        }
      }
    }
  }

  const adjustedWeights = { ...BASE_POSITION_WEIGHTS };

  for (const [factor, perf] of Object.entries(factorPerformance)) {
    if (perf.totalWeight > 0) {
      const successRate = perf.successWeight / perf.totalWeight;
      const baseWeight = BASE_POSITION_WEIGHTS[factor as keyof PositionFactorWeights];
      const adjustment = (successRate - 0.5) * WEIGHT_ADJUSTMENT_RATE;
      adjustedWeights[factor as keyof PositionFactorWeights] = Math.max(0.05, Math.min(0.50, baseWeight + adjustment));
    }
  }

  // Normalize to sum to 1
  const sum = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
  for (const factor of Object.keys(adjustedWeights)) {
    adjustedWeights[factor as keyof PositionFactorWeights] /= sum;
  }

  console.log("[AdaptiveScoring] Calculated adaptive position weights:", adjustedWeights);
  return adjustedWeights;
}

export async function detectMarketRegime(): Promise<MarketRegime> {
  const now = Date.now();
  
  if (cachedMarketRegime && (now - lastRegimeUpdate) < REGIME_CACHE_TTL) {
    return cachedMarketRegime;
  }

  try {
    const regime = await analyzeMarketConditions();
    cachedMarketRegime = regime;
    lastRegimeUpdate = now;
    return regime;
  } catch (error) {
    console.error("[AdaptiveScoring] Error detecting market regime:", error);
    return {
      type: "sideways",
      confidence: 0.5,
      detectedAt: now,
      indicators: {
        recentPriceDirection: 0,
        volatility: 0.5,
        whaleActivityLevel: 0.5,
        avgHoldTime: 24,
      },
    };
  }
}

async function analyzeMarketConditions(): Promise<MarketRegime> {
  const now = Math.floor(Date.now() / 1000);
  const twentyFourHoursAgo = now - 24 * 60 * 60;
  
  const recentPredictions = await db.select().from(aiPredictions)
    .where(and(
      isNotNull(aiPredictions.resolvedAt),
      gte(aiPredictions.predictedAt, twentyFourHoursAgo)
    ))
    .limit(50);

  if (recentPredictions.length < 5) {
    return {
      type: "sideways",
      confidence: 0.3,
      detectedAt: Date.now(),
      indicators: {
        recentPriceDirection: 0,
        volatility: 0.5,
        whaleActivityLevel: 0.5,
        avgHoldTime: 24,
      },
    };
  }

  let totalPriceMovement = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let totalVolatility = 0;
  let whaleFactorSum = 0;
  let holdTimeSum = 0;

  for (const pred of recentPredictions) {
    const multiplier = pred.outcomeMultiplier || 1;
    const pctChange = (multiplier - 1) * 100;
    
    totalPriceMovement += pctChange;
    if (pctChange > 0) positiveCount++;
    else if (pctChange < 0) negativeCount++;
    
    totalVolatility += Math.abs(pctChange);
    
    const factors = (pred.factorsSnapshot as Record<string, number>) || {};
    whaleFactorSum += Math.abs(factors.whaleActivity || 0);
    holdTimeSum += pred.holdTimeMinutes || 60;
  }

  const avgPriceDirection = totalPriceMovement / recentPredictions.length;
  const avgVolatility = totalVolatility / recentPredictions.length;
  const avgHoldTime = holdTimeSum / recentPredictions.length / 60;
  const whaleActivityLevel = Math.min(1, whaleFactorSum / (recentPredictions.length * 50));

  let type: MarketRegime["type"];
  let confidence: number;

  if (avgVolatility > 30) {
    type = "volatile";
    confidence = Math.min(0.9, avgVolatility / 50);
  } else if (avgPriceDirection > 10 && positiveCount > negativeCount * 1.5) {
    type = "bullish";
    confidence = Math.min(0.9, avgPriceDirection / 20);
  } else if (avgPriceDirection < -10 && negativeCount > positiveCount * 1.5) {
    type = "bearish";
    confidence = Math.min(0.9, Math.abs(avgPriceDirection) / 20);
  } else {
    type = "sideways";
    confidence = 1 - avgVolatility / 50;
  }

  const regime: MarketRegime = {
    type,
    confidence: Math.max(0.3, Math.min(0.95, confidence)),
    detectedAt: Date.now(),
    indicators: {
      recentPriceDirection: avgPriceDirection,
      volatility: avgVolatility,
      whaleActivityLevel,
      avgHoldTime,
    },
  };

  console.log(`[AdaptiveScoring] Market regime: ${type} (confidence: ${(confidence * 100).toFixed(1)}%)`);
  return regime;
}

export async function discoverPatterns(): Promise<PatternInsight[]> {
  const now = Date.now();
  
  // Global cache for market-level pattern discovery
  if (cachedPatterns.length > 0 && (now - lastPatternUpdate) < PATTERN_CACHE_TTL) {
    return cachedPatterns;
  }

  try {
    // Use null userId for global market-factor patterns
    const patterns = await analyzePatterns(null);
    cachedPatterns = patterns;
    lastPatternUpdate = now;
    return patterns;
  } catch (error) {
    console.error("[AdaptiveScoring] Error discovering patterns:", error);
    return [];
  }
}

async function analyzePatterns(userId: number | null): Promise<PatternInsight[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - PATTERN_MEMORY_DAYS * 24 * 60 * 60;
  
  let resolvedPredictions;
  if (userId !== null) {
    resolvedPredictions = await db.select().from(aiPredictions)
      .where(and(
        eq(aiPredictions.userId, userId),
        isNotNull(aiPredictions.resolvedAt),
        gte(aiPredictions.predictedAt, thirtyDaysAgo)
      ))
      .limit(200);
  } else {
    resolvedPredictions = await db.select().from(aiPredictions)
      .where(and(
        isNull(aiPredictions.userId),
        isNotNull(aiPredictions.resolvedAt),
        gte(aiPredictions.predictedAt, thirtyDaysAgo)
      ))
      .limit(200);
  }

  if (resolvedPredictions.length < 10) {
    return [];
  }

  const patternMap = new Map<string, {
    occurrences: number;
    successes: number;
    totalMultiplier: number;
    lastSeen: number;
  }>();

  for (const pred of resolvedPredictions) {
    const factors = (pred.factorsSnapshot as Record<string, number>) || {};
    const patternKey = classifyPattern(factors, pred.predictedOutcome || "neutral");
    
    const existing = patternMap.get(patternKey) || {
      occurrences: 0,
      successes: 0,
      totalMultiplier: 0,
      lastSeen: 0,
    };

    existing.occurrences++;
    if (pred.wasAccurate) existing.successes++;
    existing.totalMultiplier += pred.outcomeMultiplier || 1;
    existing.lastSeen = Math.max(existing.lastSeen, pred.resolvedAt || 0);
    
    patternMap.set(patternKey, existing);
  }

  const patterns: PatternInsight[] = [];
  
  for (const [pattern, data] of Array.from(patternMap.entries())) {
    if (data.occurrences >= 3) {
      patterns.push({
        pattern,
        occurrences: data.occurrences,
        successRate: data.successes / data.occurrences,
        avgMultiplier: data.totalMultiplier / data.occurrences,
        lastSeen: data.lastSeen * 1000,
      });
    }
  }

  patterns.sort((a, b) => b.successRate - a.successRate);
  
  console.log(`[AdaptiveScoring] Discovered ${patterns.length} patterns with sufficient data`);
  return patterns.slice(0, 10);
}

function classifyPattern(factors: Record<string, number>, prediction: string): string {
  const components: string[] = [];
  
  // Market factors (for AI predictions)
  if (factors.liquidityHealth !== undefined) {
    if (factors.liquidityHealth > 60) components.push("high_liquidity");
    else if (factors.liquidityHealth > 30) components.push("ok_liquidity");
    else components.push("low_liquidity");
  }
  
  if (factors.volumeStrength !== undefined) {
    if (factors.volumeStrength > 50) components.push("high_volume");
    else if (factors.volumeStrength > 20) components.push("ok_volume");
    else components.push("low_volume");
  }

  if (factors.whaleConcentration !== undefined) {
    if (factors.whaleConcentration > 50) components.push("concentrated");
    else if (factors.whaleConcentration > 20) components.push("moderate_concentration");
    else components.push("distributed");
  }

  // Position factors (for holding decisions)
  if (factors.priceChange !== undefined) {
    if (factors.priceChange > 50) components.push("strong_momentum");
    else if (factors.priceChange > 10) components.push("positive_momentum");
    else if (factors.priceChange < -30) components.push("heavy_dip");
    else if (factors.priceChange < -10) components.push("moderate_dip");
    else components.push("flat_price");
  }

  if (factors.whaleActivity !== undefined) {
    if (factors.whaleActivity > 30) components.push("high_whale_activity");
    else if (factors.whaleActivity > 0) components.push("some_whale_activity");
    else components.push("no_whale_activity");
  }

  if (factors.signalWalletStatus !== undefined) {
    if (factors.signalWalletStatus > 0) components.push("signal_holding");
    else components.push("signal_sold");
  }

  if (factors.timeDecay !== undefined) {
    if (factors.timeDecay < -30) components.push("stale");
    else if (factors.timeDecay < -10) components.push("aging");
    else components.push("fresh");
  }

  components.push(`pred_${prediction}`);

  return components.join("+");
}

// ============================================
// FACTOR DISCOVERY ENGINE
// ============================================

export interface DiscoveredFactorSuggestion {
  factorType: "market" | "position";
  factorName: string;
  description: string;
  correlationStrength: number;
  sampleSize: number;
  successRate: number;
  avgMultiplier: number;
  exampleConditions: string[];
}

// Analyze outcomes to discover potential new factors
export async function discoverNewFactors(): Promise<DiscoveredFactorSuggestion[]> {
  const suggestions: DiscoveredFactorSuggestion[] = [];
  
  try {
    // Discover market-related patterns
    const marketSuggestions = await analyzeMarketPatterns();
    suggestions.push(...marketSuggestions);
    
    // Discover position-related patterns
    const positionSuggestions = await analyzePositionPatterns();
    suggestions.push(...positionSuggestions);
    
    console.log(`[FactorDiscovery] Found ${suggestions.length} potential new factors`);
    return suggestions;
  } catch (error) {
    console.error("[FactorDiscovery] Error discovering factors:", error);
    return [];
  }
}

async function analyzeMarketPatterns(): Promise<DiscoveredFactorSuggestion[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const suggestions: DiscoveredFactorSuggestion[] = [];
  
  const predictions = await db.select().from(aiPredictions)
    .where(and(
      isNotNull(aiPredictions.resolvedAt),
      gte(aiPredictions.predictedAt, thirtyDaysAgo)
    ))
    .limit(500);

  if (predictions.length < 50) return suggestions;

  // Analyze high liquidity tokens
  const highLiquidityTokens = predictions.filter(p => {
    const ctx = p.priceContextAt as any;
    const mcap = ctx?.marketCap || 1;
    const liq = ctx?.liquidity || 0;
    return liq / mcap > 0.5;
  });
  
  if (highLiquidityTokens.length >= 20) {
    const successCount = highLiquidityTokens.filter(p => p.wasAccurate).length;
    const successRate = successCount / highLiquidityTokens.length;
    const avgMult = highLiquidityTokens.reduce((sum, p) => sum + (p.outcomeMultiplier || 1), 0) / highLiquidityTokens.length;
    
    if (successRate > 0.65) {
      suggestions.push({
        factorType: "market",
        factorName: "superLiquidity",
        description: "Tokens with >50% liquidity/mcap ratio have significantly better outcomes",
        correlationStrength: successRate,
        sampleSize: highLiquidityTokens.length,
        successRate,
        avgMultiplier: avgMult,
        exampleConditions: ["liquidity > 50% of market cap"],
      });
    }
  }

  // Analyze early tokens (< 24h old)
  const earlyTokens = predictions.filter(p => {
    const ctx = p.priceContextAt as any;
    return ctx?.heatScore && ctx.heatScore > 80;
  });
  
  if (earlyTokens.length >= 20) {
    const successCount = earlyTokens.filter(p => p.wasAccurate).length;
    const successRate = successCount / earlyTokens.length;
    const avgMult = earlyTokens.reduce((sum, p) => sum + (p.outcomeMultiplier || 1), 0) / earlyTokens.length;
    
    if (successRate > 0.6 || successRate < 0.35) {
      suggestions.push({
        factorType: "market",
        factorName: "heatMomentum",
        description: successRate > 0.5 
          ? "High-heat tokens (>80) correlate with positive outcomes"
          : "High-heat tokens (>80) actually underperform - consider as warning",
        correlationStrength: Math.abs(successRate - 0.5) * 2,
        sampleSize: earlyTokens.length,
        successRate,
        avgMultiplier: avgMult,
        exampleConditions: ["heat score > 80"],
      });
    }
  }

  return suggestions;
}

async function analyzePositionPatterns(): Promise<DiscoveredFactorSuggestion[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const suggestions: DiscoveredFactorSuggestion[] = [];
  
  const snapshots = await db.select().from(positionScoreSnapshots)
    .where(and(
      isNotNull(positionScoreSnapshots.resolvedAt),
      gte(positionScoreSnapshots.scoredAt, thirtyDaysAgo)
    ))
    .limit(500);

  if (snapshots.length < 50) return suggestions;

  // Analyze quick exits (< 30 min hold time)
  const quickExits = snapshots.filter(s => (s.holdTimeHours || 0) < 0.5);
  
  if (quickExits.length >= 20) {
    const goodCount = quickExits.filter(s => s.wasGoodScore).length;
    const successRate = goodCount / quickExits.length;
    const avgMult = quickExits.reduce((sum, s) => sum + (s.exitMultiplier || 1), 0) / quickExits.length;
    
    if (successRate < 0.4) {
      suggestions.push({
        factorType: "position",
        factorName: "quickFlipPenalty",
        description: "Positions held <30 minutes often result in losses - penalize quick flips",
        correlationStrength: (0.5 - successRate) * 2,
        sampleSize: quickExits.length,
        successRate,
        avgMultiplier: avgMult,
        exampleConditions: ["hold time < 30 minutes"],
      });
    }
  }

  // Analyze signal wallet sold but user held
  const signalSoldUserHeld = snapshots.filter(s => {
    const factors = s.factorsSnapshot || {};
    return factors.signalWalletStatus < 0 && (s.holdTimeHours || 0) > 1;
  });
  
  if (signalSoldUserHeld.length >= 15) {
    const goodCount = signalSoldUserHeld.filter(s => s.wasGoodScore).length;
    const successRate = goodCount / signalSoldUserHeld.length;
    const avgMult = signalSoldUserHeld.reduce((sum, s) => sum + (s.exitMultiplier || 1), 0) / signalSoldUserHeld.length;
    
    if (successRate < 0.35) {
      suggestions.push({
        factorType: "position",
        factorName: "signalExitIgnored",
        description: "Holding after signal wallet exits correlates with losses",
        correlationStrength: (0.5 - successRate) * 2,
        sampleSize: signalSoldUserHeld.length,
        successRate,
        avgMultiplier: avgMult,
        exampleConditions: ["signal wallet sold", "user continued holding >1hr"],
      });
    }
  }

  return suggestions;
}

// Save a discovered factor to the database
export async function saveDiscoveredFactor(suggestion: DiscoveredFactorSuggestion): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  const [inserted] = await db.insert(discoveredFactors).values({
    factorType: suggestion.factorType,
    factorName: suggestion.factorName,
    description: suggestion.description,
    correlationStrength: suggestion.correlationStrength,
    sampleSize: suggestion.sampleSize,
    successRate: suggestion.successRate,
    avgMultiplier: suggestion.avgMultiplier,
    status: "proposed",
    exampleConditions: suggestion.exampleConditions,
    discoveredAt: now,
    lastUpdated: now,
  }).returning({ id: discoveredFactors.id });
  
  console.log(`[FactorDiscovery] Saved new factor "${suggestion.factorName}" with id ${inserted.id}`);
  return inserted.id;
}

// Get all discovered factors
export async function getDiscoveredFactors(status?: string): Promise<typeof discoveredFactors.$inferSelect[]> {
  if (status) {
    return db.select().from(discoveredFactors)
      .where(eq(discoveredFactors.status, status))
      .orderBy(desc(discoveredFactors.correlationStrength));
  }
  return db.select().from(discoveredFactors)
    .orderBy(desc(discoveredFactors.discoveredAt));
}

// Activate a discovered factor (add to scoring system)
export async function activateDiscoveredFactor(factorId: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  
  await db.update(discoveredFactors)
    .set({ 
      status: "active",
      addedToScoringAt: now,
      lastUpdated: now,
    })
    .where(eq(discoveredFactors.id, factorId));
  
  console.log(`[FactorDiscovery] Activated factor ${factorId}`);
  return true;
}

export async function getAdaptiveScoringContext(): Promise<{
  weights: AdaptiveWeights;
  regime: MarketRegime;
  patterns: PatternInsight[];
  recommendations: string[];
}> {
  // All adaptive scoring context is global (market-level)
  // This ensures consistent weights, regime, and patterns for all users
  const [weights, regime, patterns] = await Promise.all([
    getAdaptiveWeights(),
    detectMarketRegime(),
    discoverPatterns(),
  ]);

  const recommendations = generateRecommendations(weights, regime, patterns);

  return { weights, regime, patterns, recommendations };
}

function generateRecommendations(
  weights: AdaptiveWeights,
  regime: MarketRegime,
  patterns: PatternInsight[]
): string[] {
  const recs: string[] = [];

  if (regime.type === "volatile" && regime.confidence > 0.6) {
    recs.push("Market is volatile - consider tighter stop-losses and smaller position sizes");
  }
  
  if (regime.type === "bearish" && regime.confidence > 0.6) {
    recs.push("Bearish conditions detected - favor defensive positions and quick exits");
  }
  
  if (regime.type === "bullish" && regime.confidence > 0.6) {
    recs.push("Bullish momentum active - consider letting winners run with trailing stops");
  }

  const topWeight = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  if (topWeight[1] > 0.40) {
    recs.push(`Factor '${topWeight[0]}' has been most predictive recently (${(topWeight[1] * 100).toFixed(0)}% weight)`);
  }

  const highSuccessPatterns = patterns.filter(p => p.successRate > 0.7 && p.occurrences >= 5);
  if (highSuccessPatterns.length > 0) {
    const pattern = highSuccessPatterns[0];
    recs.push(`Pattern '${pattern.pattern}' showing ${(pattern.successRate * 100).toFixed(0)}% success rate (${pattern.occurrences} samples)`);
  }

  const lowSuccessPatterns = patterns.filter(p => p.successRate < 0.3 && p.occurrences >= 5);
  if (lowSuccessPatterns.length > 0) {
    const pattern = lowSuccessPatterns[0];
    recs.push(`Avoid pattern '${pattern.pattern}' - only ${(pattern.successRate * 100).toFixed(0)}% success rate`);
  }

  return recs;
}

export function applyRegimeAdjustment(
  baseScore: number,
  regime: MarketRegime,
  predictionType: "bullish" | "bearish" | "neutral"
): number {
  let adjustment = 0;

  if (regime.type === "bullish" && predictionType === "bullish") {
    adjustment = 5 * regime.confidence;
  } else if (regime.type === "bullish" && predictionType === "bearish") {
    adjustment = -5 * regime.confidence;
  } else if (regime.type === "bearish" && predictionType === "bearish") {
    adjustment = 5 * regime.confidence;
  } else if (regime.type === "bearish" && predictionType === "bullish") {
    adjustment = -5 * regime.confidence;
  } else if (regime.type === "volatile") {
    adjustment = -3 * regime.confidence;
  }

  return Math.max(0, Math.min(100, baseScore + adjustment));
}

// Note: Market-level factor computation is in position-score.ts (computeMarketFactors)
// This keeps factor logic centralized and consistent

export function invalidateCaches(): void {
  cachedMarketWeights = null;
  cachedPositionWeights = null;
  cachedMarketRegime = null;
  cachedPatterns = [];
  cachedWeights = null;
  lastMarketWeightUpdate = 0;
  lastPositionWeightUpdate = 0;
  lastWeightUpdate = 0;
  lastRegimeUpdate = 0;
  lastPatternUpdate = 0;
  console.log("[AdaptiveScoring] All caches invalidated");
}

// Get full context for both scoring systems
export async function getFullAdaptiveScoringContext(): Promise<{
  marketWeights: MarketFactorWeights;
  positionWeights: PositionFactorWeights;
  regime: MarketRegime;
  patterns: PatternInsight[];
  discoveredFactors: DiscoveredFactorSuggestion[];
  recommendations: string[];
}> {
  const [marketWeights, positionWeights, regime, patterns, newFactors] = await Promise.all([
    getAdaptiveMarketWeights(),
    getAdaptivePositionWeights(),
    detectMarketRegime(),
    discoverPatterns(),
    discoverNewFactors(),
  ]);

  const recommendations = generateRecommendations(positionWeights, regime, patterns);

  // Add factor discovery recommendations
  if (newFactors.length > 0) {
    const topFactor = newFactors[0];
    recommendations.push(
      `Discovered potential new ${topFactor.factorType} factor: "${topFactor.factorName}" ` +
      `(${(topFactor.successRate * 100).toFixed(0)}% success rate, ${topFactor.sampleSize} samples)`
    );
  }

  return { 
    marketWeights, 
    positionWeights, 
    regime, 
    patterns, 
    discoveredFactors: newFactors,
    recommendations 
  };
}
