import { db } from "./db";
import { activePositions } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { updateApeBudgetAfterPosition } from "./position-allocator";

interface ExitResult {
  success: boolean;
  positionId: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  moonbagAmount: number;
  exitReason: string;
  message: string;
}

export async function exitPosition(
  positionId: number,
  exitReason: "tsl_hit" | "trajectory_collapse" | "time_stop" | "profit_take" | "user_manual",
  exitPrice: number,
  userId: number
): Promise<ExitResult> {
  const position = await db
    .select()
    .from(activePositions)
    .where(and(eq(activePositions.id, positionId), eq(activePositions.userId, userId)))
    .limit(1);

  if (position.length === 0) {
    return {
      success: false,
      positionId,
      realizedPnl: 0,
      realizedPnlPercent: 0,
      moonbagAmount: 0,
      exitReason,
      message: "Position not found",
    };
  }

  const pos = position[0];
  const now = Math.floor(Date.now() / 1000);

  // Calculate P&L
  const exitValue = exitPrice * pos.entrySol; // Approximate exit value
  const entryValue = pos.entryPrice * pos.entrySol;
  const realizedPnl = exitValue - entryValue;
  const realizedPnlPercent = (realizedPnl / entryValue) * 100;

  // Moonbag logic: leave 5-10% on trajectory collapse if profitable
  let moonbagAmount = 0;
  if (exitReason === "trajectory_collapse" && realizedPnlPercent > 10) {
    moonbagAmount = pos.entrySol * 0.075; // 7.5% moonbag
  }

  // Update position record with exit info
  const closedAtTime = now;
  await db
    .update(activePositions)
    .set({
      exitReason,
      realizedPnl,
      realizedPnlPercent,
      moonbagAmount,
      closedAt: closedAtTime,
      updatedAt: now,
    })
    .where(eq(activePositions.id, positionId));

  // Update ape budget based on outcome
  await updateApeBudgetAfterPosition(userId, realizedPnlPercent);

  // Phase D: Record outcome for retrolearner
  try {
    const { recordPositionOutcome } = await import("./retrolearner-phase-d");
    const holdMinutes = (closedAtTime - pos.openedAt) / 60;
    const trajectoryAtExit = pos.currentTrajectoryScore || 0;

    // Extract cluster type from entry clusters (first cluster if multiple)
    let clusterType = "unknown";
    if (pos.entryClusters && Array.isArray(pos.entryClusters)) {
      const clusters = pos.entryClusters as Array<{ cluster: string }>;
      if (clusters.length > 0) {
        clusterType = clusters[0].cluster;
      }
    }

    await recordPositionOutcome(
      clusterType,
      exitReason,
      realizedPnlPercent,
      holdMinutes,
      trajectoryAtExit
    );
  } catch (err) {
    console.error("[RetrolearnerHook] Failed to record outcome:", err);
  }

  return {
    success: true,
    positionId,
    realizedPnl,
    realizedPnlPercent,
    moonbagAmount,
    exitReason,
    message: `Exited ${pos.tokenSymbol} at ${exitPrice.toFixed(6)} SOL: ${realizedPnlPercent >= 0 ? "+" : ""}${realizedPnlPercent.toFixed(1)}% (${moonbagAmount > 0 ? `${moonbagAmount.toFixed(4)} SOL moonbag left` : "no moonbag"})`,
  };
}

export async function analyzeOutcomes(userId: number): Promise<{
  totalPositions: number;
  winningPositions: number;
  losingPositions: number;
  averageHoldMinutes: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
}> {
  // Get all closed positions for this user
  const closedPositions = await db
    .select()
    .from(activePositions)
    .where(and(eq(activePositions.userId, userId), isNull(activePositions.closedAt) === false));

  if (closedPositions.length === 0) {
    return {
      totalPositions: 0,
      winningPositions: 0,
      losingPositions: 0,
      averageHoldMinutes: 0,
      winRate: 0,
      profitFactor: 1,
      totalPnl: 0,
    };
  }

  let winningCount = 0;
  let losingCount = 0;
  let totalPnl = 0;
  let totalHoldSeconds = 0;
  let totalWins = 0;
  let totalLosses = 0;

  for (const pos of closedPositions) {
    const pnl = pos.realizedPnl || 0;
    totalPnl += pnl;

    if (pnl > 0) {
      winningCount++;
      totalWins += pnl;
    } else if (pnl < 0) {
      losingCount++;
      totalLosses += Math.abs(pnl);
    }

    const holdTime = (pos.closedAt || 0) - pos.openedAt;
    totalHoldSeconds += holdTime;
  }

  const averageHoldMinutes = totalHoldSeconds > 0 ? totalHoldSeconds / closedPositions.length / 60 : 0;
  const winRate = closedPositions.length > 0 ? winningCount / closedPositions.length : 0;
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 1;

  return {
    totalPositions: closedPositions.length,
    winningPositions: winningCount,
    losingPositions: losingCount,
    averageHoldMinutes,
    winRate,
    profitFactor: Math.min(profitFactor, 999), // Cap extremely high ratios
    totalPnl,
  };
}

export async function leaveMoonbag(
  positionId: number,
  moonbagSizePercent: number = 7.5
): Promise<{ success: boolean; moonbagAmount: number; message: string }> {
  const position = await db
    .select()
    .from(activePositions)
    .where(eq(activePositions.id, positionId))
    .limit(1);

  if (position.length === 0) {
    return {
      success: false,
      moonbagAmount: 0,
      message: "Position not found",
    };
  }

  const pos = position[0];
  const moonbagAmount = pos.entrySol * (moonbagSizePercent / 100);

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(activePositions)
    .set({
      moonbagAmount,
      updatedAt: now,
    })
    .where(eq(activePositions.id, positionId));

  return {
    success: true,
    moonbagAmount,
    message: `Moonbag set to ${moonbagAmount.toFixed(4)} SOL (${moonbagSizePercent}% of entry)`,
  };
}

export async function recordExitMetadata(
  positionId: number,
  exitReason: string,
  metadata: {
    exitPrice: number;
    holdMinutes: number;
    priceAtExit: number;
    clusterType?: string;
    trajectoryAtExit?: number;
  }
): Promise<void> {
  // Metadata recorded in position record via exitReason field
  // Additional metadata could be stored in a separate audit table if needed
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(activePositions)
    .set({
      exitReason,
      updatedAt: now,
    })
    .where(eq(activePositions.id, positionId));
}

export async function getMoonbags(userId: number): Promise<Array<{ id: number; tokenSymbol: string; moonbagAmount: number }>> {
  const moonbags = await db
    .select()
    .from(activePositions)
    .where(and(eq(activePositions.userId, userId), eq(activePositions.moonbagAmount, null) === false));

  return moonbags
    .filter(m => (m.moonbagAmount || 0) > 0)
    .map(m => ({
      id: m.id,
      tokenSymbol: m.tokenSymbol,
      moonbagAmount: m.moonbagAmount || 0,
    }));
}
