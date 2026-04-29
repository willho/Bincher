import { db } from "./db";
import { eq, and, gte, desc } from "drizzle-orm";
import { tokenFingerprintSnapshots } from "@shared/schema";
import { getTopHoldersWithPnL } from "./snapshot-holder-pnl-calculator";

/**
 * Fingerprint Snapshot Manager
 *
 * Manages trade-gated, trajectory-aware snapshots that capture token evolution.
 * Snapshots fire on:
 * 1. Creation (T+0, unconditional)
 * 2. Time-based schedule (trade-gated, T+0 to T+24h)
 * 3. Price movement milestones (±30% since last snapshot)
 * 4. Trade volume milestones (every 250 trades, after T+24h)
 */

interface SnapshotTriggerCheck {
  shouldSnapshot: boolean;
  trigger: "creation" | "time_based" | "price_milestone" | "trade_volume";
  triggerValue?: string;
}

/**
 * Check if token should fire a time-based snapshot
 */
function shouldFireTimeBasedSnapshot(
  tokenAgeSeconds: number,
  lastSnapshotTime: number
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const timeSinceLastSnapshot = now - lastSnapshotTime;

  // First 10 minutes: every 1 minute
  if (tokenAgeSeconds < 600) {
    return timeSinceLastSnapshot >= 60;
  }

  // Next 50 minutes (10-60 min): every 10 minutes
  if (tokenAgeSeconds < 3600) {
    return timeSinceLastSnapshot >= 600;
  }

  // After 1 hour: every hour
  return timeSinceLastSnapshot >= 3600;
}

/**
 * Check if price moved ±30% since last snapshot
 */
function checkPriceMovementMilestone(
  currentPrice: number,
  lastSnapshotPrice: number
): SnapshotTriggerCheck {
  const PRICE_MOVEMENT_THRESHOLD = 0.30; // ±30% symmetric

  const priceChange = Math.abs(
    (currentPrice - lastSnapshotPrice) / lastSnapshotPrice
  );

  if (priceChange >= PRICE_MOVEMENT_THRESHOLD) {
    const direction = currentPrice > lastSnapshotPrice ? "+" : "-";
    const percent = (priceChange * 100).toFixed(1);
    return {
      shouldSnapshot: true,
      trigger: "price_milestone",
      triggerValue: `${direction}${percent}%`,
    };
  }

  return { shouldSnapshot: false, trigger: "price_milestone" };
}

/**
 * Check if we've passed 250 trades since last snapshot (after 24h)
 */
function checkTradeVolumeMilestone(
  tokenAgeSeconds: number,
  tradeCountSinceLastSnapshot: number
): SnapshotTriggerCheck {
  const TRADE_VOLUME_THRESHOLD = 250;
  const ONE_DAY_SECONDS = 86400;

  // Only trigger after 24 hours
  if (tokenAgeSeconds < ONE_DAY_SECONDS) {
    return { shouldSnapshot: false, trigger: "trade_volume" };
  }

  if (tradeCountSinceLastSnapshot >= TRADE_VOLUME_THRESHOLD) {
    return {
      shouldSnapshot: true,
      trigger: "trade_volume",
      triggerValue: `${tradeCountSinceLastSnapshot}_trades`,
    };
  }

  return { shouldSnapshot: false, trigger: "trade_volume" };
}

/**
 * Create a new fingerprint snapshot
 */
export async function createFingerprintSnapshot(
  tokenMint: string,
  tokenCreationTime: number,
  currentPrice: number,
  features: number[], // 55-dimensional feature vector
  trigger: string,
  triggerValue?: string
) {
  const now = Math.floor(Date.now() / 1000);
  const tokenAgeSeconds = now - tokenCreationTime;

  // Get the highest existing snapshot number
  const lastSnapshot = await db.query.tokenFingerprintSnapshots.findFirst({
    where: eq(tokenFingerprintSnapshots.tokenMint, tokenMint),
    orderBy: desc(tokenFingerprintSnapshots.snapshotNumber),
  });

  const snapshotNumber = (lastSnapshot?.snapshotNumber ?? 0) + 1;

  // Calculate top 20 holder metrics at this moment
  const top20Holders = await getTopHoldersWithPnL(tokenMint, currentPrice);
  const holderMultipliers = top20Holders.map((h) => h.multiplier);
  const profitableCount = holderMultipliers.filter((m) => m > 1).length;

  const top20HolderMetrics = {
    medianMultiplier:
      holderMultipliers.length > 0
        ? holderMultipliers.sort((a, b) => a - b)[
            Math.floor(holderMultipliers.length / 2)
          ]
        : 1,
    profitableCount,
    underWaterCount: 20 - profitableCount,
    minMultiplier: Math.min(...holderMultipliers),
    maxMultiplier: Math.max(...holderMultipliers),
  };

  // Build trajectory anchored (arc from 0 to this snapshot)
  const trajectoryAnchored = {
    priceChange: ((currentPrice / getPriceAtCreation(tokenMint)) - 1) * 100, // TODO: fetch creation price
    tradeCount: 0, // TODO: fetch from rawTokenTrades
    uniqueTraders: 0, // TODO: fetch from rawTokenTrades
    volumeSol: 0, // TODO: fetch from rawTokenTrades
    top20Exited: 0, // TODO: track from previous snapshots
    concentrationShift: 0, // TODO: calculate from holder data
    durationSeconds: tokenAgeSeconds,
  };

  // Create snapshot with empty trajectoryCurrent (will be backfilled as future snapshots fire)
  const [snapshot] = await db
    .insert(tokenFingerprintSnapshots)
    .values({
      tokenMint,
      timestamp: now,
      tokenAgeSeconds,
      snapshotNumber,
      positionInArc: null, // Will be calculated when token dies
      snapshotTrigger: trigger,
      triggerValue,
      trajectoryAnchored: JSON.stringify(trajectoryAnchored),
      trajectoryCurrent: JSON.stringify(trajectoryAnchored), // Starts same as anchored
      features: JSON.stringify(features),
      top20HolderMetrics: JSON.stringify(top20HolderMetrics),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Backfill: update all previous snapshots' trajectoryCurrent with this new trajectory segment
  if (lastSnapshot) {
    const trajectorySegment = {
      priceChange: ((currentPrice - lastSnapshot.price ?? currentPrice) / (lastSnapshot.price ?? currentPrice)) * 100,
      durationSeconds: now - lastSnapshot.timestamp,
      // ... other segment fields
    };

    // Append this trajectory segment to all previous snapshots' trajectoryCurrent
    const allPreviousSnapshots = await db.query.tokenFingerprintSnapshots.findMany({
      where: eq(tokenFingerprintSnapshots.tokenMint, tokenMint),
    });

    for (const prev of allPreviousSnapshots) {
      const current = JSON.parse(prev.trajectoryCurrent as string || "{}");
      // Build full arc by chaining trajectory segments
      const updatedCurrent = {
        ...current,
        // Add latest trajectory segment info
        latestSegment: trajectorySegment,
      };

      await db
        .update(tokenFingerprintSnapshots)
        .set({
          trajectoryCurrent: JSON.stringify(updatedCurrent),
          updatedAt: now,
        })
        .where(eq(tokenFingerprintSnapshots.id, prev.id));
    }
  }

  return snapshot;
}

/**
 * Determine if snapshot should fire based on current state
 */
export async function evaluateSnapshotTrigger(
  tokenMint: string,
  tokenCreationTime: number,
  currentPrice: number,
  tradeCountSinceLastSnapshot: number
): Promise<SnapshotTriggerCheck> {
  const now = Math.floor(Date.now() / 1000);
  const tokenAgeSeconds = now - tokenCreationTime;

  // Get last snapshot
  const lastSnapshot = await db.query.tokenFingerprintSnapshots.findFirst({
    where: eq(tokenFingerprintSnapshots.tokenMint, tokenMint),
    orderBy: desc(tokenFingerprintSnapshots.timestamp),
  });

  // Check time-based (requires trade to have occurred)
  if (
    lastSnapshot &&
    tradeCountSinceLastSnapshot > 0 &&
    shouldFireTimeBasedSnapshot(tokenAgeSeconds, lastSnapshot.timestamp)
  ) {
    return { shouldSnapshot: true, trigger: "time_based" };
  }

  // Check price movement (anytime)
  if (lastSnapshot) {
    const priceCheck = checkPriceMovementMilestone(
      currentPrice,
      lastSnapshot.price ?? currentPrice
    );
    if (priceCheck.shouldSnapshot) {
      return priceCheck;
    }
  }

  // Check trade volume (after 24h)
  const volumeCheck = checkTradeVolumeMilestone(
    tokenAgeSeconds,
    tradeCountSinceLastSnapshot
  );
  if (volumeCheck.shouldSnapshot) {
    return volumeCheck;
  }

  return { shouldSnapshot: false, trigger: "time_based" };
}

/**
 * Helper: get creation price (placeholder - needs implementation)
 */
function getPriceAtCreation(tokenMint: string): number {
  // TODO: fetch from tokenDataPool or first snapshot
  return 0.00001; // Placeholder
}
