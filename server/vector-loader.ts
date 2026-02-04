import { db } from "./db";
import { 
  behaviorVectors, 
  memoryClusters, 
  globalBaselines,
  userRelationships,
  strategyClusters,
  walletFingerprints,
  tokenDataPool
} from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import type { RouteResult } from "./vector-router";

export interface LoadedVectors {
  personality?: {
    baseline: Record<string, number>;
    userAdjustments: Record<string, number>;
    effective: Record<string, number>;
  };
  relationship?: {
    affinity: number;
    type: string;
    dimensions: Record<string, number>;
    memorableEvents: any[];
  };
  safety?: {
    rugcheckScore: number | null;
    goplusRisks: string[];
    isSafe: boolean;
    lastChecked: number | null;
  };
  behavior?: {
    leaderCount: number;
    followerCount: number;
    copytradeWindow: number | null;
    crowdingRisk: number | null;
  };
  fingerprint?: {
    walletAddress: string;
    behaviorType: string;
    tradingStyle: string;
    winRate: number;
    avgHoldTime: number;
    playbookScore: number;
  }[];
  strategy?: {
    clusterId: string;
    pattern: string;
    walletCount: number;
    winRate: number;
    avgPnl: number;
  }[];
  memory?: {
    topics: string[];
    preferences: Record<string, any>;
  };
}

export async function loadVectorsForRoute(
  routeResult: RouteResult,
  userId: number,
  tokenMint?: string,
  walletAddress?: string
): Promise<LoadedVectors> {
  const vectors: LoadedVectors = {};
  const needs = new Set(routeResult.vectorNeeds);
  
  const loadPromises: Promise<void>[] = [];
  
  // Only load personality/relationship for chat-based intents that need communication style
  // Trading AI and safety checks don't need personality vectors
  const needsPersonality = needs.has("personality") || needs.has("full") || 
    routeResult.intent === "advice" || routeResult.intent === "chat" ||
    routeResult.intent === "unknown" || routeResult.tier >= 3;
  
  if (needsPersonality) {
    loadPromises.push(loadPersonalityVectors(userId, vectors));
    loadPromises.push(loadRelationshipVectors(userId, vectors));
  }
  
  if (needs.has("safety") && tokenMint) {
    loadPromises.push(loadSafetyVectors(tokenMint, vectors));
  }
  
  if (needs.has("behavior") && tokenMint) {
    loadPromises.push(loadBehaviorVectors(tokenMint, vectors));
  }
  
  if (needs.has("fingerprint")) {
    loadPromises.push(loadFingerprintVectors(walletAddress, vectors));
  }
  
  if (needs.has("strategy")) {
    loadPromises.push(loadStrategyVectors(vectors));
  }
  
  if (needs.has("clusters")) {
    loadPromises.push(loadStrategyVectors(vectors));
  }
  
  await Promise.all(loadPromises);
  
  return vectors;
}

async function loadPersonalityVectors(userId: number, vectors: LoadedVectors): Promise<void> {
  try {
    const [baseline, userVec] = await Promise.all([
      db.select().from(globalBaselines).where(eq(globalBaselines.baselineType, "personality")).limit(1),
      db.select().from(behaviorVectors).where(eq(behaviorVectors.userId, userId)).limit(1)
    ]);
    
    const baselineData = baseline[0] || {
      slangLevel: 50,
      crabHintLevel: 30,
      teasingLevel: 40,
      proactivityLevel: 50,
      culturalRefLevel: 40,
      tradingCautionLevel: 60
    };
    
    const baseVec = {
      slangLevel: baselineData.slangLevel || 50,
      crabHintLevel: baselineData.crabHintLevel || 30,
      teasingLevel: baselineData.teasingLevel || 40,
      proactivityLevel: baselineData.proactivityLevel || 50,
      culturalRefLevel: baselineData.culturalRefLevel || 40,
      tradingCautionLevel: baselineData.tradingCautionLevel || 60
    };
    
    const userAdjustments = userVec[0] ? {
      slangLevel: (userVec[0].slangLevel || 50) - 50,
      crabHintLevel: (userVec[0].crabHintLevel || 30) - 30,
      teasingLevel: (userVec[0].teasingLevel || 40) - 40,
      proactivityLevel: (userVec[0].proactivityLevel || 50) - 50,
      culturalRefLevel: (userVec[0].culturalRefLevel || 40) - 40,
      tradingCautionLevel: (userVec[0].tradingCautionLevel || 60) - 60
    } : {
      slangLevel: 0,
      crabHintLevel: 0,
      teasingLevel: 0,
      proactivityLevel: 0,
      culturalRefLevel: 0,
      tradingCautionLevel: 0
    };
    
    const effective: Record<string, number> = {};
    for (const key of Object.keys(baseVec) as (keyof typeof baseVec)[]) {
      effective[key] = Math.max(0, Math.min(100, baseVec[key] + userAdjustments[key]));
    }
    
    vectors.personality = {
      baseline: baseVec,
      userAdjustments,
      effective
    };
  } catch (err) {
    console.error("[VectorLoader] Failed to load personality vectors:", err);
  }
}

async function loadRelationshipVectors(userId: number, vectors: LoadedVectors): Promise<void> {
  try {
    const rel = await db.select()
      .from(userRelationships)
      .where(eq(userRelationships.userId, userId))
      .limit(1);
    
    if (rel[0]) {
      vectors.relationship = {
        affinity: rel[0].affinityScore || 50,
        type: rel[0].relationshipType || "new",
        dimensions: {
          adversarial: rel[0].adversarialScore || 0,
          friendly: rel[0].friendlyScore || 50,
          playful: rel[0].playfulScore || 30,
          professional: rel[0].professionalScore || 50
        },
        memorableEvents: []
      };
    } else {
      vectors.relationship = {
        affinity: 50,
        type: "new",
        dimensions: { adversarial: 0, friendly: 50, playful: 30, professional: 50 },
        memorableEvents: []
      };
    }
  } catch (err) {
    console.error("[VectorLoader] Failed to load relationship vectors:", err);
  }
}

async function loadSafetyVectors(tokenMint: string, vectors: LoadedVectors): Promise<void> {
  try {
    const tokenData = await db.select()
      .from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, tokenMint))
      .limit(1);
    
    if (tokenData[0]) {
      const goplusRisks: string[] = [];
      const gp = tokenData[0].goplusData as Record<string, any> | null;
      if (gp) {
        if (gp.is_honeypot) goplusRisks.push("honeypot");
        if (gp.is_blacklisted) goplusRisks.push("blacklisted");
        if (gp.can_take_back_ownership) goplusRisks.push("can_take_back_ownership");
        if (gp.hidden_owner) goplusRisks.push("hidden_owner");
      }
      
      const rugcheck = tokenData[0].rugcheckData as Record<string, any> | null;
      const rugcheckScore = rugcheck?.score ?? null;
      
      vectors.safety = {
        rugcheckScore,
        goplusRisks,
        isSafe: (rugcheckScore || 0) >= 70 && goplusRisks.length === 0,
        lastChecked: tokenData[0].rugcheckCheckedAt || tokenData[0].goplusCheckedAt
      };
    } else {
      vectors.safety = {
        rugcheckScore: null,
        goplusRisks: [],
        isSafe: false,
        lastChecked: null
      };
    }
  } catch (err) {
    console.error("[VectorLoader] Failed to load safety vectors:", err);
  }
}

async function loadBehaviorVectors(tokenMint: string, vectors: LoadedVectors): Promise<void> {
  try {
    const { analyzeCopytradeWindow } = await import("./cluster-detection");
    const behavior = await analyzeCopytradeWindow(tokenMint);
    
    if (behavior) {
      const peakMinutes = Math.round(behavior.peakDelay / 60);
      vectors.behavior = {
        leaderCount: behavior.leaderWallet ? 1 : 0,
        followerCount: behavior.followers?.length || 0,
        copytradeWindow: peakMinutes,
        crowdingRisk: behavior.crowdingRisk
      };
    } else {
      vectors.behavior = {
        leaderCount: 0,
        followerCount: 0,
        copytradeWindow: null,
        crowdingRisk: null
      };
    }
  } catch (err) {
    console.error("[VectorLoader] Failed to load behavior vectors:", err);
    vectors.behavior = {
      leaderCount: 0,
      followerCount: 0,
      copytradeWindow: null,
      crowdingRisk: null
    };
  }
}

async function loadFingerprintVectors(walletAddress: string | undefined, vectors: LoadedVectors): Promise<void> {
  try {
    let fingerprints;
    
    if (walletAddress) {
      fingerprints = await db.select()
        .from(walletFingerprints)
        .where(eq(walletFingerprints.walletAddress, walletAddress))
        .limit(1);
    } else {
      fingerprints = await db.select()
        .from(walletFingerprints)
        .orderBy(desc(walletFingerprints.lastUpdatedAt))
        .limit(5);
    }
    
    vectors.fingerprint = fingerprints.map(f => {
      const avgHoldMins = f.avgHoldDurationMinutes || 0;
      const avgHoldHours = avgHoldMins / 60;
      
      let behaviorType = "organic";
      if (avgHoldMins < 5) behaviorType = "bot";
      else if (f.partialSellRate && f.partialSellRate > 0.6) behaviorType = "disciplined";
      else if (f.rageExitRate && f.rageExitRate > 0.4) behaviorType = "emotional";
      
      let tradingStyle = "mixed";
      if (avgHoldMins < 30) tradingStyle = "scalper";
      else if (avgHoldMins < 60 * 4) tradingStyle = "swing";
      else tradingStyle = "holder";
      
      return {
        walletAddress: f.walletAddress,
        behaviorType,
        tradingStyle,
        winRate: 0,
        avgHoldTime: avgHoldHours,
        playbookScore: f.playbookScore || 0
      };
    });
  } catch (err) {
    console.error("[VectorLoader] Failed to load fingerprint vectors:", err);
    vectors.fingerprint = [];
  }
}

async function loadStrategyVectors(vectors: LoadedVectors): Promise<void> {
  try {
    const clusters = await db.select()
      .from(strategyClusters)
      .orderBy(desc(strategyClusters.sampleSize))
      .limit(10);
    
    vectors.strategy = clusters.map(c => {
      const outcomes = c.outcomes as {
        totalTrades: number;
        wins: number;
        winRate: number;
        avgPnlPercent: number;
      } | null;
      
      return {
        clusterId: c.clusterId,
        pattern: c.pattern,
        walletCount: c.walletCount || 0,
        winRate: outcomes?.winRate || 0,
        avgPnl: outcomes?.avgPnlPercent || 0
      };
    });
  } catch (err) {
    console.error("[VectorLoader] Failed to load strategy vectors:", err);
    vectors.strategy = [];
  }
}

export function vectorsToPromptContext(vectors: LoadedVectors): string {
  const parts: string[] = [];
  
  if (vectors.personality?.effective) {
    const p = vectors.personality.effective;
    const style: string[] = [];
    if (p.slangLevel > 60) style.push("use Caribbean slang");
    if (p.teasingLevel > 60) style.push("be playful");
    if (p.tradingCautionLevel > 70) style.push("emphasize caution");
    if (p.tradingCautionLevel < 40) style.push("be more aggressive");
    if (style.length > 0) {
      parts.push(`Style: ${style.join(", ")}`);
    }
  }
  
  if (vectors.relationship) {
    const r = vectors.relationship;
    if (r.affinity > 80) {
      parts.push(`Relationship: Close friend (affinity ${r.affinity})`);
    } else if (r.affinity < 30) {
      parts.push(`Relationship: New/cautious (affinity ${r.affinity})`);
    }
  }
  
  if (vectors.safety) {
    const s = vectors.safety;
    if (s.rugcheckScore !== null) {
      parts.push(`Token safety: RugCheck ${s.rugcheckScore}/100`);
    }
    if (s.goplusRisks.length > 0) {
      parts.push(`Risks: ${s.goplusRisks.join(", ")}`);
    }
  }
  
  if (vectors.behavior) {
    const b = vectors.behavior;
    if (b.leaderCount > 0) {
      parts.push(`Token has ${b.leaderCount} leaders, ${b.followerCount} followers`);
    }
    if (b.copytradeWindow) {
      parts.push(`Copytrade window: ${b.copytradeWindow} mins`);
    }
    if (b.crowdingRisk && b.crowdingRisk > 0.5) {
      parts.push(`High crowding risk: ${(b.crowdingRisk * 100).toFixed(0)}%`);
    }
  }
  
  if (vectors.fingerprint && vectors.fingerprint.length > 0) {
    const fp = vectors.fingerprint[0];
    parts.push(`Wallet: ${fp.behaviorType}, ${fp.tradingStyle}, ${(fp.winRate * 100).toFixed(0)}% win rate`);
  }
  
  if (vectors.strategy && vectors.strategy.length > 0) {
    const topClusters = vectors.strategy.slice(0, 3);
    const clusterInfo = topClusters.map(c => 
      `${c.pattern}(${c.walletCount} wallets, ${(c.winRate * 100).toFixed(0)}% win)`
    ).join(", ");
    parts.push(`Active strategies: ${clusterInfo}`);
  }
  
  return parts.length > 0 ? `[Context: ${parts.join(" | ")}]` : "";
}

export function getVectorLoadCost(vectorNeeds: string[]): number {
  const costs: Record<string, number> = {
    safety: 1,
    behavior: 1,
    fingerprint: 2,
    strategy: 2,
    clusters: 2
  };
  
  return vectorNeeds.reduce((sum, need) => sum + (costs[need] || 1), 0);
}
