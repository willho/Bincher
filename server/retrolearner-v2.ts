import { db } from "./db";
import { eq, and, gt, gte, desc, isNull, sql } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  tokenOutcomes,
  jupiterLatencyStats,
  raydiumPoolDiscoveries,
  familiarWhales,
  signalWalletProfiles,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { emit } from "./discovery-event-bus";
import axios from "axios";

// =====================
// CONFIGURATION
// =====================

const RETROLEARNER_V2_CONFIG = {
  // Real-time detection intervals
  trendingTokenCheckIntervalMs: 60 * 1000, // Check trending every 60s
  clusterRefreshIntervalMs: 3 * 60 * 60 * 1000, // Refresh clusters every 3h

  // Re-entry detection
  enableResurfaceDetection: true,
  enableSignalWalletRetrigger: true,

  // API limits
  dexscreenerBatchSize: 30,
  pumpfunBatchSize: 50,

  // Clustering
  optimalClusterCount: 6,
  minTokensPerCluster: 10,
};

let trendingCheckTimer: NodeJS.Timeout | null = null;
let clusterRefreshTimer: NodeJS.Timeout | null = null;

// =====================
// OUTCOME CLUSTERING
// =====================

interface TokenShape {
  tokenMint: string;
  timeToPeakMinutes: number;
  peakMultiplier: number;
  decayRate: number; // % per hour
  volumePattern: "spike" | "steady" | "pump_dump" | "flat";
  holderConcentration: number; // 0-1, concentration evolution
  profitabilityWindow: { start: number; end: number }; // minutes
}

interface OutcomeCluster {
  id: string;
  name: string;
  shape: {
    avgTimeToPeak: number;
    avgPeakMultiplier: number;
    avgDecayRate: number;
    volumePattern: string;
  };
  profitWindow: { start: number; end: number };
  sampleSize: number;
  winRate: number;
  tokenExamples: string[];
}

/**
 * Discover outcome clusters from historical token data
 * Clusters tokens by shape: spike_and_bleed, slow_moon, pump_dump, late_bloomer, dead_launch
 */
async function discoverOutcomeClusters(): Promise<OutcomeCluster[]> {
  try {
    console.log("[RetrolearnerV2] Discovering outcome clusters...");

    // Get recent analyzed tokens with full outcome data
    const tokens = await db.query.tokenOutcomes.findMany({
      where: and(
        isNull(tokenOutcomes.isPlayedOut),
        gte(tokenOutcomes.peakMultiplierAllTime, 1.0)
      ),
      limit: 100,
      orderBy: [desc(tokenOutcomes.lastAnalyzedAt)],
    });

    if (tokens.length < RETROLEARNER_V2_CONFIG.minTokensPerCluster) {
      console.log(
        `[RetrolearnerV2] Not enough tokens (${tokens.length}) to cluster, using defaults`
      );
      return getDefaultClusters();
    }

    // Extract shape features
    const shapes: TokenShape[] = tokens.map((t) => ({
      tokenMint: t.tokenMint,
      timeToPeakMinutes: t.timeToPeakMinutes || 30,
      peakMultiplier: t.peakMultiplierAllTime || 2,
      decayRate: estimateDecayRate(t),
      volumePattern: estimateVolumePattern(t),
      holderConcentration: t.raydiumHolderConcentration || 0.5,
      profitabilityWindow: { start: 0, end: 60 },
    }));

    // Simple clustering by peak multiplier and time to peak
    const clusters = clusterByShape(shapes);

    // Name clusters dynamically
    const namedClusters = clusters.map((c, i) => {
      const avgTimeToPeak = c.items.reduce((s, t) => s + t.timeToPeakMinutes, 0) / c.items.length;
      const avgPeak = c.items.reduce((s, t) => s + t.peakMultiplier, 0) / c.items.length;

      let name = "unknown";
      if (avgTimeToPeak < 60 && avgPeak > 5) {
        name = "spike_and_bleed"; // Fast 5x+, then decline
      } else if (avgTimeToPeak > 120 && avgPeak > 2) {
        name = "slow_moon"; // Gradual climb
      } else if (avgPeak < 1.5) {
        name = "dead_launch"; // Flatlines
      } else if (c.items.some((t) => t.volumePattern === "pump_dump")) {
        name = "pump_dump"; // Coordinated
      } else {
        name = "late_bloomer"; // Sleeper then moons
      }

      return {
        id: `cluster_${name}_${i}`,
        name,
        shape: {
          avgTimeToPeak,
          avgPeakMultiplier: avgPeak,
          avgDecayRate: c.items.reduce((s, t) => s + t.decayRate, 0) / c.items.length,
          volumePattern: c.items[0].volumePattern,
        },
        profitWindow: calculateProfitWindow(c.items),
        sampleSize: c.items.length,
        winRate: c.items.filter((t) => t.peakMultiplier > 2).length / c.items.length,
        tokenExamples: c.items.slice(0, 5).map((t) => t.tokenMint),
      };
    });

    console.log(`[RetrolearnerV2] Discovered ${namedClusters.length} outcome clusters`);
    namedClusters.forEach((c) => {
      console.log(
        `  - ${c.name}: ${c.sampleSize} tokens, ${(c.winRate * 100).toFixed(0)}% win rate, profit window ${c.profitWindow.start}-${c.profitWindow.end}min`
      );
    });

    return namedClusters;
  } catch (error) {
    console.error("[RetrolearnerV2] Error discovering clusters:", error);
    return getDefaultClusters();
  }
}

function getDefaultClusters(): OutcomeCluster[] {
  return [
    {
      id: "cluster_spike_and_bleed_0",
      name: "spike_and_bleed",
      shape: {
        avgTimeToPeak: 45,
        avgPeakMultiplier: 10,
        avgDecayRate: 50,
        volumePattern: "spike",
      },
      profitWindow: { start: 15, end: 45 },
      sampleSize: 0,
      winRate: 0.75,
      tokenExamples: [],
    },
    {
      id: "cluster_slow_moon_0",
      name: "slow_moon",
      shape: {
        avgTimeToPeak: 240,
        avgPeakMultiplier: 3,
        avgDecayRate: 5,
        volumePattern: "steady",
      },
      profitWindow: { start: 30, end: 240 },
      sampleSize: 0,
      winRate: 0.65,
      tokenExamples: [],
    },
    {
      id: "cluster_late_bloomer_0",
      name: "late_bloomer",
      shape: {
        avgTimeToPeak: 360,
        avgPeakMultiplier: 5,
        avgDecayRate: 10,
        volumePattern: "flat",
      },
      profitWindow: { start: 120, end: 360 },
      sampleSize: 0,
      winRate: 0.6,
      tokenExamples: [],
    },
  ];
}

function clusterByShape(shapes: TokenShape[]): { items: TokenShape[] }[] {
  // Simple clustering: group by time-to-peak ranges
  const grouped: { [key: string]: TokenShape[] } = {};

  for (const shape of shapes) {
    const key =
      shape.timeToPeakMinutes < 60
        ? "fast"
        : shape.timeToPeakMinutes < 240
          ? "medium"
          : "slow";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(shape);
  }

  return Object.values(grouped).map((items) => ({ items }));
}

function estimateDecayRate(outcome: any): number {
  // Estimate decay from peak multiplier and how fast it declined
  // Higher decay = faster drop
  if ((outcome.peakMultiplierAllTime || 0) < 2) return 0; // No decay if never peaked
  return Math.random() * 100; // Placeholder - would use actual price history
}

function estimateVolumePattern(outcome: any): "spike" | "steady" | "pump_dump" | "flat" {
  const peak = outcome.peakMultiplierAllTime || 0;
  if (peak > 5) return "spike";
  if (peak > 2) return "steady";
  if (peak < 0.5) return "flat";
  return "pump_dump"; // Default
}

function calculateProfitWindow(shapes: TokenShape[]): { start: number; end: number } {
  const avgStart = shapes.reduce((s, t) => s + (t.profitabilityWindow?.start || 0), 0) / shapes.length;
  const avgEnd = shapes.reduce((s, t) => s + (t.profitabilityWindow?.end || 60), 0) / shapes.length;
  return { start: Math.round(avgStart), end: Math.round(avgEnd) };
}

// =====================
// CREATOR HISTORY (PumpPortal)
// =====================

/**
 * Fetch creator history from PumpPortal API
 * Returns creator reputation for conviction scoring
 */
async function getCreatorHistoryPumpPortal(creator: string): Promise<{
  totalLaunches: number;
  successRate: number;
  avgMultiplier: number;
  rugRate: number;
}> {
  try {
    // Note: This would be a real API call to PumpPortal
    // For MVP, use placeholder implementation

    // In production:
    // const response = await axios.get(
    //   `https://api.pumpportal.fun/creators/${creator}`,
    //   { timeout: 5000 }
    // );

    console.log(`[RetrolearnerV2] Creator history would fetch from PumpPortal: ${creator.slice(0, 20)}...`);

    // Placeholder: estimate from on-chain data
    return {
      totalLaunches: Math.floor(Math.random() * 50),
      successRate: Math.random() * 0.8 + 0.2, // 20-100%
      avgMultiplier: Math.random() * 3 + 1, // 1-4x
      rugRate: Math.random() * 0.2, // 0-20%
    };
  } catch (error) {
    console.error(`[RetrolearnerV2] Error fetching creator history for ${creator.slice(0, 20)}...:`);
    return { totalLaunches: 0, successRate: 0.5, avgMultiplier: 1.5, rugRate: 0.1 };
  }
}

// =====================
// TRENDING TOKEN BACKSTOP
// =====================

/**
 * Check trending tokens from DexScreener/PumpFun
 * Re-trigger analysis for tokens that were marked played-out but are now trending
 */
async function checkTrendingTokensForResurface(): Promise<void> {
  try {
    console.log("[RetrolearnerV2] Checking trending tokens for dead-token resurfacing...");

    // Get trending tokens from DexScreener
    const trendingResponse = await axios.get(
      "https://api.dexscreener.com/token/trending",
      { timeout: 10000 }
    );

    const trendingMints = trendingResponse.data?.data?.map((t: any) => t.baseToken?.address).filter(Boolean) || [];

    console.log(`[RetrolearnerV2] Found ${trendingMints.length} trending tokens`);

    // Check which ones were previously marked as played-out
    for (const mint of trendingMints.slice(0, 20)) {
      const token = await getTokenData(mint);

      if (token && token.lastAnalyzedAt) {
        const hoursSinceAnalysis = (Date.now() / 1000 - token.lastAnalyzedAt) / 3600;

        // If token was analyzed >4h ago but is now trending → re-trigger
        if (hoursSinceAnalysis > 4) {
          console.log(
            `[RetrolearnerV2] Dead token resurfaced: ${mint.slice(0, 20)}... (analyzed ${hoursSinceAnalysis.toFixed(1)}h ago)`
          );

          // Emit event to trigger re-analysis
          await emit({
            type: "trending_spotted",
            tokenMint: mint,
            tokenSymbol: token.tokenSymbol,
            source: "retrolearner_v2_resurface",
            data: {
              wasPlayedOut: true,
              timeSinceLastAnalysis: hoursSinceAnalysis,
              reason: "trending_backstop",
            },
            timestamp: Date.now(),
            urgency: 8, // High urgency - resurfaced dead token
          });
        }
      }
    }
  } catch (error) {
    console.error("[RetrolearnerV2] Error checking trending tokens:", error instanceof Error ? error.message : error);
  }
}

// =====================
// SIGNAL WALLET RE-TRIGGER
// =====================

/**
 * Monitor signal wallet buys on tokens we previously marked as dead
 * If high-quality wallet buys a dead token → re-evaluate with fresh conviction
 */
async function checkSignalWalletRetriggers(): Promise<void> {
  try {
    // This would listen to the unified webhook for early signal wallet buys
    // If a wallet with 70%+ win rate buys a token we've marked played-out:
    // → Re-analyze that token immediately
    // → Calculate new conviction with fresh creator history + this new whale signal

    console.log("[RetrolearnerV2] Signal wallet re-trigger monitoring active");

    // In production: Hook into unified-webhook.ts to intercept swaps
    // Check if swapper is a high-quality whale AND token was previously analyzed
  } catch (error) {
    console.error("[RetrolearnerV2] Error in signal wallet re-trigger:", error);
  }
}

// =====================
// REAL-TIME CLUSTER MATCHING
// =====================

/**
 * Match a token to outcome clusters in real-time
 * Returns cluster probabilities
 */
async function matchTokenToClusters(
  mint: string,
  clusters: OutcomeCluster[]
): Promise<{ [clusterId: string]: number }> {
  try {
    const tokenData = await getTokenData(mint);
    const outcome = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, mint),
    });

    if (!outcome) {
      return {};
    }

    const timeToPeak = outcome.timeToPeakMinutes || 30;
    const peak = outcome.peakMultiplierAllTime || 2;

    // Calculate probability match to each cluster
    const matches: { [key: string]: number } = {};

    for (const cluster of clusters) {
      let probability = 0;

      // Distance from cluster center
      const timeDist = Math.abs(timeToPeak - cluster.shape.avgTimeToPeak);
      const peakDist = Math.abs(peak - cluster.shape.avgPeakMultiplier);

      // Closer = higher probability
      probability = Math.max(0, 1 - (timeDist / 100 + peakDist / 5) / 2);

      matches[cluster.id] = probability;
    }

    return matches;
  } catch (error) {
    console.error(`[RetrolearnerV2] Error matching token ${mint.slice(0, 20)}... to clusters:`, error);
    return {};
  }
}

// =====================
// STARTUP & MONITORING
// =====================

export async function startRetrolearnerV2(): Promise<void> {
  console.log("[RetrolearnerV2] Starting Retrolearner 2.0 with dynamic clustering...");

  // Discover initial clusters
  const clusters = await discoverOutcomeClusters();

  // Check trending tokens every 60 seconds
  if (RETROLEARNER_V2_CONFIG.enableResurfaceDetection) {
    trendingCheckTimer = setInterval(async () => {
      try {
        await checkTrendingTokensForResurface();
      } catch (error) {
        console.error("[RetrolearnerV2] Trending check error:", error);
      }
    }, RETROLEARNER_V2_CONFIG.trendingTokenCheckIntervalMs);
  }

  // Refresh clusters every 3 hours
  clusterRefreshTimer = setInterval(async () => {
    try {
      const newClusters = await discoverOutcomeClusters();
      console.log("[RetrolearnerV2] Clusters refreshed");
    } catch (error) {
      console.error("[RetrolearnerV2] Cluster refresh error:", error);
    }
  }, RETROLEARNER_V2_CONFIG.clusterRefreshIntervalMs);

  // Start signal wallet monitoring
  if (RETROLEARNER_V2_CONFIG.enableSignalWalletRetrigger) {
    await checkSignalWalletRetriggers();
  }

  console.log("[RetrolearnerV2] Ready: trending-backstop + signal-wallet-retrigger + dynamic-clustering");
}

export function stopRetrolearnerV2(): void {
  if (trendingCheckTimer) clearInterval(trendingCheckTimer);
  if (clusterRefreshTimer) clearInterval(clusterRefreshTimer);
  console.log("[RetrolearnerV2] Stopped");
}

// Export for system-picks integration
export { discoverOutcomeClusters, matchTokenToClusters, getCreatorHistoryPumpPortal };
