/**
 * Creator Clustering System
 *
 * Identifies when fresh wallets are actually the same creator
 * by analyzing on-chain launch patterns and behavior signatures.
 *
 * Problem: Many creators use new wallet per token launch
 * Solution: Cluster fresh wallets with identical patterns
 */

import axios from "axios";
import { db } from "./db";
import { eq, and } from "drizzle-orm";

export interface LaunchPattern {
  walletAddress: string;
  walletAge: number; // days
  tokenMint: string;
  launchTime: number; // unix timestamp
  initialLiquidity: number; // USD
  initialBuy: number; // SOL
  launchInterval: number; // seconds from previous token (if any)
  firstBuyer?: string;
  profitTakingPrice?: number; // If creator dumped, at what multiplier
}

export interface CreatorCluster {
  clusterId: string;
  walletAddresses: Set<string>;
  patterns: LaunchPattern[];
  commonCharacteristics: {
    launchIntervalAvg: number;
    liquidityAvg: number;
    initialBuyAvg: number;
    profitTakingMultiplier?: number;
  };
  successRate: number; // Tokens that reached 2x
  rugRate: number; // Tokens that were rugs
  totalLaunches: number;
  confidence: number; // How sure we are this is one creator
  discoveredAt: number;
}

const CREATOR_CLUSTERS = new Map<string, CreatorCluster>();
const WALLET_TO_CLUSTER = new Map<string, string>(); // walletAddress → clusterId

const CLUSTERING_CONFIG = {
  minWalletsToCluster: 3, // Need at least 3 wallets with same pattern
  patternSimilarityThreshold: 0.85, // 85% similar = same creator
  walletAgeThreshold: 7, // days (only consider fresh wallets)
  minConfidenceToApply: 0.75,
};

/**
 * Calculate pattern similarity between two launches (0-1)
 * Higher = more likely same creator
 */
function calculatePatternSimilarity(pattern1: LaunchPattern, pattern2: LaunchPattern): number {
  let similarityScore = 0;
  let weights = 0;

  // Liquidity similarity (±30% = match)
  const liquidityRatio = Math.min(pattern1.initialLiquidity, pattern2.initialLiquidity) /
    Math.max(pattern1.initialLiquidity, pattern2.initialLiquidity);
  if (liquidityRatio > 0.7) {
    similarityScore += 0.25 * liquidityRatio;
    weights += 0.25;
  }

  // Initial buy similarity (±30% = match)
  const buyRatio = Math.min(pattern1.initialBuy, pattern2.initialBuy) /
    Math.max(pattern1.initialBuy, pattern2.initialBuy);
  if (buyRatio > 0.7) {
    similarityScore += 0.25 * buyRatio;
    weights += 0.25;
  }

  // Launch interval similarity (if both have intervals)
  if (pattern1.launchInterval > 0 && pattern2.launchInterval > 0) {
    const intervalRatio = Math.min(pattern1.launchInterval, pattern2.launchInterval) /
      Math.max(pattern1.launchInterval, pattern2.launchInterval);
    if (intervalRatio > 0.8) {
      similarityScore += 0.25 * intervalRatio;
      weights += 0.25;
    }
  }

  // Profit taking pattern similarity
  if (pattern1.profitTakingPrice && pattern2.profitTakingPrice) {
    const tpRatio = Math.min(pattern1.profitTakingPrice, pattern2.profitTakingPrice) /
      Math.max(pattern1.profitTakingPrice, pattern2.profitTakingPrice);
    if (tpRatio > 0.9) {
      similarityScore += 0.25 * tpRatio;
      weights += 0.25;
    }
  }

  return weights > 0 ? similarityScore / weights : 0;
}

/**
 * Analyze wallet to extract launch pattern
 */
export async function analyzeWalletPattern(walletAddress: string): Promise<LaunchPattern | null> {
  try {
    // Get wallet creation time (via chain analysis)
    // For now: simplified - check if wallet is fresh
    const walletAge = await getWalletAge(walletAddress);

    if (walletAge > CLUSTERING_CONFIG.walletAgeThreshold) {
      return null; // Not a fresh wallet
    }

    // Get tokens created by this wallet
    const tokens = await getTokensCreatedByWallet(walletAddress);
    if (tokens.length === 0) {
      return null;
    }

    // Analyze first token
    const firstToken = tokens[0];

    return {
      walletAddress,
      walletAge,
      tokenMint: firstToken.mint,
      launchTime: firstToken.createdAt,
      initialLiquidity: firstToken.initialLiquidity,
      initialBuy: firstToken.initialBuyAmount,
      launchInterval: 0, // No previous token yet
      firstBuyer: firstToken.firstBuyerAddress,
      profitTakingPrice: await detectCreatorProfitTaking(firstToken.mint),
    };
  } catch (error) {
    console.error(`[CreatorClustering] Error analyzing wallet ${walletAddress.slice(0, 8)}...:`);
    return null;
  }
}

/**
 * Detect if creator took profits (dumped) and at what multiplier
 */
async function detectCreatorProfitTaking(tokenMint: string): Promise<number | undefined> {
  try {
    // Check if creator wallet made large sell transactions
    // For now: placeholder
    return undefined;
  } catch (error) {
    return undefined;
  }
}

/**
 * Find or create cluster for a fresh wallet
 */
export async function linkWalletToCluster(walletAddress: string): Promise<CreatorCluster | null> {
  // Check if already linked
  const existingClusterId = WALLET_TO_CLUSTER.get(walletAddress);
  if (existingClusterId) {
    return CREATOR_CLUSTERS.get(existingClusterId) || null;
  }

  // Analyze this wallet's pattern
  const newPattern = await analyzeWalletPattern(walletAddress);
  if (!newPattern) {
    return null; // Not a fresh wallet or no tokens
  }

  // Find similar patterns
  const allPatterns = Array.from(CREATOR_CLUSTERS.values())
    .flatMap((cluster) => cluster.patterns);

  const similarities = allPatterns.map((pattern) => ({
    clusterId: findClusterForPattern(pattern),
    pattern,
    similarity: calculatePatternSimilarity(newPattern, pattern),
  }));

  // Find best matching cluster
  const bestMatch = similarities
    .filter((s) => s.similarity >= CLUSTERING_CONFIG.patternSimilarityThreshold)
    .sort((a, b) => b.similarity - a.similarity)[0];

  if (bestMatch) {
    const cluster = CREATOR_CLUSTERS.get(bestMatch.clusterId);
    if (cluster) {
      // Add to existing cluster
      cluster.walletAddresses.add(walletAddress);
      cluster.patterns.push(newPattern);
      WALLET_TO_CLUSTER.set(walletAddress, bestMatch.clusterId);

      // Recalculate cluster stats
      updateClusterStats(cluster);

      console.log(
        `[CreatorClustering] Linked wallet ${walletAddress.slice(0, 8)}... to cluster ${bestMatch.clusterId} (similarity: ${(bestMatch.similarity * 100).toFixed(0)}%)`
      );

      return cluster;
    }
  }

  // No good match - if we have patterns, consider creating new cluster
  // But only if we have minimum wallets
  return null;
}

/**
 * Find cluster ID for a pattern
 */
function findClusterForPattern(pattern: LaunchPattern): string {
  for (const [clusterId, cluster] of CREATOR_CLUSTERS) {
    if (cluster.patterns.some((p) => p.walletAddress === pattern.walletAddress)) {
      return clusterId;
    }
  }
  return "";
}

/**
 * Recalculate cluster statistics
 */
function updateClusterStats(cluster: CreatorCluster): void {
  const patterns = cluster.patterns;

  // Average launch interval
  const intervals = patterns
    .filter((p) => p.launchInterval > 0)
    .map((p) => p.launchInterval);
  cluster.commonCharacteristics.launchIntervalAvg =
    intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;

  // Average liquidity
  cluster.commonCharacteristics.liquidityAvg =
    patterns.reduce((sum, p) => sum + p.initialLiquidity, 0) / patterns.length;

  // Average initial buy
  cluster.commonCharacteristics.initialBuyAvg = patterns.reduce((sum, p) => sum + p.initialBuy, 0) / patterns.length;

  // Profit taking pattern
  const tpPrices = patterns.filter((p) => p.profitTakingPrice).map((p) => p.profitTakingPrice!);
  if (tpPrices.length > 0) {
    cluster.commonCharacteristics.profitTakingMultiplier = tpPrices.reduce((a, b) => a + b, 0) / tpPrices.length;
  }

  // Update confidence based on cluster size
  cluster.confidence = Math.min(1.0, cluster.walletAddresses.size / (CLUSTERING_CONFIG.minWalletsToCluster * 2));

  cluster.totalLaunches = patterns.length;
}

/**
 * Attempt to cluster fresh wallets periodically
 * Called every hour to detect new creator clusters
 */
export async function runCreatorClusteringMaintenance(): Promise<void> {
  console.log("[CreatorClustering] Running clustering maintenance");

  // Get all recent fresh wallets
  const freshWallets = await findRecentFreshWallets();

  for (const wallet of freshWallets) {
    try {
      await linkWalletToCluster(wallet);
    } catch (error) {
      console.error(`[CreatorClustering] Error clustering ${wallet.slice(0, 8)}...:`);
    }
  }

  // Log clustering statistics
  const stats = {
    totalClusters: CREATOR_CLUSTERS.size,
    totalWalletsInClusters: Array.from(WALLET_TO_CLUSTER.keys()).length,
    averageClusterSize: Array.from(CREATOR_CLUSTERS.values()).length > 0
      ? Array.from(CREATOR_CLUSTERS.values()).reduce((sum, c) => sum + c.walletAddresses.size, 0) /
      CREATOR_CLUSTERS.size
      : 0,
  };

  console.log("[CreatorClustering] Maintenance complete:", stats);
}

/**
 * Get all clusters (for debugging)
 */
export function getAllClusters(): CreatorCluster[] {
  return Array.from(CREATOR_CLUSTERS.values());
}

/**
 * Get cluster for wallet (if linked)
 */
export function getWalletCluster(walletAddress: string): CreatorCluster | null {
  const clusterId = WALLET_TO_CLUSTER.get(walletAddress);
  return clusterId ? CREATOR_CLUSTERS.get(clusterId) || null : null;
}

/**
 * Placeholder: Get wallet age in days
 */
async function getWalletAge(walletAddress: string): Promise<number> {
  // In production: Query blockchain for wallet creation time
  // For now: Return high value to filter only fresh wallets
  return 999;
}

/**
 * Placeholder: Get tokens created by wallet
 */
async function getTokensCreatedByWallet(walletAddress: string): Promise<any[]> {
  try {
    // Query pump.fun API for tokens created by this wallet
    const response = await axios.get(`https://frontend-api.pump.fun/creator/${walletAddress}/tokens`, {
      timeout: 5000,
    });

    return response.data?.tokens || [];
  } catch (error) {
    return [];
  }
}

/**
 * Placeholder: Find recent fresh wallets
 */
async function findRecentFreshWallets(): Promise<string[]> {
  // Query blockchain for wallets created in last 24 hours
  // For now: Return empty (would integrate with RPC)
  return [];
}

export default {
  analyzeWalletPattern,
  linkWalletToCluster,
  runCreatorClusteringMaintenance,
  getAllClusters,
  getWalletCluster,
};
