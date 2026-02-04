import { db } from "./db";
import { paperPositions, holdings, PaperPosition } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { 
  getActiveRules, getTestingRules, evaluateRule, recordRuleOutcome,
  RuleContext, ActionConfig
} from "./emergent-rules";
import { logSystemEvent, createCorrelationId } from "./system-events";
import { fetchTokenWithFallback } from "./data-pool";
import { getHoldersCached } from "./price-aggregator";

interface RuleExecutionResult {
  ruleId: string;
  ruleName: string;
  positionId: number;
  actionTaken: ActionConfig | null;
  executed: boolean;
  reason?: string;
}

async function buildRuleContext(position: PaperPosition): Promise<RuleContext> {
  const tokenData = await fetchTokenWithFallback(position.tokenMint);
  const currentPrice = tokenData.priceUsd || position.entryPrice;
  const entryPrice = position.entryPrice;
  const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
  
  const now = Math.floor(Date.now() / 1000);
  const holdingMinutes = (now - position.entryTimestamp) / 60;
  
  let whaleActivity = 0;
  let topHolderPercent = 0;
  let heatScore = 50;
  let volumeChangePercent = 0;
  let priceChangePercent = 0;
  
  try {
    const holdersData = await getHoldersCached(position.tokenMint);
    const holders = holdersData?.holders || [];
    if (Array.isArray(holders) && holders.length > 0) {
      const topHolder = holders[0] as { uiAmount?: number };
      const totalAmount = holders.reduce((s: number, h: any) => s + (h.uiAmount || 0), 0);
      topHolderPercent = (topHolder.uiAmount || 0) / (totalAmount || 1) * 100;
    }
  } catch (err) {
    // Ignore holder data errors
  }
  
  try {
    const { calculateTokenHeat } = await import("./heat-score");
    const heatData = await calculateTokenHeat(position.tokenMint);
    heatScore = heatData.heatScore;
    whaleActivity = heatData.factors.whaleActivity > 50 ? 1 : 0;
  } catch (err) {
    // Ignore heat errors
  }
  
  // Calculate price change from token data
  priceChangePercent = tokenData.priceChange24h || 0;
  
  // Estimate volume change (simplified - would need historical data for accuracy)
  const volume24h = tokenData.volume24h || 0;
  volumeChangePercent = volume24h > 0 ? 0 : -100; // Basic: if no volume, assume dropped
  
  return {
    tokenMint: position.tokenMint,
    positionId: position.id,
    userId: position.userId,
    currentPrice,
    entryPrice,
    currentPnlPercent: pnlPercent,
    holdingDurationMinutes: holdingMinutes,
    whaleActivityLast1h: whaleActivity,
    volumeChangePercent,
    priceChangePercent,
    topHolderPercent,
    heatScore,
  };
}

async function executePaperAction(
  position: PaperPosition,
  action: ActionConfig,
  ruleId: string
): Promise<{ executed: boolean; reason?: string }> {
  const now = Math.floor(Date.now() / 1000);
  
  switch (action.type) {
    case 'sell_percent': {
      const percent = action.percent || 25;
      const tokensToSell = position.entryTokens * (percent / 100);
      const remainingTokens = position.entryTokens - tokensToSell;
      
      if (remainingTokens <= 0) {
        await db.update(paperPositions)
          .set({
            status: 'closed',
            exitReason: `rule:${ruleId}:sell_percent`,
            exitTimestamp: now,
            updatedAt: now,
          })
          .where(eq(paperPositions.id, position.id));
      } else {
        await db.update(paperPositions)
          .set({
            entryTokens: remainingTokens,
            updatedAt: now,
          })
          .where(eq(paperPositions.id, position.id));
        console.log(`[RuleExecutor] Sold ${percent}% of position ${position.id} via rule ${ruleId}`);
      }
      
      return { executed: true };
    }
    
    case 'sell_all': {
      await db.update(paperPositions)
        .set({
          status: 'closed',
          exitReason: `rule:${ruleId}:sell_all`,
          exitTimestamp: now,
          updatedAt: now,
        })
        .where(eq(paperPositions.id, position.id));
      
      return { executed: true };
    }
    
    case 'adjust_stop': {
      const newStopLoss = action.stopLossPercent ? action.stopLossPercent / 100 : 0.2;
      
      await db.update(paperPositions)
        .set({
          stopLossPercent: newStopLoss,
          updatedAt: now,
        })
        .where(eq(paperPositions.id, position.id));
      
      return { executed: true };
    }
    
    case 'alert': {
      console.log(`[RuleExecutor] Alert for position ${position.id}: ${action.message || 'Rule triggered'}`);
      return { executed: true, reason: 'Alert logged' };
    }
    
    case 'add_position': {
      console.log(`[RuleExecutor] Add position action not supported for paper trading`);
      return { executed: false, reason: 'Add position not supported in paper mode' };
    }
    
    default:
      return { executed: false, reason: `Unknown action type` };
  }
}

export async function evaluateRulesForPosition(
  position: PaperPosition,
  paperOnly: boolean = true
): Promise<RuleExecutionResult[]> {
  const results: RuleExecutionResult[] = [];
  
  const rules = paperOnly 
    ? await getTestingRules()
    : await getActiveRules(false);
  
  const context = await buildRuleContext(position);
  
  for (const rule of rules) {
    try {
      const { shouldAct, action } = await evaluateRule(rule, context);
      
      if (shouldAct && action) {
        const correlationId = createCorrelationId();
        
        await logSystemEvent({
          eventType: 'rule_triggered',
          sourceSystem: 'meta_optimizer',
          targetSystem: 'paper_trading',
          tokenMint: position.tokenMint,
          positionId: position.id,
          userId: position.userId,
          correlationId,
          payload: {
            ruleId: rule.ruleId,
            ruleName: rule.name,
            actionType: action.type,
            context: {
              pnlPercent: context.currentPnlPercent,
              holdingMinutes: context.holdingDurationMinutes,
            },
          },
        });
        
        const { executed, reason } = await executePaperAction(position, action, rule.ruleId);
        
        if (executed) {
          await logSystemEvent({
            eventType: 'rule_action_taken',
            sourceSystem: 'paper_trading',
            tokenMint: position.tokenMint,
            positionId: position.id,
            correlationId,
            payload: {
              ruleId: rule.ruleId,
              actionType: action.type,
              executed,
              reason,
            },
          });
        }
        
        results.push({
          ruleId: rule.ruleId,
          ruleName: rule.name,
          positionId: position.id,
          actionTaken: action,
          executed,
          reason,
        });
      }
    } catch (err) {
      console.error(`[RuleExecutor] Error evaluating rule ${rule.ruleId}:`, err);
    }
  }
  
  return results;
}

export async function runRuleEvaluationCycle(): Promise<{
  positionsEvaluated: number;
  rulesTriggered: number;
  actionsExecuted: number;
}> {
  const openPositions = await db.select()
    .from(paperPositions)
    .where(eq(paperPositions.status, 'open'));
  
  let rulesTriggered = 0;
  let actionsExecuted = 0;
  
  for (const position of openPositions) {
    const results = await evaluateRulesForPosition(position, true);
    rulesTriggered += results.length;
    actionsExecuted += results.filter(r => r.executed).length;
  }
  
  if (rulesTriggered > 0) {
    console.log(`[RuleExecutor] Cycle complete: ${openPositions.length} positions, ${rulesTriggered} rules triggered, ${actionsExecuted} actions executed`);
  }
  
  return {
    positionsEvaluated: openPositions.length,
    rulesTriggered,
    actionsExecuted,
  };
}

export async function recordClosedPositionOutcomes(): Promise<number> {
  const recentlyClosed = await db.select()
    .from(paperPositions)
    .where(and(
      eq(paperPositions.status, 'closed'),
      sql`${paperPositions.exitReason} LIKE 'rule:%'`
    ));
  
  let recorded = 0;
  
  for (const position of recentlyClosed) {
    if (!position.exitReason) continue;
    
    const ruleIdMatch = position.exitReason.match(/^rule:([^:]+):/);
    if (!ruleIdMatch) continue;
    
    const ruleId = ruleIdMatch[1];
    const pnl = position.realizedPnl || 0;
    const isWin = pnl > 0;
    
    await recordRuleOutcome(ruleId, isWin, pnl);
    recorded++;
  }
  
  return recorded;
}

export async function executeEventTriggeredRule(
  rule: { ruleId: string; name: string; paperOnly?: boolean | null },
  tokenMint: string,
  action: { type: string; percent?: number; stopLossPercent?: number; message?: string }
): Promise<{ executed: boolean; positionsAffected: number }> {
  // Find all open positions for this token
  const positions = await db.select()
    .from(paperPositions)
    .where(and(
      eq(paperPositions.tokenMint, tokenMint),
      eq(paperPositions.status, 'open')
    ));
  
  if (positions.length === 0) {
    return { executed: false, positionsAffected: 0 };
  }
  
  let positionsAffected = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const position of positions) {
    try {
      switch (action.type) {
        case 'sell_percent': {
          const percent = action.percent || 25;
          const tokensToSell = position.entryTokens * (percent / 100);
          const remainingTokens = position.entryTokens - tokensToSell;
          
          if (remainingTokens <= 0) {
            await db.update(paperPositions)
              .set({
                status: 'closed',
                exitReason: `rule:${rule.ruleId}:event_sell`,
                exitTimestamp: now,
                updatedAt: now,
              })
              .where(eq(paperPositions.id, position.id));
          } else {
            await db.update(paperPositions)
              .set({
                entryTokens: remainingTokens,
                updatedAt: now,
              })
              .where(eq(paperPositions.id, position.id));
          }
          positionsAffected++;
          break;
        }
        
        case 'sell_all': {
          await db.update(paperPositions)
            .set({
              status: 'closed',
              exitReason: `rule:${rule.ruleId}:event_sell_all`,
              exitTimestamp: now,
              updatedAt: now,
            })
            .where(eq(paperPositions.id, position.id));
          positionsAffected++;
          break;
        }
        
        case 'adjust_stop': {
          const newStopLoss = action.stopLossPercent ? action.stopLossPercent / 100 : 0.2;
          await db.update(paperPositions)
            .set({
              stopLossPercent: newStopLoss,
              updatedAt: now,
            })
            .where(eq(paperPositions.id, position.id));
          positionsAffected++;
          break;
        }
        
        case 'alert': {
          console.log(`[RuleExecutor] Event alert for position ${position.id}: ${action.message || rule.name}`);
          positionsAffected++;
          break;
        }
      }
    } catch (err) {
      console.error(`[RuleExecutor] Failed to execute event rule on position ${position.id}:`, err);
    }
  }
  
  console.log(`[RuleExecutor] Event rule ${rule.name} affected ${positionsAffected} positions for token ${tokenMint}`);
  
  return { executed: positionsAffected > 0, positionsAffected };
}
