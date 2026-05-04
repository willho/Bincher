import { db } from "./db";
import { 
  systemEvents, systemCorrelations, metaExperiments,
  SystemEvent, SystemCorrelation, MetaExperiment,
  InsertSystemCorrelation, InsertMetaExperiment
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { 
  getEventsByBucket, getEventsWithOutcomes, 
  getEventStatsByBucket, findEventCooccurrences 
} from "./system-events";

interface CorrelationCandidate {
  sourceEventType: string;
  sourceSystem: string;
  targetEventType: string;
  targetSystem: string;
  conditions: Array<{ metric: string; operator: string; value: number | string }>;
  occurrenceCount: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  avgPnlWhenPresent: number;
}

export async function analyzeSystemInteractions(bucketId: string): Promise<CorrelationCandidate[]> {
  const events = await getEventsByBucket(bucketId);
  const eventsWithOutcomes = events.filter(e => e.outcomeType !== null);
  
  const candidates: CorrelationCandidate[] = [];
  const eventsByToken = new Map<string, SystemEvent[]>();
  
  for (const event of events) {
    if (!event.tokenMint) continue;
    if (!eventsByToken.has(event.tokenMint)) {
      eventsByToken.set(event.tokenMint, []);
    }
    eventsByToken.get(event.tokenMint)!.push(event);
  }
  
  const pairCounts = new Map<string, {
    count: number;
    wins: number;
    losses: number;
    totalPnl: number;
    sourceSystem: string;
    targetSystem: string;
    sourceEventType: string;
    targetEventType: string;
  }>();
  
  Array.from(eventsByToken.entries()).forEach(([_tokenMint, tokenEvents]) => {
    const sorted = tokenEvents.sort((a: SystemEvent, b: SystemEvent) => a.timestamp - b.timestamp);
    
    for (let i = 0; i < sorted.length; i++) {
      const source = sorted[i];
      
      for (let j = i + 1; j < sorted.length; j++) {
        const target = sorted[j];
        
        if (target.timestamp - source.timestamp > 3600) break;
        if (source.sourceSystem === target.sourceSystem) continue;
        
        const key = `${source.eventType}:${source.sourceSystem}->${target.eventType}:${target.sourceSystem}`;
        
        if (!pairCounts.has(key)) {
          pairCounts.set(key, {
            count: 0,
            wins: 0,
            losses: 0,
            totalPnl: 0,
            sourceSystem: source.sourceSystem,
            targetSystem: target.sourceSystem,
            sourceEventType: source.eventType,
            targetEventType: target.eventType,
          });
        }
        
        const pair = pairCounts.get(key)!;
        pair.count++;
        
        if (target.outcomeType === 'win') {
          pair.wins++;
          pair.totalPnl += target.outcomePnl || 0;
        } else if (target.outcomeType === 'loss') {
          pair.losses++;
          pair.totalPnl += target.outcomePnl || 0;
        }
      }
    }
  });
  
  Array.from(pairCounts.entries()).forEach(([_key, pair]) => {
    if (pair.count >= 5) {
      candidates.push({
        sourceEventType: pair.sourceEventType,
        sourceSystem: pair.sourceSystem,
        targetEventType: pair.targetEventType,
        targetSystem: pair.targetSystem,
        conditions: [],
        occurrenceCount: pair.count,
        positiveOutcomes: pair.wins,
        negativeOutcomes: pair.losses,
        avgPnlWhenPresent: pair.count > 0 ? pair.totalPnl / pair.count : 0,
      });
    }
  });
  
  return candidates.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

export async function discoverCorrelations(bucketId: string): Promise<SystemCorrelation[]> {
  const candidates = await analyzeSystemInteractions(bucketId);
  const now = Math.floor(Date.now() / 1000);
  const newCorrelations: SystemCorrelation[] = [];
  
  for (const candidate of candidates) {
    if (candidate.occurrenceCount < 5) continue;
    
    const winRate = candidate.positiveOutcomes / (candidate.positiveOutcomes + candidate.negativeOutcomes || 1);
    const correlationStrength = (winRate - 0.5) * 2;
    
    const [existing] = await db.select()
      .from(systemCorrelations)
      .where(and(
        eq(systemCorrelations.sourceEventType, candidate.sourceEventType),
        eq(systemCorrelations.sourceSystem, candidate.sourceSystem),
        eq(systemCorrelations.targetEventType, candidate.targetEventType),
        eq(systemCorrelations.targetSystem, candidate.targetSystem)
      ))
      .limit(1);
    
    if (existing) {
      await db.update(systemCorrelations)
        .set({
          occurrenceCount: existing.occurrenceCount! + candidate.occurrenceCount,
          positiveOutcomes: existing.positiveOutcomes! + candidate.positiveOutcomes,
          negativeOutcomes: existing.negativeOutcomes! + candidate.negativeOutcomes,
          correlationStrength,
          avgPnlWhenPresent: candidate.avgPnlWhenPresent,
          lastUpdatedAt: now,
          lastSeenAt: now,
          status: Math.abs(correlationStrength) > 0.3 ? 'significant' : 'tracking',
        })
        .where(eq(systemCorrelations.id, existing.id));
      
      const [updated] = await db.select().from(systemCorrelations)
        .where(eq(systemCorrelations.id, existing.id));
      if (updated) newCorrelations.push(updated);
    } else {
      const correlationId = nanoid();
      const insert: InsertSystemCorrelation = {
        correlationId,
        sourceEventType: candidate.sourceEventType,
        sourceSystem: candidate.sourceSystem,
        targetEventType: candidate.targetEventType,
        targetSystem: candidate.targetSystem,
        conditions: candidate.conditions,
        occurrenceCount: candidate.occurrenceCount,
        correlationStrength,
        positiveOutcomes: candidate.positiveOutcomes,
        negativeOutcomes: candidate.negativeOutcomes,
        avgPnlWhenPresent: candidate.avgPnlWhenPresent,
        status: Math.abs(correlationStrength) > 0.3 ? 'significant' : 'tracking',
        discoveredAt: now,
        lastUpdatedAt: now,
        lastSeenAt: now,
      };
      
      await db.insert(systemCorrelations).values(insert);
      const [created] = await db.select().from(systemCorrelations)
        .where(eq(systemCorrelations.correlationId, correlationId));
      if (created) newCorrelations.push(created);
    }
  }
  
  return newCorrelations;
}

export async function getSignificantCorrelations(): Promise<SystemCorrelation[]> {
  return await db.select()
    .from(systemCorrelations)
    .where(eq(systemCorrelations.status, 'significant'))
    .orderBy(desc(sql`abs(${systemCorrelations.correlationStrength})`));
}

export async function getActionableInsights(): Promise<SystemCorrelation[]> {
  return await db.select()
    .from(systemCorrelations)
    .where(eq(systemCorrelations.status, 'actionable'))
    .orderBy(desc(systemCorrelations.correlationStrength));
}

interface SystemTuningProposal {
  hypothesis: string;
  targetSystems: string[];
  controlConfig: Record<string, any>;
  variantConfig: Record<string, any>;
  basedOnCorrelation?: string;
}

export async function proposeSystemTuning(
  correlation: SystemCorrelation
): Promise<SystemTuningProposal | null> {
  if (Math.abs(correlation.correlationStrength || 0) < 0.2) return null;
  
  const isPositive = (correlation.correlationStrength || 0) > 0;
  
  const tuningRules: Record<string, (isPositive: boolean) => SystemTuningProposal | null> = {
    'discovery_fired->heat_calculated': (pos) => ({
      hypothesis: pos 
        ? 'Discovery events with immediate heat calculation have better outcomes - reduce heat calculation delay'
        : 'Discovery events rushed to heat calculation have worse outcomes - add delay before heat calc',
      targetSystems: ['discovery', 'heat_score'],
      controlConfig: { heatCalcDelayMs: 0 },
      variantConfig: { heatCalcDelayMs: pos ? 0 : 5000 },
    }),
    
    'whale_detected->copy_executed': (pos) => ({
      hypothesis: pos
        ? 'Copy trades following whale detection succeed - increase whale event weight'
        : 'Copy trades after whale detection underperform - add delay or reduce whale weight',
      targetSystems: ['whale_detection', 'copy_trading'],
      controlConfig: { whaleWeight: 0.2, copyDelayAfterWhale: 0 },
      variantConfig: { whaleWeight: pos ? 0.3 : 0.1, copyDelayAfterWhale: pos ? 0 : 30 },
    }),
    
    'ai_recommendation->trade_opened': (pos) => ({
      hypothesis: pos
        ? 'AI recommendations leading to trades succeed - increase AI confidence threshold requirement'
        : 'AI recommendations leading to trades underperform - require higher AI confidence',
      targetSystems: ['ai_chat', 'copy_trading'],
      controlConfig: { aiConfidenceThreshold: 0.5 },
      variantConfig: { aiConfidenceThreshold: pos ? 0.5 : 0.7 },
    }),
  };
  
  const key = `${correlation.sourceEventType}->${correlation.targetEventType}`;
  const tuningFn = tuningRules[key];
  
  if (tuningFn) {
    const proposal = tuningFn(isPositive);
    if (proposal) {
      proposal.basedOnCorrelation = correlation.correlationId;
      return proposal;
    }
  }
  
  return null;
}

export async function createExperiment(proposal: SystemTuningProposal): Promise<MetaExperiment> {
  const now = Math.floor(Date.now() / 1000);
  const experimentId = nanoid();
  
  const insert: InsertMetaExperiment = {
    experimentId,
    name: `Auto: ${proposal.hypothesis.substring(0, 50)}...`,
    hypothesis: proposal.hypothesis,
    experimentType: 'parameter_tuning',
    targetSystems: proposal.targetSystems,
    controlConfig: proposal.controlConfig,
    variantConfig: proposal.variantConfig,
    assignmentRatio: 0.5,
    status: 'active',
    startedAt: now,
    endsAt: now + (7 * 24 * 60 * 60),
    createdBy: 'system',
  };
  
  await db.insert(metaExperiments).values(insert);
  
  const [created] = await db.select().from(metaExperiments)
    .where(eq(metaExperiments.experimentId, experimentId));
  
  return created;
}

export async function getActiveExperiments(): Promise<MetaExperiment[]> {
  return await db.select()
    .from(metaExperiments)
    .where(eq(metaExperiments.status, 'active'));
}

export async function assignToExperiment(
  experimentId: string,
  tradeId: string
): Promise<'control' | 'variant'> {
  const hash = tradeId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  const [experiment] = await db.select().from(metaExperiments)
    .where(eq(metaExperiments.experimentId, experimentId));
  
  if (!experiment) return 'control';
  
  const assignmentRatio = experiment.assignmentRatio || 0.5;
  return (hash % 100) / 100 < assignmentRatio ? 'variant' : 'control';
}

export async function recordExperimentOutcome(
  experimentId: string,
  group: 'control' | 'variant',
  isWin: boolean,
  pnl: number
): Promise<void> {
  const [experiment] = await db.select().from(metaExperiments)
    .where(eq(metaExperiments.experimentId, experimentId));
  
  if (!experiment) return;
  
  if (group === 'control') {
    const newTrades = (experiment.controlTrades || 0) + 1;
    const newWins = isWin ? ((experiment.controlWinRate || 0) * (experiment.controlTrades || 0) + 1) : ((experiment.controlWinRate || 0) * (experiment.controlTrades || 0));
    
    await db.update(metaExperiments)
      .set({
        controlTrades: newTrades,
        controlWinRate: newWins / newTrades,
        controlPnl: (experiment.controlPnl || 0) + pnl,
      })
      .where(eq(metaExperiments.experimentId, experimentId));
  } else {
    const newTrades = (experiment.variantTrades || 0) + 1;
    const newWins = isWin ? ((experiment.variantWinRate || 0) * (experiment.variantTrades || 0) + 1) : ((experiment.variantWinRate || 0) * (experiment.variantTrades || 0));
    
    await db.update(metaExperiments)
      .set({
        variantTrades: newTrades,
        variantWinRate: newWins / newTrades,
        variantPnl: (experiment.variantPnl || 0) + pnl,
      })
      .where(eq(metaExperiments.experimentId, experimentId));
  }
}

export async function evaluateExperiments(): Promise<MetaExperiment[]> {
  const active = await getActiveExperiments();
  const now = Math.floor(Date.now() / 1000);
  const concluded: MetaExperiment[] = [];
  
  for (const experiment of active) {
    const totalTrades = (experiment.controlTrades || 0) + (experiment.variantTrades || 0);
    const minSample = experiment.minSampleSize || 20;
    
    if (totalTrades < minSample) continue;
    
    const controlWR = experiment.controlWinRate || 0;
    const variantWR = experiment.variantWinRate || 0;
    const diff = variantWR - controlWR;
    
    let winner: string | null = null;
    let confidenceLevel = 0;
    
    if (Math.abs(diff) > 0.1 && totalTrades >= minSample * 2) {
      winner = diff > 0 ? 'variant' : 'control';
      confidenceLevel = Math.min(0.95, 0.5 + Math.abs(diff) * 2);
    } else if (experiment.endsAt && now > experiment.endsAt) {
      winner = 'inconclusive';
      confidenceLevel = 0.5;
    }
    
    if (winner) {
      await db.update(metaExperiments)
        .set({
          status: 'completed',
          winner,
          confidenceLevel,
          completedAt: now,
          promotedConfig: winner === 'variant' ? experiment.variantConfig : 
                         winner === 'control' ? experiment.controlConfig : null,
        })
        .where(eq(metaExperiments.experimentId, experiment.experimentId));
      
      const [updated] = await db.select().from(metaExperiments)
        .where(eq(metaExperiments.experimentId, experiment.experimentId));
      if (updated) concluded.push(updated);
    }
  }
  
  return concluded;
}

export async function processMetaInsights(bucketId: string): Promise<{
  correlationsFound: number;
  experimentsProposed: number;
  experimentsConcluded: number;
}> {
  const correlations = await discoverCorrelations(bucketId);
  
  let experimentsProposed = 0;
  for (const corr of correlations) {
    if (corr.status !== 'significant') continue;
    
    const existingExperiments = await db.select().from(metaExperiments)
      .where(and(
        eq(metaExperiments.status, 'active'),
        sql`${metaExperiments.controlConfig}->>'basedOnCorrelation' = ${corr.correlationId}`
      ));
    
    if (existingExperiments.length > 0) continue;
    
    const proposal = await proposeSystemTuning(corr);
    if (proposal) {
      await createExperiment(proposal);
      experimentsProposed++;
    }
  }
  
  const concluded = await evaluateExperiments();
  
  return {
    correlationsFound: correlations.length,
    experimentsProposed,
    experimentsConcluded: concluded.length,
  };
}
