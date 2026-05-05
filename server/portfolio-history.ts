/**
 * Portfolio History Service
 *
 * Tracks all portfolio events: buys, sells, resets, session changes
 * Used to display transaction history and reset stats on major events
 */

import { db } from "./db";
import { portfolioHistory, positionBudgets } from "@shared/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

function generateSessionId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export async function recordBuyEvent(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  amountSol: number,
  price: number,
  sessionId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.insert(portfolioHistory).values({
    userId,
    eventType: "buy",
    tokenMint,
    tokenSymbol,
    amount: amountSol,
    price,
    description: `Bought ${amountSol.toFixed(4)} SOL of ${tokenSymbol}`,
    sessionId,
    recordedAt: now,
    createdAt: now,
  });
}

export async function recordSellEvent(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  amountSol: number,
  price: number,
  pnl: number,
  pnlPercent: number,
  sessionId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sign = pnl >= 0 ? "+" : "";
  await db.insert(portfolioHistory).values({
    userId,
    eventType: "sell",
    tokenMint,
    tokenSymbol,
    amount: amountSol,
    price,
    pnl,
    pnlPercent,
    description: `Sold ${amountSol.toFixed(4)} SOL of ${tokenSymbol} for ${sign}${pnl.toFixed(4)} SOL (${sign}${pnlPercent.toFixed(1)}%)`,
    sessionId,
    recordedAt: now,
    createdAt: now,
  });
}

export async function recordAutoTradingEnabledEvent(userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = generateSessionId();

  // Record the event
  await db.insert(portfolioHistory).values({
    userId,
    eventType: "autotrading_enabled",
    description: "Auto-trading enabled - resetting performance metrics",
    sessionId,
    recordedAt: now,
    createdAt: now,
  });

  // Reset performance stats in positionBudgets
  await db
    .update(positionBudgets)
    .set({
      sessionStartedAt: now,
    })
    .where(eq(positionBudgets.userId, userId));

  console.log(`[PortfolioHistory] Auto-trading enabled for user ${userId}, session reset`);
}

export async function recordFundTopupEvent(userId: number, topupAmount: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = generateSessionId();

  // Record the event
  await db.insert(portfolioHistory).values({
    userId,
    eventType: "fund_topup",
    amount: topupAmount,
    description: `Fund topped up with ${topupAmount.toFixed(4)} SOL - resetting performance metrics`,
    sessionId,
    recordedAt: now,
    createdAt: now,
  });

  // Reset performance stats in positionBudgets
  await db
    .update(positionBudgets)
    .set({
      sessionStartedAt: now,
    })
    .where(eq(positionBudgets.userId, userId));

  console.log(`[PortfolioHistory] Fund topped up ${topupAmount} SOL for user ${userId}, session reset`);
}

export async function recordSessionResetEvent(userId: number, reason: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = generateSessionId();

  // Record the event
  await db.insert(portfolioHistory).values({
    userId,
    eventType: "session_reset",
    description: `System pick session reset - ${reason}`,
    sessionId,
    recordedAt: now,
    createdAt: now,
  });

  // Reset performance stats in positionBudgets
  await db
    .update(positionBudgets)
    .set({
      sessionStartedAt: now,
    })
    .where(eq(positionBudgets.userId, userId));

  console.log(`[PortfolioHistory] Session reset for user ${userId}: ${reason}`);
}

export async function getPortfolioHistory(userId: number, limit: number = 50) {
  const history = await db
    .select()
    .from(portfolioHistory)
    .where(eq(portfolioHistory.userId, userId))
    .orderBy(db.schema.portfolioHistory.recordedAt)
    .limit(limit);

  return history;
}

export async function getSessionStartTime(userId: number): Promise<number> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  if (budget.length === 0) {
    return Math.floor(Date.now() / 1000);
  }

  return budget[0].sessionStartedAt || budget[0].lastCalculatedAt || Math.floor(Date.now() / 1000);
}

export async function getCurrentSessionId(userId: number): Promise<string> {
  // Get the most recent session ID from portfolio history
  const recent = await db
    .select()
    .from(portfolioHistory)
    .where(eq(portfolioHistory.userId, userId))
    .orderBy(db.schema.portfolioHistory.recordedAt)
    .limit(1);

  if (recent.length > 0 && recent[0].sessionId) {
    return recent[0].sessionId;
  }

  // Generate new one if none exists
  return generateSessionId();
}
