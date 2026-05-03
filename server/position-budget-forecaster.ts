import { db } from "./db";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import {
  positionBudgets,
  tokenLaunchMetrics,
  dayOfWeekAggregates,
  tokenFingerprintSnapshots,
} from "@shared/schema";

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ROLLING_WINDOW_DAYS = 8;
const AGGREGATE_OLDER_THAN_DAYS = 8;
const UTC_MIDNIGHT_HOUR = 0; // UTC time to run daily aggregation

// =====================
// RECORDING FUNCTIONS
// =====================

/**
 * Record a token launch event for budget forecasting
 * Called when token is discovered
 */
export async function recordTokenLaunchEvent(
  tokenMint: string,
  launchTimestamp: number
): Promise<void> {
  try {
    const launchDate = new Date(launchTimestamp * 1000);
    const hour = launchDate.getUTCHours();
    const dayOfWeek = DAYS_OF_WEEK[launchDate.getUTCDay()];

    // Find or create hourly metric for this day/hour
    const existing = await db
      .select()
      .from(tokenLaunchMetrics)
      .where(and(eq(tokenLaunchMetrics.dayOfWeek, dayOfWeek), eq(tokenLaunchMetrics.hour, hour)))
      .orderBy(desc(tokenLaunchMetrics.timestamp))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await db
        .update(tokenLaunchMetrics)
        .set({
          launchCount: existing[0].launchCount + 1,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(tokenLaunchMetrics.id, existing[0].id));
    } else {
      // Create new
      await db.insert(tokenLaunchMetrics).values({
        dayOfWeek,
        hour,
        launchCount: 1,
        matchedCount: 0,
        rugCount: 0,
        reached2x: 0,
        reached5x: 0,
        reached10x: 0,
        reached100x: 0,
        timestamp: Math.floor(Date.now() / 1000),
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
    }
  } catch (error) {
    console.error(`[BudgetForecaster] Error recording launch event for ${tokenMint}:`, error);
  }
}

/**
 * Record a token outcome event (matched cluster, reached 2x, etc.)
 * Called when token position closes or reaches milestones
 */
export async function recordTokenOutcome(
  tokenMint: string,
  launchTimestamp: number,
  clusterMatch: number,
  maxMultiplierReached: number,
  isRug: boolean
): Promise<void> {
  try {
    if (isRug) {
      // Record as rug, skip matched/outcome tracking
      const launchDate = new Date(launchTimestamp * 1000);
      const hour = launchDate.getUTCHours();
      const dayOfWeek = DAYS_OF_WEEK[launchDate.getUTCDay()];

      const existing = await db
        .select()
        .from(tokenLaunchMetrics)
        .where(and(eq(tokenLaunchMetrics.dayOfWeek, dayOfWeek), eq(tokenLaunchMetrics.hour, hour)))
        .orderBy(desc(tokenLaunchMetrics.timestamp))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(tokenLaunchMetrics)
          .set({
            rugCount: existing[0].rugCount + 1,
            updatedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(tokenLaunchMetrics.id, existing[0].id));
      }
      return;
    }

    // Only count tokens that matched clusters (>70% confidence)
    if (clusterMatch < 0.7) {
      return;
    }

    const launchDate = new Date(launchTimestamp * 1000);
    const hour = launchDate.getUTCHours();
    const dayOfWeek = DAYS_OF_WEEK[launchDate.getUTCDay()];

    const existing = await db
      .select()
      .from(tokenLaunchMetrics)
      .where(and(eq(tokenLaunchMetrics.dayOfWeek, dayOfWeek), eq(tokenLaunchMetrics.hour, hour)))
      .orderBy(desc(tokenLaunchMetrics.timestamp))
      .limit(1);

    const updates: Record<string, any> = {
      matchedCount: (existing[0]?.matchedCount || 0) + 1,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    // Track multiplier milestones
    if (maxMultiplierReached >= 2.0) updates.reached2x = (existing[0]?.reached2x || 0) + 1;
    if (maxMultiplierReached >= 5.0) updates.reached5x = (existing[0]?.reached5x || 0) + 1;
    if (maxMultiplierReached >= 10.0) updates.reached10x = (existing[0]?.reached10x || 0) + 1;
    if (maxMultiplierReached >= 100.0) updates.reached100x = (existing[0]?.reached100x || 0) + 1;

    if (existing.length > 0) {
      await db.update(tokenLaunchMetrics).set(updates).where(eq(tokenLaunchMetrics.id, existing[0].id));
    } else {
      await db.insert(tokenLaunchMetrics).values({
        dayOfWeek,
        hour,
        launchCount: 0,
        matchedCount: updates.matchedCount,
        rugCount: 0,
        reached2x: updates.reached2x || 0,
        reached5x: updates.reached5x || 0,
        reached10x: updates.reached10x || 0,
        reached100x: updates.reached100x || 0,
        timestamp: Math.floor(Date.now() / 1000),
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
    }
  } catch (error) {
    console.error(`[BudgetForecaster] Error recording outcome for ${tokenMint}:`, error);
  }
}

// =====================
// FORECASTING & AGGREGATION
// =====================

/**
 * Calculate expected positions for next 24 hours based on historical patterns
 */
export async function calculateExpectedPositionsFor24Hours(): Promise<{
  expectedPositionsPerDay: number;
  forecastBreakdown: Array<{
    hour: number;
    dayOfWeek: string;
    expectedPositions: number;
    confidenceRate: number;
  }>;
  nextBusyPeriods: Array<{
    startHour: number;
    endHour: number;
    dayOfWeek: string;
    expectedCount: number;
  }>;
}> {
  try {
    const now = new Date();
    let currentHour = now.getUTCHours();
    let currentDay = DAYS_OF_WEEK[now.getUTCDay()];

    const forecastBreakdown = [];
    let totalExpected = 0;

    // Generate next 24 hours forecast
    for (let i = 0; i < 24; i++) {
      // Get recent data or aggregate fallback
      const recent = await db
        .select()
        .from(tokenLaunchMetrics)
        .where(
          and(
            eq(tokenLaunchMetrics.dayOfWeek, currentDay),
            eq(tokenLaunchMetrics.hour, currentHour)
          )
        )
        .orderBy(desc(tokenLaunchMetrics.timestamp))
        .limit(1);

      let expectedPositions = 0;
      let conversionRate = 0;

      if (recent.length > 0 && isDataFresh(recent[0].timestamp)) {
        // Use recent data
        const metric = recent[0];
        if (metric.matchedCount > 0) {
          expectedPositions = metric.matchedCount;
          conversionRate = metric.reached2x / metric.matchedCount;
        }
      } else {
        // Fall back to aggregate
        const aggregate = await db
          .select()
          .from(dayOfWeekAggregates)
          .where(
            and(
              eq(dayOfWeekAggregates.dayOfWeek, `${currentDay}_average`),
              eq(dayOfWeekAggregates.hour, currentHour)
            )
          )
          .limit(1);

        if (aggregate.length > 0) {
          expectedPositions = Math.round(aggregate[0].avgMatchedCount);
          conversionRate = aggregate[0].conversionTo2x || 0;
        }
      }

      forecastBreakdown.push({
        hour: currentHour,
        dayOfWeek: currentDay,
        expectedPositions,
        confidenceRate: conversionRate,
      });

      totalExpected += expectedPositions;

      // Move to next hour
      currentHour = (currentHour + 1) % 24;
      if (currentHour === 0) {
        const dayIndex = DAYS_OF_WEEK.indexOf(currentDay);
        currentDay = DAYS_OF_WEEK[(dayIndex + 1) % 7];
      }
    }

    // Identify busy periods (consecutive hours with high expected positions)
    const nextBusyPeriods = identifyBusyPeriods(forecastBreakdown);

    return {
      expectedPositionsPerDay: totalExpected,
      forecastBreakdown,
      nextBusyPeriods,
    };
  } catch (error) {
    console.error("[BudgetForecaster] Error calculating forecast:", error);
    return {
      expectedPositionsPerDay: 5, // fallback
      forecastBreakdown: [],
      nextBusyPeriods: [],
    };
  }
}

/**
 * Identify busy periods (consecutive high-volume hours)
 */
function identifyBusyPeriods(
  forecast: Array<{
    hour: number;
    dayOfWeek: string;
    expectedPositions: number;
    confidenceRate: number;
  }>
): Array<{
  startHour: number;
  endHour: number;
  dayOfWeek: string;
  expectedCount: number;
}> {
  const avgExpected =
    forecast.reduce((sum, f) => sum + f.expectedPositions, 0) / forecast.length;
  const threshold = avgExpected * 1.5; // 50% above average

  const busy = [];
  let inBusyPeriod = false;
  let startHour = 0;
  let totalInPeriod = 0;
  let dayOfWeekInPeriod = "";

  for (const hour of forecast) {
    if (hour.expectedPositions > threshold) {
      if (!inBusyPeriod) {
        inBusyPeriod = true;
        startHour = hour.hour;
        dayOfWeekInPeriod = hour.dayOfWeek;
        totalInPeriod = hour.expectedPositions;
      } else {
        totalInPeriod += hour.expectedPositions;
      }
    } else {
      if (inBusyPeriod) {
        busy.push({
          startHour,
          endHour: hour.hour,
          dayOfWeek: dayOfWeekInPeriod,
          expectedCount: Math.round(totalInPeriod),
        });
        inBusyPeriod = false;
      }
    }
  }

  return busy;
}

/**
 * Update position budgets for user based on latest forecast
 */
export async function updatePositionBudgetForecast(
  userId: number,
  currentBalance: number
): Promise<void> {
  try {
    const forecast = await calculateExpectedPositionsFor24Hours();

    // Calculate base allocation
    const safetyFactor = 1.2; // 20% buffer
    const baseAllocationPerPosition =
      currentBalance / (forecast.expectedPositionsPerDay * safetyFactor);

    // Get or create position budget record
    const existing = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, userId))
      .limit(1);

    const now = Math.floor(Date.now() / 1000);

    if (existing.length > 0) {
      await db
        .update(positionBudgets)
        .set({
          expectedPositionsPerDay: forecast.expectedPositionsPerDay,
          baseAllocationPerPosition,
          forecastBreakdown: forecast.forecastBreakdown,
          nextBusyPeriods: forecast.nextBusyPeriods,
          lastCalculatedAt: now,
          updatedAt: now,
        })
        .where(eq(positionBudgets.userId, userId));
    } else {
      await db.insert(positionBudgets).values({
        userId,
        expectedPositionsPerDay: forecast.expectedPositionsPerDay,
        baseAllocationPerPosition,
        forecastBreakdown: forecast.forecastBreakdown,
        nextBusyPeriods: forecast.nextBusyPeriods,
        apeBudget: 0,
        lastCalculatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    console.log(
      `[BudgetForecaster] Updated forecast for user ${userId}: ${forecast.expectedPositionsPerDay} positions/day, ${baseAllocationPerPosition.toFixed(4)} SOL/position`
    );
  } catch (error) {
    console.error(`[BudgetForecaster] Error updating budget forecast for user ${userId}:`, error);
  }
}

/**
 * Daily aggregation job: move >8 day old data into aggregates
 */
export async function aggregateOldData(): Promise<void> {
  try {
    const eightDaysAgo = Math.floor((Date.now() - AGGREGATE_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000) / 1000);

    // Get all metrics older than 8 days
    const oldMetrics = await db
      .select()
      .from(tokenLaunchMetrics)
      .where(lt(tokenLaunchMetrics.timestamp, eightDaysAgo));

    for (const metric of oldMetrics) {
      const aggregateKey = `${metric.dayOfWeek}_average`;

      // Find or create aggregate record
      const existing = await db
        .select()
        .from(dayOfWeekAggregates)
        .where(
          and(
            eq(dayOfWeekAggregates.dayOfWeek, aggregateKey),
            eq(dayOfWeekAggregates.hour, metric.hour)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const agg = existing[0];
        const newSampleDays = agg.sampleDays + 1;

        // Recalculate exponential moving average
        const alpha = 1 / (newSampleDays + 1); // weight for new data
        const avgLaunchCount =
          agg.avgLaunchCount * (1 - alpha) + metric.launchCount * alpha;
        const avgMatchedCount =
          agg.avgMatchedCount * (1 - alpha) + metric.matchedCount * alpha;
        const avgReached2x = agg.avgReached2x * (1 - alpha) + metric.reached2x * alpha;
        const avgReached5x = agg.avgReached5x * (1 - alpha) + metric.reached5x * alpha;
        const avgReached10x = agg.avgReached10x * (1 - alpha) + metric.reached10x * alpha;

        const conversionTo2x = avgMatchedCount > 0 ? avgReached2x / avgMatchedCount : 0;
        const conversionTo5x = avgMatchedCount > 0 ? avgReached5x / avgMatchedCount : 0;

        await db
          .update(dayOfWeekAggregates)
          .set({
            avgLaunchCount,
            avgMatchedCount,
            avgReached2x,
            avgReached5x,
            avgReached10x,
            conversionTo2x,
            conversionTo5x,
            sampleDays: newSampleDays,
            lastAggregatedAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(dayOfWeekAggregates.id, agg.id));
      } else {
        // Create new aggregate
        const conversionTo2x = metric.matchedCount > 0 ? metric.reached2x / metric.matchedCount : 0;
        const conversionTo5x = metric.matchedCount > 0 ? metric.reached5x / metric.matchedCount : 0;

        await db.insert(dayOfWeekAggregates).values({
          dayOfWeek: aggregateKey,
          hour: metric.hour,
          avgLaunchCount: metric.launchCount,
          avgMatchedCount: metric.matchedCount,
          avgReached2x: metric.reached2x,
          avgReached5x: metric.reached5x,
          avgReached10x: metric.reached10x,
          conversionTo2x,
          conversionTo5x,
          sampleDays: 1,
          lastAggregatedAt: Math.floor(Date.now() / 1000),
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }

      // Delete old metric after aggregation
      await db.delete(tokenLaunchMetrics).where(eq(tokenLaunchMetrics.id, metric.id));
    }

    console.log(`[BudgetForecaster] Aggregated ${oldMetrics.length} old metrics into day-of-week averages`);
  } catch (error) {
    console.error("[BudgetForecaster] Error aggregating old data:", error);
  }
}

// =====================
// HELPERS
// =====================

function isDataFresh(timestamp: number): boolean {
  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
  const maxAgeSeconds = ROLLING_WINDOW_DAYS * 24 * 60 * 60;
  return ageSeconds < maxAgeSeconds;
}

/**
 * Get current forecast for user
 */
export async function getPositionBudget(userId: number): Promise<any> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  return budget[0] || null;
}
