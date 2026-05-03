import { db } from "./db";
import { eq } from "drizzle-orm";
import { positionBudgets, activePositions } from "@shared/schema";

const MAX_POSITION_PERCENT = 0.30; // 30% of balance max per position
const MIN_POSITION_PERCENT = 0.01; // 1% of balance minimum
const EXCEPTIONAL_TOKEN_MULTIPLIER = 2.0; // 2x base allocation for exceptional tokens
const APE_BUDGET_MAX_BOOST = 0.5; // Ape budget can boost by max 50%
const APE_BUDGET_WEEKLY_RESET_DAYS = 7;

interface AllocationDecision {
  baseAllocation: number;
  apeBoost: number;
  totalAllocation: number;
  reason: string;
  isExceptional: boolean;
}

/**
 * Determine if a token is "exceptional" (high match + high trajectory)
 */
export function isExceptionalToken(
  clusterMatchConfidence: number,
  trajectoryScore: real
): boolean {
  const EXCEPTIONAL_MATCH_THRESHOLD = 0.85;
  const EXCEPTIONAL_TRAJECTORY_THRESHOLD = 0.7;

  return (
    clusterMatchConfidence > EXCEPTIONAL_MATCH_THRESHOLD &&
    trajectoryScore > EXCEPTIONAL_TRAJECTORY_THRESHOLD
  );
}

/**
 * Calculate allocation for a position
 */
export async function calculateAllocation(
  userId: number,
  currentBalance: number,
  clusterMatchConfidence: number,
  trajectoryScore: number
): Promise<AllocationDecision> {
  try {
    // Get current budget forecast
    const budget = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, userId))
      .limit(1);

    if (!budget || budget.length === 0) {
      // Fallback: simple allocation
      const fallbackAllocation = currentBalance / 50; // ~2% per position if 50 expected/day
      return {
        baseAllocation: fallbackAllocation,
        apeBoost: 0,
        totalAllocation: fallbackAllocation,
        reason: "No budget forecast found, using fallback",
        isExceptional: false,
      };
    }

    const budgetRecord = budget[0];
    let baseAllocation = budgetRecord.baseAllocationPerPosition;

    // Safety: ensure we don't exceed max % of balance
    const maxAllocation = currentBalance * MAX_POSITION_PERCENT;
    baseAllocation = Math.min(baseAllocation, maxAllocation);

    // Safety: ensure we meet minimum
    const minAllocation = currentBalance * MIN_POSITION_PERCENT;
    baseAllocation = Math.max(baseAllocation, minAllocation);

    // Determine if exceptional token
    const exceptional = isExceptionalToken(clusterMatchConfidence, trajectoryScore);

    // Check ape budget availability
    let apeBoost = 0;
    let totalAllocation = baseAllocation;

    if (exceptional) {
      // Try to apply 2x multiplier from ape budget
      const apeBudgetNeeded = baseAllocation * (EXCEPTIONAL_TOKEN_MULTIPLIER - 1);

      if (budgetRecord.apeBudget >= apeBudgetNeeded) {
        // Ape budget can cover the boost
        apeBoost = apeBudgetNeeded;
        totalAllocation = baseAllocation * EXCEPTIONAL_TOKEN_MULTIPLIER;

        // Deduct from ape budget
        await updateApeBudget(userId, budgetRecord.apeBudget - apeBudgetNeeded);
      } else if (budgetRecord.apeBudget > 0) {
        // Partial ape budget available
        apeBoost = budgetRecord.apeBudget;
        totalAllocation = baseAllocation + apeBoost;

        // Deplete ape budget
        await updateApeBudget(userId, 0);
      } else {
        // No ape budget, just base allocation
        totalAllocation = baseAllocation;
      }
    }

    // Final cap: don't exceed 30% of balance
    totalAllocation = Math.min(totalAllocation, maxAllocation);

    return {
      baseAllocation,
      apeBoost,
      totalAllocation,
      reason: exceptional
        ? `Exceptional token (${(clusterMatchConfidence * 100).toFixed(0)}% match, score ${trajectoryScore.toFixed(2)}), boost available`
        : `Standard allocation (${(clusterMatchConfidence * 100).toFixed(0)}% match, score ${trajectoryScore.toFixed(2)})`,
      isExceptional: exceptional,
    };
  } catch (error) {
    console.error(`[PositionAllocator] Error calculating allocation for user ${userId}:`, error);
    return {
      baseAllocation: 0.1,
      apeBoost: 0,
      totalAllocation: 0.1,
      reason: "Error calculating allocation, using fallback",
      isExceptional: false,
    };
  }
}

/**
 * Update ape budget after position closes with profit/loss
 */
export async function updateApeBudgetAfterPosition(
  userId: number,
  realizedPnlPercent: number
): Promise<void> {
  try {
    const budget = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, userId))
      .limit(1);

    if (!budget || budget.length === 0) return;

    const budgetRecord = budget[0];

    // Check if ape budget needs reset (weekly)
    const now = Math.floor(Date.now() / 1000);
    const lastReset = budgetRecord.apeBudgetResetAt || budgetRecord.createdAt;
    const secondsSinceReset = now - lastReset;
    const secondsPerWeek = APE_BUDGET_WEEKLY_RESET_DAYS * 24 * 60 * 60;

    if (secondsSinceReset > secondsPerWeek) {
      // Weekly reset: start fresh
      await db
        .update(positionBudgets)
        .set({
          apeBudget: 0,
          apeBudgetResetAt: now,
          updatedAt: now,
        })
        .where(eq(positionBudgets.userId, userId));
      return;
    }

    // Calculate ape budget impact based on position outcome
    // If position won: grow ape budget slightly (up to 30% of initial)
    // If position lost: shrink ape budget

    const multiplier = 1 + realizedPnlPercent; // e.g., 1.15 for +15% win

    let newApeBudget = budgetRecord.apeBudget * multiplier;

    // Cap ape budget growth: max 30% of initial balance
    // (This would be stored separately, but assume 1 SOL starting capital for now)
    const initialBalance = 1.0; // This should come from fund session
    const apeBudgetCap = initialBalance * 0.30;

    newApeBudget = Math.max(0, Math.min(newApeBudget, apeBudgetCap));

    await db
      .update(positionBudgets)
      .set({
        apeBudget: newApeBudget,
        updatedAt: now,
      })
      .where(eq(positionBudgets.userId, userId));

    console.log(
      `[PositionAllocator] Updated ape budget for user ${userId}: ${newApeBudget.toFixed(4)} SOL (PnL: ${(realizedPnlPercent * 100).toFixed(1)}%)`
    );
  } catch (error) {
    console.error(`[PositionAllocator] Error updating ape budget for user ${userId}:`, error);
  }
}

/**
 * Top up ape budget if conditions are met
 */
export async function topUpApeBudgetIfEarned(
  userId: number,
  winRate: number, // 0-1
  profitFactor: number // total wins / total losses
): Promise<void> {
  try {
    const budget = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, userId))
      .limit(1);

    if (!budget || budget.length === 0) return;

    const budgetRecord = budget[0];
    const now = Math.floor(Date.now() / 1000);

    // Conditions to increase ape budget multiplier
    // - Win rate > 55%
    // - Profit factor > 1.2

    if (winRate > 0.55 && profitFactor > 1.2) {
      // Increase multiplier by 0.05 (up to max 0.40)
      const newMultiplier = Math.min(0.4, (budgetRecord.apeBudgetMultiplier || 0.3) + 0.05);

      await db
        .update(positionBudgets)
        .set({
          apeBudgetMultiplier: newMultiplier,
          updatedAt: now,
        })
        .where(eq(positionBudgets.userId, userId));

      console.log(
        `[PositionAllocator] Increased ape budget multiplier for user ${userId} to ${(newMultiplier * 100).toFixed(0)}%`
      );
    }
  } catch (error) {
    console.error(`[PositionAllocator] Error topping up ape budget for user ${userId}:`, error);
  }
}

/**
 * Get current ape budget status for user
 */
export async function getApeBudgetStatus(userId: number): Promise<any> {
  try {
    const budget = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, userId))
      .limit(1);

    if (!budget || budget.length === 0) {
      return {
        apeBudget: 0,
        apeBudgetMultiplier: 0.3,
        available: true,
      };
    }

    const budgetRecord = budget[0];

    return {
      apeBudget: budgetRecord.apeBudget,
      apeBudgetMultiplier: budgetRecord.apeBudgetMultiplier,
      available: budgetRecord.apeBudget > 0,
      lastResetAt: budgetRecord.apeBudgetResetAt,
    };
  } catch (error) {
    console.error(`[PositionAllocator] Error getting ape budget status for user ${userId}:`, error);
    return {
      apeBudget: 0,
      apeBudgetMultiplier: 0.3,
      available: false,
    };
  }
}

// =====================
// INTERNAL HELPERS
// =====================

async function updateApeBudget(userId: number, newAmount: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(positionBudgets)
    .set({
      apeBudget: newAmount,
      updatedAt: now,
    })
    .where(eq(positionBudgets.userId, userId));
}
