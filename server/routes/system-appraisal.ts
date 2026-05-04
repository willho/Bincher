import { Router } from "express";
import { db } from "../db";
import {
  tokenLaunchMetrics,
  dayOfWeekAggregates,
  tokenFingerprintSnapshots,
  tokenFingerprints,
  clusterLearnings,
  positionBudgets,
  activePositions,
} from "@shared/schema";
import { eq, gte, lt, and } from "drizzle-orm";
import { getSubscriptionStatus, getRotationStats, getHealthReport } from "../subscription-telemetry";
import { getWarmupStatus } from "../warmup-gate";

const router = Router();

/**
 * System Appraisal Endpoint
 * Returns comprehensive learning status after N days of warm-up
 */
router.get("/api/system-appraisal", async (req, res) => {
  try {
    const systemUserId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);
    const now = Math.floor(Date.now() / 1000);
    const warmupStatus = await getWarmupStatus(systemUserId);
    const subscriptionStatus = getSubscriptionStatus();
    const healthReport = getHealthReport();
    const rotationStats = getRotationStats();

    // ===== TOKEN DISCOVERY LEARNING =====
    // Check if we have adequate token launch data
    const allLaunches = await db
      .select()
      .from(tokenLaunchMetrics)
      .where(eq(tokenLaunchMetrics.userId, systemUserId));

    const totalTokensLaunched = allLaunches.reduce((sum, row) => sum + (row.launchCount || 0), 0);
    const avgTokensPerHour = totalTokensLaunched / Math.max(1, allLaunches.length);

    // ===== CLUSTER MATCHING LEARNING =====
    const snapshots = await db.select().from(tokenFingerprintSnapshots);
    const totalSnapshots = snapshots.length;
    const snapshotsWithFingerprints = snapshots.filter((s) => s.fingerprintVector && (s.fingerprintVector as number[]).length > 0).length;

    // ===== TRAJECTORY LEARNING =====
    const clusterLearningData = await db.select().from(clusterLearnings).where(eq(clusterLearnings.userId, systemUserId));
    const learnedClusters = new Set(clusterLearningData.map((c) => c.clusterType));
    const convergenceMetrics = clusterLearningData.map((c) => ({
      cluster: c.clusterType,
      tslPercent: c.learnedTslPercent,
      trajectoryThreshold: c.trajectoryThreshold,
      sampleCount: c.sampleCount,
      converged: (c.sampleCount || 0) >= 15, // Need 15+ samples to be confident
    }));

    // ===== BUDGET FORECAST LEARNING =====
    const budgetData = await db
      .select()
      .from(positionBudgets)
      .where(eq(positionBudgets.userId, systemUserId))
      .limit(1);

    const budgetAccuracy = {
      expectedPositionsPerDay: budgetData[0]?.expectedPositionsPerDay || 0,
      baseAllocationPerPosition: budgetData[0]?.baseAllocationPerPosition || 0,
      apeBudget: budgetData[0]?.apeBudget || 0,
      lastCalculatedAt: budgetData[0]?.lastCalculatedAt || 0,
    };

    // ===== POSITION TESTING (if any) =====
    const testPositions = await db.select().from(activePositions).where(eq(activePositions.userId, systemUserId));
    const positionStats = {
      totalOpened: testPositions.length,
      stillOpen: testPositions.filter((p) => !p.closedAt).length,
      closed: testPositions.filter((p) => p.closedAt).length,
      avgHoldMinutes:
        testPositions.length > 0
          ? testPositions
              .filter((p) => p.closedAt)
              .reduce((sum, p) => sum + ((p.closedAt! - p.openedAt) / 60), 0) /
            Math.max(1, testPositions.filter((p) => p.closedAt).length)
          : 0,
    };

    // ===== READINESS ASSESSMENT =====
    const readinessChecks = {
      hasTokenLaunchData: totalTokensLaunched > 100,
      hasFingerprintCoverage: snapshotsWithFingerprints > 500,
      hasClusterLearning: learnedClusters.size > 0,
      hasBudgetForecast: budgetAccuracy.expectedPositionsPerDay > 0,
      hasCapacityData: subscriptionStatus.pump_fun.activeCount > 0 || subscriptionStatus.dex_paprika.activeCount > 0,
    };

    const readinessPercent = Math.round(
      (Object.values(readinessChecks).filter((v) => v).length / Object.keys(readinessChecks).length) * 100
    );

    return res.json({
      warmup: {
        isWarmingUp: warmupStatus.isWarmingUp,
        daysRemaining: warmupStatus.daysRemaining,
        percentComplete: warmupStatus.percentComplete,
        daysElapsed: 7 - warmupStatus.daysRemaining,
      },
      discovery: {
        totalTokensLaunched,
        avgTokensPerHour: avgTokensPerHour.toFixed(2),
        launchDataPoints: allLaunches.length,
      },
      clustering: {
        totalSnapshots,
        snapshotsWithFingerprints,
        fingerprintCoveragePercent: Math.round((snapshotsWithFingerprints / Math.max(1, totalSnapshots)) * 100),
      },
      learning: {
        learnedClusterCount: learnedClusters.size,
        convergenceStatus: convergenceMetrics,
      },
      budgetForecast: budgetAccuracy,
      subscriptions: {
        pump_fun: subscriptionStatus.pump_fun,
        dex_paprika: subscriptionStatus.dex_paprika,
      },
      capacity: {
        health: healthReport,
        rotations: rotationStats,
      },
      positions: positionStats,
      readiness: {
        checksPercentComplete: readinessPercent,
        checks: readinessChecks,
        recommendation:
          readinessPercent === 100
            ? "✅ System ready for auto-trading after warm-up completes"
            : `⚠️ System ${readinessPercent}% ready, needs more data`,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * Detailed Cluster Learning Analysis
 * Shows per-cluster convergence progress
 */
router.get("/api/system-appraisal/cluster-learning", async (req, res) => {
  try {
    const systemUserId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);

    const clusterData = await db.select().from(clusterLearnings).where(eq(clusterLearnings.userId, systemUserId));

    const analysis = clusterData.map((c) => ({
      cluster: c.clusterType,
      tsl: {
        learned: c.learnedTslPercent,
        sampleSize: c.sampleCount,
        converged: (c.sampleCount || 0) >= 15,
        confidence: Math.min(100, Math.round(((c.sampleCount || 0) / 15) * 100)),
      },
      trajectoryThreshold: {
        learned: c.trajectoryThreshold,
        sampleSize: c.sampleCount,
      },
      apeMultiplier: {
        learned: c.apeMultiplierLearned || 1.0,
      },
      recentMetrics: {
        winRate: c.recentWinRate || 0,
        profitFactor: c.recentProfitFactor || 0,
        avgPnl: c.recentAvgPnlPercent || 0,
      },
      recommendation:
        (c.sampleCount || 0) < 15
          ? `📊 Collecting samples: ${c.sampleCount}/15`
          : c.recentWinRate! > 0.6
          ? "✅ Cluster performing well"
          : c.recentWinRate! < 0.3
          ? "⚠️ Cluster underperforming, may need parameter adjustment"
          : "📊 Cluster performing at baseline",
    }));

    return res.json({
      clusterCount: analysis.length,
      clusters: analysis,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * Discovery Metrics by Hour/Day
 * Shows which times have highest token launch velocity
 */
router.get("/api/system-appraisal/discovery-patterns", async (req, res) => {
  try {
    const systemUserId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);

    const metrics = await db.select().from(tokenLaunchMetrics).where(eq(tokenLaunchMetrics.userId, systemUserId));

    // Group by hour and day of week
    const hourlyPatterns: Record<string, any> = {};
    const dailyPatterns: Record<string, any> = {};

    for (const m of metrics) {
      // Hourly
      if (!hourlyPatterns[m.hour]) {
        hourlyPatterns[m.hour] = { hour: m.hour, launches: 0, matches: 0, reachedPeak: 0 };
      }
      hourlyPatterns[m.hour].launches += m.launchCount || 0;
      hourlyPatterns[m.hour].matches += m.matchedCount || 0;
      hourlyPatterns[m.hour].reachedPeak += (m.reached10xCount || 0) + (m.reached5xCount || 0);

      // Daily
      if (!dailyPatterns[m.dayOfWeek]) {
        dailyPatterns[m.dayOfWeek] = { day: m.dayOfWeek, launches: 0, matches: 0, rugRate: 0, rugCount: 0 };
      }
      dailyPatterns[m.dayOfWeek].launches += m.launchCount || 0;
      dailyPatterns[m.dayOfWeek].matches += m.matchedCount || 0;
      dailyPatterns[m.dayOfWeek].rugCount += m.rugCount || 0;
    }

    // Calculate rug rates
    for (const [day, data] of Object.entries(dailyPatterns)) {
      data.rugRate = data.launches > 0 ? ((data.rugCount / data.launches) * 100).toFixed(1) : 0;
    }

    return res.json({
      byHour: Object.values(hourlyPatterns)
        .sort((a, b) => a.hour - b.hour)
        .map((h) => ({
          ...h,
          matchRate: h.launches > 0 ? ((h.matches / h.launches) * 100).toFixed(1) : 0,
          peakRate: h.launches > 0 ? ((h.reachedPeak / h.launches) * 100).toFixed(1) : 0,
        })),
      byDay: Object.values(dailyPatterns),
      peakHours: Object.values(hourlyPatterns)
        .sort((a, b) => b.launches - a.launches)
        .slice(0, 3)
        .map((h) => `${h.hour}:00 UTC`),
      peakDays: Object.entries(dailyPatterns)
        .sort((a, b) => b[1].launches - a[1].launches)
        .slice(0, 2)
        .map((d) => d[0]),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

/**
 * Fingerprint Quality Assessment
 * Shows if fingerprints are being generated and how they distribute
 */
router.get("/api/system-appraisal/fingerprint-quality", async (req, res) => {
  try {
    const snapshots = await db.select().from(tokenFingerprintSnapshots);

    const withFingerprints = snapshots.filter((s) => s.fingerprintVector && (s.fingerprintVector as number[]).length > 0);
    const withoutFingerprints = snapshots.filter((s) => !s.fingerprintVector || (s.fingerprintVector as number[]).length === 0);

    // Check snapshot density by age
    const now = Math.floor(Date.now() / 1000);
    const ageRanges = {
      "0-1h": 0,
      "1-6h": 0,
      "6-24h": 0,
      "24h+": 0,
    };

    for (const snap of snapshots) {
      const ageSeconds = now - snap.capturedAt;
      if (ageSeconds < 3600) ageRanges["0-1h"]++;
      else if (ageSeconds < 21600) ageRanges["1-6h"]++;
      else if (ageSeconds < 86400) ageRanges["6-24h"]++;
      else ageRanges["24h+"]++;
    }

    return res.json({
      coverage: {
        totalSnapshots: snapshots.length,
        withFingerprints: withFingerprints.length,
        withoutFingerprints: withFingerprints.length,
        coveragePercent: Math.round((withFingerprints.length / Math.max(1, snapshots.length)) * 100),
      },
      quality: {
        avgFingerprintSize: withFingerprints.length > 0
          ? (
              withFingerprints.reduce((sum, s) => sum + ((s.fingerprintVector as number[])?.length || 0), 0) /
              withFingerprints.length
            ).toFixed(0)
          : 0,
      },
      ageDistribution: ageRanges,
      recommendation:
        withFingerprints.length > 1000
          ? "✅ Good fingerprint coverage"
          : withFingerprints.length > 500
          ? "📊 Adequate fingerprints, keep collecting"
          : "⚠️ Need more fingerprint data (target 1000+)",
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
