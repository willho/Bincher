import { db } from "./db";
import { eq } from "drizzle-orm";
import { activePositions } from "@shared/schema";
import { updateApeBudgetAfterPosition } from "./position-allocator";

interface ExitResult {
  success: boolean;
  positionId: number;
  exitPrice: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  moonbagAmount: number;
  reason: string;
}

class PositionExitManager {
  /**
   * Execute position exit
   */
  async exitPosition(
    positionId: number,
    exitReason: "tsl_hit" | "trajectory_collapse" | "time_stop" | "profit_take" | "user_manual",
    exitPrice: number,
    userId: number
  ): Promise<ExitResult> {
    try {
      // Get position details
      const position = await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.id, positionId))
        .limit(1);

      if (!position || position.length === 0) {
        throw new Error(`Position ${positionId} not found`);
      }

      const pos = position[0];

      // Calculate PnL
      const realizedPnl = pos.entrySol * (exitPrice / pos.entryPrice - 1);
      const realizedPnlPercent = exitPrice / pos.entryPrice - 1;

      // Determine if we should leave a moonbag
      let moonbagAmount = 0;
      const shouldLeaveMoonbag =
        exitReason === "trajectory_collapse" && realizedPnlPercent > 0.1; // Only if >10% profit

      if (shouldLeaveMoonbag) {
        // Leave 5-10% of position as moonbag
        const moonbagPercent = Math.random() * 0.05 + 0.05; // 5-10%
        moonbagAmount = pos.entrySol * moonbagPercent;
      }

      const now = Math.floor(Date.now() / 1000);
      const holdDurationSeconds = now - pos.openedAt;

      // Update position record
      await db
        .update(activePositions)
        .set({
          status: "closed",
          exitReason,
          exitPrice,
          exitTxSignature: `sig_${now}`, // Would be actual TX signature in real trading
          realizedPnl,
          realizedPnlPercent,
          moonbagAmount,
          closedAt: now,
          holdDurationSeconds,
          updatedAt: now,
        })
        .where(eq(activePositions.id, positionId));

      // Update ape budget based on outcome
      await updateApeBudgetAfterPosition(userId, realizedPnlPercent);

      console.log(
        `[ExitManager] Exited position ${positionId} (${pos.tokenSymbol}): ${exitReason} at ${exitPrice.toFixed(6)} SOL, PnL: ${(realizedPnlPercent * 100).toFixed(1)}%`
      );

      return {
        success: true,
        positionId,
        exitPrice,
        realizedPnl,
        realizedPnlPercent,
        moonbagAmount,
        reason: `Exited via ${exitReason}`,
      };
    } catch (error) {
      console.error(`[ExitManager] Error exiting position ${positionId}:`, error);
      throw error;
    }
  }

  /**
   * Check if position should exit due to TSL hit
   */
  async checkTSLExit(positionId: number, currentPrice: number): Promise<boolean> {
    try {
      const position = await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.id, positionId))
        .limit(1);

      if (!position || position.length === 0) return false;

      const pos = position[0];

      // Track highest price
      if (currentPrice > pos.highestPrice) {
        const now = Math.floor(Date.now() / 1000);
        await db
          .update(activePositions)
          .set({
            highestPrice: currentPrice,
            highestPriceReachedAt: now,
            updatedAt: now,
          })
          .where(eq(activePositions.id, positionId));
      }

      // Calculate TSL threshold
      const tslPercent = pos.tslCurrentPercent / 100;
      const trailingStopPrice = pos.highestPrice * (1 - tslPercent);

      // Check if current price hit TSL
      if (currentPrice <= trailingStopPrice) {
        console.log(
          `[ExitManager] TSL triggered for position ${positionId}: ${currentPrice.toFixed(6)} <= ${trailingStopPrice.toFixed(6)}`
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[ExitManager] Error checking TSL for position ${positionId}:`, error);
      return false;
    }
  }

  /**
   * Check if position should exit due to time stop
   */
  async checkTimeStop(positionId: number, maxHoldMinutes: number): Promise<boolean> {
    try {
      const position = await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.id, positionId))
        .limit(1);

      if (!position || position.length === 0) return false;

      const pos = position[0];
      const now = Math.floor(Date.now() / 1000);
      const holdDurationSeconds = now - pos.openedAt;
      const maxHoldSeconds = maxHoldMinutes * 60;

      if (holdDurationSeconds > maxHoldSeconds) {
        console.log(
          `[ExitManager] Time stop triggered for position ${positionId}: held ${(holdDurationSeconds / 60).toFixed(0)} minutes > ${maxHoldMinutes} minutes`
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[ExitManager] Error checking time stop for position ${positionId}:`, error);
      return false;
    }
  }

  /**
   * Check if position reached take profit target
   */
  async checkTakeProfit(
    positionId: number,
    currentPrice: number,
    takeProfitMultiplier: number
  ): Promise<boolean> {
    try {
      const position = await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.id, positionId))
        .limit(1);

      if (!position || position.length === 0) return false;

      const pos = position[0];

      const takeProfitPrice = pos.entryPrice * takeProfitMultiplier;

      if (currentPrice >= takeProfitPrice) {
        console.log(
          `[ExitManager] Take profit triggered for position ${positionId}: ${currentPrice.toFixed(6)} >= ${takeProfitPrice.toFixed(6)}`
        );
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[ExitManager] Error checking take profit for position ${positionId}:`, error);
      return false;
    }
  }

  /**
   * Get all open positions for user
   */
  async getOpenPositions(userId: number): Promise<any[]> {
    try {
      return await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.userId, userId));
    } catch (error) {
      console.error(`[ExitManager] Error getting open positions for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Get closed positions for user (for retrolearner analysis)
   */
  async getClosedPositions(userId: number, limit: number = 100): Promise<any[]> {
    try {
      return await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.userId, userId))
        .orderBy((t) => t.closedAt)
        .limit(limit);
    } catch (error) {
      console.error(`[ExitManager] Error getting closed positions for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Analyze position outcomes for retrolearner
   */
  async analyzeOutcomes(userId: number): Promise<{
    totalPositions: number;
    winningPositions: number;
    losingPositions: number;
    breakEvenPositions: number;
    averageHoldMinutes: number;
    winRate: number;
    profitFactor: number;
    totalPnl: number;
  }> {
    try {
      const closed = await this.getClosedPositions(userId, 1000);

      if (closed.length === 0) {
        return {
          totalPositions: 0,
          winningPositions: 0,
          losingPositions: 0,
          breakEvenPositions: 0,
          averageHoldMinutes: 0,
          winRate: 0,
          profitFactor: 0,
          totalPnl: 0,
        };
      }

      let winCount = 0;
      let lossCount = 0;
      let breakEvenCount = 0;
      let totalHoldSeconds = 0;
      let totalWins = 0;
      let totalLosses = 0;
      let totalPnl = 0;

      for (const pos of closed) {
        const pnlPercent = pos.realizedPnlPercent || 0;
        const pnl = pos.realizedPnl || 0;

        totalPnl += pnl;

        if (pnlPercent > 0.01) {
          // >1% profit
          winCount++;
          totalWins += pnl;
        } else if (pnlPercent < -0.01) {
          // <-1% loss
          lossCount++;
          totalLosses += Math.abs(pnl);
        } else {
          breakEvenCount++;
        }

        totalHoldSeconds += pos.holdDurationSeconds || 0;
      }

      const winRate = winCount / closed.length;
      const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
      const averageHoldMinutes = totalHoldSeconds / closed.length / 60;

      return {
        totalPositions: closed.length,
        winningPositions: winCount,
        losingPositions: lossCount,
        breakEvenPositions: breakEvenCount,
        averageHoldMinutes,
        winRate,
        profitFactor,
        totalPnl,
      };
    } catch (error) {
      console.error(`[ExitManager] Error analyzing outcomes for user ${userId}:`, error);
      return {
        totalPositions: 0,
        winningPositions: 0,
        losingPositions: 0,
        breakEvenPositions: 0,
        averageHoldMinutes: 0,
        winRate: 0,
        profitFactor: 0,
        totalPnl: 0,
      };
    }
  }
}

export const positionExitManager = new PositionExitManager();
export { ExitResult };
