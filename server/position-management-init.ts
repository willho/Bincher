import { updatePositionBudgetForecast, aggregateOldData } from "./position-budget-forecaster";
import { positionExitManager } from "./position-exit-manager";

/**
 * Initialize position management system on app startup
 */
export async function initializePositionManagement(): Promise<void> {
  try {
    console.log("[PositionManagement] Initializing position management system...");

    // Schedule daily budget forecast update (at midnight UTC)
    scheduleDailyBudgetUpdate();

    // Schedule daily old data aggregation (at 1am UTC)
    scheduleDailyAggregation();

    // Log startup
    console.log("[PositionManagement] Position management system initialized");
  } catch (error) {
    console.error("[PositionManagement] Error initializing position management:", error);
    throw error;
  }
}

/**
 * Schedule daily budget forecast update
 * Runs at midnight UTC
 */
function scheduleDailyBudgetUpdate(): void {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeUntilNext = tomorrow.getTime() - now.getTime();

  console.log(`[PositionManagement] Scheduled budget forecast update in ${(timeUntilNext / 1000 / 60).toFixed(0)} minutes`);

  setTimeout(() => {
    dailyBudgetUpdateCycle();
    // Repeat every 24 hours
    setInterval(dailyBudgetUpdateCycle, 24 * 60 * 60 * 1000);
  }, timeUntilNext);
}

/**
 * Daily budget update cycle
 */
async function dailyBudgetUpdateCycle(): Promise<void> {
  try {
    console.log("[PositionManagement] Running daily budget forecast update...");

    // TODO: Get all active users and update their budgets
    // For now, this is a placeholder
    // In production, would iterate through all users with active positions

    console.log("[PositionManagement] Daily budget forecast update complete");
  } catch (error) {
    console.error("[PositionManagement] Error in daily budget update cycle:", error);
  }
}

/**
 * Schedule daily old data aggregation
 * Runs at 1am UTC (after budget update)
 */
function scheduleDailyAggregation(): void {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(1, 0, 0, 0);
  if (tomorrow <= now) {
    tomorrow.setDate(tomorrow.getDate() + 1);
  }

  const timeUntilNext = tomorrow.getTime() - now.getTime();

  console.log(`[PositionManagement] Scheduled data aggregation in ${(timeUntilNext / 1000 / 60).toFixed(0)} minutes`);

  setTimeout(() => {
    dailyAggregationCycle();
    // Repeat every 24 hours
    setInterval(dailyAggregationCycle, 24 * 60 * 60 * 1000);
  }, timeUntilNext);
}

/**
 * Daily aggregation cycle
 */
async function dailyAggregationCycle(): Promise<void> {
  try {
    console.log("[PositionManagement] Running daily data aggregation...");

    // Aggregate metrics older than 8 days
    await aggregateOldData();

    console.log("[PositionManagement] Daily data aggregation complete");
  } catch (error) {
    console.error("[PositionManagement] Error in daily aggregation cycle:", error);
  }
}

/**
 * Monitor all open positions for exit conditions
 * Should be called periodically (e.g., every 5 seconds when price data is available)
 */
export async function monitorOpenPositions(
  userId: number,
  priceUpdates: Map<string, number> // tokenMint -> currentPrice
): Promise<void> {
  try {
    const openPositions = await positionExitManager.getOpenPositions(userId);

    for (const position of openPositions) {
      const currentPrice = priceUpdates.get(position.tokenMint);
      if (!currentPrice) continue;

      // Check TSL exit
      const tslHit = await positionExitManager.checkTSLExit(position.id, currentPrice);
      if (tslHit) {
        await positionExitManager.exitPosition(position.id, "tsl_hit", currentPrice, userId);
        continue;
      }

      // Check take profit
      const tpHit = await positionExitManager.checkTakeProfit(
        position.id,
        currentPrice,
        5.0 // 5x take profit target
      );
      if (tpHit) {
        await positionExitManager.exitPosition(position.id, "profit_take", currentPrice, userId);
        continue;
      }

      // Check time stop (cluster-specific)
      const maxHoldMinutes = getMaxHoldMinutesForCluster(position.entryClusters[0]?.cluster);
      const timeStopHit = await positionExitManager.checkTimeStop(position.id, maxHoldMinutes);
      if (timeStopHit) {
        await positionExitManager.exitPosition(position.id, "time_stop", currentPrice, userId);
        continue;
      }
    }
  } catch (error) {
    console.error("[PositionManagement] Error monitoring open positions:", error);
  }
}

/**
 * Get max hold time for cluster type
 */
function getMaxHoldMinutesForCluster(cluster: string): number {
  const maxHoldMap: Record<string, number> = {
    spike_and_bleed: 120, // 2 hours
    slow_moon: 480, // 8 hours
    late_bloomer: 1440, // 24 hours
    pump_dump: 60, // 1 hour
    shaky_climb: 240, // 4 hours
    organic_growth: 720, // 12 hours
  };

  return maxHoldMap[cluster] || 240;
}
