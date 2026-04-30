import { db } from "./db";
import { rpcUsageLog, rpcUsageDailyBucket, rpcUsageWeeklyBucket, rpcUsageMonthlyBucket } from "@shared/schema";
import { eq, and, lt, sql } from "drizzle-orm";

interface RpcLogEntry {
  provider: string;
  method: string;
  success: boolean;
  latencyMs: number | null;
  fallbackUsed: boolean;
  fallbackProvider: string | null;
  errorMessage: string | null;
  timestamp: number;
}

const LOG_BUFFER: RpcLogEntry[] = [];
const FLUSH_INTERVAL_MS = 2 * 60 * 1000;
const RAW_RETENTION_DAYS = 11;
const DAILY_RETENTION_DAYS = 18;
const WEEKLY_RETENTION_WEEKS = 7;

let flushHandle: NodeJS.Timeout | null = null;
let compressionHandle: NodeJS.Timeout | null = null;

function getDateString(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getMonthString(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getWeekStart(ts: number): string {
  const d = new Date(ts * 1000);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function logRpcCall(entry: Omit<RpcLogEntry, "timestamp">): void {
  LOG_BUFFER.push({ ...entry, timestamp: Math.floor(Date.now() / 1000) });
}

async function flushBuffer(): Promise<void> {
  if (LOG_BUFFER.length === 0) return;

  const batch = LOG_BUFFER.splice(0, LOG_BUFFER.length);

  const grouped = new Map<string, { count: number; entry: RpcLogEntry; totalLatency: number; maxLatency: number }>();

  for (const entry of batch) {
    const key = `${entry.provider}:${entry.method}:${entry.success}:${entry.fallbackUsed}:${entry.fallbackProvider || ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      existing.totalLatency += entry.latencyMs || 0;
      existing.maxLatency = Math.max(existing.maxLatency, entry.latencyMs || 0);
    } else {
      grouped.set(key, {
        count: 1,
        entry,
        totalLatency: entry.latencyMs || 0,
        maxLatency: entry.latencyMs || 0,
      });
    }
  }

  try {
    const rows: any[] = [];
    grouped.forEach(({ count, entry }) => {
      rows.push({
        provider: entry.provider,
        method: entry.method,
        success: entry.success,
        latencyMs: entry.latencyMs,
        fallbackUsed: entry.fallbackUsed,
        fallbackProvider: entry.fallbackProvider,
        errorMessage: entry.errorMessage,
        timestamp: entry.timestamp,
        date: getDateString(entry.timestamp),
        callCount: count,
      });
    });

    if (rows.length > 0) {
      await db.insert(rpcUsageLog).values(rows);
    }
  } catch (error) {
    console.error("[RpcUsageLogger] Flush error:", error);
  }
}

async function compressAndClean(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  try {
    const rawCutoff = now - RAW_RETENTION_DAYS * 86400;
    const rawCutoffDate = getDateString(rawCutoff);

    const rawRows = await db.select({
      provider: rpcUsageLog.provider,
      method: rpcUsageLog.method,
      date: rpcUsageLog.date,
      totalCalls: sql<number>`sum(${rpcUsageLog.callCount})`.as("total_calls"),
      successCalls: sql<number>`sum(case when ${rpcUsageLog.success} then ${rpcUsageLog.callCount} else 0 end)`.as("success_calls"),
      errorCalls: sql<number>`sum(case when not ${rpcUsageLog.success} then ${rpcUsageLog.callCount} else 0 end)`.as("error_calls"),
      fallbackCalls: sql<number>`sum(case when ${rpcUsageLog.fallbackUsed} then ${rpcUsageLog.callCount} else 0 end)`.as("fallback_calls"),
      avgLatency: sql<number>`avg(${rpcUsageLog.latencyMs})`.as("avg_latency"),
      maxLatency: sql<number>`max(${rpcUsageLog.latencyMs})`.as("max_latency"),
    })
      .from(rpcUsageLog)
      .where(lt(rpcUsageLog.date, rawCutoffDate))
      .groupBy(rpcUsageLog.provider, rpcUsageLog.method, rpcUsageLog.date);

    for (const row of rawRows) {
      await db.insert(rpcUsageDailyBucket).values({
        provider: row.provider,
        method: row.method,
        date: row.date,
        totalCalls: row.totalCalls,
        successCalls: row.successCalls,
        errorCalls: row.errorCalls,
        fallbackCalls: row.fallbackCalls,
        avgLatencyMs: row.avgLatency ? Math.round(row.avgLatency) : null,
        maxLatencyMs: row.maxLatency ? Math.round(row.maxLatency) : null,
      }).onConflictDoNothing();
    }

    if (rawRows.length > 0) {
      await db.delete(rpcUsageLog).where(lt(rpcUsageLog.date, rawCutoffDate));
      console.log(`[RpcUsageLogger] Compressed ${rawRows.length} daily groups from raw logs`);
    }

    const dailyCutoff = now - DAILY_RETENTION_DAYS * 86400;
    const dailyCutoffDate = getDateString(dailyCutoff);

    const dailyRows = await db.select({
      provider: rpcUsageDailyBucket.provider,
      date: rpcUsageDailyBucket.date,
      totalCalls: sql<number>`sum(${rpcUsageDailyBucket.totalCalls})`.as("total_calls"),
      successCalls: sql<number>`sum(${rpcUsageDailyBucket.successCalls})`.as("success_calls"),
      errorCalls: sql<number>`sum(${rpcUsageDailyBucket.errorCalls})`.as("error_calls"),
      fallbackCalls: sql<number>`sum(${rpcUsageDailyBucket.fallbackCalls})`.as("fallback_calls"),
      avgLatency: sql<number>`avg(${rpcUsageDailyBucket.avgLatencyMs})`.as("avg_latency"),
    })
      .from(rpcUsageDailyBucket)
      .where(lt(rpcUsageDailyBucket.date, dailyCutoffDate))
      .groupBy(rpcUsageDailyBucket.provider, rpcUsageDailyBucket.date);

    for (const row of dailyRows) {
      const weekStart = getWeekStart(new Date(row.date).getTime() / 1000);
      await db.insert(rpcUsageWeeklyBucket).values({
        provider: row.provider,
        weekStart,
        totalCalls: row.totalCalls,
        successCalls: row.successCalls,
        errorCalls: row.errorCalls,
        fallbackCalls: row.fallbackCalls,
        avgLatencyMs: row.avgLatency ? Math.round(row.avgLatency) : null,
      }).onConflictDoNothing();
    }

    if (dailyRows.length > 0) {
      await db.delete(rpcUsageDailyBucket).where(lt(rpcUsageDailyBucket.date, dailyCutoffDate));
      console.log(`[RpcUsageLogger] Compressed ${dailyRows.length} weekly groups from daily buckets`);
    }

    const weeklyCutoff = now - WEEKLY_RETENTION_WEEKS * 7 * 86400;
    const weeklyCutoffDate = getDateString(weeklyCutoff);

    const weeklyRows = await db.select({
      provider: rpcUsageWeeklyBucket.provider,
      weekStart: rpcUsageWeeklyBucket.weekStart,
      totalCalls: sql<number>`sum(${rpcUsageWeeklyBucket.totalCalls})`.as("total_calls"),
      successCalls: sql<number>`sum(${rpcUsageWeeklyBucket.successCalls})`.as("success_calls"),
      errorCalls: sql<number>`sum(${rpcUsageWeeklyBucket.errorCalls})`.as("error_calls"),
      fallbackCalls: sql<number>`sum(${rpcUsageWeeklyBucket.fallbackCalls})`.as("fallback_calls"),
      avgLatency: sql<number>`avg(${rpcUsageWeeklyBucket.avgLatencyMs})`.as("avg_latency"),
    })
      .from(rpcUsageWeeklyBucket)
      .where(lt(rpcUsageWeeklyBucket.weekStart, weeklyCutoffDate))
      .groupBy(rpcUsageWeeklyBucket.provider, rpcUsageWeeklyBucket.weekStart);

    for (const row of weeklyRows) {
      const month = row.weekStart.slice(0, 7);
      await db.insert(rpcUsageMonthlyBucket).values({
        provider: row.provider,
        month,
        totalCalls: row.totalCalls,
        successCalls: row.successCalls,
        errorCalls: row.errorCalls,
        fallbackCalls: row.fallbackCalls,
        avgLatencyMs: row.avgLatency ? Math.round(row.avgLatency) : null,
      }).onConflictDoNothing();
    }

    if (weeklyRows.length > 0) {
      await db.delete(rpcUsageWeeklyBucket).where(lt(rpcUsageWeeklyBucket.weekStart, weeklyCutoffDate));
      console.log(`[RpcUsageLogger] Compressed ${weeklyRows.length} monthly groups from weekly buckets`);
    }
  } catch (error) {
    console.error("[RpcUsageLogger] Compression error:", error);
  }
}

export function startRpcUsageLogger(): void {
  if (flushHandle) return;

  flushHandle = setInterval(() => {
    flushBuffer().catch(err => console.error("[RpcUsageLogger] Flush error:", err));
  }, FLUSH_INTERVAL_MS);

  compressionHandle = setInterval(() => {
    compressAndClean().catch(err => console.error("[RpcUsageLogger] Compression error:", err));
  }, 24 * 60 * 60 * 1000);

  console.log(`[RpcUsageLogger] Started (flush every ${FLUSH_INTERVAL_MS / 1000}s, compress daily)`);
}

export function stopRpcUsageLogger(): void {
  if (flushHandle) { clearInterval(flushHandle); flushHandle = null; }
  if (compressionHandle) { clearInterval(compressionHandle); compressionHandle = null; }
  flushBuffer().catch(console.error);
}

export async function getRpcUsageSummary(): Promise<{
  today: { provider: string; method: string; calls: number; errors: number; avgLatency: number }[];
  bufferSize: number;
}> {
  const todayDate = getDateString(Math.floor(Date.now() / 1000));

  const rows = await db.select({
    provider: rpcUsageLog.provider,
    method: rpcUsageLog.method,
    calls: sql<number>`sum(${rpcUsageLog.callCount})`.as("calls"),
    errors: sql<number>`sum(case when not ${rpcUsageLog.success} then ${rpcUsageLog.callCount} else 0 end)`.as("errors"),
    avgLatency: sql<number>`avg(${rpcUsageLog.latencyMs})`.as("avg_latency"),
  })
    .from(rpcUsageLog)
    .where(eq(rpcUsageLog.date, todayDate))
    .groupBy(rpcUsageLog.provider, rpcUsageLog.method);

  return {
    today: rows.map(r => ({
      provider: r.provider,
      method: r.method,
      calls: r.calls || 0,
      errors: r.errors || 0,
      avgLatency: r.avgLatency ? Math.round(r.avgLatency) : 0,
    })),
    bufferSize: LOG_BUFFER.length,
  };
}
