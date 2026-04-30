import { db } from "./db";
import { systemInsights, SystemInsight, emergentRules } from "@shared/schema";
import { eq, and, gte, lte, desc, sql, or, isNull, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

export type InsightSource = 
  | "discovery" 
  | "heat_score" 
  | "ai_chat" 
  | "rule_executor"
  | "whale_detection"
  | "copy_trading"
  | "paper_trading"
  | "meta_optimizer"
  | "strategy_cluster"
  | "safety_checker";

export type InsightType = 
  | "pattern"
  | "recommendation" 
  | "performance"
  | "warning"
  | "correlation"
  | "rule_proposal";

interface PublishInsightParams {
  source: InsightSource;
  type: InsightType;
  title: string;
  payload: Record<string, any>;
  confidence?: number;
  tokenMint?: string;
  walletAddress?: string;
  userId?: number;
  expiresInHours?: number;
}

interface InsightFilter {
  source?: InsightSource | InsightSource[];
  type?: InsightType | InsightType[];
  tokenMint?: string;
  walletAddress?: string;
  userId?: number;
  minConfidence?: number;
  limit?: number;
  includeExpired?: boolean;
}

export async function publishInsight(params: PublishInsightParams): Promise<string> {
  const insightId = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = params.expiresInHours 
    ? now + (params.expiresInHours * 3600)
    : now + (24 * 3600); // Default 24 hours
  
  await db.insert(systemInsights).values({
    insightId,
    sourceSystem: params.source,
    insightType: params.type,
    title: params.title,
    payload: params.payload,
    confidence: params.confidence ?? 0.5,
    tokenMint: params.tokenMint,
    walletAddress: params.walletAddress,
    userId: params.userId,
    createdAt: now,
    expiresAt,
    status: 'active',
    sampleCount: 1,
    accessCount: 0,
  });
  
  // Check if this pattern should become a rule
  await checkPatternForRulePromotion(params);
  
  return insightId;
}

export async function getInsightsForContext(filter: InsightFilter): Promise<SystemInsight[]> {
  const now = Math.floor(Date.now() / 1000);
  
  const conditions: any[] = [
    eq(systemInsights.status, 'active'),
  ];
  
  if (!filter.includeExpired) {
    conditions.push(
      or(
        isNull(systemInsights.expiresAt),
        gte(systemInsights.expiresAt, now)
      )
    );
  }
  
  if (filter.source) {
    const sources = Array.isArray(filter.source) ? filter.source : [filter.source];
    conditions.push(inArray(systemInsights.sourceSystem, sources));
  }
  
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    conditions.push(inArray(systemInsights.insightType, types));
  }
  
  if (filter.tokenMint) {
    conditions.push(
      or(
        eq(systemInsights.tokenMint, filter.tokenMint),
        isNull(systemInsights.tokenMint)
      )
    );
  }
  
  if (filter.walletAddress) {
    conditions.push(
      or(
        eq(systemInsights.walletAddress, filter.walletAddress),
        isNull(systemInsights.walletAddress)
      )
    );
  }
  
  if (filter.userId) {
    conditions.push(
      or(
        eq(systemInsights.userId, filter.userId),
        isNull(systemInsights.userId)
      )
    );
  }
  
  if (filter.minConfidence) {
    conditions.push(gte(systemInsights.confidence, filter.minConfidence));
  }
  
  const insights = await db.select()
    .from(systemInsights)
    .where(and(...conditions))
    .orderBy(desc(systemInsights.confidence), desc(systemInsights.createdAt))
    .limit(filter.limit || 50);
  
  // Update access count for retrieved insights
  if (insights.length > 0) {
    const insightIds = insights.map(i => i.insightId);
    await db.update(systemInsights)
      .set({
        accessCount: sql`${systemInsights.accessCount} + 1`,
        lastAccessedAt: now,
      })
      .where(inArray(systemInsights.insightId, insightIds));
  }
  
  return insights;
}

export async function markInsightConsumed(
  insightId: string, 
  consumedBy: InsightSource
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.update(systemInsights)
    .set({
      status: 'consumed',
      consumedBy,
      consumedAt: now,
    })
    .where(eq(systemInsights.insightId, insightId));
}

export async function getRulePerformanceContext(): Promise<{
  topPerformers: Array<{ name: string; confidence: number; winRate: number; sampleCount: number }>;
  lowPerformers: Array<{ name: string; confidence: number; winRate: number; sampleCount: number }>;
  recentTriggers: Array<{ ruleName: string; tokenMint: string; action: string; timestamp: number }>;
}> {
  const activeRules = await db.select()
    .from(emergentRules)
    .where(
      or(
        eq(emergentRules.status, 'active'),
        eq(emergentRules.status, 'testing')
      )
    )
    .orderBy(desc(emergentRules.confidence));
  
  const topPerformers = activeRules
    .filter(r => (r.confidence ?? 0) >= 0.6 && (r.sampleCount ?? 0) >= 5)
    .slice(0, 5)
    .map(r => ({
      name: r.name,
      confidence: r.confidence ?? 0,
      winRate: (r.sampleCount ?? 0) > 0 
        ? ((r.sampleCount ?? 0) * (r.confidence ?? 0)) / (r.sampleCount ?? 1)
        : 0,
      sampleCount: r.sampleCount ?? 0,
    }));
  
  const lowPerformers = activeRules
    .filter(r => (r.confidence ?? 0) < 0.4 && (r.sampleCount ?? 0) >= 5)
    .slice(0, 5)
    .map(r => ({
      name: r.name,
      confidence: r.confidence ?? 0,
      winRate: (r.sampleCount ?? 0) > 0 
        ? ((r.sampleCount ?? 0) * (r.confidence ?? 0)) / (r.sampleCount ?? 1)
        : 0,
      sampleCount: r.sampleCount ?? 0,
    }));
  
  // Get recent rule triggers from insights
  const recentTriggerInsights = await db.select()
    .from(systemInsights)
    .where(
      and(
        eq(systemInsights.sourceSystem, 'rule_executor'),
        eq(systemInsights.insightType, 'performance')
      )
    )
    .orderBy(desc(systemInsights.createdAt))
    .limit(10);
  
  const recentTriggers = recentTriggerInsights.map(i => ({
    ruleName: (i.payload as any)?.ruleName || 'Unknown',
    tokenMint: i.tokenMint || '',
    action: (i.payload as any)?.action || 'unknown',
    timestamp: i.createdAt,
  }));
  
  return { topPerformers, lowPerformers, recentTriggers };
}

export async function proposeRuleFromInsight(insight: SystemInsight): Promise<string | null> {
  const { createRule } = await import("./emergent-rules");
  
  const payload = insight.payload as Record<string, any>;
  
  // Only create rules from pattern or recommendation insights with high confidence
  if (insight.insightType !== 'pattern' && insight.insightType !== 'recommendation') {
    return null;
  }
  
  if ((insight.confidence ?? 0) < 0.6) {
    return null;
  }
  
  // Map pattern types to proper rule configurations
  let triggerConfig: { type: 'threshold' | 'interval' | 'event'; metric: string; threshold?: number; eventType?: string } | null = null;
  let actionConfig: { type: 'alert' | 'sell_percent' | 'sell_all' | 'adjust_stop' | 'add_position'; message?: string; percent?: number } | null = null;
  
  // Handle specific pattern types with proper defaults
  const patternType = payload.pattern || payload.signal;
  
  switch (patternType) {
    case 'hot_token':
      triggerConfig = {
        type: 'threshold',
        metric: 'heat_score',
        threshold: payload.heatScore || 70,
      };
      actionConfig = {
        type: 'alert',
        message: `Hot token: ${payload.topFactor || 'multiple factors'}`,
      };
      break;
      
    case 'discovery_trigger':
      triggerConfig = {
        type: 'event',
        metric: payload.signal || 'discovery',
        eventType: 'discovery_fired',
      };
      actionConfig = {
        type: 'alert',
        message: `Discovery: ${payload.triggerName || 'trigger fired'}`,
      };
      break;
      
    case 'whale_activity':
      triggerConfig = {
        type: 'event',
        metric: 'whale_activity',
        eventType: 'whale_detected',
      };
      actionConfig = {
        type: payload.actionType || 'alert',
        message: payload.recommendation || 'Whale activity detected',
        percent: payload.percent,
      };
      break;
      
    default:
      // For other patterns, require explicit metric and threshold
      if (!payload.metric || payload.threshold === undefined) {
        console.log(`[InsightBus] Skipping rule creation - pattern ${patternType} lacks required fields`);
        return null;
      }
      triggerConfig = {
        type: payload.triggerType || 'threshold',
        metric: payload.metric,
        threshold: payload.threshold,
      };
      actionConfig = {
        type: payload.actionType || 'alert',
        message: payload.recommendation || insight.title,
        percent: payload.percent,
      };
  }
  
  // Check if a similar rule already exists
  const existingRules = await db.select()
    .from(emergentRules)
    .where(
      and(
        eq(emergentRules.status, 'active'),
        sql`${emergentRules.triggerConfig}->>'metric' = ${triggerConfig.metric}`
      )
    )
    .limit(1);
  
  if (existingRules.length > 0) {
    return null; // Similar rule exists
  }
  
  // Create a new rule from the insight
  const newRule = await createRule({
    name: `Auto: ${insight.title}`,
    description: `Generated from ${insight.sourceSystem} insight: ${insight.title}. Ref: ${insight.insightId}`,
    triggerConfig,
    condition: payload.condition || undefined,
    actionConfig,
    origin: 'llm_insight',
    discoveredPattern: insight.insightId,
  });
  
  // Mark insight as consumed
  await markInsightConsumed(insight.insightId, 'rule_executor');
  
  console.log(`[InsightBus] Created rule ${newRule.ruleId} from insight ${insight.insightId}`);
  
  return newRule.ruleId;
}

async function checkPatternForRulePromotion(params: PublishInsightParams): Promise<void> {
  if (params.type !== 'pattern' && params.type !== 'recommendation') {
    return;
  }
  
  if ((params.confidence ?? 0) < 0.6) {
    return;
  }
  
  const payload = params.payload as Record<string, any>;
  const patternKey = payload.pattern || payload.signal || params.title;
  
  // Count similar patterns in last 7 days
  const weekAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);
  
  const similarPatterns = await db.select()
    .from(systemInsights)
    .where(
      and(
        eq(systemInsights.sourceSystem, params.source),
        eq(systemInsights.insightType, params.type),
        gte(systemInsights.createdAt, weekAgo),
        sql`${systemInsights.payload}->>'pattern' = ${patternKey}`
      )
    );
  
  // If we've seen this pattern 5+ times with high confidence, propose a rule
  if (similarPatterns.length >= 5) {
    const avgConfidence = similarPatterns.reduce((sum, p) => sum + (p.confidence ?? 0), 0) / similarPatterns.length;
    
    if (avgConfidence >= 0.6) {
      const latestInsight = similarPatterns[similarPatterns.length - 1];
      if (latestInsight) {
        await proposeRuleFromInsight(latestInsight);
      }
    }
  }
}

export async function proposeRuleFix(ruleId: string): Promise<string | null> {
  const rule = await db.select()
    .from(emergentRules)
    .where(eq(emergentRules.ruleId, ruleId))
    .limit(1);
  
  if (rule.length === 0) {
    return null;
  }
  
  const r = rule[0];
  
  // Publish an insight requesting AI help to fix this rule
  const insightId = await publishInsight({
    source: 'rule_executor',
    type: 'warning',
    title: `Rule "${r.name}" underperforming`,
    payload: {
      ruleId: r.ruleId,
      ruleName: r.name,
      currentConfidence: r.confidence,
      sampleCount: r.sampleCount,
      triggerConfig: r.triggerConfig,
      condition: r.condition,
      actionConfig: r.actionConfig,
      needsFix: true,
      suggestion: 'Consider modifying thresholds, conditions, or action type',
    },
    confidence: 0.8,
    expiresInHours: 48,
  });
  
  console.log(`[InsightBus] Published fix request for rule ${ruleId}`);
  
  return insightId;
}

export async function decayAndArchiveInsights(): Promise<{
  expired: number;
  archived: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  
  // Mark expired insights
  const expiredResult = await db.update(systemInsights)
    .set({ status: 'expired' })
    .where(
      and(
        eq(systemInsights.status, 'active'),
        lte(systemInsights.expiresAt, now)
      )
    );
  
  // Archive old consumed/expired insights (older than 30 days)
  const thirtyDaysAgo = now - (30 * 24 * 3600);
  const archivedResult = await db.update(systemInsights)
    .set({ status: 'archived' })
    .where(
      and(
        inArray(systemInsights.status, ['consumed', 'expired']),
        lte(systemInsights.createdAt, thirtyDaysAgo)
      )
    );
  
  // Decay confidence for insights that haven't been accessed
  const weekAgo = now - (7 * 24 * 3600);
  await db.update(systemInsights)
    .set({
      confidence: sql`GREATEST(0.1, ${systemInsights.confidence} * 0.9)`,
    })
    .where(
      and(
        eq(systemInsights.status, 'active'),
        or(
          isNull(systemInsights.lastAccessedAt),
          lte(systemInsights.lastAccessedAt, weekAgo)
        ),
        lte(systemInsights.createdAt, weekAgo)
      )
    );
  
  return {
    expired: 0, // expiredResult.rowCount || 0,
    archived: 0, // archivedResult.rowCount || 0,
  };
}

export async function buildContextForAI(params: {
  tokenMint?: string;
  walletAddress?: string;
  userId?: number;
}): Promise<{
  rulePerformance: Awaited<ReturnType<typeof getRulePerformanceContext>>;
  relevantInsights: SystemInsight[];
  summary: string;
}> {
  const [rulePerformance, relevantInsights] = await Promise.all([
    getRulePerformanceContext(),
    getInsightsForContext({
      tokenMint: params.tokenMint,
      walletAddress: params.walletAddress,
      userId: params.userId,
      minConfidence: 0.4,
      limit: 20,
    }),
  ]);
  
  // Build a summary string for AI context
  let summary = '';
  
  if (rulePerformance.topPerformers.length > 0) {
    summary += `Top performing rules: ${rulePerformance.topPerformers.map(r => 
      `${r.name} (${Math.round(r.confidence * 100)}% confidence)`
    ).join(', ')}. `;
  }
  
  if (rulePerformance.lowPerformers.length > 0) {
    summary += `Underperforming rules needing review: ${rulePerformance.lowPerformers.map(r => 
      r.name
    ).join(', ')}. `;
  }
  
  const patternInsights = relevantInsights.filter(i => i.insightType === 'pattern');
  if (patternInsights.length > 0) {
    summary += `Active patterns: ${patternInsights.slice(0, 3).map(i => i.title).join(', ')}. `;
  }
  
  const warningInsights = relevantInsights.filter(i => i.insightType === 'warning');
  if (warningInsights.length > 0) {
    summary += `Warnings: ${warningInsights.slice(0, 2).map(i => i.title).join(', ')}.`;
  }
  
  return {
    rulePerformance,
    relevantInsights,
    summary: summary.trim() || 'No active insights or patterns.',
  };
}
