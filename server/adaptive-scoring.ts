import { db } from "./db";
import { aiPredictions, aiAccuracyStats } from "@shared/schema";
import { eq, and, isNotNull, gte, lte, desc, sql, isNull } from "drizzle-orm";

export interface AdaptiveWeights {
  priceChange: number;
  timeDecay: number;
  whaleActivity: number;
  signalWalletStatus: number;
  volumeTrend: number;
}

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

const BASE_WEIGHTS: AdaptiveWeights = {
  priceChange: 0.35,
  timeDecay: 0.15,
  whaleActivity: 0.20,
  signalWalletStatus: 0.20,
  volumeTrend: 0.10,
};

const WEIGHT_ADJUSTMENT_RATE = 0.1;
const MIN_PREDICTIONS_FOR_LEARNING = 10;
const PATTERN_MEMORY_DAYS = 30;

let cachedWeights: AdaptiveWeights | null = null;
let cachedMarketRegime: MarketRegime | null = null;
let cachedPatterns: PatternInsight[] = [];
let lastWeightUpdate = 0;
let lastRegimeUpdate = 0;
let lastPatternUpdate = 0;

const WEIGHT_CACHE_TTL = 3600 * 1000;
const REGIME_CACHE_TTL = 900 * 1000;
const PATTERN_CACHE_TTL = 3600 * 1000;

// Global caches - adaptive scoring uses global market data, not user-specific
// Rationale: Market factors (liquidity, volume, whale concentration) are global token properties
// Individual users don't have different "versions" of market conditions
// Position factors (entry price, hold time) are user-specific but stored in holdings, not predictions

export async function getAdaptiveWeights(): Promise<AdaptiveWeights> {
  const now = Date.now();
  
  // Global cache for market-level adaptive weights
  if (cachedWeights && (now - lastWeightUpdate) < WEIGHT_CACHE_TTL) {
    return cachedWeights;
  }

  try {
    // Use null userId for global market-factor learning
    const weights = await calculateAdaptiveWeights(null);
    cachedWeights = weights;
    lastWeightUpdate = now;
    return weights;
  } catch (error) {
    console.error("[AdaptiveScoring] Error calculating weights:", error);
    return BASE_WEIGHTS;
  }
}

async function calculateAdaptiveWeights(userId: number | null): Promise<AdaptiveWeights> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  
  let recentPredictions;
  if (userId !== null) {
    recentPredictions = await db.select().from(aiPredictions)
      .where(and(
        eq(aiPredictions.userId, userId),
        isNotNull(aiPredictions.resolvedAt),
        gte(aiPredictions.predictedAt, thirtyDaysAgo)
      ))
      .orderBy(desc(aiPredictions.resolvedAt))
      .limit(100);
  } else {
    recentPredictions = await db.select().from(aiPredictions)
      .where(and(
        isNull(aiPredictions.userId),
        isNotNull(aiPredictions.resolvedAt),
        gte(aiPredictions.predictedAt, thirtyDaysAgo)
      ))
      .orderBy(desc(aiPredictions.resolvedAt))
      .limit(100);
  }

  if (recentPredictions.length < MIN_PREDICTIONS_FOR_LEARNING) {
    console.log(`[AdaptiveScoring] Not enough predictions (${recentPredictions.length}), using base weights`);
    return BASE_WEIGHTS;
  }

  const factorPerformance = {
    priceChange: { totalWeight: 0, successWeight: 0 },
    timeDecay: { totalWeight: 0, successWeight: 0 },
    whaleActivity: { totalWeight: 0, successWeight: 0 },
    signalWalletStatus: { totalWeight: 0, successWeight: 0 },
    volumeTrend: { totalWeight: 0, successWeight: 0 },
  };

  for (const prediction of recentPredictions) {
    const factors = (prediction.factorsSnapshot as Record<string, number>) || {};
    const wasSuccessful = prediction.wasAccurate;
    const multiplier = prediction.outcomeMultiplier || 1;

    for (const [key, value] of Object.entries(factors)) {
      if (key in factorPerformance) {
        const k = key as keyof typeof factorPerformance;
        const absValue = Math.abs(value);
        factorPerformance[k].totalWeight += absValue;
        if (wasSuccessful) {
          factorPerformance[k].successWeight += absValue * multiplier;
        }
      }
    }
  }

  const adjustedWeights = { ...BASE_WEIGHTS };
  let totalAdjustment = 0;

  for (const [factor, perf] of Object.entries(factorPerformance)) {
    if (perf.totalWeight > 0) {
      const successRate = perf.successWeight / perf.totalWeight;
      const baseWeight = BASE_WEIGHTS[factor as keyof AdaptiveWeights];
      
      const adjustment = (successRate - 0.5) * WEIGHT_ADJUSTMENT_RATE;
      adjustedWeights[factor as keyof AdaptiveWeights] = Math.max(0.05, Math.min(0.50, baseWeight + adjustment));
      totalAdjustment += adjustedWeights[factor as keyof AdaptiveWeights] - baseWeight;
    }
  }

  const sum = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
  for (const factor of Object.keys(adjustedWeights)) {
    adjustedWeights[factor as keyof AdaptiveWeights] /= sum;
  }

  console.log("[AdaptiveScoring] Calculated adaptive weights:", adjustedWeights);
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
  
  if (factors.priceChange !== undefined) {
    if (factors.priceChange > 50) components.push("strong_momentum");
    else if (factors.priceChange > 10) components.push("positive_momentum");
    else if (factors.priceChange < -30) components.push("heavy_dip");
    else if (factors.priceChange < -10) components.push("moderate_dip");
    else components.push("flat_price");
  }

  if (factors.whaleActivity !== undefined) {
    if (factors.whaleActivity > 30) components.push("high_whale");
    else if (factors.whaleActivity > 0) components.push("some_whale");
    else if (factors.whaleActivity < -20) components.push("concentrated");
    else components.push("no_whale");
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
  cachedWeights = null;
  cachedMarketRegime = null;
  cachedPatterns = [];
  lastWeightUpdate = 0;
  lastRegimeUpdate = 0;
  lastPatternUpdate = 0;
  console.log("[AdaptiveScoring] Caches invalidated");
}
