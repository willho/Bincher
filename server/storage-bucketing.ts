import { db } from "./db";
import { eq, and, lt, sql, desc, asc, lte, gte, ne, notInArray, inArray } from "drizzle-orm";
import {
  priceSnapshots,
  storageBucketStatus,
  paperPositions,
  tokenDataPool,
  discoveryEvents,
  PriceSnapshot,
} from "@shared/schema";

const SIZE_THRESHOLD_BYTES = 500 * 1024 * 1024;
const DAILY_RAW_RETENTION_DAYS = 14;
const THREE_DAY_RETENTION_DAYS = 30;
const WEEKLY_RETENTION_DAYS = 90;

interface StorageReport {
  totalSizeBytes: number;
  tableSizes: Record<string, number>;
  overThreshold: boolean;
  compressionNeeded: boolean;
  oldestRawDataDate: string | null;
}

export async function getStorageReport(): Promise<StorageReport> {
  try {
    const result = await db.execute(sql`
      SELECT
        schemaname,
        tablename,
        pg_total_relation_size(schemaname || '.' || tablename) as total_bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
    `);

    const tableSizes: Record<string, number> = {};
    let totalSize = 0;

    const rows = Array.isArray(result) ? result : (result as any).rows || [];
    for (const row of rows as any[]) {
      const bytes = parseInt(row.total_bytes) || 0;
      tableSizes[row.tablename] = bytes;
      totalSize += bytes;
    }

    const oldestRaw = await db.query.priceSnapshots.findFirst({
      where: eq(priceSnapshots.snapshotType, "daily"),
      orderBy: [asc(priceSnapshots.snapshotDate)],
    });

    return {
      totalSizeBytes: totalSize,
      tableSizes,
      overThreshold: totalSize > SIZE_THRESHOLD_BYTES,
      compressionNeeded: totalSize > SIZE_THRESHOLD_BYTES * 0.8,
      oldestRawDataDate: oldestRaw?.snapshotDate ?? null,
    };
  } catch (error) {
    console.error("[StorageBucketing] Error getting storage report:", error);
    return {
      totalSizeBytes: 0,
      tableSizes: {},
      overThreshold: false,
      compressionNeeded: false,
      oldestRawDataDate: null,
    };
  }
}

export async function compressDailyToThreeDay(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAILY_RAW_RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const dailySnapshots = await db.query.priceSnapshots.findMany({
    where: and(
      eq(priceSnapshots.snapshotType, "daily"),
      lt(priceSnapshots.snapshotDate, cutoffStr)
    ),
    orderBy: [asc(priceSnapshots.snapshotDate)],
  });

  if (dailySnapshots.length === 0) return 0;

  const tokenGroups = new Map<string, PriceSnapshot[]>();
  for (const snap of dailySnapshots) {
    const list = tokenGroups.get(snap.tokenMint) || [];
    list.push(snap);
    tokenGroups.set(snap.tokenMint, list);
  }

  let compressed = 0;

  for (const [tokenMint, snapshots] of Array.from(tokenGroups.entries())) {
    const chunks = chunkByDays(snapshots, 3);

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;

      const ohlc = aggregateOHLC(chunk);
      const periodDate = chunk[0].snapshotDate;

      try {
        await db.insert(priceSnapshots).values({
          tokenMint,
          snapshotDate: periodDate,
          snapshotType: "3day",
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          volume: ohlc.volume,
          volumeBuckets: ohlc.volumeBuckets,
          marketCap: ohlc.marketCap,
          liquidity: ohlc.liquidity,
          holderCount: ohlc.holderCount,
          dataPointCount: chunk.length,
          createdAt: Math.floor(Date.now() / 1000),
        }).onConflictDoNothing();

        const ids = chunk.map(s => s.id);
        for (const id of ids) {
          await db.delete(priceSnapshots).where(eq(priceSnapshots.id, id));
        }

        compressed += chunk.length;
      } catch (error) {
        console.error(`[StorageBucketing] Error compressing daily->3day for ${tokenMint}:`, error);
      }
    }
  }

  if (compressed > 0) {
    console.log(`[StorageBucketing] Compressed ${compressed} daily snapshots into 3-day OHLC`);
  }

  return compressed;
}

export async function compressThreeDayToWeekly(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - THREE_DAY_RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const threeDaySnapshots = await db.query.priceSnapshots.findMany({
    where: and(
      eq(priceSnapshots.snapshotType, "3day"),
      lt(priceSnapshots.snapshotDate, cutoffStr)
    ),
    orderBy: [asc(priceSnapshots.snapshotDate)],
  });

  if (threeDaySnapshots.length === 0) return 0;

  const tokenGroups = new Map<string, PriceSnapshot[]>();
  for (const snap of threeDaySnapshots) {
    const list = tokenGroups.get(snap.tokenMint) || [];
    list.push(snap);
    tokenGroups.set(snap.tokenMint, list);
  }

  let compressed = 0;

  for (const [tokenMint, snapshots] of Array.from(tokenGroups.entries())) {
    const chunks = chunkByDays(snapshots, 7);

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;

      const ohlc = aggregateOHLC(chunk);
      const periodDate = chunk[0].snapshotDate;

      try {
        await db.insert(priceSnapshots).values({
          tokenMint,
          snapshotDate: periodDate,
          snapshotType: "weekly",
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          volume: ohlc.volume,
          volumeBuckets: ohlc.volumeBuckets,
          marketCap: ohlc.marketCap,
          liquidity: ohlc.liquidity,
          holderCount: ohlc.holderCount,
          dataPointCount: chunk.reduce((sum, s) => sum + (s.dataPointCount ?? 1), 0),
          createdAt: Math.floor(Date.now() / 1000),
        }).onConflictDoNothing();

        const ids = chunk.map(s => s.id);
        for (const id of ids) {
          await db.delete(priceSnapshots).where(eq(priceSnapshots.id, id));
        }

        compressed += chunk.length;
      } catch (error) {
        console.error(`[StorageBucketing] Error compressing 3day->weekly for ${tokenMint}:`, error);
      }
    }
  }

  if (compressed > 0) {
    console.log(`[StorageBucketing] Compressed ${compressed} 3-day snapshots into weekly OHLC`);
  }

  return compressed;
}

export async function compressWeeklyToMonthly(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - WEEKLY_RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  const weeklySnapshots = await db.query.priceSnapshots.findMany({
    where: and(
      eq(priceSnapshots.snapshotType, "weekly"),
      lt(priceSnapshots.snapshotDate, cutoffStr)
    ),
    orderBy: [asc(priceSnapshots.snapshotDate)],
  });

  if (weeklySnapshots.length === 0) return 0;

  const tokenGroups = new Map<string, PriceSnapshot[]>();
  for (const snap of weeklySnapshots) {
    const list = tokenGroups.get(snap.tokenMint) || [];
    list.push(snap);
    tokenGroups.set(snap.tokenMint, list);
  }

  let compressed = 0;

  for (const [tokenMint, snapshots] of Array.from(tokenGroups.entries())) {
    const chunks = chunkByDays(snapshots, 30);

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;

      const ohlc = aggregateOHLC(chunk);
      const periodDate = chunk[0].snapshotDate;

      try {
        await db.insert(priceSnapshots).values({
          tokenMint,
          snapshotDate: periodDate,
          snapshotType: "monthly",
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          volume: ohlc.volume,
          volumeBuckets: ohlc.volumeBuckets,
          marketCap: ohlc.marketCap,
          liquidity: ohlc.liquidity,
          holderCount: ohlc.holderCount,
          dataPointCount: chunk.reduce((sum, s) => sum + (s.dataPointCount ?? 1), 0),
          createdAt: Math.floor(Date.now() / 1000),
        }).onConflictDoNothing();

        const ids = chunk.map(s => s.id);
        for (const id of ids) {
          await db.delete(priceSnapshots).where(eq(priceSnapshots.id, id));
        }

        compressed += chunk.length;
      } catch (error) {
        console.error(`[StorageBucketing] Error compressing weekly->monthly for ${tokenMint}:`, error);
      }
    }
  }

  if (compressed > 0) {
    console.log(`[StorageBucketing] Compressed ${compressed} weekly snapshots into monthly OHLC`);
  }

  return compressed;
}

function chunkByDays(snapshots: PriceSnapshot[], dayInterval: number): PriceSnapshot[][] {
  if (snapshots.length === 0) return [];

  const chunks: PriceSnapshot[][] = [];
  let currentChunk: PriceSnapshot[] = [];
  let chunkStartDate: Date | null = null;

  for (const snap of snapshots) {
    const snapDate = new Date(snap.snapshotDate);

    if (!chunkStartDate) {
      chunkStartDate = snapDate;
      currentChunk.push(snap);
      continue;
    }

    const daysDiff = Math.floor((snapDate.getTime() - chunkStartDate.getTime()) / (86400 * 1000));

    if (daysDiff < dayInterval) {
      currentChunk.push(snap);
    } else {
      chunks.push(currentChunk);
      currentChunk = [snap];
      chunkStartDate = snapDate;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function aggregateOHLC(snapshots: PriceSnapshot[]): {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  volumeBuckets: number[] | null;
  marketCap: number | null;
  liquidity: number | null;
  holderCount: number | null;
} {
  const open = snapshots[0].open;
  const close = snapshots[snapshots.length - 1].close;
  const high = Math.max(...snapshots.map(s => s.high));
  const low = Math.min(...snapshots.map(s => s.low));

  let volume: number | null = null;
  const volumeSnaps = snapshots.filter(s => s.volume !== null);
  if (volumeSnaps.length > 0) {
    volume = volumeSnaps.reduce((sum, s) => sum + (s.volume ?? 0), 0);
  }

  let volumeBuckets: number[] | null = null;
  const bucketSnaps = snapshots.filter(s => s.volumeBuckets && s.volumeBuckets.length === 6);
  if (bucketSnaps.length > 0) {
    volumeBuckets = [0, 0, 0, 0, 0, 0];
    for (const snap of bucketSnaps) {
      for (let i = 0; i < 6; i++) {
        volumeBuckets[i] += snap.volumeBuckets![i];
      }
    }
  }

  const mcSnaps = snapshots.filter(s => s.marketCap !== null);
  const marketCap = mcSnaps.length > 0
    ? mcSnaps[mcSnaps.length - 1].marketCap
    : null;

  const liqSnaps = snapshots.filter(s => s.liquidity !== null);
  const liquidity = liqSnaps.length > 0
    ? liqSnaps[liqSnaps.length - 1].liquidity
    : null;

  const holderSnaps = snapshots.filter(s => s.holderCount !== null);
  const holderCount = holderSnaps.length > 0
    ? holderSnaps[holderSnaps.length - 1].holderCount
    : null;

  return { open, high, low, close, volume, volumeBuckets, marketCap, liquidity, holderCount };
}

const PAPER_POSITION_RETENTION_DAYS = 14;
const TOKEN_POOL_STALE_DAYS = 7;

export async function archiveOldPaperPositions(): Promise<number> {
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - PAPER_POSITION_RETENTION_DAYS * 86400;

  try {
    const oldPositions = await db.select({ id: paperPositions.id })
      .from(paperPositions)
      .where(and(
        eq(paperPositions.status, "closed"),
        lt(paperPositions.exitTimestamp, cutoffTimestamp)
      ));

    if (oldPositions.length === 0) return 0;

    const batchSize = 100;
    let deleted = 0;

    for (let i = 0; i < oldPositions.length; i += batchSize) {
      const batch = oldPositions.slice(i, i + batchSize);
      const ids = batch.map(p => p.id);

      await db.delete(paperPositions)
        .where(inArray(paperPositions.id, ids));

      deleted += ids.length;
    }

    if (deleted > 0) {
      console.log(`[Retention] Archived ${deleted} closed paper positions older than ${PAPER_POSITION_RETENTION_DAYS} days`);
    }

    return deleted;
  } catch (error) {
    console.error("[Retention] Error archiving old paper positions:", error);
    return 0;
  }
}

export async function pruneStaleTokenPoolEntries(): Promise<number> {
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - TOKEN_POOL_STALE_DAYS * 86400;

  try {
    const openMints = await db.selectDistinct({ mint: paperPositions.tokenMint })
      .from(paperPositions)
      .where(eq(paperPositions.status, "open"));

    const openMintSet = new Set(openMints.map(r => r.mint));

    const recentEventMints = await db.selectDistinct({ mint: discoveryEvents.tokenMint })
      .from(discoveryEvents)
      .where(gte(discoveryEvents.firedAt, cutoffTimestamp));

    const recentMintSet = new Set(recentEventMints.map(r => r.mint));

    const staleTokens = await db.select({ id: tokenDataPool.id, mint: tokenDataPool.tokenMint })
      .from(tokenDataPool)
      .where(lt(tokenDataPool.updatedAt, cutoffTimestamp));

    const toDelete = staleTokens.filter(t =>
      !openMintSet.has(t.mint) && !recentMintSet.has(t.mint)
    );

    if (toDelete.length === 0) return 0;

    const batchSize = 100;
    let deleted = 0;

    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      const ids = batch.map(t => t.id);

      await db.delete(tokenDataPool)
        .where(inArray(tokenDataPool.id, ids));

      deleted += ids.length;
    }

    if (deleted > 0) {
      console.log(`[Retention] Pruned ${deleted} stale token pool entries (not updated in ${TOKEN_POOL_STALE_DAYS}+ days, no open positions or recent events)`);
    }

    return deleted;
  } catch (error) {
    console.error("[Retention] Error pruning stale token pool entries:", error);
    return 0;
  }
}

export async function runCompressionCycle(): Promise<{
  dailyCompressed: number;
  threeDayCompressed: number;
  weeklyCompressed: number;
  storageReport: StorageReport;
}> {
  console.log("[StorageBucketing] Starting compression cycle...");

  const dailyCompressed = await compressDailyToThreeDay();
  const threeDayCompressed = await compressThreeDayToWeekly();
  const weeklyCompressed = await compressWeeklyToMonthly();

  const positionsArchived = await archiveOldPaperPositions();
  const tokensPruned = await pruneStaleTokenPoolEntries();

  const storageReport = await getStorageReport();

  const now = Math.floor(Date.now() / 1000);
  try {
    await db.insert(storageBucketStatus).values({
      totalSizeBytes: storageReport.totalSizeBytes,
      tableSizes: storageReport.tableSizes,
      lastCompressionAt: now,
      lastCompressionLevel: weeklyCompressed > 0 ? "monthly" : threeDayCompressed > 0 ? "weekly" : dailyCompressed > 0 ? "3day" : "none",
      oldestRawDataAt: storageReport.oldestRawDataDate ? Math.floor(new Date(storageReport.oldestRawDataDate).getTime() / 1000) : null,
      checkedAt: now,
    });
  } catch (error) {
    console.error("[StorageBucketing] Error recording status:", error);
  }

  console.log(`[StorageBucketing] Compression complete: daily=${dailyCompressed}, 3day=${threeDayCompressed}, weekly=${weeklyCompressed}`);
  console.log(`[StorageBucketing] Total storage: ${(storageReport.totalSizeBytes / 1024 / 1024).toFixed(1)}MB (threshold: ${(SIZE_THRESHOLD_BYTES / 1024 / 1024).toFixed(0)}MB)`);

  return { dailyCompressed, threeDayCompressed, weeklyCompressed, storageReport };
}

let compressionInterval: NodeJS.Timeout | null = null;

export function startCompressionScheduler(): void {
  if (compressionInterval) return;

  console.log("[StorageBucketing] Compression scheduler started (runs daily)");

  runCompressionCycle().catch(err =>
    console.error("[StorageBucketing] Initial compression error:", err)
  );

  compressionInterval = setInterval(async () => {
    try {
      await runCompressionCycle();
    } catch (error) {
      console.error("[StorageBucketing] Scheduled compression error:", error);
    }
  }, 24 * 60 * 60 * 1000);
}

export function stopCompressionScheduler(): void {
  if (compressionInterval) {
    clearInterval(compressionInterval);
    compressionInterval = null;
    console.log("[StorageBucketing] Compression scheduler stopped");
  }
}

export async function getSnapshotHistory(
  tokenMint: string,
  days: number = 30
): Promise<PriceSnapshot[]> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  return await db.query.priceSnapshots.findMany({
    where: and(
      eq(priceSnapshots.tokenMint, tokenMint),
      gte(priceSnapshots.snapshotDate, cutoffStr)
    ),
    orderBy: [asc(priceSnapshots.snapshotDate)],
  });
}

export async function calculatePriceSlope(
  tokenMint: string,
  days: number
): Promise<number | null> {
  const snapshots = await getSnapshotHistory(tokenMint, days);
  if (snapshots.length < 2) return null;

  const first = snapshots[0].close;
  const last = snapshots[snapshots.length - 1].close;

  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

export async function detectRecoveryPattern(
  tokenMint: string,
  days: number = 30
): Promise<boolean> {
  const snapshots = await getSnapshotHistory(tokenMint, days);
  if (snapshots.length < 5) return false;

  const closes = snapshots.map(s => s.close);
  const maxPrice = Math.max(...closes);
  const maxIdx = closes.indexOf(maxPrice);

  if (maxIdx < 2) return false;

  const minAfterMax = Math.min(...closes.slice(maxIdx));
  const minAfterMaxIdx = maxIdx + closes.slice(maxIdx).indexOf(minAfterMax);

  if (minAfterMax >= maxPrice * 0.7) return false;

  const recoverySlice = closes.slice(minAfterMaxIdx);
  if (recoverySlice.length < 2) return false;

  const currentPrice = recoverySlice[recoverySlice.length - 1];
  return currentPrice > minAfterMax * 1.3;
}
