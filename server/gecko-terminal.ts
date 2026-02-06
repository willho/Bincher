import { memoryCache } from "./memory-cache";
import { upsertTokenData } from "./data-pool";
import { shouldAllowApiCall, trackApiCall } from "./api-budget";
import { db } from "./db";
import { priceSnapshots } from "@shared/schema";

const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2";
const HIGH_PRIORITY_INTERVAL_MS = 4000;
const LOW_PRIORITY_INTERVAL_MS = 12000;
const MAX_CALLS_PER_MINUTE = 25;
const LOW_PRIORITY_QUEUE_MAX = 500;

interface GeckoState {
  isRunning: boolean;
  highPriorityHandle: NodeJS.Timeout | null;
  lowPriorityHandle: NodeJS.Timeout | null;
  alternator: boolean;
  callsThisMinute: number;
  lastMinuteReset: number;
  trendingUpdatedAt: number;
  newPoolsUpdatedAt: number;
  totalCallsToday: number;
  errors: number;
}

interface LowPriorityTask {
  type: "price" | "ohlcv";
  tokenMint: string;
  poolAddress?: string;
  timeframe?: string;
  limit?: number;
}

const state: GeckoState = {
  isRunning: false,
  highPriorityHandle: null,
  lowPriorityHandle: null,
  alternator: true,
  callsThisMinute: 0,
  lastMinuteReset: Date.now(),
  trendingUpdatedAt: 0,
  newPoolsUpdatedAt: 0,
  totalCallsToday: 0,
  errors: 0,
};

const lowPriorityQueue: LowPriorityTask[] = [];

function resetMinuteCounterIfNeeded(): void {
  const now = Date.now();
  if (now - state.lastMinuteReset >= 60_000) {
    state.callsThisMinute = 0;
    state.lastMinuteReset = now;
  }
}

function canMakeCall(): boolean {
  resetMinuteCounterIfNeeded();
  return state.callsThisMinute < MAX_CALLS_PER_MINUTE;
}

function recordCall(): void {
  state.callsThisMinute++;
  state.totalCallsToday++;
}

function extractMintFromRelationship(pool: any): string | null {
  try {
    const id = pool?.relationships?.base_token?.data?.id;
    if (typeof id === "string" && id.startsWith("solana_")) {
      return id.replace("solana_", "");
    }
  } catch {}
  return null;
}

export async function fetchTrending(): Promise<void> {
  try {
    const budget = await shouldAllowApiCall("geckoterminal");
    if (!budget.allowed) {
      console.log(`[GeckoTerminal] Trending blocked: ${budget.reason}`);
      return;
    }

    if (!canMakeCall()) {
      console.log("[GeckoTerminal] Rate limit approaching, skipping trending");
      return;
    }

    const response = await fetch(`${GECKO_BASE_URL}/networks/solana/trending_pools`, {
      headers: { Accept: "application/json" },
    });

    recordCall();
    await trackApiCall("geckoterminal", "trending", 1);

    if (!response.ok) {
      console.error(`[GeckoTerminal] Trending fetch failed: ${response.status}`);
      state.errors++;
      return;
    }

    const data = await response.json();
    const pools = data?.data;
    if (!Array.isArray(pools)) return;

    const trendingEntries: { tokenMint: string; rank: number; source: string; updatedAt: number }[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const tokenMint = extractMintFromRelationship(pool);
      if (!tokenMint) continue;

      const attrs = pool.attributes || {};

      trendingEntries.push({
        tokenMint,
        rank: i + 1,
        source: "geckoterminal",
        updatedAt: now,
      });

      const priceStr = attrs.base_token_price_usd;
      const mcapStr = attrs.market_cap_usd;
      const fdvStr = attrs.fdv_usd;
      const volStr = attrs.volume_usd?.h24;
      const priceChangeStr = attrs.price_change_percentage?.h24;

      await upsertTokenData(
        tokenMint,
        {
          tokenSymbol: attrs.base_token_symbol || undefined,
          tokenName: attrs.name || undefined,
          priceUsd: priceStr ? parseFloat(priceStr) : undefined,
          marketCap: mcapStr ? parseFloat(mcapStr) : undefined,
          fdv: fdvStr ? parseFloat(fdvStr) : undefined,
          volume24h: volStr ? parseFloat(volStr) : undefined,
          priceChange24h: priceChangeStr ? parseFloat(priceChangeStr) : undefined,
          pairAddress: attrs.address || undefined,
        },
        "geckoterminal"
      );
    }

    if (trendingEntries.length > 0) {
      memoryCache.setTrending(trendingEntries);
      state.trendingUpdatedAt = now;
      console.log(`[GeckoTerminal] Updated ${trendingEntries.length} trending tokens`);
    }
  } catch (error) {
    console.error("[GeckoTerminal] Error fetching trending:", error);
    state.errors++;
  }
}

export async function fetchNewPools(): Promise<void> {
  try {
    const budget = await shouldAllowApiCall("geckoterminal");
    if (!budget.allowed) {
      console.log(`[GeckoTerminal] New pools blocked: ${budget.reason}`);
      return;
    }

    if (!canMakeCall()) {
      console.log("[GeckoTerminal] Rate limit approaching, skipping new pools");
      return;
    }

    const response = await fetch(`${GECKO_BASE_URL}/networks/solana/new_pools`, {
      headers: { Accept: "application/json" },
    });

    recordCall();
    await trackApiCall("geckoterminal", "new_pools", 1);

    if (!response.ok) {
      console.error(`[GeckoTerminal] New pools fetch failed: ${response.status}`);
      state.errors++;
      return;
    }

    const data = await response.json();
    const pools = data?.data;
    if (!Array.isArray(pools)) return;

    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;
    let addedCount = 0;

    for (const pool of pools) {
      const tokenMint = extractMintFromRelationship(pool);
      if (!tokenMint) continue;

      const attrs = pool.attributes || {};
      const createdAt = attrs.pool_created_at
        ? Math.floor(new Date(attrs.pool_created_at).getTime() / 1000)
        : now;

      if (createdAt < oneDayAgo) continue;

      memoryCache.addNewPool({
        tokenMint,
        poolAddress: attrs.address || undefined,
        dexId: attrs.dex_id || undefined,
        createdAt,
        source: "geckoterminal",
      });

      const priceStr = attrs.base_token_price_usd;
      const mcapStr = attrs.market_cap_usd;
      const fdvStr = attrs.fdv_usd;
      const volStr = attrs.volume_usd?.h24;
      const priceChangeStr = attrs.price_change_percentage?.h24;

      await upsertTokenData(
        tokenMint,
        {
          tokenSymbol: attrs.base_token_symbol || undefined,
          tokenName: attrs.name || undefined,
          priceUsd: priceStr ? parseFloat(priceStr) : undefined,
          marketCap: mcapStr ? parseFloat(mcapStr) : undefined,
          fdv: fdvStr ? parseFloat(fdvStr) : undefined,
          volume24h: volStr ? parseFloat(volStr) : undefined,
          priceChange24h: priceChangeStr ? parseFloat(priceChangeStr) : undefined,
          pairAddress: attrs.address || undefined,
          dexId: attrs.dex_id || undefined,
          pairCreatedAt: createdAt,
        },
        "geckoterminal"
      );

      addedCount++;
    }

    state.newPoolsUpdatedAt = now;
    if (addedCount > 0) {
      console.log(`[GeckoTerminal] Added ${addedCount} new pools`);
    }
  } catch (error) {
    console.error("[GeckoTerminal] Error fetching new pools:", error);
    state.errors++;
  }
}

export async function fetchTokenPrice(tokenMint: string): Promise<{
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number | null;
  symbol: string | null;
  name: string | null;
} | null> {
  try {
    const budget = await shouldAllowApiCall("geckoterminal");
    if (!budget.allowed) {
      console.log(`[GeckoTerminal] Token price blocked: ${budget.reason}`);
      return null;
    }

    if (!canMakeCall()) {
      console.log("[GeckoTerminal] Rate limit approaching, skipping token price");
      return null;
    }

    const response = await fetch(`${GECKO_BASE_URL}/networks/solana/tokens/${tokenMint}`, {
      headers: { Accept: "application/json" },
    });

    recordCall();
    await trackApiCall("geckoterminal", "token_price", 1);

    if (!response.ok) {
      console.error(`[GeckoTerminal] Token price fetch failed: ${response.status} for ${tokenMint}`);
      state.errors++;
      return null;
    }

    const data = await response.json();
    const attrs = data?.data?.attributes;
    if (!attrs) return null;

    const result = {
      priceUsd: attrs.price_usd ? parseFloat(attrs.price_usd) : null,
      marketCap: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : null,
      fdv: attrs.fdv_usd ? parseFloat(attrs.fdv_usd) : null,
      volume24h: attrs.volume_usd?.h24 ? parseFloat(attrs.volume_usd.h24) : null,
      symbol: attrs.symbol || null,
      name: attrs.name || null,
    };

    await upsertTokenData(
      tokenMint,
      {
        tokenSymbol: result.symbol || undefined,
        tokenName: result.name || undefined,
        priceUsd: result.priceUsd ?? undefined,
        marketCap: result.marketCap ?? undefined,
        fdv: result.fdv ?? undefined,
        volume24h: result.volume24h ?? undefined,
      },
      "geckoterminal"
    );

    return result;
  } catch (error) {
    console.error(`[GeckoTerminal] Error fetching token price for ${tokenMint}:`, error);
    state.errors++;
    return null;
  }
}

export async function fetchOHLCV(
  poolAddress: string,
  timeframe: string = "day",
  limit: number = 30
): Promise<number[][] | null> {
  try {
    const budget = await shouldAllowApiCall("geckoterminal");
    if (!budget.allowed) {
      console.log(`[GeckoTerminal] OHLCV blocked: ${budget.reason}`);
      return null;
    }

    if (!canMakeCall()) {
      console.log("[GeckoTerminal] Rate limit approaching, skipping OHLCV");
      return null;
    }

    const url = `${GECKO_BASE_URL}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    recordCall();
    await trackApiCall("geckoterminal", "ohlcv", 1);

    if (!response.ok) {
      console.error(`[GeckoTerminal] OHLCV fetch failed: ${response.status} for ${poolAddress}`);
      state.errors++;
      return null;
    }

    const data = await response.json();
    const ohlcvList = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcvList) || ohlcvList.length === 0) return null;

    const now = Math.floor(Date.now() / 1000);
    let insertedCount = 0;

    for (const candle of ohlcvList) {
      if (!Array.isArray(candle) || candle.length < 6) continue;

      const [timestamp, open, high, low, close, volume] = candle;
      const snapshotDate = new Date(timestamp * 1000).toISOString().split("T")[0];

      try {
        await db
          .insert(priceSnapshots)
          .values({
            tokenMint: poolAddress,
            snapshotDate,
            snapshotType: timeframe === "day" ? "daily" : timeframe,
            open,
            high,
            low,
            close,
            volume,
            createdAt: now,
          })
          .onConflictDoNothing();
        insertedCount++;
      } catch (insertError) {
        console.error(`[GeckoTerminal] OHLCV insert error for ${poolAddress}:`, insertError);
      }
    }

    if (insertedCount > 0) {
      console.log(`[GeckoTerminal] Inserted ${insertedCount} OHLCV candles for ${poolAddress}`);
    }

    return ohlcvList;
  } catch (error) {
    console.error(`[GeckoTerminal] Error fetching OHLCV for ${poolAddress}:`, error);
    state.errors++;
    return null;
  }
}

async function processHighPriority(): Promise<void> {
  if (state.alternator) {
    await fetchTrending();
  } else {
    await fetchNewPools();
  }
  state.alternator = !state.alternator;
}

async function processLowPriority(): Promise<void> {
  if (lowPriorityQueue.length === 0) return;

  const task = lowPriorityQueue.shift()!;

  try {
    if (task.type === "price") {
      await fetchTokenPrice(task.tokenMint);
    } else if (task.type === "ohlcv" && task.poolAddress) {
      await fetchOHLCV(task.poolAddress, task.timeframe || "day", task.limit || 30);
    }
  } catch (error) {
    console.error("[GeckoTerminal] Low priority task error:", error);
    state.errors++;
  }
}

export function queueLowPriorityFetch(task: {
  type: "price" | "ohlcv";
  tokenMint: string;
  poolAddress?: string;
  timeframe?: string;
  limit?: number;
}): void {
  if (lowPriorityQueue.length >= LOW_PRIORITY_QUEUE_MAX) {
    lowPriorityQueue.shift();
  }
  lowPriorityQueue.push(task);
}

export function startGeckoScheduler(): void {
  if (state.isRunning) {
    console.log("[GeckoTerminal] Scheduler already running");
    return;
  }

  state.isRunning = true;
  state.callsThisMinute = 0;
  state.lastMinuteReset = Date.now();

  console.log("[GeckoTerminal] Starting scheduler (high: 2.5s, low: 10s)");

  state.highPriorityHandle = setInterval(async () => {
    try {
      await processHighPriority();
    } catch (error) {
      console.error("[GeckoTerminal] High priority loop error:", error);
      state.errors++;
    }
  }, HIGH_PRIORITY_INTERVAL_MS);

  state.lowPriorityHandle = setInterval(async () => {
    try {
      await processLowPriority();
    } catch (error) {
      console.error("[GeckoTerminal] Low priority loop error:", error);
      state.errors++;
    }
  }, LOW_PRIORITY_INTERVAL_MS);
}

export function stopGeckoScheduler(): void {
  if (!state.isRunning) return;

  if (state.highPriorityHandle) {
    clearInterval(state.highPriorityHandle);
    state.highPriorityHandle = null;
  }

  if (state.lowPriorityHandle) {
    clearInterval(state.lowPriorityHandle);
    state.lowPriorityHandle = null;
  }

  state.isRunning = false;
  console.log("[GeckoTerminal] Scheduler stopped");
}

export function getGeckoStats(): {
  isRunning: boolean;
  callsThisMinute: number;
  totalCallsToday: number;
  trendingUpdatedAt: number;
  newPoolsUpdatedAt: number;
  errors: number;
  lowPriorityQueueSize: number;
  alternator: boolean;
} {
  resetMinuteCounterIfNeeded();
  return {
    isRunning: state.isRunning,
    callsThisMinute: state.callsThisMinute,
    totalCallsToday: state.totalCallsToday,
    trendingUpdatedAt: state.trendingUpdatedAt,
    newPoolsUpdatedAt: state.newPoolsUpdatedAt,
    errors: state.errors,
    lowPriorityQueueSize: lowPriorityQueue.length,
    alternator: state.alternator,
  };
}
