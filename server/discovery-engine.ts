import { db } from "./db";
import { 
  discoveryTriggers, discoveryEvents, discoveryMetrics, 
  marketRegimes, discoveryJobRuns,
  tokenDataPool, swaps, holderCache,
  discoverySources, discoveryExperiments, discoveryConfig,
  emergentPatterns, vectorUpdates, userTokenViews,
  DiscoveryTrigger, DiscoveryEvent
} from "@shared/schema";
import { eq, and, desc, gte, lte, sql, gt, lt, isNull } from "drizzle-orm";
import { fetchTokenWithFallback } from "./data-pool";
import { logSystemEvent, createCorrelationId } from "./system-events";

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
  
  try {
    await logSystemEvent({
      eventType: 'discovery_fired',
      sourceSystem: 'discovery',
      tokenMint,
      payload: {
        triggerName: trigger.name,
        triggerType: trigger.metric,
        metricValue,
        threshold: trigger.threshold,
        priority: trigger.priority,
        shadowMode: trigger.shadowMode,
      },
      metrics: {
        metricValue,
        threshold: trigger.threshold,
        priceUsd: tokenData.priceUsd || 0,
        marketCap: tokenData.marketCap || 0,
        liquidity: tokenData.liquidity || 0,
      },
    });
    
    // Publish insight for discovery events
    const { publishInsight } = await import("./insight-bus");
    await publishInsight({
      source: 'discovery',
      type: 'pattern',
      title: `Discovery: ${trigger.name} triggered`,
      payload: {
        pattern: 'discovery_trigger',
        signal: trigger.metric,
        triggerName: trigger.name,
        metricValue,
        threshold: trigger.threshold,
        priority: trigger.priority,
      },
      confidence: Math.min(0.5 + (trigger.priority / 200), 0.9),
      tokenMint,
      expiresInHours: 12,
    });
  } catch (err) {
    console.error('[Discovery] System event logging failed:', err);
  }
  
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

// =====================
// DIVERSE TOKEN DISCOVERY (DexScreener, pump.fun, etc.)
// =====================

interface DiscoveredToken {
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  source: 'dexscreener_new' | 'dexscreener_gainers' | 'pumpfun' | 'whale_activity' | 'random_sample';
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  liquidity: number | null;
  priceChange24h: number | null;
  pairAddress: string | null;
  discoveredAt: number;
  crowdingRisk: number;
  alphaDecay: number;
}

interface DiscoveryResult {
  tokens: DiscoveredToken[];
  source: string;
  fetchedAt: number;
  apiHealthy: boolean;
}

const DISCOVERY_TOKEN_CACHE: Map<string, DiscoveredToken> = new Map();
const LAST_DISCOVERY_TIME: Map<string, number> = new Map();

const DEXSCREENER_BASE = "https://api.dexscreener.com";

export async function discoverNewTokens(limit: number = 20): Promise<DiscoveryResult> {
  const source = 'dexscreener_new';
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const response = await fetch(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return { tokens: [], source, fetchedAt: now, apiHealthy: false };
    }
    
    const data = await response.json();
    const tokens: DiscoveredToken[] = [];
    
    const solanaTokens = (data || [])
      .filter((t: any) => t.chainId === 'solana')
      .slice(0, limit);
    
    for (const token of solanaTokens) {
      const discovered: DiscoveredToken = {
        tokenMint: token.tokenAddress,
        tokenSymbol: token.symbol || 'UNKNOWN',
        tokenName: token.name || 'Unknown Token',
        source: 'dexscreener_new',
        priceUsd: null,
        marketCap: null,
        volume24h: null,
        liquidity: null,
        priceChange24h: null,
        pairAddress: null,
        discoveredAt: now,
        crowdingRisk: 0,
        alphaDecay: 0,
      };
      
      tokens.push(discovered);
      DISCOVERY_TOKEN_CACHE.set(token.tokenAddress, discovered);
    }
    
    LAST_DISCOVERY_TIME.set(source, now);
    return { tokens, source, fetchedAt: now, apiHealthy: true };
  } catch (error) {
    console.error("[Discovery] Error fetching new tokens:", error);
    return { tokens: [], source, fetchedAt: now, apiHealthy: false };
  }
}

export async function discoverTopGainers(limit: number = 20): Promise<DiscoveryResult> {
  const source = 'dexscreener_gainers';
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const response = await fetch(`${DEXSCREENER_BASE}/token-boosts/top/v1`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      return { tokens: [], source, fetchedAt: now, apiHealthy: false };
    }
    
    const data = await response.json();
    const tokens: DiscoveredToken[] = [];
    
    const solanaTokens = (data || [])
      .filter((t: any) => t.chainId === 'solana')
      .slice(0, limit);
    
    for (const token of solanaTokens) {
      const discovered: DiscoveredToken = {
        tokenMint: token.tokenAddress,
        tokenSymbol: token.symbol || 'UNKNOWN',
        tokenName: token.name || 'Unknown Token',
        source: 'dexscreener_gainers',
        priceUsd: null,
        marketCap: null,
        volume24h: null,
        liquidity: null,
        priceChange24h: null,
        pairAddress: null,
        discoveredAt: now,
        crowdingRisk: 0.3,
        alphaDecay: 0.2,
      };
      
      tokens.push(discovered);
      DISCOVERY_TOKEN_CACHE.set(token.tokenAddress, discovered);
    }
    
    LAST_DISCOVERY_TIME.set(source, now);
    return { tokens, source, fetchedAt: now, apiHealthy: true };
  } catch (error) {
    console.error("[Discovery] Error fetching top gainers:", error);
    return { tokens: [], source, fetchedAt: now, apiHealthy: false };
  }
}

export async function discoverFromWhaleActivity(limit: number = 10): Promise<DiscoveryResult> {
  const source = 'whale_activity';
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 3600;
  
  try {
    const recentBuys = await db.select().from(swaps)
      .where(and(
        eq(swaps.type, 'buy'),
        gte(swaps.timestamp, cutoff)
      ))
      .orderBy(desc(swaps.fromAmount))
      .limit(100);
    
    const tokenCounts: Map<string, { count: number; totalSol: number; symbol: string }> = new Map();
    
    for (const buy of recentBuys) {
      const current = tokenCounts.get(buy.toToken) || { count: 0, totalSol: 0, symbol: '' };
      current.count++;
      current.totalSol += buy.fromAmount;
      if (buy.toTokenSymbol) current.symbol = buy.toTokenSymbol;
      tokenCounts.set(buy.toToken, current);
    }
    
    const sortedTokens = Array.from(tokenCounts.entries())
      .sort((a, b) => b[1].totalSol - a[1].totalSol)
      .slice(0, limit);
    
    const tokens: DiscoveredToken[] = sortedTokens.map(([tokenMint, data]) => ({
      tokenMint,
      tokenSymbol: data.symbol || 'UNKNOWN',
      tokenName: 'Unknown Token',
      source: 'whale_activity' as const,
      priceUsd: null,
      marketCap: null,
      volume24h: null,
      liquidity: null,
      priceChange24h: null,
      pairAddress: null,
      discoveredAt: now,
      crowdingRisk: Math.min(data.count / 10, 1),
      alphaDecay: 0.1 * data.count,
    }));
    
    for (const token of tokens) {
      DISCOVERY_TOKEN_CACHE.set(token.tokenMint, token);
    }
    
    LAST_DISCOVERY_TIME.set(source, now);
    return { tokens, source, fetchedAt: now, apiHealthy: true };
  } catch (error) {
    console.error("[Discovery] Error fetching whale activity:", error);
    return { tokens: [], source, fetchedAt: now, apiHealthy: false };
  }
}

export async function discoverPumpfunTokens(limit: number = 10): Promise<DiscoveryResult> {
  const source = 'pumpfun';
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const pumpfunTokens = await db.select().from(tokenDataPool)
      .where(eq(tokenDataPool.isPumpfun, true))
      .orderBy(desc(tokenDataPool.updatedAt))
      .limit(limit);
    
    const tokens: DiscoveredToken[] = pumpfunTokens.map(t => ({
      tokenMint: t.tokenMint,
      tokenSymbol: t.tokenSymbol || 'UNKNOWN',
      tokenName: t.tokenName || 'Unknown Token',
      source: 'pumpfun' as const,
      priceUsd: t.priceUsd,
      marketCap: t.marketCap,
      volume24h: t.volume24h,
      liquidity: t.liquidity,
      priceChange24h: t.priceChange24h,
      pairAddress: t.pairAddress,
      discoveredAt: now,
      crowdingRisk: 0.2,
      alphaDecay: t.pumpfunGraduated ? 0.5 : 0.1,
    }));
    
    for (const token of tokens) {
      DISCOVERY_TOKEN_CACHE.set(token.tokenMint, token);
    }
    
    LAST_DISCOVERY_TIME.set(source, now);
    return { tokens, source, fetchedAt: now, apiHealthy: true };
  } catch (error) {
    console.error("[Discovery] Error fetching pump.fun tokens:", error);
    return { tokens: [], source, fetchedAt: now, apiHealthy: false };
  }
}

export async function discoverRandomSample(limit: number = 5): Promise<DiscoveryResult> {
  const source = 'random_sample';
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const recentTokens = await db.select().from(tokenDataPool)
      .where(gte(tokenDataPool.updatedAt, now - 86400))
      .limit(100);
    
    const shuffled = recentTokens.sort(() => Math.random() - 0.5).slice(0, limit);
    
    const tokens: DiscoveredToken[] = shuffled.map(t => ({
      tokenMint: t.tokenMint,
      tokenSymbol: t.tokenSymbol || 'UNKNOWN',
      tokenName: t.tokenName || 'Unknown Token',
      source: 'random_sample' as const,
      priceUsd: t.priceUsd,
      marketCap: t.marketCap,
      volume24h: t.volume24h,
      liquidity: t.liquidity,
      priceChange24h: t.priceChange24h,
      pairAddress: t.pairAddress,
      discoveredAt: now,
      crowdingRisk: 0,
      alphaDecay: 0,
    }));
    
    for (const token of tokens) {
      DISCOVERY_TOKEN_CACHE.set(token.tokenMint, token);
    }
    
    LAST_DISCOVERY_TIME.set(source, now);
    return { tokens, source, fetchedAt: now, apiHealthy: true };
  } catch (error) {
    console.error("[Discovery] Error fetching random sample:", error);
    return { tokens: [], source, fetchedAt: now, apiHealthy: false };
  }
}

export async function runDiverseDiscovery(): Promise<{
  newTokens: DiscoveryResult;
  gainers: DiscoveryResult;
  whaleActivity: DiscoveryResult;
  pumpfun: DiscoveryResult;
  random: DiscoveryResult;
  total: number;
}> {
  const [newTokens, gainers, whaleActivity, pumpfun, random] = await Promise.all([
    discoverNewTokens(10),
    discoverTopGainers(10),
    discoverFromWhaleActivity(5),
    discoverPumpfunTokens(5),
    discoverRandomSample(3),
  ]);
  
  const total = 
    newTokens.tokens.length + 
    gainers.tokens.length + 
    whaleActivity.tokens.length + 
    pumpfun.tokens.length + 
    random.tokens.length;
  
  return { newTokens, gainers, whaleActivity, pumpfun, random, total };
}

export function calculateCrowdingRisk(
  walletCount: number,
  timeWindowMinutes: number = 15
): number {
  if (walletCount <= 2) return 0;
  if (walletCount <= 5) return 0.2;
  if (walletCount <= 10) return 0.4;
  if (walletCount <= 20) return 0.6;
  if (walletCount <= 50) return 0.8;
  return 1.0;
}

export function calculateAlphaDecay(
  discoveryAge: number,
  uniqueHolders: number
): number {
  const ageHours = discoveryAge / 3600;
  const ageDecay = Math.min(ageHours / 24, 1);
  const holderDecay = Math.min(uniqueHolders / 100, 1);
  return Math.min((ageDecay * 0.6) + (holderDecay * 0.4), 1);
}

export async function trackPumpfunGraduation(tokenMint: string): Promise<{
  graduated: boolean;
  graduationTime: number | null;
  ageAtGraduation: number | null;
  bondingCurveProgress: number;
} | null> {
  try {
    const [token] = await db.select().from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, tokenMint))
      .limit(1);
    
    if (!token || !token.isPumpfun) return null;
    
    return {
      graduated: token.pumpfunGraduated || false,
      graduationTime: token.pumpfunGraduationTime,
      ageAtGraduation: token.pumpfunAgeAtGraduation,
      bondingCurveProgress: token.pumpfunBondingCurveProgress || 0,
    };
  } catch (error) {
    console.error("[Discovery] Error tracking graduation:", error);
    return null;
  }
}

export function getDiscoveryTokenCache(): DiscoveredToken[] {
  return Array.from(DISCOVERY_TOKEN_CACHE.values());
}

export function getDiscoveryTokenCacheSize(): number {
  return DISCOVERY_TOKEN_CACHE.size;
}

export function clearDiscoveryTokenCache(): void {
  DISCOVERY_TOKEN_CACHE.clear();
}

export function getLastDiscoveryTimes(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Array.from(LAST_DISCOVERY_TIME.entries())) {
    result[key] = value;
  }
  return result;
}

export async function getDiverseDiscoveryStats(): Promise<{
  cacheSize: number;
  lastDiscovery: Record<string, number>;
  sourceBreakdown: Record<string, number>;
}> {
  const cached = getDiscoveryTokenCache();
  const sourceBreakdown: Record<string, number> = {};
  
  for (const token of cached) {
    sourceBreakdown[token.source] = (sourceBreakdown[token.source] || 0) + 1;
  }
  
  return {
    cacheSize: cached.length,
    lastDiscovery: getLastDiscoveryTimes(),
    sourceBreakdown,
  };
}

// =====================
// EXPLORE/EXPLOIT SOURCE-BASED DISCOVERY
// Self-optimizing discovery with dynamic ratio adjustment
// =====================

export async function getOrCreateDiscoveryConfig(): Promise<{
  exploreRatio: number;
  exploreRatioMin: number;
  exploreRatioMax: number;
  vectorCreationThreshold: number;
  vectorPruneThreshold: number;
}> {
  const existing = await db.select()
    .from(discoveryConfig)
    .where(eq(discoveryConfig.configKey, "global"))
    .limit(1);
  
  if (existing[0]) {
    return {
      exploreRatio: existing[0].exploreRatio || 0.1,
      exploreRatioMin: existing[0].exploreRatioMin || 0.1,
      exploreRatioMax: existing[0].exploreRatioMax || 0.5,
      vectorCreationThreshold: existing[0].vectorCreationThreshold || 0.7,
      vectorPruneThreshold: existing[0].vectorPruneThreshold || 0.2
    };
  }
  
  const now = Math.floor(Date.now() / 1000);
  await db.insert(discoveryConfig).values({
    configKey: "global",
    exploreRatio: 0.1,
    exploreRatioMin: 0.1,
    exploreRatioMax: 0.5,
    vectorCreationThreshold: 0.7,
    vectorPruneThreshold: 0.2,
    adjustmentHistory: [],
    createdAt: now
  });
  
  return {
    exploreRatio: 0.1,
    exploreRatioMin: 0.1,
    exploreRatioMax: 0.5,
    vectorCreationThreshold: 0.7,
    vectorPruneThreshold: 0.2
  };
}

export async function selectDiscoverySources(): Promise<{
  primarySource: { sourceId: string; sourceType: string } | null;
  experimentSource: { sourceId: string; sourceType: string } | null;
  primaryAllocation: number;
  experimentAllocation: number;
}> {
  const config = await getOrCreateDiscoveryConfig();
  
  const sources = await db.select()
    .from(discoverySources)
    .where(eq(discoverySources.isActive, true))
    .orderBy(desc(discoverySources.priority));
  
  if (sources.length === 0) {
    return {
      primarySource: null,
      experimentSource: null,
      primaryAllocation: 1,
      experimentAllocation: 0
    };
  }
  
  const primarySource = sources[0];
  
  const exploitAllocation = 1 - config.exploreRatio;
  const exploreAllocation = config.exploreRatio;
  
  let experimentSource = null;
  if (sources.length > 1 && Math.random() < exploreAllocation) {
    const otherSources = sources.slice(1);
    const totalWeight = otherSources.reduce((sum, s) => sum + (s.priority || 50), 0);
    let random = Math.random() * totalWeight;
    
    for (const source of otherSources) {
      random -= source.priority || 50;
      if (random <= 0) {
        experimentSource = source;
        break;
      }
    }
    experimentSource = experimentSource || otherSources[0];
  }
  
  return {
    primarySource: { sourceId: primarySource.sourceId, sourceType: primarySource.sourceType },
    experimentSource: experimentSource ? { sourceId: experimentSource.sourceId, sourceType: experimentSource.sourceType } : null,
    primaryAllocation: exploitAllocation,
    experimentAllocation: experimentSource ? exploreAllocation : 0
  };
}

function getVectorBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

export async function recordDiscoverySourceOutcome(
  tokenMint: string,
  sourceId: string,
  outcome: {
    executed: boolean;
    pnlPercent: number | null;
    holdTimeMinutes: number | null;
    isWin: boolean;
  }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const source = await db.select()
    .from(discoverySources)
    .where(eq(discoverySources.sourceId, sourceId))
    .limit(1);
  
  if (!source[0]) return;
  
  const currentSample = source[0].sampleCount || 0;
  const currentSuccessRate = source[0].successRate || 0;
  const currentAvgPnl = source[0].avgPnlPercent || 0;
  
  const newSample = currentSample + 1;
  const newSuccessRate = (currentSuccessRate * currentSample + (outcome.isWin ? 1 : 0)) / newSample;
  const newAvgPnl = outcome.pnlPercent !== null 
    ? (currentAvgPnl * currentSample + outcome.pnlPercent) / newSample 
    : currentAvgPnl;
  
  const newPriority = Math.min(100, Math.max(1, 
    50 + (newSuccessRate - 0.5) * 50 + (newAvgPnl / 10)
  ));
  
  await db.update(discoverySources)
    .set({
      sampleCount: newSample,
      successRate: newSuccessRate,
      avgPnlPercent: newAvgPnl,
      priority: Math.round(newPriority),
      updatedAt: now
    })
    .where(eq(discoverySources.sourceId, sourceId));
  
  const bucketId = getVectorBucketId();
  await db.insert(vectorUpdates).values({
    vectorType: "discovery_source",
    targetId: sourceId,
    signalType: outcome.isWin ? "discovery_win" : "discovery_loss",
    signalData: {
      tokenMint,
      pnlPercent: outcome.pnlPercent,
      holdTimeMinutes: outcome.holdTimeMinutes
    },
    weight: outcome.isWin ? 2.0 : 1.5,
    bucketId,
    processed: false,
    createdAt: now
  });
}

export async function adjustExploreRatio(): Promise<{
  oldRatio: number;
  newRatio: number;
  reason: string;
}> {
  const config = await getOrCreateDiscoveryConfig();
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 24 * 60 * 60;
  
  const experiments = await db.select()
    .from(discoveryExperiments)
    .where(and(
      eq(discoveryExperiments.status, "completed"),
      gt(discoveryExperiments.completedAt, weekAgo)
    ));
  
  if (experiments.length < 10) {
    return {
      oldRatio: config.exploreRatio,
      newRatio: config.exploreRatio,
      reason: "Not enough experiments to adjust ratio"
    };
  }
  
  let exploitWins = 0;
  let exploitTotal = 0;
  let exploreWins = 0;
  let exploreTotal = 0;
  
  for (const exp of experiments) {
    if (exp.primaryOutcome) {
      const primary = exp.primaryOutcome as { pnlPercent: number | null };
      if (primary.pnlPercent !== null) {
        exploitTotal++;
        if (primary.pnlPercent > 0) exploitWins++;
      }
    }
    if (exp.experimentOutcome) {
      const experiment = exp.experimentOutcome as { pnlPercent: number | null };
      if (experiment.pnlPercent !== null) {
        exploreTotal++;
        if (experiment.pnlPercent > 0) exploreWins++;
      }
    }
  }
  
  const exploitWinRate = exploitTotal > 0 ? exploitWins / exploitTotal : 0.5;
  const exploreWinRate = exploreTotal > 0 ? exploreWins / exploreTotal : 0.5;
  
  let newRatio = config.exploreRatio;
  let reason = "No change needed";
  
  if (exploreWinRate > exploitWinRate + 0.1) {
    newRatio = Math.min(config.exploreRatioMax, config.exploreRatio + 0.05);
    reason = `Experiments outperforming (${(exploreWinRate * 100).toFixed(0)}% vs ${(exploitWinRate * 100).toFixed(0)}%)`;
  } else if (exploitWinRate > exploreWinRate + 0.1) {
    newRatio = Math.max(config.exploreRatioMin, config.exploreRatio - 0.05);
    reason = `Best strategy outperforming (${(exploitWinRate * 100).toFixed(0)}% vs ${(exploreWinRate * 100).toFixed(0)}%)`;
  } else if (exploitWinRate < 0.4 && exploreWinRate < 0.4) {
    newRatio = Math.min(config.exploreRatioMax, config.exploreRatio + 0.1);
    reason = `Both struggling, increasing exploration`;
  }
  
  if (newRatio !== config.exploreRatio) {
    const history = await db.select()
      .from(discoveryConfig)
      .where(eq(discoveryConfig.configKey, "global"))
      .limit(1);
    
    const currentHistory = (history[0]?.adjustmentHistory as any[]) || [];
    currentHistory.push({
      timestamp: now,
      oldRatio: config.exploreRatio,
      newRatio,
      reason,
      outcomeImproved: null
    });
    
    if (currentHistory.length > 20) {
      currentHistory.splice(0, currentHistory.length - 20);
    }
    
    await db.update(discoveryConfig)
      .set({
        exploreRatio: newRatio,
        exploitWinRate,
        exploreWinRate,
        adjustmentHistory: currentHistory,
        updatedAt: now
      })
      .where(eq(discoveryConfig.configKey, "global"));
  }
  
  return {
    oldRatio: config.exploreRatio,
    newRatio,
    reason
  };
}

export async function detectEmergentPattern(
  patternType: "discovery_source" | "strategy" | "route_intent",
  signature: Record<string, any>,
  example: { tokenMint?: string; message?: string; outcome?: any }
): Promise<{ patternId: string; confidence: number; promoted: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  
  const signatureKey = JSON.stringify(signature);
  const patternId = `${patternType}_${Buffer.from(signatureKey).toString('base64').slice(0, 16)}`;
  
  const existing = await db.select()
    .from(emergentPatterns)
    .where(eq(emergentPatterns.patternId, patternId))
    .limit(1);
  
  if (existing[0]) {
    const pattern = existing[0];
    const examples = (pattern.examples as any[]) || [];
    examples.push(example);
    if (examples.length > 20) examples.splice(0, examples.length - 20);
    
    const newCount = (pattern.occurrenceCount || 1) + 1;
    const newConfidence = Math.min(1, (pattern.confidence || 0) + 0.05);
    
    await db.update(emergentPatterns)
      .set({
        occurrenceCount: newCount,
        examples,
        confidence: newConfidence,
        lastSeenAt: now
      })
      .where(eq(emergentPatterns.patternId, patternId));
    
    const config = await getOrCreateDiscoveryConfig();
    if (newConfidence >= config.vectorCreationThreshold && pattern.status === "tracking") {
      await promoteEmergentPattern(patternId, patternType, signature);
      return { patternId, confidence: newConfidence, promoted: true };
    }
    
    return { patternId, confidence: newConfidence, promoted: false };
  }
  
  await db.insert(emergentPatterns).values({
    patternId,
    patternType,
    patternSignature: signature,
    occurrenceCount: 1,
    examples: [example],
    confidence: 0.1,
    confidenceThreshold: 0.7,
    status: "tracking",
    createdAt: now,
    lastSeenAt: now
  });
  
  return { patternId, confidence: 0.1, promoted: false };
}

async function promoteEmergentPattern(
  patternId: string,
  patternType: string,
  signature: Record<string, any>
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  
  try {
    let promotedToId: string | null = null;
    
    if (patternType === "discovery_source") {
      promotedToId = `system_${patternId}`;
      await db.insert(discoverySources).values({
        sourceId: promotedToId,
        sourceType: signature.sourceType || "emergent",
        sourceConfig: signature,
        vector: [],
        createdBy: "system",
        priority: 40,
        createdAt: now
      });
    }
    
    if (promotedToId) {
      await db.update(emergentPatterns)
        .set({
          status: "promoted",
          promotedToId
        })
        .where(eq(emergentPatterns.patternId, patternId));
      
      console.log(`[DiscoveryEngine] Promoted emergent pattern ${patternId} to ${promotedToId}`);
    }
    
    return promotedToId;
  } catch (err) {
    console.error("[DiscoveryEngine] Failed to promote pattern:", err);
    return null;
  }
}

export async function pruneUnderperformingVectors(): Promise<number> {
  const config = await getOrCreateDiscoveryConfig();
  const now = Math.floor(Date.now() / 1000);
  
  const systemSources = await db.select()
    .from(discoverySources)
    .where(and(
      eq(discoverySources.createdBy, "system"),
      lt(discoverySources.successRate, config.vectorPruneThreshold),
      gt(discoverySources.sampleCount, 10)
    ));
  
  let pruned = 0;
  for (const source of systemSources) {
    await db.update(discoverySources)
      .set({ isActive: false, updatedAt: now })
      .where(eq(discoverySources.sourceId, source.sourceId));
    
    console.log(`[DiscoveryEngine] Pruned underperforming source: ${source.sourceId}`);
    pruned++;
  }
  
  return pruned;
}

export async function seedDefaultDiscoverySources(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  const existing = await db.select()
    .from(discoverySources)
    .limit(1);
  
  if (existing.length > 0) return 0;
  
  const defaultSources = [
    { sourceId: "dexscreener_new", sourceType: "dexscreener_new", priority: 60 },
    { sourceId: "dexscreener_gainers", sourceType: "dexscreener_gainers", priority: 55 },
    { sourceId: "whale_follows", sourceType: "whale_follows", priority: 70 },
    { sourceId: "signal_wallet_overlap", sourceType: "signal_wallet_overlap", priority: 65 },
  ];
  
  for (const source of defaultSources) {
    await db.insert(discoverySources).values({
      ...source,
      sourceConfig: {},
      vector: [],
      createdBy: "manual",
      createdAt: now
    });
  }
  
  console.log(`[DiscoveryEngine] Seeded ${defaultSources.length} default discovery sources`);
  return defaultSources.length;
}

export async function processDiscoverySourceUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "discovery_source"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));
  
  if (updates.length === 0) return 0;
  
  const sourceUpdates = new Map<string, { wins: number; losses: number; totalWeight: number }>();
  
  for (const update of updates) {
    const sourceId = update.targetId;
    const current = sourceUpdates.get(sourceId) || { wins: 0, losses: 0, totalWeight: 0 };
    
    if (update.signalType === "discovery_win") {
      current.wins += update.weight || 1;
    } else {
      current.losses += update.weight || 1;
    }
    current.totalWeight += update.weight || 1;
    
    sourceUpdates.set(sourceId, current);
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  for (const [sourceId, data] of Array.from(sourceUpdates.entries())) {
    const source = await db.select()
      .from(discoverySources)
      .where(eq(discoverySources.sourceId, sourceId))
      .limit(1);
    
    if (!source[0]) continue;
    
    const dampening = 1 / (1 + Math.log10(Math.max(1, source[0].sampleCount || 1)));
    const recentWinRate = data.wins / (data.wins + data.losses);
    const currentConfidence = source[0].confidence || 0.5;
    const newConfidence = currentConfidence + dampening * (recentWinRate - currentConfidence) * 0.1;
    
    await db.update(discoverySources)
      .set({
        confidence: Math.max(0, Math.min(1, newConfidence)),
        updatedAt: now
      })
      .where(eq(discoverySources.sourceId, sourceId));
  }
  
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(and(
      eq(vectorUpdates.vectorType, "discovery_source"),
      eq(vectorUpdates.bucketId, bucketId)
    ));
  
  return sourceUpdates.size;
}

// View signal constants
const VIEW_SIGNAL_DECAY_HOURS = 48;
const VIEW_SIGNAL_MAX_SCORE = 3; // log scale cap

/**
 * Calculate decay factor for a view signal based on time since view
 * Returns 0-1, where 1 = fresh view, 0 = fully decayed (>48h)
 */
export function calculateViewDecay(viewedAt: number): number {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - viewedAt;
  const ageHours = ageSeconds / 3600;
  
  if (ageHours >= VIEW_SIGNAL_DECAY_HOURS) return 0;
  return 1 - (ageHours / VIEW_SIGNAL_DECAY_HOURS);
}

/**
 * Calculate view signal score for a token based on unique user views
 * Uses log scale: min(log(signal + 1), 3) where signal = sum of decayed views
 */
export async function calculateTokenViewSignal(tokenMint: string): Promise<{
  rawSignal: number;
  score: number;
  uniqueUsers: number;
}> {
  const views = await db.query.userTokenViews.findMany({
    where: eq(userTokenViews.tokenMint, tokenMint)
  });
  
  if (views.length === 0) {
    return { rawSignal: 0, score: 0, uniqueUsers: 0 };
  }
  
  // Sum decayed signals across unique users
  const rawSignal = views.reduce((sum, view) => {
    const decay = calculateViewDecay(view.viewedAt);
    return sum + decay;
  }, 0);
  
  // Apply log scale with cap
  const score = Math.min(Math.log(rawSignal + 1), VIEW_SIGNAL_MAX_SCORE);
  
  return {
    rawSignal,
    score,
    uniqueUsers: views.length
  };
}

/**
 * Get tokens with highest view signals for discovery consideration
 */
export async function getTopViewedTokens(limit: number = 20): Promise<Array<{
  tokenMint: string;
  score: number;
  uniqueUsers: number;
  avgAiScore: number | null;
  avgPnl: number | null;
}>> {
  // Get all token views from last 48 hours
  const cutoff = Math.floor(Date.now() / 1000) - (VIEW_SIGNAL_DECAY_HOURS * 3600);
  
  const recentViews = await db.query.userTokenViews.findMany({
    where: gte(userTokenViews.viewedAt, cutoff)
  });
  
  // Group by token
  const tokenMap = new Map<string, typeof recentViews>();
  for (const view of recentViews) {
    const existing = tokenMap.get(view.tokenMint) || [];
    existing.push(view);
    tokenMap.set(view.tokenMint, existing);
  }
  
  // Calculate scores
  const results: Array<{
    tokenMint: string;
    score: number;
    uniqueUsers: number;
    avgAiScore: number | null;
    avgPnl: number | null;
  }> = [];
  
  for (const [tokenMint, views] of tokenMap.entries()) {
    const rawSignal = views.reduce((sum, v) => sum + calculateViewDecay(v.viewedAt), 0);
    const score = Math.min(Math.log(rawSignal + 1), VIEW_SIGNAL_MAX_SCORE);
    
    // Calculate averages for AI score and PnL
    const aiScores = views.filter(v => v.aiAnalysisScore !== null).map(v => v.aiAnalysisScore!);
    const pnls = views.filter(v => v.pnlPercent !== null).map(v => v.pnlPercent!);
    
    results.push({
      tokenMint,
      score,
      uniqueUsers: views.length,
      avgAiScore: aiScores.length > 0 ? aiScores.reduce((a, b) => a + b, 0) / aiScores.length : null,
      avgPnl: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null,
    });
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  return results.slice(0, limit);
}
