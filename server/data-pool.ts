import { db } from "./db";
import { eq, and, desc, asc, sql, lt, gt, isNull } from "drizzle-orm";
import {
  tokenDataPool,
  holderCache,
  priceHistoryCache,
  fetchWorkQueue,
  TokenDataPoolEntry,
  HolderCacheEntry,
  PriceHistoryCacheEntry,
  FetchWorkQueueItem,
} from "@shared/schema";

const PRICE_TTL_SECONDS = 60;
const MARKET_DATA_TTL_SECONDS = 300;
const HOLDER_CACHE_TTL_SECONDS = 86400;

export async function getTokenData(tokenMint: string): Promise<TokenDataPoolEntry | null> {
  const entry = await db.query.tokenDataPool.findFirst({
    where: eq(tokenDataPool.tokenMint, tokenMint),
  });

  if (entry) {
    const now = Math.floor(Date.now() / 1000);
    await db.update(tokenDataPool)
      .set({
        lastAccessedAt: now,
        accessCount: (entry.accessCount ?? 0) + 1,
      })
      .where(eq(tokenDataPool.id, entry.id));
  }

  return entry ?? null;
}

export async function upsertTokenData(
  tokenMint: string,
  data: Partial<{
    tokenSymbol: string;
    tokenName: string;
    priceUsd: number;
    marketCap: number;
    fdv: number;
    liquidity: number;
    volume24h: number;
    priceChange24h: number;
    pairAddress: string;
    dexId: string;
    pairCreatedAt: number;
  }>,
  source: string = 'backend',
  fetchedBy?: number
): Promise<TokenDataPoolEntry> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await getTokenData(tokenMint);

  if (existing) {
    const updateData: Record<string, any> = {
      updatedAt: now,
      lastFetchSource: source,
    };

    if (data.tokenSymbol) updateData.tokenSymbol = data.tokenSymbol;
    if (data.tokenName) updateData.tokenName = data.tokenName;
    if (data.pairAddress) updateData.pairAddress = data.pairAddress;
    if (data.dexId) updateData.dexId = data.dexId;
    if (data.pairCreatedAt) updateData.pairCreatedAt = data.pairCreatedAt;

    if (data.priceUsd !== undefined) {
      updateData.priceUsd = data.priceUsd;
      updateData.priceUpdatedAt = now;
      updateData.priceSource = source;
    }

    if (data.marketCap !== undefined || data.fdv !== undefined || 
        data.liquidity !== undefined || data.volume24h !== undefined ||
        data.priceChange24h !== undefined) {
      if (data.marketCap !== undefined) updateData.marketCap = data.marketCap;
      if (data.fdv !== undefined) updateData.fdv = data.fdv;
      if (data.liquidity !== undefined) updateData.liquidity = data.liquidity;
      if (data.volume24h !== undefined) updateData.volume24h = data.volume24h;
      if (data.priceChange24h !== undefined) updateData.priceChange24h = data.priceChange24h;
      updateData.marketDataUpdatedAt = now;
    }

    if (fetchedBy) {
      updateData.lastFetchedBy = fetchedBy;
    }

    const [updated] = await db.update(tokenDataPool)
      .set(updateData)
      .where(eq(tokenDataPool.id, existing.id))
      .returning();

    return updated;
  }

  const [inserted] = await db.insert(tokenDataPool).values({
    tokenMint,
    tokenSymbol: data.tokenSymbol,
    tokenName: data.tokenName,
    priceUsd: data.priceUsd,
    priceUpdatedAt: data.priceUsd !== undefined ? now : null,
    priceSource: data.priceUsd !== undefined ? source : null,
    marketCap: data.marketCap,
    fdv: data.fdv,
    liquidity: data.liquidity,
    volume24h: data.volume24h,
    priceChange24h: data.priceChange24h,
    marketDataUpdatedAt: now,
    pairAddress: data.pairAddress,
    dexId: data.dexId,
    pairCreatedAt: data.pairCreatedAt,
    lastFetchedBy: fetchedBy,
    lastFetchSource: source,
    createdAt: now,
    updatedAt: now,
    isActive: true,
    lastAccessedAt: now,
    accessCount: 1,
  }).returning();

  return inserted;
}

export async function isPriceStale(tokenMint: string): Promise<boolean> {
  const entry = await getTokenData(tokenMint);
  if (!entry || !entry.priceUpdatedAt) return true;

  const now = Math.floor(Date.now() / 1000);
  return (now - entry.priceUpdatedAt) > PRICE_TTL_SECONDS;
}

export async function isMarketDataStale(tokenMint: string): Promise<boolean> {
  const entry = await getTokenData(tokenMint);
  if (!entry || !entry.marketDataUpdatedAt) return true;

  const now = Math.floor(Date.now() / 1000);
  return (now - entry.marketDataUpdatedAt) > MARKET_DATA_TTL_SECONDS;
}

export async function getHolderCache(tokenMint: string): Promise<HolderCacheEntry | null> {
  const result = await db.query.holderCache.findFirst({
    where: eq(holderCache.tokenMint, tokenMint),
  });
  return result ?? null;
}

export async function upsertHolderCache(
  tokenMint: string,
  holders: { address: string; amount: number; percent: number; rank: number }[],
  fetchedByUserId?: number,
  source: string = 'api'
): Promise<HolderCacheEntry> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + HOLDER_CACHE_TTL_SECONDS;

  const totalHolders = holders.length;
  const top10Concentration = holders
    .slice(0, 10)
    .reduce((sum, h) => sum + h.percent, 0);

  const existing = await getHolderCache(tokenMint);

  if (existing) {
    const [updated] = await db.update(holderCache)
      .set({
        holders,
        totalHolders,
        top10Concentration,
        fetchedVia: source,
        fetchedByUserId,
        fetchedAt: now,
        expiresAt,
        webhookUpdateCount: 0,
      })
      .where(eq(holderCache.id, existing.id))
      .returning();

    return updated;
  }

  const [inserted] = await db.insert(holderCache).values({
    tokenMint,
    holders,
    totalHolders,
    top10Concentration,
    fetchedVia: source,
    fetchedByUserId,
    fetchedAt: now,
    expiresAt,
    lastWebhookUpdate: null,
    webhookUpdateCount: 0,
    isActive: true,
    refreshPriority: 50,
  }).returning();

  return inserted;
}

export async function updateHolderFromWebhook(
  tokenMint: string,
  walletAddress: string,
  action: 'entry' | 'exit',
  amount?: number,
  retries: number = 3
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const cache = await getHolderCache(tokenMint);
    if (!cache) return false;

    const now = Math.floor(Date.now() / 1000);
    const originalFetchedAt = cache.fetchedAt;
    let holders = cache.holders ? [...cache.holders] : [];

    if (action === 'exit') {
      holders = holders.filter(h => h.address !== walletAddress);
    } else if (action === 'entry' && amount) {
      const existingIndex = holders.findIndex(h => h.address === walletAddress);
      if (existingIndex >= 0) {
        holders[existingIndex] = {
          ...holders[existingIndex],
          amount: holders[existingIndex].amount + amount,
        };
      } else {
        holders.push({
          address: walletAddress,
          amount,
          percent: 0,
          rank: holders.length + 1,
        });
      }
    }

    const totalAmount = holders.reduce((sum, h) => sum + h.amount, 0);
    holders = holders.map((h, i) => ({
      ...h,
      percent: totalAmount > 0 ? (h.amount / totalAmount) * 100 : 0,
      rank: i + 1,
    }));

    holders.sort((a, b) => b.amount - a.amount);

    const result = await db.update(holderCache)
      .set({
        holders,
        totalHolders: holders.length,
        top10Concentration: holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0),
        lastWebhookUpdate: now,
        webhookUpdateCount: (cache.webhookUpdateCount ?? 0) + 1,
      })
      .where(and(
        eq(holderCache.id, cache.id),
        eq(holderCache.fetchedAt, originalFetchedAt)
      ))
      .returning();

    if (result.length > 0) {
      return true;
    }
  }

  return false;
}

export async function isHolderCacheStale(tokenMint: string): Promise<boolean> {
  const cache = await getHolderCache(tokenMint);
  if (!cache) return true;

  const now = Math.floor(Date.now() / 1000);
  return now > cache.expiresAt;
}

export async function savePriceHistory(
  tokenMint: string,
  candles: {
    timeframe: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }[],
  source: string = 'dexscreener'
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  for (const candle of candles) {
    const existing = await db.query.priceHistoryCache.findFirst({
      where: and(
        eq(priceHistoryCache.tokenMint, tokenMint),
        eq(priceHistoryCache.timeframe, candle.timeframe),
        eq(priceHistoryCache.timestamp, candle.timestamp)
      ),
    });

    if (!existing) {
      await db.insert(priceHistoryCache).values({
        tokenMint,
        timeframe: candle.timeframe,
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        source,
        fetchedAt: now,
      });
    }
  }
}

export async function getPriceHistory(
  tokenMint: string,
  timeframe: string = '1h',
  limit: number = 168
): Promise<PriceHistoryCacheEntry[]> {
  return await db.query.priceHistoryCache.findMany({
    where: and(
      eq(priceHistoryCache.tokenMint, tokenMint),
      eq(priceHistoryCache.timeframe, timeframe)
    ),
    orderBy: [desc(priceHistoryCache.timestamp)],
    limit,
  });
}

export async function addToFetchQueue(
  resourceType: string,
  tokenMint: string,
  priority: number = 50,
  requestedBy?: number
): Promise<FetchWorkQueueItem> {
  const now = Math.floor(Date.now() / 1000);

  const existing = await db.query.fetchWorkQueue.findFirst({
    where: and(
      eq(fetchWorkQueue.resourceType, resourceType),
      eq(fetchWorkQueue.tokenMint, tokenMint),
      eq(fetchWorkQueue.status, 'pending')
    ),
  });

  if (existing) {
    if (priority > (existing.priority ?? 50)) {
      await db.update(fetchWorkQueue)
        .set({ priority })
        .where(eq(fetchWorkQueue.id, existing.id));
    }
    return existing;
  }

  const [inserted] = await db.insert(fetchWorkQueue).values({
    resourceType,
    tokenMint,
    priority,
    requestedBy,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 300,
  }).returning();

  return inserted;
}

export async function claimFetchWork(userId: number, limit: number = 5): Promise<FetchWorkQueueItem[]> {
  const now = Math.floor(Date.now() / 1000);

  const items = await db.query.fetchWorkQueue.findMany({
    where: and(
      eq(fetchWorkQueue.status, 'pending'),
      gt(fetchWorkQueue.expiresAt, now)
    ),
    orderBy: [desc(fetchWorkQueue.priority), asc(fetchWorkQueue.createdAt)],
    limit,
  });

  for (const item of items) {
    await db.update(fetchWorkQueue)
      .set({
        status: 'claimed',
        claimedBy: userId,
        claimedAt: now,
      })
      .where(eq(fetchWorkQueue.id, item.id));
  }

  return items;
}

export async function completeFetchWork(
  itemId: number,
  success: boolean,
  error?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await db.update(fetchWorkQueue)
    .set({
      status: success ? 'completed' : 'failed',
      completedAt: now,
      errorMessage: error,
    })
    .where(eq(fetchWorkQueue.id, itemId));
}

export async function getStaleTokensForRefresh(limit: number = 10): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - MARKET_DATA_TTL_SECONDS;

  const staleEntries = await db.query.tokenDataPool.findMany({
    where: and(
      eq(tokenDataPool.isActive, true),
      lt(tokenDataPool.marketDataUpdatedAt, staleThreshold)
    ),
    orderBy: [asc(tokenDataPool.marketDataUpdatedAt)],
    limit,
  });

  return staleEntries.map(e => e.tokenMint);
}

export async function getStaleHoldersForRefresh(limit: number = 10): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);

  const staleEntries = await db.query.holderCache.findMany({
    where: and(
      eq(holderCache.isActive, true),
      lt(holderCache.expiresAt, now)
    ),
    orderBy: [desc(holderCache.refreshPriority), asc(holderCache.expiresAt)],
    limit,
  });

  return staleEntries.map(e => e.tokenMint);
}

export async function cleanupOldPriceHistory(daysToKeep: number = 7): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 86400);

  await db.delete(priceHistoryCache)
    .where(lt(priceHistoryCache.fetchedAt, cutoff));

  return 0;
}

export async function cleanupOldFetchQueue(): Promise<number> {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

  await db.delete(fetchWorkQueue)
    .where(and(
      lt(fetchWorkQueue.createdAt, oneDayAgo),
      sql`${fetchWorkQueue.status} IN ('completed', 'failed')`
    ));

  return 0;
}

export async function getDataPoolStats(): Promise<{
  totalTokens: number;
  activeTokens: number;
  staleTokens: number;
  cachedHolders: number;
  staleHolders: number;
  pendingFetches: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - MARKET_DATA_TTL_SECONDS;

  const allTokens = await db.query.tokenDataPool.findMany();
  const activeTokens = allTokens.filter(t => t.isActive);
  const staleTokens = activeTokens.filter(t => 
    !t.marketDataUpdatedAt || t.marketDataUpdatedAt < staleThreshold
  );

  const allHolders = await db.query.holderCache.findMany();
  const staleHolders = allHolders.filter(h => now > h.expiresAt);

  const pendingFetches = await db.query.fetchWorkQueue.findMany({
    where: eq(fetchWorkQueue.status, 'pending'),
  });

  return {
    totalTokens: allTokens.length,
    activeTokens: activeTokens.length,
    staleTokens: staleTokens.length,
    cachedHolders: allHolders.length,
    staleHolders: staleHolders.length,
    pendingFetches: pendingFetches.length,
  };
}

export interface OpportunisticRefreshResult {
  tokensRefreshed: number;
  holdersRefreshed: number;
  creditsUsed: number;
  skippedNoSurplus: boolean;
  skippedNotIdle: boolean;
}

let isRefreshRunning = false;
let lastRefreshTime = 0;
const REFRESH_COOLDOWN_SECONDS = 60;

export async function runOpportunisticRefresh(
  maxCreditsToUse: number = 1000
): Promise<OpportunisticRefreshResult> {
  const result: OpportunisticRefreshResult = {
    tokensRefreshed: 0,
    holdersRefreshed: 0,
    creditsUsed: 0,
    skippedNoSurplus: false,
    skippedNotIdle: false,
  };

  const now = Math.floor(Date.now() / 1000);
  if (now - lastRefreshTime < REFRESH_COOLDOWN_SECONDS) {
    result.skippedNotIdle = true;
    return result;
  }

  if (isRefreshRunning) {
    result.skippedNotIdle = true;
    return result;
  }

  try {
    isRefreshRunning = true;

    const { getPoolSummary, borrowDiscoverySurplus } = await import("./budget-manager");
    const surplusStats = await getPoolSummary();
    
    const availableDiscovery = surplusStats.discoveryAllocation - surplusStats.discoveryUsed;
    if (availableDiscovery < 100) {
      result.skippedNoSurplus = true;
      return result;
    }

    const creditsToUse = Math.min(maxCreditsToUse, availableDiscovery);
    
    const staleTokens = await getStaleTokensForRefresh(5);
    for (const tokenMint of staleTokens) {
      if (result.creditsUsed >= creditsToUse) break;
      
      const borrowResult = await borrowDiscoverySurplus(100);
      if (borrowResult.borrowed < 100) break;
      
      await addToFetchQueue('market_data', tokenMint, 5);
      result.tokensRefreshed++;
      result.creditsUsed += 100;
    }

    const staleHolders = await getStaleHoldersForRefresh(3);
    for (const tokenMint of staleHolders) {
      if (result.creditsUsed >= creditsToUse) break;
      
      const borrowResult = await borrowDiscoverySurplus(200);
      if (borrowResult.borrowed < 200) break;
      
      await addToFetchQueue('holders', tokenMint, 5);
      result.holdersRefreshed++;
      result.creditsUsed += 200;
    }

    lastRefreshTime = now;
    return result;

  } finally {
    isRefreshRunning = false;
  }
}

export function isSystemIdle(): boolean {
  return !isRefreshRunning;
}

export function getLastRefreshTime(): number {
  return lastRefreshTime;
}

let opportunisticRefreshInterval: NodeJS.Timeout | null = null;

export function startOpportunisticRefreshJob(intervalMinutes: number = 5): void {
  if (opportunisticRefreshInterval) {
    clearInterval(opportunisticRefreshInterval);
  }

  console.log(`[DataPool] Starting opportunistic refresh job (every ${intervalMinutes} minutes)`);
  
  opportunisticRefreshInterval = setInterval(async () => {
    try {
      const result = await runOpportunisticRefresh(500);
      if (result.tokensRefreshed > 0 || result.holdersRefreshed > 0) {
        console.log(`[DataPool] Opportunistic refresh: ${result.tokensRefreshed} tokens, ${result.holdersRefreshed} holders, ${result.creditsUsed} credits`);
      }
    } catch (error) {
      console.error("[DataPool] Opportunistic refresh error:", error);
    }
  }, intervalMinutes * 60 * 1000);
}

export function stopOpportunisticRefreshJob(): void {
  if (opportunisticRefreshInterval) {
    clearInterval(opportunisticRefreshInterval);
    opportunisticRefreshInterval = null;
    console.log("[DataPool] Stopped opportunistic refresh job");
  }
}

export interface TokenDataWithSource {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  source: 'cache' | 'dexscreener' | 'geckoterminal' | 'stale';
  isStale: boolean;
  fetchedAt?: number;
}

export async function fetchTokenWithFallback(
  tokenMint: string,
  maxCacheAgeSeconds: number = 300
): Promise<TokenDataWithSource> {
  const now = Math.floor(Date.now() / 1000);
  
  const cached = await getTokenData(tokenMint);

  try {
    const dexData = await fetchFromDexScreener(tokenMint);
    if (dexData) {
      await upsertTokenData(tokenMint, dexData, 'dexscreener');
      return {
        tokenMint,
        ...dexData,
        source: 'dexscreener',
        isStale: false,
        fetchedAt: now,
      };
    }
  } catch (error) {
    console.warn("[DataPool] DexScreener fetch failed:", error);
  }

  if (cached && cached.priceUpdatedAt && (now - cached.priceUpdatedAt < maxCacheAgeSeconds)) {
    return {
      tokenMint,
      tokenSymbol: cached.tokenSymbol ?? undefined,
      tokenName: cached.tokenName ?? undefined,
      priceUsd: cached.priceUsd ?? undefined,
      marketCap: cached.marketCap ?? undefined,
      fdv: cached.fdv ?? undefined,
      liquidity: cached.liquidity ?? undefined,
      volume24h: cached.volume24h ?? undefined,
      priceChange24h: cached.priceChange24h ?? undefined,
      source: 'cache',
      isStale: false,
      fetchedAt: cached.priceUpdatedAt,
    };
  }

  try {
    const geckoData = await fetchFromGeckoTerminal(tokenMint);
    if (geckoData) {
      await upsertTokenData(tokenMint, geckoData, 'geckoterminal');
      return {
        tokenMint,
        ...geckoData,
        source: 'geckoterminal',
        isStale: false,
        fetchedAt: now,
      };
    }
  } catch (error) {
    console.warn("[DataPool] GeckoTerminal fetch failed:", error);
  }

  if (cached) {
    return {
      tokenMint,
      tokenSymbol: cached.tokenSymbol ?? undefined,
      tokenName: cached.tokenName ?? undefined,
      priceUsd: cached.priceUsd ?? undefined,
      marketCap: cached.marketCap ?? undefined,
      fdv: cached.fdv ?? undefined,
      liquidity: cached.liquidity ?? undefined,
      volume24h: cached.volume24h ?? undefined,
      priceChange24h: cached.priceChange24h ?? undefined,
      source: 'stale',
      isStale: true,
      fetchedAt: cached.priceUpdatedAt ?? undefined,
    };
  }

  return {
    tokenMint,
    source: 'stale',
    isStale: true,
  };
}

async function fetchFromDexScreener(tokenMint: string): Promise<{
  tokenSymbol?: string;
  tokenName?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  pairAddress?: string;
  dexId?: string;
} | null> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (!data.pairs || data.pairs.length === 0) {
    return null;
  }

  const pair = data.pairs[0];
  return {
    tokenSymbol: pair.baseToken?.symbol,
    tokenName: pair.baseToken?.name,
    priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
    marketCap: pair.marketCap,
    fdv: pair.fdv,
    liquidity: pair.liquidity?.usd,
    volume24h: pair.volume?.h24,
    priceChange24h: pair.priceChange?.h24,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
  };
}

async function fetchFromGeckoTerminal(tokenMint: string): Promise<{
  tokenSymbol?: string;
  tokenName?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  volume24h?: number;
} | null> {
  const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenMint}`);
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (!data.data || !data.data.attributes) {
    return null;
  }

  const attrs = data.data.attributes;
  return {
    tokenSymbol: attrs.symbol,
    tokenName: attrs.name,
    priceUsd: attrs.price_usd ? parseFloat(attrs.price_usd) : undefined,
    marketCap: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : undefined,
    fdv: attrs.fdv_usd ? parseFloat(attrs.fdv_usd) : undefined,
    volume24h: attrs.volume_usd?.h24 ? parseFloat(attrs.volume_usd.h24) : undefined,
  };
}
