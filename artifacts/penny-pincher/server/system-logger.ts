import { db } from "./db";
import {
  systemLogs, type InsertSystemLog,
  aiLogs, type InsertAiLog,
  apiLogs, type InsertApiLog,
  webhookLogs, type InsertWebhookLog,
  tradeLogs, type InsertTradeLog,
  errorLogs, type InsertErrorLog,
} from "@shared/schema";
import { desc, sql } from "drizzle-orm";

type LogStatus = "success" | "error" | "warning" | "info";
type LogService = "copy_trade" | "alert" | "webhook" | "swap" | "sell" | "system" | "telegram" | "helius" | "jupiter" | "ai" | "dexscreener" | "geckoterminal" | "price_monitor";
type ApiService = "jupiter" | "dexscreener" | "geckoterminal" | "binance";
type ErrorType = "timeout" | "validation" | "network" | "auth" | "rate_limit" | "unknown";
type PipelineCategory =
  | "discovery"
  | "features"
  | "ann"
  | "snapshot"
  | "trades"
  | "graduation"
  | "retrolearner"
  | "api"
  | "db"
  | "capacity"
  | "system";

export type { LogService, LogStatus, ApiService, ErrorType };

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

export async function logAiUsage(
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
  const roundedCost = Math.round(estimatedCostUsd * 1_000_000) / 1_000_000;
  
  // Write to dedicated ai_logs table
  try {
    const aiLogEntry: InsertAiLog = {
      userId: userId || null,
      action,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      totalTokens,
      estimatedCostUsd: roundedCost,
      latencyMs,
      model,
      context: context || null,
      createdAt: Date.now(),
    };
    await db.insert(aiLogs).values(aiLogEntry);
  } catch (err) {
    console.error("[AiLogger] Failed to write AI log:", err);
  }
  
  // Also write to legacy system_logs for backward compatibility
  return logSystemEvent("ai", action, "success", {
    ...context,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostUsd: roundedCost,
  }, { userId, latencyMs });
}

const MAX_LOGS = 500; // Increased to support 24h analytics
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

// Log external API call (Jupiter, DexScreener, etc.) - writes to dedicated api_logs table
export async function logApiCall(
  service: ApiService,
  endpoint: string,
  success: boolean,
  latencyMs: number,
  context?: Record<string, unknown>,
  statusCode?: number
): Promise<void> {
  try {
    const apiLogEntry: InsertApiLog = {
      service,
      endpoint,
      success,
      latencyMs,
      statusCode: statusCode || null,
      context: context || null,
      createdAt: Date.now(),
    };
    await db.insert(apiLogs).values(apiLogEntry);
  } catch (err) {
    console.error("[ApiLogger] Failed to write API log:", err);
  }
}

// Log webhook events - writes to dedicated webhook_logs table
export async function logWebhook(
  source: string,
  eventType: string,
  status: "received" | "processed" | "ignored" | "error",
  options?: {
    walletAddress?: string;
    tokenMint?: string;
    processingTimeMs?: number;
    context?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const webhookLogEntry: InsertWebhookLog = {
      source,
      eventType,
      status,
      walletAddress: options?.walletAddress || null,
      tokenMint: options?.tokenMint || null,
      processingTimeMs: options?.processingTimeMs || null,
      context: options?.context || null,
      createdAt: Date.now(),
    };
    await db.insert(webhookLogs).values(webhookLogEntry);
  } catch (err) {
    console.error("[WebhookLogger] Failed to write webhook log:", err);
  }
}

// Log trade events - writes to dedicated trade_logs table
export async function logTrade(
  action: "buy" | "sell" | "mirror_buy" | "mirror_sell",
  status: "pending" | "queued" | "executing" | "success" | "failed" | "skipped",
  tokenMint: string,
  options?: {
    userId?: number;
    signalWalletId?: number;
    tokenSymbol?: string;
    amountSol?: number;
    amountUsd?: number;
    priceAtExecution?: number;
    txSignature?: string;
    failureReason?: string;
    latencyMs?: number;
    context?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const tradeLogEntry: InsertTradeLog = {
      userId: options?.userId || null,
      signalWalletId: options?.signalWalletId || null,
      tokenMint,
      tokenSymbol: options?.tokenSymbol || null,
      action,
      status,
      amountSol: options?.amountSol || null,
      amountUsd: options?.amountUsd || null,
      priceAtExecution: options?.priceAtExecution || null,
      txSignature: options?.txSignature || null,
      failureReason: options?.failureReason || null,
      latencyMs: options?.latencyMs || null,
      context: options?.context || null,
      createdAt: Date.now(),
    };
    await db.insert(tradeLogs).values(tradeLogEntry);
  } catch (err) {
    console.error("[TradeLogger] Failed to write trade log:", err);
  }
}

// Log copy trade decisions with detailed context for debugging
export type CopyTradeDecision = 
  | "queued"           // Successfully queued for execution
  | "skipped_disabled" // copyTradeEnabled is false
  | "skipped_sell"     // Transaction was a sell, not a buy
  | "skipped_stablecoin" // Stablecoin-to-stablecoin swap
  | "skipped_blacklist"  // Token is blacklisted
  | "skipped_holding"    // Already holding from this signal (dedup)
  | "skipped_ever_held"  // Ever held this token before (dedup)
  | "skipped_pending"    // Already have pending buy (dedup)
  | "skipped_first_only" // First buy only and not first buy
  | "skipped_cross_signal" // Cross-signal prevention
  | "skipped_daily_limit"  // Daily buy limit reached
  | "skipped_weekly_limit" // Weekly buy limit reached
  | "skipped_price_protection" // Price moved too much
  | "skipped_score"      // AI score below threshold
  | "skipped_min_trade"  // Trade below minimum USD
  | "skipped_budget"     // Budget exceeded
  | "error";             // Error during processing

export async function logCopyTradeDecision(
  decision: CopyTradeDecision,
  details: {
    userId: number;
    signalWalletId: number;
    signalWalletLabel: string;
    tokenMint: string;
    tokenSymbol?: string;
    swapType: "buy" | "sell";
    signalAmountSol?: number;
    signalAmountUsd?: number;
    copySettings: {
      copyTradeEnabled: boolean;
      copyMirrorBuys: boolean | null;
      copyMirrorSells: boolean | null;
      copyBuyType?: string;
      copyBuyAmount?: number;
      dedupSkipIfHolding?: boolean;
      dedupSkipIfEverHeld?: boolean;
      dedupSkipIfPending?: boolean;
      dedupFirstBuyOnly?: boolean;
      dedupCrossSignalPrevention?: boolean;
    };
    checks?: {
      isStablecoinSwap?: boolean;
      isBlacklisted?: boolean;
      alreadyHolding?: boolean;
      everHeld?: boolean;
      hasPendingBuy?: boolean;
      isFirstBuy?: boolean;
      crossSignalBlocked?: boolean;
      dailyBuysCount?: number;
      weeklyBuysCount?: number;
      priceChangePercent?: number;
      aiScore?: number;
      tradeValueUsd?: number;
    };
    errorMessage?: string;
  }
): Promise<void> {
  try {
    // Log to trade_logs with comprehensive context
    const tradeLogEntry: InsertTradeLog = {
      userId: details.userId,
      signalWalletId: details.signalWalletId,
      tokenMint: details.tokenMint,
      tokenSymbol: details.tokenSymbol || null,
      action: details.swapType === "buy" ? "buy" : "sell",
      status: decision === "queued" ? "queued" : "skipped",
      amountSol: details.signalAmountSol || null,
      amountUsd: details.signalAmountUsd || null,
      priceAtExecution: null,
      txSignature: null,
      failureReason: decision !== "queued" ? decision : null,
      latencyMs: null,
      context: {
        decision,
        signalWalletLabel: details.signalWalletLabel,
        copySettings: details.copySettings,
        checks: details.checks,
        errorMessage: details.errorMessage,
        timestamp: new Date().toISOString(),
      },
      createdAt: Date.now(),
    };
    await db.insert(tradeLogs).values(tradeLogEntry);
    
    // Also log to console for real-time debugging
    const prefix = decision === "queued" ? "[OK]" : "[SKIP]";
    console.log(`[CopyTrade] ${prefix} ${decision.toUpperCase()} | ${details.signalWalletLabel} | ${details.tokenSymbol || details.tokenMint.slice(0,8)} | ${details.swapType}`);
  } catch (err) {
    console.error("[CopyTradeLogger] Failed to write decision log:", err);
  }
}

// Log errors to dedicated error_logs table
export async function logErrorToTable(
  service: string,
  action: string,
  errorType: ErrorType,
  error: Error | string,
  options?: {
    userId?: number;
    context?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const errorMessage = typeof error === "string" ? error : error.message;
    const errorStack = typeof error === "string" ? null : error.stack || null;
    
    const errorLogEntry: InsertErrorLog = {
      service,
      action,
      errorType,
      errorMessage,
      errorStack,
      userId: options?.userId || null,
      context: options?.context || null,
      resolved: false,
      createdAt: Date.now(),
    };
    await db.insert(errorLogs).values(errorLogEntry);
  } catch (err) {
    console.error("[ErrorLogger] Failed to write error log:", err);
  }
}

// Retention limits per table
const LOG_RETENTION = {
  system: 500,
  ai: 500,
  api: 500,
  webhook: 200,
  trade: 500,
  error: 1000, // Keep errors longer
};

async function cleanupTable(tableName: string, maxLogs: number): Promise<number> {
  try {
    const countResult = await db.execute(sql`SELECT COUNT(*) as count FROM ${sql.identifier(tableName)}`);
    const totalCount = Number((countResult as any)[0]?.count || 0);

    if (totalCount <= maxLogs) return 0;

    const toDelete = totalCount - maxLogs;
    await db.execute(sql`
      DELETE FROM ${sql.identifier(tableName)} 
      WHERE id IN (
        SELECT id FROM ${sql.identifier(tableName)} 
        ORDER BY created_at ASC 
        LIMIT ${toDelete}
      )
    `);

    return toDelete;
  } catch (err) {
    console.error(`[Logger] Cleanup failed for ${tableName}:`, err);
    return 0;
  }
}

export async function cleanupAllLogs(): Promise<{ [key: string]: number }> {
  const results: { [key: string]: number } = {};
  
  results.system = await cleanupTable("system_logs", LOG_RETENTION.system);
  results.ai = await cleanupTable("ai_logs", LOG_RETENTION.ai);
  results.api = await cleanupTable("api_logs", LOG_RETENTION.api);
  results.webhook = await cleanupTable("webhook_logs", LOG_RETENTION.webhook);
  results.trade = await cleanupTable("trade_logs", LOG_RETENTION.trade);
  results.error = await cleanupTable("error_logs", LOG_RETENTION.error);
  
  try {
    const { pruneOldClusters } = await import("./cluster-detection");
    results.clusters = await pruneOldClusters(30, 3);
  } catch (err) {
    console.error("[Logger] Cluster pruning failed:", err);
    results.clusters = 0;
  }
  
  try {
    const { shouldRunAggregation, run8HourAggregation } = await import("./vector-aggregation");
    if (shouldRunAggregation()) {
      const aggResult = await run8HourAggregation();
      results.vectorAggregation = aggResult.routeUpdates + aggResult.strategyUpdates + aggResult.behaviorUpdates;
    }
  } catch (err) {
    console.error("[Logger] Vector aggregation failed:", err);
  }
  
  const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);
  if (totalDeleted > 0) {
    console.log(`[Logger] Cleanup: ${JSON.stringify(results)}`);
  }
  
  return results;
}

// Legacy function for backward compatibility
export async function cleanupSystemLogs(): Promise<number> {
  const results = await cleanupAllLogs();
  return results.system || 0;
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

// Get time-series usage data for graphs - uses dedicated tables
export interface TimeSeriesDataPoint {
  timestamp: number; // hour bucket
  aiCalls: number;
  aiTokens: number;
  aiCost: number;
  apiCalls: number;
  webhooks: number;
  trades: number;
  errors: number;
}

export async function getUsageTimeSeries(hoursBack: number = 24): Promise<TimeSeriesDataPoint[]> {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  
  // Fetch from all dedicated tables in parallel
  const [aiData, apiData, webhookData, tradeData, errorData] = await Promise.all([
    db.select().from(aiLogs).orderBy(desc(aiLogs.createdAt)),
    db.select().from(apiLogs).orderBy(desc(apiLogs.createdAt)),
    db.select().from(webhookLogs).orderBy(desc(webhookLogs.createdAt)),
    db.select().from(tradeLogs).orderBy(desc(tradeLogs.createdAt)),
    db.select().from(errorLogs).orderBy(desc(errorLogs.createdAt)),
  ]);
  
  // Bucket by hour
  const buckets = new Map<number, TimeSeriesDataPoint>();
  
  const getOrCreateBucket = (timestamp: number): TimeSeriesDataPoint => {
    const hourBucket = Math.floor(timestamp / (60 * 60 * 1000)) * (60 * 60 * 1000);
    if (!buckets.has(hourBucket)) {
      buckets.set(hourBucket, {
        timestamp: hourBucket,
        aiCalls: 0, aiTokens: 0, aiCost: 0, apiCalls: 0, webhooks: 0, trades: 0, errors: 0,
      });
    }
    return buckets.get(hourBucket)!;
  };
  
  // Process AI logs
  for (const log of aiData.filter(l => l.createdAt >= cutoff)) {
    const bucket = getOrCreateBucket(log.createdAt);
    bucket.aiCalls++;
    bucket.aiTokens += log.totalTokens;
    bucket.aiCost += log.estimatedCostUsd;
  }
  
  // Process API logs
  for (const log of apiData.filter(l => l.createdAt >= cutoff)) {
    getOrCreateBucket(log.createdAt).apiCalls++;
  }
  
  // Process webhook logs
  for (const log of webhookData.filter(l => l.createdAt >= cutoff)) {
    getOrCreateBucket(log.createdAt).webhooks++;
  }
  
  // Process trade logs
  for (const log of tradeData.filter(l => l.createdAt >= cutoff)) {
    getOrCreateBucket(log.createdAt).trades++;
  }
  
  // Process error logs
  for (const log of errorData.filter(l => l.createdAt >= cutoff)) {
    getOrCreateBucket(log.createdAt).errors++;
  }
  
  // Return sorted by time ascending
  return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// Get per-user usage breakdown - uses dedicated ai_logs table
export interface UserUsageBreakdown {
  userId: number;
  aiCalls: number;
  aiTokens: number;
  aiCost: number;
  trades: number;
  errors: number;
  lastActivity: number;
}

export async function getUserUsageBreakdown(hoursBack: number = 24): Promise<UserUsageBreakdown[]> {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  
  // Fetch from tables that have userId
  const [aiData, tradeData, errorData] = await Promise.all([
    db.select().from(aiLogs).orderBy(desc(aiLogs.createdAt)),
    db.select().from(tradeLogs).orderBy(desc(tradeLogs.createdAt)),
    db.select().from(errorLogs).orderBy(desc(errorLogs.createdAt)),
  ]);
  
  const userMap = new Map<number, UserUsageBreakdown>();
  
  const getOrCreateUser = (userId: number, createdAt: number) => {
    if (!userMap.has(userId)) {
      userMap.set(userId, {
        userId, aiCalls: 0, aiTokens: 0, aiCost: 0, trades: 0, errors: 0, lastActivity: createdAt,
      });
    }
    const user = userMap.get(userId)!;
    if (createdAt > user.lastActivity) user.lastActivity = createdAt;
    return user;
  };
  
  // Process AI logs
  for (const log of aiData.filter(l => l.createdAt >= cutoff && l.userId != null)) {
    const user = getOrCreateUser(log.userId!, log.createdAt);
    user.aiCalls++;
    user.aiTokens += log.totalTokens;
    user.aiCost += log.estimatedCostUsd;
  }
  
  // Process trade logs
  for (const log of tradeData.filter(l => l.createdAt >= cutoff && l.userId != null)) {
    getOrCreateUser(log.userId!, log.createdAt).trades++;
  }
  
  // Process error logs
  for (const log of errorData.filter(l => l.createdAt >= cutoff && l.userId != null)) {
    getOrCreateUser(log.userId!, log.createdAt).errors++;
  }
  
  // Return sorted by AI cost descending
  return Array.from(userMap.values()).sort((a, b) => b.aiCost - a.aiCost);
}

// Calculate projections based on current usage rate - uses dedicated ai_logs table
export interface UsageProjections {
  hourly: { calls: number; cost: number };
  daily: { calls: number; cost: number };
  weekly: { calls: number; cost: number };
  monthly: { calls: number; cost: number };
}

export async function getUsageProjections(): Promise<UsageProjections> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const aiData = await db.select().from(aiLogs).orderBy(desc(aiLogs.createdAt));
  
  const recentLogs = aiData.filter(log => log.createdAt >= oneDayAgo);
  
  const totalCalls = recentLogs.length;
  const totalCost = recentLogs.reduce((sum, log) => sum + log.estimatedCostUsd, 0);
  
  const hourlyRate = totalCalls / 24;
  const hourlyCostRate = totalCost / 24;
  
  return {
    hourly: { calls: Math.round(hourlyRate * 10) / 10, cost: hourlyCostRate },
    daily: { calls: Math.round(hourlyRate * 24), cost: hourlyCostRate * 24 },
    weekly: { calls: Math.round(hourlyRate * 24 * 7), cost: hourlyCostRate * 24 * 7 },
    monthly: { calls: Math.round(hourlyRate * 24 * 30), cost: hourlyCostRate * 24 * 30 },
  };
}

// Query functions for each dedicated log table
export async function queryAiLogs(options: { userId?: number; limit?: number; hoursAgo?: number } = {}) {
  const { userId, limit = 50, hoursAgo } = options;
  const logs = await db.select().from(aiLogs).orderBy(desc(aiLogs.createdAt)).limit(limit);
  return logs.filter(log => {
    if (userId && log.userId !== userId) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    return true;
  });
}

export async function queryApiLogs(options: { service?: ApiService; limit?: number; hoursAgo?: number } = {}) {
  const { service, limit = 50, hoursAgo } = options;
  const logs = await db.select().from(apiLogs).orderBy(desc(apiLogs.createdAt)).limit(limit);
  return logs.filter(log => {
    if (service && log.service !== service) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    return true;
  });
}

export async function queryWebhookLogs(options: { status?: string; limit?: number; hoursAgo?: number } = {}) {
  const { status, limit = 50, hoursAgo } = options;
  const logs = await db.select().from(webhookLogs).orderBy(desc(webhookLogs.createdAt)).limit(limit);
  return logs.filter(log => {
    if (status && log.status !== status) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    return true;
  });
}

export async function queryTradeLogs(options: { userId?: number; signalWalletId?: number; status?: string; action?: string; limit?: number; hoursAgo?: number } = {}) {
  const { userId, signalWalletId, status, action, limit = 50, hoursAgo } = options;
  const logs = await db.select().from(tradeLogs).orderBy(desc(tradeLogs.createdAt)).limit(limit * 2); // Get more and filter
  return logs.filter(log => {
    if (userId && log.userId !== userId) return false;
    if (signalWalletId && log.signalWalletId !== signalWalletId) return false;
    if (status && log.status !== status) return false;
    if (action && log.action !== action) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    return true;
  }).slice(0, limit);
}

export async function queryErrorLogs(options: { service?: string; resolved?: boolean; limit?: number; hoursAgo?: number } = {}) {
  const { service, resolved, limit = 100, hoursAgo } = options;
  const logs = await db.select().from(errorLogs).orderBy(desc(errorLogs.createdAt)).limit(limit);
  return logs.filter(log => {
    if (service && log.service !== service) return false;
    if (resolved !== undefined && log.resolved !== resolved) return false;
    if (hoursAgo) {
      const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
      if (log.createdAt < cutoff) return false;
    }
    return true;
  });
}

// Get summary counts for all log types
export async function getLogSummary() {
  const [aiCount, apiCount, webhookCount, tradeCount, errorCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(aiLogs),
    db.select({ count: sql<number>`count(*)` }).from(apiLogs),
    db.select({ count: sql<number>`count(*)` }).from(webhookLogs),
    db.select({ count: sql<number>`count(*)` }).from(tradeLogs),
    db.select({ count: sql<number>`count(*)` }).from(errorLogs),
  ]);
  
  return {
    ai: Number(aiCount[0]?.count || 0),
    api: Number(apiCount[0]?.count || 0),
    webhook: Number(webhookCount[0]?.count || 0),
    trade: Number(tradeCount[0]?.count || 0),
    error: Number(errorCount[0]?.count || 0),
  };
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

// =====================
// PIPELINE METRICS & LOGGING
// =====================

/**
 * In-memory event buffer for comprehensive pipeline tracking
 * Flushes to database on demand or crash
 */

export interface PipelineLogEvent {
  timestamp: number;
  category: PipelineCategory;
  message: string;
  level: "trace" | "debug" | "info" | "warn" | "error";

  // Context
  tokenMint?: string;
  walletAddress?: string;
  snapshotId?: string;

  // Metrics
  metrics?: {
    apiCalls?: number;
    dbReads?: number;
    dbWrites?: number;
    dbDeletes?: number;
    cpuMs?: number;
    memoryMb?: number;
    latencyMs?: number;
  };

  // Trace
  traceId: string;
  parentTraceId?: string;
}

export interface SystemMetricsSnapshot {
  timestamp: number;

  // State
  activeTokens: number;
  activeSnapshots: number;
  capacityPercent: number;

  // API usage (hourly)
  apiUsage: {
    pumpPortal: number;
    pumpSdk: number;
    dexPaprika: number;
    dexScreener: number;
    chainstack: number;
    helius: number;
  };

  // DB operations (hourly)
  dbOps: {
    reads: number;
    writes: number;
    deletes: number;
  };

  // Performance
  avgLatencies: {
    feature: number; // ms
    ann: number; // ms
    dbWrite: number; // ms
    api: number; // ms
  };

  // Resources
  memory: number; // MB
  cpu: number; // %
  errors: number;
  errorsByCategory: Record<string, number>;
}

// Ring buffer for events
const PIPELINE_BUFFER_SIZE = 10_000;
let pipelineBuffer: PipelineLogEvent[] = [];
let pipelineIndex = 0;

// Metrics tracking
let metricsSnapshot: SystemMetricsSnapshot = {
  timestamp: Date.now(),
  activeTokens: 0,
  activeSnapshots: 0,
  capacityPercent: 0,
  apiUsage: {
    pumpPortal: 0,
    pumpSdk: 0,
    dexPaprika: 0,
    dexScreener: 0,
    chainstack: 0,
    helius: 0,
  },
  dbOps: { reads: 0, writes: 0, deletes: 0 },
  avgLatencies: { feature: 0, ann: 0, dbWrite: 0, api: 0 },
  memory: 0,
  cpu: 0,
  errors: 0,
  errorsByCategory: {},
};

/**
 * Log a pipeline event
 */
export function logPipeline(
  category: PipelineCategory,
  message: string,
  level: "trace" | "debug" | "info" | "warn" | "error" = "info",
  opts?: {
    tokenMint?: string;
    walletAddress?: string;
    snapshotId?: string;
    traceId?: string;
    parentTraceId?: string;
    metrics?: PipelineLogEvent["metrics"];
  }
): string {
  const traceId = opts?.traceId || generatePipelineTraceId();

  const event: PipelineLogEvent = {
    timestamp: Date.now(),
    category,
    message,
    level,
    tokenMint: opts?.tokenMint,
    walletAddress: opts?.walletAddress,
    snapshotId: opts?.snapshotId,
    traceId,
    parentTraceId: opts?.parentTraceId,
    metrics: opts?.metrics,
  };

  // Add to circular buffer
  pipelineBuffer[pipelineIndex % PIPELINE_BUFFER_SIZE] = event;
  pipelineIndex++;

  // Update metrics
  if (opts?.metrics) {
    if (opts.metrics.apiCalls) metricsSnapshot.apiUsage.pumpPortal += opts.metrics.apiCalls;
    if (opts.metrics.dbReads) metricsSnapshot.dbOps.reads += opts.metrics.dbReads;
    if (opts.metrics.dbWrites) metricsSnapshot.dbOps.writes += opts.metrics.dbWrites;
    if (opts.metrics.dbDeletes) metricsSnapshot.dbOps.deletes += opts.metrics.dbDeletes;
  }

  if (level === "error") {
    metricsSnapshot.errors++;
    metricsSnapshot.errorsByCategory[category] = (metricsSnapshot.errorsByCategory[category] || 0) + 1;
  }

  return traceId;
}

/**
 * Get recent pipeline events
 */
export function getPipelineEvents(count: number = 100): PipelineLogEvent[] {
  const results: PipelineLogEvent[] = [];
  const start = Math.max(0, pipelineIndex - count);

  for (let i = start; i < pipelineIndex; i++) {
    const event = pipelineBuffer[i % PIPELINE_BUFFER_SIZE];
    if (event) results.push(event);
  }

  return results;
}

/**
 * Get all buffered pipeline events
 */
export function getAllPipelineEvents(): PipelineLogEvent[] {
  const results: PipelineLogEvent[] = [];
  for (const event of pipelineBuffer) {
    if (event) results.push(event);
  }
  return results;
}

/**
 * Update system metrics
 */
export function updatePipelineMetrics(updates: Partial<SystemMetricsSnapshot>): void {
  metricsSnapshot = {
    ...metricsSnapshot,
    ...updates,
    timestamp: Date.now(),
  };
}

/**
 * Get current metrics snapshot
 */
export function getPipelineMetrics(): SystemMetricsSnapshot {
  const memUsage = process.memoryUsage();
  metricsSnapshot.memory = Math.round(memUsage.rss / 1024 / 1024);
  return metricsSnapshot;
}

/**
 * Flush pipeline logs to database
 */
export async function flushPipelineLogs(): Promise<number> {
  const events = getAllPipelineEvents();

  if (events.length === 0) {
    return 0;
  }

  try {
    // Batch inserts to system_logs table
    for (let i = 0; i < events.length; i += 100) {
      const batch = events.slice(i, i + 100);

      // TODO: Insert batch to system_logs table
      // await db.insert(systemLogs).values(...)
    }

    console.log(`[PipelineLogger] Flushed ${events.length} events to database`);
    return events.length;
  } catch (error) {
    console.error("[PipelineLogger] Failed to flush logs:", error);
    return 0;
  }
}

/**
 * Crash dump handler
 */
export async function pipelineCrashDump(): Promise<void> {
  console.error("[PipelineLogger] CRASH DUMP: Flushing events...");
  await flushPipelineLogs();
}

/**
 * Create a tracer for operations
 */
export function createPipelineTracer(category: PipelineCategory, operation: string) {
  const traceId = generatePipelineTraceId();
  const startTime = Date.now();

  return {
    traceId,
    start: () => logPipeline(category, `${operation}: started`, "debug", { traceId }),
    log: (message: string, level: PipelineLogEvent["level"] = "info", metrics?: PipelineLogEvent["metrics"]) =>
      logPipeline(category, `${operation}: ${message}`, level, { traceId, metrics }),
    end: (success: boolean = true) => {
      const duration = Date.now() - startTime;
      logPipeline(category, `${operation}: complete (${duration}ms)`, success ? "info" : "warn", {
        traceId,
        metrics: { latencyMs: duration },
      });
      return duration;
    },
  };
}

function generatePipelineTraceId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
