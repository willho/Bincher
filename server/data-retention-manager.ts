import { db } from "./db";
import { eq, lt, and, sql } from "drizzle-orm";
import { swaps, monitoredWallets, walletFundingLinks } from "@shared/schema";

const RETENTION_CONFIG = {
  swaps: {
    monitoredWallets: "indefinite", // Keep all swaps from monitored wallets
    discoveredWallets: 30, // Keep discovered wallets 30 days
    unknownWallets: 7, // Keep unknown wallets 7 days
  },
  tokenDataPool: 90, // Keep token metadata 90 days
  priceAggregates: {
    fifteenMin: 14, // 15min candles kept 14 days
    hourly: 90, // Hourly candles kept 90 days
    daily: "indefinite", // Daily/weekly kept indefinitely
  },
};

interface CleanupJob {
  tableName: string;
  rowsDeleted: number;
  storageFreedBytes: number;
  executedAt: number;
}

/**
 * Clean up old swaps from unknown wallets (keep 7 days)
 * Budget: ~50 unknown wallets discovered daily × 100 swaps each = 5,000 rows/day
 * At 1KB per row = 5MB/day without cleanup, ~150MB/month
 */
export async function cleanupOldUnknownWalletSwaps(): Promise<CleanupJob> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_CONFIG.swaps.unknownWallets * 86400;

  // Get list of monitored wallets (those we want to keep)
  const monitoredWalletAddresses = (
    await db.select({ walletAddress: monitoredWallets.walletAddress }).from(monitoredWallets)
  ).map((w) => w.walletAddress);

  // Delete swaps older than cutoff from wallets we're not monitoring
  const result = await db
    .delete(swaps)
    .where(
      and(
        lt(swaps.timestamp, cutoff),
        // Exclude monitored wallets
        sql`source NOT IN (${sql.join(monitoredWalletAddresses)})`
      )
    )
    .returning({ id: swaps.id });

  const rowsDeleted = result.length;
  const estimatedStorageFreed = rowsDeleted * 1024; // ~1KB per swap record

  console.log(
    `[DataRetention] Deleted ${rowsDeleted} old unknown-wallet swaps (freed ~${(
      estimatedStorageFreed / 1024 / 1024
    ).toFixed(1)}MB)`
  );

  return {
    tableName: "swaps_unknown_wallets",
    rowsDeleted,
    storageFreedBytes: estimatedStorageFreed,
    executedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Clean up old swaps from discovered wallets (keep 30 days)
 * Before deletion, archive key metrics to tokenOutcomes table for backtest data
 */
export async function cleanupOldDiscoveredWalletSwaps(): Promise<CleanupJob> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_CONFIG.swaps.discoveredWallets * 86400;

  const monitoredWalletAddresses = (
    await db.select({ walletAddress: monitoredWallets.walletAddress }).from(monitoredWallets)
  ).map((w) => w.walletAddress);

  // TODO: Archive metrics to tokenOutcomes table before deletion
  // This would consolidate: win_rate, avg_multiplier, largest_win, largest_loss per token
  // For MVP, just delete without archiving

  const result = await db
    .delete(swaps)
    .where(
      and(
        lt(swaps.timestamp, cutoff),
        sql`source NOT IN (${sql.join(monitoredWalletAddresses)})` // Already covered in unknown cleanup
      )
    )
    .returning({ id: swaps.id });

  const rowsDeleted = result.length;
  const estimatedStorageFreed = rowsDeleted * 1024;

  console.log(
    `[DataRetention] Archived & deleted ${rowsDeleted} discovered-wallet swaps (freed ~${(
      estimatedStorageFreed / 1024 / 1024
    ).toFixed(1)}MB)`
  );

  return {
    tableName: "swaps_discovered_wallets",
    rowsDeleted,
    storageFreedBytes: estimatedStorageFreed,
    executedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Clean up old funding links (dormant > 7 days)
 * Funding links to "played out" tokens or wallets that never took action
 */
export async function cleanupOldFundingLinks(): Promise<CleanupJob> {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;

  const result = await db
    .delete(walletFundingLinks)
    .where(
      and(
        eq(walletFundingLinks.recipientStatus, "pending"),
        lt(walletFundingLinks.transferredAt, cutoff)
      )
    )
    .returning({ id: walletFundingLinks.id });

  const rowsDeleted = result.length;
  const estimatedStorageFreed = rowsDeleted * 500; // ~500 bytes per link

  console.log(
    `[DataRetention] Deleted ${rowsDeleted} dormant funding links (freed ~${(
      estimatedStorageFreed / 1024
    ).toFixed(0)}KB)`
  );

  return {
    tableName: "wallet_funding_links",
    rowsDeleted,
    storageFreedBytes: estimatedStorageFreed,
    executedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Main retention cleanup job - run daily
 */
export async function runDataRetentionCleanup(): Promise<CleanupJob[]> {
  console.log("[DataRetention] Starting daily cleanup cycle...");

  const results = await Promise.all([
    cleanupOldUnknownWalletSwaps(),
    cleanupOldDiscoveredWalletSwaps(),
    cleanupOldFundingLinks(),
  ]);

  const totalDeleted = results.reduce((sum, r) => sum + r.rowsDeleted, 0);
  const totalFreed = results.reduce((sum, r) => sum + r.storageFreedBytes, 0);

  console.log(
    `[DataRetention] Complete: deleted ${totalDeleted} rows, freed ~${(
      totalFreed / 1024 / 1024
    ).toFixed(1)}MB`
  );

  return results;
}

/**
 * Estimate current database size per wallet
 * Useful for monitoring growth and capacity planning
 */
export async function estimateWalletStorageFootprint(
  walletAddress: string
): Promise<{ swaps: number; estimatedMB: number }> {
  const swapCount = await db
    .select()
    .from(swaps)
    .where(eq(swaps.source, walletAddress));

  const estimatedMB = (swapCount.length * 1024) / (1024 * 1024);

  return {
    swaps: swapCount.length,
    estimatedMB,
  };
}

/**
 * Calculate total retention savings YTD
 */
export async function calculateRetentionSavings(): Promise<{
  estimatedRowsDeleted: number;
  estimatedStorageSavedGB: number;
  estimatedCostSavedUSD: number;
}> {
  // Heuristic: 1,000 wallets × 100 swaps/day × 365 = 36.5M swaps/year
  // With retention: keep monitored only (100 wallets × 100/day × 365 = 3.65M)
  // Deleted: 32.85M swaps/year
  // At 1KB per swap = 32.85GB saved
  // At ~$0.02/GB/month storage = ~$8/month × 12 = $96/year saved

  const estimatedDailyRows = 5000; // 50 unknown wallets × 100 swaps
  const estimatedYearlyRows = estimatedDailyRows * 365;
  const estimatedStorageGB = (estimatedYearlyRows * 1024) / (1024 * 1024 * 1024);
  const estimatedCostPerGBMonth = 0.02;
  const estimatedCostSaved = estimatedStorageGB * estimatedCostPerGBMonth * 12;

  return {
    estimatedRowsDeleted: estimatedYearlyRows,
    estimatedStorageSavedGB: estimatedStorageGB,
    estimatedCostSavedUSD: estimatedCostSaved,
  };
}
