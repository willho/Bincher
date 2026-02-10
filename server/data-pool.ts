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
import { memoryCache } from "./memory-cache";

const PRICE_TTL_SECONDS = 60;
const MARKET_DATA_TTL_SECONDS = 300;
const HOLDER_CACHE_TTL_SECONDS = 86400;

export async function getTokenData(tokenMint: string): Promise<TokenDataPoolEntry | null> {
  const cached = memoryCache.getToken(tokenMint);
  if (cached) return cached;

  const entry = await db.query.tokenDataPool.findFirst({
    where: eq(tokenDataPool.tokenMint, tokenMint),
  });

  if (entry) {
    memoryCache.setToken(tokenMint, entry, false);
  }

  return entry ?? null;
}

export async function resolveTokenIdentifier(identifier: string): Promise<string | null> {
  if (!identifier || identifier.length < 2) return null;
  
  if (identifier.length >= 32 && identifier.length <= 44) {
    const entry = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, identifier),
    });
    if (entry) return identifier;
  }
  
  const searchLower = identifier.toLowerCase();
  const bySymbol = await db.query.tokenDataPool.findFirst({
    where: sql`LOWER(${tokenDataPool.tokenSymbol}) = ${searchLower}`,
  });
  if (bySymbol) return bySymbol.tokenMint;
  
  const byName = await db.query.tokenDataPool.findFirst({
    where: sql`LOWER(${tokenDataPool.tokenName}) LIKE ${'%' + searchLower + '%'}`,
  });
  if (byName) return byName.tokenMint;
  
  return null;
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
    priceChange1h: number;
    priceChange6h: number;
    pairAddress: string;
    dexId: string;
    pairCreatedAt: number;
    hasTwitter: boolean;
    hasTelegram: boolean;
    hasWebsite: boolean;
    twitterUrl: string;
    telegramUrl: string;
    websiteUrl: string;
    twitterMentions: number;
    telegramMentions: number;
    holderCount: number;
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
        data.priceChange24h !== undefined || data.priceChange1h !== undefined ||
        data.priceChange6h !== undefined) {
      if (data.marketCap !== undefined) updateData.marketCap = data.marketCap;
      if (data.fdv !== undefined) updateData.fdv = data.fdv;
      if (data.liquidity !== undefined) updateData.liquidity = data.liquidity;
      if (data.volume24h !== undefined) updateData.volume24h = data.volume24h;
      if (data.priceChange24h !== undefined) updateData.priceChange24h = data.priceChange24h;
      if (data.priceChange1h !== undefined) updateData.priceChange1h = data.priceChange1h;
      if (data.priceChange6h !== undefined) updateData.priceChange6h = data.priceChange6h;
      updateData.marketDataUpdatedAt = now;
    }

    if (data.hasTwitter !== undefined) updateData.hasTwitter = data.hasTwitter;
    if (data.hasTelegram !== undefined) updateData.hasTelegram = data.hasTelegram;
    if (data.hasWebsite !== undefined) updateData.hasWebsite = data.hasWebsite;
    if (data.twitterUrl) updateData.twitterUrl = data.twitterUrl;
    if (data.telegramUrl) updateData.telegramUrl = data.telegramUrl;
    if (data.websiteUrl) updateData.websiteUrl = data.websiteUrl;
    if (data.twitterMentions !== undefined) updateData.twitterMentions = data.twitterMentions;
    if (data.telegramMentions !== undefined) updateData.telegramMentions = data.telegramMentions;
    if (data.holderCount !== undefined) {
      updateData.holderCount = data.holderCount;
      updateData.holderCountUpdatedAt = now;
    }

    const hadSocials = existing.hasTwitter || existing.hasTelegram || existing.hasWebsite;
    const hasSocialsNow = data.hasTwitter || data.hasTelegram || data.hasWebsite;
    if (!hadSocials && hasSocialsNow) {
      updateData.socialFirstDetectedAt = now;
      try {
        const { emit } = await import("./discovery-event-bus");
        await emit({
          type: "social_detected" as any,
          tokenMint,
          tokenSymbol: data.tokenSymbol || existing.tokenSymbol || undefined,
          source: source,
          data: {
            hasTwitter: data.hasTwitter,
            hasTelegram: data.hasTelegram,
            hasWebsite: data.hasWebsite,
            twitterUrl: data.twitterUrl,
            telegramUrl: data.telegramUrl,
            websiteUrl: data.websiteUrl,
          },
          timestamp: Date.now(),
          urgency: 4,
        });
      } catch (e) {}
    }
    if (data.hasTwitter !== undefined || data.hasTelegram !== undefined || data.hasWebsite !== undefined) {
      updateData.socialCheckedAt = now;
    }

    if (fetchedBy) {
      updateData.lastFetchedBy = fetchedBy;
    }

    const mergedData = { ...existing, ...updateData } as TokenDataPoolEntry;
    memoryCache.setToken(tokenMint, mergedData, true);
    return mergedData;
  }

  const newEntry: TokenDataPoolEntry = {
    id: 0,
    tokenMint,
    tokenSymbol: data.tokenSymbol ?? null,
    tokenName: data.tokenName ?? null,
    priceUsd: data.priceUsd ?? null,
    priceUpdatedAt: data.priceUsd !== undefined ? now : null,
    priceSource: data.priceUsd !== undefined ? source : null,
    marketCap: data.marketCap ?? null,
    fdv: data.fdv ?? null,
    liquidity: data.liquidity ?? null,
    volume24h: data.volume24h ?? null,
    priceChange24h: data.priceChange24h ?? null,
    priceChange1h: data.priceChange1h ?? null,
    priceChange6h: data.priceChange6h ?? null,
    marketDataUpdatedAt: now,
    pairAddress: data.pairAddress ?? null,
    dexId: data.dexId ?? null,
    pairCreatedAt: data.pairCreatedAt ?? null,
    lastFetchedBy: fetchedBy ?? null,
    lastFetchSource: source,
    createdAt: now,
    updatedAt: now,
    isActive: true,
    lastAccessedAt: now,
    accessCount: 1,
    rugcheckData: null,
    rugcheckCheckedAt: null,
    goplusData: null,
    goplusCheckedAt: null,
    safetySource: null,
    isPumpfun: null,
    pumpfunGraduated: null,
    pumpfunGraduationTime: null,
    pumpfunAgeAtGraduation: null,
    pumpfunBondingCurveProgress: null,
    boostRank: null,
    boostUpdatedAt: null,
    trendingRank: null,
    trendingSource: null,
    trendingUpdatedAt: null,
    priceChange7d: null,
    priceChange14d: null,
    priceChange30d: null,
    deployerAddress: null,
    hasTwitter: data.hasTwitter ?? false,
    hasTelegram: data.hasTelegram ?? false,
    hasWebsite: data.hasWebsite ?? false,
    twitterUrl: data.twitterUrl ?? null,
    telegramUrl: data.telegramUrl ?? null,
    websiteUrl: data.websiteUrl ?? null,
    socialFirstDetectedAt: (data.hasTwitter || data.hasTelegram || data.hasWebsite) ? now : null,
    socialScore: null,
    twitterMentions: data.twitterMentions ?? 0,
    telegramMentions: data.telegramMentions ?? 0,
    socialCheckedAt: (data.hasTwitter !== undefined || data.hasTelegram !== undefined || data.hasWebsite !== undefined) ? now : null,
    pincherScore: null,
    pincherScoreRaw: null,
    pincherVerdict: null,
    pincherConfidence: null,
    pincherScoredAt: null,
    discoverySource: null,
    discoverySourceWallet: null,
    discoveryHopDepth: null,
    whaleHolderCount: 0,
    whaleAvgReputation: null,
    whaleBestReputation: null,
    whaleWorstReputation: null,
    whaleNetSentiment: null,
    whaleContextUpdatedAt: null,
    holderCount: data.holderCount ?? null,
    holderCountUpdatedAt: data.holderCount ? now : null,
  };

  memoryCache.setToken(tokenMint, newEntry, true);
  return newEntry;
}

export async function isPriceStale(tokenMint: string): Promise<boolean> {
  if (!memoryCache.isPriceStale(tokenMint)) return false;
  const entry = await getTokenData(tokenMint);
  if (!entry || !entry.priceUpdatedAt) return true;
  const now = Math.floor(Date.now() / 1000);
  return (now - entry.priceUpdatedAt) > PRICE_TTL_SECONDS;
}

export async function isMarketDataStale(tokenMint: string): Promise<boolean> {
  if (!memoryCache.isMarketDataStale(tokenMint)) return false;
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

// =====================
// ENRICHMENT QUEUE - FREE SOURCES FIRST, HELIUS ONLY IF NEEDED
// =====================

interface EnrichmentRequest {
  tokenMint: string;
  priority: 'high' | 'normal' | 'low';
  requiredFields: string[];
  requestedAt: number;
  source?: string;
}

const ENRICHMENT_QUEUE: EnrichmentRequest[] = [];
let isEnrichmentRunning = false;

export function queueEnrichment(
  tokenMint: string,
  priority: 'high' | 'normal' | 'low' = 'normal',
  requiredFields: string[] = ['priceUsd']
): void {
  const existing = ENRICHMENT_QUEUE.find(r => r.tokenMint === tokenMint);
  if (existing) {
    if (priority === 'high' && existing.priority !== 'high') {
      existing.priority = 'high';
    }
    for (const field of requiredFields) {
      if (!existing.requiredFields.includes(field)) {
        existing.requiredFields.push(field);
      }
    }
    return;
  }
  
  ENRICHMENT_QUEUE.push({
    tokenMint,
    priority,
    requiredFields,
    requestedAt: Date.now(),
  });
  
  if (!isEnrichmentRunning) {
    processEnrichmentQueue();
  }
}

async function processEnrichmentQueue(): Promise<void> {
  if (isEnrichmentRunning || ENRICHMENT_QUEUE.length === 0) return;
  
  isEnrichmentRunning = true;
  
  try {
    while (ENRICHMENT_QUEUE.length > 0) {
      ENRICHMENT_QUEUE.sort((a, b) => {
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        return a.requestedAt - b.requestedAt;
      });
      
      const request = ENRICHMENT_QUEUE.shift()!;
      await enrichToken(request);
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    isEnrichmentRunning = false;
  }
}

async function enrichToken(request: EnrichmentRequest): Promise<boolean> {
  const { tokenMint, requiredFields } = request;
  
  const cached = await getTokenData(tokenMint);
  if (cached && hasRequiredFields(cached, requiredFields)) {
    return true;
  }
  
  const dexData = await fetchFromDexScreener(tokenMint);
  if (dexData) {
    await upsertTokenData(tokenMint, {
      tokenSymbol: dexData.tokenSymbol,
      tokenName: dexData.tokenName,
      priceUsd: dexData.priceUsd,
      marketCap: dexData.marketCap,
      fdv: dexData.fdv,
      liquidity: dexData.liquidity,
      volume24h: dexData.volume24h,
      priceChange24h: dexData.priceChange24h,
    }, 'dexscreener');
    
    const updated = await getTokenData(tokenMint);
    if (updated && hasRequiredFields(updated, requiredFields)) {
      return true;
    }
  }
  
  const geckoData = await fetchFromGeckoTerminal(tokenMint);
  if (geckoData) {
    await upsertTokenData(tokenMint, {
      tokenSymbol: geckoData.tokenSymbol,
      tokenName: geckoData.tokenName,
      priceUsd: geckoData.priceUsd,
      marketCap: geckoData.marketCap,
      fdv: geckoData.fdv,
      volume24h: geckoData.volume24h,
    }, 'geckoterminal');
    
    const updated = await getTokenData(tokenMint);
    if (updated && hasRequiredFields(updated, requiredFields)) {
      return true;
    }
  }
  
  if (requiredFields.includes('holders') || requiredFields.includes('topHolders')) {
    console.log(`[Enrichment] Would use Helius for ${tokenMint} holders (not implemented)`);
  }
  
  return false;
}

function hasRequiredFields(data: TokenDataPoolEntry, requiredFields: string[]): boolean {
  for (const field of requiredFields) {
    const value = (data as Record<string, unknown>)[field];
    if (value === null || value === undefined) {
      return false;
    }
  }
  return true;
}

export function getEnrichmentQueueStats(): {
  queueLength: number;
  isRunning: boolean;
  byPriority: { high: number; normal: number; low: number };
} {
  return {
    queueLength: ENRICHMENT_QUEUE.length,
    isRunning: isEnrichmentRunning,
    byPriority: {
      high: ENRICHMENT_QUEUE.filter(r => r.priority === 'high').length,
      normal: ENRICHMENT_QUEUE.filter(r => r.priority === 'normal').length,
      low: ENRICHMENT_QUEUE.filter(r => r.priority === 'low').length,
    },
  };
}

export async function bulkEnrich(
  tokenMints: string[],
  priority: 'high' | 'normal' | 'low' = 'low'
): Promise<number> {
  let queued = 0;
  
  for (const tokenMint of tokenMints) {
    const cached = await getTokenData(tokenMint);
    if (!cached || isDataStale(cached)) {
      queueEnrichment(tokenMint, priority);
      queued++;
    }
  }
  
  return queued;
}

function isDataStale(data: TokenDataPoolEntry): boolean {
  const now = Math.floor(Date.now() / 1000);
  const staleTTL = 3600;
  return !data.priceUpdatedAt || (now - data.priceUpdatedAt) > staleTTL;
}

// Safety data TTL (1 hour, but can be re-checked if budget allows)
const SAFETY_DATA_TTL_SECONDS = 3600;

export async function updateTokenSafety(
  tokenMint: string,
  data: {
    rugcheckData?: Record<string, unknown>;
    goplusData?: Record<string, unknown>;
  },
  source: 'rugcheck' | 'goplus' | 'both'
): Promise<TokenDataPoolEntry | null> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await getTokenData(tokenMint);
  
  const updateData: Record<string, unknown> = {
    updatedAt: now,
  };
  
  if (data.rugcheckData) {
    updateData.rugcheckData = data.rugcheckData;
    updateData.rugcheckCheckedAt = now;
  }
  
  if (data.goplusData) {
    updateData.goplusData = data.goplusData;
    updateData.goplusCheckedAt = now;
  }
  
  // Determine source based on what we have
  if (data.rugcheckData && data.goplusData) {
    updateData.safetySource = 'both';
  } else if (data.rugcheckData) {
    updateData.safetySource = 'rugcheck';
  } else if (data.goplusData) {
    updateData.safetySource = 'goplus';
  }
  
  if (existing) {
    const merged = { ...existing, ...updateData } as TokenDataPoolEntry;
    memoryCache.setToken(tokenMint, merged, true);
    return merged;
  }
  
  const [inserted] = await db.insert(tokenDataPool).values({
    tokenMint,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    isActive: true,
    ...updateData,
  }).returning();
  
  memoryCache.setToken(tokenMint, inserted, false);
  return inserted;
}

export async function updatePumpfunStatus(
  tokenMint: string,
  data: {
    isPumpfun?: boolean;
    graduated?: boolean;
    graduationTime?: number;
    ageAtGraduation?: number;
    bondingCurveProgress?: number;
  }
): Promise<TokenDataPoolEntry | null> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await getTokenData(tokenMint);
  
  const updateData: Record<string, unknown> = {
    updatedAt: now,
  };
  
  if (data.isPumpfun !== undefined) updateData.isPumpfun = data.isPumpfun;
  if (data.graduated !== undefined) updateData.pumpfunGraduated = data.graduated;
  if (data.graduationTime !== undefined) updateData.pumpfunGraduationTime = data.graduationTime;
  if (data.ageAtGraduation !== undefined) updateData.pumpfunAgeAtGraduation = data.ageAtGraduation;
  if (data.bondingCurveProgress !== undefined) updateData.pumpfunBondingCurveProgress = data.bondingCurveProgress;
  
  if (existing) {
    const merged = { ...existing, ...updateData } as TokenDataPoolEntry;
    memoryCache.setToken(tokenMint, merged, true);
    return merged;
  }
  
  const [inserted] = await db.insert(tokenDataPool).values({
    tokenMint,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    isActive: true,
    ...updateData,
  }).returning();
  
  memoryCache.setToken(tokenMint, inserted, false);
  return inserted;
}

export async function isSafetyDataStale(tokenMint: string): Promise<boolean> {
  const entry = await getTokenData(tokenMint);
  if (!entry) return true;
  
  const now = Math.floor(Date.now() / 1000);
  
  // If we have both sources, check if either is stale
  const rugcheckStale = !entry.rugcheckCheckedAt || (now - entry.rugcheckCheckedAt) > SAFETY_DATA_TTL_SECONDS;
  const goplusStale = !entry.goplusCheckedAt || (now - entry.goplusCheckedAt) > SAFETY_DATA_TTL_SECONDS;
  
  // Stale if we have neither, or both are stale
  if (!entry.rugcheckCheckedAt && !entry.goplusCheckedAt) return true;
  
  return rugcheckStale && goplusStale;
}

export async function getTokensNeedingSafetyCheck(limit: number = 50): Promise<TokenDataPoolEntry[]> {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - SAFETY_DATA_TTL_SECONDS;
  
  // Get tokens that are active but have stale or missing safety data
  return await db.query.tokenDataPool.findMany({
    where: and(
      eq(tokenDataPool.isActive, true),
      sql`(
        ${tokenDataPool.rugcheckCheckedAt} IS NULL OR ${tokenDataPool.rugcheckCheckedAt} < ${staleThreshold}
      ) AND (
        ${tokenDataPool.goplusCheckedAt} IS NULL OR ${tokenDataPool.goplusCheckedAt} < ${staleThreshold}
      )`
    ),
    orderBy: [desc(tokenDataPool.accessCount), desc(tokenDataPool.lastAccessedAt)],
    limit,
  });
}

// Priority levels for unified queue
export type PriorityLevel = 'ui_displayed' | 'paper_position' | 'copy_trade' | 'discovery' | 'background';

const PRIORITY_WEIGHTS: Record<PriorityLevel, number> = {
  'ui_displayed': 100,
  'paper_position': 90,
  'copy_trade': 80,
  'discovery': 50,
  'background': 10,
};

// In-memory priority tracker for tokens
const tokenPriorityMap = new Map<string, { level: PriorityLevel; bumpedAt: number }>();

export function bumpTokenPriority(tokenMint: string, level: PriorityLevel): void {
  const current = tokenPriorityMap.get(tokenMint);
  const now = Math.floor(Date.now() / 1000);
  
  // Only bump if new priority is higher or current is expired (5 min)
  if (!current || PRIORITY_WEIGHTS[level] > PRIORITY_WEIGHTS[current.level] || (now - current.bumpedAt) > 300) {
    tokenPriorityMap.set(tokenMint, { level, bumpedAt: now });
  }
}

export function getTokenPriority(tokenMint: string): PriorityLevel {
  const entry = tokenPriorityMap.get(tokenMint);
  const now = Math.floor(Date.now() / 1000);
  
  if (!entry || (now - entry.bumpedAt) > 300) {
    return 'background';
  }
  
  return entry.level;
}

export function getHighPriorityTokens(): string[] {
  const now = Math.floor(Date.now() / 1000);
  const result: { mint: string; weight: number }[] = [];
  
  const entries = Array.from(tokenPriorityMap.entries());
  for (const [mint, entry] of entries) {
    if ((now - entry.bumpedAt) <= 300) {
      result.push({ mint, weight: PRIORITY_WEIGHTS[entry.level] });
    }
  }
  
  result.sort((a, b) => b.weight - a.weight);
  return result.map(r => r.mint);
}

export function clearExpiredPriorities(): number {
  const now = Math.floor(Date.now() / 1000);
  let cleared = 0;
  
  const entries = Array.from(tokenPriorityMap.entries());
  for (const [mint, entry] of entries) {
    if ((now - entry.bumpedAt) > 300) {
      tokenPriorityMap.delete(mint);
      cleared++;
    }
  }
  
  return cleared;
}

// Batch bump for UI views (e.g., signal wallet holdings)
export function bumpTokensBatch(tokenMints: string[], level: PriorityLevel): void {
  for (const mint of tokenMints) {
    bumpTokenPriority(mint, level);
  }
}

// =====================
// BATCHED DEXSCREENER REFRESH SYSTEM
// Targets 80% of daily DexScreener budget (345,600 calls/day)
// Uses batching (up to 30 tokens per call) for efficiency
// =====================

const DEXSCREENER_DAILY_BUDGET = 432000; // ~300/min
const TARGET_USAGE_PERCENT = 0.80;
const TARGET_DAILY_CALLS = Math.floor(DEXSCREENER_DAILY_BUDGET * TARGET_USAGE_PERCENT);
const MAX_BATCH_SIZE = 30;
const MIN_REFRESH_INTERVAL_MS = 1000; // Minimum 1 second between batches
const MAX_REFRESH_INTERVAL_MS = 60000; // Maximum 1 minute between batches

interface BatchedRefreshState {
  isRunning: boolean;
  lastRunAt: number;
  currentIntervalMs: number;
  tokensRefreshedToday: number;
  callsMadeToday: number;
  lastDayReset: string;
  intervalHandle: NodeJS.Timeout | null;
}

const batchRefreshState: BatchedRefreshState = {
  isRunning: false,
  lastRunAt: 0,
  currentIntervalMs: 5000, // Start with 5 second interval
  tokensRefreshedToday: 0,
  callsMadeToday: 0,
  lastDayReset: new Date().toISOString().split('T')[0],
  intervalHandle: null,
};

export interface TokenPriceData {
  tokenMint: string;
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
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
}

export async function batchFetchFromDexScreener(tokenMints: string[]): Promise<Map<string, TokenPriceData>> {
  const results = new Map<string, TokenPriceData>();
  
  if (tokenMints.length === 0) return results;
  
  // DexScreener supports comma-separated token addresses
  const batchedMints = tokenMints.slice(0, MAX_BATCH_SIZE).join(',');
  
  try {
    const { shouldAllowApiCall, trackApiCall } = await import("./api-budget");
    
    const budgetCheck = await shouldAllowApiCall("dexscreener");
    if (!budgetCheck.allowed) {
      return results;
    }
    
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batchedMints}`);
    
    // Track the API call (1 call for the batch)
    await trackApiCall("dexscreener", "batchTokens", 1);
    batchRefreshState.callsMadeToday++;
    
    if (!response.ok) {
      console.error(`[DexScreener Batch] API error: ${response.status}`);
      return results;
    }
    
    const data = await response.json();
    if (!data.pairs || data.pairs.length === 0) {
      return results;
    }
    
    // Group pairs by base token mint
    const pairsByMint = new Map<string, any[]>();
    for (const pair of data.pairs) {
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      
      if (!pairsByMint.has(mint)) {
        pairsByMint.set(mint, []);
      }
      pairsByMint.get(mint)!.push(pair);
    }
    
    // Select best pair for each token (highest liquidity)
    const pairEntries = Array.from(pairsByMint.entries());
    for (const [mint, pairs] of pairEntries) {
      const bestPair = pairs.reduce((best: any, current: any) => {
        const bestLiq = best.liquidity?.usd || 0;
        const currLiq = current.liquidity?.usd || 0;
        return currLiq > bestLiq ? current : best;
      });
      
      const socials = bestPair.info?.socials || [];
      const websites = bestPair.info?.websites || [];
      const twitterSocial = socials.find((s: any) => s.type === "twitter" || s.platform === "twitter");
      const telegramSocial = socials.find((s: any) => s.type === "telegram" || s.platform === "telegram");
      const websiteEntry = websites.find((w: any) => w.url);

      results.set(mint, {
        tokenMint: mint,
        tokenSymbol: bestPair.baseToken?.symbol,
        tokenName: bestPair.baseToken?.name,
        priceUsd: bestPair.priceUsd ? parseFloat(bestPair.priceUsd) : undefined,
        marketCap: bestPair.marketCap,
        fdv: bestPair.fdv,
        liquidity: bestPair.liquidity?.usd,
        volume24h: bestPair.volume?.h24,
        priceChange24h: bestPair.priceChange?.h24,
        pairAddress: bestPair.pairAddress,
        dexId: bestPair.dexId,
        hasTwitter: !!twitterSocial,
        hasTelegram: !!telegramSocial,
        hasWebsite: !!websiteEntry,
        twitterUrl: twitterSocial?.url || undefined,
        telegramUrl: telegramSocial?.url || undefined,
        websiteUrl: websiteEntry?.url || undefined,
      });
      
      batchRefreshState.tokensRefreshedToday++;
    }
    
    return results;
  } catch (error) {
    console.error("[DexScreener Batch] Fetch error:", error);
    return results;
  }
}

export async function refreshTokenBatch(): Promise<{ tokensRefreshed: number; callsMade: number }> {
  // Reset counters if new day
  const today = new Date().toISOString().split('T')[0];
  if (batchRefreshState.lastDayReset !== today) {
    batchRefreshState.tokensRefreshedToday = 0;
    batchRefreshState.callsMadeToday = 0;
    batchRefreshState.lastDayReset = today;
  }
  
  // Get tokens that need refreshing (stale first, then by priority)
  const staleTokens = await getStaleTokensForRefresh(MAX_BATCH_SIZE * 2);
  const highPriorityTokens = getHighPriorityTokens();
  
  // Combine and dedupe, prioritizing high-priority tokens
  const combinedTokens = [...highPriorityTokens, ...staleTokens];
  const tokensToRefresh = Array.from(new Set(combinedTokens)).slice(0, MAX_BATCH_SIZE);
  
  if (tokensToRefresh.length === 0) {
    return { tokensRefreshed: 0, callsMade: 0 };
  }
  
  // Fetch batch
  const results = await batchFetchFromDexScreener(tokensToRefresh);
  
  // Update tokenDataPool for each result
  const resultEntries = Array.from(results.entries());
  for (const [mint, data] of resultEntries) {
    await upsertTokenData(mint, {
      tokenSymbol: data.tokenSymbol,
      tokenName: data.tokenName,
      priceUsd: data.priceUsd,
      marketCap: data.marketCap,
      fdv: data.fdv,
      liquidity: data.liquidity,
      volume24h: data.volume24h,
      priceChange24h: data.priceChange24h,
      pairAddress: data.pairAddress,
      dexId: data.dexId,
      hasTwitter: data.hasTwitter,
      hasTelegram: data.hasTelegram,
      hasWebsite: data.hasWebsite,
      twitterUrl: data.twitterUrl,
      telegramUrl: data.telegramUrl,
      websiteUrl: data.websiteUrl,
    }, 'dexscreener_batch');
  }
  
  batchRefreshState.lastRunAt = Date.now();
  
  return { tokensRefreshed: results.size, callsMade: 1 };
}

function calculateOptimalInterval(): number {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msElapsedToday = now.getTime() - startOfDay.getTime();
  const msRemainingToday = 86400000 - msElapsedToday;
  
  // Calculate how many calls we can still make today to hit 80% target
  const callsRemaining = TARGET_DAILY_CALLS - batchRefreshState.callsMadeToday;
  
  if (callsRemaining <= 0) {
    // Already hit target, slow down significantly
    return MAX_REFRESH_INTERVAL_MS;
  }
  
  // Calculate interval to spread remaining calls evenly
  const intervalMs = Math.floor(msRemainingToday / callsRemaining);
  
  // Clamp to reasonable bounds
  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.min(intervalMs, MAX_REFRESH_INTERVAL_MS));
}

async function runBatchRefreshCycle(): Promise<void> {
  if (batchRefreshState.isRunning) return;
  
  batchRefreshState.isRunning = true;
  
  try {
    const result = await refreshTokenBatch();
    
    if (result.tokensRefreshed > 0) {
      console.log(`[DexScreener Batch] Refreshed ${result.tokensRefreshed} tokens (${batchRefreshState.callsMadeToday}/${TARGET_DAILY_CALLS} daily calls)`);
    }
    
    // Adjust interval dynamically
    batchRefreshState.currentIntervalMs = calculateOptimalInterval();
  } catch (error) {
    console.error("[DexScreener Batch] Cycle error:", error);
  } finally {
    batchRefreshState.isRunning = false;
  }
}

export function startBatchedDexScreenerRefresh(): void {
  if (batchRefreshState.intervalHandle) {
    console.log("[DexScreener Batch] Already running");
    return;
  }
  
  console.log(`[DexScreener Batch] Starting with ${batchRefreshState.currentIntervalMs}ms interval, targeting ${TARGET_DAILY_CALLS} calls/day`);
  
  // Run immediately
  runBatchRefreshCycle();
  
  // Set up dynamic interval
  const dynamicInterval = async () => {
    await runBatchRefreshCycle();
    
    // Schedule next run with updated interval
    batchRefreshState.intervalHandle = setTimeout(dynamicInterval, batchRefreshState.currentIntervalMs);
  };
  
  batchRefreshState.intervalHandle = setTimeout(dynamicInterval, batchRefreshState.currentIntervalMs);
}

export function stopBatchedDexScreenerRefresh(): void {
  if (batchRefreshState.intervalHandle) {
    clearTimeout(batchRefreshState.intervalHandle);
    batchRefreshState.intervalHandle = null;
    console.log("[DexScreener Batch] Stopped");
  }
}

export function getBatchRefreshStats(): {
  isRunning: boolean;
  currentIntervalMs: number;
  tokensRefreshedToday: number;
  callsMadeToday: number;
  targetDailyCalls: number;
  usagePercent: number;
} {
  return {
    isRunning: batchRefreshState.intervalHandle !== null,
    currentIntervalMs: batchRefreshState.currentIntervalMs,
    tokensRefreshedToday: batchRefreshState.tokensRefreshedToday,
    callsMadeToday: batchRefreshState.callsMadeToday,
    targetDailyCalls: TARGET_DAILY_CALLS,
    usagePercent: Math.round((batchRefreshState.callsMadeToday / TARGET_DAILY_CALLS) * 100 * 10) / 10,
  };
}
