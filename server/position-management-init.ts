import { updatePositionBudgetForecast, aggregateOldData } from "./position-budget-forecaster";
import { db } from "./db";
import { users, activePositions } from "@shared/schema";
import { checkTSLExit, checkTimeStop, checkTakeProfit } from "./snapshot-event-dispatcher";
import { exitPosition } from "./position-exit-manager";
import { eq } from "drizzle-orm";

let isInitialized = false;

export async function initializePositionManagement(): Promise<void> {
  if (isInitialized) return;

  console.log("[PositionManagement] Initializing Phase A position management system...");

  try {
    // Initialize budget for system account (user 1) at startup
    await initializeSystemAccountBudget();
  } catch (err) {
    console.error("[PositionManagement] Error initializing system account budget:", err);
  }

  // Schedule daily budget update at midnight UTC
  scheduleDailyBudgetUpdate();

  // Schedule daily data aggregation at 1am UTC
  scheduleDailyAggregation();

  // Start monitoring open positions for exits
  monitorOpenPositions();

  isInitialized = true;
  console.log("[PositionManagement] Initialization complete");
}

async function initializeSystemAccountBudget(): Promise<void> {
  const systemUserId = 1; // System picks fund account
  const { getHotWalletBalance } = await import("./wallet");

  try {
    // Get actual wallet balance for system account
    const currentBalance = await getHotWalletBalance(systemUserId);
    const initialBalance = currentBalance; // Use current balance as initial for startup

    console.log(`[PositionManagement] Initializing user ${systemUserId} with wallet balance: ${currentBalance.toFixed(4)} SOL`);

    // Calculate and store budget forecast
    await updatePositionBudgetForecast(systemUserId, currentBalance, initialBalance);
    console.log(`[PositionManagement] Budget forecast initialized for user ${systemUserId}`);
  } catch (err) {
    console.warn("[PositionManagement] Could not get wallet balance, will use defaults:", err instanceof Error ? err.message : err);
    // Fallback: initialize with safe defaults
    await updatePositionBudgetForecast(systemUserId, 0, 0);
  }
}

function scheduleDailyBudgetUpdate(): void {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  let delayMs = nextMidnight.getTime() - now.getTime();

  // Ensure delay is at least 1 minute
  if (delayMs < 60000) {
    delayMs += 24 * 60 * 60 * 1000;
  }

  setTimeout(async () => {
    try {
      console.log("[PositionManagement] Running daily budget update...");

      // Get all users
      const allUsers = await db.select().from(users);
      const { getHotWalletBalance } = await import("./wallet");

      for (const user of allUsers) {
        try {
          // Get current wallet balance
          const currentBalance = await getHotWalletBalance(user.id);
          // TODO: get initialBalance from user settings if available
          const initialBalance = currentBalance;

          await updatePositionBudgetForecast(user.id, currentBalance, initialBalance);
        } catch (err) {
          console.warn(`[PositionManagement] Error updating budget for user ${user.id}:`, err instanceof Error ? err.message : err);
        }
      }

      console.log("[PositionManagement] Daily budget update completed");
    } catch (err) {
      console.error("[PositionManagement] Error in daily budget update:", err);
    }

    // Schedule next day's update
    scheduleDailyBudgetUpdate();
  }, delayMs);
}

function scheduleDailyAggregation(): void {
  const now = new Date();
  const nextDay1am = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 0, 0));
  let delayMs = nextDay1am.getTime() - now.getTime();

  // Ensure delay is at least 1 minute
  if (delayMs < 60000) {
    delayMs += 24 * 60 * 60 * 1000;
  }

  setTimeout(async () => {
    try {
      console.log("[PositionManagement] Running daily data aggregation...");

      // Get all users
      const allUsers = await db.select().from(users);

      for (const user of allUsers) {
        await aggregateOldData(user.id);
      }

      console.log("[PositionManagement] Daily aggregation completed");
    } catch (err) {
      console.error("[PositionManagement] Error in daily aggregation:", err);
    }

    // Schedule next day's aggregation
    scheduleDailyAggregation();
  }, delayMs);
}

function monitorOpenPositions(): void {
  // Check open positions every 5-10 seconds for exit conditions
  const pollInterval = 5000 + Math.random() * 5000; // 5-10 seconds with jitter

  setInterval(async () => {
    try {
      // Get all open positions
      const openPositions = await db
        .select()
        .from(activePositions)
        .where(eq(activePositions.closedAt, null));

      // This is a stub - actual monitoring would require:
      // 1. Current price data from price feed
      // 2. Cluster type information
      // 3. Max hold time configuration

      // TODO: implement actual position monitoring with price feed integration
    } catch (err) {
      console.error("[PositionManagement] Error in position monitoring:", err);
    }
  }, pollInterval);
}

// Stub position monitoring implementation
// Full implementation would require price feed integration
export async function monitorPositionForExit(
  positionId: number,
  userId: number,
  currentPrice: number,
  clusterType: string = "spike_and_bleed"
): Promise<void> {
  // Define max hold times per cluster
  const maxHoldMinutes: { [key: string]: number } = {
    spike_and_bleed: 240, // 4 hours
    slow_moon: 1440, // 24 hours
    pump_and_dump: 60, // 1 hour
  };

  const maxHold = maxHoldMinutes[clusterType] || 480; // Default 8 hours

  // Check all exit conditions
  const tslResult = await checkTSLExit(positionId, currentPrice);
  if (tslResult.shouldExit) {
    const exitResult = await exitPosition(positionId, "tsl_hit", currentPrice, userId);
    console.log(`[PositionMonitor] TSL exit executed: ${exitResult.message}`);
    return;
  }

  const timeResult = await checkTimeStop(positionId, maxHold);
  if (timeResult.shouldExit) {
    const exitResult = await exitPosition(positionId, "time_stop", currentPrice, userId);
    console.log(`[PositionMonitor] Time stop exit executed: ${exitResult.message}`);
    return;
  }

  const tpResult = await checkTakeProfit(positionId, currentPrice, 5.0);
  if (tpResult.shouldExit) {
    const exitResult = await exitPosition(positionId, "profit_take", currentPrice, userId);
    console.log(`[PositionMonitor] Take profit exit executed: ${exitResult.message}`);
    return;
  }
}
