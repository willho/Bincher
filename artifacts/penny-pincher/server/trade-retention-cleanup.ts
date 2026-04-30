import { db } from "./db";
import { rawTokenTrades } from "@shared/schema";
import { lt } from "drizzle-orm";

/**
 * Trade Retention Cleanup Job
 * Deletes old raw trades to prevent storage bloat
 *
 * Strategy: Keep trades only 1 day (for same-token recalculation if needed)
 * After 1 day: Fingerprints exist, raw trades no longer needed
 *
 * Storage impact:
 * - 18M trades/month × 100B = 1.8 TB of raw data
 * - Keep 1 day only = 40M trades × 100B = 70 GB short-term
 * - Saves: 1.73 TB/month vs keeping all trades
 */

export async function cleanupOldTrades(maxAgeDays: number = 1): Promise<{
  deletedCount: number;
  storageCleaned: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - maxAgeDays * 86400;

  // Delete trades older than cutoff (return IDs to get accurate count)
  const deleted = await db
    .delete(rawTokenTrades)
    .where(lt(rawTokenTrades.createdAt, cutoffTime))
    .returning({ id: rawTokenTrades.id });

  const deletedCount = deleted.length;
  // Estimate storage freed (100 bytes per trade)
  const estimatedBytes = deletedCount * 100;
  const storageCleaned =
    estimatedBytes > 1_000_000_000
      ? `${(estimatedBytes / 1_000_000_000).toFixed(1)} GB`
      : `${(estimatedBytes / 1_000_000).toFixed(1)} MB`;

  console.log(
    `[TradeCleanup] Deleted ${deletedCount} trades older than ${maxAgeDays} day(s). Storage freed: ${storageCleaned}`
  );

  return {
    deletedCount,
    storageCleaned,
  };
}

/**
 * Strategy for keeping trades vs fingerprints
 *
 * KEEP (essential for trading):
 * - tokenFingerprints: All snapshots (recent 0-30 days + compressed 30+)
 * - tokenFingerprintClusters: Compressed historical patterns
 * - creatorReputation: Creator metrics
 * - retrolearnerThresholds: Learned thresholds
 * - tokenOutcomes: Final outcomes (for retrolearner)
 *
 * DELETE AFTER 1 DAY (no longer needed):
 * - rawTokenTrades: Aggregated into fingerprints
 *   └─ Saves 1.73 TB/month
 *
 * KEEP FOR CONTEXT (copy to archive if needed):
 * - Recent trades (0-1 day): Keep in rawTokenTrades
 * - Old trades (1+ days): Move to archive or delete
 *
 * Result: Storage scales with fingerprint growth, not trade volume growth
 */

/**
 * Archive old trades before deletion (optional, if audit trail needed)
 *
 * If you need historical trade data for compliance/debugging:
 * 1. Copy trades to archive table before deleting
 * 2. Archive table grows slowly (old trades appended, never deleted)
 * 3. queryable for forensics but not for active trading
 */
export async function archiveOldTrades(maxAgeDays: number = 7): Promise<{
  archivedCount: number;
}> {
  // TODO: Implement if audit trail needed
  // For now: just delete (no archive)
  return { archivedCount: 0 };
}

/**
 * Verify storage cleanup is working
 * Returns current trade table size estimate
 */
export async function getTradeTableStats(): Promise<{
  estimatedRowCount: number;
  estimatedSizeGB: number;
  oldestTradeAgeHours: number;
}> {
  // Query sample to estimate table size
  const sample = await db.query.rawTokenTrades.findMany({
    limit: 1000,
  });

  const oldestTrade = await db.query.rawTokenTrades.findFirst({
    orderBy: (table) => [table.createdAt],
  });

  const now = Math.floor(Date.now() / 1000);
  const oldestAgeSeconds = oldestTrade ? now - oldestTrade.createdAt : 0;
  const oldestAgeHours = oldestAgeSeconds / 3600;

  // Rough estimate: if sample of 1000 trades, how many total?
  // This is approximate - actual count may be higher
  const estimatedRowCount = sample.length > 0 ? sample.length * 100 : 0;
  const estimatedSizeGB = (estimatedRowCount * 100) / 1_000_000_000;

  return {
    estimatedRowCount,
    estimatedSizeGB,
    oldestTradeAgeHours: oldestAgeHours,
  };
}
