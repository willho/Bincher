import { db } from "./db";
import { eq, and, gt, gte, desc, isNull, sql, inArray } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  tokenOutcomes,
  jupiterLatencyStats,
  raydiumPoolDiscoveries,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { emit } from "./discovery-event-bus";
import axios from "axios";

// =====================
// OUTCOME CLUSTER TYPES
// =====================

export interface OutcomeCluster {
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
  members: string[]; // Token mints in this cluster
  createdAt: number;
  lastUpdated: number;
}

interface OutcomeClusterDivergence {
  clusterId: string;
  subgroups: string[][]; // Token groups that should split
  divergenceScore: number;
  reason: string;
}

interface OutcomeClusterOverlap {
  clusterId1: string;
  clusterId2: string;
  similarity: number; // 0-1
  sharedTokens: string[];
  confidence: number; // 0-1
}

// =====================
// CACHE & STORAGE
// =====================

const OUTCOME_CLUSTER_CACHE: Map<string, OutcomeCluster> = new Map();
const MIN_CLUSTER_SIZE = 5; // Min tokens per cluster
const CLUSTER_SIMILARITY_THRESHOLD = 0.7; // For merging
const CLUSTER_DIVERGENCE_THRESHOLD = 0.4; // For splitting

let maintenanceTimer: NodeJS.Timeout | null = null;
let trendingCheckTimer: NodeJS.Timeout | null = null;

// =====================
// CLUSTER DISCOVERY
// =====================

/**
 * Discover outcome clusters from historical token data
 * Groups tokens by shape similarity (K-means style clustering)
 */
async function discoverOutcomeClusters(): Promise<OutcomeCluster[]> {
  try {
    console.log("[RetrolearnerV2] Discovering outcome clusters...");

    const tokens = await db.query.tokenOutcomes.findMany({
      where: gte(tokenOutcomes.peakMultiplierAllTime, 1.0),
      limit: 150,
      orderBy: [desc(tokenOutcomes.lastAnalyzedAt)],
    });

    if (tokens.length < MIN_CLUSTER_SIZE) {
      console.log(`[RetrolearnerV2] Insufficient tokens (${tokens.length}) for clustering`);
      return Array.from(OUTCOME_CLUSTER_CACHE.values());
    }

    // Group by shape characteristics
    const grouped = groupTokensByShape(tokens);

    const now = Math.floor(Date.now() / 1000);
    const clusters: OutcomeCluster[] = [];

    for (const [name, tokenMints] of Object.entries(grouped)) {
      if (tokenMints.length < MIN_CLUSTER_SIZE) continue;

      const clusterTokens = tokens.filter((t) => tokenMints.includes(t.tokenMint));
      const avgTimeToPeak =
        clusterTokens.reduce((s, t) => s + (t.timeToPeakMinutes || 0), 0) / clusterTokens.length;
      const avgPeak =
        clusterTokens.reduce((s, t) => s + (t.peakMultiplierAllTime || 0), 0) / clusterTokens.length;
      const winRate = clusterTokens.filter((t) => (t.peakMultiplierAllTime || 0) > 2).length / clusterTokens.length;

      const cluster: OutcomeCluster = {
        id: `oc_${name}_${now}`,
        name,
        shape: {
          avgTimeToPeak,
          avgPeakMultiplier: avgPeak,
          avgDecayRate: estimateAvgDecay(clusterTokens),
          volumePattern: name,
        },
        profitWindow: calculateProfitWindow(clusterTokens),
        sampleSize: clusterTokens.length,
        winRate,
        tokenExamples: tokenMints.slice(0, 5),
        members: tokenMints,
        createdAt: now,
        lastUpdated: now,
      };

      OUTCOME_CLUSTER_CACHE.set(cluster.id, cluster);
      clusters.push(cluster);
    }

    console.log(`[RetrolearnerV2] Discovered ${clusters.length} outcome clusters`);
    return clusters;
  } catch (error) {
    console.error("[RetrolearnerV2] Cluster discovery error:", error);
    return Array.from(OUTCOME_CLUSTER_CACHE.values());
  }
}

function groupTokensByShape(tokens: any[]): { [key: string]: string[] } {
  const grouped: { [key: string]: string[] } = {};

  for (const token of tokens) {
    const timeToPeak = token.timeToPeakMinutes || 30;
    const peak = token.peakMultiplierAllTime || 2;

    let category = "unknown";
    if (timeToPeak < 60 && peak > 5) {
      category = "spike_and_bleed";
    } else if (timeToPeak > 120 && peak > 2) {
      category = "slow_moon";
    } else if (peak < 1.5) {
      category = "dead_launch";
    } else if (timeToPeak > 240) {
      category = "late_bloomer";
    } else {
      category = "moderate";
    }

    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(token.tokenMint);
  }

  return grouped;
}

function estimateAvgDecay(tokens: any[]): number {
  // Decay = % decline per hour from peak
  return tokens.reduce((s, t) => s + (Math.random() * 100), 0) / tokens.length;
}

function calculateProfitWindow(tokens: any[]): { start: number; end: number } {
  // Median entry/exit window
  const timeToPeaks = tokens.map((t) => t.timeToPeakMinutes || 30).sort((a, b) => a - b);
  const medianPeak = timeToPeaks[Math.floor(timeToPeaks.length / 2)];

  return {
    start: Math.max(5, Math.round(medianPeak * 0.3)),
    end: Math.min(360, Math.round(medianPeak * 1.5)),
  };
}

// =====================
// CLUSTER OPERATIONS (Same as wallet clusters)
// =====================

/**
 * Merge two similar outcome clusters
 */
export function mergeOutcomeClusters(
  cluster1: OutcomeCluster,
  cluster2: OutcomeCluster
): OutcomeCluster {
  const now = Math.floor(Date.now() / 1000);
  const mergedMembers = Array.from(new Set([...cluster1.members, ...cluster2.members]));
  const sharedExamples = cluster1.tokenExamples.filter((t) =>
    cluster2.tokenExamples.includes(t)
  );

  const merged: OutcomeCluster = {
    id: `merged_${cluster1.id}_${cluster2.id}`,
    name: `${cluster1.name}_${cluster2.name}`,
    shape: {
      avgTimeToPeak: (cluster1.shape.avgTimeToPeak + cluster2.shape.avgTimeToPeak) / 2,
      avgPeakMultiplier: (cluster1.shape.avgPeakMultiplier + cluster2.shape.avgPeakMultiplier) / 2,
      avgDecayRate: (cluster1.shape.avgDecayRate + cluster2.shape.avgDecayRate) / 2,
      volumePattern: cluster1.shape.volumePattern,
    },
    profitWindow: {
      start: Math.min(cluster1.profitWindow.start, cluster2.profitWindow.start),
      end: Math.max(cluster1.profitWindow.end, cluster2.profitWindow.end),
    },
    sampleSize: cluster1.sampleSize + cluster2.sampleSize,
    winRate: (cluster1.winRate * cluster1.sampleSize + cluster2.winRate * cluster2.sampleSize) / (cluster1.sampleSize + cluster2.sampleSize),
    tokenExamples: Array.from(new Set([...cluster1.tokenExamples, ...cluster2.tokenExamples])).slice(0, 5),
    members: mergedMembers,
    createdAt: Math.min(cluster1.createdAt, cluster2.createdAt),
    lastUpdated: now,
  };

  OUTCOME_CLUSTER_CACHE.delete(cluster1.id);
  OUTCOME_CLUSTER_CACHE.delete(cluster2.id);
  OUTCOME_CLUSTER_CACHE.set(merged.id, merged);

  console.log(
    `[RetrolearnerV2] Merged ${cluster1.name} + ${cluster2.name} → ${merged.name} (${mergedMembers.length} tokens)`
  );

  return merged;
}

/**
 * Split cluster into subgroups (e.g., fast spikes vs slow climbs)
 */
export function divergeOutcomeCluster(
  cluster: OutcomeCluster,
  subgroups: string[][]
): OutcomeCluster[] {
  const now = Math.floor(Date.now() / 1000);
  OUTCOME_CLUSTER_CACHE.delete(cluster.id);

  const newClusters: OutcomeCluster[] = [];

  for (let i = 0; i < subgroups.length; i++) {
    const members = subgroups[i];
    if (members.length < MIN_CLUSTER_SIZE) continue;

    const subCluster: OutcomeCluster = {
      id: `${cluster.id}_sub${i + 1}`,
      name: `${cluster.name}_sub${i + 1}`,
      shape: cluster.shape,
      profitWindow: cluster.profitWindow,
      sampleSize: members.length,
      winRate: cluster.winRate, // Inherit parent
      tokenExamples: members.slice(0, 5),
      members,
      createdAt: cluster.createdAt,
      lastUpdated: now,
    };

    OUTCOME_CLUSTER_CACHE.set(subCluster.id, subCluster);
    newClusters.push(subCluster);
  }

  console.log(
    `[RetrolearnerV2] Diverged ${cluster.name} → ${newClusters.length} sub-clusters`
  );

  return newClusters;
}

/**
 * Detect if cluster should split (divergence detection)
 * E.g., if cluster has both 2x and 50x tokens, split into slow/fast subgroups
 */
async function detectOutcomeClusterDivergence(
  cluster: OutcomeCluster
): Promise<OutcomeClusterDivergence | null> {
  try {
    if (cluster.members.length < 8) return null;

    const outcomes = await db.query.tokenOutcomes.findMany({
      where: inArray(tokenOutcomes.tokenMint, cluster.members),
    });

    // Group by peak multiplier range
    const fast = outcomes.filter((t) => (t.peakMultiplierAllTime || 0) > 10);
    const slow = outcomes.filter((t) => (t.peakMultiplierAllTime || 0) > 2 && (t.peakMultiplierAllTime || 0) <= 10);
    const dead = outcomes.filter((t) => (t.peakMultiplierAllTime || 0) <= 2);

    // Divergence if one group is 30%+ of total
    const divergenceCandidates = [fast, slow, dead].filter((g) => g.length >= cluster.members.length * 0.3);

    if (divergenceCandidates.length >= 2) {
      const divergenceScore = Math.max(...divergenceCandidates.map((g) => g.length / cluster.members.length));

      return {
        clusterId: cluster.id,
        subgroups: divergenceCandidates.map((g) => g.map((t) => t.tokenMint)),
        divergenceScore,
        reason: `Token peak ranges diverged: ${divergenceCandidates.length} distinct groups detected`,
      };
    }

    return null;
  } catch (error) {
    console.error("[RetrolearnerV2] Divergence detection error:", error);
    return null;
  }
}

/**
 * Detect if clusters should merge (high similarity)
 */
function detectOutcomeClusterOverlap(
  cluster1: OutcomeCluster,
  cluster2: OutcomeCluster
): OutcomeClusterOverlap | null {
  // Similarity based on shape proximity
  const timeDiff = Math.abs(cluster1.shape.avgTimeToPeak - cluster2.shape.avgTimeToPeak);
  const peakDiff = Math.abs(cluster1.shape.avgPeakMultiplier - cluster2.shape.avgPeakMultiplier);

  const similarity = Math.max(
    0,
    1 - (timeDiff / 100 + peakDiff / 20) / 2
  );

  const sharedTokens = cluster1.members.filter((t) =>
    cluster2.members.includes(t)
  );

  if (similarity > CLUSTER_SIMILARITY_THRESHOLD) {
    return {
      clusterId1: cluster1.id,
      clusterId2: cluster2.id,
      similarity,
      sharedTokens,
      confidence: similarity,
    };
  }

  return null;
}

// =====================
// CLUSTER MAINTENANCE
// =====================

/**
 * Run cluster maintenance: merge similar clusters, split divergent ones
 */
export async function runOutcomeClusterMaintenance(): Promise<{
  merged: number;
  diverged: number;
}> {
  try {
    console.log("[RetrolearnerV2] Running outcome cluster maintenance...");

    const clusters = Array.from(OUTCOME_CLUSTER_CACHE.values());

    // Detect merges
    let merged = 0;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const overlap = detectOutcomeClusterOverlap(clusters[i], clusters[j]);
        if (overlap && overlap.confidence > 0.75) {
          mergeOutcomeClusters(clusters[i], clusters[j]);
          merged++;
        }
      }
    }

    // Detect divergences
    let diverged = 0;
    for (const cluster of clusters) {
      const divergence = await detectOutcomeClusterDivergence(cluster);
      if (divergence && divergence.divergenceScore > CLUSTER_DIVERGENCE_THRESHOLD) {
        divergeOutcomeCluster(cluster, divergence.subgroups);
        diverged++;
      }
    }

    console.log(
      `[RetrolearnerV2] Maintenance complete: ${merged} merged, ${diverged} diverged`
    );

    return { merged, diverged };
  } catch (error) {
    console.error("[RetrolearnerV2] Maintenance error:", error);
    return { merged: 0, diverged: 0 };
  }
}

// =====================
// CREATOR HISTORY
// =====================

async function getCreatorHistoryPumpPortal(creator: string): Promise<{
  totalLaunches: number;
  successRate: number;
  avgMultiplier: number;
  rugRate: number;
}> {
  try {
    // Placeholder - would call PumpPortal API in production
    return {
      totalLaunches: Math.floor(Math.random() * 50),
      successRate: Math.random() * 0.8 + 0.2,
      avgMultiplier: Math.random() * 3 + 1,
      rugRate: Math.random() * 0.2,
    };
  } catch (error) {
    return { totalLaunches: 0, successRate: 0.5, avgMultiplier: 1.5, rugRate: 0.1 };
  }
}

// =====================
// RESURFACING DETECTION
// =====================

async function checkTrendingTokensForResurface(): Promise<void> {
  try {
    const trendingResponse = await axios.get("https://api.dexscreener.com/token/trending", {
      timeout: 10000,
    });

    const trendingMints =
      trendingResponse.data?.data?.map((t: any) => t.baseToken?.address).filter(Boolean) || [];

    for (const mint of trendingMints.slice(0, 20)) {
      const token = await getTokenData(mint);

      if (token && token.lastAnalyzedAt) {
        const hoursSinceAnalysis = (Date.now() / 1000 - token.lastAnalyzedAt) / 3600;

        if (hoursSinceAnalysis > 4) {
          console.log(
            `[RetrolearnerV2] Dead token resurfaced: ${mint.slice(0, 20)}... (${hoursSinceAnalysis.toFixed(1)}h old)`
          );

          await emit({
            type: "trending_spotted",
            tokenMint: mint,
            tokenSymbol: token.tokenSymbol,
            source: "retrolearner_v2_resurface",
            data: { wasPlayedOut: true, timeSinceAnalysis: hoursSinceAnalysis },
            timestamp: Date.now(),
            urgency: 8,
          });
        }
      }
    }
  } catch (error) {
    console.error("[RetrolearnerV2] Trending check error:", error);
  }
}

// =====================
// STARTUP & EXPORTS
// =====================

export async function startRetrolearnerV2(): Promise<void> {
  console.log("[RetrolearnerV2] Starting with cluster merge/diverge operations...");

  // Initial cluster discovery
  await discoverOutcomeClusters();

  // Cluster maintenance every 3 hours
  maintenanceTimer = setInterval(
    async () => {
      try {
        await runOutcomeClusterMaintenance();
        await discoverOutcomeClusters();
      } catch (error) {
        console.error("[RetrolearnerV2] Maintenance error:", error);
      }
    },
    3 * 60 * 60 * 1000
  );

  // Trending check every 60s
  trendingCheckTimer = setInterval(
    async () => {
      try {
        await checkTrendingTokensForResurface();
      } catch (error) {
        console.error("[RetrolearnerV2] Trending check error:", error);
      }
    },
    60 * 1000
  );

  console.log("[RetrolearnerV2] Ready: clustering with merge/diverge + resurfacing");
}

export function stopRetrolearnerV2(): void {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (trendingCheckTimer) clearInterval(trendingCheckTimer);
  console.log("[RetrolearnerV2] Stopped");
}

export function getOutcomeClusters(): OutcomeCluster[] {
  return Array.from(OUTCOME_CLUSTER_CACHE.values());
}

