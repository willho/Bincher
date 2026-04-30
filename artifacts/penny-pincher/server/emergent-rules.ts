import { db } from "./db";
import { 
  emergentRules, EmergentRule, InsertEmergentRule,
  systemEvents, paperPositions, holdings
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logSystemEvent, createCorrelationId } from "./system-events";

export interface TriggerConfig {
  type: 'interval' | 'event' | 'threshold';
  intervalMinutes?: number;
  eventType?: string;
  metric?: string;
  threshold?: number;
  operator?: 'gte' | 'lte' | 'gt' | 'lt';
}

export type { Condition };

interface Condition {
  operator: 'AND' | 'OR' | 'NOT' | 'SIMPLE';
  conditions?: Condition[];
  metric?: string;
  comparator?: 'eq' | 'gte' | 'lte' | 'gt' | 'lt';
  value?: number | string;
}

export interface ActionConfig {
  type: 'sell_percent' | 'sell_all' | 'adjust_stop' | 'add_position' | 'alert';
  percent?: number;
  stopLossPercent?: number;
  amount?: number;
  message?: string;
}

export interface RuleContext {
  tokenMint: string;
  positionId?: number;
  userId?: number;
  currentPrice?: number;
  entryPrice?: number;
  currentPnlPercent?: number;
  holdingDurationMinutes?: number;
  whaleActivityLast1h?: number;
  volumeChangePercent?: number;
  priceChangePercent?: number;
  holderCount?: number;
  topHolderPercent?: number;
  heatScore?: number;
}

export async function evaluateCondition(
  condition: Condition,
  context: RuleContext
): Promise<boolean> {
  switch (condition.operator) {
    case 'AND':
      if (!condition.conditions) return true;
      for (const c of condition.conditions) {
        if (!(await evaluateCondition(c, context))) return false;
      }
      return true;
      
    case 'OR':
      if (!condition.conditions) return false;
      for (const c of condition.conditions) {
        if (await evaluateCondition(c, context)) return true;
      }
      return false;
      
    case 'NOT':
      if (!condition.conditions || condition.conditions.length === 0) return true;
      return !(await evaluateCondition(condition.conditions[0], context));
      
    case 'SIMPLE':
      return evaluateSimpleCondition(condition, context);
      
    default:
      return false;
  }
}

function evaluateSimpleCondition(condition: Condition, context: RuleContext): boolean {
  const metric = condition.metric;
  if (!metric) return false;
  
  const contextValue = (context as Record<string, any>)[metric];
  if (contextValue === undefined || contextValue === null) return false;
  
  const targetValue = condition.value;
  if (targetValue === undefined || targetValue === null) return false;
  
  switch (condition.comparator) {
    case 'eq':
      return contextValue === targetValue;
    case 'gte':
      return contextValue >= targetValue;
    case 'lte':
      return contextValue <= targetValue;
    case 'gt':
      return contextValue > targetValue;
    case 'lt':
      return contextValue < targetValue;
    default:
      return false;
  }
}

export async function checkTrigger(
  trigger: TriggerConfig,
  context: RuleContext,
  lastTriggeredAt?: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  
  switch (trigger.type) {
    case 'interval':
      if (!trigger.intervalMinutes) return false;
      if (!lastTriggeredAt) return true;
      const intervalSeconds = trigger.intervalMinutes * 60;
      return (now - lastTriggeredAt) >= intervalSeconds;
      
    case 'threshold':
      if (!trigger.metric || trigger.threshold === undefined) return false;
      const metricValue = (context as Record<string, any>)[trigger.metric];
      if (metricValue === undefined) return false;
      
      switch (trigger.operator) {
        case 'gte': return metricValue >= trigger.threshold;
        case 'lte': return metricValue <= trigger.threshold;
        case 'gt': return metricValue > trigger.threshold;
        case 'lt': return metricValue < trigger.threshold;
        default: return false;
      }
      
    case 'event':
      // Event triggers should be handled by explicit event firing, not polling
      // Return false here - events are triggered by logSystemEvent + triggerEventRules()
      return false;
      
    default:
      return false;
  }
}

export async function evaluateRule(
  rule: EmergentRule,
  context: RuleContext
): Promise<{ shouldAct: boolean; action?: ActionConfig }> {
  if (!rule.enabled || rule.status === 'deprecated') {
    return { shouldAct: false };
  }
  
  const trigger = rule.triggerConfig as TriggerConfig | null;
  if (!trigger) return { shouldAct: false };
  
  const triggerPassed = await checkTrigger(trigger, context, rule.lastTriggeredAt || undefined);
  if (!triggerPassed) return { shouldAct: false };
  
  const condition = rule.condition as Condition | null;
  if (condition) {
    const conditionPassed = await evaluateCondition(condition, context);
    if (!conditionPassed) return { shouldAct: false };
  }
  
  const action = rule.actionConfig as ActionConfig | null;
  if (!action) return { shouldAct: false };
  
  return { shouldAct: true, action };
}

export async function getActiveRules(paperOnly?: boolean): Promise<EmergentRule[]> {
  const conditions = [
    eq(emergentRules.enabled, true),
    eq(emergentRules.status, 'active'),
  ];
  
  if (paperOnly !== undefined) {
    conditions.push(eq(emergentRules.paperOnly, paperOnly));
  }
  
  return await db.select()
    .from(emergentRules)
    .where(and(...conditions))
    .orderBy(desc(emergentRules.confidence));
}

export async function getTestingRules(): Promise<EmergentRule[]> {
  return await db.select()
    .from(emergentRules)
    .where(and(
      eq(emergentRules.enabled, true),
      eq(emergentRules.status, 'testing')
    ))
    .orderBy(desc(emergentRules.createdAt));
}

export async function createRule(params: {
  name: string;
  description?: string;
  triggerConfig: TriggerConfig;
  condition?: Condition;
  actionConfig: ActionConfig;
  scope?: string;
  origin?: string;
  parentRuleId?: string;
  discoveredPattern?: string;
}): Promise<EmergentRule> {
  const now = Math.floor(Date.now() / 1000);
  const ruleId = nanoid();
  
  const insert: InsertEmergentRule = {
    ruleId,
    name: params.name,
    description: params.description,
    triggerType: params.triggerConfig.type,
    triggerConfig: params.triggerConfig,
    condition: params.condition,
    actionType: params.actionConfig.type,
    actionConfig: params.actionConfig,
    scope: params.scope || 'global',
    origin: params.origin || 'evolved',
    parentRuleId: params.parentRuleId,
    discoveredPattern: params.discoveredPattern,
    status: 'testing',
    enabled: true,
    paperOnly: true,
    createdAt: now,
  };
  
  await db.insert(emergentRules).values(insert);
  
  const [created] = await db.select().from(emergentRules)
    .where(eq(emergentRules.ruleId, ruleId));
  
  await logSystemEvent({
    eventType: 'rule_triggered',
    sourceSystem: 'meta_optimizer',
    payload: { ruleId, name: params.name, origin: params.origin },
  });
  
  return created;
}

export async function recordRuleOutcome(
  ruleId: string,
  isWin: boolean,
  pnl: number
): Promise<void> {
  const [rule] = await db.select().from(emergentRules)
    .where(eq(emergentRules.ruleId, ruleId));
  
  if (!rule) return;
  
  const now = Math.floor(Date.now() / 1000);
  const newSampleCount = (rule.sampleCount || 0) + 1;
  const newWinCount = (rule.winCount || 0) + (isWin ? 1 : 0);
  const newTotalPnl = (rule.totalPnl || 0) + pnl;
  const newConfidence = newWinCount / newSampleCount;
  const newAvgPnl = newTotalPnl / newSampleCount;
  
  await db.update(emergentRules)
    .set({
      sampleCount: newSampleCount,
      winCount: newWinCount,
      totalPnl: newTotalPnl,
      confidence: newConfidence,
      avgPnlPerTrade: newAvgPnl,
      lastTriggeredAt: now,
      updatedAt: now,
    })
    .where(eq(emergentRules.ruleId, ruleId));
}

export async function promoteRule(ruleId: string): Promise<boolean> {
  const [rule] = await db.select().from(emergentRules)
    .where(eq(emergentRules.ruleId, ruleId));
  
  if (!rule) return false;
  
  const minSample = rule.minSampleForPromotion || 20;
  const minConfidence = rule.minConfidenceForPromotion || 0.6;
  
  if ((rule.sampleCount || 0) < minSample) return false;
  if ((rule.confidence || 0) < minConfidence) return false;
  
  const now = Math.floor(Date.now() / 1000);
  
  await db.update(emergentRules)
    .set({
      status: 'active',
      paperOnly: false,
      promotedAt: now,
      updatedAt: now,
    })
    .where(eq(emergentRules.ruleId, ruleId));
  
  await logSystemEvent({
    eventType: 'rule_action_taken',
    sourceSystem: 'meta_optimizer',
    payload: { ruleId, action: 'promoted', confidence: rule.confidence, sampleCount: rule.sampleCount },
  });
  
  return true;
}

export async function deprecateRule(ruleId: string, reason?: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  await db.update(emergentRules)
    .set({
      status: 'deprecated',
      enabled: false,
      updatedAt: now,
    })
    .where(eq(emergentRules.ruleId, ruleId));
  
  await logSystemEvent({
    eventType: 'rule_action_taken',
    sourceSystem: 'meta_optimizer',
    payload: { ruleId, action: 'deprecated', reason },
  });
}

export async function evaluateRulePromotion(): Promise<string[]> {
  const testingRules = await getTestingRules();
  const promoted: string[] = [];
  
  for (const rule of testingRules) {
    const wasPromoted = await promoteRule(rule.ruleId);
    if (wasPromoted) {
      promoted.push(rule.ruleId);
    }
    
    if ((rule.sampleCount || 0) >= (rule.minSampleForPromotion || 20) * 2) {
      if ((rule.confidence || 0) < (rule.minConfidenceForPromotion || 0.6) * 0.5) {
        await deprecateRule(rule.ruleId, 'Low confidence after sufficient samples');
      }
    }
  }
  
  return promoted;
}

interface PatternObservation {
  patternType: string;
  description: string;
  triggerConfig: TriggerConfig;
  condition: Condition;
  actionConfig: ActionConfig;
  observedWinRate: number;
  sampleCount: number;
}

export async function proposeNewRule(observation: PatternObservation): Promise<EmergentRule | null> {
  if (observation.sampleCount < 10) return null;
  if (observation.observedWinRate < 0.55) return null;
  
  const existingRules = await db.select().from(emergentRules)
    .where(eq(emergentRules.discoveredPattern, observation.patternType));
  
  if (existingRules.length > 0) return null;
  
  return await createRule({
    name: `Auto: ${observation.description}`,
    description: `Automatically discovered pattern: ${observation.patternType}`,
    triggerConfig: observation.triggerConfig,
    condition: observation.condition,
    actionConfig: observation.actionConfig,
    origin: 'evolved',
    discoveredPattern: observation.patternType,
  });
}

export const PRESET_RULES: Array<{
  name: string;
  description: string;
  triggerConfig: TriggerConfig;
  condition: Condition;
  actionConfig: ActionConfig;
}> = [
  {
    name: 'Whale Exit Alert',
    description: 'Alert when top holder sells while position is profitable',
    triggerConfig: { type: 'event', eventType: 'whale_sell' },
    condition: {
      operator: 'AND',
      conditions: [
        { operator: 'SIMPLE', metric: 'currentPnlPercent', comparator: 'gt', value: 0 },
        { operator: 'SIMPLE', metric: 'topHolderPercent', comparator: 'lt', value: 5 },
      ],
    },
    actionConfig: { type: 'alert', message: 'Top holder exiting while you are in profit' },
  },
  {
    name: 'Progressive Take Profit',
    description: 'Sell 25% when profit exceeds 50%',
    triggerConfig: { type: 'threshold', metric: 'currentPnlPercent', threshold: 50, operator: 'gte' },
    condition: { operator: 'SIMPLE', metric: 'currentPnlPercent', comparator: 'gte', value: 50 },
    actionConfig: { type: 'sell_percent', percent: 25 },
  },
  {
    name: 'Trailing Stop Tightener',
    description: 'Tighten stop loss when profit exceeds 100%',
    triggerConfig: { type: 'threshold', metric: 'currentPnlPercent', threshold: 100, operator: 'gte' },
    condition: { operator: 'SIMPLE', metric: 'currentPnlPercent', comparator: 'gte', value: 100 },
    actionConfig: { type: 'adjust_stop', stopLossPercent: 20 },
  },
  {
    name: 'Volume Drop Exit',
    description: 'Exit position when volume drops 80% from entry',
    triggerConfig: { type: 'threshold', metric: 'volumeChangePercent', threshold: -80, operator: 'lte' },
    condition: {
      operator: 'AND',
      conditions: [
        { operator: 'SIMPLE', metric: 'volumeChangePercent', comparator: 'lte', value: -80 },
        { operator: 'SIMPLE', metric: 'holdingDurationMinutes', comparator: 'gte', value: 60 },
      ],
    },
    actionConfig: { type: 'sell_all' },
  },
  {
    name: 'Hourly Whale DCA',
    description: 'Sell 20% every hour after top holder buys',
    triggerConfig: { type: 'interval', intervalMinutes: 60 },
    condition: {
      operator: 'AND',
      conditions: [
        { operator: 'SIMPLE', metric: 'whaleActivityLast1h', comparator: 'gte', value: 1 },
        { operator: 'SIMPLE', metric: 'currentPnlPercent', comparator: 'gt', value: 10 },
      ],
    },
    actionConfig: { type: 'sell_percent', percent: 20 },
  },
];

export async function initializePresetRules(): Promise<number> {
  let created = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const preset of PRESET_RULES) {
    const [existing] = await db.select().from(emergentRules)
      .where(eq(emergentRules.name, preset.name))
      .limit(1);
    
    if (!existing) {
      await createRule({
        name: preset.name,
        description: preset.description,
        triggerConfig: preset.triggerConfig,
        condition: preset.condition,
        actionConfig: preset.actionConfig,
        origin: 'preset',
      });
      created++;
    }
  }
  
  return created;
}
