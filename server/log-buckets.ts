/**
 * Bucketed Logging System with Pruning
 *
 * Strategy:
 * - Bucket logs by hour + category
 * - Keep raw events for last 6 hours
 * - Keep hourly summaries forever
 * - Prune individual events at 24hr
 * - Compact buckets into summaries automatically
 */

import { db } from "./db";

// =====================
// TYPES
// =====================

export interface LogBucket {
  id: string;
  timestamp: number; // Hour start (rounded down to nearest hour)
  category: string;
  level: string;

  // Aggregated metrics for this bucket
  eventCount: number;
  errorCount: number;
  warningCount: number;

  // API/DB totals
  apiCalls: number;
  dbReads: number;
  dbWrites: number;
  dbDeletes: number;

  // Latency stats
  latencyMs: {
    min: number;
    max: number;
    avg: number;
    p95: number;
  };

  // Memory stats
  memoryMb: {
    min: number;
    max: number;
    avg: number;
  };

  // Error summary
  topErrors: Array<{
    message: string;
    count: number;
  }>;

  // Token activity
  tokensInvolved: number;
  walletsTouched: number;

  // Metadata
  compacted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DiagnosticQuery {
  timeRange?: {
    start: number;
    end: number;
  };
  category?: string;
  level?: string;
  tokenMint?: string;
  walletAddress?: string;
  limit?: number;
  offset?: number;
}

// =====================
// BUCKETING LOGIC
// =====================

/**
 * Get bucket ID for a timestamp
 * Buckets logs into 1-hour windows
 */
function getBucketId(timestamp: number, category: string): string {
  const hour = Math.floor(timestamp / 3600000) * 3600000;
  return `${category}_${hour}`;
}

/**
 * Get current hour bucket key
 */
function getCurrentBucketKey(category: string): string {
  return getBucketId(Date.now(), category);
}

// =====================
// IN-MEMORY BUFFER (Recent Events)
// =====================

interface RecentEvent {
  timestamp: number;
  category: string;
  level: string;
  message: string;
  tokenMint?: string;
  walletAddress?: string;
  metrics?: {
    apiCalls?: number;
    dbReads?: number;
    dbWrites?: number;
    dbDeletes?: number;
    latencyMs?: number;
    memoryMb?: number;
  };
  error?: string;
  traceId?: string;
}

// Keep last 6 hours of raw events in memory
const RECENT_EVENTS_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 5000;
let recentEvents: RecentEvent[] = [];

/**
 * Add event to recent buffer
 */
export function addRecentEvent(event: RecentEvent): void {
  recentEvents.push(event);

  // Trim old events and limit size
  const cutoff = Date.now() - RECENT_EVENTS_WINDOW_MS;
  recentEvents = recentEvents
    .filter((e) => e.timestamp > cutoff)
    .slice(-MAX_RECENT_EVENTS);
}

/**
 * Get recent events (for diagnosis)
 */
export function getRecentEvents(query?: DiagnosticQuery): RecentEvent[] {
  let results = [...recentEvents];

  if (query?.timeRange) {
    results = results.filter(
      (e) =>
        e.timestamp >= query.timeRange!.start &&
        e.timestamp <= query.timeRange!.end
    );
  }

  if (query?.category) {
    results = results.filter((e) => e.category === query.category);
  }

  if (query?.level) {
    results = results.filter((e) => e.level === query.level);
  }

  if (query?.tokenMint) {
    results = results.filter((e) => e.tokenMint === query.tokenMint);
  }

  if (query?.walletAddress) {
    results = results.filter((e) => e.walletAddress === query.walletAddress);
  }

  const limit = query?.limit || 100;
  const offset = query?.offset || 0;

  return results.slice(offset, offset + limit);
}

// =====================
// BUCKETING & COMPACTION
// =====================

const buckets = new Map<string, LogBucket>();

/**
 * Initialize or update a bucket
 */
export function updateBucket(
  category: string,
  timestamp: number,
  event: {
    level: string;
    message: string;
    metrics?: RecentEvent["metrics"];
    error?: string;
  }
): void {
  const bucketId = getBucketId(timestamp, category);
  const hour = Math.floor(timestamp / 3600000) * 3600000;

  if (!buckets.has(bucketId)) {
    buckets.set(bucketId, {
      id: bucketId,
      timestamp: hour,
      category,
      level: event.level,
      eventCount: 0,
      errorCount: 0,
      warningCount: 0,
      apiCalls: 0,
      dbReads: 0,
      dbWrites: 0,
      dbDeletes: 0,
      latencyMs: { min: Infinity, max: 0, avg: 0, p95: 0 },
      memoryMb: { min: Infinity, max: 0, avg: 0 },
      topErrors: [],
      tokensInvolved: 0,
      walletsTouched: 0,
      compacted: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const bucket = buckets.get(bucketId)!;
  bucket.eventCount++;
  bucket.updatedAt = Date.now();

  if (event.level === "error") {
    bucket.errorCount++;
    if (event.error) {
      const existing = bucket.topErrors.find((e) => e.message === event.error);
      if (existing) {
        existing.count++;
      } else {
        bucket.topErrors.push({
          message: event.error,
          count: 1,
        });
      }
      // Keep top 10 errors
      bucket.topErrors.sort((a, b) => b.count - a.count).slice(0, 10);
    }
  } else if (event.level === "warn") {
    bucket.warningCount++;
  }

  // Update metrics
  if (event.metrics) {
    if (event.metrics.apiCalls)
      bucket.apiCalls += event.metrics.apiCalls;
    if (event.metrics.dbReads) bucket.dbReads += event.metrics.dbReads;
    if (event.metrics.dbWrites) bucket.dbWrites += event.metrics.dbWrites;
    if (event.metrics.dbDeletes) bucket.dbDeletes += event.metrics.dbDeletes;

    if (event.metrics.latencyMs) {
      const latencies = [
        ...(bucket.latencyMs as any),
        event.metrics.latencyMs,
      ];
      bucket.latencyMs.min = Math.min(bucket.latencyMs.min, event.metrics.latencyMs);
      bucket.latencyMs.max = Math.max(bucket.latencyMs.max, event.metrics.latencyMs);
      bucket.latencyMs.avg =
        latencies.reduce((a, b) => a + b, 0) / latencies.length;
      // Simple p95 approximation
      latencies.sort((a, b) => a - b);
      bucket.latencyMs.p95 = latencies[Math.floor(latencies.length * 0.95)];
    }

    if (event.metrics.memoryMb) {
      const memories = [
        ...(bucket.memoryMb as any),
        event.metrics.memoryMb,
      ];
      bucket.memoryMb.min = Math.min(bucket.memoryMb.min, event.metrics.memoryMb);
      bucket.memoryMb.max = Math.max(bucket.memoryMb.max, event.metrics.memoryMb);
      bucket.memoryMb.avg =
        memories.reduce((a, b) => a + b, 0) / memories.length;
    }
  }
}

/**
 * Get bucket summary for a time range
 */
export function getBucketSummary(
  category?: string,
  since?: number
): LogBucket[] {
  const cutoff = since || Date.now() - 24 * 60 * 60 * 1000; // Default 24 hours

  const results = Array.from(buckets.values()).filter((b) => {
    if (b.timestamp < cutoff) return false;
    if (category && b.category !== category) return false;
    return true;
  });

  return results.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Compact buckets older than 6 hours to database
 * (Save aggregated data, discard individual events)
 */
export async function compactOldBuckets(): Promise<number> {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  let compacted = 0;

  for (const [bucketId, bucket] of buckets) {
    if (bucket.timestamp < sixHoursAgo && !bucket.compacted) {
      try {
        // TODO: Insert bucket summary to database
        // await db.insert(logBuckets).values({
        //   bucketId: bucket.id,
        //   category: bucket.category,
        //   timestamp: bucket.timestamp,
        //   metrics: JSON.stringify(bucket),
        //   createdAt: bucket.createdAt,
        // });

        bucket.compacted = true;
        compacted++;
      } catch (error) {
        console.error("[LogBucket] Failed to compact bucket:", error);
      }
    }
  }

  return compacted;
}

/**
 * Prune buckets older than 24 hours from memory
 */
export async function pruneOldBuckets(): Promise<number> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const [bucketId, bucket] of buckets) {
    if (bucket.timestamp < oneDayAgo && bucket.compacted) {
      buckets.delete(bucketId);
      pruned++;
    }
  }

  return pruned;
}

/**
 * Get current bucket stats (for monitoring)
 */
export function getBucketStats(): {
  bucketCount: number;
  recentEventsCount: number;
  oldestBucket: number;
  newestBucket: number;
  memoryUsageMb: number;
} {
  const bucketArray = Array.from(buckets.values());
  const timestamps = bucketArray.map((b) => b.timestamp);

  // Rough memory estimate
  const memoryUsageMb = (
    (recentEvents.length * 300) + // ~300 bytes per event
    (buckets.size * 2000) // ~2KB per bucket
  ) / 1024 / 1024;

  return {
    bucketCount: buckets.size,
    recentEventsCount: recentEvents.length,
    oldestBucket: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    newestBucket: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    memoryUsageMb: parseFloat(memoryUsageMb.toFixed(2)),
  };
}

// =====================
// PERIODIC MAINTENANCE
// =====================

let maintenanceInterval: NodeJS.Timeout | null = null;

export function startLogMaintenance(intervalMs: number = 60 * 60 * 1000): void {
  if (maintenanceInterval) {
    console.warn("[LogMaintenance] Already running");
    return;
  }

  maintenanceInterval = setInterval(async () => {
    const compacted = await compactOldBuckets();
    const pruned = await pruneOldBuckets();
    const stats = getBucketStats();

    if (compacted > 0 || pruned > 0) {
      console.log(
        `[LogMaintenance] Compacted ${compacted} buckets, pruned ${pruned}, memory: ${stats.memoryUsageMb}MB`
      );
    }
  }, intervalMs);

  console.log("[LogMaintenance] Started with interval", intervalMs);
}

export function stopLogMaintenance(): void {
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
}
