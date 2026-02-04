import { db } from "./db";
import { eq, and, desc, gte, inArray } from "drizzle-orm";
import { swaps } from "@shared/schema";

interface WalletCluster {
  id: string;
  members: string[];
  tokenOverlap: string[];
  timingCorrelation: number;
  detectedVia: 'timing' | 'behavior' | 'funding';
  firstSeen: number;
  lastSeen: number;
  successRate?: number;
}

interface ClusterCandidate {
  wallets: string[];
  token: string;
  timestamps: number[];
}

const TIMING_WINDOW_SECONDS = 900;
const MIN_CLUSTER_SIZE = 3;
const MIN_TOKEN_OVERLAP = 3;
const CLUSTER_CACHE: Map<string, WalletCluster> = new Map();

export async function detectTimingClusters(
  tokenAddress: string,
  lookbackHours: number = 24
): Promise<ClusterCandidate[]> {
  const cutoff = Math.floor(Date.now() / 1000) - (lookbackHours * 3600);

  const tokenSwaps = await db.query.swaps.findMany({
    where: and(
      eq(swaps.toToken, tokenAddress),
      gte(swaps.timestamp, cutoff),
      eq(swaps.type, 'buy')
    ),
    orderBy: [desc(swaps.timestamp)],
  });

  if (tokenSwaps.length < MIN_CLUSTER_SIZE) {
    return [];
  }

  const clusters: ClusterCandidate[] = [];
  const processed = new Set<number>();

  for (let i = 0; i < tokenSwaps.length; i++) {
    if (processed.has(i)) continue;

    const anchor = tokenSwaps[i];
    const anchorTime = anchor.timestamp;
    const clusterWallets: string[] = [anchor.source];
    const clusterTimestamps: number[] = [anchorTime];

    for (let j = i + 1; j < tokenSwaps.length; j++) {
      if (processed.has(j)) continue;

      const swap = tokenSwaps[j];
      if (Math.abs(swap.timestamp - anchorTime) <= TIMING_WINDOW_SECONDS) {
        if (!clusterWallets.includes(swap.source)) {
          clusterWallets.push(swap.source);
          clusterTimestamps.push(swap.timestamp);
          processed.add(j);
        }
      }
    }

    if (clusterWallets.length >= MIN_CLUSTER_SIZE) {
      clusters.push({
        wallets: clusterWallets,
        token: tokenAddress,
        timestamps: clusterTimestamps,
      });
    }

    processed.add(i);
  }

  return clusters;
}

export async function findBehavioralClusters(
  lookbackDays: number = 7
): Promise<WalletCluster[]> {
  const cutoff = Math.floor(Date.now() / 1000) - (lookbackDays * 86400);

  const recentSwaps = await db.query.swaps.findMany({
    where: and(
      gte(swaps.timestamp, cutoff),
      eq(swaps.type, 'buy')
    ),
  });

  const walletTokens: Map<string, Set<string>> = new Map();
  const walletTimings: Map<string, number[]> = new Map();

  for (const swap of recentSwaps) {
    const wallet = swap.source;
    const token = swap.toToken;

    if (!walletTokens.has(wallet)) {
      walletTokens.set(wallet, new Set());
      walletTimings.set(wallet, []);
    }
    walletTokens.get(wallet)!.add(token);
    walletTimings.get(wallet)!.push(swap.timestamp);
  }

  const walletAddresses = Array.from(walletTokens.keys());
  const clusters: WalletCluster[] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < walletAddresses.length; i++) {
    const walletA = walletAddresses[i];
    if (assigned.has(walletA)) continue;

    const tokensA = walletTokens.get(walletA)!;
    const tokensAArray = Array.from(tokensA);
    const clusterMembers: string[] = [walletA];
    const sharedTokens: Set<string> = new Set(tokensAArray);

    for (let j = i + 1; j < walletAddresses.length; j++) {
      const walletB = walletAddresses[j];
      if (assigned.has(walletB)) continue;

      const tokensB = walletTokens.get(walletB)!;
      const overlap: string[] = [];
      tokensAArray.forEach(t => {
        if (tokensB.has(t)) overlap.push(t);
      });

      if (overlap.length >= MIN_TOKEN_OVERLAP) {
        const timingsA = walletTimings.get(walletA)!;
        const timingsB = walletTimings.get(walletB)!;
        const correlation = calculateTimingCorrelation(timingsA, timingsB);

        if (correlation > 0.5) {
          clusterMembers.push(walletB);
          overlap.forEach(t => sharedTokens.add(t));
          assigned.add(walletB);
        }
      }
    }

    if (clusterMembers.length >= MIN_CLUSTER_SIZE) {
      const now = Math.floor(Date.now() / 1000);
      const cluster: WalletCluster = {
        id: `cluster_${now}_${i}`,
        members: clusterMembers,
        tokenOverlap: Array.from(sharedTokens),
        timingCorrelation: 0.7,
        detectedVia: 'behavior',
        firstSeen: now,
        lastSeen: now,
      };

      clusters.push(cluster);
      assigned.add(walletA);
    }
  }

  return clusters;
}

function calculateTimingCorrelation(timingsA: number[], timingsB: number[]): number {
  if (timingsA.length === 0 || timingsB.length === 0) return 0;

  let matches = 0;
  const windowSeconds = TIMING_WINDOW_SECONDS;

  for (const tA of timingsA) {
    for (const tB of timingsB) {
      if (Math.abs(tA - tB) <= windowSeconds) {
        matches++;
        break;
      }
    }
  }

  const maxPossible = Math.min(timingsA.length, timingsB.length);
  return maxPossible > 0 ? matches / maxPossible : 0;
}

export async function getClusterForWallet(walletAddress: string): Promise<WalletCluster | null> {
  const entries = Array.from(CLUSTER_CACHE.values());
  for (const cluster of entries) {
    if (cluster.members.includes(walletAddress)) {
      return cluster;
    }
  }
  return null;
}

export async function analyzeClusterSuccess(cluster: WalletCluster): Promise<number> {
  if (cluster.tokenOverlap.length === 0) return 0;

  let wins = 0;
  let total = 0;

  for (const tokenAddress of cluster.tokenOverlap) {
    const buys = await db.query.swaps.findMany({
      where: and(
        eq(swaps.toToken, tokenAddress),
        eq(swaps.type, 'buy'),
        inArray(swaps.source, cluster.members)
      ),
      orderBy: [desc(swaps.timestamp)],
      limit: 10,
    });

    const sells = await db.query.swaps.findMany({
      where: and(
        eq(swaps.fromToken, tokenAddress),
        eq(swaps.type, 'sell'),
        inArray(swaps.source, cluster.members)
      ),
      orderBy: [desc(swaps.timestamp)],
      limit: 10,
    });

    if (buys.length > 0 && sells.length > 0) {
      const avgBuyAmount = buys.reduce((sum, s) => sum + s.fromAmount, 0) / buys.length;
      const avgSellAmount = sells.reduce((sum, s) => sum + s.toAmount, 0) / sells.length;

      if (avgSellAmount > avgBuyAmount) {
        wins++;
      }
      total++;
    }
  }

  return total > 0 ? wins / total : 0;
}

export async function detectCoordinatedBuying(
  tokenAddress: string,
  windowMinutes: number = 15
): Promise<{
  isCoordinated: boolean;
  clusterSize: number;
  wallets: string[];
  confidence: number;
}> {
  const windowSeconds = windowMinutes * 60;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;

  const recentBuys = await db.query.swaps.findMany({
    where: and(
      eq(swaps.toToken, tokenAddress),
      eq(swaps.type, 'buy'),
      gte(swaps.timestamp, cutoff)
    ),
  });

  const uniqueWallets = Array.from(new Set(recentBuys.map(s => s.source)));

  const isCoordinated = uniqueWallets.length >= MIN_CLUSTER_SIZE;
  const confidence = Math.min(uniqueWallets.length / 10, 1);

  return {
    isCoordinated,
    clusterSize: uniqueWallets.length,
    wallets: uniqueWallets,
    confidence,
  };
}

export async function refreshClusterCache(): Promise<void> {
  const clusters = await findBehavioralClusters(7);

  CLUSTER_CACHE.clear();
  for (const cluster of clusters) {
    const successRate = await analyzeClusterSuccess(cluster);
    cluster.successRate = successRate;
    CLUSTER_CACHE.set(cluster.id, cluster);
  }
}

export function getCachedClusters(): WalletCluster[] {
  return Array.from(CLUSTER_CACHE.values());
}

export async function getClusterStats(): Promise<{
  totalClusters: number;
  totalWalletsInClusters: number;
  avgClusterSize: number;
  avgSuccessRate: number;
}> {
  const clusters = getCachedClusters();

  if (clusters.length === 0) {
    return {
      totalClusters: 0,
      totalWalletsInClusters: 0,
      avgClusterSize: 0,
      avgSuccessRate: 0,
    };
  }

  const totalWallets = clusters.reduce((sum, c) => sum + c.members.length, 0);
  const avgSize = totalWallets / clusters.length;
  const avgSuccess = clusters.reduce((sum, c) => sum + (c.successRate || 0), 0) / clusters.length;

  return {
    totalClusters: clusters.length,
    totalWalletsInClusters: totalWallets,
    avgClusterSize: avgSize,
    avgSuccessRate: avgSuccess,
  };
}

// =====================
// CLUSTER MERGE/DIVERGE WITH AI DECISIONS
// =====================

interface MergeProposal {
  clusterId1: string;
  clusterId2: string;
  sharedWallets: string[];
  overlapPercent: number;
  confidence: number;
  reason: string;
}

interface DivergeProposal {
  clusterId: string;
  subgroups: string[][];
  divergenceScore: number;
  reason: string;
}

export function detectClusterOverlap(
  cluster1: WalletCluster,
  cluster2: WalletCluster
): MergeProposal | null {
  const sharedWallets = cluster1.members.filter(w => cluster2.members.includes(w));
  
  if (sharedWallets.length === 0) return null;
  
  const overlapPercent = sharedWallets.length / Math.min(cluster1.members.length, cluster2.members.length);
  
  if (overlapPercent < 0.3) return null;
  
  const tokenOverlap = cluster1.tokenOverlap.filter(t => cluster2.tokenOverlap.includes(t));
  
  return {
    clusterId1: cluster1.id,
    clusterId2: cluster2.id,
    sharedWallets,
    overlapPercent,
    confidence: overlapPercent * 0.6 + (tokenOverlap.length / 10) * 0.4,
    reason: `${sharedWallets.length} shared wallets (${(overlapPercent * 100).toFixed(0)}%), ${tokenOverlap.length} shared tokens`,
  };
}

export async function detectDivergence(cluster: WalletCluster): Promise<DivergeProposal | null> {
  if (cluster.members.length < 6) return null;
  
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 7 * 24 * 3600;
  
  const activityByWallet: Record<string, { tokens: string[]; avgTime: number; count: number }> = {};
  
  for (const wallet of cluster.members) {
    const recentSwaps = await db.query.swaps.findMany({
      where: and(
        eq(swaps.source, wallet),
        gte(swaps.timestamp, cutoff)
      ),
    });
    
    const tokens = Array.from(new Set(recentSwaps.map(s => s.toToken)));
    const avgTime = recentSwaps.length > 0 
      ? recentSwaps.reduce((sum, s) => sum + s.timestamp, 0) / recentSwaps.length 
      : 0;
    
    activityByWallet[wallet] = { tokens, avgTime, count: recentSwaps.length };
  }
  
  const activeWallets = Object.entries(activityByWallet).filter(([_, a]) => a.count > 0);
  const inactiveWallets = Object.entries(activityByWallet).filter(([_, a]) => a.count === 0);
  
  if (inactiveWallets.length >= cluster.members.length * 0.4) {
    return {
      clusterId: cluster.id,
      subgroups: [
        activeWallets.map(([w]) => w),
        inactiveWallets.map(([w]) => w),
      ],
      divergenceScore: inactiveWallets.length / cluster.members.length,
      reason: `${inactiveWallets.length} wallets inactive (${(inactiveWallets.length / cluster.members.length * 100).toFixed(0)}%)`,
    };
  }
  
  return null;
}

export function mergeClusters(
  cluster1: WalletCluster,
  cluster2: WalletCluster
): WalletCluster {
  const mergedMembers = Array.from(new Set([...cluster1.members, ...cluster2.members]));
  const mergedTokens = Array.from(new Set([...cluster1.tokenOverlap, ...cluster2.tokenOverlap]));
  
  const avgSuccessRate = (
    ((cluster1.successRate || 0) * cluster1.members.length) +
    ((cluster2.successRate || 0) * cluster2.members.length)
  ) / (cluster1.members.length + cluster2.members.length);
  
  const merged: WalletCluster = {
    id: `merged_${cluster1.id}_${cluster2.id}`,
    members: mergedMembers,
    tokenOverlap: mergedTokens,
    timingCorrelation: (cluster1.timingCorrelation + cluster2.timingCorrelation) / 2,
    detectedVia: cluster1.detectedVia,
    firstSeen: Math.min(cluster1.firstSeen, cluster2.firstSeen),
    lastSeen: Math.max(cluster1.lastSeen, cluster2.lastSeen),
    successRate: avgSuccessRate,
  };
  
  CLUSTER_CACHE.delete(cluster1.id);
  CLUSTER_CACHE.delete(cluster2.id);
  CLUSTER_CACHE.set(merged.id, merged);
  
  console.log(`[Cluster] Merged ${cluster1.id} + ${cluster2.id} → ${merged.id} (${merged.members.length} wallets)`);
  
  return merged;
}

export function divergeCluster(
  cluster: WalletCluster,
  subgroups: string[][]
): WalletCluster[] {
  CLUSTER_CACHE.delete(cluster.id);
  
  const newClusters: WalletCluster[] = [];
  
  for (let i = 0; i < subgroups.length; i++) {
    const members = subgroups[i];
    if (members.length < MIN_CLUSTER_SIZE) continue;
    
    const subCluster: WalletCluster = {
      id: `${cluster.id}_sub${i + 1}`,
      members,
      tokenOverlap: cluster.tokenOverlap,
      timingCorrelation: cluster.timingCorrelation,
      detectedVia: cluster.detectedVia,
      firstSeen: cluster.firstSeen,
      lastSeen: Math.floor(Date.now() / 1000),
      successRate: cluster.successRate,
    };
    
    CLUSTER_CACHE.set(subCluster.id, subCluster);
    newClusters.push(subCluster);
  }
  
  console.log(`[Cluster] Diverged ${cluster.id} → ${newClusters.length} sub-clusters`);
  
  return newClusters;
}

export async function runClusterMaintenance(): Promise<{
  merged: number;
  diverged: number;
  proposals: { merges: MergeProposal[]; diverges: DivergeProposal[] };
}> {
  const clusters = getCachedClusters();
  const mergeProposals: MergeProposal[] = [];
  const divergeProposals: DivergeProposal[] = [];
  
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const proposal = detectClusterOverlap(clusters[i], clusters[j]);
      if (proposal && proposal.confidence > 0.5) {
        mergeProposals.push(proposal);
      }
    }
  }
  
  for (const cluster of clusters) {
    const proposal = await detectDivergence(cluster);
    if (proposal && proposal.divergenceScore > 0.4) {
      divergeProposals.push(proposal);
    }
  }
  
  let merged = 0;
  for (const proposal of mergeProposals.filter(p => p.confidence > 0.7)) {
    const c1 = CLUSTER_CACHE.get(proposal.clusterId1);
    const c2 = CLUSTER_CACHE.get(proposal.clusterId2);
    if (c1 && c2) {
      mergeClusters(c1, c2);
      merged++;
    }
  }
  
  let diverged = 0;
  for (const proposal of divergeProposals.filter(p => p.divergenceScore > 0.6)) {
    const cluster = CLUSTER_CACHE.get(proposal.clusterId);
    if (cluster) {
      divergeCluster(cluster, proposal.subgroups);
      diverged++;
    }
  }
  
  return {
    merged,
    diverged,
    proposals: {
      merges: mergeProposals,
      diverges: divergeProposals,
    },
  };
}
