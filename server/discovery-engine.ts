import { db } from "./db";
import { 
  discoveryTriggers, discoveryEvents, discoveryMetrics, 
  marketRegimes, discoveryJobRuns,
  tokenDataPool, swaps, holderCache,
  DiscoveryTrigger, DiscoveryEvent
} from "@shared/schema";
import { eq, and, desc, gte, lte, sql, gt, lt, isNull } from "drizzle-orm";
import { fetchTokenWithFallback } from "./data-pool";

const OUTCOME_WINDOW_HOURS = 24;
const PROFIT_THRESHOLD_PERCENT = 5;

interface MetricResult {
  value: number;
  tokenMint: string;
  tokenSymbol?: string;
  context?: Record<string, unknown>;
}

export async function evaluateMetric(
  metric: string,
  tokenMint: string,
  timeWindowMinutes: number = 60
): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (timeWindowMinutes * 60);
  
  switch (metric) {
    case "price_surge": {
      const tokenData = await fetchTokenWithFallback(tokenMint);
      return tokenData.priceChange24h || 0;
    }
    
    case "volume_spike": {
      const [recent] = await db.select().from(tokenDataPool)
        .where(eq(tokenDataPool.tokenMint, tokenMint))
        .limit(1);
      
      if (!recent) return null;
      
      const avgVolume = recent.volume24h || 0;
      if (avgVolume === 0) return 0;
      
      const recentSwapData = await db.select({
        total: sql<number>`sum(from_amount)`,
      })
        .from(swaps)
        .where(and(
          eq(swaps.toToken, tokenMint),
          gte(swaps.timestamp, now - 3600)
        ));
      
      const recentVolume = (recentSwapData[0]?.total || 0) * 24;
      return recentVolume / (avgVolume + 1);
    }
    
    case "whale_buy": {
      const recentBuys = await db.select().from(swaps)
        .where(and(
          eq(swaps.toToken, tokenMint),
          eq(swaps.type, "buy"),
          gte(swaps.timestamp, windowStart)
        ))
        .orderBy(desc(swaps.fromAmount))
        .limit(10);
      
      if (recentBuys.length === 0) return 0;
      
      const maxBuy = Math.max(...recentBuys.map(s => s.fromAmount || 0));
      return maxBuy;
    }
    
    case "heat_score": {
      const [tokenData] = await db.select().from(tokenDataPool)
        .where(eq(tokenDataPool.tokenMint, tokenMint))
        .limit(1);
      
      if (!tokenData) return 0;
      
      const recency = Math.max(0, 100 - (now - (tokenData.priceUpdatedAt || 0)) / 60);
      const volumeScore = Math.min(100, (tokenData.volume24h || 0) / 10000);
      const liquidityScore = Math.min(100, (tokenData.liquidity || 0) / 10000);
      
      return (recency * 0.3) + (volumeScore * 0.4) + (liquidityScore * 0.3);
    }
    
    case "holder_growth": {
      const [holderData] = await db.select().from(holderCache)
        .where(eq(holderCache.tokenMint, tokenMint))
        .limit(1);
      
      if (!holderData) return 0;
      
      const currentHolders = holderData.totalHolders || 0;
      const webhookUpdates = holderData.webhookUpdateCount || 0;
      
      if (currentHolders === 0) return 0;
      return (webhookUpdates / currentHolders) * 100;
    }
    
    case "liquidity_depth": {
      const [tokenData] = await db.select().from(tokenDataPool)
        .where(eq(tokenDataPool.tokenMint, tokenMint))
        .limit(1);
      
      return tokenData?.liquidity || 0;
    }
    
    default:
      return null;
  }
}

function evaluateThreshold(
  value: number,
  threshold: number,
  operator: string
): boolean {
  switch (operator) {
    case "gte": return value >= threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "lt": return value < threshold;
    case "eq": return Math.abs(value - threshold) < 0.001;
    case "change_pct": return Math.abs(value) >= threshold;
    default: return value >= threshold;
  }
}

export async function checkTriggerForToken(
  trigger: DiscoveryTrigger,
  tokenMint: string,
  tokenSymbol?: string
): Promise<DiscoveryEvent | null> {
  const now = Math.floor(Date.now() / 1000);
  
  const recentEvent = await db.select().from(discoveryEvents)
    .where(and(
      eq(discoveryEvents.triggerId, trigger.id),
      eq(discoveryEvents.tokenMint, tokenMint),
      gte(discoveryEvents.firedAt, now - (trigger.cooldownMinutes || 30) * 60)
    ))
    .limit(1);
  
  if (recentEvent.length > 0) {
    return null;
  }
  
  const metricValue = await evaluateMetric(
    trigger.metric,
    tokenMint,
    trigger.timeWindowMinutes || 60
  );
  
  if (metricValue === null) return null;
  
  const weightedThreshold = trigger.threshold * (trigger.currentWeight || 1.0);
  
  if (!evaluateThreshold(metricValue, weightedThreshold, trigger.operator)) {
    return null;
  }
  
  const tokenData = await fetchTokenWithFallback(tokenMint);
  
  const [event] = await db.insert(discoveryEvents).values({
    triggerId: trigger.id,
    tokenMint,
    tokenSymbol: tokenSymbol || tokenData.tokenSymbol,
    metricValue,
    threshold: trigger.threshold,
    priority: trigger.priority,
    priceAtDiscovery: tokenData.priceUsd,
    marketCapAtDiscovery: tokenData.marketCap,
    liquidityAtDiscovery: tokenData.liquidity,
    volumeAtDiscovery: tokenData.volume24h,
    status: trigger.shadowMode ? "shadow" : "pending",
    firedAt: now,
    expiresAt: now + (OUTCOME_WINDOW_HOURS * 3600),
  }).returning();
  
  await db.update(discoveryTriggers)
    .set({
      fireCount: (trigger.fireCount || 0) + 1,
      updatedAt: now,
    })
    .where(eq(discoveryTriggers.id, trigger.id));
  
  console.log(`[Discovery] Trigger "${trigger.name}" fired for ${tokenSymbol || tokenMint}: ${metricValue.toFixed(2)} >= ${weightedThreshold.toFixed(2)}`);
  
  return event;
}

export async function scanForDiscoveries(): Promise<DiscoveryEvent[]> {
  const now = Math.floor(Date.now() / 1000);
  const events: DiscoveryEvent[] = [];
  
  const triggers = await db.select().from(discoveryTriggers)
    .where(eq(discoveryTriggers.enabled, true))
    .orderBy(desc(discoveryTriggers.priority));
  
  const recentTokens = await db.select({
    tokenMint: swaps.toToken,
    symbol: swaps.toTokenSymbol,
  })
    .from(swaps)
    .where(gte(swaps.timestamp, now - 3600))
    .groupBy(swaps.toToken, swaps.toTokenSymbol)
    .limit(100);
  
  for (const { tokenMint, symbol } of recentTokens) {
    for (const trigger of triggers) {
      const event = await checkTriggerForToken(trigger, tokenMint, symbol || undefined);
      if (event) {
        events.push(event);
      }
    }
  }
  
  return events;
}

export async function updateEventOutcomes(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  
  const pendingEvents = await db.select().from(discoveryEvents)
    .where(and(
      eq(discoveryEvents.status, "pending"),
      lte(discoveryEvents.expiresAt, now)
    ))
    .limit(100);
  
  for (const event of pendingEvents) {
    const tokenData = await fetchTokenWithFallback(event.tokenMint);
    const currentPrice = tokenData.priceUsd || 0;
    
    if (!event.priceAtDiscovery || event.priceAtDiscovery === 0) {
      await db.update(discoveryEvents)
        .set({ status: "expired", evaluatedAt: now })
        .where(eq(discoveryEvents.id, event.id));
      continue;
    }
    
    const priceChangePercent = ((currentPrice - event.priceAtDiscovery) / event.priceAtDiscovery) * 100;
    
    let outcome: "profit" | "loss" | "neutral";
    if (priceChangePercent >= PROFIT_THRESHOLD_PERCENT) {
      outcome = "profit";
    } else if (priceChangePercent <= -PROFIT_THRESHOLD_PERCENT) {
      outcome = "loss";
    } else {
      outcome = "neutral";
    }
    
    await db.update(discoveryEvents)
      .set({
        priceAfter24h: currentPrice,
        outcome,
        outcomePercent: priceChangePercent,
        status: "tracked",
        evaluatedAt: now,
      })
      .where(eq(discoveryEvents.id, event.id));
    
    const [trigger] = await db.select().from(discoveryTriggers)
      .where(eq(discoveryTriggers.id, event.triggerId));
    
    if (trigger) {
      const isProfit = outcome === "profit";
      const newTp = (trigger.truePositives || 0) + (isProfit ? 1 : 0);
      const newFp = (trigger.falsePositives || 0) + (outcome === "loss" ? 1 : 0);
      const newPrecision = (newTp + newFp) > 0 ? newTp / (newTp + newFp) : null;
      
      await db.update(discoveryTriggers)
        .set({
          truePositives: newTp,
          falsePositives: newFp,
          precision: newPrecision,
          updatedAt: now,
        })
        .where(eq(discoveryTriggers.id, trigger.id));
    }
    
    updated++;
  }
  
  return updated;
}

export async function adjustTriggerThresholds(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let adjusted = 0;
  
  const triggers = await db.select().from(discoveryTriggers)
    .where(and(
      eq(discoveryTriggers.enabled, true),
      gt(discoveryTriggers.fireCount, 10)
    ));
  
  for (const trigger of triggers) {
    if (trigger.precision === null) continue;
    
    const targetPrecision = 0.6;
    const precisionDiff = trigger.precision - targetPrecision;
    
    const dampening = trigger.explorationPhase 
      ? (trigger.dampeningFactor || 0.1) * 2
      : (trigger.dampeningFactor || 0.1);
    
    let weightAdjustment = precisionDiff * dampening;
    weightAdjustment = Math.max(-0.2, Math.min(0.2, weightAdjustment));
    
    const newWeight = Math.max(0.5, Math.min(2.0, (trigger.currentWeight || 1.0) + weightAdjustment));
    
    const shouldEndExploration = (trigger.fireCount || 0) >= 50;
    
    if (Math.abs(newWeight - (trigger.currentWeight || 1.0)) > 0.01 || shouldEndExploration) {
      await db.update(discoveryTriggers)
        .set({
          currentWeight: newWeight,
          explorationPhase: shouldEndExploration ? false : trigger.explorationPhase,
          updatedAt: now,
        })
        .where(eq(discoveryTriggers.id, trigger.id));
      
      adjusted++;
      console.log(`[Discovery] Adjusted "${trigger.name}": precision=${trigger.precision?.toFixed(2)}, weight=${newWeight.toFixed(3)}`);
    }
  }
  
  return adjusted;
}

export async function initializeDefaultTriggers(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const [existing] = await db.select().from(discoveryTriggers).limit(1);
  if (existing) return;
  
  const defaults: Array<{
    name: string;
    description: string;
    metric: string;
    threshold: number;
    operator: string;
    priority: number;
    timeWindowMinutes: number;
    cooldownMinutes: number;
  }> = [
    {
      name: "Volume Spike 3x",
      description: "Volume 3x above 24h average",
      metric: "volume_spike",
      threshold: 3.0,
      operator: "gte",
      priority: 80,
      timeWindowMinutes: 60,
      cooldownMinutes: 30,
    },
    {
      name: "Price Surge 20%",
      description: "24h price increase of 20%+",
      metric: "price_surge",
      threshold: 20,
      operator: "gte",
      priority: 75,
      timeWindowMinutes: 60,
      cooldownMinutes: 60,
    },
    {
      name: "Whale Buy 5+ SOL",
      description: "Single buy of 5+ SOL",
      metric: "whale_buy",
      threshold: 5.0,
      operator: "gte",
      priority: 85,
      timeWindowMinutes: 30,
      cooldownMinutes: 15,
    },
    {
      name: "High Heat Score",
      description: "Heat score above 80",
      metric: "heat_score",
      threshold: 80,
      operator: "gte",
      priority: 70,
      timeWindowMinutes: 60,
      cooldownMinutes: 60,
    },
    {
      name: "Holder Growth 10%",
      description: "Holder count increased 10%+ in window",
      metric: "holder_growth",
      threshold: 10,
      operator: "gte",
      priority: 65,
      timeWindowMinutes: 120,
      cooldownMinutes: 120,
    },
    {
      name: "Liquidity Above 100k",
      description: "Liquidity depth above $100k",
      metric: "liquidity_depth",
      threshold: 100000,
      operator: "gte",
      priority: 50,
      timeWindowMinutes: 60,
      cooldownMinutes: 240,
    },
  ];
  
  for (const trigger of defaults) {
    await db.insert(discoveryTriggers).values({
      ...trigger,
      createdAt: now,
    });
  }
  
  console.log(`[Discovery] Initialized ${defaults.length} default triggers`);
}

export async function runHourlyMonitor(): Promise<{
  eventsFired: number;
  outcomesUpdated: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  
  const [run] = await db.insert(discoveryJobRuns).values({
    jobType: "hourly_monitor",
    startedAt: now,
    status: "running",
  }).returning();
  
  try {
    const events = await scanForDiscoveries();
    const outcomesUpdated = await updateEventOutcomes();
    
    await db.update(discoveryJobRuns)
      .set({
        completedAt: Math.floor(Date.now() / 1000),
        eventsFired: events.length,
        outcomesUpdated,
        status: "completed",
        summary: JSON.stringify({
          triggersActive: (await db.select().from(discoveryTriggers).where(eq(discoveryTriggers.enabled, true))).length,
          topEvents: events.slice(0, 5).map(e => ({ token: e.tokenSymbol, priority: e.priority })),
        }),
      })
      .where(eq(discoveryJobRuns.id, run.id));
    
    return { eventsFired: events.length, outcomesUpdated };
  } catch (error) {
    await db.update(discoveryJobRuns)
      .set({
        completedAt: Math.floor(Date.now() / 1000),
        status: "failed",
        error: String(error),
      })
      .where(eq(discoveryJobRuns.id, run.id));
    
    throw error;
  }
}

export async function runDailyTuning(): Promise<{
  thresholdsAdjusted: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  
  const [run] = await db.insert(discoveryJobRuns).values({
    jobType: "daily_tune",
    startedAt: now,
    status: "running",
  }).returning();
  
  try {
    const thresholdsAdjusted = await adjustTriggerThresholds();
    
    await db.update(discoveryJobRuns)
      .set({
        completedAt: Math.floor(Date.now() / 1000),
        thresholdsAdjusted,
        status: "completed",
      })
      .where(eq(discoveryJobRuns.id, run.id));
    
    return { thresholdsAdjusted };
  } catch (error) {
    await db.update(discoveryJobRuns)
      .set({
        completedAt: Math.floor(Date.now() / 1000),
        status: "failed",
        error: String(error),
      })
      .where(eq(discoveryJobRuns.id, run.id));
    
    throw error;
  }
}

export async function getDiscoveryStats(): Promise<{
  activeTriggers: number;
  totalEvents: number;
  pendingEvents: number;
  avgPrecision: number | null;
  topPerformers: Array<{ name: string; precision: number; fireCount: number }>;
}> {
  const triggers = await db.select().from(discoveryTriggers)
    .where(eq(discoveryTriggers.enabled, true));
  
  const [eventCounts] = await db.select({
    total: sql<number>`count(*)`,
    pending: sql<number>`sum(case when status = 'pending' then 1 else 0 end)`,
  }).from(discoveryEvents);
  
  const precisions = triggers
    .filter(t => t.precision !== null)
    .map(t => t.precision!);
  
  const avgPrecision = precisions.length > 0
    ? precisions.reduce((a, b) => a + b, 0) / precisions.length
    : null;
  
  const topPerformers = triggers
    .filter(t => t.precision !== null && (t.fireCount || 0) >= 10)
    .sort((a, b) => (b.precision || 0) - (a.precision || 0))
    .slice(0, 5)
    .map(t => ({
      name: t.name,
      precision: t.precision!,
      fireCount: t.fireCount || 0,
    }));
  
  return {
    activeTriggers: triggers.length,
    totalEvents: Number(eventCounts?.total) || 0,
    pendingEvents: Number(eventCounts?.pending) || 0,
    avgPrecision,
    topPerformers,
  };
}

export async function getRecentEvents(
  limit: number = 20,
  status?: string
): Promise<DiscoveryEvent[]> {
  let query = db.select().from(discoveryEvents);
  
  if (status) {
    query = query.where(eq(discoveryEvents.status, status)) as typeof query;
  }
  
  return query.orderBy(desc(discoveryEvents.firedAt)).limit(limit);
}

// =====================
// REGIME DETECTION
// =====================

interface RegimeData {
  name: string;
  confidence: number;
  solPriceChange: number;
  volumeRatio: number;
  volatility: number;
}

export async function detectMarketRegime(): Promise<RegimeData> {
  const now = Math.floor(Date.now() / 1000);
  
  const recentSwaps = await db.select({
    totalVolume: sql<number>`sum(from_amount)`,
    swapCount: sql<number>`count(*)`,
  })
    .from(swaps)
    .where(gte(swaps.timestamp, now - 3600));
  
  const olderSwaps = await db.select({
    totalVolume: sql<number>`sum(from_amount)`,
    swapCount: sql<number>`count(*)`,
  })
    .from(swaps)
    .where(and(
      gte(swaps.timestamp, now - 86400),
      lte(swaps.timestamp, now - 3600)
    ));
  
  const recentVolume = recentSwaps[0]?.totalVolume || 0;
  const olderVolumePerHour = (olderSwaps[0]?.totalVolume || 0) / 23;
  
  const volumeRatio = olderVolumePerHour > 0 ? recentVolume / olderVolumePerHour : 1;
  
  const solPriceChange = 0;
  const volatility = Math.abs(volumeRatio - 1);
  
  let name: string;
  let confidence: number;
  
  if (volumeRatio > 2) {
    name = "volatile";
    confidence = Math.min(0.9, 0.5 + (volumeRatio - 2) * 0.2);
  } else if (volumeRatio > 1.3) {
    name = "bull";
    confidence = Math.min(0.8, 0.4 + (volumeRatio - 1.3) * 0.3);
  } else if (volumeRatio < 0.5) {
    name = "quiet";
    confidence = Math.min(0.8, 0.4 + (0.5 - volumeRatio) * 0.4);
  } else if (volumeRatio < 0.7) {
    name = "bear";
    confidence = Math.min(0.7, 0.3 + (0.7 - volumeRatio) * 0.4);
  } else {
    name = "crab";
    confidence = 0.5;
  }
  
  await db.update(marketRegimes)
    .set({
      detectedAt: now,
      confidence,
      updatedAt: now,
    })
    .where(eq(marketRegimes.name, name));
  
  console.log(`[Discovery] Detected regime: ${name} (confidence: ${(confidence * 100).toFixed(0)}%)`);
  
  return {
    name,
    confidence,
    solPriceChange,
    volumeRatio,
    volatility,
  };
}

export async function getRegimeAdjustedThreshold(
  baseThreshold: number,
  regime: string
): Promise<number> {
  const [regimeData] = await db.select().from(marketRegimes)
    .where(eq(marketRegimes.name, regime));
  
  const multiplier = regimeData?.thresholdMultiplier || 1.0;
  return baseThreshold * multiplier;
}

export async function initializeDefaultRegimes(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const [existing] = await db.select().from(marketRegimes).limit(1);
  if (existing) return;
  
  const defaults = [
    { name: "bull", thresholdMultiplier: 0.9, cooldownMultiplier: 0.8 },
    { name: "bear", thresholdMultiplier: 1.3, cooldownMultiplier: 1.5 },
    { name: "crab", thresholdMultiplier: 1.0, cooldownMultiplier: 1.0 },
    { name: "volatile", thresholdMultiplier: 1.2, cooldownMultiplier: 0.7 },
    { name: "quiet", thresholdMultiplier: 0.8, cooldownMultiplier: 2.0 },
  ];
  
  for (const regime of defaults) {
    await db.insert(marketRegimes).values({
      ...regime,
      createdAt: now,
    });
  }
  
  console.log(`[Discovery] Initialized ${defaults.length} market regimes`);
}

// =====================
// AI SELF-EVOLVING TRIGGERS
// =====================

interface TriggerProposal {
  name: string;
  description: string;
  metric: string;
  threshold: number;
  operator: string;
  priority: number;
  reason: string;
}

export async function proposeNewTrigger(
  parentTriggerId: number,
  variant: "threshold_up" | "threshold_down" | "new_metric"
): Promise<DiscoveryTrigger | null> {
  const now = Math.floor(Date.now() / 1000);
  
  const [parent] = await db.select().from(discoveryTriggers)
    .where(eq(discoveryTriggers.id, parentTriggerId));
  
  if (!parent) return null;
  
  let newThreshold = parent.threshold;
  let newName = parent.name;
  let description = "";
  
  switch (variant) {
    case "threshold_up":
      newThreshold = parent.threshold * 1.2;
      newName = `${parent.name} (higher)`;
      description = `Testing higher threshold ${newThreshold.toFixed(2)} vs ${parent.threshold}`;
      break;
    case "threshold_down":
      newThreshold = parent.threshold * 0.8;
      newName = `${parent.name} (lower)`;
      description = `Testing lower threshold ${newThreshold.toFixed(2)} vs ${parent.threshold}`;
      break;
    case "new_metric":
      return null;
  }
  
  const [newTrigger] = await db.insert(discoveryTriggers).values({
    name: newName,
    description,
    metric: parent.metric,
    threshold: newThreshold,
    timeWindowMinutes: parent.timeWindowMinutes,
    operator: parent.operator,
    priority: parent.priority - 5,
    cooldownMinutes: parent.cooldownMinutes,
    isAiProposed: true,
    shadowMode: true,
    parentTriggerId,
    explorationPhase: true,
    dampeningFactor: 0.15,
    createdAt: now,
  }).returning();
  
  console.log(`[Discovery] Proposed new trigger variant: ${newName} (shadow mode)`);
  
  return newTrigger;
}

export async function promoteShadowTrigger(triggerId: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  
  const [trigger] = await db.select().from(discoveryTriggers)
    .where(eq(discoveryTriggers.id, triggerId));
  
  if (!trigger || !trigger.shadowMode) return false;
  
  if ((trigger.fireCount || 0) < 20) {
    console.log(`[Discovery] Cannot promote ${trigger.name}: insufficient data (${trigger.fireCount} fires)`);
    return false;
  }
  
  if (!trigger.precision || trigger.precision < 0.5) {
    console.log(`[Discovery] Cannot promote ${trigger.name}: low precision (${trigger.precision})`);
    return false;
  }
  
  if (trigger.parentTriggerId) {
    const [parent] = await db.select().from(discoveryTriggers)
      .where(eq(discoveryTriggers.id, trigger.parentTriggerId));
    
    if (parent?.precision && trigger.precision <= parent.precision * 1.1) {
      console.log(`[Discovery] Cannot promote ${trigger.name}: not significantly better than parent`);
      return false;
    }
  }
  
  await db.update(discoveryTriggers)
    .set({
      shadowMode: false,
      promotedAt: now,
      explorationPhase: false,
      updatedAt: now,
    })
    .where(eq(discoveryTriggers.id, triggerId));
  
  console.log(`[Discovery] Promoted ${trigger.name} from shadow to active`);
  
  return true;
}

export async function evaluateShadowTriggers(): Promise<{
  promoted: number;
  retired: number;
}> {
  const shadowTriggers = await db.select().from(discoveryTriggers)
    .where(eq(discoveryTriggers.shadowMode, true));
  
  let promoted = 0;
  let retired = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const trigger of shadowTriggers) {
    const ageHours = (now - trigger.createdAt) / 3600;
    
    if ((trigger.fireCount || 0) >= 20 && trigger.precision !== null) {
      if (trigger.precision >= 0.5) {
        if (await promoteShadowTrigger(trigger.id)) {
          promoted++;
        }
      } else if (trigger.precision < 0.3 || ageHours > 168) {
        await db.update(discoveryTriggers)
          .set({ enabled: false, updatedAt: now })
          .where(eq(discoveryTriggers.id, trigger.id));
        retired++;
        console.log(`[Discovery] Retired underperforming trigger: ${trigger.name}`);
      }
    } else if (ageHours > 336 && (trigger.fireCount || 0) < 5) {
      await db.update(discoveryTriggers)
        .set({ enabled: false, updatedAt: now })
        .where(eq(discoveryTriggers.id, trigger.id));
      retired++;
      console.log(`[Discovery] Retired inactive trigger: ${trigger.name}`);
    }
  }
  
  return { promoted, retired };
}

export async function suggestTriggerVariants(): Promise<TriggerProposal[]> {
  const proposals: TriggerProposal[] = [];
  
  const topPerformers = await db.select().from(discoveryTriggers)
    .where(and(
      eq(discoveryTriggers.enabled, true),
      eq(discoveryTriggers.shadowMode, false),
      gt(discoveryTriggers.precision, 0.6),
      gt(discoveryTriggers.fireCount, 30)
    ))
    .orderBy(desc(discoveryTriggers.precision))
    .limit(3);
  
  for (const trigger of topPerformers) {
    const existingVariants = await db.select().from(discoveryTriggers)
      .where(and(
        eq(discoveryTriggers.parentTriggerId, trigger.id),
        eq(discoveryTriggers.enabled, true)
      ));
    
    if (existingVariants.length >= 2) continue;
    
    proposals.push({
      name: `${trigger.name} (stricter)`,
      description: `Increase threshold by 20% to reduce false positives`,
      metric: trigger.metric,
      threshold: trigger.threshold * 1.2,
      operator: trigger.operator,
      priority: trigger.priority - 5,
      reason: `Parent trigger has ${(trigger.precision! * 100).toFixed(0)}% precision with ${trigger.fireCount} fires`,
    });
    
    if (trigger.precision! < 0.8) {
      proposals.push({
        name: `${trigger.name} (relaxed)`,
        description: `Decrease threshold by 20% to catch more opportunities`,
        metric: trigger.metric,
        threshold: trigger.threshold * 0.8,
        operator: trigger.operator,
        priority: trigger.priority - 5,
        reason: `Testing if lower threshold can maintain acceptable precision`,
      });
    }
  }
  
  return proposals;
}
