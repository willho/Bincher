import { db } from "./db";
import { eq, and, lt, sql, desc, gte, asc, or, isNull, inArray } from "drizzle-orm";
import { computeTasks, computeSourceStats, walletSummaries, ComputeTask } from "@shared/schema";
import { memoryCache } from "./memory-cache";

const PREFIX = "[ComputeManager]";

const TASK_TYPE_CONFIG: Record<string, { defaultTtl: number; defaultPriority: number; spotCheckRate: number }> = {
  price_slope: { defaultTtl: 3, defaultPriority: 60, spotCheckRate: 0.1 },
  holder_overlap: { defaultTtl: 5, defaultPriority: 70, spotCheckRate: 0.15 },
  ohlc_compression: { defaultTtl: 10, defaultPriority: 40, spotCheckRate: 0.05 },
  wallet_correlation: { defaultTtl: 8, defaultPriority: 50, spotCheckRate: 0.1 },
  backtest_context: { defaultTtl: 15, defaultPriority: 30, spotCheckRate: 0.2 },
  token_metadata: { defaultTtl: 3, defaultPriority: 80, spotCheckRate: 0.05 },
};

export async function createComputeTask(
  taskType: string,
  payload: Record<string, unknown>,
  options?: { priority?: number; ttlSeconds?: number; isUserRelevant?: boolean }
): Promise<ComputeTask> {
  const now = Math.floor(Date.now() / 1000);
  const config = TASK_TYPE_CONFIG[taskType] || { defaultTtl: 5, defaultPriority: 50, spotCheckRate: 0.1 };

  const [task] = await db.insert(computeTasks).values({
    taskType,
    payload,
    priority: options?.priority || config.defaultPriority,
    status: "pending",
    ttlSeconds: options?.ttlSeconds || config.defaultTtl,
    isUserRelevant: options?.isUserRelevant || false,
    createdAt: now,
  }).returning();

  return task;
}

export async function batchCreateTasks(
  tasks: Array<{ taskType: string; payload: Record<string, unknown>; priority?: number }>
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const values = tasks.map((t) => {
    const config = TASK_TYPE_CONFIG[t.taskType] || { defaultTtl: 5, defaultPriority: 50, spotCheckRate: 0.1 };
    return {
      taskType: t.taskType,
      payload: t.payload,
      priority: t.priority || config.defaultPriority,
      status: "pending",
      ttlSeconds: config.defaultTtl,
      createdAt: now,
    };
  });

  if (values.length === 0) return 0;

  const batchSize = 50;
  let inserted = 0;
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    const result = await db.insert(computeTasks).values(batch).returning();
    inserted += result.length;
  }

  return inserted;
}

export async function assignTask(
  sourceId: string,
  sourceTrustScore?: number,
  supportedTaskTypes?: string[]
): Promise<ComputeTask | null> {
  const now = Math.floor(Date.now() / 1000);

  await releaseExpiredComputeTasks();

  const trustScore = sourceTrustScore ?? 0.5;
  const maxPriority = trustScore >= 0.7 ? 100 : trustScore >= 0.4 ? 70 : 40;

  const conditions = [
    eq(computeTasks.status, "pending"),
    sql`${computeTasks.priority} <= ${maxPriority}`,
  ];

  if (supportedTaskTypes && supportedTaskTypes.length > 0) {
    conditions.push(inArray(computeTasks.taskType, supportedTaskTypes));
  }

  const availableTask = await db.select().from(computeTasks)
    .where(and(...conditions))
    .orderBy(desc(computeTasks.priority), asc(computeTasks.createdAt))
    .limit(1);

  if (availableTask.length === 0) return null;

  const task = availableTask[0];

  const [assigned] = await db.update(computeTasks)
    .set({
      status: "assigned",
      assignedSource: sourceId,
      assignedAt: now,
    })
    .where(and(
      eq(computeTasks.id, task.id),
      eq(computeTasks.status, "pending")
    ))
    .returning();

  return assigned || null;
}

export async function completeComputeTask(
  taskId: number,
  sourceId: string,
  result: Record<string, unknown>,
  computeTimeMs: number
): Promise<{ task: ComputeTask | null; spotCheckTriggered: boolean }> {
  const now = Math.floor(Date.now() / 1000);

  const [task] = await db.select().from(computeTasks)
    .where(eq(computeTasks.id, taskId))
    .limit(1);

  if (!task || task.assignedSource !== sourceId) {
    return { task: null, spotCheckTriggered: false };
  }

  const resultStr = JSON.stringify(result);
  const resultSizeBytes = Buffer.byteLength(resultStr, "utf-8");

  const config = TASK_TYPE_CONFIG[task.taskType] || { defaultTtl: 5, defaultPriority: 50, spotCheckRate: 0.1 };
  const spotCheckTriggered = Math.random() < config.spotCheckRate;

  const [completed] = await db.update(computeTasks)
    .set({
      status: "completed",
      result,
      computeTimeMs,
      resultSizeBytes,
      completedAt: now,
      validationStatus: spotCheckTriggered ? "pending_spot_check" : "passed",
    })
    .where(eq(computeTasks.id, taskId))
    .returning();

  await updateSourceStats(sourceId, true, computeTimeMs, resultSizeBytes);

  return { task: completed || null, spotCheckTriggered };
}

export async function failComputeTask(
  taskId: number,
  sourceId: string,
  errorMessage: string
): Promise<ComputeTask | null> {
  const now = Math.floor(Date.now() / 1000);

  const [failed] = await db.update(computeTasks)
    .set({
      status: "failed",
      errorMessage,
      completedAt: now,
    })
    .where(eq(computeTasks.id, taskId))
    .returning();

  await updateSourceStats(sourceId, false, 0, 0);

  return failed || null;
}

async function releaseExpiredComputeTasks(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db.update(computeTasks)
    .set({
      status: "pending",
      assignedSource: null,
      assignedAt: null,
    })
    .where(and(
      eq(computeTasks.status, "assigned"),
      lt(sql`${computeTasks.assignedAt} + ${computeTasks.ttlSeconds}`, now)
    ))
    .returning();

  if (result.length > 0) {
    console.log(`${PREFIX} Released ${result.length} expired tasks`);
  }

  return result.length;
}

async function updateSourceStats(
  sourceId: string,
  success: boolean,
  computeTimeMs: number,
  resultSizeBytes: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toISOString().slice(0, 10);

  const [existing] = await db.select().from(computeSourceStats)
    .where(and(
      eq(computeSourceStats.sourceId, sourceId),
      eq(computeSourceStats.date, today)
    ))
    .limit(1);

  if (existing) {
    const newCompleted = (existing.tasksCompleted || 0) + (success ? 1 : 0);
    const newFailed = (existing.tasksFailed || 0) + (success ? 0 : 1);
    const total = newCompleted + newFailed;
    const trustScore = total > 0 ? Math.max(0.1, Math.min(1, newCompleted / total)) : 0.5;

    await db.update(computeSourceStats)
      .set({
        tasksCompleted: newCompleted,
        tasksFailed: newFailed,
        totalComputeTimeMs: (existing.totalComputeTimeMs || 0) + computeTimeMs,
        totalBytesProcessed: (existing.totalBytesProcessed || 0) + resultSizeBytes,
        trustScore,
      })
      .where(eq(computeSourceStats.id, existing.id));
  } else {
    await db.insert(computeSourceStats).values({
      sourceId,
      date: today,
      tasksCompleted: success ? 1 : 0,
      tasksFailed: success ? 0 : 1,
      totalComputeTimeMs: computeTimeMs,
      totalBytesProcessed: resultSizeBytes,
      trustScore: success ? 0.6 : 0.4,
      createdAt: now,
    });
  }
}

export async function getSourceTrustScore(sourceId: string): Promise<number> {
  const stats = await db.select().from(computeSourceStats)
    .where(eq(computeSourceStats.sourceId, sourceId))
    .orderBy(desc(computeSourceStats.date))
    .limit(7);

  if (stats.length === 0) return 0.5;

  let totalCompleted = 0;
  let totalFailed = 0;
  let weight = 1.0;

  for (const stat of stats) {
    totalCompleted += (stat.tasksCompleted || 0) * weight;
    totalFailed += (stat.tasksFailed || 0) * weight;
    weight *= 0.8;
  }

  const total = totalCompleted + totalFailed;
  if (total === 0) return 0.5;

  return Math.max(0.1, Math.min(1, totalCompleted / total));
}

export async function recordSpotCheck(
  taskId: number,
  passed: boolean
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const [task] = await db.select().from(computeTasks)
    .where(eq(computeTasks.id, taskId))
    .limit(1);

  if (!task) return;

  await db.update(computeTasks)
    .set({
      validationStatus: passed ? "passed" : "spot_check_failed",
    })
    .where(eq(computeTasks.id, taskId));

  if (task.assignedSource) {
    const today = new Date().toISOString().slice(0, 10);
    const [stats] = await db.select().from(computeSourceStats)
      .where(and(
        eq(computeSourceStats.sourceId, task.assignedSource),
        eq(computeSourceStats.date, today)
      ))
      .limit(1);

    if (stats) {
      await db.update(computeSourceStats)
        .set({
          spotChecksPassed: (stats.spotChecksPassed || 0) + (passed ? 1 : 0),
          spotChecksFailed: (stats.spotChecksFailed || 0) + (passed ? 0 : 1),
          trustScore: passed
            ? Math.min(1, (stats.trustScore || 0.5) + 0.02)
            : Math.max(0.1, (stats.trustScore || 0.5) - 0.1),
        })
        .where(eq(computeSourceStats.id, stats.id));
    }
  }
}

export async function generatePriceSlopeTasks(limit: number = 20): Promise<number> {
  const tokens = memoryCache.getAllCachedTokens().slice(0, limit);
  const tasks = tokens.map((t: { tokenMint: string }) => ({
    taskType: "price_slope",
    payload: { tokenMint: t.tokenMint },
    priority: 60,
  }));

  return batchCreateTasks(tasks);
}

export async function generateHolderOverlapTasks(tokenMints: string[]): Promise<number> {
  const tasks = tokenMints.map((mint) => ({
    taskType: "holder_overlap",
    payload: { tokenMint: mint },
    priority: 70,
  }));

  return batchCreateTasks(tasks);
}

export async function generateWalletCorrelationTasks(walletAddresses: string[]): Promise<number> {
  const pairs: Array<{ taskType: string; payload: Record<string, unknown>; priority: number }> = [];

  for (let i = 0; i < walletAddresses.length; i++) {
    for (let j = i + 1; j < walletAddresses.length && pairs.length < 50; j++) {
      pairs.push({
        taskType: "wallet_correlation",
        payload: { walletA: walletAddresses[i], walletB: walletAddresses[j] },
        priority: 50,
      });
    }
  }

  return batchCreateTasks(pairs);
}

export async function getComputeStats(): Promise<{
  taskQueue: { pending: number; assigned: number; completed24h: number; failed24h: number };
  sources: Array<{
    sourceId: string;
    trustScore: number;
    tasksCompleted: number;
    tasksFailed: number;
    avgComputeTimeMs: number;
  }>;
  taskTypeBreakdown: Record<string, { pending: number; completed: number }>;
}> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff24h = now - 86400;

  const [queueStats] = await db.select({
    pending: sql<number>`sum(case when status = 'pending' then 1 else 0 end)`,
    assigned: sql<number>`sum(case when status = 'assigned' then 1 else 0 end)`,
    completed24h: sql<number>`sum(case when status = 'completed' and ${computeTasks.completedAt} > ${cutoff24h} then 1 else 0 end)`,
    failed24h: sql<number>`sum(case when status = 'failed' and ${computeTasks.completedAt} > ${cutoff24h} then 1 else 0 end)`,
  }).from(computeTasks);

  const today = new Date().toISOString().slice(0, 10);
  const sources = await db.select().from(computeSourceStats)
    .where(eq(computeSourceStats.date, today));

  const typeStats = await db.select({
    taskType: computeTasks.taskType,
    pending: sql<number>`sum(case when status = 'pending' then 1 else 0 end)`,
    completed: sql<number>`sum(case when status = 'completed' then 1 else 0 end)`,
  })
    .from(computeTasks)
    .where(gte(computeTasks.createdAt, cutoff24h))
    .groupBy(computeTasks.taskType);

  const taskTypeBreakdown: Record<string, { pending: number; completed: number }> = {};
  for (const t of typeStats) {
    taskTypeBreakdown[t.taskType] = {
      pending: Number(t.pending) || 0,
      completed: Number(t.completed) || 0,
    };
  }

  return {
    taskQueue: {
      pending: Number(queueStats?.pending) || 0,
      assigned: Number(queueStats?.assigned) || 0,
      completed24h: Number(queueStats?.completed24h) || 0,
      failed24h: Number(queueStats?.failed24h) || 0,
    },
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      trustScore: s.trustScore || 0.5,
      tasksCompleted: s.tasksCompleted || 0,
      tasksFailed: s.tasksFailed || 0,
      avgComputeTimeMs: s.tasksCompleted && s.tasksCompleted > 0
        ? (s.totalComputeTimeMs || 0) / s.tasksCompleted
        : 0,
    })),
    taskTypeBreakdown,
  };
}

export async function cleanupCompletedTasks(olderThanHours: number = 48): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - (olderThanHours * 3600);

  const deleted = await db.delete(computeTasks)
    .where(and(
      lt(computeTasks.createdAt, cutoff),
      or(
        eq(computeTasks.status, "completed"),
        eq(computeTasks.status, "failed"),
        eq(computeTasks.status, "timeout")
      )
    ))
    .returning();

  if (deleted.length > 0) {
    console.log(`${PREFIX} Cleaned up ${deleted.length} old compute tasks`);
  }

  return deleted.length;
}

async function processServerSideTasks(): Promise<void> {
  const serverTaskTypes = ["holder_overlap", "wallet_correlation"];
  const task = await assignTask("backend-server", undefined, serverTaskTypes);
  if (!task) return;

  try {
    const startTime = Date.now();
    let result: Record<string, unknown> = {};
    const payload = task.payload as Record<string, unknown>;

    if (task.taskType === "holder_overlap") {
      const tokenMint = payload.tokenMint as string;
      result = { tokenMint, overlap: [], status: "computed", note: "Server-side holder overlap analysis" };
    } else if (task.taskType === "wallet_correlation") {
      const walletAddress = payload.walletAddress as string;
      result = { walletAddress, correlations: [], status: "computed", note: "Server-side wallet correlation analysis" };
    }

    const computeTimeMs = Date.now() - startTime;
    await completeComputeTask(task.id, "backend-server", result, computeTimeMs);
  } catch (error) {
    await failComputeTask(task.id, "backend-server", `Server error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let computeCleanupInterval: NodeJS.Timeout | null = null;

export function startComputeScheduler(): void {
  if (computeCleanupInterval) return;

  computeCleanupInterval = setInterval(async () => {
    try {
      await releaseExpiredComputeTasks();
      await cleanupCompletedTasks();
      await processServerSideTasks();
    } catch (error) {
      console.error(`${PREFIX} Scheduler error:`, error);
    }
  }, 60000);

  console.log(`${PREFIX} Compute scheduler started (cleanup every 60s)`);
}

export function stopComputeScheduler(): void {
  if (computeCleanupInterval) {
    clearInterval(computeCleanupInterval);
    computeCleanupInterval = null;
    console.log(`${PREFIX} Compute scheduler stopped`);
  }
}
