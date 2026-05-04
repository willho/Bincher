import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

const WARMUP_PERIOD_DAYS = 7;
const WARMUP_PERIOD_SECONDS = WARMUP_PERIOD_DAYS * 24 * 60 * 60;

export async function isAutoTradingEnabled(userId: number): Promise<boolean> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    return false;
  }

  // Auto-trading only enabled if explicitly set to true after warm-up completes
  if (user[0].autoTradingEnabled) {
    return true;
  }

  return false;
}

export async function getWarmupStatus(userId: number): Promise<{
  isWarmingUp: boolean;
  isComplete: boolean;
  daysRemaining: number;
  percentComplete: number;
  startedAt?: number;
  willCompleteAt?: number;
}> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    return {
      isWarmingUp: false,
      isComplete: false,
      daysRemaining: 0,
      percentComplete: 0,
    };
  }

  const startTime = user[0].warmupStartedAt;
  const enabledTime = user[0].warmupEnabledAt;

  // If warmup not started yet
  if (!startTime) {
    return {
      isWarmingUp: false,
      isComplete: false,
      daysRemaining: 0,
      percentComplete: 0,
    };
  }

  // If already enabled
  if (enabledTime && enabledTime <= Math.floor(Date.now() / 1000)) {
    return {
      isWarmingUp: false,
      isComplete: true,
      daysRemaining: 0,
      percentComplete: 100,
      startedAt: startTime,
      willCompleteAt: enabledTime,
    };
  }

  // Currently warming up
  const now = Math.floor(Date.now() / 1000);
  const elapsedSeconds = now - startTime;
  const percentComplete = Math.min(100, Math.round((elapsedSeconds / WARMUP_PERIOD_SECONDS) * 100));
  const daysRemaining = Math.ceil((WARMUP_PERIOD_SECONDS - elapsedSeconds) / (24 * 60 * 60));
  const willCompleteAt = startTime + WARMUP_PERIOD_SECONDS;

  return {
    isWarmingUp: true,
    isComplete: false,
    daysRemaining: Math.max(0, daysRemaining),
    percentComplete,
    startedAt: startTime,
    willCompleteAt,
  };
}

export async function startWarmupPeriod(userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const willCompleteAt = now + WARMUP_PERIOD_SECONDS;

  await db
    .update(users)
    .set({
      warmupStartedAt: now,
      warmupEnabledAt: willCompleteAt,
      autoTradingEnabled: false, // Reset on restart
    })
    .where(eq(users.id, userId));

  console.log(
    `[WarmupGate] Started 7-day warm-up for user ${userId} (will complete at ${new Date(
      willCompleteAt * 1000
    ).toISOString()})`
  );
}

export async function enableAutoTrading(userId: number): Promise<boolean> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    return false;
  }

  // Only enable if warmup is complete
  const now = Math.floor(Date.now() / 1000);
  if (!user[0].warmupEnabledAt || user[0].warmupEnabledAt > now) {
    console.warn(`[WarmupGate] Cannot enable auto-trading for user ${userId}: warm-up not complete`);
    return false;
  }

  await db
    .update(users)
    .set({ autoTradingEnabled: true })
    .where(eq(users.id, userId));

  console.log(`[WarmupGate] Auto-trading enabled for user ${userId}`);
  return true;
}

export async function disableAutoTrading(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ autoTradingEnabled: false })
    .where(eq(users.id, userId));

  console.log(`[WarmupGate] Auto-trading disabled for user ${userId}`);
}

export async function resetWarmupPeriod(userId: number): Promise<void> {
  await db
    .update(users)
    .set({
      warmupStartedAt: null,
      warmupEnabledAt: null,
      autoTradingEnabled: false,
    })
    .where(eq(users.id, userId));

  console.log(`[WarmupGate] Reset warm-up period for user ${userId}`);
}
