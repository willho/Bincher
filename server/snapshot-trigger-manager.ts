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
    const isUnlocked = updated[downKey] === true; // Has dropped >50% away

    if (current >= milestone && !triggered) {
      // First time hitting this milestone
      newSnapshots.push({ trigger: key, type: "up" });
      updated[key] = true;
      updated[downKey] = false; // Mark: not yet unlocked (no 50% drop yet)
    } else if (current >= milestone && triggered && isUnlocked && prev < milestone * 0.5) {
      // Recovery: price previously dropped >50% away (unlocked), now bouncing back through milestone
      newSnapshots.push({ trigger: recoveryKey, type: "recovery" });
      updated[downKey] = false; // Re-lock after recovery snapshot
      // Don't reset triggered; milestone stays active
    } else if (current < milestone * 0.5 && triggered && !isUnlocked) {
      // Price dropped >50% away for first time, unlock for potential recovery
      updated[downKey] = true;
    }
  }

  // Downward milestones: 0.5x, 0.1x, 0.01x
  const downwardMilestones = [0.5, 0.1, 0.01];

  for (const milestone of downwardMilestones) {
    const key = `price_${milestone.toFixed(2)}x_down`;
    const triggered = updated[key] ?? false;

    if (current <= milestone && prev > milestone && !triggered) {
      // Crossing downward through milestone (triggers once per crash cycle)
      newSnapshots.push({ trigger: key, type: "down" });
      updated[key] = true;
    } else if (current > milestone * 2 && triggered) {
      // Price recovered 100%+ back above 2x the milestone
      // Reset for next crash (allows re-trigger if crashes down again)
      updated[key] = false;
    }
  }

  // Trade-count milestones: 50, 100, 150, ... NO CAP (all trades until compression)
  // Keep creating snapshots for every 50 trades indefinitely
  // Retrolearner will summarize trades after ingestion
  let tradeBlock = 1;
  while (state.totalTradeCount >= tradeBlock * 50) {
    const tradeCount = tradeBlock * 50;
    const key = `trade_${tradeCount}`;
    const triggered = updated[key] ?? false;

    if (!triggered) {
      newSnapshots.push({ trigger: key, type: "up" });
      updated[key] = true;
    }
    tradeBlock++;
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
/**
 * Detect if token has reached true deathbed state (fundamentally dead, won't recover)
 *
 * NEW STRATEGY: Don't auto-deathbed based on volume/trades
 * Keep ALL tokens alive for snapshots and trades
 * Compression happens via storage-aware retrolearner (compressTradesIfNeeded)
 * with priority: dead tokens first, then low-volume tokens
 *
 * Only mark deathbed for:
 * 1. Extreme crashes (worthless)
 * 2. Explicit graduation/rug confirmation from retrolearner
 */
export function isTokenDeathbed(
  state: TokenState,
  now: number
): boolean {
  // Only deathbed if token crashed to essentially worthless
  // <0.001x = 1000x loss, unlikely to ever recover
  if (state.currentMultiplier < 0.001) {
    return true;
  }

  // Otherwise, keep token alive for all snapshots and trades
  return false;
}

/**
 * Update token snapshot state after snapshot creation
 * @param tokenMint - Token mint address
 * @param now - Current timestamp (seconds)
 * @param totalTradeCountNow - Total trade count at this moment (cumulative)
 * @param multiplier - Current price multiplier
 * @param triggeredMilestones - Milestone state map
 * @param isDeathbed - If true, mark token as deathbed
 */
export async function updateTokenSnapshotState(
  tokenMint: string,
  now: number,
  totalTradeCountNow: number,
  multiplier: number,
  triggeredMilestones: Record<string, boolean>,
  isDeathbed: boolean = false
): Promise<void> {
  // Get current snapshot count and increment
  const currentToken = await db
    .select({ snapshotsCount: tokenDataPool.snapshotsCount })
    .from(tokenDataPool)
    .where(eq(tokenDataPool.tokenMint, tokenMint))
    .limit(1)
    .then((rows) => rows[0]);

  const newSnapshotCount = (currentToken?.snapshotsCount || 0) + 1;

  const updates: Record<string, any> = {
    lastSnapshotAt: now,
    lastSnapshotTradeCount: totalTradeCountNow,
    totalTradeCount: totalTradeCountNow,
    lastMilestoneMultiplier: multiplier,
    triggeredMilestones,
    snapshotsCount: newSnapshotCount, // Increment on each snapshot
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
