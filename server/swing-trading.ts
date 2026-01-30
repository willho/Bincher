import { db } from "./db";
import { priceAggregates, swingTradeSettings, holdings, SwingTradeSettings } from "@shared/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";

export interface SupportResistanceLevel {
  price: number;
  type: "support" | "resistance";
  strength: number; // 0-100, based on touch count and recency
  bounces: number;
  lastTouched: number;
}

export interface PatternDetection {
  pattern: string;
  confidence: number; // 0-100
  direction: "bullish" | "bearish" | "neutral";
  description: string;
  timestamp: number;
}

export interface VolumeSpike {
  timestamp: number;
  volume: number;
  avgVolume: number;
  multiplier: number;
  priceChange: number;
  direction: "buy" | "sell" | "mixed";
}

export interface BreakoutAlert {
  type: "support_break" | "resistance_break" | "volume_spike" | "pattern_complete";
  tokenMint: string;
  level?: number;
  currentPrice: number;
  confidence: number;
  direction: "bullish" | "bearish";
  message: string;
  timestamp: number;
}

export interface SwingAnalysis {
  tokenMint: string;
  currentPrice: number;
  supportLevels: SupportResistanceLevel[];
  resistanceLevels: SupportResistanceLevel[];
  patterns: PatternDetection[];
  volumeSpikes: VolumeSpike[];
  alerts: BreakoutAlert[];
  swingScore: number; // 0-100, overall swing trading opportunity score
}

async function getOHLCData(tokenMint: string, tier: string, lookback: number): Promise<typeof priceAggregates.$inferSelect[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - lookback;
  
  return await db.select()
    .from(priceAggregates)
    .where(and(
      eq(priceAggregates.tokenMint, tokenMint),
      eq(priceAggregates.tier, tier),
      gte(priceAggregates.bucketStart, cutoff)
    ))
    .orderBy(priceAggregates.bucketStart);
}

export function detectSupportResistance(ohlcData: typeof priceAggregates.$inferSelect[], sensitivity: number = 0.02): {
  supports: SupportResistanceLevel[];
  resistances: SupportResistanceLevel[];
} {
  if (ohlcData.length < 10) {
    return { supports: [], resistances: [] };
  }
  
  const pricePoints: { price: number; timestamp: number; type: "high" | "low" }[] = [];
  
  // Extract local highs and lows
  for (let i = 2; i < ohlcData.length - 2; i++) {
    const curr = ohlcData[i];
    const prev1 = ohlcData[i - 1];
    const prev2 = ohlcData[i - 2];
    const next1 = ohlcData[i + 1];
    const next2 = ohlcData[i + 2];
    
    if (!curr.priceHigh || !curr.priceLow) continue;
    
    // Local high (swing high)
    if (curr.priceHigh >= (prev1.priceHigh || 0) && 
        curr.priceHigh >= (prev2.priceHigh || 0) &&
        curr.priceHigh >= (next1.priceHigh || 0) &&
        curr.priceHigh >= (next2.priceHigh || 0)) {
      pricePoints.push({ price: curr.priceHigh, timestamp: curr.bucketStart, type: "high" });
    }
    
    // Local low (swing low)
    if (curr.priceLow <= (prev1.priceLow || Infinity) &&
        curr.priceLow <= (prev2.priceLow || Infinity) &&
        curr.priceLow <= (next1.priceLow || Infinity) &&
        curr.priceLow <= (next2.priceLow || Infinity)) {
      pricePoints.push({ price: curr.priceLow, timestamp: curr.bucketStart, type: "low" });
    }
  }
  
  // Cluster nearby price points to find support/resistance zones
  const clusters: { 
    avgPrice: number;
    points: typeof pricePoints;
    type: "support" | "resistance";
  }[] = [];
  
  const sortedPoints = [...pricePoints].sort((a, b) => a.price - b.price);
  
  for (const point of sortedPoints) {
    // Find existing cluster within sensitivity range
    const existingCluster = clusters.find(c => 
      Math.abs(c.avgPrice - point.price) / c.avgPrice < sensitivity
    );
    
    if (existingCluster) {
      existingCluster.points.push(point);
      existingCluster.avgPrice = existingCluster.points.reduce((sum, p) => sum + p.price, 0) / existingCluster.points.length;
    } else {
      clusters.push({
        avgPrice: point.price,
        points: [point],
        type: point.type === "low" ? "support" : "resistance"
      });
    }
  }
  
  // Convert clusters to support/resistance levels
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 7 * 24 * 3600; // 7 days
  
  const supports: SupportResistanceLevel[] = [];
  const resistances: SupportResistanceLevel[] = [];
  
  for (const cluster of clusters) {
    if (cluster.points.length < 2) continue; // Need at least 2 touches
    
    const lastTouched = Math.max(...cluster.points.map(p => p.timestamp));
    const recency = 1 - Math.min(1, (now - lastTouched) / maxAge);
    const touchWeight = Math.min(1, cluster.points.length / 5);
    const strength = Math.round((recency * 0.4 + touchWeight * 0.6) * 100);
    
    const level: SupportResistanceLevel = {
      price: cluster.avgPrice,
      type: cluster.type,
      strength,
      bounces: cluster.points.length,
      lastTouched
    };
    
    if (cluster.type === "support") {
      supports.push(level);
    } else {
      resistances.push(level);
    }
  }
  
  // Sort by strength descending
  supports.sort((a, b) => b.strength - a.strength);
  resistances.sort((a, b) => b.strength - a.strength);
  
  return { supports: supports.slice(0, 3), resistances: resistances.slice(0, 3) };
}

export function detectPatterns(ohlcData: typeof priceAggregates.$inferSelect[]): PatternDetection[] {
  const patterns: PatternDetection[] = [];
  
  if (ohlcData.length < 10) return patterns;
  
  const now = Math.floor(Date.now() / 1000);
  const recent = ohlcData.slice(-20);
  
  // Higher lows pattern (bullish)
  const lows = recent.filter(d => d.priceLow).map(d => ({ price: d.priceLow!, ts: d.bucketStart }));
  if (lows.length >= 3) {
    const lastThreeLows = lows.slice(-3);
    if (lastThreeLows[0].price < lastThreeLows[1].price && lastThreeLows[1].price < lastThreeLows[2].price) {
      const confidence = Math.round(((lastThreeLows[2].price - lastThreeLows[0].price) / lastThreeLows[0].price) * 1000);
      patterns.push({
        pattern: "higher_lows",
        confidence: Math.min(90, confidence + 50),
        direction: "bullish",
        description: "Price forming higher lows - bullish accumulation",
        timestamp: now
      });
    }
  }
  
  // Lower highs pattern (bearish)
  const highs = recent.filter(d => d.priceHigh).map(d => ({ price: d.priceHigh!, ts: d.bucketStart }));
  if (highs.length >= 3) {
    const lastThreeHighs = highs.slice(-3);
    if (lastThreeHighs[0].price > lastThreeHighs[1].price && lastThreeHighs[1].price > lastThreeHighs[2].price) {
      const confidence = Math.round(((lastThreeHighs[0].price - lastThreeHighs[2].price) / lastThreeHighs[0].price) * 1000);
      patterns.push({
        pattern: "lower_highs",
        confidence: Math.min(90, confidence + 50),
        direction: "bearish",
        description: "Price forming lower highs - distribution phase",
        timestamp: now
      });
    }
  }
  
  // Double bottom pattern
  if (lows.length >= 5) {
    const recentLows = lows.slice(-5);
    for (let i = 0; i < recentLows.length - 2; i++) {
      const low1 = recentLows[i];
      const low2 = recentLows[i + 2];
      const midHigh = Math.max(...recentLows.slice(i, i + 3).map(l => 
        recent.find(r => r.bucketStart === l.ts)?.priceHigh || 0
      ));
      
      // Double bottom: two similar lows with a higher peak between
      const priceDiff = Math.abs(low1.price - low2.price) / low1.price;
      if (priceDiff < 0.03 && midHigh > low1.price * 1.05) {
        patterns.push({
          pattern: "double_bottom",
          confidence: Math.round((1 - priceDiff) * 80),
          direction: "bullish",
          description: "Double bottom formation - potential reversal",
          timestamp: now
        });
        break;
      }
    }
  }
  
  // Bullish engulfing
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2];
    const curr = recent[recent.length - 1];
    if (prev.priceClose && prev.priceOpen && curr.priceClose && curr.priceOpen) {
      if (prev.priceClose < prev.priceOpen && // Previous was red
          curr.priceClose > curr.priceOpen && // Current is green
          curr.priceOpen < prev.priceClose && // Opens below prev close
          curr.priceClose > prev.priceOpen) { // Closes above prev open
        patterns.push({
          pattern: "bullish_engulfing",
          confidence: 70,
          direction: "bullish",
          description: "Bullish engulfing candle - reversal signal",
          timestamp: now
        });
      }
    }
  }
  
  // Bearish engulfing
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2];
    const curr = recent[recent.length - 1];
    if (prev.priceClose && prev.priceOpen && curr.priceClose && curr.priceOpen) {
      if (prev.priceClose > prev.priceOpen && // Previous was green
          curr.priceClose < curr.priceOpen && // Current is red
          curr.priceOpen > prev.priceClose && // Opens above prev close
          curr.priceClose < prev.priceOpen) { // Closes below prev open
        patterns.push({
          pattern: "bearish_engulfing",
          confidence: 70,
          direction: "bearish",
          description: "Bearish engulfing candle - reversal signal",
          timestamp: now
        });
      }
    }
  }
  
  return patterns;
}

export function detectVolumeSpikes(ohlcData: typeof priceAggregates.$inferSelect[], threshold: number = 2.0): VolumeSpike[] {
  const spikes: VolumeSpike[] = [];
  
  if (ohlcData.length < 10) return spikes;
  
  // Calculate average volume from older data
  const volumeData = ohlcData.slice(0, -3).filter(d => d.volume && d.volume > 0);
  if (volumeData.length < 5) return spikes;
  
  const avgVolume = volumeData.reduce((sum, d) => sum + (d.volume || 0), 0) / volumeData.length;
  
  // Check recent candles for volume spikes
  const recent = ohlcData.slice(-3);
  for (const candle of recent) {
    if (!candle.volume || candle.volume <= 0) continue;
    
    const multiplier = candle.volume / avgVolume;
    if (multiplier >= threshold) {
      const priceChange = candle.priceClose && candle.priceOpen 
        ? (candle.priceClose - candle.priceOpen) / candle.priceOpen 
        : 0;
      
      const buys = candle.buys || 0;
      const sells = candle.sells || 0;
      let direction: "buy" | "sell" | "mixed" = "mixed";
      if (buys > sells * 1.5) direction = "buy";
      else if (sells > buys * 1.5) direction = "sell";
      
      spikes.push({
        timestamp: candle.bucketStart,
        volume: candle.volume,
        avgVolume,
        multiplier,
        priceChange,
        direction
      });
    }
  }
  
  return spikes;
}

export function generateBreakoutAlerts(
  currentPrice: number,
  supports: SupportResistanceLevel[],
  resistances: SupportResistanceLevel[],
  patterns: PatternDetection[],
  volumeSpikes: VolumeSpike[],
  tokenMint: string
): BreakoutAlert[] {
  const alerts: BreakoutAlert[] = [];
  const now = Math.floor(Date.now() / 1000);
  
  // Check support breaks
  for (const support of supports) {
    if (currentPrice < support.price * 0.98 && support.strength >= 50) {
      alerts.push({
        type: "support_break",
        tokenMint,
        level: support.price,
        currentPrice,
        confidence: support.strength,
        direction: "bearish",
        message: `Price broke below support at $${support.price.toFixed(6)} (${support.bounces} bounces)`,
        timestamp: now
      });
    }
  }
  
  // Check resistance breaks
  for (const resistance of resistances) {
    if (currentPrice > resistance.price * 1.02 && resistance.strength >= 50) {
      alerts.push({
        type: "resistance_break",
        tokenMint,
        level: resistance.price,
        currentPrice,
        confidence: resistance.strength,
        direction: "bullish",
        message: `Price broke above resistance at $${resistance.price.toFixed(6)} (${resistance.bounces} tests)`,
        timestamp: now
      });
    }
  }
  
  // Volume spike alerts
  for (const spike of volumeSpikes) {
    if (spike.multiplier >= 3) {
      alerts.push({
        type: "volume_spike",
        tokenMint,
        currentPrice,
        confidence: Math.min(95, Math.round(spike.multiplier * 20)),
        direction: spike.direction === "buy" ? "bullish" : spike.direction === "sell" ? "bearish" : "bullish",
        message: `${spike.multiplier.toFixed(1)}x volume spike (${spike.direction} pressure, ${(spike.priceChange * 100).toFixed(1)}% price change)`,
        timestamp: now
      });
    }
  }
  
  // Pattern completion alerts
  for (const pattern of patterns) {
    if (pattern.confidence >= 70) {
      alerts.push({
        type: "pattern_complete",
        tokenMint,
        currentPrice,
        confidence: pattern.confidence,
        direction: pattern.direction === "bearish" ? "bearish" : "bullish",
        message: `${pattern.pattern.replace(/_/g, " ")} pattern detected: ${pattern.description}`,
        timestamp: now
      });
    }
  }
  
  return alerts;
}

export function calculateSwingScore(analysis: Omit<SwingAnalysis, "swingScore">): number {
  let score = 50; // Base score
  
  // Support/resistance quality
  const strongSupport = analysis.supportLevels.find(s => s.strength >= 70);
  const strongResistance = analysis.resistanceLevels.find(r => r.strength >= 70);
  
  if (strongSupport) score += 10;
  if (strongResistance) score += 10;
  
  // Bullish patterns boost, bearish patterns reduce
  for (const pattern of analysis.patterns) {
    if (pattern.direction === "bullish") {
      score += Math.round(pattern.confidence / 10);
    } else if (pattern.direction === "bearish") {
      score -= Math.round(pattern.confidence / 10);
    }
  }
  
  // Volume spikes with buy pressure boost
  for (const spike of analysis.volumeSpikes) {
    if (spike.direction === "buy") {
      score += Math.min(15, Math.round(spike.multiplier * 3));
    } else if (spike.direction === "sell") {
      score -= Math.min(10, Math.round(spike.multiplier * 2));
    }
  }
  
  // Bullish alerts boost
  const bullishAlerts = analysis.alerts.filter(a => a.direction === "bullish");
  const bearishAlerts = analysis.alerts.filter(a => a.direction === "bearish");
  score += bullishAlerts.length * 5;
  score -= bearishAlerts.length * 5;
  
  return Math.max(0, Math.min(100, score));
}

export async function analyzeTokenForSwing(tokenMint: string, currentPrice: number): Promise<SwingAnalysis> {
  // Get 7 days of hourly data for analysis
  const ohlcData = await getOHLCData(tokenMint, "hourly", 7 * 24 * 3600);
  
  const { supports, resistances } = detectSupportResistance(ohlcData);
  const patterns = detectPatterns(ohlcData);
  const volumeSpikes = detectVolumeSpikes(ohlcData);
  const alerts = generateBreakoutAlerts(currentPrice, supports, resistances, patterns, volumeSpikes, tokenMint);
  
  const partialAnalysis = {
    tokenMint,
    currentPrice,
    supportLevels: supports,
    resistanceLevels: resistances,
    patterns,
    volumeSpikes,
    alerts
  };
  
  const swingScore = calculateSwingScore(partialAnalysis);
  
  return { ...partialAnalysis, swingScore };
}

export async function getUserSwingSettings(userId: number): Promise<SwingTradeSettings | null> {
  const rows = await db.select().from(swingTradeSettings).where(eq(swingTradeSettings.userId, userId));
  return rows[0] || null;
}

export async function updateSwingSettings(userId: number, settings: Partial<SwingTradeSettings>): Promise<SwingTradeSettings> {
  const existing = await getUserSwingSettings(userId);
  
  if (existing) {
    await db.update(swingTradeSettings)
      .set({ ...settings, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(swingTradeSettings.userId, userId));
  } else {
    await db.insert(swingTradeSettings).values({
      userId,
      ...settings,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000)
    });
  }
  
  return (await getUserSwingSettings(userId))!;
}

export async function getSwingOpportunities(userId: number): Promise<{
  opportunities: SwingAnalysis[];
  settings: SwingTradeSettings;
}> {
  const settings = await getUserSwingSettings(userId);
  
  if (!settings || !settings.enabled) {
    return { opportunities: [], settings: settings || {} as SwingTradeSettings };
  }
  
  // Get tokens from user's holdings and watchlist that meet minimum criteria
  const userHoldings = await db.select()
    .from(holdings)
    .where(and(eq(holdings.userId, userId), sql`${holdings.currentAmount} > 0`));
  
  const opportunities: SwingAnalysis[] = [];
  
  for (const holding of userHoldings) {
    const analysis = await analyzeTokenForSwing(holding.tokenMint, holding.buyPrice || 0);
    
    // Filter by swing score threshold
    if (analysis.swingScore >= (settings.minTokenScore || 60)) {
      opportunities.push(analysis);
    }
  }
  
  // Sort by swing score
  opportunities.sort((a, b) => b.swingScore - a.swingScore);
  
  return { opportunities, settings };
}
