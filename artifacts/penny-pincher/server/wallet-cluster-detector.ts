import { db } from "./db";
import { walletClusters } from "../shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * Wallet Cluster Detector
 *
 * Identifies coordinated buyer groups (clusters) trading the same tokens.
 * Analyzes:
 * - Entry timing clusters (multiple wallets entering at similar times)
 * - Entry price clusters (multiple wallets entering at same price)
 * - Coordination patterns (likely insider/coordinated groups)
 *
 * Used to identify tokens with coordinated whale activity or insider trading.
 */

export interface TradeEvent {
  walletAddress: string;
  tokenMint: string;
  timestamp: number;
  entryPrice: number;
  amount: number;
}

export interface ClusterAnalysisResult {
  clusterId: string;
  tokenMint: string;
  walletCount: number;
  walletAddresses: string[];
  entryTimeCluster: boolean;
  entryPriceCluster: boolean;
  coordinationScore: number;
  isLikelyInsider: boolean;
  analysis: string;
}

export class WalletClusterDetector {
  // Configuration thresholds
  private readonly TIME_WINDOW_SECONDS = 300; // 5-minute window for entry time clustering
  private readonly PRICE_DEVIATION_PERCENT = 2; // 2% price deviation for entry price clustering
  private readonly MIN_CLUSTER_SIZE = 3; // Minimum wallets to form a cluster
  private readonly COORDINATION_THRESHOLD = 0.7; // 70%+ probability of coordination

  /**
   * Analyze trades for a token and detect buyer clusters
   */
  async detectClusters(
    tokenMint: string,
    recentTrades: TradeEvent[]
  ): Promise<ClusterAnalysisResult[]> {
    try {
      // Group trades by entry time window
      const timeClusters = this.groupByEntryTime(recentTrades);

      const results: ClusterAnalysisResult[] = [];

      for (const [timeWindow, trades] of timeClusters.entries()) {
        if (trades.length < this.MIN_CLUSTER_SIZE) continue;

        // Check for price clustering within time window
        const priceClusters = this.groupByEntryPrice(trades);

        for (const [pricePoint, pricedTrades] of priceClusters.entries()) {
          if (pricedTrades.length < this.MIN_CLUSTER_SIZE) continue;

          const cluster = await this.analyzeCluster(
            tokenMint,
            pricedTrades
          );
          if (cluster) {
            results.push(cluster);
          }
        }
      }

      return results;
    } catch (error) {
      console.error(
        `[WalletClusterDetector] Failed to detect clusters:`,
        error
      );
      return [];
    }
  }

  /**
   * Group trades by entry time window (5 minutes)
   */
  private groupByEntryTime(
    trades: TradeEvent[]
  ): Map<number, TradeEvent[]> {
    const clusters = new Map<number, TradeEvent[]>();

    for (const trade of trades) {
      // Round timestamp to nearest time window
      const windowKey = Math.floor(trade.timestamp / this.TIME_WINDOW_SECONDS);

      if (!clusters.has(windowKey)) {
        clusters.set(windowKey, []);
      }
      clusters.get(windowKey)!.push(trade);
    }

    return clusters;
  }

  /**
   * Group trades by entry price (within 2% deviation)
   */
  private groupByEntryPrice(
    trades: TradeEvent[]
  ): Map<string, TradeEvent[]> {
    const clusters = new Map<string, TradeEvent[]>();

    // Sort by price for easier grouping
    const sorted = [...trades].sort((a, b) => a.entryPrice - b.entryPrice);

    let currentCluster: TradeEvent[] = [];
    let clusterPrice: number | null = null;

    for (const trade of sorted) {
      if (clusterPrice === null) {
        // Start new cluster
        clusterPrice = trade.entryPrice;
        currentCluster = [trade];
      } else {
        // Check if trade is within price deviation
        const deviation = Math.abs(
          (trade.entryPrice - clusterPrice) / clusterPrice
        );

        if (deviation <= this.PRICE_DEVIATION_PERCENT / 100) {
          currentCluster.push(trade);
        } else {
          // Save current cluster and start new one
          if (currentCluster.length > 0) {
            const key = `${clusterPrice.toFixed(8)}`;
            clusters.set(key, currentCluster);
          }
          clusterPrice = trade.entryPrice;
          currentCluster = [trade];
        }
      }
    }

    // Save last cluster
    if (currentCluster.length > 0) {
      const key = `${clusterPrice?.toFixed(8)}`;
      clusters.set(key, currentCluster);
    }

    return clusters;
  }

  /**
   * Analyze a cluster for coordination indicators
   */
  private async analyzeCluster(
    tokenMint: string,
    trades: TradeEvent[]
  ): Promise<ClusterAnalysisResult | null> {
    if (trades.length < this.MIN_CLUSTER_SIZE) return null;

    const clusterId = randomUUID();
    const wallets = [...new Set(trades.map((t) => t.walletAddress))];

    if (wallets.length < this.MIN_CLUSTER_SIZE) return null;

    // Calculate timing metrics
    const times = trades.map((t) => t.timestamp);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeRange = maxTime - minTime;

    // Calculate price metrics
    const prices = trades.map((t) => t.entryPrice);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxPriceDeviation = Math.max(
      ...prices.map((p) => Math.abs((p - avgPrice) / avgPrice))
    );

    // Analyze coordination
    const timeCluster = timeRange <= this.TIME_WINDOW_SECONDS;
    const priceCluster = maxPriceDeviation <= this.PRICE_DEVIATION_PERCENT / 100;

    // Coordination score: higher for tight time + price clustering
    const baseCoordination = (timeCluster ? 0.5 : 0) + (priceCluster ? 0.5 : 0);
    const sizeBonus = Math.min(wallets.length / 10, 0.3); // Bonus for larger clusters
    const coordinationScore = Math.min(baseCoordination + sizeBonus, 1.0);

    const isLikelyInsider =
      coordinationScore >= this.COORDINATION_THRESHOLD &&
      wallets.length >= 5;

    // Store in database
    const now = Math.floor(Date.now() / 1000);

    try {
      await db
        .insert(walletClusters)
        .values({
          clusterId,
          tokenMint,
          walletCount: wallets.length,
          walletAddresses: wallets,
          entryTimeCluster: timeCluster,
          entryPriceCluster: priceCluster,
          coordinationScore,
          isLikelyInsider,
          earliestEntryTime: minTime,
          latestEntryTime: maxTime,
          entryTimeRangeMinutes: Math.ceil(timeRange / 60),
          detectedAt: now,
          analysisCompletedAt: now,
          createdAt: now,
        })
        .execute();

      const result: ClusterAnalysisResult = {
        clusterId,
        tokenMint,
        walletCount: wallets.length,
        walletAddresses: wallets,
        entryTimeCluster: timeCluster,
        entryPriceCluster: priceCluster,
        coordinationScore,
        isLikelyInsider,
        analysis:
          `${wallets.length} wallets, ` +
          `${timeCluster ? "tight" : "loose"} timing, ` +
          `${priceCluster ? "tight" : "loose"} pricing, ` +
          `coordination: ${(coordinationScore * 100).toFixed(0)}%`,
      };

      if (isLikelyInsider) {
        console.warn(
          `[WalletClusterDetector] INSIDER CLUSTER DETECTED on ${tokenMint}: ` +
          `${wallets.length} wallets, coordination ${(coordinationScore * 100).toFixed(0)}%`
        );
      } else {
        console.log(
          `[WalletClusterDetector] Cluster detected on ${tokenMint}: ` +
          `${result.analysis}`
        );
      }

      return result;
    } catch (error) {
      console.error(
        `[WalletClusterDetector] Failed to store cluster:`,
        error
      );
      return null;
    }
  }

  /**
   * Get all clusters for a token
   */
  async getTokenClusters(tokenMint: string): Promise<any[]> {
    try {
      const clusters = await db
        .select()
        .from(walletClusters)
        .where(eq(walletClusters.tokenMint, tokenMint))
        .execute();

      return clusters;
    } catch (error) {
      console.error(
        `[WalletClusterDetector] Failed to get token clusters:`,
        error
      );
      return [];
    }
  }

  /**
   * Get suspicious clusters (likely insider trading)
   */
  async getSuspiciousClusters(limit: number = 50): Promise<any[]> {
    try {
      const clusters = await db
        .select()
        .from(walletClusters)
        .where(eq(walletClusters.isLikelyInsider, true))
        .limit(limit)
        .execute();

      return clusters;
    } catch (error) {
      console.error(
        `[WalletClusterDetector] Failed to get suspicious clusters:`,
        error
      );
      return [];
    }
  }

  /**
   * Calculate cluster statistics
   */
  async getClusterStats(): Promise<{
    totalClusters: number;
    suspiciousClusters: number;
    avgClusterSize: number;
    avgCoordination: number;
  }> {
    try {
      const all = await db
        .select()
        .from(walletClusters)
        .execute();

      const suspicious = all.filter((c) => c.isLikelyInsider).length;
      const avgSize =
        all.length > 0
          ? all.reduce((sum, c) => sum + (c.walletCount ?? 0), 0) / all.length
          : 0;
      const avgCoordination =
        all.length > 0
          ? all.reduce((sum, c) => sum + (c.coordinationScore ?? 0), 0) / all.length
          : 0;

      return {
        totalClusters: all.length,
        suspiciousClusters: suspicious,
        avgClusterSize: avgSize,
        avgCoordination,
      };
    } catch (error) {
      console.error(
        `[WalletClusterDetector] Failed to get cluster stats:`,
        error
      );
      return {
        totalClusters: 0,
        suspiciousClusters: 0,
        avgClusterSize: 0,
        avgCoordination: 0,
      };
    }
  }
}
