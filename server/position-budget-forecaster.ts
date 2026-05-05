import { db } from "./db";
import { positionBudgets, tokenLaunchMetrics, dayOfWeekAggregates, users } from "@shared/schema";
import { eq, and, gte, lt } from "drizzle-orm";

interface BudgetForecast {
  expectedPositionsPerDay: number;
  baseAllocationPerPosition: number;
  apeBudget: number;
  forecastBreakdown: Array<{ hour: number; dayOfWeek: string; expectedPositions: number }>;
  nextBusyPeriods: Array<{ startHour: number; dayOfWeek: string; endHour: number; expectedPositions: number }>;
}

export async function recordTokenLaunchEvent(userId: number, tokenMint: string): Promise<void> {
  const now = Date.now();
  const date = new Date(now);
  const hour = date.getUTCHours();
  const dayOfWeek = date.toLocaleString("en-US", { weekday: "long", timeZone: "UTC" });
  const capturedDate = Math.floor(now / 1000 / 86400) * 86400; // Start of UTC day

  // Record launch event in rolling window
  const existing = await db
    .select()
    .from(tokenLaunchMetrics)
    .where(
      and(
        eq(tokenLaunchMetrics.userId, userId),
        eq(tokenLaunchMetrics.hour, hour),
        eq(tokenLaunchMetrics.dayOfWeek, dayOfWeek),
        eq(tokenLaunchMetrics.capturedDate, capturedDate)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(tokenLaunchMetrics)
      .set({ launchCount: (existing[0].launchCount || 0) + 1, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tokenLaunchMetrics.id, existing[0].id));
  } else {
    await db.insert(tokenLaunchMetrics).values({
      userId,
      hour,
      dayOfWeek,
      capturedDate,
      launchCount: 1,
      matchedCount: 0,
      reached2xCount: 0,
      reached5xCount: 0,
      reached10xCount: 0,
      rugCount: 0,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }
}

export async function recordTokenOutcome(
  userId: number,
  hour: number,
  dayOfWeek: string,
  capturedDate: number,
  outcome: "matched" | "reached_2x" | "reached_5x" | "reached_10x" | "rug"
): Promise<void> {
  const existing = await db
    .select()
    .from(tokenLaunchMetrics)
    .where(
      and(
        eq(tokenLaunchMetrics.userId, userId),
        eq(tokenLaunchMetrics.hour, hour),
        eq(tokenLaunchMetrics.dayOfWeek, dayOfWeek),
        eq(tokenLaunchMetrics.capturedDate, capturedDate)
      )
    )
    .limit(1);

  if (existing.length === 0) return;

  const updates: any = { updatedAt: Math.floor(Date.now() / 1000) };

  if (outcome === "matched") updates.matchedCount = (existing[0].matchedCount || 0) + 1;
  else if (outcome === "reached_2x") updates.reached2xCount = (existing[0].reached2xCount || 0) + 1;
  else if (outcome === "reached_5x") updates.reached5xCount = (existing[0].reached5xCount || 0) + 1;
  else if (outcome === "reached_10x") updates.reached10xCount = (existing[0].reached10xCount || 0) + 1;
  else if (outcome === "rug") updates.rugCount = (existing[0].rugCount || 0) + 1;

  await db.update(tokenLaunchMetrics).set(updates).where(eq(tokenLaunchMetrics.id, existing[0].id));
}

export async function calculateExpectedPositionsFor24Hours(userId: number): Promise<Array<{ hour: number; dayOfWeek: string; expectedPositions: number }>> {
  const forecastBreakdown: Array<{ hour: number; dayOfWeek: string; expectedPositions: number }> = [];

  for (let hour = 0; hour < 24; hour++) {
    for (const dayOfWeek of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      const aggregates = await db
        .select()
        .from(dayOfWeekAggregates)
        .where(
          and(
            eq(dayOfWeekAggregates.userId, userId),
            eq(dayOfWeekAggregates.hour, hour),
            eq(dayOfWeekAggregates.dayOfWeek, dayOfWeek)
          )
        )
        .limit(1);

      const expectedPositions = aggregates.length > 0 ? aggregates[0].avgMatchedCount || 0 : 0;
      forecastBreakdown.push({ hour, dayOfWeek, expectedPositions });
    }
  }

  return forecastBreakdown;
}

export async function updatePositionBudgetForecast(
  userId: number,
  currentBalance: number,
  initialBalance: number
): Promise<BudgetForecast> {
  const now = Math.floor(Date.now() / 1000);

  // Check if warm-up period is less than 7 days old
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const warmupStartedAt = user.length > 0 ? user[0].warmupStartedAt : null;
  const isFirstWeek = warmupStartedAt && (now - warmupStartedAt) < 604800; // 7 days in seconds

  let forecastBreakdown: Array<{ hour: number; dayOfWeek: string; expectedPositions: number }>;
  let expectedPositionsPerDay: number;

  if (isFirstWeek) {
    // First week: use simple daily average (no day-of-week breakdown)
    const dailyMetrics = await db
      .select()
      .from(tokenLaunchMetrics)
      .where(eq(tokenLaunchMetrics.userId, userId));

    const totalMatched = dailyMetrics.reduce((sum, m) => sum + (m.matchedCount || 0), 0);
    const uniqueDays = new Set(dailyMetrics.map(m => m.capturedDate)).size;
    const dailyAverage = uniqueDays > 0 ? totalMatched / uniqueDays : 0;

    // Fill all 24 hours with the same daily average
    forecastBreakdown = [];
    for (let hour = 0; hour < 24; hour++) {
      forecastBreakdown.push({
        hour,
        dayOfWeek: "Daily Average",
        expectedPositions: dailyAverage / 24, // Spread evenly across hours
      });
    }

    expectedPositionsPerDay = dailyAverage;
  } else {
    // After first week: use day-of-week breakdown
    forecastBreakdown = await calculateExpectedPositionsFor24Hours(userId);
    expectedPositionsPerDay = forecastBreakdown.reduce((sum, entry) => sum + entry.expectedPositions, 0) / 7; // Average across week
  }

  // Base allocation: conservative reserve across expected discovery velocity
  const conservativeFactor = 1.2; // 20% safety margin
  const baseAllocationPerPosition = expectedPositionsPerDay > 0
    ? currentBalance / (expectedPositionsPerDay * conservativeFactor)
    : 0.1; // Fallback to 0.1 SOL if no forecast

  // Cap base allocation at 30% of current balance
  const cappedBaseAllocation = Math.min(baseAllocationPerPosition, currentBalance * 0.3);

  // Ape budget: grows with wins, resets weekly
  const existing = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  let apeBudget = 0;
  let apeBudgetMultiplier = 1.0;

  if (existing.length > 0) {
    // Check if weekly reset needed (7 days = 604800 seconds)
    const lastReset = existing[0].apeBudgetResetAt || now;
    const needsReset = now - lastReset > 604800;

    if (needsReset) {
      apeBudget = 0;
      apeBudgetMultiplier = 1.0;
    } else {
      apeBudget = existing[0].apeBudget || 0;
      apeBudgetMultiplier = existing[0].apeBudgetMultiplier || 1.0;
    }
  }

  // Identify next busy periods (hours with expectedPositions > 75th percentile)
  const positions = forecastBreakdown.map(f => f.expectedPositions);
  const sorted = [...positions].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)];

  const nextBusyPeriods: Array<{ startHour: number; dayOfWeek: string; endHour: number; expectedPositions: number }> = [];
  let inBusyPeriod = false;
  let startHour = 0;

  for (const entry of forecastBreakdown) {
    if (entry.expectedPositions > p75 && !inBusyPeriod) {
      inBusyPeriod = true;
      startHour = entry.hour;
    } else if (entry.expectedPositions <= p75 && inBusyPeriod) {
      inBusyPeriod = false;
      nextBusyPeriods.push({
        startHour,
        dayOfWeek: forecastBreakdown[startHour].dayOfWeek,
        endHour: entry.hour,
        expectedPositions: Math.max(...forecastBreakdown.slice(startHour, entry.hour).map(e => e.expectedPositions)),
      });
    }
  }

  const forecast: BudgetForecast = {
    expectedPositionsPerDay: Math.max(expectedPositionsPerDay, 1), // Min 1 position/day
    baseAllocationPerPosition: cappedBaseAllocation,
    apeBudget: Math.min(apeBudget, currentBalance * 0.3), // Cap ape budget at 30%
    forecastBreakdown,
    nextBusyPeriods,
  };

  // Upsert budget record
  if (existing.length > 0) {
    await db
      .update(positionBudgets)
      .set({
        expectedPositionsPerDay: forecast.expectedPositionsPerDay,
        baseAllocationPerPosition: forecast.baseAllocationPerPosition,
        apeBudget: forecast.apeBudget,
        apeBudgetMultiplier,
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
      baseAllocationPerPosition: forecast.baseAllocationPerPosition,
      apeBudget: forecast.apeBudget,
      apeBudgetMultiplier,
      apeBudgetResetAt: now,
      forecastBreakdown: forecast.forecastBreakdown,
      nextBusyPeriods: forecast.nextBusyPeriods,
      lastCalculatedAt: now,
      createdAt: now,
    });
  }

  return forecast;
}

export async function aggregateOldData(userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const eightDaysAgo = now - 8 * 86400;

  // Get all data from rolling window
  const metrics = await db
    .select()
    .from(tokenLaunchMetrics)
    .where(
      and(
        eq(tokenLaunchMetrics.userId, userId),
        gte(tokenLaunchMetrics.capturedDate, eightDaysAgo)
      )
    );

  // Group by hour and day of week
  const grouped: { [key: string]: typeof metrics } = {};
  for (const metric of metrics) {
    const key = `${metric.hour}:${metric.dayOfWeek}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(metric);
  }

  // Calculate aggregates using exponential moving average
  for (const [key, entries] of Object.entries(grouped)) {
    const [hourStr, dayOfWeek] = key.split(":");
    const hour = parseInt(hourStr);

    // Fetch existing aggregate
    const existing = await db
      .select()
      .from(dayOfWeekAggregates)
      .where(
        and(
          eq(dayOfWeekAggregates.userId, userId),
          eq(dayOfWeekAggregates.hour, hour),
          eq(dayOfWeekAggregates.dayOfWeek, dayOfWeek)
        )
      )
      .limit(1);

    // Calculate new values from this batch
    const totalLaunches = entries.reduce((sum, e) => sum + (e.launchCount || 0), 0);
    const totalMatched = entries.reduce((sum, e) => sum + (e.matchedCount || 0), 0);
    const avgMatchedPerDay = entries.length > 0 ? totalMatched / entries.length : 0;
    const avg2xRate = totalMatched > 0 ? entries.reduce((sum, e) => sum + (e.reached2xCount || 0), 0) / totalMatched : 0;
    const avg5xRate = totalMatched > 0 ? entries.reduce((sum, e) => sum + (e.reached5xCount || 0), 0) / totalMatched : 0;
    const avg10xRate = totalMatched > 0 ? entries.reduce((sum, e) => sum + (e.reached10xCount || 0), 0) / totalMatched : 0;
    const avgRugRate = totalLaunches > 0 ? entries.reduce((sum, e) => sum + (e.rugCount || 0), 0) / totalLaunches : 0;

    const alpha = 0.15; // EMA smoothing factor (15% weight to new data)

    if (existing.length > 0) {
      // Apply exponential moving average
      const prevAvgMatched = existing[0].avgMatchedCount || 0;
      const prevAvg2xRate = existing[0].avg2xReachRate || 0;
      const prevAvg5xRate = existing[0].avg5xReachRate || 0;
      const prevAvg10xRate = existing[0].avg10xReachRate || 0;
      const prevAvgRugRate = existing[0].avgRugRate || 0;

      await db
        .update(dayOfWeekAggregates)
        .set({
          avgLaunchCount: (1 - alpha) * (existing[0].avgLaunchCount || 0) + alpha * (totalLaunches / Math.max(entries.length, 1)),
          avgMatchedCount: (1 - alpha) * prevAvgMatched + alpha * avgMatchedPerDay,
          avg2xReachRate: (1 - alpha) * prevAvg2xRate + alpha * avg2xRate,
          avg5xReachRate: (1 - alpha) * prevAvg5xRate + alpha * avg5xRate,
          avg10xReachRate: (1 - alpha) * prevAvg10xRate + alpha * avg10xRate,
          avgRugRate: (1 - alpha) * prevAvgRugRate + alpha * avgRugRate,
          sampleDays: Math.min((existing[0].sampleDays || 0) + entries.length, 60),
          lastUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(dayOfWeekAggregates.id, existing[0].id));
    } else {
      await db.insert(dayOfWeekAggregates).values({
        userId,
        hour,
        dayOfWeek,
        avgLaunchCount: totalLaunches / Math.max(entries.length, 1),
        avgMatchedCount: avgMatchedPerDay,
        avg2xReachRate: avg2xRate,
        avg5xReachRate: avg5xRate,
        avg10xReachRate: avg10xRate,
        avgRugRate,
        sampleDays: entries.length,
        lastUpdatedAt: now,
        createdAt: now,
      });
    }
  }

  // Cleanup: delete data older than 8 days
  await db
    .delete(tokenLaunchMetrics)
    .where(
      and(
        eq(tokenLaunchMetrics.userId, userId),
        lt(tokenLaunchMetrics.capturedDate, eightDaysAgo)
      )
    );
}

export async function getPositionBudget(userId: number): Promise<BudgetForecast | null> {
  const budget = await db
    .select()
    .from(positionBudgets)
    .where(eq(positionBudgets.userId, userId))
    .limit(1);

  if (budget.length === 0) return null;

  return {
    expectedPositionsPerDay: budget[0].expectedPositionsPerDay,
    baseAllocationPerPosition: budget[0].baseAllocationPerPosition,
    apeBudget: budget[0].apeBudget,
    forecastBreakdown: (budget[0].forecastBreakdown as any) || [],
    nextBusyPeriods: (budget[0].nextBusyPeriods as any) || [],
  };
}
