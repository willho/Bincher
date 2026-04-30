import { db } from "./db";
import { eq, and, lt, isNull, or, asc, sql } from "drizzle-orm";
import { discoveryTasks, DiscoveryTask, InsertDiscoveryTask } from "@shared/schema";

const TASK_TTL_SECONDS = 60;
const CLEANUP_INTERVAL_MS = 30 * 1000;

export async function createDiscoveryTask(
  taskType: string,
  payload: { mint?: string; walletAddress?: string },
  priority: number = 10
): Promise<DiscoveryTask> {
  const now = Math.floor(Date.now() / 1000);
  
  const [task] = await db.insert(discoveryTasks).values({
    taskType,
    payload,
    priority,
    status: "pending",
    ttlSeconds: TASK_TTL_SECONDS,
    createdAt: now,
  }).returning();
  
  return task;
}

export async function createTokenMetadataTask(mint: string, priority: number = 10): Promise<DiscoveryTask> {
  const existing = await db.query.discoveryTasks.findFirst({
    where: and(
      sql`${discoveryTasks.payload}->>'mint' = ${mint}`,
      or(
        eq(discoveryTasks.status, "pending"),
        eq(discoveryTasks.status, "assigned")
      )
    ),
  });
  
  if (existing) {
    return existing;
  }
  
  return createDiscoveryTask("token_metadata", { mint }, priority);
}

export async function assignTaskToWorker(userId: number): Promise<DiscoveryTask | null> {
  const now = Math.floor(Date.now() / 1000);
  
  await releaseExpiredTasks();
  
  const availableTask = await db.query.discoveryTasks.findFirst({
    where: eq(discoveryTasks.status, "pending"),
    orderBy: [asc(discoveryTasks.priority), asc(discoveryTasks.createdAt)],
  });
  
  if (!availableTask) {
    return null;
  }
  
  const [assigned] = await db
    .update(discoveryTasks)
    .set({
      status: "assigned",
      assignedTo: userId,
      assignedAt: now,
    })
    .where(and(
      eq(discoveryTasks.id, availableTask.id),
      eq(discoveryTasks.status, "pending")
    ))
    .returning();
  
  return assigned || null;
}

export async function completeTask(
  taskId: number,
  result: { name?: string; symbol?: string; decimals?: number; image?: string }
): Promise<DiscoveryTask | null> {
  const now = Math.floor(Date.now() / 1000);
  
  const [completed] = await db
    .update(discoveryTasks)
    .set({
      status: "completed",
      result,
      completedAt: now,
    })
    .where(eq(discoveryTasks.id, taskId))
    .returning();
  
  return completed || null;
}

export async function failTask(taskId: number, errorMessage: string): Promise<DiscoveryTask | null> {
  const [failed] = await db
    .update(discoveryTasks)
    .set({
      status: "failed",
      errorMessage,
    })
    .where(eq(discoveryTasks.id, taskId))
    .returning();
  
  return failed || null;
}

export async function releaseExpiredTasks(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  const result = await db
    .update(discoveryTasks)
    .set({
      status: "pending",
      assignedTo: null,
      assignedAt: null,
    })
    .where(and(
      eq(discoveryTasks.status, "assigned"),
      lt(sql`${discoveryTasks.assignedAt} + ${discoveryTasks.ttlSeconds}`, now)
    ))
    .returning();
  
  if (result.length > 0) {
    console.log(`[DiscoveryWorker] Released ${result.length} expired tasks`);
  }
  
  return result.length;
}

export async function getTaskStats(): Promise<{
  pending: number;
  assigned: number;
  completed: number;
  failed: number;
}> {
  const all = await db.query.discoveryTasks.findMany({
    where: sql`${discoveryTasks.createdAt} > ${Math.floor(Date.now() / 1000) - 86400}`,
  });
  
  return {
    pending: all.filter(t => t.status === "pending").length,
    assigned: all.filter(t => t.status === "assigned").length,
    completed: all.filter(t => t.status === "completed").length,
    failed: all.filter(t => t.status === "failed").length,
  };
}

export async function cleanupOldTasks(olderThanHours: number = 24): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - (olderThanHours * 3600);
  
  const deleted = await db
    .delete(discoveryTasks)
    .where(and(
      lt(discoveryTasks.createdAt, cutoff),
      or(
        eq(discoveryTasks.status, "completed"),
        eq(discoveryTasks.status, "failed")
      )
    ))
    .returning();
  
  if (deleted.length > 0) {
    console.log(`[DiscoveryWorker] Cleaned up ${deleted.length} old tasks`);
  }
  
  return deleted.length;
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupScheduler(): void {
  if (cleanupInterval) return;
  
  cleanupInterval = setInterval(async () => {
    try {
      await releaseExpiredTasks();
      await cleanupOldTasks();
    } catch (error) {
      console.error("[DiscoveryWorker] Cleanup error:", error);
    }
  }, CLEANUP_INTERVAL_MS);
  
  console.log("[DiscoveryWorker] Cleanup scheduler started");
}

export function stopCleanupScheduler(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("[DiscoveryWorker] Cleanup scheduler stopped");
  }
}
