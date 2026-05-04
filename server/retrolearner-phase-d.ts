import { db } from "./db";
import { clusterLearnings, activePositions } from "@shared/schema";
import { eq } from "drizzle-orm";

const ALPHA = 0.15; // EMA smoothing factor (15% new data, 85% old)
const MIN_SAMPLE_SIZE = 15; // Min trades before updating parameter
const TSL_SHIFT_CAP = 2; // TSL can move ±2% per cycle
const THRESHOLD_SHIFT_CAP = 5; // Threshold can shift ±5 points per cycle
const APE_BUDGET_SHIFT_CAP = 0.1; // Multiplier can move ±0.1 per cycle

/**
 * Record completed position outcome for learning
 */
export async function recordPositionOutcome(
  clusterType: string,
  exitReason: string,
  realizedPnlPercent: number,
  holdMinutes: number,
  trajectoryAtExit: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Get or create cluster learning record
  let cluster = await db
    .select()
    .from(clusterLearnings)
    .where(eq(clusterLearnings.clusterType, clusterType))
    .limit(1);

  if (cluster.length === 0) {
    // Initialize with defaults
    await db.insert(clusterLearnings).values({
      clusterType,
      learnedTslPercent: getDefaultTsl(clusterType),
      learnedTrajectoryThreshold: getDefaultTrajectoryThreshold(clusterType),
      learnedApeBudgetMultiplier: 1.0,
      cycleStartAt: now,
      createdAt: now,
    });
    cluster = await db
      .select()
      .from(clusterLearnings)
      .where(eq(clusterLearnings.clusterType, clusterType))
      .limit(1);
  }

  const c = cluster[0];

  // Determine confidence of this outcome
  let outcomeConfidence = 0.5; // Base confidence
  if (Math.abs(realizedPnlPercent) > 30) outcomeConfidence = 0.9; // High gains/losses = high signal
  if (Math.abs(realizedPnlPercent) < 10) outcomeConfidence = 0.2; // Near-zero = low signal
  if (realizedPnlPercent > 0 && realizedPnlPercent < 5) outcomeConfidence = 0.1; // Noise

  // Update recent performance tracking (rolling window logic)
  const winOrLoss = realizedPnlPercent > 0 ? 1 : 0;
  const newWinRate = (1 - ALPHA) * (c.recentWinRate || 0.5) + ALPHA * winOrLoss;

  // Update learning parameters if sample size sufficient
  const updates: any = {
    recentWinRate: newWinRate,
    recentProfitFactor: updateProfitFactor(c.recentProfitFactor || 1, realizedPnlPercent),
    recentAvgPnlPercent: (1 - ALPHA) * (c.recentAvgPnlPercent || 0) + ALPHA * realizedPnlPercent,
    updatedAt: now,
  };

  // Increment sample counts
  updates.tslSampleCount = (c.tslSampleCount || 0) + 1;
  updates.trajectoryThresholdSampleCount = (c.trajectoryThresholdSampleCount || 0) + 1;
  updates.apeBudgetSampleCount = (c.apeBudgetSampleCount || 0) + 1;

  // Learn TSL: if exit reason is TSL hit and we can learn from it
  if (exitReason === "tsl_hit" && updates.tslSampleCount >= MIN_SAMPLE_SIZE) {
    const suggestedTsl = suggestTslAdjustment(newWinRate, c.learnedTslPercent || 15);
    if (canShiftParameter(c.lastTslShiftAt, c.tslShiftCount, 0)) {
      updates.learnedTslPercent = applyDampeningFilter(
        c.learnedTslPercent || 15,
        suggestedTsl,
        TSL_SHIFT_CAP
      );
      updates.tslConfidence = Math.min(1, (updates.tslSampleCount / 20) * outcomeConfidence);
      updates.lastTslShiftAt = now;
      updates.tslShiftCount = (c.tslShiftCount || 0) + 1;
    }
  }

  // Learn trajectory threshold: if trajectory collapse and we can learn from it
  if (exitReason === "trajectory_collapse" && updates.trajectoryThresholdSampleCount >= MIN_SAMPLE_SIZE) {
    const suggestedThreshold = suggestThresholdAdjustment(realizedPnlPercent, c.learnedTrajectoryThreshold || 0.5);
    if (canShiftParameter(c.lastThresholdShiftAt, c.thresholdShiftCount, 1)) {
      updates.learnedTrajectoryThreshold = applyDampeningFilter(
        c.learnedTrajectoryThreshold || 0.5,
        suggestedThreshold,
        THRESHOLD_SHIFT_CAP / 100
      );
      updates.trajectoryConfidence = Math.min(1, (updates.trajectoryThresholdSampleCount / 20) * outcomeConfidence);
      updates.lastThresholdShiftAt = now;
      updates.thresholdShiftCount = (c.thresholdShiftCount || 0) + 1;
    }
  }

  // Learn ape budget: if win rate improves and profit factor good
  if (newWinRate > 0.55 && updates.apeBudgetSampleCount >= MIN_SAMPLE_SIZE) {
    if (canShiftParameter(c.lastApeBudgetShiftAt, c.apeBudgetShiftCount, 2)) {
      const currentMultiplier = c.learnedApeBudgetMultiplier || 1.0;
      const suggestedMultiplier = currentMultiplier * 1.05; // 5% boost per strong outcome
      updates.learnedApeBudgetMultiplier = Math.min(2.5, applyDampeningFilter(
        currentMultiplier,
        suggestedMultiplier,
        APE_BUDGET_SHIFT_CAP
      ));
      updates.apeBudgetConfidence = Math.min(1, (updates.apeBudgetSampleCount / 20) * outcomeConfidence);
      updates.lastApeBudgetShiftAt = now;
      updates.apeBudgetShiftCount = (c.apeBudgetShiftCount || 0) + 1;
    }
  }

  // Check if cycle should reset (weekly)
  if (c.cycleStartAt && now - c.cycleStartAt > 7 * 86400) {
    updates.cycleStartAt = now;
    updates.tslShiftCount = 0;
    updates.thresholdShiftCount = 0;
    updates.apeBudgetShiftCount = 0;
    updates.cycleResets = (c.cycleResets || 0) + 1;
  }

  // Update database
  await db.update(clusterLearnings).set(updates).where(eq(clusterLearnings.clusterType, clusterType));
}

/**
 * Exponential moving average dampening filter
 * Smooths parameter changes to prevent whiplash
 */
function applyDampeningFilter(
  currentValue: number,
  suggestedValue: number,
  maxShift: number
): number {
  // Apply EMA
  const newValue = (1 - ALPHA) * currentValue + ALPHA * suggestedValue;

  // Cap the shift
  const shift = newValue - currentValue;
  if (Math.abs(shift) > maxShift) {
    return currentValue + (shift > 0 ? maxShift : -maxShift);
  }

  // Apply sensible range limits
  if (newValue < 5) return 5; // TSL/threshold minimum
  if (newValue > 40) return 40; // TSL maximum

  return newValue;
}

/**
 * Check if parameter can shift (enforce caps per cycle)
 */
function canShiftParameter(lastShiftAt: number | null | undefined, shiftCount: number | null | undefined, paramType: number): boolean {
  const count = shiftCount || 0;
  if (paramType === 0) return count < 5; // TSL can shift up to 5x per cycle
  if (paramType === 1) return count < 5; // Threshold can shift up to 5x per cycle
  if (paramType === 2) return count < 5; // Ape budget can shift up to 5x per cycle
  return false;
}

/**
 * Suggest TSL adjustment based on win rate
 */
function suggestTslAdjustment(winRate: number, currentTsl: number): number {
  // If win rate improving: loosen TSL (allow more profit taking)
  // If win rate declining: tighten TSL (exit faster)
  if (winRate > 0.6) {
    return Math.min(30, currentTsl + 2); // Loosen by 2%
  } else if (winRate < 0.4) {
    return Math.max(5, currentTsl - 2); // Tighten by 2%
  }
  return currentTsl;
}

/**
 * Suggest trajectory threshold adjustment
 */
function suggestThresholdAdjustment(realizedPnlPercent: number, currentThreshold: number): number {
  // If trade was profitable and we exited early: lower threshold (exit earlier next time)
  // If trade was loss and we exited late: raise threshold (hold longer)
  if (realizedPnlPercent > 20) {
    return Math.max(0.1, currentThreshold - 0.05); // Raise exit sensitivity
  } else if (realizedPnlPercent < -20) {
    return Math.min(0.9, currentThreshold + 0.05); // Lower exit sensitivity
  }
  return currentThreshold;
}

/**
 * Update profit factor (wins / losses)
 */
function updateProfitFactor(currentFactor: number, realizedPnlPercent: number): number {
  const multiplier = realizedPnlPercent > 0 ? 1.1 : 0.9;
  return Math.max(0.5, Math.min(3, (1 - ALPHA) * currentFactor + ALPHA * (currentFactor * multiplier)));
}

/**
 * Get default TSL for cluster type
 */
export function getDefaultTsl(clusterType: string): number {
  const defaults: { [key: string]: number } = {
    spike_and_bleed: 15,
    slow_moon: 20,
    pump_and_dump: 10,
    early_movers: 18,
  };
  return defaults[clusterType] || 15;
}

/**
 * Get default trajectory threshold for cluster type
 */
export function getDefaultTrajectoryThreshold(clusterType: string): number {
  const defaults: { [key: string]: number } = {
    spike_and_bleed: 0.45,
    slow_moon: 0.55,
    pump_and_dump: 0.35,
    early_movers: 0.5,
  };
  return defaults[clusterType] || 0.5;
}

/**
 * Get current learned parameters for cluster
 */
export async function getLearnedParameters(clusterType: string): Promise<{
  tslPercent: number;
  trajectoryThreshold: number;
  apeBudgetMultiplier: number;
  confidence: number;
}> {
  const cluster = await db
    .select()
    .from(clusterLearnings)
    .where(eq(clusterLearnings.clusterType, clusterType))
    .limit(1);

  if (cluster.length === 0) {
    return {
      tslPercent: getDefaultTsl(clusterType),
      trajectoryThreshold: getDefaultTrajectoryThreshold(clusterType),
      apeBudgetMultiplier: 1.0,
      confidence: 0,
    };
  }

  const c = cluster[0];
  const avgConfidence =
    ((c.tslConfidence || 0) + (c.trajectoryConfidence || 0) + (c.apeBudgetConfidence || 0)) / 3;

  return {
    tslPercent: c.learnedTslPercent || getDefaultTsl(clusterType),
    trajectoryThreshold: c.learnedTrajectoryThreshold || getDefaultTrajectoryThreshold(clusterType),
    apeBudgetMultiplier: c.learnedApeBudgetMultiplier || 1.0,
    confidence: avgConfidence,
  };
}

/**
 * Get all cluster learning metrics
 */
export async function getAllClusterMetrics(): Promise<Array<{
  clusterType: string;
  learnedTslPercent: number;
  learnedTrajectoryThreshold: number;
  learnedApeBudgetMultiplier: number;
  recentWinRate: number;
  recentProfitFactor: number;
  recentAvgPnlPercent: number;
  sampleSize: number;
}>> {
  const clusters = await db.select().from(clusterLearnings);

  return clusters.map(c => ({
    clusterType: c.clusterType,
    learnedTslPercent: c.learnedTslPercent,
    learnedTrajectoryThreshold: c.learnedTrajectoryThreshold,
    learnedApeBudgetMultiplier: c.learnedApeBudgetMultiplier,
    recentWinRate: c.recentWinRate || 0.5,
    recentProfitFactor: c.recentProfitFactor || 1.0,
    recentAvgPnlPercent: c.recentAvgPnlPercent || 0,
    sampleSize: Math.max(c.tslSampleCount || 0, c.trajectoryThresholdSampleCount || 0, c.apeBudgetSampleCount || 0),
  }));
}
