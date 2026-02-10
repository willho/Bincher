import { db } from "./db";
import { priceSnapshots, tokenDataPool, holderCache } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { memoryCache } from "./memory-cache";
import { upsertTokenData } from "./data-pool";
import { shouldAllowApiCall, trackApiCall, record429 } from "./api-budget";
import { emit } from "./discovery-event-bus";

const BOOST_FETCH_INTERVAL_MS = 60 * 1000;
const DAILY_SNAPSHOT_CHECK_INTERVAL_MS = 60 * 1000;

let boostInterval: NodeJS.Timeout | null = null;
let snapshotInterval: NodeJS.Timeout | null = null;
let lastSnapshotDate: string | null = null;

let boostStats = {
  totalFetches: 0,
  totalBoostedTokens: 0,
  lastFetchAt: 0,
  lastFetchCount: 0,
  errors: 0,
  startedAt: 0,
};

interface DexBoostToken {
  tokenAddress: string;
  chainId: string;
  amount?: number;
  totalAmount?: number;
  icon?: string;
  description?: string;
  links?: any[];
}

async function fetchBoosts(): Promise<void> {
  try {
    const budget = await shouldAllowApiCall("dexscreener", "boosts");
    if (!budget.allowed) return;

    const response = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (!response.ok) {
      if (response.status === 429) record429("dexscreener");
      else console.error(`[DexBoosts] API error: ${response.status} ${response.statusText}`);
      boostStats.errors++;
      return;
    }

    await trackApiCall("dexscreener", "boosts", 1);

    const data: DexBoostToken[] = await response.json();

    const solanaTokens = data.filter((t) => t.chainId === "solana");

    solanaTokens.sort((a, b) => {
      const amountA = a.totalAmount ?? a.amount ?? 0;
      const amountB = b.totalAmount ?? b.amount ?? 0;
      return amountB - amountA;
    });

    const now = Math.floor(Date.now() / 1000);
    const boostEntries = solanaTokens.map((token, index) => ({
      tokenMint: token.tokenAddress,
      rank: index + 1,
      updatedAt: now,
    }));

    memoryCache.setBoosted(boostEntries);

    for (const token of solanaTokens) {
      try {
        await upsertTokenData(
          token.tokenAddress,
          {},
          "dexscreener-boost"
        );
      } catch (err) {
        // silent - best effort
      }
    }

    const boostMints = solanaTokens.map(t => t.tokenAddress);
    if (boostMints.length > 0) {
      try {
        await db.update(tokenDataPool)
          .set({ discoverySource: "boosted", discoverySourceWallet: null })
          .where(and(
            sql`${tokenDataPool.tokenMint} IN (${sql.join(boostMints.map(m => sql`${m}`), sql`, `)})`,
            sql`${tokenDataPool.discoverySource} IS NULL`
          ));
      } catch (err) {
        // silent
      }
    }

    boostStats.totalFetches++;
    boostStats.lastFetchAt = now;
    boostStats.lastFetchCount = solanaTokens.length;
    boostStats.totalBoostedTokens += solanaTokens.length;

    if (solanaTokens.length > 0) {
      console.log(`[DexBoosts] Fetched ${solanaTokens.length} boosted Solana tokens`);

      const topMints = solanaTokens.slice(0, 10).map(t => t.tokenAddress);
      import("./whale-context").then(({ batchScanWhaleContext }) => {
        batchScanWhaleContext(topMints).catch(() => {});
      }).catch(() => {});

      for (const token of solanaTokens.slice(0, 10)) {
        const boostAmount = token.totalAmount ?? token.amount ?? 0;
        emit({
          type: "boost_detected",
          tokenMint: token.tokenAddress,
          source: "dexscreener",
          data: { boostAmount, description: token.description },
          timestamp: Date.now(),
          urgency: Math.min(10, Math.max(3, Math.floor(boostAmount / 100))),
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error("[DexBoosts] Fetch error:", error);
    boostStats.errors++;
  }
}

export function startBoostFetcher(): void {
  if (boostInterval) return;
  boostStats.startedAt = Math.floor(Date.now() / 1000);
  console.log("[DexBoosts] Starting boost fetcher (60s interval)");
  fetchBoosts();
  boostInterval = setInterval(fetchBoosts, BOOST_FETCH_INTERVAL_MS);
}

export function stopBoostFetcher(): void {
  if (boostInterval) {
    clearInterval(boostInterval);
    boostInterval = null;
    console.log("[DexBoosts] Boost fetcher stopped");
  }
}

export function getBoostStats(): {
  totalFetches: number;
  totalBoostedTokens: number;
  lastFetchAt: number;
  lastFetchCount: number;
  errors: number;
  startedAt: number;
  isRunning: boolean;
} {
  return {
    ...boostStats,
    isRunning: boostInterval !== null,
  };
}

function getTodayDateUTC(): string {
  const now = new Date();
  return now.toISOString().split("T")[0];
}

function getDateNDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

export async function runDailySnapshot(): Promise<{ snapshotsCreated: number; priceChangesUpdated: number }> {
  const today = getTodayDateUTC();
  let snapshotsCreated = 0;
  let priceChangesUpdated = 0;

  try {
    console.log(`[DailySnapshot] Starting daily snapshot for ${today}`);

    const activeTokens = await db.query.tokenDataPool.findMany({
      where: eq(tokenDataPool.isActive, true),
    });

    console.log(`[DailySnapshot] Found ${activeTokens.length} active tokens`);

    for (const token of activeTokens) {
      if (!token.priceUsd) continue;

      try {
        let holderCount: number | null = null;
        try {
          const holder = await db.query.holderCache.findFirst({
            where: eq(holderCache.tokenMint, token.tokenMint),
          });
          if (holder) {
            holderCount = holder.totalHolders ?? null;
          }
        } catch {
          // silent
        }

        const price = token.priceUsd;

        await db.insert(priceSnapshots).values({
          tokenMint: token.tokenMint,
          snapshotDate: today,
          snapshotType: "daily",
          open: price,
          high: price,
          low: price,
          close: price,
          volume: token.volume24h ?? null,
          marketCap: token.marketCap ?? null,
          liquidity: token.liquidity ?? null,
          holderCount,
          dataPointCount: 1,
          createdAt: Math.floor(Date.now() / 1000),
        }).onConflictDoNothing();

        snapshotsCreated++;
      } catch (error) {
        console.error(`[DailySnapshot] Error creating snapshot for ${token.tokenMint}:`, error);
      }
    }

    console.log(`[DailySnapshot] Created ${snapshotsCreated} snapshots`);

    const date7d = getDateNDaysAgo(7);
    const date14d = getDateNDaysAgo(14);
    const date30d = getDateNDaysAgo(30);

    for (const token of activeTokens) {
      if (!token.priceUsd) continue;

      try {
        const currentPrice = token.priceUsd;
        let priceChange7d: number | null = null;
        let priceChange14d: number | null = null;
        let priceChange30d: number | null = null;

        const [snap7d, snap14d, snap30d] = await Promise.all([
          db.query.priceSnapshots.findFirst({
            where: and(
              eq(priceSnapshots.tokenMint, token.tokenMint),
              eq(priceSnapshots.snapshotDate, date7d),
              eq(priceSnapshots.snapshotType, "daily")
            ),
          }),
          db.query.priceSnapshots.findFirst({
            where: and(
              eq(priceSnapshots.tokenMint, token.tokenMint),
              eq(priceSnapshots.snapshotDate, date14d),
              eq(priceSnapshots.snapshotType, "daily")
            ),
          }),
          db.query.priceSnapshots.findFirst({
            where: and(
              eq(priceSnapshots.tokenMint, token.tokenMint),
              eq(priceSnapshots.snapshotDate, date30d),
              eq(priceSnapshots.snapshotType, "daily")
            ),
          }),
        ]);

        if (snap7d && snap7d.close > 0) {
          priceChange7d = ((currentPrice - snap7d.close) / snap7d.close) * 100;
        }
        if (snap14d && snap14d.close > 0) {
          priceChange14d = ((currentPrice - snap14d.close) / snap14d.close) * 100;
        }
        if (snap30d && snap30d.close > 0) {
          priceChange30d = ((currentPrice - snap30d.close) / snap30d.close) * 100;
        }

        if (priceChange7d !== null || priceChange14d !== null || priceChange30d !== null) {
          const updateFields: Record<string, any> = {};
          if (priceChange7d !== null) updateFields.priceChange7d = priceChange7d;
          if (priceChange14d !== null) updateFields.priceChange14d = priceChange14d;
          if (priceChange30d !== null) updateFields.priceChange30d = priceChange30d;

          await db.update(tokenDataPool)
            .set(updateFields)
            .where(eq(tokenDataPool.tokenMint, token.tokenMint));

          memoryCache.updateTokenFields(token.tokenMint, updateFields);
          priceChangesUpdated++;
        }
      } catch (error) {
        console.error(`[DailySnapshot] Error calculating price changes for ${token.tokenMint}:`, error);
      }
    }

    console.log(`[DailySnapshot] Updated ${priceChangesUpdated} tokens with multi-timeframe price changes`);
    lastSnapshotDate = today;

    return { snapshotsCreated, priceChangesUpdated };
  } catch (error) {
    console.error("[DailySnapshot] Fatal error:", error);
    return { snapshotsCreated, priceChangesUpdated };
  }
}

async function checkAndRunDailySnapshot(): Promise<void> {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const today = getTodayDateUTC();

  if (currentHour === 0 && currentMinute < 2 && lastSnapshotDate !== today) {
    console.log("[DailySnapshot] Midnight UTC detected, running daily snapshot");
    await runDailySnapshot();
  }
}

export function startDailySnapshotJob(): void {
  if (snapshotInterval) return;
  lastSnapshotDate = null;
  console.log("[DailySnapshot] Starting daily snapshot job (checks every 60s for midnight UTC)");
  snapshotInterval = setInterval(checkAndRunDailySnapshot, DAILY_SNAPSHOT_CHECK_INTERVAL_MS);
}

export function stopDailySnapshotJob(): void {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
    console.log("[DailySnapshot] Daily snapshot job stopped");
  }
}
