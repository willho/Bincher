import { db } from "./db";
import { eq, sql, inArray } from "drizzle-orm";
import {
  tokenDataPool,
  TokenDataPoolEntry,
} from "@shared/schema";
import { cacheCoordinator } from "./cache-coordinator";

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 10000;
const PRICE_TTL_MS = 60 * 1000;
const MARKET_DATA_TTL_MS = 5 * 60 * 1000;

interface CachedToken {
  data: TokenDataPoolEntry;
  dirty: boolean;
  lastAccessed: number;
  insertedAt: number;
}

interface TrendingEntry {
  tokenMint: string;
  rank: number;
  source: string;
  updatedAt: number;
}

interface BoostEntry {
  tokenMint: string;
  rank: number;
  updatedAt: number;
}

interface NewPoolEntry {
  tokenMint: string;
  poolAddress?: string;
  dexId?: string;
  createdAt: number;
  source: string;
}

class MemoryCache {
  private tokenCache = new Map<string, CachedToken>();
  private dirtyTokens = new Set<string>();
  private newTokens = new Set<string>();

  private trendingTokens: TrendingEntry[] = [];
  private boostedTokens: BoostEntry[] = [];
  private newPools: NewPoolEntry[] = [];

  private flushInterval: NodeJS.Timeout | null = null;
  private flushInProgress = false;
  private lastFlushAt = 0;
  private totalFlushes = 0;
  private totalDbWritesSaved = 0;
  private totalReadsFromCache = 0;

  start(): void {
    if (this.flushInterval) return;

    // Startup recovery from potential crash
    cacheCoordinator.startupRecovery();

    // Poll for external invalidations every 30 seconds
    setInterval(() => {
      cacheCoordinator.pollForExternalInvalidations(60).catch(err => {
        console.error("[MemoryCache] Error polling invalidations:", err);
      });
    }, 30_000);

    // Listen for token invalidations (stale cache)
    cacheCoordinator.onInvalidate("token", undefined, () => {
      console.log("[MemoryCache] Received token invalidation signal");
      // Could implement selective invalidation here
      // For now, full flush on next cycle
    });

    console.log(`[MemoryCache] Started (flush every ${FLUSH_INTERVAL_MS / 1000}s, max ${MAX_CACHE_SIZE} tokens)`);
    this.flushInterval = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
    console.log("[MemoryCache] Stopped, final flush complete");
  }

  getToken(tokenMint: string): TokenDataPoolEntry | null {
    const cached = this.tokenCache.get(tokenMint);
    if (cached) {
      cached.lastAccessed = Date.now();
      this.totalReadsFromCache++;
      return cached.data;
    }
    return null;
  }

  setToken(tokenMint: string, data: TokenDataPoolEntry, markDirty: boolean = true): void {
    const existing = this.tokenCache.get(tokenMint);
    const now = Date.now();

    this.tokenCache.set(tokenMint, {
      data,
      dirty: markDirty || (existing?.dirty ?? false),
      lastAccessed: now,
      insertedAt: existing?.insertedAt ?? now,
    });

    if (markDirty) {
      this.dirtyTokens.add(tokenMint);
      if (!existing) {
        this.newTokens.add(tokenMint);
      }
    }

    if (this.tokenCache.size > MAX_CACHE_SIZE) {
      this.evictOldest();
    }
  }

  updateTokenFields(tokenMint: string, fields: Partial<TokenDataPoolEntry>): void {
    const cached = this.tokenCache.get(tokenMint);
    if (cached) {
      cached.data = { ...cached.data, ...fields } as TokenDataPoolEntry;
      cached.dirty = true;
      cached.lastAccessed = Date.now();
      this.dirtyTokens.add(tokenMint);
      this.totalDbWritesSaved++;
    }
  }

  isPriceStale(tokenMint: string): boolean {
    const cached = this.tokenCache.get(tokenMint);
    if (!cached || !cached.data.priceUpdatedAt) return true;
    const now = Math.floor(Date.now() / 1000);
    return (now - cached.data.priceUpdatedAt) > (PRICE_TTL_MS / 1000);
  }

  isMarketDataStale(tokenMint: string): boolean {
    const cached = this.tokenCache.get(tokenMint);
    if (!cached || !cached.data.marketDataUpdatedAt) return true;
    const now = Math.floor(Date.now() / 1000);
    return (now - cached.data.marketDataUpdatedAt) > (MARKET_DATA_TTL_MS / 1000);
  }

  setTrending(entries: TrendingEntry[]): void {
    this.trendingTokens = entries;
    const now = Math.floor(Date.now() / 1000);
    for (const entry of entries) {
      this.updateTokenFields(entry.tokenMint, {
        trendingRank: entry.rank,
        trendingSource: entry.source,
        trendingUpdatedAt: now,
      });
    }
  }

  getTrending(): TrendingEntry[] {
    return this.trendingTokens;
  }

  setBoosted(entries: BoostEntry[]): void {
    this.boostedTokens = entries;
    const now = Math.floor(Date.now() / 1000);
    for (const entry of entries) {
      this.updateTokenFields(entry.tokenMint, {
        boostRank: entry.rank,
        boostUpdatedAt: now,
      });
    }
  }

  getBoosted(): BoostEntry[] {
    return this.boostedTokens;
  }

  addNewPool(entry: NewPoolEntry): void {
    this.newPools.push(entry);
    if (this.newPools.length > 500) {
      this.newPools = this.newPools.slice(-500);
    }
  }

  getNewPools(since?: number): NewPoolEntry[] {
    if (!since) return this.newPools;
    return this.newPools.filter(p => p.createdAt >= since);
  }

  getAllCachedTokens(): TokenDataPoolEntry[] {
    return Array.from(this.tokenCache.values()).map(c => c.data);
  }

  getCachedTokenCount(): number {
    return this.tokenCache.size;
  }

  async warmUp(limit: number = 500): Promise<number> {
    const tokens = await db.query.tokenDataPool.findMany({
      where: eq(tokenDataPool.isActive, true),
      limit,
    });

    for (const token of tokens) {
      this.setToken(token.tokenMint, token, false);
    }

    console.log(`[MemoryCache] Warmed up with ${tokens.length} tokens`);
    return tokens.length;
  }

  async flush(): Promise<{ updated: number; inserted: number; errors: number }> {
    if (this.flushInProgress || this.dirtyTokens.size === 0) {
      return { updated: 0, inserted: 0, errors: 0 };
    }

    this.flushInProgress = true;
    const stats = { updated: 0, inserted: 0, errors: 0 };

    try {
      const dirtyMints = Array.from(this.dirtyTokens);
      const newMints = new Set(this.newTokens);

      const BATCH_SIZE = 50;
      for (let i = 0; i < dirtyMints.length; i += BATCH_SIZE) {
        const batch = dirtyMints.slice(i, i + BATCH_SIZE);

        for (const mint of batch) {
          const cached = this.tokenCache.get(mint);
          if (!cached || !cached.dirty) continue;

          try {
            if (newMints.has(mint)) {
              const existing = await db.query.tokenDataPool.findFirst({
                where: eq(tokenDataPool.tokenMint, mint),
              });

              if (existing) {
                await db.update(tokenDataPool)
                  .set(this.buildUpdatePayload(cached.data))
                  .where(eq(tokenDataPool.id, existing.id));
                stats.updated++;
              } else {
                const insertData = this.buildInsertPayload(cached.data);
                await db.insert(tokenDataPool).values(insertData as typeof tokenDataPool.$inferInsert);
                stats.inserted++;
              }
            } else {
              await db.update(tokenDataPool)
                .set(this.buildUpdatePayload(cached.data))
                .where(eq(tokenDataPool.tokenMint, mint));
              stats.updated++;
            }

            cached.dirty = false;
          } catch (error) {
            console.error(`[MemoryCache] Flush error for ${mint}:`, error);
            stats.errors++;
          }
        }
      }

      this.dirtyTokens.clear();
      this.newTokens.clear();
      this.lastFlushAt = Date.now();
      this.totalFlushes++;

      // Register write with cache coordinator
      for (const mint of dirtyMints) {
        cacheCoordinator.registerWrite("token", mint);
      }

      if (stats.updated > 0 || stats.inserted > 0) {
        console.log(`[MemoryCache] Flushed: ${stats.updated} updated, ${stats.inserted} inserted, ${stats.errors} errors`);
      }
    } finally {
      this.flushInProgress = false;
    }

    return stats;
  }

  private buildUpdatePayload(data: TokenDataPoolEntry): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { updatedAt: now };

    if (data.tokenSymbol) payload.tokenSymbol = data.tokenSymbol;
    if (data.tokenName) payload.tokenName = data.tokenName;
    if (data.priceUsd !== null && data.priceUsd !== undefined) {
      payload.priceUsd = data.priceUsd;
      payload.priceUpdatedAt = data.priceUpdatedAt;
      payload.priceSource = data.priceSource;
    }
    if (data.marketCap !== null && data.marketCap !== undefined) payload.marketCap = data.marketCap;
    if (data.fdv !== null && data.fdv !== undefined) payload.fdv = data.fdv;
    if (data.liquidity !== null && data.liquidity !== undefined) payload.liquidity = data.liquidity;
    if (data.volume24h !== null && data.volume24h !== undefined) payload.volume24h = data.volume24h;
    if (data.priceChange24h !== null && data.priceChange24h !== undefined) payload.priceChange24h = data.priceChange24h;
    if (data.marketDataUpdatedAt) payload.marketDataUpdatedAt = data.marketDataUpdatedAt;
    if (data.boostRank !== null && data.boostRank !== undefined) payload.boostRank = data.boostRank;
    if (data.boostUpdatedAt) payload.boostUpdatedAt = data.boostUpdatedAt;
    if (data.trendingRank !== null && data.trendingRank !== undefined) payload.trendingRank = data.trendingRank;
    if (data.trendingSource) payload.trendingSource = data.trendingSource;
    if (data.trendingUpdatedAt) payload.trendingUpdatedAt = data.trendingUpdatedAt;
    if (data.priceChange7d !== null && data.priceChange7d !== undefined) payload.priceChange7d = data.priceChange7d;
    if (data.priceChange14d !== null && data.priceChange14d !== undefined) payload.priceChange14d = data.priceChange14d;
    if (data.priceChange30d !== null && data.priceChange30d !== undefined) payload.priceChange30d = data.priceChange30d;
    if (data.deployerAddress) payload.deployerAddress = data.deployerAddress;
    if (data.lastFetchSource) payload.lastFetchSource = data.lastFetchSource;
    if (data.lastFetchedBy) payload.lastFetchedBy = data.lastFetchedBy;

    return payload;
  }

  private buildInsertPayload(data: TokenDataPoolEntry): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      tokenMint: data.tokenMint,
      tokenSymbol: data.tokenSymbol,
      tokenName: data.tokenName,
      priceUsd: data.priceUsd,
      priceUpdatedAt: data.priceUpdatedAt,
      priceSource: data.priceSource,
      marketCap: data.marketCap,
      fdv: data.fdv,
      liquidity: data.liquidity,
      volume24h: data.volume24h,
      priceChange24h: data.priceChange24h,
      marketDataUpdatedAt: data.marketDataUpdatedAt,
      pairAddress: data.pairAddress,
      dexId: data.dexId,
      pairCreatedAt: data.pairCreatedAt,
      lastFetchedBy: data.lastFetchedBy,
      lastFetchSource: data.lastFetchSource,
      createdAt: now,
      updatedAt: now,
      isActive: true,
      lastAccessedAt: now,
      accessCount: 1,
      boostRank: data.boostRank,
      boostUpdatedAt: data.boostUpdatedAt,
      trendingRank: data.trendingRank,
      trendingSource: data.trendingSource,
      trendingUpdatedAt: data.trendingUpdatedAt,
      priceChange7d: data.priceChange7d,
      priceChange14d: data.priceChange14d,
      priceChange30d: data.priceChange30d,
      deployerAddress: data.deployerAddress,
    };
  }

  private evictOldest(): void {
    const entries = Array.from(this.tokenCache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    const toEvict = entries.slice(0, Math.floor(MAX_CACHE_SIZE * 0.1));
    for (const [mint, cached] of toEvict) {
      if (cached.dirty) {
        continue;
      }
      this.tokenCache.delete(mint);
    }
  }

  getStats(): {
    cachedTokens: number;
    dirtyTokens: number;
    newTokens: number;
    trendingCount: number;
    boostedCount: number;
    newPoolsCount: number;
    totalFlushes: number;
    totalDbWritesSaved: number;
    totalReadsFromCache: number;
    lastFlushAt: number;
    flushInProgress: boolean;
  } {
    return {
      cachedTokens: this.tokenCache.size,
      dirtyTokens: this.dirtyTokens.size,
      newTokens: this.newTokens.size,
      trendingCount: this.trendingTokens.length,
      boostedCount: this.boostedTokens.length,
      newPoolsCount: this.newPools.length,
      totalFlushes: this.totalFlushes,
      totalDbWritesSaved: this.totalDbWritesSaved,
      totalReadsFromCache: this.totalReadsFromCache,
      lastFlushAt: this.lastFlushAt,
      flushInProgress: this.flushInProgress,
    };
  }
}

export const memoryCache = new MemoryCache();
