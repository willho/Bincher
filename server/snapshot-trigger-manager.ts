import { db } from "./db";
import { tokenDataPool, tokenFingerprints } from "@shared/schema";
import { eq } from "drizzle-orm";

/**
 * Snapshot Trigger Manager
 *
 * Activity-gated snapshot creation with volatility-protected milestones:
 * - Every 1min for first 10min (if trade since last snapshot)
 * - Every 10min for next 50min (if trade since last snapshot)
 * - Every hour for next 24hr (if trade since last snapshot)
 * - Milestones only after 24hr
 *
 * Milestone volatility buffers:
 * - Upward milestones (2x, 5x, 10x): lock until 50% drop, re-trigger on recovery
 * - Downward milestones (0.5x, 0.1x, 0.01x): lock until 100% recovery (2x bounce), re-trigger on re-crash
 */

interface TokenState {
  mint: string;
  createdAt: number; // Token creation timestamp
  currentMultiplier: number; // Current price multiplier vs entry
  lastSnapshotAt: number | null;
  lastSnapshotTradeCount: number;
  totalTradeCount: number;
  triggeredMilestones: Record<string, boolean>; // {price_2x: true, price_2x_down: false, ...}
  lastMilestoneMultiplier: number | null;
}

/**
 * Determine if time-based snapshot should trigger
 * Only triggers if:
 * 1. Enough time has passed since last snapshot
 * 2. At least one trade occurred since last snapshot
 */
export function shouldCreateTimeBasedSnapshot(
  now: number,
  state: TokenState
): { should: boolean; reason?: string; trigger?: string } {
  if (!state.lastSnapshotAt) {
    return { should: true, reason: "First snapshot", trigger: "time_initial" };
  }

  const tokenAgeSeconds = now - state.createdAt;
  const timeSinceLastSnapshot = now - state.lastSnapshotAt;

  // Check if trades occurred since last snapshot
  const hasNewTrades = state.totalTradeCount > state.lastSnapshotTradeCount;
  if (!hasNewTrades) {
    return { should: false, reason: "No trades since last snapshot" };
  }

  // Time-based intervals based on token age
  let intervalSeconds: number;
  let trigger: string;

  if (tokenAgeSeconds <= 600) {
    // T+0 to T+10min: snapshot every 1 minute
    intervalSeconds = 60;
    trigger = "time_1min_if_trade";
  } else if (tokenAgeSeconds <= 3600) {
    // T+10min to T+1hr: snapshot every 10 minutes
    intervalSeconds = 600;
    trigger = "time_10min_if_trade";
  } else if (tokenAgeSeconds <= 86400) {
    // T+1hr to T+24hr: snapshot every hour
    intervalSeconds = 3600;
    trigger = "time_1hr_if_trade";
  } else {
    // T+24hr+: only milestones, no time-based
    return { should: false, reason: "Token >24hr old, milestones only" };
  }

  if (timeSinceLastSnapshot >= intervalSeconds) {
    return { should: true, reason: `${intervalSeconds}s interval passed`, trigger };
  }

  return { should: false, reason: `${intervalSeconds}s interval not yet reached` };
}

/**
 * Determine which milestone snapshots should trigger with volatility protection
 */
export function getTriggeredMilestones(
  state: TokenState,
  previousMultiplier: number | null
): {
  newSnapshots: Array<{ trigger: string; type: "up" | "down" | "recovery" }>;
  updatedMilestones: Record<string, boolean>;
} {
  const newSnapshots: Array<{ trigger: string; type: "up" | "down" | "recovery" }> = [];
  const updated = { ...state.triggeredMilestones };
  const current = state.currentMultiplier;
  const prev = previousMultiplier ?? current;

  // Upward milestones: 2x, 5x, 10x, 50x, 100x, 500x, 1000x
  const upwardMilestones = [2, 5, 10, 50, 100, 500, 1000];

  for (const milestone of upwardMilestones) {
    const key = `price_${milestone}x`;
    const triggered = updated[key] ?? false;
    const downKey = `${key}_down`;
    const recoveryKey = `${key}_recovery`;

    if (current >= milestone && !triggered) {
      // First time hitting this milestone
      newSnapshots.push({ trigger: key, type: "up" });
      updated[key] = true;
      updated[downKey] = false; // Mark as not triggered on downside
    } else if (current >= milestone && triggered && prev < milestone * 0.5) {
      // Recovery: price dropped 50% away, now bouncing back
      newSnapshots.push({ trigger: recoveryKey, type: "recovery" });
      // Don't reset the milestone, just record recovery
    } else if (current < milestone * 0.5 && !updated[downKey]) {
      // Price dropped >50% away, unlock for re-triggering
      updated[downKey] = true;
      // Will re-trigger if bounces back above milestone
    }
  }

  // Downward milestones: 0.5x, 0.1x, 0.01x
  const downwardMilestones = [0.5, 0.1, 0.01];

  for (const milestone of downwardMilestones) {
    const key = `price_${(milestone * 100).toFixed(0)}x_down`;
    const recoveryKey = `price_${(milestone * 100).toFixed(0)}x_recovery`;
    const triggered = updated[key] ?? false;
    const recoveryThreshold = milestone * 2; // 100% recovery buffer (2x the milestone)

    if (current <= milestone && prev > milestone && !triggered) {
      // Crossing downward through milestone
      newSnapshots.push({ trigger: key, type: "down" });
      updated[key] = true;
      updated[recoveryKey] = false;
    } else if (current <= milestone && triggered && prev > recoveryThreshold) {
      // Re-crash: price recovered to 2x+ the milestone, now crashing back down
      newSnapshots.push({ trigger: recoveryKey, type: "down" });
      // Keep triggered, will unlock when price recovers enough again
    } else if (current > recoveryThreshold && updated[recoveryKey] === false) {
      // Price bounced back above 2x the milestone, unlock for re-crashing
      updated[recoveryKey] = true;
    }
  }

  // Trade-count milestones: 50, 100, 150, ..., 500 (capped at 10 blocks of 50)
  for (let block = 1; block <= 10; block++) {
    const tradeCount = block * 50;
    const key = `trade_${tradeCount}`;
    const triggered = updated[key] ?? false;

    if (state.totalTradeCount >= tradeCount && !triggered) {
      newSnapshots.push({ trigger: key, type: "up" });
      updated[key] = true;
    }
  }

  return { newSnapshots, updatedMilestones: updated };
}

/**
 * Detect if token has reached deathbed state
 * Deathbed = token is effectively dead and won't recover
 * Indicators:
 * - Volume <0.5% of peak 24h volume
 * - No trades for 30+ minutes
 * - Holder count drop >50% in last hour
 * - Price <0.01x entry (crashed to penny)
 */
export function isTokenDeathbed(
  state: TokenState,
  now: number,
  lastTradeAt: number | null,
  volume24h: number | null,
  peakVolume24h: number | null,
  holderCount: number | null,
  peakHolderCount: number | null
): boolean {
  // No trades in 30+ minutes
  if (lastTradeAt && now - lastTradeAt > 1800) {
    return true;
  }

  // Volume collapsed to <0.5% of peak
  if (volume24h !== null && peakVolume24h !== null && peakVolume24h > 0) {
    if (volume24h < peakVolume24h * 0.005) {
      return true;
    }
  }

  // Holder count dropped >50% in last hour
  if (holderCount !== null && peakHolderCount !== null) {
    if (holderCount < peakHolderCount * 0.5) {
      return true;
    }
  }

  // Price crashed to <0.01x (penny territory, unlikely to recover)
  if (state.currentMultiplier < 0.01) {
    return true;
  }

  return false;
}

/**
 * Update token snapshot state after snapshot creation
 */
export async function updateTokenSnapshotState(
  tokenMint: string,
  now: number,
  tradeCount: number,
  multiplier: number,
  triggeredMilestones: Record<string, boolean>,
  isDeathbed: boolean = false
): Promise<void> {
  const updates: Record<string, any> = {
    lastSnapshotAt: now,
    lastSnapshotTradeCount: tradeCount,
    totalTradeCount: tradeCount,
    lastMilestoneMultiplier: multiplier,
    triggeredMilestones,
  };

  if (isDeathbed) {
    updates.isDeathbed = true;
    updates.deathbedDetectedAt = now;
  }

  await db
    .update(tokenDataPool)
    .set(updates)
    .where(eq(tokenDataPool.tokenMint, tokenMint));
}

/**
 * Mark deathbed snapshot as created
 */
export async function markDeathbedSnapshotCreated(tokenMint: string): Promise<void> {
  await db
    .update(tokenDataPool)
    .set({ deathbedSnapshotCreated: true })
    .where(eq(tokenDataPool.tokenMint, tokenMint));
}

/**
 * Get trajectory outcome label for a completed token
 * Called by retrolearner to determine which archetype pattern token followed
 */
export function determineTrajectoryOutcome(
  maxMultiplier: number,
  minMultiplier: number,
  finalMultiplier: number,
  tokenAgeSeconds: number
): string {
  // Pump 100x+ early
  if (maxMultiplier >= 100 && tokenAgeSeconds <= 86400) {
    return "pump_100x";
  }

  // Mega pump 1000x+
  if (maxMultiplier >= 1000) {
    return "pump_1000x";
  }

  // Sustained pump (stayed >5x for a while)
  if (finalMultiplier >= 5 && maxMultiplier >= 10) {
    return "sustained_pump";
  }

  // Slow bleed (gradually declined from peak)
  if (maxMultiplier >= 2 && finalMultiplier < 0.5 && minMultiplier > 0.1) {
    return "slow_bleed";
  }

  // Fast crash (dropped hard, stayed down)
  if (maxMultiplier >= 2 && finalMultiplier < 0.1) {
    return "crash_fast";
  }

  // Penny stock (settled at low multiplier)
  if (finalMultiplier < 0.01) {
    return "penny_stock";
  }

  // Flat performance
  if (maxMultiplier < 2 && minMultiplier > 0.5) {
    return "flat";
  }

  // Default: volatile but no clear pattern
  return "volatile";
}

/**
 * Update token with trajectory outcome label (called by retrolearner)
 */
export async function setTokenTrajectoryOutcome(
  tokenMint: string,
  outcome: string
): Promise<void> {
  await db
    .update(tokenDataPool)
    .set({ trajectoryOutcomeLabel: outcome })
    .where(eq(tokenDataPool.tokenMint, tokenMint));
}

/**
 * Update snapshot count for token
 */
export async function updateTokenSnapshotCount(tokenMint: string): Promise<void> {
  const count = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .then((rows) => rows.length);

  await db
    .update(tokenDataPool)
    .set({ snapshotsCount: count })
    .where(eq(tokenDataPool.tokenMint, tokenMint));
}
