import { db } from "./db";
import { eq, and, desc, asc, sql, lt, gt, isNull } from "drizzle-orm";
import {
  userApiKeys,
  userBudgetUsage,
  apiQueue,
  surplusPool,
  UserApiKey,
  UserBudgetUsage,
  ApiQueueItem,
  SurplusPoolEntry,
} from "@shared/schema";

const HELIUS_FREE_TIER_CREDITS = 1_000_000;
const MAX_SIGNAL_WALLETS_PER_KEY = 100;

export const REQUEST_PRIORITY: Record<string, number> = {
  COPY_TRADE: 100,
  UI_ACTIVE: 75,
  UI_REQUEST: 50,
  BACKGROUND: 25,
  DISCOVERY: 10,
};

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getDaysInMonth(month: string): number {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(year, monthNum, 0).getDate();
}

function getCurrentDayOfMonth(): number {
  return new Date().getDate();
}

export async function getOrCreateUserBudget(userId: number, apiKeyId?: number): Promise<UserBudgetUsage> {
  const month = getCurrentMonth();
  
  const existing = await db.query.userBudgetUsage.findFirst({
    where: and(
      eq(userBudgetUsage.userId, userId),
      eq(userBudgetUsage.month, month),
      apiKeyId ? eq(userBudgetUsage.apiKeyId, apiKeyId) : isNull(userBudgetUsage.apiKeyId)
    ),
  });

  if (existing) {
    return existing;
  }

  let monthlyBudget = HELIUS_FREE_TIER_CREDITS;
  
  if (apiKeyId) {
    const apiKey = await db.query.userApiKeys.findFirst({
      where: eq(userApiKeys.id, apiKeyId),
    });
    if (apiKey?.monthlyBudget) {
      monthlyBudget = apiKey.monthlyBudget;
    }
  }

  const daysInMonth = getDaysInMonth(month);
  const currentDay = getCurrentDayOfMonth();
  const now = Math.floor(Date.now() / 1000);

  const [newBudget] = await db.insert(userBudgetUsage).values({
    userId,
    apiKeyId: apiKeyId ?? null,
    month,
    monthlyBudget,
    creditsUsed: 0,
    creditsRemaining: monthlyBudget,
    daysInMonth,
    currentDay,
    targetDailyRate: Math.floor(monthlyBudget / daysInMonth),
    actualDailyRate: 0,
    isThrottled: false,
    throttleFactor: 1.0,
    surplusCredits: 0,
    lastCalculatedAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return newBudget;
}

export async function recordCreditsUsed(userId: number, credits: number, apiKeyId?: number): Promise<void> {
  const budget = await getOrCreateUserBudget(userId, apiKeyId);
  const now = Math.floor(Date.now() / 1000);

  await db.update(userBudgetUsage)
    .set({
      creditsUsed: budget.creditsUsed + credits,
      creditsRemaining: budget.creditsRemaining - credits,
      updatedAt: now,
    })
    .where(eq(userBudgetUsage.id, budget.id));
}

export async function calculateBudgetStatus(userId: number, apiKeyId?: number): Promise<{
  isThrottled: boolean;
  throttleFactor: number;
  surplusCredits: number;
  remainingCredits: number;
  targetDailyRate: number;
  actualDailyRate: number;
  daysRemaining: number;
}> {
  const budget = await getOrCreateUserBudget(userId, apiKeyId);
  const month = getCurrentMonth();
  const daysInMonth = getDaysInMonth(month);
  const currentDay = getCurrentDayOfMonth();
  const daysRemaining = Math.max(1, daysInMonth - currentDay + 1);

  const targetDailyRate = Math.floor(budget.creditsRemaining / daysRemaining);
  const daysSoFar = Math.max(1, currentDay);
  const actualDailyRate = Math.floor(budget.creditsUsed / daysSoFar);

  const expectedUsage = Math.floor((budget.monthlyBudget / daysInMonth) * currentDay);
  const surplusCredits = Math.max(0, expectedUsage - budget.creditsUsed);

  let isThrottled = false;
  let throttleFactor = 1.0;

  if (actualDailyRate > targetDailyRate && targetDailyRate > 0) {
    isThrottled = true;
    throttleFactor = Math.max(0.1, targetDailyRate / actualDailyRate);
  }

  const now = Math.floor(Date.now() / 1000);
  await db.update(userBudgetUsage)
    .set({
      currentDay,
      targetDailyRate,
      actualDailyRate,
      isThrottled,
      throttleFactor,
      surplusCredits,
      lastCalculatedAt: now,
      updatedAt: now,
    })
    .where(eq(userBudgetUsage.id, budget.id));

  return {
    isThrottled,
    throttleFactor,
    surplusCredits,
    remainingCredits: budget.creditsRemaining,
    targetDailyRate,
    actualDailyRate,
    daysRemaining,
  };
}

export async function getThrottleDelayMs(userId: number): Promise<number> {
  const status = await calculateBudgetStatus(userId);
  
  if (!status.isThrottled) {
    return 0;
  }

  const baseDelay = 1000;
  const delayMs = Math.floor(baseDelay / status.throttleFactor) - baseDelay;
  return Math.max(0, Math.min(delayMs, 10000));
}

export async function queueApiRequest(
  userId: number | null,
  requestType: string,
  service: string,
  endpoint: string,
  payload?: Record<string, any>,
  isUiActive: boolean = false
): Promise<ApiQueueItem> {
  let priority = REQUEST_PRIORITY.BACKGROUND;
  
  switch (requestType) {
    case 'copy_trade':
      priority = REQUEST_PRIORITY.COPY_TRADE;
      break;
    case 'ui_request':
      priority = isUiActive ? REQUEST_PRIORITY.UI_ACTIVE : REQUEST_PRIORITY.UI_REQUEST;
      break;
    case 'background':
      priority = REQUEST_PRIORITY.BACKGROUND;
      break;
    case 'discovery':
      priority = REQUEST_PRIORITY.DISCOVERY;
      break;
  }

  const now = Math.floor(Date.now() / 1000);

  const [queueItem] = await db.insert(apiQueue).values({
    userId,
    requestType,
    service,
    endpoint,
    payload,
    priority,
    isUiActive,
    status: 'pending',
    createdAt: now,
  }).returning();

  return queueItem;
}

export async function promoteToUiActive(userId: number, tokenMint?: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await db.update(apiQueue)
    .set({
      priority: REQUEST_PRIORITY.UI_ACTIVE,
      isUiActive: true,
    })
    .where(and(
      eq(apiQueue.userId, userId),
      eq(apiQueue.status, 'pending')
    ));
}

export async function getNextQueueItem(userId?: number, bypassThrottle: boolean = false): Promise<ApiQueueItem | null> {
  const now = Math.floor(Date.now() / 1000);

  const conditions: any[] = [
    eq(apiQueue.status, 'pending'),
  ];

  if (userId !== undefined) {
    conditions.push(eq(apiQueue.userId, userId));
  }

  const items = await db.query.apiQueue.findMany({
    where: and(...conditions),
    orderBy: [desc(apiQueue.priority), asc(apiQueue.createdAt)],
    limit: 10,
  });

  if (items.length === 0) return null;

  for (const item of items) {
    const isCopyTrade = item.requestType === 'copy_trade';
    
    if (item.scheduledFor && item.scheduledFor > now && !isCopyTrade) {
      continue;
    }

    if (!isCopyTrade && !bypassThrottle && item.userId) {
      const delay = await getThrottleDelayMs(item.userId);
      if (delay > 0) {
        const newScheduledFor = now + Math.floor(delay / 1000);
        await db.update(apiQueue)
          .set({ scheduledFor: newScheduledFor })
          .where(eq(apiQueue.id, item.id));
        continue;
      }
    }

    await db.update(apiQueue)
      .set({
        status: 'processing',
        startedAt: now,
      })
      .where(eq(apiQueue.id, item.id));

    return item;
  }

  return null;
}

export async function completeQueueItem(
  itemId: number,
  result?: Record<string, any>,
  creditsUsed?: number,
  error?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await db.update(apiQueue)
    .set({
      status: error ? 'failed' : 'completed',
      result,
      errorMessage: error,
      creditsUsed,
      completedAt: now,
    })
    .where(eq(apiQueue.id, itemId));

  const item = await db.query.apiQueue.findFirst({
    where: eq(apiQueue.id, itemId),
  });

  if (item && item.userId && creditsUsed) {
    await recordCreditsUsed(item.userId, creditsUsed);
  }
}

export async function getOrCreateSurplusPool(): Promise<SurplusPoolEntry> {
  const month = getCurrentMonth();
  
  const existing = await db.query.surplusPool.findFirst({
    where: eq(surplusPool.month, month),
  });

  if (existing) {
    return existing;
  }

  const now = Math.floor(Date.now() / 1000);

  const [newPool] = await db.insert(surplusPool).values({
    month,
    totalSurplus: 0,
    throttledUserAllocation: 0,
    discoveryAllocation: 0,
    throttledUsed: 0,
    discoveryUsed: 0,
    contributorCount: 0,
    borrowerCount: 0,
    lastCalculatedAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return newPool;
}

export async function recalculateSurplusPool(): Promise<SurplusPoolEntry> {
  const month = getCurrentMonth();
  const pool = await getOrCreateSurplusPool();
  const now = Math.floor(Date.now() / 1000);

  const budgets = await db.query.userBudgetUsage.findMany({
    where: eq(userBudgetUsage.month, month),
  });

  const contributingKeys = await db.query.userApiKeys.findMany({
    where: and(
      eq(userApiKeys.isValid, true),
      eq(userApiKeys.contributesToPool, true)
    ),
  });
  const contributingKeyIds = new Set(contributingKeys.map(k => k.id));

  let totalSurplus = 0;
  let contributorCount = 0;
  let borrowerCount = 0;

  for (const budget of budgets) {
    if (budget.apiKeyId && !contributingKeyIds.has(budget.apiKeyId)) {
      continue;
    }

    if ((budget.surplusCredits ?? 0) > 0) {
      totalSurplus += budget.surplusCredits ?? 0;
      contributorCount++;
    } else if (budget.isThrottled) {
      borrowerCount++;
    }
  }

  const throttledUserAllocation = Math.floor(totalSurplus * 0.5);
  const discoveryAllocation = Math.floor(totalSurplus * 0.5);

  await db.update(surplusPool)
    .set({
      totalSurplus,
      throttledUserAllocation,
      discoveryAllocation,
      contributorCount,
      borrowerCount,
      lastCalculatedAt: now,
      updatedAt: now,
    })
    .where(eq(surplusPool.id, pool.id));

  return {
    ...pool,
    totalSurplus,
    throttledUserAllocation,
    discoveryAllocation,
    contributorCount,
    borrowerCount,
  };
}

export async function borrowFromPool(
  userId: number,
  credits: number,
  forDiscovery: boolean = false
): Promise<{ borrowed: number; remaining: number }> {
  return borrowFromPoolInternal(credits, forDiscovery);
}

export async function borrowDiscoverySurplus(
  credits: number
): Promise<{ borrowed: number; remaining: number }> {
  return borrowFromPoolInternal(credits, true);
}

async function borrowFromPoolInternal(
  credits: number,
  forDiscovery: boolean
): Promise<{ borrowed: number; remaining: number }> {
  const pool = await recalculateSurplusPool();
  
  const discoveryAllocation = pool.discoveryAllocation ?? 0;
  const discoveryUsed = pool.discoveryUsed ?? 0;
  const throttledAllocation = pool.throttledUserAllocation ?? 0;
  const throttledUsed = pool.throttledUsed ?? 0;
  
  const available = forDiscovery
    ? discoveryAllocation - discoveryUsed
    : throttledAllocation - throttledUsed;

  const borrowed = Math.min(credits, available);
  
  if (borrowed > 0) {
    const now = Math.floor(Date.now() / 1000);
    
    await db.update(surplusPool)
      .set({
        [forDiscovery ? 'discoveryUsed' : 'throttledUsed']: 
          forDiscovery ? discoveryUsed + borrowed : throttledUsed + borrowed,
        updatedAt: now,
      })
      .where(eq(surplusPool.id, pool.id));
  }

  return {
    borrowed,
    remaining: available - borrowed,
  };
}

export async function canUseApiKey(userId: number, apiKeyId: number): Promise<boolean> {
  const apiKey = await db.query.userApiKeys.findFirst({
    where: and(
      eq(userApiKeys.id, apiKeyId),
      eq(userApiKeys.userId, userId),
      eq(userApiKeys.isValid, true)
    ),
  });

  return !!apiKey;
}

export async function getWalletCountForKey(apiKeyId: number): Promise<number> {
  const apiKey = await db.query.userApiKeys.findFirst({
    where: eq(userApiKeys.id, apiKeyId),
  });

  return apiKey?.currentWalletCount ?? 0;
}

export async function canAddWalletToKey(apiKeyId: number): Promise<boolean> {
  const apiKey = await db.query.userApiKeys.findFirst({
    where: eq(userApiKeys.id, apiKeyId),
  });

  if (!apiKey) return false;

  return (apiKey.currentWalletCount ?? 0) < (apiKey.walletLimit ?? MAX_SIGNAL_WALLETS_PER_KEY);
}

export async function incrementWalletCount(apiKeyId: number): Promise<void> {
  const apiKey = await db.query.userApiKeys.findFirst({
    where: eq(userApiKeys.id, apiKeyId),
  });

  if (!apiKey) return;

  await db.update(userApiKeys)
    .set({
      currentWalletCount: (apiKey.currentWalletCount ?? 0) + 1,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(userApiKeys.id, apiKeyId));
}

export async function decrementWalletCount(apiKeyId: number): Promise<void> {
  const apiKey = await db.query.userApiKeys.findFirst({
    where: eq(userApiKeys.id, apiKeyId),
  });

  if (!apiKey) return;

  await db.update(userApiKeys)
    .set({
      currentWalletCount: Math.max(0, (apiKey.currentWalletCount ?? 0) - 1),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(userApiKeys.id, apiKeyId));
}

export async function cleanupOldQueueItems(): Promise<number> {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

  const result = await db.delete(apiQueue)
    .where(and(
      lt(apiQueue.createdAt, oneDayAgo),
      sql`${apiQueue.status} IN ('completed', 'failed', 'cancelled')`
    ));

  return 0;
}

export async function getBudgetSummary(userId: number): Promise<{
  totalBudget: number;
  totalUsed: number;
  totalRemaining: number;
  isThrottled: boolean;
  throttleFactor: number;
  surplusCredits: number;
  daysRemaining: number;
  walletCount: number;
  walletLimit: number;
}> {
  const budget = await getOrCreateUserBudget(userId);
  const status = await calculateBudgetStatus(userId);

  const userKeys = await db.query.userApiKeys.findMany({
    where: and(
      eq(userApiKeys.userId, userId),
      eq(userApiKeys.service, 'helius'),
      eq(userApiKeys.isValid, true)
    ),
  });

  let walletCount = 0;
  let walletLimit = 0;

  for (const key of userKeys) {
    walletCount += key.currentWalletCount ?? 0;
    walletLimit += key.walletLimit ?? MAX_SIGNAL_WALLETS_PER_KEY;
  }

  return {
    totalBudget: budget.monthlyBudget,
    totalUsed: budget.creditsUsed,
    totalRemaining: budget.creditsRemaining,
    isThrottled: status.isThrottled,
    throttleFactor: status.throttleFactor,
    surplusCredits: status.surplusCredits,
    daysRemaining: status.daysRemaining,
    walletCount,
    walletLimit,
  };
}

export async function getPoolSummary(): Promise<{
  totalSurplus: number;
  throttledAllocation: number;
  discoveryAllocation: number;
  throttledUsed: number;
  discoveryUsed: number;
  contributorCount: number;
  borrowerCount: number;
}> {
  const pool = await recalculateSurplusPool();

  return {
    totalSurplus: pool.totalSurplus ?? 0,
    throttledAllocation: pool.throttledUserAllocation ?? 0,
    discoveryAllocation: pool.discoveryAllocation ?? 0,
    throttledUsed: pool.throttledUsed ?? 0,
    discoveryUsed: pool.discoveryUsed ?? 0,
    contributorCount: pool.contributorCount ?? 0,
    borrowerCount: pool.borrowerCount ?? 0,
  };
}
