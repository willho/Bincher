import { db } from "./db";
import { priceHistoryCache, priceSnapshots, priceAggregates } from "@shared/schema";
import { eq, and, gte, desc, asc } from "drizzle-orm";

interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorResult {
  tokenMint: string;
  timeframe: string;
  computedAt: number;
  ema: { ema12: number; ema26: number; signal: "bullish" | "bearish" } | null;
  rsi: { value: number; signal: "oversold" | "neutral" | "overbought" } | null;
  macd: { macd: number; signal: number; histogram: number; trend: "bullish" | "bearish" } | null;
  bollinger: { upper: number; middle: number; lower: number; bandwidth: number; position: "above" | "within" | "below" } | null;
  obv: { value: number; trend: "accumulating" | "distributing" | "neutral" } | null;
  stochastic: { k: number; d: number; signal: "oversold" | "neutral" | "overbought" } | null;
  composite: { score: number; bias: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" };
}

function calcEMA(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const multiplier = 2 / (period + 1);
  const ema: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema.push(sum / period);
  for (let i = period; i < data.length; i++) {
    ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
  }
  return ema;
}

function calcRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += Math.abs(change);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12.length === 0 || ema26.length === 0) return null;
  const offset = ema12.length - ema26.length;
  const macdLine: number[] = [];
  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }
  if (macdLine.length < 9) return null;
  const signalLine = calcEMA(macdLine, 9);
  if (signalLine.length === 0) return null;
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
}

function calcBollinger(closes: number[], period: number = 20, stdDevMult: number = 2): { upper: number; middle: number; lower: number; bandwidth: number } | null {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + stdDevMult * stdDev;
  const lower = mean - stdDevMult * stdDev;
  const bandwidth = mean > 0 ? (upper - lower) / mean : 0;
  return { upper, middle: mean, lower, bandwidth };
}

function calcOBV(candles: OHLCV[]): { value: number; trend: "accumulating" | "distributing" | "neutral" } | null {
  if (candles.length < 5) return null;
  let obv = 0;
  const obvSeries: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      obv += candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      obv -= candles[i].volume;
    }
    obvSeries.push(obv);
  }
  const recentLen = Math.min(5, obvSeries.length);
  const recentOBV = obvSeries.slice(-recentLen);
  let increasing = 0, decreasing = 0;
  for (let i = 1; i < recentOBV.length; i++) {
    if (recentOBV[i] > recentOBV[i - 1]) increasing++;
    else if (recentOBV[i] < recentOBV[i - 1]) decreasing++;
  }
  const trend = increasing > decreasing ? "accumulating" : decreasing > increasing ? "distributing" : "neutral";
  return { value: obv, trend };
}

function calcStochastic(candles: OHLCV[], kPeriod: number = 14, dPeriod: number = 3): { k: number; d: number } | null {
  if (candles.length < kPeriod) return null;
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const window = candles.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...window.map(c => c.high));
    const lowest = Math.min(...window.map(c => c.low));
    const range = highest - lowest;
    kValues.push(range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50);
  }
  if (kValues.length < dPeriod) return null;
  const dValues: number[] = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    const slice = kValues.slice(i - dPeriod + 1, i + 1);
    dValues.push(slice.reduce((a, b) => a + b, 0) / dPeriod);
  }
  return { k: kValues[kValues.length - 1], d: dValues[dValues.length - 1] };
}

async function getCandles(tokenMint: string, timeframe: string, limit: number = 100): Promise<OHLCV[]> {
  const rows = await db.select()
    .from(priceHistoryCache)
    .where(and(
      eq(priceHistoryCache.tokenMint, tokenMint),
      eq(priceHistoryCache.timeframe, timeframe)
    ))
    .orderBy(asc(priceHistoryCache.timestamp))
    .limit(limit);

  if (rows.length > 0) {
    return rows.map(r => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume ?? 0,
    }));
  }

  const tierMap: Record<string, string> = { "15m": "15min", "1h": "hourly", "4h": "hourly", "1d": "daily" };
  const aggTier = tierMap[timeframe] || "hourly";
  const aggRows = await db.select()
    .from(priceAggregates)
    .where(and(
      eq(priceAggregates.tokenMint, tokenMint),
      eq(priceAggregates.tier, aggTier)
    ))
    .orderBy(asc(priceAggregates.bucketStart))
    .limit(limit);

  if (aggRows.length > 0) {
    return aggRows
      .filter(r => r.priceOpen && r.priceClose)
      .map(r => ({
        timestamp: r.bucketStart,
        open: r.priceOpen!,
        high: r.priceHigh ?? r.priceOpen!,
        low: r.priceLow ?? r.priceOpen!,
        close: r.priceClose!,
        volume: 0,
      }));
  }

  const snapRows = await db.select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.tokenMint, tokenMint))
    .orderBy(asc(priceSnapshots.snapshotDate))
    .limit(limit);

  return snapRows.map(r => ({
    timestamp: r.createdAt ?? 0,
    open: r.open ?? 0,
    high: r.high ?? 0,
    low: r.low ?? 0,
    close: r.close ?? 0,
    volume: r.volume ?? 0,
  }));
}

function computeComposite(result: Partial<IndicatorResult>): { score: number; bias: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell" } {
  let score = 50;
  let signals = 0;

  if (result.rsi) {
    signals++;
    if (result.rsi.value < 30) score += 15;
    else if (result.rsi.value < 40) score += 8;
    else if (result.rsi.value > 70) score -= 15;
    else if (result.rsi.value > 60) score -= 8;
  }

  if (result.macd) {
    signals++;
    if (result.macd.histogram > 0) score += 10;
    else score -= 10;
  }

  if (result.ema) {
    signals++;
    if (result.ema.signal === "bullish") score += 10;
    else score -= 10;
  }

  if (result.bollinger) {
    signals++;
    if (result.bollinger.position === "below") score += 12;
    else if (result.bollinger.position === "above") score -= 12;
  }

  if (result.obv) {
    signals++;
    if (result.obv.trend === "accumulating") score += 8;
    else if (result.obv.trend === "distributing") score -= 8;
  }

  if (result.stochastic) {
    signals++;
    if (result.stochastic.signal === "oversold") score += 10;
    else if (result.stochastic.signal === "overbought") score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  let bias: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  if (score >= 75) bias = "strong_buy";
  else if (score >= 60) bias = "buy";
  else if (score >= 40) bias = "neutral";
  else if (score >= 25) bias = "sell";
  else bias = "strong_sell";

  return { score, bias };
}

export async function computeIndicators(tokenMint: string, timeframe: string = "1h"): Promise<IndicatorResult | null> {
  try {
    const candles = await getCandles(tokenMint, timeframe);
    if (candles.length < 14) return null;

    const closes = candles.map(c => c.close);

    const ema12Values = calcEMA(closes, 12);
    const ema26Values = calcEMA(closes, 26);
    const emaResult = ema12Values.length > 0 && ema26Values.length > 0 ? {
      ema12: ema12Values[ema12Values.length - 1],
      ema26: ema26Values[ema26Values.length - 1],
      signal: (ema12Values[ema12Values.length - 1] > ema26Values[ema26Values.length - 1] ? "bullish" : "bearish") as "bullish" | "bearish",
    } : null;

    const rsiValue = calcRSI(closes);
    const rsiResult = rsiValue !== null ? {
      value: Math.round(rsiValue * 100) / 100,
      signal: (rsiValue < 30 ? "oversold" : rsiValue > 70 ? "overbought" : "neutral") as "oversold" | "neutral" | "overbought",
    } : null;

    const macdRaw = calcMACD(closes);
    const macdResult = macdRaw ? {
      ...macdRaw,
      trend: (macdRaw.histogram > 0 ? "bullish" : "bearish") as "bullish" | "bearish",
    } : null;

    const bollingerRaw = calcBollinger(closes);
    const lastClose = closes[closes.length - 1];
    const bollingerResult = bollingerRaw ? {
      ...bollingerRaw,
      position: (lastClose > bollingerRaw.upper ? "above" : lastClose < bollingerRaw.lower ? "below" : "within") as "above" | "within" | "below",
    } : null;

    const obvResult = calcOBV(candles);

    const stochRaw = calcStochastic(candles);
    const stochResult = stochRaw ? {
      ...stochRaw,
      signal: (stochRaw.k < 20 ? "oversold" : stochRaw.k > 80 ? "overbought" : "neutral") as "oversold" | "neutral" | "overbought",
    } : null;

    const partial: Partial<IndicatorResult> = { ema: emaResult, rsi: rsiResult, macd: macdResult, bollinger: bollingerResult, obv: obvResult, stochastic: stochResult };
    const composite = computeComposite(partial);

    return {
      tokenMint,
      timeframe,
      computedAt: Math.floor(Date.now() / 1000),
      ema: emaResult,
      rsi: rsiResult,
      macd: macdResult,
      bollinger: bollingerResult,
      obv: obvResult,
      stochastic: stochResult,
      composite,
    };
  } catch (error) {
    console.error(`[Indicators] Error computing for ${tokenMint}:`, error);
    return null;
  }
}

const indicatorCache = new Map<string, { result: IndicatorResult; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function getIndicators(tokenMint: string, timeframe: string = "1h"): Promise<IndicatorResult | null> {
  const key = `${tokenMint}:${timeframe}`;
  const cached = indicatorCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;

  const result = await computeIndicators(tokenMint, timeframe);
  if (result) {
    indicatorCache.set(key, { result, expires: Date.now() + CACHE_TTL });
    if (indicatorCache.size > 200) {
      const now = Date.now();
      const keys = Array.from(indicatorCache.keys());
      for (const k of keys) {
        const v = indicatorCache.get(k);
        if (v && v.expires < now) indicatorCache.delete(k);
      }
    }
  }
  return result;
}

export function formatIndicatorsForAI(result: IndicatorResult): string {
  const parts: string[] = [`[Technical Indicators (${result.timeframe}):`];
  if (result.rsi) parts.push(`RSI=${result.rsi.value.toFixed(1)} (${result.rsi.signal})`);
  if (result.macd) parts.push(`MACD histogram=${result.macd.histogram > 0 ? '+' : ''}${result.macd.histogram.toFixed(6)} (${result.macd.trend})`);
  if (result.ema) parts.push(`EMA cross=${result.ema.signal}`);
  if (result.bollinger) parts.push(`Bollinger=${result.bollinger.position}, BW=${(result.bollinger.bandwidth * 100).toFixed(1)}%`);
  if (result.obv) parts.push(`OBV=${result.obv.trend}`);
  if (result.stochastic) parts.push(`Stoch K=${result.stochastic.k.toFixed(1)} (${result.stochastic.signal})`);
  parts.push(`Composite: ${result.composite.score}/100 → ${result.composite.bias.replace('_', ' ').toUpperCase()}`);
  parts.push(']');
  return parts.join(', ');
}
