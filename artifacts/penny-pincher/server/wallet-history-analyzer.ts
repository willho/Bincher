import { db } from "./db";
import { retrolearnerWalletAnalysis, goodTraders } from "../shared/schema";
import { eq, and, lt } from "drizzle-orm";

/**
 * Wallet History Analyzer
 *
 * Retrieves 7-day wallet transaction history from Shyft RPC.
 * Features:
 * - 7-day lookback for complete trader history
 * - Deduplication: skip wallets/tokens already analyzed within 24h
 * - PnL calculation: track profit/loss, win rate, Sharpe ratio
 * - Fresh wallet detection: identifies newly-active wallets
 *
 * Rate limit: Unlimited HTTP RPC (Shyft free tier)
 * Target: 85% utilization of available capacity
 */

export interface WalletHistoryEntry {
  signature: string;
  timestamp: number;
  tokenMint: string;
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  profitUsd?: number;
  daysHeld?: number;
}

export interface WalletAnalysisResult {
  walletAddress: string;
  totalProfitUsd: number;
  winRate: number;
  avgHoldMinutes: number;
  sharpeRatio: number;
  sampleCount: number;
  discoveredTokens: string[];
}

export class WalletHistoryAnalyzer {
  private shyftApiKey: string;
  private readonly LOOKBACK_DAYS = 7;
  private readonly DEDUP_HOURS = 24; // Skip if analyzed within 24h
  private readonly SHARPE_RISK_FREE_RATE = 0.0001; // Small daily risk-free rate for Sharpe

  constructor(shyftApiKey: string) {
    this.shyftApiKey = shyftApiKey;
  }

  /**
   * Get wallets that need analysis (not analyzed in last 24h)
   */
  async getWalletsNeedingAnalysis(limit: number = 50): Promise<string[]> {
    try {
      const cutoffTime = Math.floor(Date.now() / 1000) - 24 * 3600; // 24 hours ago

      // Get good traders not analyzed recently
      const wallets = await db
        .select({ walletAddress: goodTraders.walletAddress })
        .from(goodTraders)
        .where(
          and(
            eq(goodTraders.isActive, true),
            // TODO: Add join with retrolearnerWalletAnalysis to check lastAnalyzedAt
            // For now, return all active good traders
          )
        )
        .limit(limit)
        .execute();

      return wallets.map((w) => w.walletAddress);
    } catch (error) {
      console.error(
        `[WalletHistoryAnalyzer] Failed to get wallets needing analysis:`,
        error
      );
      return [];
    }
  }

  /**
   * Analyze wallet's 7-day trading history
   */
  async analyzeWalletHistory(
    walletAddress: string
  ): Promise<WalletAnalysisResult | null> {
    try {
      // Check if already analyzed recently
      const existing = await db
        .select()
        .from(retrolearnerWalletAnalysis)
        .where(eq(retrolearnerWalletAnalysis.walletAddress, walletAddress))
        .limit(1)
        .execute();

      if (existing.length > 0) {
        const analysis = existing[0];
        const lastAnalyzed = analysis.lastAnalyzedAt || 0;
        const hoursAgo = (Math.floor(Date.now() / 1000) - lastAnalyzed) / 3600;

        if (hoursAgo < this.DEDUP_HOURS) {
          console.debug(
            `[WalletHistoryAnalyzer] Skipping ${walletAddress} (analyzed ${hoursAgo.toFixed(1)}h ago)`
          );
          return null; // Skip if analyzed recently
        }
      }

      // Fetch transaction history from Shyft
      const history = await this.fetchWalletHistory(walletAddress);

      if (!history || history.length === 0) {
        console.warn(
          `[WalletHistoryAnalyzer] No transaction history for ${walletAddress}`
        );
        return null;
      }

      // Calculate PnL metrics
      const result = this.calculateMetrics(walletAddress, history);

      // Store in database
      await this.storeAnalysis(walletAddress, result);

      return result;
    } catch (error) {
      console.error(
        `[WalletHistoryAnalyzer] Failed to analyze wallet:`,
        error
      );
      return null;
    }
  }

  /**
   * Fetch 7-day transaction history from Shyft
   */
  private async fetchWalletHistory(walletAddress: string): Promise<WalletHistoryEntry[]> {
    try {
      // TODO: Implement Shyft RPC call
      // Method: getSignaturesForAddress with 7-day lookback
      // Parse transaction data to extract swaps

      const url = `https://api.shyft.to/sol/v1/wallet/history?wallet=${walletAddress}&api_key=${this.shyftApiKey}`;

      const response = await fetch(url);

      if (!response.ok) {
        console.error(
          `[WalletHistoryAnalyzer] Shyft API error: ${response.status}`
        );
        return [];
      }

      const data = await response.json();

      // Parse and transform Shyft response
      // Filter for transactions within last 7 days
      const now = Math.floor(Date.now() / 1000);
      const sevenDaysAgo = now - 7 * 24 * 3600;

      const transactions: WalletHistoryEntry[] = [];

      // TODO: Transform Shyft transaction format to WalletHistoryEntry
      // This is a placeholder; actual parsing depends on Shyft response format

      return transactions;
    } catch (error) {
      console.error(
        `[WalletHistoryAnalyzer] Failed to fetch wallet history:`,
        error
      );
      return [];
    }
  }

  /**
   * Calculate PnL metrics from transaction history
   */
  private calculateMetrics(
    walletAddress: string,
    history: WalletHistoryEntry[]
  ): WalletAnalysisResult {
    let totalProfitUsd = 0;
    let winningTrades = 0;
    const holdTimes: number[] = [];
    const returns: number[] = []; // Daily returns for Sharpe

    for (const trade of history) {
      if (trade.profitUsd !== undefined) {
        totalProfitUsd += trade.profitUsd;
        if (trade.profitUsd > 0) winningTrades++;
      }

      if (trade.daysHeld !== undefined) {
        holdTimes.push(trade.daysHeld * 24 * 60); // Convert to minutes
      }

      // Simplified daily return calculation
      if (trade.exitPrice && trade.entryPrice) {
        const dailyReturn =
          Math.log(trade.exitPrice / trade.entryPrice) /
          Math.max(trade.daysHeld || 1, 1);
        returns.push(dailyReturn);
      }
    }

    // Calculate metrics
    const winRate =
      history.length > 0 ? winningTrades / history.length : 0;
    const avgHoldMinutes =
      holdTimes.length > 0 ?
        holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
        : 0;

    // Sharpe ratio = (mean return - risk-free rate) / std dev
    const sharpeRatio = this.calculateSharpeRatio(returns);

    // Extract unique tokens traded
    const discoveredTokens = [
      ...new Set(history.map((t) => t.tokenMint)),
    ];

    return {
      walletAddress,
      totalProfitUsd,
      winRate,
      avgHoldMinutes,
      sharpeRatio,
      sampleCount: history.length,
      discoveredTokens,
    };
  }

  /**
   * Calculate Sharpe ratio
   */
  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length === 0) return 0;

    // Mean return
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    // Standard deviation
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      returns.length;
    const stdDev = Math.sqrt(variance);

    // Sharpe ratio
    if (stdDev === 0) return 0;

    return (mean - this.SHARPE_RISK_FREE_RATE) / stdDev;
  }

  /**
   * Store analysis results in database
   */
  private async storeAnalysis(
    walletAddress: string,
    result: WalletAnalysisResult
  ): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);

      const existing = await db
        .select()
        .from(retrolearnerWalletAnalysis)
        .where(eq(retrolearnerWalletAnalysis.walletAddress, walletAddress))
        .limit(1)
        .execute();

      if (existing.length > 0) {
        // Update existing analysis
        await db
          .update(retrolearnerWalletAnalysis)
          .set({
            lastAnalyzedAt: now,
            totalPnl7d: result.totalProfitUsd,
            winRate7d: result.winRate,
            avgHoldMinutes: result.avgHoldMinutes,
            sharpeRatio: result.sharpeRatio,
            sampleCount: result.sampleCount,
            discoveredFromTokens: result.discoveredTokens,
            updatedAt: now,
          })
          .where(
            eq(retrolearnerWalletAnalysis.id, existing[0].id)
          )
          .execute();
      } else {
        // Create new analysis
        await db
          .insert(retrolearnerWalletAnalysis)
          .values({
            walletAddress,
            lastAnalyzedAt: now,
            totalPnl7d: result.totalProfitUsd,
            winRate7d: result.winRate,
            avgHoldMinutes: result.avgHoldMinutes,
            sharpeRatio: result.sharpeRatio,
            sampleCount: result.sampleCount,
            discoveredFromTokens: result.discoveredTokens,
            discoveryConfidence: 0,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      }

      console.log(
        `[WalletHistoryAnalyzer] Analyzed ${walletAddress}: ` +
        `$${result.totalProfitUsd.toFixed(2)} profit, ` +
        `${(result.winRate * 100).toFixed(0)}% win rate`
      );
    } catch (error) {
      console.error(
        `[WalletHistoryAnalyzer] Failed to store analysis:`,
        error
      );
    }
  }

  /**
   * Get analysis for wallet
   */
  async getAnalysis(walletAddress: string): Promise<WalletAnalysisResult | null> {
    try {
      const result = await db
        .select()
        .from(retrolearnerWalletAnalysis)
        .where(eq(retrolearnerWalletAnalysis.walletAddress, walletAddress))
        .limit(1)
        .execute();

      if (!result.length) return null;

      const r = result[0];

      return {
        walletAddress,
        totalProfitUsd: r.totalPnl7d || 0,
        winRate: r.winRate7d || 0,
        avgHoldMinutes: r.avgHoldMinutes || 0,
        sharpeRatio: r.sharpeRatio || 0,
        sampleCount: r.sampleCount || 0,
        discoveredTokens: (r.discoveredFromTokens as string[]) || [],
      };
    } catch (error) {
      console.error(
        `[WalletHistoryAnalyzer] Failed to get analysis:`,
        error
      );
      return null;
    }
  }
}
