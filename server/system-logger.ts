import { db } from "./db";
import { systemLogs, type InsertSystemLog } from "@shared/schema";
import { desc, sql } from "drizzle-orm";

type LogStatus = "success" | "error" | "warning" | "info";
type LogService = "copy_trade" | "alert" | "webhook" | "swap" | "sell" | "system" | "telegram" | "helius" | "jupiter" | "ai";

// GPT-4o-mini pricing (as of 2024): $0.15/1M input, $0.60/1M output
const AI_PRICING = {
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4o": { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
} as const;

export interface AiUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

export function logAiUsage(
  action: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  model: string,
  latencyMs: number,
  userId?: number,
  context?: Record<string, unknown>
): Promise<void> {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || promptTokens + completionTokens;
  
  const pricing = AI_PRICING[model as keyof typeof AI_PRICING] || AI_PRICING["gpt-4o-mini"];
  const estimatedCostUsd = (promptTokens * pricing.input) + (completionTokens * pricing.output);
  
  return logSystemEvent("ai", action, "success", {
    ...context,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000, // 6 decimal places
  }, { userId, latencyMs });
}

const MAX_LOGS = 100;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function logSystemEvent(
  service: LogService,
  action: string,
  status: LogStatus,
  context?: Record<string, unknown>,
  options?: { userId?: number; errorMessage?: string; errorStack?: string; latencyMs?: number }
): Promise<void> {
  try {
    const logEntry: InsertSystemLog = {
      service,
      action,
      status,
      context: context || null,
      errorMessage: options?.errorMessage || null,
      errorStack: options?.errorStack || null,
      latencyMs: options?.latencyMs || null,
      userId: options?.userId || null,
      createdAt: Date.now(),
    };

    await db.insert(systemLogs).values(logEntry);
  } catch (err) {
    console.error("[SystemLogger] Failed to write log:", err);
  }
}

export function logError(
  service: LogService,
  action: string,
  error: Error,
  context?: Record<string, unknown>,
  userId?: number
): Promise<void> {
  return logSystemEvent(service, action, "error", context, {
    userId,
    errorMessage: error.message,
    errorStack: error.stack,
  });
}

export function logWarn(
  service: LogService,
  action: string,
  message: string,
  context?: Record<string, unknown>,
  userId?: number
): Promise<void> {
  return logSystemEvent(service, action, "warning", { ...context, message }, { userId });
}

export function logInfo(
  service: LogService,
  action: string,
  message: string,
  context?: Record<string, unknown>,
  userId?: number
): Promise<void> {
  return logSystemEvent(service, action, "info", { ...context, message }, { userId });
}

export function logSuccess(
  service: LogService,
  action: string,
  message: string,
  context?: Record<string, unknown>,
  userId?: number,
  latencyMs?: number
): Promise<void> {
  return logSystemEvent(service, action, "success", { ...context, message }, { userId, latencyMs });
}

export async function cleanupSystemLogs(): Promise<number> {
  try {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(systemLogs);
    const totalCount = Number(countResult[0]?.count || 0);

    if (totalCount <= MAX_LOGS) {
      return 0;
    }

    const toDelete = totalCount - MAX_LOGS;

    await db.execute(sql`
      DELETE FROM system_logs 
      WHERE id IN (
        SELECT id FROM system_logs 
        ORDER BY created_at ASC 
        LIMIT ${toDelete}
      )
    `);

    console.log(`[SystemLogger] Cleaned up ${toDelete} old log entries, kept ${MAX_LOGS}`);
    return toDelete;
  } catch (err) {
    console.error("[SystemLogger] Cleanup failed:", err);
    return 0;
  }
}

export async function querySystemLogs(options: {
  service?: LogService;
  status?: LogStatus;
  userId?: number;
  search?: string;
  limit?: number;
  hoursAgo?: number;
}): Promise<typeof systemLogs.$inferSelect[]> {
  const { service, status, userId, search, limit = 50, hoursAgo } = options;
  
  const logs = await db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(limit);

  return logs.filter(log => {
    if (service && log.service !== service) return false;
    if (status && log.status !== status) return false;
    if (userId && log.userId !== userId) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    if (search) {
      const searchLower = search.toLowerCase();
      const inAction = log.action.toLowerCase().includes(searchLower);
      const inError = log.errorMessage?.toLowerCase().includes(searchLower) || false;
      const inContext = log.context ? JSON.stringify(log.context).toLowerCase().includes(searchLower) : false;
      if (!inAction && !inError && !inContext) return false;
    }
    return true;
  });
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startSystemLogCleanup(): void {
  if (cleanupInterval) return;

  // Run cleanup immediately on startup
  cleanupSystemLogs().catch(err => console.error("[SystemLogger] Startup cleanup failed:", err));

  cleanupInterval = setInterval(async () => {
    await cleanupSystemLogs();
  }, CLEANUP_INTERVAL_MS);

  console.log("[SystemLogger] Hourly cleanup job started");
}

export function stopSystemLogCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
