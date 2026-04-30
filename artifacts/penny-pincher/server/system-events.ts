import { db } from "./db";
import { systemEvents, SystemEvent, InsertSystemEvent } from "@shared/schema";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

export type SourceSystem = 
  | "discovery" 
  | "heat_score" 
  | "copy_trading" 
  | "ai_chat" 
  | "paper_trading" 
  | "strategy_cluster"
  | "whale_detection"
  | "safety_checker"
  | "budget_manager"
  | "data_pool"
  | "meta_optimizer";

export type EventType =
  | "discovery_fired"
  | "discovery_matched"
  | "heat_calculated"
  | "heat_threshold_crossed"
  | "copy_executed"
  | "copy_skipped"
  | "ai_recommendation"
  | "ai_analysis"
  | "trade_opened"
  | "trade_closed"
  | "whale_detected"
  | "whale_sell"
  | "safety_check_passed"
  | "safety_check_failed"
  | "rule_triggered"
  | "rule_action_taken"
  | "experiment_assigned"
  | "pattern_detected"
  | "correlation_found";

interface LogEventParams {
  eventType: EventType;
  sourceSystem: SourceSystem;
  targetSystem?: SourceSystem;
  userId?: number;
  tokenMint?: string;
  walletAddress?: string;
  positionId?: number;
  correlationId?: string;
  payload?: Record<string, any>;
  metrics?: Record<string, number>;
}

function getCurrentBucketId(): string {
  const now = new Date();
  const hours = Math.floor(now.getUTCHours() / 8) * 8;
  const bucketDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours, 0, 0, 0
  ));
  return `${bucketDate.getUTCFullYear()}-${String(bucketDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bucketDate.getUTCDate()).padStart(2, '0')}_${String(hours).padStart(2, '0')}`;
}

const EVENT_TRIGGER_TYPES: EventType[] = [
  'whale_detected',
  'whale_sell',
  'discovery_fired',
  'heat_threshold_crossed',
];

export async function logSystemEvent(params: LogEventParams): Promise<string> {
  const eventId = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const bucketId = getCurrentBucketId();
  
  const event: InsertSystemEvent = {
    eventId,
    eventType: params.eventType,
    sourceSystem: params.sourceSystem,
    targetSystem: params.targetSystem,
    userId: params.userId,
    tokenMint: params.tokenMint,
    walletAddress: params.walletAddress,
    positionId: params.positionId,
    correlationId: params.correlationId || nanoid(10),
    payload: params.payload,
    metrics: params.metrics,
    timestamp: now,
    bucketId,
  };
  
  await db.insert(systemEvents).values(event);
  
  // Auto-trigger event-based rules for specific event types
  if (params.tokenMint && EVENT_TRIGGER_TYPES.includes(params.eventType)) {
    // Use setImmediate to avoid blocking the event logging
    setImmediate(async () => {
      try {
        await triggerEventRulesInternal(params.eventType, params.tokenMint!, {
          ...params.metrics,
          userId: params.userId,
          positionId: params.positionId,
        });
      } catch (err) {
        console.error('[SystemEvents] Auto-trigger event rules failed:', err);
      }
    });
  }
  
  return eventId;
}

async function triggerEventRulesInternal(
  eventType: EventType,
  tokenMint: string,
  context?: Record<string, any>
): Promise<void> {
  try {
    const { getActiveRules, getTestingRules, evaluateCondition } = await import("./emergent-rules");
    const { executeEventTriggeredRule } = await import("./rule-executor");
    
    const [activeRules, testingRules] = await Promise.all([
      getActiveRules(),
      getTestingRules()
    ]);
    const allRules = [...activeRules, ...testingRules];
    
    for (const rule of allRules) {
      const triggerConfig = rule.triggerConfig as { type: string; eventType?: string } | null;
      if (!triggerConfig || triggerConfig.type !== 'event') continue;
      if (triggerConfig.eventType !== eventType) continue;
      
      const ruleContext = {
        tokenMint,
        ...context,
      };
      
      const condition = rule.condition as any | null;
      let shouldAct = true;
      
      if (condition) {
        shouldAct = await evaluateCondition(condition, ruleContext);
      }
      
      const action = rule.actionConfig as { type: string; percent?: number; message?: string } | null;
      
      if (shouldAct && action) {
        await logSystemEventDirect({
          eventType: 'rule_triggered',
          sourceSystem: 'meta_optimizer',
          tokenMint,
          payload: {
            ruleId: rule.ruleId,
            ruleName: rule.name,
            triggeredBy: eventType,
            actionType: action.type,
            paperOnly: rule.paperOnly,
          },
        });
        
        // Actually execute the rule action on relevant positions
        try {
          await executeEventTriggeredRule(rule, tokenMint, action);
        } catch (execErr) {
          console.error(`[SystemEvents] Rule action execution failed:`, execErr);
        }
        
        console.log(`[SystemEvents] Event rule ${rule.name} triggered by ${eventType} for ${tokenMint}`);
      }
    }
  } catch (err) {
    console.error('[SystemEvents] Event rule trigger failed:', err);
  }
}

async function logSystemEventDirect(params: LogEventParams): Promise<string> {
  const eventId = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const bucketId = getCurrentBucketId();
  
  const event: InsertSystemEvent = {
    eventId,
    eventType: params.eventType,
    sourceSystem: params.sourceSystem,
    targetSystem: params.targetSystem,
    userId: params.userId,
    tokenMint: params.tokenMint,
    walletAddress: params.walletAddress,
    positionId: params.positionId,
    correlationId: params.correlationId || nanoid(10),
    payload: params.payload,
    metrics: params.metrics,
    timestamp: now,
    bucketId,
  };
  
  await db.insert(systemEvents).values(event);
  return eventId;
}

export async function logEventChain(
  correlationId: string,
  events: Omit<LogEventParams, 'correlationId'>[]
): Promise<string[]> {
  const eventIds: string[] = [];
  for (const event of events) {
    const id = await logSystemEvent({ ...event, correlationId });
    eventIds.push(id);
  }
  return eventIds;
}

export async function recordOutcome(
  eventId: string,
  outcomeType: 'win' | 'loss' | 'neutral',
  pnl: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.update(systemEvents)
    .set({
      outcomeType,
      outcomePnl: pnl,
      outcomeRecordedAt: now,
    })
    .where(eq(systemEvents.eventId, eventId));
}

export async function recordOutcomeByCorrelation(
  correlationId: string,
  outcomeType: 'win' | 'loss' | 'neutral',
  pnl: number
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.update(systemEvents)
    .set({
      outcomeType,
      outcomePnl: pnl,
      outcomeRecordedAt: now,
    })
    .where(eq(systemEvents.correlationId, correlationId));
  
  return (result as any).rowCount || 0;
}

export async function getEventsByCorrelation(correlationId: string): Promise<SystemEvent[]> {
  return await db.select()
    .from(systemEvents)
    .where(eq(systemEvents.correlationId, correlationId))
    .orderBy(systemEvents.timestamp);
}

export async function getEventsByBucket(bucketId: string): Promise<SystemEvent[]> {
  return await db.select()
    .from(systemEvents)
    .where(eq(systemEvents.bucketId, bucketId))
    .orderBy(systemEvents.timestamp);
}

export async function getEventsByToken(
  tokenMint: string,
  startTime?: number,
  endTime?: number
): Promise<SystemEvent[]> {
  const conditions = [eq(systemEvents.tokenMint, tokenMint)];
  if (startTime) conditions.push(gte(systemEvents.timestamp, startTime));
  if (endTime) conditions.push(lte(systemEvents.timestamp, endTime));
  
  return await db.select()
    .from(systemEvents)
    .where(and(...conditions))
    .orderBy(desc(systemEvents.timestamp));
}

export async function getEventsWithOutcomes(
  bucketId?: string,
  eventTypes?: EventType[]
): Promise<SystemEvent[]> {
  const conditions: any[] = [sql`${systemEvents.outcomeType} IS NOT NULL`];
  if (bucketId) conditions.push(eq(systemEvents.bucketId, bucketId));
  if (eventTypes?.length) conditions.push(inArray(systemEvents.eventType, eventTypes));
  
  return await db.select()
    .from(systemEvents)
    .where(and(...conditions))
    .orderBy(desc(systemEvents.timestamp));
}

interface EventStats {
  eventType: string;
  sourceSystem: string;
  count: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
}

export async function getEventStatsByBucket(bucketId: string): Promise<EventStats[]> {
  const events = await getEventsWithOutcomes(bucketId);
  
  const stats = new Map<string, EventStats>();
  
  for (const event of events) {
    const key = `${event.eventType}:${event.sourceSystem}`;
    
    if (!stats.has(key)) {
      stats.set(key, {
        eventType: event.eventType,
        sourceSystem: event.sourceSystem,
        count: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
        avgPnl: 0,
        totalPnl: 0,
      });
    }
    
    const s = stats.get(key)!;
    s.count++;
    s.totalPnl += event.outcomePnl || 0;
    
    if (event.outcomeType === 'win') s.winCount++;
    if (event.outcomeType === 'loss') s.lossCount++;
  }
  
  Array.from(stats.values()).forEach(s => {
    s.winRate = s.count > 0 ? s.winCount / s.count : 0;
    s.avgPnl = s.count > 0 ? s.totalPnl / s.count : 0;
  });
  
  return Array.from(stats.values());
}

interface CooccurrencePattern {
  eventTypeA: string;
  eventTypeB: string;
  cooccurrenceCount: number;
  winWhenBoth: number;
  winWhenOnlyA: number;
  winWhenOnlyB: number;
  liftRatio: number;
}

export async function findEventCooccurrences(
  bucketId: string,
  windowSeconds: number = 300
): Promise<CooccurrencePattern[]> {
  const events = await getEventsByBucket(bucketId);
  
  const tokenEvents = new Map<string, SystemEvent[]>();
  for (const event of events) {
    if (!event.tokenMint) continue;
    if (!tokenEvents.has(event.tokenMint)) {
      tokenEvents.set(event.tokenMint, []);
    }
    tokenEvents.get(event.tokenMint)!.push(event);
  }
  
  const patterns = new Map<string, CooccurrencePattern>();
  
  Array.from(tokenEvents.entries()).forEach(([_tokenMint, evts]) => {
    const sorted = evts.sort((a: SystemEvent, b: SystemEvent) => a.timestamp - b.timestamp);
    
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        
        if (b.timestamp - a.timestamp > windowSeconds) break;
        if (a.eventType === b.eventType) continue;
        
        const key = [a.eventType, b.eventType].sort().join('::');
        
        if (!patterns.has(key)) {
          patterns.set(key, {
            eventTypeA: a.eventType,
            eventTypeB: b.eventType,
            cooccurrenceCount: 0,
            winWhenBoth: 0,
            winWhenOnlyA: 0,
            winWhenOnlyB: 0,
            liftRatio: 0,
          });
        }
        
        const p = patterns.get(key)!;
        p.cooccurrenceCount++;
        
        const laterEvent = sorted.find((e: SystemEvent) => 
          e.timestamp > b.timestamp && 
          e.outcomeType !== null &&
          e.outcomeType !== undefined
        );
        
        if (laterEvent?.outcomeType === 'win') {
          p.winWhenBoth++;
        }
      }
    }
  });
  
  return Array.from(patterns.values())
    .filter(p => p.cooccurrenceCount >= 3)
    .sort((a, b) => b.cooccurrenceCount - a.cooccurrenceCount);
}

export async function cleanupOldEvents(retentionDays: number = 30): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - (retentionDays * 24 * 60 * 60);
  
  const result = await db.delete(systemEvents)
    .where(lte(systemEvents.timestamp, cutoff));
  
  return (result as any).rowCount || 0;
}

export function createCorrelationId(): string {
  return nanoid(10);
}

export async function triggerEventRules(
  eventType: EventType,
  tokenMint: string,
  context?: Record<string, any>
): Promise<void> {
  // Delegate to internal function to avoid recursion with logSystemEvent
  await triggerEventRulesInternal(eventType, tokenMint, context);
}
