import { db } from "./db";
import { positionBudgets, activePositions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getLearnedParameters } from "./retrolearner-phase-d";

interface AllocationResult {
  allocationSol: number;
  isExceptional: boolean;
  apeBudgetApplied: number;
}

export async function calculateAllocation(
  userId: number,
  currentBalance: number,
  clusterMatchConfidence: number,
  trajectoryScore: number,
  baseAllocationPerPosition: number,
  apeBudget: number,
  clusterType?: string
): Promise<AllocationResult> {
  // Check if this is an exceptional token (high confidence + high trajectory)
  const isExceptional = clusterMatchConfidence > 0.85 && trajectoryScore > 0.7;

  // Base allocation from budget
  let allocationSol = baseAllocationPerPosition;

  // Apply ape boost for exceptional tokens
  let apeBudgetApplied = 0;
  if (isExceptional) {
    // Get learned ape budget multiplier from retrolearner if cluster type available
    let boostMultiplier = 1.0; // Default: 2x total (base + 1x boost)
    if (clusterType) {
      const learned = await getLearnedParameters(clusterType);
      boostMultiplier = Math.min(learned.apeBudgetMultiplier, 1.0); // Cap at 1.0 for boost (2x total)
    }
    const apeBoost = baseAllocationPerPosition * boostMultiplier;
    const availableApeBudget = Math.min(apeBoost, apeBudget);
    allocationSol += availableApeBudget;
    apeBudgetApplied = availableApeBudget;
  }

  // Enforce constraints
  const maxPercentPerPosition = 0.3; // 30% max
  const minSolPerPosition = 0.01; // 1% minimum
  const maxPerPosition = currentBalance * maxPercentPerPosition;
  const minPerPosition = currentBalance * minSolPerPosition;

  // Cap at max, but respect minimum
  allocationSol = Math.min(allocationSol, maxPerPosition);
  allocationSol = Math.max(allocationSol, minPerPosition);

  // Verify we have balance
  if (allocationSol > currentBalance) {
    allocationSol = currentBalance;
    apeBudgetApplied = 0; // Ape budget not available
  }

  return {
    allocationSol,
    isExceptional,
    apeBudgetApplied,
  };
}

export async function isExceptionalToken(
  clusterMatchConfidence: number,
  trajectoryScore: number
): Promise<boolean> {
  return clusterMatchConfidence > 0.85 && trajectoryScore > 0.7;
}

export async function updateApeBudgetAfterPosition(
  userId: number,
  realizedPnlPercent: number
): Promise<void> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  if (budget.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const budgetRecord = budget[0];

  // Check if weekly reset needed (7 days = 604800 seconds)
  const lastReset = budgetRecord.apeBudgetResetAt || now;
  const needsReset = now - lastReset > 604800;

  let newApeBudget = budgetRecord.apeBudget || 0;
  let newMultiplier = budgetRecord.apeBudgetMultiplier || 1.0;
  let newResetTime = lastReset;

  if (needsReset) {
    // Weekly reset: reset ape budget to 0, multiplier to 1.0
    newApeBudget = 0;
    newMultiplier = 1.0;
    newResetTime = now;
  } else {
    // Update ape budget based on realized P&L
    // Grow if profitable (realizedPnlPercent > 0), shrink if losing
    const pnlFactor = 1 + realizedPnlPercent / 100; // e.g., 15% gain = 1.15x multiplier
    newMultiplier = Math.max(0.5, Math.min(3.0, newMultiplier * pnlFactor)); // Keep between 0.5x and 3.0x

    // Cap total ape budget at 30% of initial balance (use currentBalance as proxy)
    const maxApeBudget = 0.3; // This should be calculated based on initial fund size
    newApeBudget = Math.min(newApeBudget * newMultiplier, maxApeBudget);
  }

  await db
    .update(positionBudgets)
    .set({
      apeBudget: newApeBudget,
      apeBudgetMultiplier: newMultiplier,
      apeBudgetResetAt: newResetTime,
      updatedAt: now,
    })
    .where(eq(positionBudgets.userId, userId));
}

export async function topUpApeBudgetIfEarned(
  userId: number,
  winRate: number,
  profitFactor: number
): Promise<void> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  if (budget.length === 0) return;

  // Topup conditions: win rate > 55% and profit factor > 1.2
  if (winRate > 0.55 && profitFactor > 1.2) {
    const currentMultiplier = budget[0].apeBudgetMultiplier || 1.0;
    const newMultiplier = Math.min(2.5, currentMultiplier * 1.1); // 10% increase, capped at 2.5x

    const now = Math.floor(Date.now() / 1000);
    await db
      .update(positionBudgets)
      .set({
        apeBudgetMultiplier: newMultiplier,
        updatedAt: now,
      })
      .where(eq(positionBudgets.userId, userId));
  }
}

export async function getApeBudgetStatus(userId: number): Promise<{ apeBudget: number; multiplier: number; nextResetAt: number } | null> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  if (budget.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const lastReset = budget[0].apeBudgetResetAt || now;
  const nextResetAt = lastReset + 604800; // 7 days

  return {
    apeBudget: budget[0].apeBudget || 0,
    multiplier: budget[0].apeBudgetMultiplier || 1.0,
    nextResetAt,
  };
}
