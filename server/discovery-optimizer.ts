import { db } from "./db";
import {
  discoveryTriggers,
  discoveryEvents,
  systemInsights,
  emergentRules,
  vectorUpdates,
  scanContextLogs,
  tokenDataPool,
} from "@shared/schema";
import { eq, and, gte, desc, sql, gt, lt, lte } from "drizzle-orm";
import { publishInsight } from "./insight-bus";
import { evaluateMetric } from "./discovery-engine";
import { fetchTokenWithFallback } from "./data-pool";
import { getBusStats, getRecentEvents } from "./discovery-event-bus";

interface ReviewStats {
  reviewsRun: number;
  outcomesBackfilled: number;
  llmCallsMade: number;
  llmCallsSkipped: number;
  rulesCovering: number;
  totalDecisions: number;
  ruleCoverage: number;
  thresholdsAdjusted: number;
  shadowsEvaluated: number;
}

const optimizerState = {
  reviewIntervalMs: 30 * 60 * 1000,
  minIntervalMs: 10 * 60 * 1000,
  maxIntervalMs: 120 * 60 * 1000,
  lastReviewAt: 0,
  consecutiveQuietReviews: 0,
  consecutiveActiveReviews: 0,
  reviewHandle: null as NodeJS.Timeout | null,
  stats: {
    reviewsRun: 0,
    outcomesBackfilled: 0,
    llmCallsMade: 0,
    llmCallsSkipped: 0,
    rulesCovering: 0,
    totalDecisions: 0,
    ruleCoverage: 0,
    thresholdsAdjusted: 0,
    shadowsEvaluated: 0,
  } as ReviewStats,
  selfImprovementHandle: null as NodeJS.Timeout | null,
};

const THRESHOLDS = {
  triggerPromotionPrecision: 0.50,
  ruleRetirementPrecision: 0.30,
  llmSkipConfidence: 0.70,
  discoveryFireMinUrgency: 4,
};

const thresholdHistory: Array<{
  timestamp: number;
  key: string;
  oldValue: number;
  newValue: number;
  reason: string;
}> = [];

export async function runAdaptiveReview(): Promise<ReviewStats> {
  const now = Math.floor(Date.now() / 1000);
  const reviewWindow = Math.floor(optimizerState.reviewIntervalMs / 1000);
  const windowStart = now - reviewWindow;

  const outcomesBackfilled = await backfillOutcomes(windowStart, now);

  const { rulesCovering, totalDecisions, llmSkipped, llmNeeded } =
    await evaluateRuleCoverage(windowStart, now);

  const thresholdsAdjusted = await adjustThresholdsFromOutcomes(windowStart, now);

  const shadowsEvaluated = await evaluateShadowTriggers();

  const ruleCoverage = totalDecisions > 0 ? rulesCovering / totalDecisions : 0;

  optimizerState.stats = {
    reviewsRun: optimizerState.stats.reviewsRun + 1,
    outcomesBackfilled,
    llmCallsMade: llmNeeded,
    llmCallsSkipped: llmSkipped,
    rulesCovering,
    totalDecisions,
    ruleCoverage,
    thresholdsAdjusted,
    shadowsEvaluated,
  };
  optimizerState.lastReviewAt = Date.now();

  const busStats = getBusStats();
  const isActive = busStats.totalEmitted > 5 || outcomesBackfilled > 0 || thresholdsAdjusted > 0;

  if (isActive) {
    optimizerState.consecutiveActiveReviews++;
    optimizerState.consecutiveQuietReviews = 0;
    if (optimizerState.consecutiveActiveReviews >= 3) {
      const newInterval = Math.max(
        optimizerState.minIntervalMs,
        optimizerState.reviewIntervalMs * 0.75
      );
      if (newInterval !== optimizerState.reviewIntervalMs) {
        optimizerState.reviewIntervalMs = newInterval;
        rescheduleReview();
      }
    }
  } else {
    optimizerState.consecutiveQuietReviews++;
    optimizerState.consecutiveActiveReviews = 0;
    if (optimizerState.consecutiveQuietReviews >= 2) {
      const newInterval = Math.min(
        optimizerState.maxIntervalMs,
        optimizerState.reviewIntervalMs * 1.5
      );
      if (newInterval !== optimizerState.reviewIntervalMs) {
        optimizerState.reviewIntervalMs = newInterval;
        rescheduleReview();
      }
    }
  }

  if (ruleCoverage > 0 || thresholdsAdjusted > 0) {
    await publishInsight({
      source: "discovery",
      type: "performance",
      title: `Review cycle: ${(ruleCoverage * 100).toFixed(0)}% rule coverage`,
      payload: {
        ruleCoverage: Math.round(ruleCoverage * 100),
        outcomesBackfilled,
        thresholdsAdjusted,
        shadowsEvaluated,
        reviewIntervalMinutes: Math.round(optimizerState.reviewIntervalMs / 60000),
        llmCallsMade: llmNeeded,
        llmCallsSkipped: llmSkipped,
      },
      confidence: Math.min(1.0, ruleCoverage),
      expiresInHours: 8,
    });
  }

  const hour = new Date().getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  const bucketDate = new Date().toISOString().slice(0, 10);
  const bucketId = `${bucketDate}-${bucket}`;

  await db.insert(vectorUpdates).values({
    vectorType: "strategy",
    targetId: "discovery_optimizer",
    signalType: ruleCoverage >= 0.9 ? "discovery_win" : "discovery_loss",
    signalData: {
      ruleCoverage,
      thresholdsAdjusted,
      reviewInterval: optimizerState.reviewIntervalMs,
      hour,
    },
    weight: 1.0,
    bucketId,
    processed: false,
    createdAt: now,
  });

  return optimizerState.stats;
}

async function backfillOutcomes(windowStart: number, now: number): Promise<number> {
  let updated = 0;

  const pendingEvents = await db
    .select()
    .from(discoveryEvents)
    .where(
      and(
        eq(discoveryEvents.status, "pending"),
        lte(discoveryEvents.firedAt, now - 3600)
      )
    )
    .limit(50);

  for (const event of pendingEvents) {
    const tokenData = await fetchTokenWithFallback(event.tokenMint);
    const currentPrice = tokenData.priceUsd || 0;

    if (!event.priceAtDiscovery || event.priceAtDiscovery === 0) {
      await db
        .update(discoveryEvents)
        .set({ status: "expired", evaluatedAt: now })
        .where(eq(discoveryEvents.id, event.id));
      continue;
    }

    const ageHours = (now - event.firedAt) / 3600;
    const priceChange = ((currentPrice - event.priceAtDiscovery) / event.priceAtDiscovery) * 100;

    const updates: Record<string, any> = {};
    if (ageHours >= 1 && !event.priceAfter1h) updates.priceAfter1h = currentPrice;
    if (ageHours >= 4 && !event.priceAfter4h) updates.priceAfter4h = currentPrice;

    if (ageHours >= 24) {
      updates.priceAfter24h = currentPrice;
      updates.outcomePercent = priceChange;
      updates.outcome = priceChange >= 5 ? "profit" : priceChange <= -10 ? "loss" : "neutral";
      updates.status = "tracked";
      updates.evaluatedAt = now;

      const trigger = await db
        .select()
        .from(discoveryTriggers)
        .where(eq(discoveryTriggers.id, event.triggerId))
        .limit(1);

      if (trigger.length > 0) {
        const t = trigger[0];
        if (priceChange >= 5) {
          await db
            .update(discoveryTriggers)
            .set({
              truePositives: (t.truePositives || 0) + 1,
              precision:
                ((t.truePositives || 0) + 1) /
                ((t.truePositives || 0) + 1 + (t.falsePositives || 0)),
              updatedAt: now,
            })
            .where(eq(discoveryTriggers.id, t.id));
        } else {
          await db
            .update(discoveryTriggers)
            .set({
              falsePositives: (t.falsePositives || 0) + 1,
              precision:
                (t.truePositives || 0) /
                ((t.truePositives || 0) + (t.falsePositives || 0) + 1),
              updatedAt: now,
            })
            .where(eq(discoveryTriggers.id, t.id));
        }
      }

      updated++;
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(discoveryEvents)
        .set(updates)
        .where(eq(discoveryEvents.id, event.id));
    }
  }

  return updated;
}

async function evaluateRuleCoverage(
  windowStart: number,
  now: number
): Promise<{
  rulesCovering: number;
  totalDecisions: number;
  llmSkipped: number;
  llmNeeded: number;
}> {
  const activeRules = await db
    .select()
    .from(emergentRules)
    .where(and(eq(emergentRules.enabled, true), eq(emergentRules.status, "active")));

  const recentEvents = await db
    .select()
    .from(discoveryEvents)
    .where(gte(discoveryEvents.firedAt, windowStart))
    .limit(100);

  const totalDecisions = recentEvents.length;
  if (totalDecisions === 0)
    return { rulesCovering: 0, totalDecisions: 0, llmSkipped: 0, llmNeeded: 0 };

  let rulesCovering = 0;
  let llmSkipped = 0;
  let llmNeeded = 0;

  for (const event of recentEvents) {
    const matchingRule = activeRules.find((r) => {
      const config = r.triggerConfig as Record<string, any> | null;
      if (!config) return false;
      return config.metric === "discovery_event" && config.tokenMint === event.tokenMint;
    });

    if (matchingRule && (matchingRule.confidence || 0) >= THRESHOLDS.llmSkipConfidence) {
      rulesCovering++;
      llmSkipped++;
    } else {
      llmNeeded++;
    }
  }

  return { rulesCovering, totalDecisions, llmSkipped, llmNeeded };
}

async function adjustThresholdsFromOutcomes(
  windowStart: number,
  now: number
): Promise<number> {
  let adjusted = 0;

  const completedEvents = await db
    .select()
    .from(discoveryEvents)
    .where(
      and(
        eq(discoveryEvents.status, "tracked"),
        gte(discoveryEvents.evaluatedAt, windowStart)
      )
    )
    .limit(100);

  if (completedEvents.length < 5) return 0;

  const triggerOutcomes = new Map<
    number,
    { wins: number; losses: number; neutrals: number }
  >();
  for (const event of completedEvents) {
    const existing = triggerOutcomes.get(event.triggerId) || {
      wins: 0,
      losses: 0,
      neutrals: 0,
    };
    if (event.outcome === "profit") existing.wins++;
    else if (event.outcome === "loss") existing.losses++;
    else existing.neutrals++;
    triggerOutcomes.set(event.triggerId, existing);
  }

  const entries = Array.from(triggerOutcomes.entries());
  for (const [triggerId, outcomes] of entries) {
    const total = outcomes.wins + outcomes.losses + outcomes.neutrals;
    if (total < 3) continue;

    const winRate = outcomes.wins / total;
    const trigger = await db
      .select()
      .from(discoveryTriggers)
      .where(eq(discoveryTriggers.id, triggerId))
      .limit(1);

    if (trigger.length === 0) continue;
    const t = trigger[0];

    const targetPrecision = THRESHOLDS.triggerPromotionPrecision;
    const precisionDiff = winRate - targetPrecision;
    const dampening = t.explorationPhase
      ? (t.dampeningFactor || 0.1) * 2
      : (t.dampeningFactor || 0.1);

    let weightAdj = precisionDiff * dampening;
    weightAdj = Math.max(-0.15, Math.min(0.15, weightAdj));

    const newWeight = Math.max(0.5, Math.min(2.0, (t.currentWeight || 1.0) + weightAdj));

    if (Math.abs(newWeight - (t.currentWeight || 1.0)) > 0.01) {
      await db
        .update(discoveryTriggers)
        .set({ currentWeight: newWeight, updatedAt: now })
        .where(eq(discoveryTriggers.id, triggerId));
      adjusted++;
    }
  }

  if (completedEvents.length >= 10) {
    const overallWins = completedEvents.filter((e) => e.outcome === "profit").length;
    const overallWinRate = overallWins / completedEvents.length;

    if (overallWinRate < 0.3 && THRESHOLDS.discoveryFireMinUrgency > 2) {
      const old = THRESHOLDS.discoveryFireMinUrgency;
      THRESHOLDS.discoveryFireMinUrgency = Math.max(2, old - 1);
      thresholdHistory.push({
        timestamp: now,
        key: "discoveryFireMinUrgency",
        oldValue: old,
        newValue: THRESHOLDS.discoveryFireMinUrgency,
        reason: `Low win rate ${(overallWinRate * 100).toFixed(0)}%, loosening`,
      });
    } else if (overallWinRate > 0.7 && THRESHOLDS.discoveryFireMinUrgency < 8) {
      const old = THRESHOLDS.discoveryFireMinUrgency;
      THRESHOLDS.discoveryFireMinUrgency = Math.min(8, old + 1);
      thresholdHistory.push({
        timestamp: now,
        key: "discoveryFireMinUrgency",
        oldValue: old,
        newValue: THRESHOLDS.discoveryFireMinUrgency,
        reason: `High win rate ${(overallWinRate * 100).toFixed(0)}%, tightening`,
      });
    }

    if (overallWinRate < 0.25 && THRESHOLDS.triggerPromotionPrecision > 0.35) {
      const old = THRESHOLDS.triggerPromotionPrecision;
      THRESHOLDS.triggerPromotionPrecision = Math.max(0.35, old - 0.05);
      thresholdHistory.push({
        timestamp: now,
        key: "triggerPromotionPrecision",
        oldValue: old,
        newValue: THRESHOLDS.triggerPromotionPrecision,
        reason: `Low win rate, lowering promotion bar`,
      });
    } else if (overallWinRate > 0.6 && THRESHOLDS.triggerPromotionPrecision < 0.70) {
      const old = THRESHOLDS.triggerPromotionPrecision;
      THRESHOLDS.triggerPromotionPrecision = Math.min(0.70, old + 0.05);
      thresholdHistory.push({
        timestamp: now,
        key: "triggerPromotionPrecision",
        oldValue: old,
        newValue: THRESHOLDS.triggerPromotionPrecision,
        reason: `High win rate, raising promotion bar`,
      });
    }

    if (overallWinRate > 0.5 && THRESHOLDS.llmSkipConfidence > 0.5) {
      const old = THRESHOLDS.llmSkipConfidence;
      THRESHOLDS.llmSkipConfidence = Math.max(0.5, old - 0.05);
      thresholdHistory.push({
        timestamp: now,
        key: "llmSkipConfidence",
        oldValue: old,
        newValue: THRESHOLDS.llmSkipConfidence,
        reason: `Good outcomes, trusting rules more`,
      });
    } else if (overallWinRate < 0.3 && THRESHOLDS.llmSkipConfidence < 0.90) {
      const old = THRESHOLDS.llmSkipConfidence;
      THRESHOLDS.llmSkipConfidence = Math.min(0.90, old + 0.05);
      thresholdHistory.push({
        timestamp: now,
        key: "llmSkipConfidence",
        oldValue: old,
        newValue: THRESHOLDS.llmSkipConfidence,
        reason: `Poor outcomes, requiring more LLM verification`,
      });
    }
  }

  return adjusted;
}

async function evaluateShadowTriggers(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let evaluated = 0;

  const shadows = await db
    .select()
    .from(discoveryTriggers)
    .where(
      and(eq(discoveryTriggers.enabled, true), eq(discoveryTriggers.shadowMode, true))
    );

  for (const trigger of shadows) {
    const ageHours = (now - trigger.createdAt) / 3600;

    if ((trigger.fireCount || 0) >= 20 && trigger.precision !== null) {
      if (trigger.precision >= THRESHOLDS.triggerPromotionPrecision) {
        await db
          .update(discoveryTriggers)
          .set({
            shadowMode: false,
            promotedAt: now,
            explorationPhase: false,
            updatedAt: now,
          })
          .where(eq(discoveryTriggers.id, trigger.id));
        evaluated++;
        console.log(
          `[Optimizer] Promoted shadow trigger "${trigger.name}" (precision: ${(trigger.precision * 100).toFixed(0)}%)`
        );
      } else if (
        trigger.precision < THRESHOLDS.ruleRetirementPrecision ||
        ageHours > 168
      ) {
        await db
          .update(discoveryTriggers)
          .set({ enabled: false, updatedAt: now })
          .where(eq(discoveryTriggers.id, trigger.id));
        evaluated++;
      }
    } else if (ageHours > 336 && (trigger.fireCount || 0) < 5) {
      await db
        .update(discoveryTriggers)
        .set({ enabled: false, updatedAt: now })
        .where(eq(discoveryTriggers.id, trigger.id));
      evaluated++;
    }
  }

  return evaluated;
}

export async function runSelfImprovementCycle(): Promise<{
  outcomesBackfilled: number;
  shadowsEvaluated: number;
  computeTasksGenerated: number;
  thresholdAdjustments: number;
  insightsPublished: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const fourHoursAgo = now - 4 * 3600;

  const outcomesBackfilled = await backfillOutcomes(fourHoursAgo, now);
  const shadowsEvaluated = await evaluateShadowTriggers();
  const thresholdAdjustments = await adjustThresholdsFromOutcomes(fourHoursAgo, now);

  let computeTasksGenerated = 0;
  try {
    const {
      generatePriceSlopeTasks,
      generateHolderOverlapTasks,
      generateWalletCorrelationTasks,
    } = await import("./compute-manager");

    const priceTasks = await generatePriceSlopeTasks(30);

    const highPriorityTokens = await db
      .select({ tokenMint: tokenDataPool.tokenMint })
      .from(tokenDataPool)
      .where(gt(tokenDataPool.volume24h, 50000))
      .limit(15);

    const holderTasks =
      highPriorityTokens.length > 0
        ? await generateHolderOverlapTasks(highPriorityTokens.map((t) => t.tokenMint))
        : 0;

    computeTasksGenerated = priceTasks + holderTasks;
  } catch (err) {
    console.error("[Optimizer] Compute task generation failed:", err);
  }

  let insightsPublished = 0;
  if (thresholdHistory.length > 0) {
    const recentAdjustments = thresholdHistory.filter((h) => h.timestamp >= fourHoursAgo);
    if (recentAdjustments.length > 0) {
      await publishInsight({
        source: "discovery",
        type: "performance",
        title: `Self-improvement: ${recentAdjustments.length} threshold adjustments`,
        payload: {
          adjustments: recentAdjustments,
          currentThresholds: { ...THRESHOLDS },
        },
        confidence: 0.7,
        expiresInHours: 24,
      });
      insightsPublished++;
    }
  }

  return {
    outcomesBackfilled,
    shadowsEvaluated,
    computeTasksGenerated,
    thresholdAdjustments,
    insightsPublished,
  };
}

export function startOptimizer(): void {
  function scheduleReview() {
    optimizerState.reviewHandle = setTimeout(async () => {
      try {
        const stats = await runAdaptiveReview();
        if (stats.reviewsRun % 10 === 0 || stats.thresholdsAdjusted > 0) {
          console.log(
            `[Optimizer] Review #${stats.reviewsRun}: coverage=${(stats.ruleCoverage * 100).toFixed(0)}%, ` +
              `outcomes=${stats.outcomesBackfilled}, thresholds=${stats.thresholdsAdjusted}, ` +
              `interval=${Math.round(optimizerState.reviewIntervalMs / 60000)}min`
          );
        }
      } catch (err) {
        console.error("[Optimizer] Review failed:", err);
      }
      scheduleReview();
    }, optimizerState.reviewIntervalMs);
  }

  scheduleReview();

  optimizerState.selfImprovementHandle = setInterval(async () => {
    try {
      const result = await runSelfImprovementCycle();
      console.log(
        `[Optimizer] Self-improvement cycle: outcomes=${result.outcomesBackfilled}, ` +
          `shadows=${result.shadowsEvaluated}, compute=${result.computeTasksGenerated}, ` +
          `thresholds=${result.thresholdAdjustments}`
      );
    } catch (err) {
      console.error("[Optimizer] Self-improvement cycle failed:", err);
    }
  }, 4 * 3600 * 1000);

  console.log(
    `[Optimizer] Started (review every ${Math.round(optimizerState.reviewIntervalMs / 60000)}min, self-improvement every 4h)`
  );
}

function rescheduleReview(): void {
  if (optimizerState.reviewHandle) {
    clearTimeout(optimizerState.reviewHandle);
    optimizerState.reviewHandle = setTimeout(async () => {
      try {
        await runAdaptiveReview();
      } catch (err) {
        console.error("[Optimizer] Review failed:", err);
      }
    }, optimizerState.reviewIntervalMs);
  }
}

export function getOptimizerStats() {
  return {
    stats: optimizerState.stats,
    reviewIntervalMinutes: Math.round(optimizerState.reviewIntervalMs / 60000),
    lastReviewAt: optimizerState.lastReviewAt,
    thresholds: { ...THRESHOLDS },
    thresholdHistory: thresholdHistory.slice(-20),
    consecutiveQuietReviews: optimizerState.consecutiveQuietReviews,
    consecutiveActiveReviews: optimizerState.consecutiveActiveReviews,
  };
}
