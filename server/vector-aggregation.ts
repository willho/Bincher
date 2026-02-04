import { db } from "./db";
import { 
  vectorUpdates, 
  routeIntents, 
  strategyClusters,
  behaviorVectors,
  globalBaselines
} from "@shared/schema";
import { eq, and, sql, lt, inArray } from "drizzle-orm";
import OpenAI from "openai";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

const WEIGHTS = {
  trade_win: 3.0,
  trade_loss: 2.0,
  route_correction: 2.0,
  route_success: 1.0,
  chat_interaction: 1.0,
  passive_view: 0.5
};

function calculateDampening(sampleCount: number): number {
  return 1 / (1 + Math.log10(Math.max(1, sampleCount)));
}

function nudgeVector(
  current: number[],
  target: number[],
  learningRate: number,
  dampening: number
): number[] {
  if (current.length !== target.length) {
    return target;
  }
  
  return current.map((val, i) => {
    const delta = (target[i] - val) * learningRate * dampening;
    return val + delta;
  });
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await getOpenAI().embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 384
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("[VectorAggregation] Embedding failed:", err);
    return null;
  }
}

export async function processRouteIntentUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "route_intent"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));
  
  if (updates.length === 0) return 0;
  
  const updatesByIntent = new Map<string, typeof updates>();
  for (const update of updates) {
    const current = updatesByIntent.get(update.targetId) || [];
    current.push(update);
    updatesByIntent.set(update.targetId, current);
  }
  
  let processed = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const [intentName, intentUpdates] of Array.from(updatesByIntent.entries())) {
    const intent = await db.select()
      .from(routeIntents)
      .where(eq(routeIntents.intent, intentName))
      .limit(1);
    
    if (!intent[0]) continue;
    
    const currentVector = (intent[0].vector as number[]) || [];
    const hitCount = intent[0].hitCount || 0;
    const dampening = calculateDampening(hitCount);
    const learningRate = intent[0].learningRate || 0.1;
    
    const embeddings: number[][] = [];
    for (const update of intentUpdates) {
      const signalData = update.signalData as Record<string, any> | null;
      const messagePreview = signalData?.messagePreview;
      
      if (messagePreview && update.signalType === "route_correction") {
        const embedding = await getEmbedding(messagePreview);
        if (embedding) {
          embeddings.push(embedding);
        }
      }
    }
    
    if (embeddings.length > 0 && currentVector.length > 0) {
      const avgEmbedding = embeddings[0].map((_, i) => {
        const sum = embeddings.reduce((acc, emb) => acc + emb[i], 0);
        return sum / embeddings.length;
      });
      
      const newVector = nudgeVector(currentVector, avgEmbedding, learningRate, dampening);
      
      await db.update(routeIntents)
        .set({
          vector: newVector,
          updatedAt: now
        })
        .where(eq(routeIntents.intent, intentName));
    }
    
    processed += intentUpdates.length;
  }
  
  const updateIds = updates.map(u => u.id);
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(inArray(vectorUpdates.id, updateIds));
  
  return processed;
}

export async function processStrategyClusterUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "strategy"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));
  
  if (updates.length === 0) return 0;
  
  const updatesByCluster = new Map<string, typeof updates>();
  for (const update of updates) {
    const current = updatesByCluster.get(update.targetId) || [];
    current.push(update);
    updatesByCluster.set(update.targetId, current);
  }
  
  let processed = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const [clusterId, clusterUpdates] of Array.from(updatesByCluster.entries())) {
    const cluster = await db.select()
      .from(strategyClusters)
      .where(eq(strategyClusters.clusterId, clusterId))
      .limit(1);
    
    if (!cluster[0]) continue;
    
    const outcomes = cluster[0].outcomes as {
      totalTrades: number;
      wins: number;
      losses: number;
      avgPnlPercent: number;
      totalPnlSol: number;
      winRate: number;
      bestTrade: { token: string; pnlPercent: number; timestamp: number } | null;
      worstTrade: { token: string; pnlPercent: number; timestamp: number } | null;
    };
    
    for (const update of clusterUpdates) {
      const signalData = update.signalData as Record<string, any> | null;
      
      if (update.signalType === "trade_win") {
        outcomes.totalTrades++;
        outcomes.wins++;
        if (signalData?.pnlPercent) {
          const count = outcomes.totalTrades;
          outcomes.avgPnlPercent = ((outcomes.avgPnlPercent * (count - 1)) + signalData.pnlPercent) / count;
        }
        if (signalData?.pnlSol) {
          outcomes.totalPnlSol += signalData.pnlSol;
        }
        if (signalData?.pnlPercent && (!outcomes.bestTrade || signalData.pnlPercent > outcomes.bestTrade.pnlPercent)) {
          outcomes.bestTrade = {
            token: signalData.tokenMint || "unknown",
            pnlPercent: signalData.pnlPercent,
            timestamp: now
          };
        }
      } else if (update.signalType === "trade_loss") {
        outcomes.totalTrades++;
        outcomes.losses++;
        if (signalData?.pnlPercent) {
          const count = outcomes.totalTrades;
          outcomes.avgPnlPercent = ((outcomes.avgPnlPercent * (count - 1)) + signalData.pnlPercent) / count;
        }
        if (signalData?.pnlSol) {
          outcomes.totalPnlSol += signalData.pnlSol;
        }
        if (signalData?.pnlPercent && (!outcomes.worstTrade || signalData.pnlPercent < outcomes.worstTrade.pnlPercent)) {
          outcomes.worstTrade = {
            token: signalData.tokenMint || "unknown",
            pnlPercent: signalData.pnlPercent,
            timestamp: now
          };
        }
      }
    }
    
    outcomes.winRate = outcomes.totalTrades > 0 ? outcomes.wins / outcomes.totalTrades : 0;
    
    await db.update(strategyClusters)
      .set({
        outcomes,
        sampleSize: sql`${strategyClusters.sampleSize} + ${clusterUpdates.length}`,
        updatedAt: now
      })
      .where(eq(strategyClusters.clusterId, clusterId));
    
    processed += clusterUpdates.length;
  }
  
  const updateIds = updates.map(u => u.id);
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(inArray(vectorUpdates.id, updateIds));
  
  return processed;
}

export async function processBehaviorVectorUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "behavior"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));
  
  if (updates.length === 0) return 0;
  
  const updatesByUser = new Map<string, typeof updates>();
  for (const update of updates) {
    const current = updatesByUser.get(update.targetId) || [];
    current.push(update);
    updatesByUser.set(update.targetId, current);
  }
  
  let processed = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const [userIdStr, userUpdates] of Array.from(updatesByUser.entries())) {
    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) continue;
    
    const userVec = await db.select()
      .from(behaviorVectors)
      .where(eq(behaviorVectors.userId, userId))
      .limit(1);
    
    if (!userVec[0]) continue;
    
    let tradingCautionDelta = 0;
    let teasingDelta = 0;
    
    for (const update of userUpdates) {
      const weight = WEIGHTS[update.signalType as keyof typeof WEIGHTS] || 1.0;
      const signalData = update.signalData as Record<string, any> | null;
      
      if (update.signalType === "trade_win") {
        tradingCautionDelta -= 2 * weight;
      } else if (update.signalType === "trade_loss") {
        tradingCautionDelta += 3 * weight;
      }
      
      if (signalData?.laughEmoji || signalData?.playful) {
        teasingDelta += 1 * weight;
      }
    }
    
    const dampening = calculateDampening(userUpdates.length);
    tradingCautionDelta *= dampening;
    teasingDelta *= dampening;
    
    const newCaution = Math.max(0, Math.min(100, (userVec[0].tradingCautionLevel || 60) + tradingCautionDelta));
    const newTeasing = Math.max(0, Math.min(100, (userVec[0].teasingLevel || 40) + teasingDelta));
    
    await db.update(behaviorVectors)
      .set({
        tradingCautionLevel: Math.round(newCaution),
        teasingLevel: Math.round(newTeasing),
        updatedAt: now
      })
      .where(eq(behaviorVectors.userId, userId));
    
    processed += userUpdates.length;
  }
  
  const updateIds = updates.map(u => u.id);
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(inArray(vectorUpdates.id, updateIds));
  
  return processed;
}

export async function updateGlobalBaseline(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const vectors = await db.select({
    slangLevel: behaviorVectors.slangLevel,
    crabHintLevel: behaviorVectors.crabHintLevel,
    teasingLevel: behaviorVectors.teasingLevel,
    proactivityLevel: behaviorVectors.proactivityLevel,
    culturalRefLevel: behaviorVectors.culturalRefLevel,
    tradingCautionLevel: behaviorVectors.tradingCautionLevel
  }).from(behaviorVectors);
  
  if (vectors.length === 0) return;
  
  const avgVector = {
    slangLevel: Math.round(vectors.reduce((s, v) => s + (v.slangLevel || 50), 0) / vectors.length),
    crabHintLevel: Math.round(vectors.reduce((s, v) => s + (v.crabHintLevel || 30), 0) / vectors.length),
    teasingLevel: Math.round(vectors.reduce((s, v) => s + (v.teasingLevel || 40), 0) / vectors.length),
    proactivityLevel: Math.round(vectors.reduce((s, v) => s + (v.proactivityLevel || 50), 0) / vectors.length),
    culturalRefLevel: Math.round(vectors.reduce((s, v) => s + (v.culturalRefLevel || 40), 0) / vectors.length),
    tradingCautionLevel: Math.round(vectors.reduce((s, v) => s + (v.tradingCautionLevel || 60), 0) / vectors.length)
  };
  
  const baseline = await db.select()
    .from(globalBaselines)
    .where(eq(globalBaselines.baselineType, "personality"))
    .limit(1);
  
  const dampening = calculateDampening(baseline[0]?.sampleCount || 0);
  
  if (baseline[0]) {
    const blended = {
      slangLevel: Math.round(baseline[0].slangLevel! + (avgVector.slangLevel - baseline[0].slangLevel!) * dampening),
      crabHintLevel: Math.round(baseline[0].crabHintLevel! + (avgVector.crabHintLevel - baseline[0].crabHintLevel!) * dampening),
      teasingLevel: Math.round(baseline[0].teasingLevel! + (avgVector.teasingLevel - baseline[0].teasingLevel!) * dampening),
      proactivityLevel: Math.round(baseline[0].proactivityLevel! + (avgVector.proactivityLevel - baseline[0].proactivityLevel!) * dampening),
      culturalRefLevel: Math.round(baseline[0].culturalRefLevel! + (avgVector.culturalRefLevel - baseline[0].culturalRefLevel!) * dampening),
      tradingCautionLevel: Math.round(baseline[0].tradingCautionLevel! + (avgVector.tradingCautionLevel - baseline[0].tradingCautionLevel!) * dampening)
    };
    
    await db.update(globalBaselines)
      .set({
        ...blended,
        sampleCount: vectors.length,
        lastAggregation: now,
        version: sql`${globalBaselines.version} + 1`,
        updatedAt: now
      })
      .where(eq(globalBaselines.baselineType, "personality"));
  } else {
    await db.insert(globalBaselines).values({
      baselineType: "personality",
      ...avgVector,
      sampleCount: vectors.length,
      lastAggregation: now,
      version: 1,
      createdAt: now,
      updatedAt: now
    });
  }
  
  console.log(`[VectorAggregation] Updated global baseline from ${vectors.length} users`);
}

export async function run8HourAggregation(): Promise<{
  routeUpdates: number;
  strategyUpdates: number;
  behaviorUpdates: number;
  baselineUpdated: boolean;
}> {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  const previousBucket = bucket === "00" ? "16" : bucket === "08" ? "00" : "08";
  
  const yesterday = new Date(now);
  if (bucket === "00") {
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  }
  const bucketDate = bucket === "00" 
    ? yesterday.toISOString().slice(0, 10)
    : now.toISOString().slice(0, 10);
  const bucketId = `${bucketDate}-${previousBucket}`;
  
  console.log(`[VectorAggregation] Processing bucket: ${bucketId}`);
  
  const [routeUpdates, strategyUpdates, behaviorUpdates] = await Promise.all([
    processRouteIntentUpdates(bucketId),
    processStrategyClusterUpdates(bucketId),
    processBehaviorVectorUpdates(bucketId)
  ]);
  
  let discoveryUpdates = 0;
  try {
    const { processDiscoverySourceUpdates, adjustExploreRatio, pruneUnderperformingVectors } = await import("./discovery-engine");
    discoveryUpdates = await processDiscoverySourceUpdates(bucketId);
    await adjustExploreRatio();
    await pruneUnderperformingVectors();
  } catch (err) {
    console.error("[VectorAggregation] Discovery processing failed:", err);
  }
  
  let heatFactorUpdates = 0;
  try {
    const { processHeatFactorUpdates } = await import("./heat-score");
    heatFactorUpdates = await processHeatFactorUpdates(bucketId);
  } catch (err) {
    console.error("[VectorAggregation] Heat factor processing failed:", err);
  }
  
  let metaInsights = { correlationsFound: 0, experimentsProposed: 0, experimentsConcluded: 0 };
  try {
    const { processMetaInsights } = await import("./meta-optimizer");
    metaInsights = await processMetaInsights(bucketId);
    console.log(`[VectorAggregation] Meta-optimizer: correlations=${metaInsights.correlationsFound}, experiments=${metaInsights.experimentsProposed}, concluded=${metaInsights.experimentsConcluded}`);
  } catch (err) {
    console.error("[VectorAggregation] Meta-optimizer processing failed:", err);
  }
  
  let rulesPromoted: string[] = [];
  let ruleExecutionStats = { positionsEvaluated: 0, rulesTriggered: 0, actionsExecuted: 0 };
  try {
    const { evaluateRulePromotion, initializePresetRules } = await import("./emergent-rules");
    await initializePresetRules();
    rulesPromoted = await evaluateRulePromotion();
    if (rulesPromoted.length > 0) {
      console.log(`[VectorAggregation] Rules promoted: ${rulesPromoted.join(", ")}`);
    }
    
    const { runRuleEvaluationCycle, recordClosedPositionOutcomes } = await import("./rule-executor");
    ruleExecutionStats = await runRuleEvaluationCycle();
    const outcomesRecorded = await recordClosedPositionOutcomes();
    if (outcomesRecorded > 0) {
      console.log(`[VectorAggregation] Recorded ${outcomesRecorded} rule outcomes`);
    }
  } catch (err) {
    console.error("[VectorAggregation] Rule evaluation failed:", err);
  }
  
  await updateGlobalBaseline();
  
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);
  await db.delete(vectorUpdates)
    .where(and(
      eq(vectorUpdates.processed, true),
      lt(vectorUpdates.createdAt, sevenDaysAgo)
    ));
  
  // Decay and archive old insights
  let insightStats = { expired: 0, archived: 0 };
  try {
    const { decayAndArchiveInsights } = await import("./insight-bus");
    insightStats = await decayAndArchiveInsights();
    if (insightStats.expired > 0 || insightStats.archived > 0) {
      console.log(`[VectorAggregation] Insights: expired=${insightStats.expired}, archived=${insightStats.archived}`);
    }
  } catch (err) {
    console.error("[VectorAggregation] Insight decay failed:", err);
  }
  
  console.log(`[VectorAggregation] Processed: routes=${routeUpdates}, strategies=${strategyUpdates}, behavior=${behaviorUpdates}, discovery=${discoveryUpdates}, heat=${heatFactorUpdates}`);
  
  return {
    routeUpdates,
    strategyUpdates,
    behaviorUpdates,
    baselineUpdated: true
  };
}

export function getCurrentBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

export function shouldRunAggregation(): boolean {
  const hour = new Date().getUTCHours();
  return hour === 0 || hour === 8 || hour === 16;
}
