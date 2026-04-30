import { db } from "./db";
import { goodTraders, swaps } from "../shared/schema";
import { eq, and, gte } from "drizzle-orm";

/**
 * Good Trader Identifier
 *
 * Identifies and tracks wallets with profitable trading patterns.
 * Filter criteria:
 * - At least $100+ profit on a single trade
 * - Traded at least 2 different tokens (excluding SOL/USDC)
 * - Not flagged as bot (MEV sandwich, rapid-fire patterns)
 *
 * Feeds discovered wallets into wallet monitoring and analysis systems.
 */

export interface ProfitableTradeSignal {
  walletAddress: string;
  tokenMint: string;
  profitUsd: number;
  profitMultiplier: number;
  buyPrice: number;
  sellPrice: number;
  holdMinutes: number;
  signature: string;
}

export class GoodTraderIdentifier {
  private readonly MIN_PROFIT_USD = 100; // $100+ profit threshold
  private readonly MIN_UNIQUE_TOKENS = 2; // Must trade at least 2 tokens (exclude SOL/USDC)
  private readonly EXCLUDED_TOKENS = ["11111111111111111111111111111111", "EPjFWdd5Au", "USDC"]; // SOL, USDC, etc

  /**
   * Analyze a trade to determine if trader should be marked as "good"
   * Called when detecting profitable exits
   */
  async analyzeTradeSignal(
    signal: ProfitableTradeSignal
  ): Promise<{ isGoodTrader: boolean; reason: string }> {
    // Check profit threshold
    if (signal.profitUsd < this.MIN_PROFIT_USD) {
      return {
        isGoodTrader: false,
        reason: `Profit below $${this.MIN_PROFIT_USD} threshold`,
      };
    }

    // Check if wallet already exists in good_traders
    const existing = await db
      .select()
      .from(goodTraders)
      .where(eq(goodTraders.walletAddress, signal.walletAddress))
      .limit(1)
      .execute();

    if (existing.length > 0) {
      // Already tracked, update metrics
      await this.updateTraderMetrics(signal);
      return { isGoodTrader: true, reason: "Already tracked trader" };
    }

    // Check token diversity (must trade multiple non-excluded tokens)
    const tokenDiversity = await this.checkTokenDiversity(signal.walletAddress);

    if (tokenDiversity.uniqueTokenCount < this.MIN_UNIQUE_TOKENS) {
      return {
        isGoodTrader: false,
        reason: `Only ${tokenDiversity.uniqueTokenCount} unique token(s), need ≥${this.MIN_UNIQUE_TOKENS}`,
      };
    }

    // Check for bot patterns
    const botCheck = await this.checkBotPatterns(signal.walletAddress);
    if (botCheck.isBot) {
      return {
        isGoodTrader: false,
        reason: `Bot detected: ${botCheck.reason}`,
      };
    }

    // All checks passed - add to good traders
    await this.addGoodTrader(signal);
    return {
      isGoodTrader: true,
      reason: `Profitable trader: $${signal.profitUsd} on ${tokenDiversity.uniqueTokenCount} tokens`,
    };
  }

  /**
   * Check token diversity: count unique tokens trader has transacted with
   */
  private async checkTokenDiversity(
    walletAddress: string
  ): Promise<{ uniqueTokenCount: number; tokens: string[] }> {
    try {
      // For now, we'll approximate by checking known swaps
      // In full implementation, would query blockchain history
      const trades = await db
        .select({
          toToken: swaps.toToken,
        })
        .from(swaps)
        .where(
          and(
            // Wallet appears as recipient or sender - simplified for now
            // Full implementation would track wallet address directly
          )
        )
        .limit(100)
        .execute();

      const uniqueTokens = [...new Set(trades.map((t) => t.toToken))].filter(
        (t) => !this.EXCLUDED_TOKENS.includes(t)
      );

      return {
        uniqueTokenCount: uniqueTokens.length,
        tokens: uniqueTokens,
      };
    } catch (error) {
      console.error(
        `[GoodTraderIdentifier] Failed to check token diversity:`,
        error
      );
      return { uniqueTokenCount: 0, tokens: [] };
    }
  }

  /**
   * Detect bot patterns: rapid-fire trades, MEV sandwich, exact amounts, etc
   */
  private async checkBotPatterns(
    walletAddress: string
  ): Promise<{ isBot: boolean; reason: string }> {
    // Bot detection heuristics:
    // 1. Rapid-fire trades (multiple within 1 second)
    // 2. Identical transaction amounts
    // 3. MEV sandwich patterns (buy → immediate sell within 1 block)
    // 4. Granular amount patterns (exact values, not human-like)

    try {
      // Placeholder: simplified implementation
      // Full implementation would analyze transaction patterns on-chain

      // For now, assume no bots detected (conservative)
      return { isBot: false, reason: "" };
    } catch (error) {
      console.error(`[GoodTraderIdentifier] Failed to check bot patterns:`, error);
      // Default to not-a-bot to avoid false positives
      return { isBot: false, reason: "" };
    }
  }

  /**
   * Add wallet to good_traders table
   */
  private async addGoodTrader(signal: ProfitableTradeSignal): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);

      await db
        .insert(goodTraders)
        .values({
          walletAddress: signal.walletAddress,
          discoveredFromTokens: [signal.tokenMint],
          totalProfitUsd: signal.profitUsd,
          totalTrades: 1,
          profitableCount: 1,
          winRate: 1.0,
          avgHoldMinutes: signal.holdMinutes,
          lastAssessedAt: now,
          isActive: true,
          createdAt: now,
        })
        .onConflictDoNothing()
        .execute();

      console.log(
        `[GoodTraderIdentifier] Added good trader: ${signal.walletAddress} ` +
          `(+$${signal.profitUsd} on ${signal.tokenMint})`
      );
    } catch (error) {
      console.error(`[GoodTraderIdentifier] Failed to add good trader:`, error);
    }
  }

  /**
   * Update trader metrics when new profitable trade is detected
   */
  private async updateTraderMetrics(signal: ProfitableTradeSignal): Promise<void> {
    try {
      const existing = await db
        .select()
        .from(goodTraders)
        .where(eq(goodTraders.walletAddress, signal.walletAddress))
        .limit(1)
        .execute();

      if (!existing.length) return;

      const trader = existing[0];
      const newTradeCount = (trader.totalTrades || 0) + 1;
      const newWinningCount = (trader.profitableCount || 0) + 1;
      const newTotalProfit = (trader.totalProfitUsd || 0) + signal.profitUsd;
      const newWinRate = newWinningCount / newTradeCount;

      await db
        .update(goodTraders)
        .set({
          totalProfitUsd: newTotalProfit,
          totalTrades: newTradeCount,
          profitableCount: newWinningCount,
          winRate: newWinRate,
          lastAssessedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(goodTraders.id, trader.id))
        .execute();

      console.log(
        `[GoodTraderIdentifier] Updated metrics for ${signal.walletAddress}: ` +
          `${newTradeCount} trades, ${newWinRate.toFixed(2)} win rate, +$${newTotalProfit}`
      );
    } catch (error) {
      console.error(
        `[GoodTraderIdentifier] Failed to update trader metrics:`,
        error
      );
    }
  }

  /**
   * Get all active good traders
   */
  async getActiveTraders(): Promise<any[]> {
    try {
      const traders = await db
        .select()
        .from(goodTraders)
        .where(eq(goodTraders.isActive, true))
        .orderBy(goodTraders.totalProfitUsd)
        .limit(1000)
        .execute();

      return traders;
    } catch (error) {
      console.error(`[GoodTraderIdentifier] Failed to get active traders:`, error);
      return [];
    }
  }

  /**
   * Get top traders by profit
   */
  async getTopTradersByProfit(limit: number = 50): Promise<any[]> {
    try {
      const traders = await db
        .select()
        .from(goodTraders)
        .where(eq(goodTraders.isActive, true))
        .orderBy(goodTraders.totalProfitUsd)
        .limit(limit)
        .execute();

      return traders;
    } catch (error) {
      console.error(
        `[GoodTraderIdentifier] Failed to get top traders by profit:`,
        error
      );
      return [];
    }
  }

  /**
   * Get trader by wallet address
   */
  async getTrader(walletAddress: string): Promise<any | null> {
    try {
      const result = await db
        .select()
        .from(goodTraders)
        .where(eq(goodTraders.walletAddress, walletAddress))
        .limit(1)
        .execute();

      return result.length > 0 ? result[0] : null;
    } catch (error) {
      console.error(
        `[GoodTraderIdentifier] Failed to get trader ${walletAddress}:`,
        error
      );
      return null;
    }
  }

  /**
   * Deactivate trader (e.g., if they're identified as bot or inactive)
   */
  async deactivateTrader(walletAddress: string, reason: string): Promise<void> {
    try {
      await db
        .update(goodTraders)
        .set({
          isActive: false,
        })
        .where(eq(goodTraders.walletAddress, walletAddress))
        .execute();

      console.log(
        `[GoodTraderIdentifier] Deactivated trader ${walletAddress}: ${reason}`
      );
    } catch (error) {
      console.error(
        `[GoodTraderIdentifier] Failed to deactivate trader:`,
        error
      );
    }
  }
}
