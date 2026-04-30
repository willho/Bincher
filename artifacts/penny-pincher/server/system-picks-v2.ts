// @ts-nocheck
import { db } from "./db";
import { eq, and, gte, desc, gt } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  raydiumPoolDiscoveries,
  paperPositions,
  familiarWhales,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { openPaperPosition } from "./paper-trading";
// TODO: These exports need to be implemented in retrolearner-v2.ts
// import {
//   discoverOutcomeClusters,
//   matchTokenToClusters,
//   getCreatorHistoryPumpPortal,
// } from "./retrolearner-v2";
import { getExitStrategy } from "./exit-strategies";

// =====================
// CONFIGURATION
// =====================

const SYSTEM_PICKS_V2_CONFIG = {
  // Real-time scanning
  scanIntervalMs: 2 * 60 * 1000, // 2 minutes (faster than before)
  maxSimultaneousTokens: 50,

  // Conviction scoring weights
  clusterConfidenceWeight: 0.4, // Cluster match probability
  creatorReputationWeight: 0.35, // Creator track record
  walletSignalWeight: 0.25, // Whale/signal wallet buys

  // Cluster-specific thresholds
  clusterThresholds: {
    spike_and_bleed: 0.65, // Higher threshold for volatility
    slow_moon: 0.55, // Lower threshold for steady climbs
    pump_dump: 0.8, // Very high - avoid pump dumps
    late_bloomer: 0.6, // Medium - risky pattern
  },

  // Re-entry detection
  enableResurfaceRetrigger: true,
  minHoursSincePlayedOut: 4,
};

// =====================
// CREATOR REPUTATION SCORING
// =====================

/**
 * Get creator reputation from PumpPortal or on-chain analysis
 */
async function getCreatorReputation(mint: string): Promise<number> {
  try {
    const tokenData = await getTokenData(mint);

    if (!tokenData.creatorAddress) {
      return 0.5; // Unknown creator, neutral
    }

    // Query PumpPortal for creator history
    const creatorHistory = await getCreatorHistoryPumpPortal(tokenData.creatorAddress);

    // Score: (successRate * 0.6) + (1 - rugRate * 0.4)
    const creatorScore =
      creatorHistory.successRate * 0.6 - creatorHistory.rugRate * 0.4;

    // Boost if many launches (experienced creator)
    const volumeBoost = Math.min(0.2, creatorHistory.totalLaunches / 100);

    return Math.min(1.0, Math.max(0.1, creatorScore + volumeBoost));
  } catch (error) {
    console.error(
      `[SystemPicksV2] Error getting creator reputation for ${mint.slice(0, 20)}...:`
    );
    return 0.5;
  }
}

// =====================
// WALLET QUALITY SIGNALS
// =====================

/**
 * Evaluate whale/signal wallet quality for a token
 * Higher score if high-quality wallets are buying
 */
async function getWalletSignalScore(mint: string): Promise<number> {
  try {
    // In production: would check unified webhook for recent buyers
    // Calculate average win rate of recent buyers

    const tokenData = await getTokenData(mint);
    const ageHours = (Date.now() / 1000 - (tokenData.pairCreatedAt || 0)) / 3600;

    // Tokens with active whale interest are hotter
    if (ageHours < 0.5) return 0.8; // Fresh with potential whale activity
    if (ageHours < 2) return 0.6;
    if (ageHours < 6) return 0.4;
    return 0.2; // Older tokens less interesting
  } catch (error) {
    console.error(`[SystemPicksV2] Error getting wallet signals for ${mint.slice(0, 20)}...:`);
    return 0.3;
  }
}

// =====================
// CONVICTION CALCULATION
// =====================

interface ConvictionCalculation {
  clusterScore: number; // 0-1, highest probability cluster
  clusterName: string;
  creatorScore: number; // 0-1, creator reputation
  walletScore: number; // 0-1, whale/signal activity
  finalConviction: number; // 0-1, weighted average
  profitWindow: { start: number; end: number }; // minutes from entry
}

/**
 * Calculate conviction score using cluster matching + creator + wallets
 */
async function calculateConviction(
  mint: string
): Promise<ConvictionCalculation | null> {
  try {
    // Get outcome clusters
    const clusters = await discoverOutcomeClusters();

    // Match token to clusters
    const clusterMatches = await matchTokenToClusters(mint, clusters);

    // Find best cluster match
    let bestCluster = null;
    let bestScore = 0;

    for (const [clusterId, score] of Object.entries(clusterMatches)) {
      if (score > bestScore) {
        bestScore = score;
        bestCluster = clusters.find((c) => c.id === clusterId);
      }
    }

    if (!bestCluster || bestScore < 0.3) {
      return null; // No strong cluster match
    }

    // Get creator reputation
    const creatorScore = await getCreatorReputation(mint);

    // Get wallet signals
    const walletScore = await getWalletSignalScore(mint);

    // Weighted conviction
    const conviction =
      bestScore * SYSTEM_PICKS_V2_CONFIG.clusterConfidenceWeight +
      creatorScore * SYSTEM_PICKS_V2_CONFIG.creatorReputationWeight +
      walletScore * SYSTEM_PICKS_V2_CONFIG.walletSignalWeight;

    return {
      clusterScore: bestScore,
      clusterName: bestCluster.name,
      creatorScore,
      walletScore,
      finalConviction: conviction,
      profitWindow: bestCluster.profitWindow,
    };
  } catch (error) {
    console.error(
      `[SystemPicksV2] Error calculating conviction for ${mint.slice(0, 20)}...:`
    );
    return null;
  }
}

// =====================
// CLUSTER-SPECIFIC EXECUTION
// =====================

/**
 * Get cluster-specific entry/exit parameters
 * Entry windows define how long we wait for initial entry signal
 */
function getClusterEntryWindow(clusterName: string): number {
  const entryWindows: { [key: string]: number } = {
    spike_and_bleed: 5,    // Must buy within 5 minutes
    slow_moon: 30,         // More time to enter
    late_bloomer: 120,     // Very patient entry
    pump_dump: 15,         // Quick entry or miss it
    dead_launch: 10,       // Very quick decision
  };
  return entryWindows[clusterName] || 30;
}

/**
 * Determine if conviction meets cluster threshold
 */
function meetsClusterThreshold(
  clusterName: string,
  conviction: ConvictionCalculation
): boolean {
  const threshold = (SYSTEM_PICKS_V2_CONFIG.clusterThresholds as any)[clusterName] || 0.5;
  return conviction.finalConviction >= threshold;
}

// =====================
// POSITION OPENING
// =====================

/**
 * Open position with cluster-specific parameters
 */
async function openSystemPickV2(
  mint: string,
  tokenSymbol: string,
  conviction: ConvictionCalculation
): Promise<void> {
  try {
    const strategy = getExitStrategy(conviction.clusterName);

    // Skip pump_dump unless conviction is very high
    if (conviction.clusterName === "pump_dump" && conviction.finalConviction < 0.85) {
      console.log(
        `[SystemPicksV2] Skipping ${tokenSymbol}/${mint.slice(0, 8)}... (${conviction.clusterName}, conviction=${(conviction.finalConviction * 100).toFixed(0)}%)`
      );
      return;
    }

    console.log(
      `[SystemPicksV2] Opening position: ${tokenSymbol}/${mint.slice(0, 8)}... (cluster=${conviction.clusterName}, conviction=${(conviction.finalConviction * 100).toFixed(0)}%, creator=${(conviction.creatorScore * 100).toFixed(0)}%, wallet=${(conviction.walletScore * 100).toFixed(0)}%)`
    );

    await openPaperPosition({
      userId: 1,
      tokenMint: mint,
      tokenSymbol,
      entrySol: 1.0,
      stopLossPercent: strategy.stopLossPercent,
      takeProfitMultiplier: strategy.takeProfitMultiplier,
      trailingStop: true,
      trailingStopPercent: strategy.trailingStopPercent,
      // TODO: Pass exitTiers when paper-trading.ts supports partial exits
      // exitTiers: strategy.exitTiers,
    });

    console.log(
      `[SystemPicksV2] Strategy: ${strategy.description} (SL=${strategy.stopLossPercent}%, hold=${strategy.maxHoldMinutes}min)`
    );
  } catch (error) {
    console.error(
      `[SystemPicksV2] Error opening position for ${mint.slice(0, 20)}...:`
    );
  }
}

// =====================
// MAIN SCANNER
// =====================

export async function startSystemPicksV2(): Promise<void> {
  console.log(
    "[SystemPicksV2] Starting System Picks 2.0 (cluster-matched, real-time)"
  );

  // Initial scan after 30 seconds
  setTimeout(async () => {
    try {
      await scanForHighConvictionPicks();
    } catch (error) {
      console.error("[SystemPicksV2] Initial scan failed:", error);
    }
  }, 30_000);

  // Periodic scans every 2 minutes
  setInterval(async () => {
    try {
      await scanForHighConvictionPicks();
    } catch (error) {
      console.error("[SystemPicksV2] Scan error:", error);
    }
  }, SYSTEM_PICKS_V2_CONFIG.scanIntervalMs);
}

async function scanForHighConvictionPicks(): Promise<void> {
  try {
    // Check capacity
    const openTokens = await db
      .selectDistinct({ tokenMint: paperPositions.tokenMint })
      .from(paperPositions)
      .where(eq(paperPositions.status, "open"));

    if (openTokens.length >= SYSTEM_PICKS_V2_CONFIG.maxSimultaneousTokens) {
      console.log(
        `[SystemPicksV2] At capacity (${openTokens.length}/${SYSTEM_PICKS_V2_CONFIG.maxSimultaneousTokens})`
      );
      return;
    }

    // Get recently discovered pools
    const now = Math.floor(Date.now() / 1000);
    const candidates = await db.query.raydiumPoolDiscoveries.findMany({
      where: and(
        gte(raydiumPoolDiscoveries.discoveredAt, now - 3600),
        gt(raydiumPoolDiscoveries.qualityScore, 50) // Quality > 50
      ),
      orderBy: [desc(raydiumPoolDiscoveries.qualityScore)],
      limit: 30,
    });

    console.log(
      `[SystemPicksV2] Scanning ${candidates.length} quality pools from last hour`
    );

    const picks: Array<{
      mint: string;
      symbol: string;
      conviction: ConvictionCalculation;
    }> = [];

    // Evaluate each candidate
    for (const candidate of candidates) {
      const mint = candidate.associatedTokenMint || candidate.baseTokenMint;

      // Skip if already trading
      const existing = await db.query.paperPositions.findFirst({
        where: and(
          eq(paperPositions.tokenMint, mint),
          eq(paperPositions.status, "open")
        ),
      });

      if (existing) {
        continue;
      }

      // Calculate conviction
      const conviction = await calculateConviction(mint);

      if (!conviction) {
        continue;
      }

      // Skip if below cluster threshold
      if (!meetsClusterThreshold(conviction.clusterName, conviction)) {
        continue;
      }

      // High conviction pick!
      const tokenData = await getTokenData(mint);
      picks.push({
        mint,
        symbol: tokenData.tokenSymbol || mint.slice(0, 8),
        conviction,
      });
    }

    console.log(
      `[SystemPicksV2] Found ${picks.length} high-conviction picks`
    );

    // Open positions
    for (const pick of picks) {
      await openSystemPickV2(pick.mint, pick.symbol, pick.conviction);
    }
  } catch (error) {
    console.error("[SystemPicksV2] Scan failed:", error);
  }
}
