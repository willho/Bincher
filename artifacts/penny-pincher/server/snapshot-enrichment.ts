import { db } from "./db";
import { priceHistoryCache, tokenDataPool, signalWalletProfiles, paperPositions, indicatorSnapshots } from "@shared/schema";
import { eq, and, gte, lte, asc, desc, sql } from "drizzle-orm";

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface TradeJourney {
  priceHigh: number | null;
  priceLow: number | null;
  highTimestamp: number | null;
  lowTimestamp: number | null;
  maxDrawdownPercent: number | null;
  maxUnrealizedGainPercent: number | null;
  holdDurationMinutes: number | null;
  avgVolume: number | null;
  totalVolume: number | null;
  indicatorsAtHigh: Record<string, any> | null;
  indicatorsAtLow: Record<string, any> | null;
}

interface MarketContext {
  liquidityAtSnapshot: number | null;
  marketCapAtSnapshot: number | null;
  tokenAgeHours: number | null;
  holderCount: number | null;
  whaleCount: number | null;
  whaleAvgReputation: number | null;
  whaleNetSentiment: number | null;
  discoverySource: string | null;
  signalWalletWinRate: number | null;
  signalWalletStyle: string | null;
  dexListingCount: number | null;
}

interface DerivedMetrics {
  hourOfDay: number;
  dayOfWeek: number;
  solCorrelation: number | null;
  priceVelocity: number | null;
  relativeVolume: number | null;
  lifecycleStage: string | null;
  clusterCrowding: number | null;
}

export type SnapshotEnrichment = Partial<TradeJourney> & MarketContext & DerivedMetrics;

export async function computeTradeJourney(
  tokenMint: string,
  entryTimestamp: number,
  exitTimestamp: number,
  entryPrice: number
): Promise<TradeJourney> {
  try {
    const candles = await db.select()
      .from(priceHistoryCache)
      .where(and(
        eq(priceHistoryCache.tokenMint, tokenMint),
        gte(priceHistoryCache.timestamp, entryTimestamp),
        lte(priceHistoryCache.timestamp, exitTimestamp)
      ))
      .orderBy(asc(priceHistoryCache.timestamp))
      .limit(500);

    if (candles.length === 0) {
      return {
        priceHigh: null, priceLow: null, highTimestamp: null, lowTimestamp: null,
        maxDrawdownPercent: null, maxUnrealizedGainPercent: null,
        holdDurationMinutes: Math.round((exitTimestamp - entryTimestamp) / 60),
        avgVolume: null, totalVolume: null,
        indicatorsAtHigh: null, indicatorsAtLow: null,
      };
    }

    let priceHigh = -Infinity;
    let priceLow = Infinity;
    let highTimestamp = entryTimestamp;
    let lowTimestamp = entryTimestamp;
    let totalVolume = 0;

    for (const candle of candles) {
      if (candle.high > priceHigh) {
        priceHigh = candle.high;
        highTimestamp = candle.timestamp;
      }
      if (candle.low < priceLow) {
        priceLow = candle.low;
        lowTimestamp = candle.timestamp;
      }
      totalVolume += candle.volume ?? 0;
    }

    const maxUnrealizedGainPercent = entryPrice > 0
      ? ((priceHigh - entryPrice) / entryPrice) * 100
      : null;
    const maxDrawdownPercent = entryPrice > 0
      ? ((entryPrice - priceLow) / entryPrice) * 100
      : null;

    const avgVolume = candles.length > 0 ? totalVolume / candles.length : null;
    const holdDurationMinutes = Math.round((exitTimestamp - entryTimestamp) / 60);

    let indicatorsAtHigh: Record<string, any> | null = null;
    let indicatorsAtLow: Record<string, any> | null = null;

    try {
      const highCandle = candles.find(c => c.timestamp === highTimestamp);
      const lowCandle = candles.find(c => c.timestamp === lowTimestamp);

      const nearbyCandles = candles.map(c => c.close);
      if (nearbyCandles.length >= 14) {
        const highIdx = candles.findIndex(c => c.timestamp === highTimestamp);
        const lowIdx = candles.findIndex(c => c.timestamp === lowTimestamp);

        if (highIdx >= 0) {
          const slice = nearbyCandles.slice(0, highIdx + 1);
          if (slice.length >= 14) {
            indicatorsAtHigh = computeQuickIndicators(slice);
          }
        }
        if (lowIdx >= 0) {
          const slice = nearbyCandles.slice(0, lowIdx + 1);
          if (slice.length >= 14) {
            indicatorsAtLow = computeQuickIndicators(slice);
          }
        }
      }
    } catch {}

    return {
      priceHigh: priceHigh === -Infinity ? null : priceHigh,
      priceLow: priceLow === Infinity ? null : priceLow,
      highTimestamp,
      lowTimestamp,
      maxDrawdownPercent: maxDrawdownPercent != null ? Math.round(maxDrawdownPercent * 100) / 100 : null,
      maxUnrealizedGainPercent: maxUnrealizedGainPercent != null ? Math.round(maxUnrealizedGainPercent * 100) / 100 : null,
      holdDurationMinutes,
      avgVolume,
      totalVolume,
      indicatorsAtHigh,
      indicatorsAtLow,
    };
  } catch (err) {
    console.error("[SnapshotEnrichment] Trade journey computation failed:", err);
    return {
      priceHigh: null, priceLow: null, highTimestamp: null, lowTimestamp: null,
      maxDrawdownPercent: null, maxUnrealizedGainPercent: null,
      holdDurationMinutes: Math.round((exitTimestamp - entryTimestamp) / 60),
      avgVolume: null, totalVolume: null,
      indicatorsAtHigh: null, indicatorsAtLow: null,
    };
  }
}

function computeQuickIndicators(closes: number[]): Record<string, any> {
  if (closes.length < 15) return {};

  let gains = 0, losses = 0;
  const start = closes.length - 14;
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = Math.round((100 - 100 / (1 + rs)) * 100) / 100;

  let ema12 = closes[0];
  let ema26 = closes[0];
  const m12 = 2 / 13;
  const m26 = 2 / 27;
  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * m12 + ema12 * (1 - m12);
    ema26 = closes[i] * m26 + ema26 * (1 - m26);
  }

  return {
    rsi,
    emaCross: ema12 > ema26 ? "bullish" : "bearish",
    ema12: Math.round(ema12 * 1e8) / 1e8,
    ema26: Math.round(ema26 * 1e8) / 1e8,
  };
}

export async function gatherMarketContext(
  tokenMint: string,
  signalWallet?: string | null,
  discoverySourceOverride?: string | null
): Promise<MarketContext> {
  try {
    const tokenData = await db.select({
      liquidity: tokenDataPool.liquidity,
      marketCap: tokenDataPool.marketCap,
      pairCreatedAt: tokenDataPool.pairCreatedAt,
      holderCount: tokenDataPool.holderCount,
      whaleHolderCount: tokenDataPool.whaleHolderCount,
      whaleAvgReputation: tokenDataPool.whaleAvgReputation,
      whaleNetSentiment: tokenDataPool.whaleNetSentiment,
      discoverySource: tokenDataPool.discoverySource,
      dexId: tokenDataPool.dexId,
    })
      .from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, tokenMint))
      .limit(1);

    const td = tokenData[0];

    let signalWalletWinRate: number | null = null;
    let signalWalletStyle: string | null = null;

    if (signalWallet) {
      const profile = await db.select({
        winRate: signalWalletProfiles.winRate,
        tradingStyle: signalWalletProfiles.tradingStyle,
      })
        .from(signalWalletProfiles)
        .where(eq(signalWalletProfiles.walletAddress, signalWallet))
        .limit(1);

      if (profile[0]) {
        signalWalletWinRate = profile[0].winRate;
        signalWalletStyle = profile[0].tradingStyle;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenAgeHours = td?.pairCreatedAt
      ? Math.round((now - td.pairCreatedAt) / 3600 * 10) / 10
      : null;

    let dexListingCount: number | null = null;
    if (td) {
      dexListingCount = td.dexId ? 1 : null;
    }

    return {
      liquidityAtSnapshot: td?.liquidity ?? null,
      marketCapAtSnapshot: td?.marketCap ?? null,
      tokenAgeHours,
      holderCount: td?.holderCount ?? null,
      whaleCount: td?.whaleHolderCount ?? null,
      whaleAvgReputation: td?.whaleAvgReputation ?? null,
      whaleNetSentiment: td?.whaleNetSentiment ?? null,
      discoverySource: discoverySourceOverride ?? td?.discoverySource ?? null,
      signalWalletWinRate,
      signalWalletStyle,
      dexListingCount,
    };
  } catch (err) {
    console.error("[SnapshotEnrichment] Market context failed:", err);
    return {
      liquidityAtSnapshot: null, marketCapAtSnapshot: null, tokenAgeHours: null,
      holderCount: null, whaleCount: null, whaleAvgReputation: null,
      whaleNetSentiment: null, discoverySource: null, signalWalletWinRate: null,
      signalWalletStyle: null, dexListingCount: null,
    };
  }
}

export async function computeDerivedMetrics(
  tokenMint: string,
  clusterId?: string | null
): Promise<DerivedMetrics> {
  const now = new Date();
  const hourOfDay = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();

  let solCorrelation: number | null = null;
  let priceVelocity: number | null = null;
  let relativeVolume: number | null = null;
  let lifecycleStage: string | null = null;
  let clusterCrowding: number | null = null;

  try {
    const recentCandles = await db.select()
      .from(priceHistoryCache)
      .where(and(
        eq(priceHistoryCache.tokenMint, tokenMint),
        eq(priceHistoryCache.timeframe, "1h")
      ))
      .orderBy(desc(priceHistoryCache.timestamp))
      .limit(24);

    if (recentCandles.length >= 5) {
      const closes = recentCandles.reverse().map(c => c.close);
      const volumes = recentCandles.map(c => c.volume ?? 0);

      const recentCloses = closes.slice(-5);
      if (recentCloses.length >= 2 && recentCloses[0] > 0) {
        const pctChanges = [];
        for (let i = 1; i < recentCloses.length; i++) {
          pctChanges.push((recentCloses[i] - recentCloses[i - 1]) / recentCloses[i - 1]);
        }
        priceVelocity = Math.round(pctChanges.reduce((a, b) => a + b, 0) / pctChanges.length * 10000) / 10000;
      }

      if (volumes.length >= 6) {
        const olderVolumes = volumes.slice(0, -3);
        const recentVols = volumes.slice(-3);
        const avgOlder = olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length;
        const avgRecent = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
        relativeVolume = avgOlder > 0 ? Math.round(avgRecent / avgOlder * 100) / 100 : null;
      }

      if (closes.length >= 10) {
        const first = closes[0];
        const last = closes[closes.length - 1];
        const mid = closes[Math.floor(closes.length / 2)];
        const max = Math.max(...closes);
        const min = Math.min(...closes);

        if (max > 0 && first > 0) {
          const fromStart = (last - first) / first;
          const peakPos = closes.indexOf(max) / closes.length;

          if (fromStart > 0.5 && peakPos > 0.7) {
            lifecycleStage = "first_pump";
          } else if (fromStart > 0.2 && peakPos < 0.5) {
            lifecycleStage = "consolidation";
          } else if (fromStart < -0.3) {
            lifecycleStage = "decline";
          } else if (peakPos < 0.3 && last < max * 0.7) {
            lifecycleStage = "post_dump";
          } else if (Math.abs(fromStart) < 0.1 && (max - min) / first < 0.2) {
            lifecycleStage = "sideways";
          } else if (fromStart > 0 && last > mid) {
            lifecycleStage = "uptrend";
          } else {
            lifecycleStage = "mixed";
          }
        }
      }
    }

    try {
      const solCandles = await db.select()
        .from(priceHistoryCache)
        .where(and(
          eq(priceHistoryCache.tokenMint, SOL_MINT),
          eq(priceHistoryCache.timeframe, "1h")
        ))
        .orderBy(desc(priceHistoryCache.timestamp))
        .limit(24);

      if (solCandles.length >= 10 && recentCandles.length >= 10) {
        const tokenCloses = recentCandles.reverse().map(c => c.close);
        const solCloses = solCandles.reverse().map(c => c.close);
        const minLen = Math.min(tokenCloses.length, solCloses.length, 20);

        if (minLen >= 5) {
          const tokenReturns: number[] = [];
          const solReturns: number[] = [];
          for (let i = 1; i < minLen; i++) {
            if (tokenCloses[i - 1] > 0 && solCloses[i - 1] > 0) {
              tokenReturns.push((tokenCloses[i] - tokenCloses[i - 1]) / tokenCloses[i - 1]);
              solReturns.push((solCloses[i] - solCloses[i - 1]) / solCloses[i - 1]);
            }
          }

          if (tokenReturns.length >= 4) {
            solCorrelation = pearsonCorrelation(tokenReturns, solReturns);
          }
        }
      }
    } catch {}

    if (clusterId) {
      try {
        const crowding = await db.select({
          count: sql<number>`count(*)`,
        })
          .from(paperPositions)
          .where(and(
            eq(paperPositions.status, "open"),
            eq(paperPositions.signalWallet, clusterId)
          ));
        clusterCrowding = Number(crowding[0]?.count || 0);
      } catch {}
    }

    if (clusterCrowding === null) {
      try {
        const openOnToken = await db.select({
          count: sql<number>`count(*)`,
        })
          .from(paperPositions)
          .where(and(
            eq(paperPositions.status, "open"),
            eq(paperPositions.tokenMint, tokenMint)
          ));
        clusterCrowding = Number(openOnToken[0]?.count || 0);
      } catch {}
    }
  } catch (err) {
    console.error("[SnapshotEnrichment] Derived metrics failed:", err);
  }

  return {
    hourOfDay,
    dayOfWeek,
    solCorrelation,
    priceVelocity,
    relativeVolume,
    lifecycleStage,
    clusterCrowding,
  };
}

function pearsonCorrelation(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 4) return null;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;

  return Math.round((num / den) * 1000) / 1000;
}

export async function enrichSnapshot(
  tokenMint: string,
  snapshotType: "entry" | "exit" | "periodic" | "checkpoint",
  positionId?: number,
  signalWallet?: string | null,
  clusterId?: string | null,
  discoverySource?: string | null,
  entryTimestamp?: number,
  exitTimestamp?: number,
  entryPrice?: number
): Promise<Partial<SnapshotEnrichment>> {
  const enrichment: Partial<SnapshotEnrichment> = {};

  const [marketContext, derivedMetrics] = await Promise.all([
    gatherMarketContext(tokenMint, signalWallet, discoverySource),
    computeDerivedMetrics(tokenMint, clusterId),
  ]);

  Object.assign(enrichment, marketContext, derivedMetrics);

  if (snapshotType === "exit" && entryTimestamp && exitTimestamp && entryPrice) {
    const journey = await computeTradeJourney(tokenMint, entryTimestamp, exitTimestamp, entryPrice);
    Object.assign(enrichment, journey);
  }

  return enrichment;
}
