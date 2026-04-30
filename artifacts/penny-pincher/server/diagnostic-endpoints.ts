/**
 * Diagnostic Logging Endpoints
 *
 * Provides structured API endpoints for querying logs, metrics, and diagnostic data
 * Makes it easy for Claude (or operators) to diagnose system issues without exposing
 * raw 10K event buffer
 */

import type { Express, Request, Response } from "express";
import {
  getRecentEvents,
  getBucketSummary,
  getBucketStats,
  type DiagnosticQuery,
} from "./log-buckets";

/**
 * Register all diagnostic endpoints
 */
export function registerDiagnosticEndpoints(app: Express): void {
  /**
   * GET /api/system/logs/recent
   * Query recent raw events with optional filtering
   *
   * Query parameters:
   * - category: string (discovery, features, ann, snapshot, trades, graduation, retrolearner, api, db, capacity, system)
   * - level: string (debug, info, warn, error)
   * - tokenMint: string (filter by token)
   * - walletAddress: string (filter by wallet)
   * - timeRange: JSON string {start, end} (ISO timestamps)
   * - limit: number (default 100, max 1000)
   * - offset: number (default 0)
   *
   * Example:
   * GET /api/system/logs/recent?category=discovery&level=error&limit=50
   * GET /api/system/logs/recent?tokenMint=ABC123&limit=200
   */
  app.get("/api/system/logs/recent", async (req: Request, res: Response) => {
    try {
      const {
        category,
        level,
        tokenMint,
        walletAddress,
        timeRange,
        limit = "100",
        offset = "0",
      } = req.query;

      const query: DiagnosticQuery = {
        category: category as string | undefined,
        level: level as string | undefined,
        tokenMint: tokenMint as string | undefined,
        walletAddress: walletAddress as string | undefined,
        limit: Math.min(parseInt(limit as string) || 100, 1000),
        offset: parseInt(offset as string) || 0,
      };

      // Parse timeRange if provided
      if (typeof timeRange === "string") {
        try {
          const range = JSON.parse(timeRange);
          query.timeRange = {
            start: new Date(range.start).getTime(),
            end: new Date(range.end).getTime(),
          };
        } catch (e) {
          return res.status(400).json({ error: "Invalid timeRange format" });
        }
      }

      const events = getRecentEvents(query);

      return res.json({
        success: true,
        count: events.length,
        limit: query.limit,
        offset: query.offset,
        events,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/recent:", error);
      return res.status(500).json({
        error: "Failed to query recent events",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/buckets
   * Query hourly bucket summaries for aggregated statistics
   *
   * Query parameters:
   * - category: string (optional filter)
   * - since: number (milliseconds in past, default 86400000 = 24h)
   * - hours: number (alternative to since - how many hours back, default 24)
   *
   * Example:
   * GET /api/system/logs/buckets - last 24 hours, all categories
   * GET /api/system/logs/buckets?category=retrolearner&hours=6 - last 6 hours, retrolearner only
   * GET /api/system/logs/buckets?category=api&since=3600000 - last 1 hour, API only
   */
  app.get("/api/system/logs/buckets", async (req: Request, res: Response) => {
    try {
      const { category, since, hours } = req.query;

      // Calculate since timestamp
      let sinceTimestamp: number;
      if (since) {
        sinceTimestamp = Date.now() - parseInt(since as string);
      } else if (hours) {
        sinceTimestamp = Date.now() - parseInt(hours as string) * 60 * 60 * 1000;
      } else {
        sinceTimestamp = Date.now() - 24 * 60 * 60 * 1000; // Default 24 hours
      }

      const buckets = getBucketSummary(category as string | undefined, sinceTimestamp);

      return res.json({
        success: true,
        count: buckets.length,
        category: category || "all",
        timeRange: {
          since: new Date(sinceTimestamp).toISOString(),
          until: new Date().toISOString(),
        },
        buckets,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/buckets:", error);
      return res.status(500).json({
        error: "Failed to query buckets",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/stats
   * Get current buffer and bucket statistics
   *
   * Returns:
   * - bucketCount: number of buckets in memory
   * - recentEventsCount: number of raw events in buffer
   * - oldestBucket: timestamp of oldest bucket
   * - newestBucket: timestamp of newest bucket
   * - memoryUsageMb: estimated memory usage in MB
   * - bufferHealth: object with status and recommendations
   */
  app.get("/api/system/logs/stats", async (req: Request, res: Response) => {
    try {
      const stats = getBucketStats();

      // Calculate buffer health
      const bufferHealth = {
        recentEventsFilled: `${((stats.recentEventsCount / 5000) * 100).toFixed(1)}%`,
        bucketCount: stats.bucketCount,
        memoryHealthy: stats.memoryUsageMb < 50, // Warn if >50MB
        recommendation:
          stats.memoryUsageMb > 50
            ? "Buffer approaching size limit, consider increasing compaction frequency"
            : "Buffer within healthy limits",
      };

      return res.json({
        success: true,
        stats,
        bufferHealth,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/stats:", error);
      return res.status(500).json({
        error: "Failed to get stats",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/errors
   * Get error trends and summary
   *
   * Query parameters:
   * - hours: number (default 24)
   * - category: string (optional filter)
   * - topN: number (return top N errors, default 10)
   *
   * Returns aggregated error data by type and category
   */
  app.get("/api/system/logs/errors", async (req: Request, res: Response) => {
    try {
      const { hours = "24", category, topN = "10" } = req.query;

      const sinceTimestamp = Date.now() - parseInt(hours as string) * 60 * 60 * 1000;
      const buckets = getBucketSummary(category as string | undefined, sinceTimestamp);

      // Aggregate error data
      const errorSummary: Record<string, { count: number; topErrors: string[] }> = {};
      let totalErrors = 0;

      for (const bucket of buckets) {
        if (bucket.errorCount > 0) {
          if (!errorSummary[bucket.category]) {
            errorSummary[bucket.category] = { count: 0, topErrors: [] };
          }
          errorSummary[bucket.category].count += bucket.errorCount;
          totalErrors += bucket.errorCount;

          // Collect top error messages
          bucket.topErrors.forEach((err) => {
            const idx = errorSummary[bucket.category].topErrors.findIndex(
              (e) => e === err.message
            );
            if (idx >= 0) {
              // Already in list, could track count but keeping simple
            } else {
              errorSummary[bucket.category].topErrors.push(err.message);
            }
          });
        }
      }

      // Limit top errors
      const topNLimit = parseInt(topN as string);
      for (const cat in errorSummary) {
        errorSummary[cat].topErrors = errorSummary[cat].topErrors.slice(0, topNLimit);
      }

      return res.json({
        success: true,
        timeRange: {
          hours: parseInt(hours as string),
          since: new Date(sinceTimestamp).toISOString(),
          until: new Date().toISOString(),
        },
        totalErrors,
        byCategory: errorSummary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/errors:", error);
      return res.status(500).json({
        error: "Failed to get error trends",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/api-usage
   * Show API call statistics per service
   *
   * Query parameters:
   * - hours: number (default 24)
   *
   * Returns API usage aggregated by service (PumpPortal, DexPaprika, Chainstack, etc.)
   */
  app.get("/api/system/logs/api-usage", async (req: Request, res: Response) => {
    try {
      const { hours = "24" } = req.query;

      const sinceTimestamp = Date.now() - parseInt(hours as string) * 60 * 60 * 1000;
      const buckets = getBucketSummary("api", sinceTimestamp);

      // Aggregate API usage
      const apiUsage: Record<
        string,
        { callsTotal: number; bucketsContributing: number; average: number }
      > = {};
      const timeRange = parseInt(hours as string);

      for (const bucket of buckets) {
        const service =
          bucket.category === "api" ? bucket.level || "unknown" : bucket.category;

        if (!apiUsage[service]) {
          apiUsage[service] = { callsTotal: 0, bucketsContributing: 0, average: 0 };
        }

        apiUsage[service].callsTotal += bucket.apiCalls;
        apiUsage[service].bucketsContributing += 1;
      }

      // Calculate averages
      for (const service in apiUsage) {
        const data = apiUsage[service];
        data.average = data.bucketsContributing > 0 ? data.callsTotal / data.bucketsContributing : 0;
      }

      return res.json({
        success: true,
        timeRange: {
          hours: parseInt(hours as string),
          since: new Date(sinceTimestamp).toISOString(),
          until: new Date().toISOString(),
        },
        apiUsageByService: apiUsage,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/api-usage:", error);
      return res.status(500).json({
        error: "Failed to get API usage",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/db-ops
   * Show database operation statistics
   *
   * Query parameters:
   * - hours: number (default 24)
   *
   * Returns database read/write/delete statistics aggregated by hour
   */
  app.get("/api/system/logs/db-ops", async (req: Request, res: Response) => {
    try {
      const { hours = "24" } = req.query;

      const sinceTimestamp = Date.now() - parseInt(hours as string) * 60 * 60 * 1000;
      const buckets = getBucketSummary("db", sinceTimestamp);

      // Aggregate DB operations
      let totalReads = 0;
      let totalWrites = 0;
      let totalDeletes = 0;
      const byHour: Record<string, { reads: number; writes: number; deletes: number }> = {};

      for (const bucket of buckets) {
        totalReads += bucket.dbReads;
        totalWrites += bucket.dbWrites;
        totalDeletes += bucket.dbDeletes;

        const hourKey = new Date(bucket.timestamp).toISOString().split("T")[0];

        if (!byHour[hourKey]) {
          byHour[hourKey] = { reads: 0, writes: 0, deletes: 0 };
        }
        byHour[hourKey].reads += bucket.dbReads;
        byHour[hourKey].writes += bucket.dbWrites;
        byHour[hourKey].deletes += bucket.dbDeletes;
      }

      // Calculate percentages
      const totalOps = totalReads + totalWrites + totalDeletes;
      const percentages = {
        reads: totalOps > 0 ? ((totalReads / totalOps) * 100).toFixed(1) : "0",
        writes: totalOps > 0 ? ((totalWrites / totalOps) * 100).toFixed(1) : "0",
        deletes: totalOps > 0 ? ((totalDeletes / totalOps) * 100).toFixed(1) : "0",
      };

      return res.json({
        success: true,
        timeRange: {
          hours: parseInt(hours as string),
          since: new Date(sinceTimestamp).toISOString(),
          until: new Date().toISOString(),
        },
        summary: {
          totalReads,
          totalWrites,
          totalDeletes,
          totalOps,
          percentages,
          averagePerHour: {
            reads: (totalReads / Math.max(1, buckets.length)).toFixed(0),
            writes: (totalWrites / Math.max(1, buckets.length)).toFixed(0),
            deletes: (totalDeletes / Math.max(1, buckets.length)).toFixed(0),
          },
        },
        byHour,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/db-ops:", error);
      return res.status(500).json({
        error: "Failed to get DB operations",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/system/logs/health
   * Overall system health summary
   *
   * Combines data from all other endpoints to give a quick health assessment
   */
  app.get("/api/system/logs/health", async (req: Request, res: Response) => {
    try {
      const stats = getBucketStats();
      const buckets24h = getBucketSummary(undefined, Date.now() - 24 * 60 * 60 * 1000);

      // Calculate health indicators
      let totalEvents = 0;
      let totalErrors = 0;
      let totalWarnings = 0;
      let totalApiCalls = 0;
      let totalDbOps = 0;

      for (const bucket of buckets24h) {
        totalEvents += bucket.eventCount;
        totalErrors += bucket.errorCount;
        totalWarnings += bucket.warningCount;
        totalApiCalls += bucket.apiCalls;
        totalDbOps += bucket.dbReads + bucket.dbWrites + bucket.dbDeletes;
      }

      // Calculate error rate
      const errorRate =
        totalEvents > 0 ? ((totalErrors / totalEvents) * 100).toFixed(2) : "0";

      // Determine health status
      let healthStatus = "healthy";
      const issues: string[] = [];

      if (stats.memoryUsageMb > 50) {
        healthStatus = "warning";
        issues.push("Memory usage approaching limit");
      }

      if (parseFloat(errorRate) > 5) {
        healthStatus = "warning";
        issues.push("Error rate elevated (>5%)");
      }

      if (parseFloat(errorRate) > 10) {
        healthStatus = "critical";
        issues.push("Error rate critical (>10%)");
      }

      if (totalEvents === 0) {
        healthStatus = "warning";
        issues.push("No events logged in last 24 hours");
      }

      return res.json({
        success: true,
        healthStatus,
        issues,
        last24h: {
          totalEvents,
          totalErrors,
          totalWarnings,
          totalApiCalls,
          totalDbOps,
          errorRate: `${errorRate}%`,
        },
        bufferStats: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[DiagnosticEndpoints] Error in /api/system/logs/health:", error);
      return res.status(500).json({
        error: "Failed to get health status",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
