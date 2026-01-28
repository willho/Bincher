import { db } from "./db";
import { priceAggregates, type PriceAggregate, type InsertPriceAggregate, type AggregateTier } from "@shared/schema";
import { eq, and, lt, desc } from "drizzle-orm";
import { fetchTopHolders, type TopHolderInfo } from "./helius";
import { BatchPriceResult } from "./jupiter";

// Tick data structure for in-memory buffer
interface PriceTick {
  timestamp: number;
  price: number;
  liquidity: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  marketCap: number | null;
  fdv: number | null;
}

// In-memory tick buffer - 15 min window per token
const TICK_BUFFER_WINDOW_MS = 15 * 60 * 1000;
const tickBuffer: Map<string, PriceTick[]> = new Map();

// Top 100 holder cache per token
interface HolderCache {
  holders: TopHolderInfo[];
  totalCount: number;
  lastFetchedAt: number;
  lastEventTriggerAt: number;
}

const HOLDER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const holderCache: Map<string, HolderCache> = new Map();

// Aggregation intervals
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Retention periods with overlap
const RETENTION = {
  "15min": 2 * HOUR_MS,      // Keep 15min buckets for 2 hours (overlap with hourly)
  "hourly": 48 * HOUR_MS,    // Keep hourly buckets for 48 hours (overlap with daily)
  "daily": 14 * DAY_MS,      // Keep daily buckets for 14 days (overlap with weekly)
  "weekly": 90 * DAY_MS,     // Keep weekly buckets for 90 days
};

// ==================== TICK BUFFER ====================

export function recordTick(tokenMint: string, data: BatchPriceResult): void {
  if (data.price === null) return;

  const now = Date.now();
  const tick: PriceTick = {
    timestamp: now,
    price: data.price,
    liquidity: data.liquidity,
    volume24h: data.volume24h,
    buys24h: data.buys24h,
    sells24h: data.sells24h,
    marketCap: data.marketCap,
    fdv: data.fdv,
  };

  const buffer = tickBuffer.get(tokenMint) || [];
  buffer.push(tick);

  // Trim old ticks outside 15-min window
  const cutoff = now - TICK_BUFFER_WINDOW_MS;
  const trimmed = buffer.filter(t => t.timestamp > cutoff);
  tickBuffer.set(tokenMint, trimmed);
}

export function getTickBuffer(tokenMint: string): PriceTick[] {
  return tickBuffer.get(tokenMint) || [];
}

export function getLatestTick(tokenMint: string): PriceTick | null {
  const buffer = tickBuffer.get(tokenMint);
  if (!buffer || buffer.length === 0) return null;
  return buffer[buffer.length - 1];
}

export function getPriceAt(tokenMint: string, targetTimestamp: number): number | null {
  const buffer = tickBuffer.get(tokenMint);
  if (!buffer || buffer.length === 0) return null;

  let closest = buffer[0];
  let closestDiff = Math.abs(buffer[0].timestamp - targetTimestamp);

  for (const tick of buffer) {
    const diff = Math.abs(tick.timestamp - targetTimestamp);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = tick;
    }
  }

  return closest.price;
}

// ==================== HOLDER CACHE ====================

export async function getHoldersCached(tokenMint: string, forceRefresh = false): Promise<HolderCache | null> {
  const cached = holderCache.get(tokenMint);
  const now = Date.now();

  // Return cache if fresh and not forced
  if (cached && !forceRefresh && (now - cached.lastFetchedAt < HOLDER_CACHE_TTL_MS)) {
    return cached;
  }

  // Fetch fresh data
  try {
    const holders = await fetchTopHolders(tokenMint, 100);
    if (!holders || holders.length === 0) {
      // Keep stale cache if fetch fails
      return cached || null;
    }

    const totalCount = holders.reduce((sum, h) => sum + 1, 0);
    const newCache: HolderCache = {
      holders,
      totalCount,
      lastFetchedAt: now,
      lastEventTriggerAt: cached?.lastEventTriggerAt || 0,
    };

    holderCache.set(tokenMint, newCache);
    return newCache;
  } catch (error) {
    console.error(`Failed to fetch holders for ${tokenMint}:`, error);
    return cached || null;
  }
}

export function triggerHolderRefresh(tokenMint: string): void {
  const cached = holderCache.get(tokenMint);
  if (cached) {
    cached.lastEventTriggerAt = Date.now();
    holderCache.set(tokenMint, cached);
  }
  // Fetch in background
  getHoldersCached(tokenMint, true).catch(console.error);
}

export function isWalletInTop100(tokenMint: string, walletAddress: string): { found: boolean; rank: number | null; percent: number | null } {
  const cached = holderCache.get(tokenMint);
  if (!cached) return { found: false, rank: null, percent: null };

  const index = cached.holders.findIndex(h => h.address.toLowerCase() === walletAddress.toLowerCase());
  if (index === -1) return { found: false, rank: null, percent: null };

  return {
    found: true,
    rank: index + 1,
    percent: cached.holders[index].percent,
  };
}

export function getHolderTier(rank: number): "top10" | "top50" | "top100" | null {
  if (rank <= 10) return "top10";
  if (rank <= 50) return "top50";
  if (rank <= 100) return "top100";
  return null;
}

export interface EmergingWhaleCheck {
  isEmergingWhale: boolean;
  wouldBeRank: number | null;
  top10Threshold: number | null;  // Amount needed to be in top 10
  swapAmount: number;
}

export function checkEmergingWhale(tokenMint: string, swapTokenAmount: number, walletAddress?: string): EmergingWhaleCheck {
  const cached = holderCache.get(tokenMint);
  if (!cached || cached.holders.length < 10) {
    return { isEmergingWhale: false, wouldBeRank: null, top10Threshold: null, swapAmount: swapTokenAmount };
  }

  // If wallet is already in top 10, skip - they're already a whale
  if (walletAddress) {
    const existingIdx = cached.holders.findIndex(h => h.address.toLowerCase() === walletAddress.toLowerCase());
    if (existingIdx !== -1 && existingIdx < 10) {
      return { isEmergingWhale: false, wouldBeRank: existingIdx + 1, top10Threshold: null, swapAmount: swapTokenAmount };
    }
  }

  // Get the #10 holder's uiAmount as the threshold (human-readable, matches swap.toAmount)
  const top10Threshold = cached.holders[9]?.uiAmount || 0;
  
  // Check where this swap amount would rank (compare against uiAmount for consistency)
  let wouldBeRank: number | null = null;
  for (let i = 0; i < cached.holders.length; i++) {
    if (swapTokenAmount > cached.holders[i].uiAmount) {
      wouldBeRank = i + 1;
      break;
    }
  }
  
  // If swap amount is larger than #10, they could become a top 10 holder
  const isEmergingWhale = swapTokenAmount > top10Threshold;
  
  return {
    isEmergingWhale,
    wouldBeRank: wouldBeRank || (swapTokenAmount > 0 ? 101 : null),
    top10Threshold,
    swapAmount: swapTokenAmount,
  };
}

// ==================== AGGREGATION ====================

function getBucketStart(timestamp: number, tier: AggregateTier): number {
  const date = new Date(timestamp);
  
  switch (tier) {
    case "15min":
      const mins = date.getMinutes();
      const bucket15 = Math.floor(mins / 15) * 15;
      date.setMinutes(bucket15, 0, 0);
      return date.getTime();
    case "hourly":
      date.setMinutes(0, 0, 0);
      return date.getTime();
    case "daily":
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    case "weekly":
      const day = date.getDay();
      date.setDate(date.getDate() - day);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
  }
}

export async function aggregateTicksTo15Min(tokenMint: string): Promise<void> {
  const buffer = tickBuffer.get(tokenMint);
  if (!buffer || buffer.length === 0) return;

  const now = Date.now();
  const currentBucketStart = getBucketStart(now, "15min");

  // Group ticks by bucket
  const buckets = new Map<number, PriceTick[]>();
  
  for (const tick of buffer) {
    const bucketStart = getBucketStart(tick.timestamp, "15min");
    // Only aggregate completed buckets (not current one)
    if (bucketStart < currentBucketStart) {
      if (!buckets.has(bucketStart)) {
        buckets.set(bucketStart, []);
      }
      buckets.get(bucketStart)!.push(tick);
    }
  }

  // Create aggregates for each completed bucket
  const bucketEntries = Array.from(buckets.entries());
  for (const [bucketStart, ticks] of bucketEntries) {
    if (ticks.length === 0) continue;

    // Check if aggregate already exists
    const existing = await db.select()
      .from(priceAggregates)
      .where(and(
        eq(priceAggregates.tokenMint, tokenMint),
        eq(priceAggregates.tier, "15min"),
        eq(priceAggregates.bucketStart, Math.floor(bucketStart / 1000))
      ))
      .limit(1);

    if (existing.length > 0) continue;

    // Sort by timestamp
    ticks.sort((a: PriceTick, b: PriceTick) => a.timestamp - b.timestamp);

    const holderData = holderCache.get(tokenMint);
    const aggregate: InsertPriceAggregate = {
      tokenMint,
      tier: "15min",
      bucketStart: Math.floor(bucketStart / 1000),
      priceOpen: ticks[0].price,
      priceHigh: Math.max(...ticks.map((t: PriceTick) => t.price)),
      priceLow: Math.min(...ticks.map((t: PriceTick) => t.price)),
      priceClose: ticks[ticks.length - 1].price,
      lpOpen: ticks[0].liquidity,
      lpClose: ticks[ticks.length - 1].liquidity,
      volume: ticks[ticks.length - 1].volume24h,
      buys: ticks[ticks.length - 1].buys24h,
      sells: ticks[ticks.length - 1].sells24h,
      marketCap: ticks[ticks.length - 1].marketCap,
      fdv: ticks[ticks.length - 1].fdv,
      holderCount: holderData?.totalCount || null,
      createdAt: Math.floor(now / 1000),
    };

    await db.insert(priceAggregates).values(aggregate);
  }

  // Clean up old ticks from buffer (keep only current bucket)
  const freshTicks = buffer.filter(t => getBucketStart(t.timestamp, "15min") >= currentBucketStart);
  tickBuffer.set(tokenMint, freshTicks);
}

async function rollUpAggregates(
  tokenMint: string,
  fromTier: AggregateTier,
  toTier: AggregateTier,
  requiredBuckets: number
): Promise<void> {
  const now = Date.now();
  const toBucketStart = getBucketStart(now, toTier);

  // Get completed source buckets that would roll into this bucket
  const fromBuckets = await db.select()
    .from(priceAggregates)
    .where(and(
      eq(priceAggregates.tokenMint, tokenMint),
      eq(priceAggregates.tier, fromTier),
      lt(priceAggregates.bucketStart, Math.floor(toBucketStart / 1000))
    ))
    .orderBy(desc(priceAggregates.bucketStart));

  // Group by target bucket
  const targetBuckets = new Map<number, PriceAggregate[]>();
  
  for (const bucket of fromBuckets) {
    const targetStart = getBucketStart(bucket.bucketStart * 1000, toTier);
    if (!targetBuckets.has(targetStart)) {
      targetBuckets.set(targetStart, []);
    }
    targetBuckets.get(targetStart)!.push(bucket);
  }

  // Create rolled up aggregates
  const targetEntries = Array.from(targetBuckets.entries());
  for (const [targetStart, sources] of targetEntries) {
    if (sources.length < requiredBuckets) continue;

    // Check if target already exists
    const existing = await db.select()
      .from(priceAggregates)
      .where(and(
        eq(priceAggregates.tokenMint, tokenMint),
        eq(priceAggregates.tier, toTier),
        eq(priceAggregates.bucketStart, Math.floor(targetStart / 1000))
      ))
      .limit(1);

    if (existing.length > 0) continue;

    // Sort by timestamp
    sources.sort((a: PriceAggregate, b: PriceAggregate) => a.bucketStart - b.bucketStart);

    const prices = sources.filter((s: PriceAggregate) => s.priceHigh !== null).map((s: PriceAggregate) => s.priceHigh!);
    const lows = sources.filter((s: PriceAggregate) => s.priceLow !== null).map((s: PriceAggregate) => s.priceLow!);

    const aggregate: InsertPriceAggregate = {
      tokenMint,
      tier: toTier,
      bucketStart: Math.floor(targetStart / 1000),
      priceOpen: sources[0].priceOpen,
      priceHigh: prices.length > 0 ? Math.max(...prices) : null,
      priceLow: lows.length > 0 ? Math.min(...lows) : null,
      priceClose: sources[sources.length - 1].priceClose,
      lpOpen: sources[0].lpOpen,
      lpClose: sources[sources.length - 1].lpClose,
      volume: sources.reduce((sum: number, s: PriceAggregate) => sum + (s.volume || 0), 0),
      buys: sources.reduce((sum: number, s: PriceAggregate) => sum + (s.buys || 0), 0),
      sells: sources.reduce((sum: number, s: PriceAggregate) => sum + (s.sells || 0), 0),
      marketCap: sources[sources.length - 1].marketCap,
      fdv: sources[sources.length - 1].fdv,
      holderCount: sources[sources.length - 1].holderCount,
      createdAt: Math.floor(now / 1000),
    };

    await db.insert(priceAggregates).values(aggregate);
  }
}

export async function runAggregationCycle(tokenMint: string): Promise<void> {
  // 1. Aggregate ticks to 15min buckets
  await aggregateTicksTo15Min(tokenMint);

  // 2. Roll up 15min -> hourly (4 buckets)
  await rollUpAggregates(tokenMint, "15min", "hourly", 4);

  // 3. Roll up hourly -> daily (24 buckets)
  await rollUpAggregates(tokenMint, "hourly", "daily", 24);

  // 4. Roll up daily -> weekly (7 buckets)
  await rollUpAggregates(tokenMint, "daily", "weekly", 7);
}

// ==================== CULLING ====================

export async function cullOldAggregates(tokenMint: string): Promise<void> {
  const now = Date.now();

  for (const [tier, maxAge] of Object.entries(RETENTION)) {
    const cutoff = Math.floor((now - maxAge) / 1000);
    
    await db.delete(priceAggregates)
      .where(and(
        eq(priceAggregates.tokenMint, tokenMint),
        eq(priceAggregates.tier, tier),
        lt(priceAggregates.bucketStart, cutoff)
      ));
  }
}

export async function runFullAggregationAndCull(): Promise<void> {
  // Get all unique tokens being tracked
  const tokens = Array.from(tickBuffer.keys());

  for (const tokenMint of tokens) {
    try {
      await runAggregationCycle(tokenMint);
      await cullOldAggregates(tokenMint);
    } catch (error) {
      console.error(`Aggregation failed for ${tokenMint}:`, error);
    }
  }
}

// ==================== QUERY HELPERS ====================

export async function getAggregates(
  tokenMint: string,
  tier: AggregateTier,
  limit = 100
): Promise<PriceAggregate[]> {
  return await db.select()
    .from(priceAggregates)
    .where(and(
      eq(priceAggregates.tokenMint, tokenMint),
      eq(priceAggregates.tier, tier)
    ))
    .orderBy(desc(priceAggregates.bucketStart))
    .limit(limit);
}

export async function getAggregatesForAI(tokenMint: string): Promise<{
  recent15min: PriceAggregate[];
  recentHourly: PriceAggregate[];
  recentDaily: PriceAggregate[];
}> {
  const [recent15min, recentHourly, recentDaily] = await Promise.all([
    getAggregates(tokenMint, "15min", 8),   // Last 2 hours
    getAggregates(tokenMint, "hourly", 24), // Last 24 hours
    getAggregates(tokenMint, "daily", 7),   // Last week
  ]);

  return { recent15min, recentHourly, recentDaily };
}

// Periodic aggregation job runner
let aggregationInterval: NodeJS.Timeout | null = null;

export function startAggregationJob(intervalMs = 60000): void {
  if (aggregationInterval) return;

  aggregationInterval = setInterval(async () => {
    try {
      await runFullAggregationAndCull();
    } catch (error) {
      console.error("Aggregation job failed:", error);
    }
  }, intervalMs);

  console.log("Price aggregation job started");
}

export function stopAggregationJob(): void {
  if (aggregationInterval) {
    clearInterval(aggregationInterval);
    aggregationInterval = null;
    console.log("Price aggregation job stopped");
  }
}
