import { db } from "./db";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import { swaps, walletFingerprints, type InsertWalletFingerprint } from "@shared/schema";

export interface WalletFingerprint {
  walletAddress: string;
  timeInMarket: {
    avgHoldMinutes: number;
    medianHoldMinutes: number;
    shortestHold: number;
    longestHold: number;
    holdDistribution: number[];
  };
  sizeDiscipline: {
    avgBuySol: number;
    stdDevBuySol: number;
    consistencyScore: number;
    preferredSize: 'micro' | 'small' | 'medium' | 'large' | 'whale';
  };
  sellPatterns: {
    avgSellPercent: number;
    partialSellRatio: number;
    takeProfitLevels: number[];
    stopLossUsage: number;
    trailingSellPattern: boolean;
  };
  entryTiming: {
    preVolumeRatio: number;
    earlyBirdScore: number;
    chaseScore: number;
    avgEntryRank: number;
  };
  playbookConsistency: {
    score: number;
    preferredTokenTypes: string[];
    timeOfDayPattern: number[];
    dayOfWeekPattern: number[];
  };
  chaosAvoidance: {
    score: number;
    avoidsHighVolatility: boolean;
    avoidsRugPulls: boolean;
    diversificationRatio: number;
  };
  lastAnalyzed: number;
  tradeCount: number;
  successRate: number;
}

const FINGERPRINT_CACHE: Map<string, WalletFingerprint> = new Map();

export async function analyzeWalletFingerprint(
  walletAddress: string,
  lookbackDays: number = 30
): Promise<WalletFingerprint> {
  const cached = FINGERPRINT_CACHE.get(walletAddress);
  const now = Math.floor(Date.now() / 1000);
  
  if (cached && (now - cached.lastAnalyzed) < 3600) {
    return cached;
  }
  
  const cutoff = now - (lookbackDays * 86400);
  
  const allSwaps = await db.query.swaps.findMany({
    where: and(
      eq(swaps.source, walletAddress),
      gte(swaps.timestamp, cutoff)
    ),
    orderBy: [desc(swaps.timestamp)],
  });
  
  const buys = allSwaps.filter(s => s.type === 'buy');
  const sells = allSwaps.filter(s => s.type === 'sell');
  
  const fingerprint: WalletFingerprint = {
    walletAddress,
    timeInMarket: analyzeTimeInMarket(buys, sells),
    sizeDiscipline: analyzeSizeDiscipline(buys),
    sellPatterns: analyzeSellPatterns(buys, sells),
    entryTiming: await analyzeEntryTiming(walletAddress, buys),
    playbookConsistency: analyzePlaybookConsistency(allSwaps),
    chaosAvoidance: analyzeChaosAvoidance(allSwaps),
    lastAnalyzed: now,
    tradeCount: allSwaps.length,
    successRate: calculateSuccessRate(buys, sells),
  };
  
  FINGERPRINT_CACHE.set(walletAddress, fingerprint);
  return fingerprint;
}

function analyzeTimeInMarket(
  buys: typeof swaps.$inferSelect[],
  sells: typeof swaps.$inferSelect[]
): WalletFingerprint['timeInMarket'] {
  const holdTimes: number[] = [];
  
  const buysByToken: Map<string, number[]> = new Map();
  for (const buy of buys) {
    const token = buy.toToken;
    if (!buysByToken.has(token)) {
      buysByToken.set(token, []);
    }
    buysByToken.get(token)!.push(buy.timestamp);
  }
  
  for (const sell of sells) {
    const token = sell.fromToken;
    const buyTimes = buysByToken.get(token);
    if (buyTimes && buyTimes.length > 0) {
      const lastBuy = Math.max(...buyTimes);
      const holdMinutes = (sell.timestamp - lastBuy) / 60;
      if (holdMinutes > 0 && holdMinutes < 43200) {
        holdTimes.push(holdMinutes);
      }
    }
  }
  
  if (holdTimes.length === 0) {
    return {
      avgHoldMinutes: 0,
      medianHoldMinutes: 0,
      shortestHold: 0,
      longestHold: 0,
      holdDistribution: [0, 0, 0, 0, 0],
    };
  }
  
  holdTimes.sort((a, b) => a - b);
  const avg = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
  const median = holdTimes[Math.floor(holdTimes.length / 2)];
  
  const distribution = [0, 0, 0, 0, 0];
  for (const t of holdTimes) {
    if (t < 5) distribution[0]++;
    else if (t < 30) distribution[1]++;
    else if (t < 120) distribution[2]++;
    else if (t < 480) distribution[3]++;
    else distribution[4]++;
  }
  const total = holdTimes.length;
  for (let i = 0; i < distribution.length; i++) {
    distribution[i] = Math.round((distribution[i] / total) * 100) / 100;
  }
  
  return {
    avgHoldMinutes: Math.round(avg),
    medianHoldMinutes: Math.round(median),
    shortestHold: Math.round(holdTimes[0]),
    longestHold: Math.round(holdTimes[holdTimes.length - 1]),
    holdDistribution: distribution,
  };
}

function analyzeSizeDiscipline(
  buys: typeof swaps.$inferSelect[]
): WalletFingerprint['sizeDiscipline'] {
  if (buys.length === 0) {
    return {
      avgBuySol: 0,
      stdDevBuySol: 0,
      consistencyScore: 0,
      preferredSize: 'micro',
    };
  }
  
  const amounts = buys.map(b => b.fromAmount);
  const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const stdDev = Math.sqrt(
    amounts.reduce((sum, a) => sum + Math.pow(a - avg, 2), 0) / amounts.length
  );
  
  const consistencyScore = avg > 0 ? Math.max(0, 1 - (stdDev / avg)) : 0;
  
  let preferredSize: WalletFingerprint['sizeDiscipline']['preferredSize'] = 'micro';
  if (avg >= 10) preferredSize = 'whale';
  else if (avg >= 5) preferredSize = 'large';
  else if (avg >= 1) preferredSize = 'medium';
  else if (avg >= 0.1) preferredSize = 'small';
  
  return {
    avgBuySol: Math.round(avg * 1000) / 1000,
    stdDevBuySol: Math.round(stdDev * 1000) / 1000,
    consistencyScore: Math.round(consistencyScore * 100) / 100,
    preferredSize,
  };
}

function analyzeSellPatterns(
  buys: typeof swaps.$inferSelect[],
  sells: typeof swaps.$inferSelect[]
): WalletFingerprint['sellPatterns'] {
  if (buys.length === 0 || sells.length === 0) {
    return {
      avgSellPercent: 0,
      partialSellRatio: 0,
      takeProfitLevels: [],
      stopLossUsage: 0,
      trailingSellPattern: false,
    };
  }
  
  const tokenBuys: Map<string, number> = new Map();
  for (const buy of buys) {
    const current = tokenBuys.get(buy.toToken) || 0;
    tokenBuys.set(buy.toToken, current + buy.toAmount);
  }
  
  const tokenSells: Map<string, number[]> = new Map();
  for (const sell of sells) {
    if (!tokenSells.has(sell.fromToken)) {
      tokenSells.set(sell.fromToken, []);
    }
    tokenSells.get(sell.fromToken)!.push(sell.fromAmount);
  }
  
  let partialSells = 0;
  let fullSells = 0;
  const sellPercents: number[] = [];
  
  for (const [token, sellAmounts] of Array.from(tokenSells.entries())) {
    const bought = tokenBuys.get(token);
    if (!bought) continue;
    
    for (const sellAmount of sellAmounts) {
      const percent = (sellAmount / bought) * 100;
      sellPercents.push(percent);
      
      if (percent < 90) {
        partialSells++;
      } else {
        fullSells++;
      }
    }
  }
  
  const avgSellPercent = sellPercents.length > 0 
    ? sellPercents.reduce((a, b) => a + b, 0) / sellPercents.length 
    : 0;
  
  const partialSellRatio = (partialSells + fullSells) > 0 
    ? partialSells / (partialSells + fullSells) 
    : 0;
  
  const takeProfitLevels = detectTakeProfitLevels(sellPercents);
  
  return {
    avgSellPercent: Math.round(avgSellPercent),
    partialSellRatio: Math.round(partialSellRatio * 100) / 100,
    takeProfitLevels,
    stopLossUsage: 0,
    trailingSellPattern: partialSellRatio > 0.5,
  };
}

function detectTakeProfitLevels(sellPercents: number[]): number[] {
  if (sellPercents.length < 3) return [];
  
  const buckets: Map<number, number> = new Map();
  for (const p of sellPercents) {
    const bucket = Math.round(p / 10) * 10;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  
  const sorted = Array.from(buckets.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([level]) => level);
  
  return sorted;
}

async function analyzeEntryTiming(
  walletAddress: string,
  buys: typeof swaps.$inferSelect[]
): Promise<WalletFingerprint['entryTiming']> {
  if (buys.length === 0) {
    return {
      preVolumeRatio: 0,
      earlyBirdScore: 0,
      chaseScore: 0,
      avgEntryRank: 0,
    };
  }
  
  let preVolumeCount = 0;
  let earlyCount = 0;
  let chaseCount = 0;
  const entryRanks: number[] = [];
  
  for (const buy of buys.slice(0, 20)) {
    const tokenBuys = await db.query.swaps.findMany({
      where: and(
        eq(swaps.toToken, buy.toToken),
        eq(swaps.type, 'buy')
      ),
      orderBy: [desc(swaps.timestamp)],
      limit: 100,
    });
    
    if (tokenBuys.length < 5) continue;
    
    tokenBuys.sort((a, b) => a.timestamp - b.timestamp);
    const rank = tokenBuys.findIndex(s => s.source === walletAddress && s.timestamp === buy.timestamp);
    
    if (rank !== -1) {
      entryRanks.push(rank / tokenBuys.length);
      
      if (rank < tokenBuys.length * 0.1) {
        preVolumeCount++;
      } else if (rank < tokenBuys.length * 0.3) {
        earlyCount++;
      } else if (rank > tokenBuys.length * 0.7) {
        chaseCount++;
      }
    }
  }
  
  const total = buys.slice(0, 20).length;
  
  return {
    preVolumeRatio: Math.round((preVolumeCount / total) * 100) / 100,
    earlyBirdScore: Math.round((earlyCount / total) * 100) / 100,
    chaseScore: Math.round((chaseCount / total) * 100) / 100,
    avgEntryRank: entryRanks.length > 0 
      ? Math.round((entryRanks.reduce((a, b) => a + b, 0) / entryRanks.length) * 100) / 100 
      : 0.5,
  };
}

function analyzePlaybookConsistency(
  allSwaps: typeof swaps.$inferSelect[]
): WalletFingerprint['playbookConsistency'] {
  if (allSwaps.length < 5) {
    return {
      score: 0,
      preferredTokenTypes: [],
      timeOfDayPattern: Array(6).fill(0),
      dayOfWeekPattern: Array(7).fill(0),
    };
  }
  
  const timeOfDay = Array(6).fill(0);
  const dayOfWeek = Array(7).fill(0);
  
  for (const swap of allSwaps) {
    const date = new Date(swap.timestamp * 1000);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    
    const timeSlot = Math.floor(hour / 4);
    timeOfDay[timeSlot]++;
    dayOfWeek[day]++;
  }
  
  const total = allSwaps.length;
  for (let i = 0; i < timeOfDay.length; i++) {
    timeOfDay[i] = Math.round((timeOfDay[i] / total) * 100) / 100;
  }
  for (let i = 0; i < dayOfWeek.length; i++) {
    dayOfWeek[i] = Math.round((dayOfWeek[i] / total) * 100) / 100;
  }
  
  const maxTimeSlot = Math.max(...timeOfDay);
  const maxDay = Math.max(...dayOfWeek);
  const consistencyScore = (maxTimeSlot + maxDay) / 2;
  
  return {
    score: Math.round(consistencyScore * 100) / 100,
    preferredTokenTypes: [],
    timeOfDayPattern: timeOfDay,
    dayOfWeekPattern: dayOfWeek,
  };
}

function analyzeChaosAvoidance(
  allSwaps: typeof swaps.$inferSelect[]
): WalletFingerprint['chaosAvoidance'] {
  if (allSwaps.length < 3) {
    return {
      score: 0.5,
      avoidsHighVolatility: false,
      avoidsRugPulls: false,
      diversificationRatio: 0,
    };
  }
  
  const uniqueTokens = new Set(allSwaps.map(s => s.toToken || s.fromToken));
  const diversificationRatio = uniqueTokens.size / allSwaps.length;
  
  const timestamps = allSwaps.map(s => s.timestamp).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  
  const avgInterval = intervals.length > 0 
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length 
    : 0;
  const stdDevInterval = intervals.length > 1
    ? Math.sqrt(intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length)
    : 0;
  
  const intervalConsistency = avgInterval > 0 ? 1 - Math.min(stdDevInterval / avgInterval, 1) : 0;
  
  const chaosScore = (intervalConsistency + diversificationRatio) / 2;
  
  return {
    score: Math.round(chaosScore * 100) / 100,
    avoidsHighVolatility: intervalConsistency > 0.6,
    avoidsRugPulls: false,
    diversificationRatio: Math.round(diversificationRatio * 100) / 100,
  };
}

function calculateSuccessRate(
  buys: typeof swaps.$inferSelect[],
  sells: typeof swaps.$inferSelect[]
): number {
  if (buys.length === 0) return 0;
  
  const tokenBuys: Map<string, number> = new Map();
  const tokenBuyAmounts: Map<string, number> = new Map();
  
  for (const buy of buys) {
    tokenBuys.set(buy.toToken, buy.fromAmount);
    tokenBuyAmounts.set(buy.toToken, (tokenBuyAmounts.get(buy.toToken) || 0) + buy.fromAmount);
  }
  
  let wins = 0;
  let total = 0;
  
  for (const sell of sells) {
    const buyAmount = tokenBuyAmounts.get(sell.fromToken);
    if (buyAmount) {
      total++;
      if (sell.toAmount > buyAmount * 0.9) {
        wins++;
      }
    }
  }
  
  return total > 0 ? Math.round((wins / total) * 100) / 100 : 0;
}

export async function persistFingerprint(fingerprint: WalletFingerprint): Promise<number | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    
    const existing = await db.query.walletFingerprints.findFirst({
      where: eq(walletFingerprints.walletAddress, fingerprint.walletAddress),
    });
    
    const data = {
      walletAddress: fingerprint.walletAddress,
      avgHoldDurationMinutes: fingerprint.timeInMarket.avgHoldMinutes,
      holdDurationStdDev: 0,
      shortestHold: fingerprint.timeInMarket.shortestHold,
      longestHold: fingerprint.timeInMarket.longestHold,
      avgEntrySizeUsd: fingerprint.sizeDiscipline.avgBuySol * 100,
      entrySizeStdDev: fingerprint.sizeDiscipline.stdDevBuySol * 100,
      partialSellRate: fingerprint.sellPatterns.partialSellRatio,
      preVolumeBuyRate: fingerprint.entryTiming.preVolumeRatio,
      playbookScore: fingerprint.playbookConsistency.score * 100,
      totalTrades: fingerprint.tradeCount,
      lastUpdatedAt: now,
      firstAnalyzedAt: now,
    };
    
    if (existing) {
      await db.update(walletFingerprints)
        .set(data)
        .where(eq(walletFingerprints.walletAddress, fingerprint.walletAddress));
      return existing.id;
    } else {
      const result = await db.insert(walletFingerprints).values(data).returning({ id: walletFingerprints.id });
      return result[0]?.id ?? null;
    }
  } catch (error) {
    console.error("[Fingerprint] Failed to persist:", error);
    return null;
  }
}

export async function getStoredFingerprint(walletAddress: string): Promise<WalletFingerprint | null> {
  try {
    const stored = await db.query.walletFingerprints.findFirst({
      where: eq(walletFingerprints.walletAddress, walletAddress),
    });
    
    if (!stored) return null;
    
    return {
      walletAddress: stored.walletAddress,
      timeInMarket: {
        avgHoldMinutes: stored.avgHoldDurationMinutes || 0,
        medianHoldMinutes: stored.avgHoldDurationMinutes || 0,
        shortestHold: stored.shortestHold || 0,
        longestHold: stored.longestHold || 0,
        holdDistribution: [0, 0, 0, 0, 0],
      },
      sizeDiscipline: {
        avgBuySol: (stored.avgEntrySizeUsd || 0) / 100,
        stdDevBuySol: (stored.entrySizeStdDev || 0) / 100,
        consistencyScore: stored.avgEntrySizeUsd && stored.entrySizeStdDev 
          ? Math.max(0, 1 - (stored.entrySizeStdDev / stored.avgEntrySizeUsd)) 
          : 0,
        preferredSize: 'micro',
      },
      sellPatterns: {
        avgSellPercent: 0,
        partialSellRatio: stored.partialSellRate || 0,
        takeProfitLevels: [],
        stopLossUsage: 0,
        trailingSellPattern: (stored.partialSellRate || 0) > 0.5,
      },
      entryTiming: {
        preVolumeRatio: stored.preVolumeBuyRate || 0,
        earlyBirdScore: 0,
        chaseScore: 0,
        avgEntryRank: 0.5,
      },
      playbookConsistency: {
        score: (stored.playbookScore || 0) / 100,
        preferredTokenTypes: [],
        timeOfDayPattern: Array(6).fill(0),
        dayOfWeekPattern: Array(7).fill(0),
      },
      chaosAvoidance: {
        score: stored.totalTrades && stored.tradesInChaos 
          ? 1 - (stored.tradesInChaos / stored.totalTrades) 
          : 0.5,
        avoidsHighVolatility: false,
        avoidsRugPulls: false,
        diversificationRatio: 0,
      },
      lastAnalyzed: stored.lastUpdatedAt || 0,
      tradeCount: stored.totalTrades || 0,
      successRate: 0,
    };
  } catch (error) {
    console.error("[Fingerprint] Failed to get stored:", error);
    return null;
  }
}

export function getFingerprintSummary(fp: WalletFingerprint): string {
  const parts: string[] = [];
  
  const holdStyle = fp.timeInMarket.avgHoldMinutes < 30 ? 'scalper' 
    : fp.timeInMarket.avgHoldMinutes < 120 ? 'short-term' 
    : 'swing';
  parts.push(holdStyle);
  
  parts.push(`${fp.sizeDiscipline.preferredSize} size`);
  
  if (fp.sellPatterns.partialSellRatio > 0.5) {
    parts.push('partial seller');
  }
  
  if (fp.entryTiming.preVolumeRatio > 0.3) {
    parts.push('early mover');
  } else if (fp.entryTiming.chaseScore > 0.4) {
    parts.push('chaser');
  }
  
  if (fp.playbookConsistency.score > 0.6) {
    parts.push('consistent');
  }
  
  return parts.join(', ');
}

export function clearFingerprintCache(): void {
  FINGERPRINT_CACHE.clear();
}

export function getCachedFingerprints(): WalletFingerprint[] {
  return Array.from(FINGERPRINT_CACHE.values());
}
