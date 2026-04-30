import { db } from "./db";
import {
  vectorUpdates,
  discoveryTriggers,
  discoveryEvents,
  tokenDataPool,
  swaps,
  scanContextLogs,
} from "@shared/schema";
import { eq, and, gte, desc, gt, sql } from "drizzle-orm";
import { publishInsight } from "./insight-bus";
import { evaluateMetric } from "./discovery-engine";
import { fetchTokenWithFallback } from "./data-pool";
import { memoryCache } from "./memory-cache";
import { nanoid } from "nanoid";

export type DiscoveryEventType =
  | "trending_spotted"
  | "signal_buy"
  | "new_token"
  | "whale_activity"
  | "volume_spike"
  | "price_surge"
  | "boost_detected"
  | "multi_signal_convergence"
  | "social_call"
  | "social_detected"
  | "pumpfun_graduated"
  | "pumpfun_bonding_curve"
  | "raydium_new_pool";

interface BusEvent {
  type: DiscoveryEventType;
  tokenMint: string;
  tokenSymbol?: string;
  source: string;
  data: Record<string, any>;
  timestamp: number;
  urgency: number;
}

type EventHandler = (event: BusEvent) => Promise<void>;

interface TriggerCombo {
  name: string;
  required: DiscoveryEventType[];
  windowMs: number;
  minUrgency: number;
  action: (events: BusEvent[]) => Promise<void>;
}

const recentEvents: BusEvent[] = [];
const MAX_RECENT = 500;
const RECENT_WINDOW_MS = 10 * 60 * 1000;

const handlers: Map<DiscoveryEventType, EventHandler[]> = new Map();
const combos: TriggerCombo[] = [];
const tokenCooldowns: Map<string, number> = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

const busStats = {
  totalEmitted: 0,
  byType: {} as Record<string, number>,
  combosTriggered: 0,
  lastEmit: 0,
  droppedCooldown: 0,
};

export function onEvent(type: DiscoveryEventType, handler: EventHandler): void {
  const existing = handlers.get(type) || [];
  existing.push(handler);
  handlers.set(type, existing);
}

export function registerCombo(combo: TriggerCombo): void {
  combos.push(combo);
}

export async function emit(event: BusEvent): Promise<void> {
  const cooldownKey = `${event.type}:${event.tokenMint}`;
  const lastSeen = tokenCooldowns.get(cooldownKey);
  if (lastSeen && event.timestamp - lastSeen < COOLDOWN_MS) {
    busStats.droppedCooldown++;
    return;
  }
  tokenCooldowns.set(cooldownKey, event.timestamp);

  recentEvents.push(event);
  busStats.totalEmitted++;
  busStats.byType[event.type] = (busStats.byType[event.type] || 0) + 1;
  busStats.lastEmit = event.timestamp;

  const cutoff = Date.now() - RECENT_WINDOW_MS;
  while (recentEvents.length > MAX_RECENT || (recentEvents.length > 0 && recentEvents[0].timestamp < cutoff)) {
    recentEvents.shift();
  }

  const typeHandlers = handlers.get(event.type) || [];
  for (const handler of typeHandlers) {
    try {
      await handler(event);
    } catch (err) {
      console.error(`[EventBus] Handler error for ${event.type}:`, err);
    }
  }

  await checkCombos(event);
}

async function checkCombos(latestEvent: BusEvent): Promise<void> {
  for (const combo of combos) {
    if (!combo.required.includes(latestEvent.type)) continue;

    const windowStart = latestEvent.timestamp - combo.windowMs;
    const tokenEvents = recentEvents.filter(
      (e) =>
        e.tokenMint === latestEvent.tokenMint &&
        e.timestamp >= windowStart &&
        combo.required.includes(e.type)
    );

    const seenTypes = new Set(tokenEvents.map((e) => e.type));
    const allRequired = combo.required.every((t) => seenTypes.has(t));

    if (!allRequired) continue;

    const avgUrgency = tokenEvents.reduce((s, e) => s + e.urgency, 0) / tokenEvents.length;
    if (avgUrgency < combo.minUrgency) continue;

    const comboKey = `combo:${combo.name}:${latestEvent.tokenMint}`;
    const lastTriggered = tokenCooldowns.get(comboKey);
    if (lastTriggered && latestEvent.timestamp - lastTriggered < combo.windowMs * 2) continue;
    tokenCooldowns.set(comboKey, latestEvent.timestamp);

    busStats.combosTriggered++;
    try {
      await combo.action(tokenEvents);
    } catch (err) {
      console.error(`[EventBus] Combo "${combo.name}" error:`, err);
    }
  }
}

export function getRecentEvents(
  type?: DiscoveryEventType,
  tokenMint?: string,
  limit: number = 50
): BusEvent[] {
  let filtered = recentEvents;
  if (type) filtered = filtered.filter((e) => e.type === type);
  if (tokenMint) filtered = filtered.filter((e) => e.tokenMint === tokenMint);
  return filtered.slice(-limit);
}

export function getBusStats() {
  return { ...busStats, recentCount: recentEvents.length, combosRegistered: combos.length };
}

async function runImmediateDiscoveryScan(event: BusEvent): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const triggers = await db
    .select()
    .from(discoveryTriggers)
    .where(eq(discoveryTriggers.enabled, true));

  for (const trigger of triggers) {
    const recentEvent = await db
      .select()
      .from(discoveryEvents)
      .where(
        and(
          eq(discoveryEvents.triggerId, trigger.id),
          eq(discoveryEvents.tokenMint, event.tokenMint),
          gte(discoveryEvents.firedAt, now - (trigger.cooldownMinutes || 30) * 60)
        )
      )
      .limit(1);

    if (recentEvent.length > 0) continue;

    const metricValue = await evaluateMetric(
      trigger.metric,
      event.tokenMint,
      trigger.timeWindowMinutes || 60
    );
    if (metricValue === null) continue;

    const weightedThreshold = trigger.threshold * (trigger.currentWeight || 1.0);

    const operators: Record<string, (v: number, t: number) => boolean> = {
      gte: (v, t) => v >= t,
      gt: (v, t) => v > t,
      lte: (v, t) => v <= t,
      lt: (v, t) => v < t,
      eq: (v, t) => Math.abs(v - t) < 0.001,
      change_pct: (v, t) => Math.abs(v) >= t,
    };
    const check = operators[trigger.operator] || operators.gte;
    if (!check(metricValue, weightedThreshold)) continue;

    const tokenData = await fetchTokenWithFallback(event.tokenMint);
    const priceAtDiscovery = tokenData.priceUsd || 0;

    await db.insert(discoveryEvents).values({
      triggerId: trigger.id,
      tokenMint: event.tokenMint,
      tokenSymbol: event.tokenSymbol || tokenData.tokenSymbol || "UNKNOWN",
      metricValue,
      threshold: weightedThreshold,
      priority: trigger.priority || 5,
      priceAtDiscovery,
      firedAt: now,
      expiresAt: now + 24 * 3600,
      status: "pending",
    });

    await db
      .update(discoveryTriggers)
      .set({
        fireCount: (trigger.fireCount || 0) + 1,
        updatedAt: now,
      })
      .where(eq(discoveryTriggers.id, trigger.id));
  }
}

async function publishToInsightBus(event: BusEvent): Promise<void> {
  if (event.urgency < 5) return;

  await publishInsight({
    source: "discovery",
    type: "pattern",
    title: `${event.type}: ${event.tokenSymbol || event.tokenMint.slice(0, 8)}`,
    payload: {
      eventType: event.type,
      tokenMint: event.tokenMint,
      tokenSymbol: event.tokenSymbol,
      source: event.source,
      urgency: event.urgency,
      data: event.data,
    },
    confidence: Math.min(1.0, event.urgency / 10),
    tokenMint: event.tokenMint,
    expiresInHours: 8,
  });
}

async function publishVectorUpdate(event: BusEvent): Promise<void> {
  if (event.urgency < 3) return;

  const now = Math.floor(Date.now() / 1000);
  const hour = new Date().getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  const bucketDate = new Date().toISOString().slice(0, 10);
  const bucketId = `${bucketDate}-${bucket}`;

  await db.insert(vectorUpdates).values({
    vectorType: "strategy",
    targetId: event.tokenMint,
    signalType: `discovery_${event.type}`,
    signalData: {
      source: event.source,
      urgency: event.urgency,
      tokenSymbol: event.tokenSymbol,
      ...event.data,
    },
    weight: event.urgency / 10,
    bucketId,
    processed: false,
    createdAt: now,
  });
}

function registerDefaultHandlers(): void {
  for (const type of [
    "trending_spotted",
    "signal_buy",
    "new_token",
    "whale_activity",
    "volume_spike",
    "price_surge",
    "boost_detected",
    "social_call",
    "social_detected",
    "pumpfun_graduated",
    "raydium_new_pool",
  ] as DiscoveryEventType[]) {
    onEvent(type, runImmediateDiscoveryScan);
    onEvent(type, publishToInsightBus);
    onEvent(type, publishVectorUpdate);
  }

  registerCombo({
    name: "trending_plus_signal",
    required: ["trending_spotted", "signal_buy"],
    windowMs: 5 * 60 * 1000,
    minUrgency: 4,
    action: async (events) => {
      const tokenMint = events[0].tokenMint;
      const tokenSymbol = events[0].tokenSymbol || "UNKNOWN";
      await publishInsight({
        source: "discovery",
        type: "recommendation",
        title: `Convergence: ${tokenSymbol} trending + signal wallet buy`,
        payload: {
          convergenceType: "trending_plus_signal",
          events: events.map((e) => ({ type: e.type, source: e.source, urgency: e.urgency })),
        },
        confidence: 0.75,
        tokenMint,
        expiresInHours: 4,
      });
      await emit({
        type: "multi_signal_convergence",
        tokenMint,
        tokenSymbol,
        source: "event_bus",
        data: { convergenceType: "trending_plus_signal", signalCount: events.length },
        timestamp: Date.now(),
        urgency: 8,
      });
    },
  });

  registerCombo({
    name: "new_token_volume",
    required: ["new_token", "volume_spike"],
    windowMs: 10 * 60 * 1000,
    minUrgency: 3,
    action: async (events) => {
      const tokenMint = events[0].tokenMint;
      const tokenSymbol = events[0].tokenSymbol || "UNKNOWN";
      await publishInsight({
        source: "discovery",
        type: "recommendation",
        title: `New token ${tokenSymbol} with volume spike`,
        payload: {
          convergenceType: "new_token_volume",
          events: events.map((e) => ({ type: e.type, source: e.source, urgency: e.urgency })),
        },
        confidence: 0.65,
        tokenMint,
        expiresInHours: 4,
      });
      await emit({
        type: "multi_signal_convergence",
        tokenMint,
        tokenSymbol,
        source: "event_bus",
        data: { convergenceType: "new_token_volume", signalCount: events.length },
        timestamp: Date.now(),
        urgency: 7,
      });
    },
  });

  registerCombo({
    name: "whale_trending",
    required: ["whale_activity", "trending_spotted"],
    windowMs: 10 * 60 * 1000,
    minUrgency: 5,
    action: async (events) => {
      const tokenMint = events[0].tokenMint;
      const tokenSymbol = events[0].tokenSymbol || "UNKNOWN";
      await publishInsight({
        source: "discovery",
        type: "recommendation",
        title: `Whale activity on trending token ${tokenSymbol}`,
        payload: {
          convergenceType: "whale_trending",
          events: events.map((e) => ({ type: e.type, source: e.source, urgency: e.urgency })),
        },
        confidence: 0.8,
        tokenMint,
        expiresInHours: 4,
      });
      await emit({
        type: "multi_signal_convergence",
        tokenMint,
        tokenSymbol,
        source: "event_bus",
        data: { convergenceType: "whale_trending", signalCount: events.length },
        timestamp: Date.now(),
        urgency: 9,
      });
    },
  });

  registerCombo({
    name: "social_plus_trending",
    required: ["social_call", "trending_spotted"],
    windowMs: 10 * 60 * 1000,
    minUrgency: 4,
    action: async (events) => {
      const tokenMint = events[0].tokenMint;
      const tokenSymbol = events[0].tokenSymbol || "UNKNOWN";
      await publishInsight({
        source: "discovery",
        type: "recommendation",
        title: `Social caller + trending: ${tokenSymbol}`,
        payload: {
          convergenceType: "social_plus_trending",
          events: events.map((e) => ({ type: e.type, source: e.source, urgency: e.urgency })),
        },
        confidence: 0.7,
        tokenMint,
        expiresInHours: 4,
      });
      await emit({
        type: "multi_signal_convergence",
        tokenMint,
        tokenSymbol,
        source: "event_bus",
        data: { convergenceType: "social_plus_trending", signalCount: events.length },
        timestamp: Date.now(),
        urgency: 7,
      });
    },
  });

  registerCombo({
    name: "social_plus_signal_buy",
    required: ["social_call", "signal_buy"],
    windowMs: 15 * 60 * 1000,
    minUrgency: 4,
    action: async (events) => {
      const tokenMint = events[0].tokenMint;
      const tokenSymbol = events[0].tokenSymbol || "UNKNOWN";
      await publishInsight({
        source: "discovery",
        type: "recommendation",
        title: `Social + signal wallet convergence: ${tokenSymbol}`,
        payload: {
          convergenceType: "social_plus_signal",
          events: events.map((e) => ({ type: e.type, source: e.source, urgency: e.urgency })),
        },
        confidence: 0.75,
        tokenMint,
        expiresInHours: 4,
      });
      await emit({
        type: "multi_signal_convergence",
        tokenMint,
        tokenSymbol,
        source: "event_bus",
        data: { convergenceType: "social_plus_signal", signalCount: events.length },
        timestamp: Date.now(),
        urgency: 8,
      });
    },
  });
}

async function runIndicatorScan(): Promise<void> {
  try {
    const { getIndicators } = await import("./technical-indicators");
    const activeTokens = await db.select({ tokenMint: tokenDataPool.tokenMint, tokenSymbol: tokenDataPool.tokenSymbol })
      .from(tokenDataPool)
      .where(gte(tokenDataPool.updatedAt, Math.floor(Date.now() / 1000) - 86400))
      .limit(50);

    let emitted = 0;
    for (const token of activeTokens) {
      const result = await getIndicators(token.tokenMint, "1h");
      if (!result) continue;

      const signals: string[] = [];
      if (result.rsi && result.rsi.value < 25) signals.push(`RSI oversold (${result.rsi.value.toFixed(1)})`);
      if (result.rsi && result.rsi.value > 80) signals.push(`RSI overbought (${result.rsi.value.toFixed(1)})`);
      if (result.macd && Math.abs(result.macd.histogram) > 0 && result.macd.trend === "bullish" && result.composite.score >= 65) {
        signals.push(`MACD bullish crossover`);
      }
      if (result.bollinger && result.bollinger.position === "below") signals.push(`Below Bollinger lower band`);
      if (result.stochastic && result.stochastic.signal === "oversold") signals.push(`Stochastic oversold (K=${result.stochastic.k.toFixed(1)})`);
      if (result.obv && result.obv.trend === "accumulating" && result.composite.score >= 60) signals.push(`OBV accumulating`);

      if (signals.length >= 2 || result.composite.score >= 75 || result.composite.score <= 20) {
        const urgency = result.composite.score >= 75 ? 7 : result.composite.score <= 20 ? 6 : 5;
        await emit({
          type: "price_surge",
          tokenMint: token.tokenMint,
          tokenSymbol: token.tokenSymbol || undefined,
          source: "technical_indicators",
          data: {
            compositeScore: result.composite.score,
            bias: result.composite.bias,
            signals,
            rsi: result.rsi?.value,
            macdTrend: result.macd?.trend,
            bollingerPosition: result.bollinger?.position,
          },
          timestamp: Date.now(),
          urgency,
        });

        await publishInsight({
          source: "discovery",
          type: result.composite.score >= 60 ? "recommendation" : "warning",
          title: `Technical: ${token.tokenSymbol || token.tokenMint.slice(0, 8)} → ${result.composite.bias.replace('_', ' ')}`,
          payload: {
            compositeScore: result.composite.score,
            bias: result.composite.bias,
            signals,
            indicators: {
              rsi: result.rsi,
              macd: result.macd ? { trend: result.macd.trend, histogram: result.macd.histogram } : null,
              bollinger: result.bollinger ? { position: result.bollinger.position, bandwidth: result.bollinger.bandwidth } : null,
              obv: result.obv ? { trend: result.obv.trend } : null,
              stochastic: result.stochastic ? { k: result.stochastic.k, signal: result.stochastic.signal } : null,
            },
          },
          confidence: Math.min(1.0, result.composite.score >= 50 ? result.composite.score / 100 : (100 - result.composite.score) / 100),
          tokenMint: token.tokenMint,
          expiresInHours: 4,
        });

        emitted++;
      }
    }

    if (emitted > 0) {
      console.log(`[EventBus] Indicator scan: ${emitted} signal(s) from ${activeTokens.length} tokens`);
    }
  } catch (err) {
    console.error("[EventBus] Indicator scan error:", err);
  }
}

let initialized = false;

export function initEventBus(): void {
  if (initialized) return;
  initialized = true;
  registerDefaultHandlers();

  setInterval(() => {
    const now = Date.now();
    const keys = Array.from(tokenCooldowns.keys());
    for (const key of keys) {
      const ts = tokenCooldowns.get(key);
      if (ts && now - ts > COOLDOWN_MS * 3) {
        tokenCooldowns.delete(key);
      }
    }
    const cutoff = now - RECENT_WINDOW_MS;
    while (recentEvents.length > 0 && recentEvents[0].timestamp < cutoff) {
      recentEvents.shift();
    }
  }, 60_000);

  setInterval(runIndicatorScan, 15 * 60 * 1000);
  setTimeout(runIndicatorScan, 60_000);

  console.log(`[EventBus] Initialized with ${combos.length} combos, ${handlers.size} event types, indicator scanner (15min)`);
}
