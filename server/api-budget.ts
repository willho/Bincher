import { db } from "./db";
import { apiUsage, apiBudgetConfig } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";

export type ApiService = "helius" | "dexscreener" | "openai" | "geckoterminal";

interface ServiceRateLimits {
  perMinute: number;
  dailyCap: number;
  monthlyCap: number;
}

const RATE_LIMITS: Record<ApiService, ServiceRateLimits> = {
  geckoterminal: { perMinute: 30, dailyCap: 0, monthlyCap: 0 },
  dexscreener: { perMinute: 300, dailyCap: 0, monthlyCap: 0 },
  helius: { perMinute: 600, dailyCap: 0, monthlyCap: 1_000_000 },
  openai: { perMinute: 60, dailyCap: 250, monthlyCap: 5000 },
};

interface PerMinuteTracker {
  calls: number;
  windowStart: number;
  backoffUntil: number;
  backoffMultiplier: number;
  consecutiveErrors: number;
}

const minuteTrackers: Map<string, PerMinuteTracker> = new Map();

const lastLogState: Map<string, { state: string; loggedAt: number }> = new Map();
const LOG_SUPPRESS_MS = 60_000;

function getMinuteTracker(service: string, endpoint?: string): PerMinuteTracker {
  const key = endpoint ? `${service}:${endpoint}` : service;
  let tracker = minuteTrackers.get(key);
  if (!tracker) {
    tracker = { calls: 0, windowStart: Date.now(), backoffUntil: 0, backoffMultiplier: 1, consecutiveErrors: 0 };
    minuteTrackers.set(key, tracker);
  }
  const now = Date.now();
  if (now - tracker.windowStart >= 60_000) {
    tracker.calls = 0;
    tracker.windowStart = now;
  }
  return tracker;
}

function shouldLogStateChange(service: string, newState: string): boolean {
  const key = service;
  const prev = lastLogState.get(key);
  const now = Date.now();
  if (!prev || prev.state !== newState || now - prev.loggedAt >= LOG_SUPPRESS_MS) {
    lastLogState.set(key, { state: newState, loggedAt: now });
    return true;
  }
  return false;
}

const usageCache: Map<string, { count: number; cachedAt: number }> = new Map();
const CACHE_TTL_MS = 10000;

function getDateStrings(): { date: string; month: string } {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const month = date.slice(0, 7);
  return { date, month };
}

export async function trackApiCall(
  service: ApiService,
  endpoint?: string,
  callCount: number = 1
): Promise<void> {
  try {
    const { date, month } = getDateStrings();
    const timestamp = Math.floor(Date.now() / 1000);
    
    await db.insert(apiUsage).values({
      service,
      endpoint,
      callCount,
      timestamp,
      date,
      month,
    });
    
    usageCache.delete(`${service}_daily`);
    usageCache.delete(`${service}_monthly`);
    
    const tracker = getMinuteTracker(service);
    tracker.calls += callCount;
    tracker.consecutiveErrors = 0;
    tracker.backoffMultiplier = 1;
  } catch (error) {
    console.error(`Error tracking API call for ${service}:`, error);
  }
}

export function record429(service: ApiService): void {
  const tracker = getMinuteTracker(service);
  tracker.consecutiveErrors++;
  tracker.backoffMultiplier = Math.min(16, tracker.backoffMultiplier * 2);
  const backoffMs = tracker.backoffMultiplier * 5000;
  tracker.backoffUntil = Date.now() + backoffMs;
  if (shouldLogStateChange(service, "backoff")) {
    console.log(`[ApiBudget] ${service} hit 429, backing off ${backoffMs / 1000}s (x${tracker.backoffMultiplier})`);
  }
}

export async function getDailyUsage(service: ApiService): Promise<number> {
  const cacheKey = `${service}_daily`;
  const cached = usageCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.count;
  }
  
  const { date } = getDateStrings();
  const result = await db.select({
    total: sql<number>`COALESCE(SUM(${apiUsage.callCount}), 0)`,
  })
    .from(apiUsage)
    .where(and(eq(apiUsage.service, service), eq(apiUsage.date, date)));
  
  const count = Number(result[0]?.total || 0);
  usageCache.set(cacheKey, { count, cachedAt: Date.now() });
  return count;
}

export async function getMonthlyUsage(service: ApiService): Promise<number> {
  const cacheKey = `${service}_monthly`;
  const cached = usageCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.count;
  }
  
  const { month } = getDateStrings();
  const result = await db.select({
    total: sql<number>`COALESCE(SUM(${apiUsage.callCount}), 0)`,
  })
    .from(apiUsage)
    .where(and(eq(apiUsage.service, service), eq(apiUsage.month, month)));
  
  const count = Number(result[0]?.total || 0);
  usageCache.set(cacheKey, { count, cachedAt: Date.now() });
  return count;
}

export async function getBudgetConfig(service: ApiService): Promise<{
  monthlyLimit: number;
  dailyLimit: number;
  warningThreshold: number;
  pauseThreshold: number;
  isPaused: boolean;
}> {
  const limits = RATE_LIMITS[service];
  const config = await db.select()
    .from(apiBudgetConfig)
    .where(eq(apiBudgetConfig.service, service))
    .limit(1);
  
  if (config.length === 0) {
    return {
      monthlyLimit: limits.monthlyCap,
      dailyLimit: limits.dailyCap,
      warningThreshold: 80,
      pauseThreshold: 95,
      isPaused: false,
    };
  }
  
  return {
    monthlyLimit: limits.monthlyCap > 0 ? limits.monthlyCap : config[0].monthlyLimit,
    dailyLimit: limits.dailyCap > 0 ? limits.dailyCap : config[0].dailyLimit,
    warningThreshold: config[0].warningThreshold,
    pauseThreshold: config[0].pauseThreshold,
    isPaused: config[0].isPaused,
  };
}

export async function updateBudgetConfig(
  service: ApiService,
  updates: Partial<{
    monthlyLimit: number;
    dailyLimit: number;
    warningThreshold: number;
    pauseThreshold: number;
    isPaused: boolean;
  }>
): Promise<void> {
  const existing = await db.select()
    .from(apiBudgetConfig)
    .where(eq(apiBudgetConfig.service, service))
    .limit(1);
  
  const updatedAt = Math.floor(Date.now() / 1000);
  const limits = RATE_LIMITS[service];
  
  if (existing.length === 0) {
    await db.insert(apiBudgetConfig).values({
      service,
      monthlyLimit: updates.monthlyLimit ?? limits.monthlyCap,
      dailyLimit: updates.dailyLimit ?? limits.dailyCap,
      warningThreshold: updates.warningThreshold ?? 80,
      pauseThreshold: updates.pauseThreshold ?? 95,
      isPaused: updates.isPaused ?? false,
      updatedAt,
    });
  } else {
    await db.update(apiBudgetConfig)
      .set({ ...updates, updatedAt })
      .where(eq(apiBudgetConfig.service, service));
  }
}

export async function getBudgetStatus(service: ApiService): Promise<{
  service: ApiService;
  dailyUsage: number;
  monthlyUsage: number;
  dailyLimit: number;
  monthlyLimit: number;
  dailyPercent: number;
  monthlyPercent: number;
  warningThreshold: number;
  pauseThreshold: number;
  isPaused: boolean;
  isWarning: boolean;
  shouldPause: boolean;
  perMinuteUsage: number;
  perMinuteLimit: number;
  isRateLimited: boolean;
  isBackingOff: boolean;
  throttleFactor: number;
}> {
  const [dailyUsage, monthlyUsage, config] = await Promise.all([
    getDailyUsage(service),
    getMonthlyUsage(service),
    getBudgetConfig(service),
  ]);
  
  const limits = RATE_LIMITS[service];
  const tracker = getMinuteTracker(service);
  
  const dailyPercent = config.dailyLimit > 0 ? (dailyUsage / config.dailyLimit) * 100 : 0;
  const monthlyPercent = config.monthlyLimit > 0 ? (monthlyUsage / config.monthlyLimit) * 100 : 0;
  
  const maxPercent = Math.max(dailyPercent, monthlyPercent);
  const isWarning = config.dailyLimit > 0 || config.monthlyLimit > 0 ? maxPercent >= config.warningThreshold : false;
  const shouldPause = config.dailyLimit > 0 || config.monthlyLimit > 0 ? maxPercent >= config.pauseThreshold : false;
  
  const perMinuteUsage = tracker.calls;
  const perMinuteLimit = limits.perMinute;
  const minutePercent = perMinuteLimit > 0 ? (perMinuteUsage / perMinuteLimit) * 100 : 0;
  const isRateLimited = minutePercent >= 90;
  const isBackingOff = Date.now() < tracker.backoffUntil;
  
  let throttleFactor = 1.0;
  if (minutePercent >= 90) {
    throttleFactor = Math.max(0.1, (perMinuteLimit - perMinuteUsage) / perMinuteLimit);
  }
  if (shouldPause && (config.dailyLimit > 0 || config.monthlyLimit > 0)) {
    throttleFactor = Math.min(throttleFactor, 0.1);
  }
  
  return {
    service,
    dailyUsage,
    monthlyUsage,
    dailyLimit: config.dailyLimit,
    monthlyLimit: config.monthlyLimit,
    dailyPercent: Math.round(dailyPercent * 10) / 10,
    monthlyPercent: Math.round(monthlyPercent * 10) / 10,
    warningThreshold: config.warningThreshold,
    pauseThreshold: config.pauseThreshold,
    isPaused: config.isPaused,
    isWarning,
    shouldPause,
    perMinuteUsage,
    perMinuteLimit,
    isRateLimited,
    isBackingOff,
    throttleFactor,
  };
}

export async function getAllBudgetStatuses(): Promise<Array<ReturnType<typeof getBudgetStatus> extends Promise<infer T> ? T : never>> {
  const services: ApiService[] = ["helius", "dexscreener", "openai", "geckoterminal"];
  return Promise.all(services.map(getBudgetStatus));
}

export async function shouldAllowApiCall(service: ApiService, endpoint?: string): Promise<{
  allowed: boolean;
  reason?: string;
  throttleFactor?: number;
}> {
  const limits = RATE_LIMITS[service];
  const tracker = getMinuteTracker(service, endpoint);
  
  if (Date.now() < tracker.backoffUntil) {
    const secsLeft = Math.ceil((tracker.backoffUntil - Date.now()) / 1000);
    if (shouldLogStateChange(service, "backoff")) {
      console.log(`[ApiBudget] ${service} backing off (${secsLeft}s remaining)`);
    }
    return { allowed: false, reason: `${service} backing off after 429 (${secsLeft}s)`, throttleFactor: 0 };
  }
  
  if (tracker.calls >= limits.perMinute) {
    if (shouldLogStateChange(service, "rate_limited")) {
      console.log(`[ApiBudget] ${service} at per-minute limit (${tracker.calls}/${limits.perMinute}), waiting for reset`);
    }
    return { allowed: false, reason: `${service} per-minute rate limit reached`, throttleFactor: 0 };
  }
  
  if (limits.dailyCap > 0 || limits.monthlyCap > 0) {
    const config = await getBudgetConfig(service);
    
    if (config.isPaused) {
      if (shouldLogStateChange(service, "paused")) {
        console.log(`[ApiBudget] ${service} is manually paused`);
      }
      return { allowed: false, reason: `${service} API is manually paused` };
    }
    
    if (limits.dailyCap > 0) {
      const daily = await getDailyUsage(service);
      const dailyPercent = (daily / limits.dailyCap) * 100;
      if (dailyPercent >= 100) {
        if (shouldLogStateChange(service, "daily_exhausted")) {
          console.log(`[ApiBudget] ${service} daily cap reached (${daily}/${limits.dailyCap})`);
        }
        return { allowed: false, reason: `${service} daily cap reached`, throttleFactor: 0 };
      }
      if (dailyPercent >= 90) {
        const factor = Math.max(0.1, (limits.dailyCap - daily) / limits.dailyCap);
        if (shouldLogStateChange(service, "daily_throttled")) {
          console.log(`[ApiBudget] ${service} daily usage at ${dailyPercent.toFixed(0)}%, throttling to ${(factor * 100).toFixed(0)}%`);
        }
        return { allowed: true, throttleFactor: factor };
      }
    }
    
    if (limits.monthlyCap > 0) {
      const monthly = await getMonthlyUsage(service);
      const monthlyPercent = (monthly / limits.monthlyCap) * 100;
      if (monthlyPercent >= 100) {
        if (shouldLogStateChange(service, "monthly_exhausted")) {
          console.log(`[ApiBudget] ${service} monthly cap reached (${monthly}/${limits.monthlyCap})`);
        }
        return { allowed: false, reason: `${service} monthly cap reached`, throttleFactor: 0 };
      }
      if (monthlyPercent >= 90) {
        const factor = Math.max(0.1, (limits.monthlyCap - monthly) / limits.monthlyCap);
        if (shouldLogStateChange(service, "monthly_throttled")) {
          console.log(`[ApiBudget] ${service} monthly usage at ${monthlyPercent.toFixed(0)}%, throttling to ${(factor * 100).toFixed(0)}%`);
        }
        return { allowed: true, throttleFactor: factor };
      }
    }
  }
  
  const minutePercent = limits.perMinute > 0 ? (tracker.calls / limits.perMinute) * 100 : 0;
  let throttleFactor = 1.0;
  if (minutePercent >= 70) {
    throttleFactor = Math.max(0.2, (limits.perMinute - tracker.calls) / limits.perMinute);
  }
  
  return { allowed: true, throttleFactor };
}

export async function getUsageHistory(
  service: ApiService,
  days: number = 7
): Promise<Array<{ date: string; count: number }>> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const cutoffDate = new Date(cutoff * 1000).toISOString().split("T")[0];
  
  const result = await db.select({
    date: apiUsage.date,
    count: sql<number>`SUM(${apiUsage.callCount})`,
  })
    .from(apiUsage)
    .where(and(
      eq(apiUsage.service, service),
      gte(apiUsage.date, cutoffDate)
    ))
    .groupBy(apiUsage.date)
    .orderBy(apiUsage.date);
  
  return result.map(r => ({ date: r.date, count: Number(r.count) }));
}

export function getPerMinuteStats(): Record<string, { calls: number; limit: number; percent: number; backingOff: boolean }> {
  const stats: Record<string, { calls: number; limit: number; percent: number; backingOff: boolean }> = {};
  for (const service of Object.keys(RATE_LIMITS) as ApiService[]) {
    const tracker = getMinuteTracker(service);
    const limits = RATE_LIMITS[service];
    stats[service] = {
      calls: tracker.calls,
      limit: limits.perMinute,
      percent: limits.perMinute > 0 ? Math.round((tracker.calls / limits.perMinute) * 100) : 0,
      backingOff: Date.now() < tracker.backoffUntil,
    };
  }
  return stats;
}
