import { db } from "./db";
import { apiUsage, apiBudgetConfig } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";

export type ApiService = "helius" | "dexscreener" | "openai" | "geckoterminal";

const DEFAULT_LIMITS: Record<ApiService, { monthly: number; daily: number }> = {
  helius: { monthly: 10000, daily: 500 },
  dexscreener: { monthly: 20000, daily: 1000 },
  openai: { monthly: 5000, daily: 250 },
  geckoterminal: { monthly: 43200, daily: 1440 },
};

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
  } catch (error) {
    console.error(`Error tracking API call for ${service}:`, error);
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
  const config = await db.select()
    .from(apiBudgetConfig)
    .where(eq(apiBudgetConfig.service, service))
    .limit(1);
  
  if (config.length === 0) {
    const defaults = DEFAULT_LIMITS[service];
    return {
      monthlyLimit: defaults.monthly,
      dailyLimit: defaults.daily,
      warningThreshold: 80,
      pauseThreshold: 95,
      isPaused: false,
    };
  }
  
  return {
    monthlyLimit: config[0].monthlyLimit,
    dailyLimit: config[0].dailyLimit,
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
  
  if (existing.length === 0) {
    const defaults = DEFAULT_LIMITS[service];
    await db.insert(apiBudgetConfig).values({
      service,
      monthlyLimit: updates.monthlyLimit ?? defaults.monthly,
      dailyLimit: updates.dailyLimit ?? defaults.daily,
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
}> {
  const [dailyUsage, monthlyUsage, config] = await Promise.all([
    getDailyUsage(service),
    getMonthlyUsage(service),
    getBudgetConfig(service),
  ]);
  
  const dailyPercent = config.dailyLimit > 0 ? (dailyUsage / config.dailyLimit) * 100 : 0;
  const monthlyPercent = config.monthlyLimit > 0 ? (monthlyUsage / config.monthlyLimit) * 100 : 0;
  
  const maxPercent = Math.max(dailyPercent, monthlyPercent);
  const isWarning = maxPercent >= config.warningThreshold;
  const shouldPause = maxPercent >= config.pauseThreshold;
  
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
  };
}

export async function getAllBudgetStatuses(): Promise<Array<ReturnType<typeof getBudgetStatus> extends Promise<infer T> ? T : never>> {
  const services: ApiService[] = ["helius", "dexscreener", "openai", "geckoterminal"];
  return Promise.all(services.map(getBudgetStatus));
}

export async function shouldAllowApiCall(service: ApiService): Promise<{
  allowed: boolean;
  reason?: string;
}> {
  const status = await getBudgetStatus(service);
  
  if (status.isPaused) {
    return { allowed: false, reason: `${service} API is paused due to budget limits` };
  }
  
  if (status.shouldPause) {
    await updateBudgetConfig(service, { isPaused: true });
    return { allowed: false, reason: `${service} API auto-paused: budget at ${Math.max(status.dailyPercent, status.monthlyPercent).toFixed(0)}%` };
  }
  
  return { allowed: true };
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
