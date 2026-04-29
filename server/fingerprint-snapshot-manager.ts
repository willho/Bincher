import { db } from "./db";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { tokenFingerprintSnapshots, rawTokenTrades, holderSnapshots } from "@shared/schema";
import { getTopHoldersWithPnL } from "./snapshot-holder-pnl-calculator";
import { latencyMonitor } from "./latency-monitor";

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
 * Helper: get creation price from first trade
 */
async function getPriceAtCreation(tokenMint: string): Promise<number> {
  const firstTrade = await db.query.rawTokenTrades.findFirst({
    where: eq(rawTokenTrades.tokenMint, tokenMint),
    orderBy: (trades, { asc }) => asc(trades.timestamp),
  });

  if (!firstTrade) return 0.00001;
  return firstTrade.price ?? 0.00001;
}

/**
 * Helper: calculate trade metrics since last snapshot
 */
async function getTradeMetricsSinceLastSnapshot(
  tokenMint: string,
  lastSnapshotTime: number
): Promise<{
  tradeCount: number;
  uniqueTraders: number;
  volumeSol: number;
}> {
  const trades = await db.query.rawTokenTrades.findMany({
    where: and(
      eq(rawTokenTrades.tokenMint, tokenMint),
      gte(rawTokenTrades.timestamp, lastSnapshotTime)
    ),
  });

  const uniqueWallets = new Set(trades.map(t => t.walletAddress));
  const volumeSol = trades.reduce((sum, t) => sum + (t.amountSol || 0), 0);

  return {
    tradeCount: trades.length,
    uniqueTraders: uniqueWallets.size,
    volumeSol,
  };
}

/**
 * Helper: track top 20 holder exits between snapshots
 */
async function getHolderExitsSinceLastSnapshot(
  tokenMint: string,
  lastSnapshotTime: number,
  previousTop20Holders: string[]
): Promise<number> {
  if (previousTop20Holders.length === 0) return 0;

  // Find sells from previous top 20 holders after last snapshot
  const exitTrades = await db.query.rawTokenTrades.findMany({
    where: and(
      eq(rawTokenTrades.tokenMint, tokenMint),
      eq(rawTokenTrades.direction, "sell"),
      gte(rawTokenTrades.timestamp, lastSnapshotTime)
    ),
  });

  const exitWallets = new Set(
    exitTrades
      .filter(t => previousTop20Holders.includes(t.walletAddress))
      .map(t => t.walletAddress)
  );

  return exitWallets.size;
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
    walletAddresses: top20Holders.map(h => h.walletAddress), // For leaderboard lookups
  };

  // Get worst-case latency and slippage from last 3 seconds
  const { worstLatencyMs, worstSlippagePercent } =
    latencyMonitor.getWorstInWindow(3);

  // Get creation price
  const creationPrice = await getPriceAtCreation(tokenMint);

  // Get all trades since token creation to calculate trajectory
  const creationTime = Math.floor(Date.now() / 1000) - tokenAgeSeconds;
  const allTrades = await db.query.rawTokenTrades.findMany({
    where: and(
      eq(rawTokenTrades.tokenMint, tokenMint),
      gte(rawTokenTrades.timestamp, creationTime)
    ),
  });

  const uniqueTradersSinceCreation = new Set(
    allTrades.map(t => t.walletAddress)
  ).size;
  const volumeSolSinceCreation = allTrades.reduce(
    (sum, t) => sum + (t.amountSol || 0),
    0
  );

  // Track exits of previous top holders
  let top20ExitCount = 0;
  if (lastSnapshot) {
    const lastHolderSnapshot = await db.query.holderSnapshots.findFirst({
      where: and(
        eq(holderSnapshots.tokenMint, tokenMint),
        gte(holderSnapshots.snapshotTime, lastSnapshot.timestamp)
      ),
      orderBy: desc(holderSnapshots.snapshotTime),
    });

    if (lastHolderSnapshot?.topHolders) {
      const previousTopHolders = new Set(
        (lastHolderSnapshot.topHolders as any[]).map(h => h.address)
      );

      const exitTrades = await db.query.rawTokenTrades.findMany({
        where: and(
          eq(rawTokenTrades.tokenMint, tokenMint),
          eq(rawTokenTrades.direction, "sell"),
          gte(rawTokenTrades.timestamp, lastSnapshot.timestamp)
        ),
      });

      top20ExitCount = new Set(
        exitTrades
          .filter(t => previousTopHolders.has(t.walletAddress))
          .map(t => t.walletAddress)
      ).size;
    }
  }

  // Calculate concentration shift from top 20 holder metrics
  let concentrationShift = 0;
  if (lastSnapshot && top20HolderMetrics) {
    const lastMetrics = lastSnapshot.top20HolderMetrics as any;
    if (lastMetrics?.maxMultiplier) {
      concentrationShift = Math.abs(
        (top20HolderMetrics.maxMultiplier - lastMetrics.maxMultiplier) /
          lastMetrics.maxMultiplier
      ) * 100;
    }
  }

  // Build trajectory anchored (arc from 0 to this snapshot)
  const trajectoryAnchored = {
    priceChange: creationPrice > 0 ? ((currentPrice / creationPrice) - 1) * 100 : 0,
    tradeCount: allTrades.length,
    uniqueTraders: uniqueTradersSinceCreation,
    volumeSol: volumeSolSinceCreation,
    top20Exited: top20ExitCount,
    concentrationShift,
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
      worstLatencyMs, // Worst Jupiter quote latency in last 3 sec
      worstSlippagePercent, // Worst slippage in last 3 sec
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

