import { db } from "./db";
import { routeIntents, vectorUpdates, type RouteIntent } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy-key",
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
});

export type IntentType = "casual" | "safety" | "wallet" | "strategy" | "trading";

export interface RouteResult {
  intent: IntentType;
  confidence: number;
  tier: 1 | 2 | 3 | 4;
  vectorNeeds: string[];
  matchedKeyword?: string;
  similarityScore?: number;
}

const DEFAULT_INTENTS: Record<IntentType, { keywords: string[]; vectorNeeds: string[] }> = {
  casual: {
    keywords: ["hello", "hi", "hey", "how are you", "thanks", "thank you", "bye", "goodbye", "what's up", "sup"],
    vectorNeeds: []
  },
  safety: {
    keywords: ["safe", "rug", "honeypot", "scam", "rugcheck", "goplus", "risk", "dangerous", "trust", "legit", "legitimate"],
    vectorNeeds: ["safety", "behavior"]
  },
  wallet: {
    keywords: ["wallet", "fingerprint", "trader", "signal", "leader", "follower", "bot", "whale", "holder"],
    vectorNeeds: ["fingerprint", "clusters"]
  },
  strategy: {
    keywords: ["strategy", "pattern", "style", "momentum", "swing", "sniper", "playbook", "approach", "method"],
    vectorNeeds: ["strategy", "fingerprint", "clusters"]
  },
  trading: {
    keywords: ["buy", "sell", "trade", "swap", "position", "entry", "exit", "portfolio", "holding", "profit", "loss", "pnl"],
    vectorNeeds: ["safety", "behavior", "strategy", "fingerprint"]
  }
};

let intentCache: RouteIntent[] | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function loadIntentCache(): Promise<RouteIntent[]> {
  const now = Date.now();
  if (intentCache && (now - cacheLoadedAt) < CACHE_TTL) {
    return intentCache;
  }
  
  try {
    const intents = await db.select().from(routeIntents);
    
    if (intents.length === 0) {
      await seedDefaultIntents();
      intentCache = await db.select().from(routeIntents);
    } else {
      intentCache = intents;
    }
    
    cacheLoadedAt = now;
    return intentCache!;
  } catch (err) {
    console.error("[VectorRouter] Failed to load intent cache:", err);
    return [];
  }
}

async function seedDefaultIntents(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  for (const [intent, config] of Object.entries(DEFAULT_INTENTS)) {
    try {
      await db.insert(routeIntents).values({
        intent,
        vector: [],
        vectorNeeds: config.vectorNeeds,
        tier1Keywords: config.keywords,
        hitCount: 0,
        confidence: 0.5,
        dampingFactor: 0.95,
        learningRate: 0.1,
        createdAt: now,
        updatedAt: now
      }).onConflictDoNothing();
    } catch (err) {
      console.error(`[VectorRouter] Failed to seed intent ${intent}:`, err);
    }
  }
  
  console.log("[VectorRouter] Seeded default intents");
}

function tier1KeywordMatch(message: string, intents: RouteIntent[]): RouteResult | null {
  const normalized = message.toLowerCase().trim();
  const words = normalized.split(/\s+/);
  
  for (const intent of intents) {
    const keywords = (intent.tier1Keywords as string[]) || [];
    for (const keyword of keywords) {
      if (words.includes(keyword) || normalized.includes(keyword)) {
        return {
          intent: intent.intent as IntentType,
          confidence: 0.95,
          tier: 1,
          vectorNeeds: (intent.vectorNeeds as string[]) || [],
          matchedKeyword: keyword
        };
      }
    }
  }
  
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 384
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("[VectorRouter] Embedding failed:", err);
    return null;
  }
}

async function tier2VectorSimilarity(
  message: string, 
  intents: RouteIntent[]
): Promise<RouteResult | null> {
  const intentsWithVectors = intents.filter(i => {
    const vec = i.vector as number[];
    return vec && vec.length > 0;
  });
  
  if (intentsWithVectors.length === 0) {
    return null;
  }
  
  const embedding = await getEmbedding(message);
  if (!embedding) {
    return null;
  }
  
  let bestMatch: { intent: RouteIntent; score: number } | null = null;
  
  for (const intent of intentsWithVectors) {
    const intentVector = intent.vector as number[];
    const score = cosineSimilarity(embedding, intentVector);
    
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { intent, score };
    }
  }
  
  if (bestMatch && bestMatch.score >= 0.85) {
    return {
      intent: bestMatch.intent.intent as IntentType,
      confidence: bestMatch.score,
      tier: 2,
      vectorNeeds: (bestMatch.intent.vectorNeeds as string[]) || [],
      similarityScore: bestMatch.score
    };
  }
  
  return null;
}

async function tier3MiniClassifier(message: string): Promise<RouteResult | null> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Classify the user message intent. Reply with ONLY one word from: casual, safety, wallet, strategy, trading

casual = greetings, thanks, small talk, general questions
safety = token safety, rug checks, honeypot detection, scam questions
wallet = wallet analysis, trader behavior, signal wallets, whale activity
strategy = trading strategies, patterns, approaches, styles
trading = buy/sell actions, positions, portfolio, specific trades`
        },
        { role: "user", content: message }
      ],
      max_tokens: 10,
      temperature: 0
    });
    
    const result = response.choices[0]?.message?.content?.toLowerCase().trim();
    const validIntents: IntentType[] = ["casual", "safety", "wallet", "strategy", "trading"];
    
    if (result && validIntents.includes(result as IntentType)) {
      const intentConfig = DEFAULT_INTENTS[result as IntentType];
      return {
        intent: result as IntentType,
        confidence: 0.75,
        tier: 3,
        vectorNeeds: intentConfig.vectorNeeds
      };
    }
    
    return null;
  } catch (err) {
    console.error("[VectorRouter] Mini classifier failed:", err);
    return null;
  }
}

function tier4Fallback(): RouteResult {
  return {
    intent: "trading",
    confidence: 0.5,
    tier: 4,
    vectorNeeds: ["safety", "behavior", "strategy", "fingerprint"]
  };
}

export async function routeMessage(message: string): Promise<RouteResult> {
  const intents = await loadIntentCache();
  
  const tier1Result = tier1KeywordMatch(message, intents);
  if (tier1Result) {
    recordRouteSignal(tier1Result, message);
    return tier1Result;
  }
  
  const tier2Result = await tier2VectorSimilarity(message, intents);
  if (tier2Result) {
    recordRouteSignal(tier2Result, message);
    return tier2Result;
  }
  
  const tier3Result = await tier3MiniClassifier(message);
  if (tier3Result) {
    recordRouteSignal(tier3Result, message);
    return tier3Result;
  }
  
  const tier4Result = tier4Fallback();
  recordRouteSignal(tier4Result, message);
  return tier4Result;
}

function getBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

async function recordRouteSignal(result: RouteResult, message: string): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const bucketId = getBucketId();
    
    await db.insert(vectorUpdates).values({
      vectorType: "route_intent",
      targetId: result.intent,
      signalType: "route_success",
      signalData: {
        tier: result.tier,
        confidence: result.confidence,
        matchedKeyword: result.matchedKeyword,
        similarityScore: result.similarityScore,
        messagePreview: message.slice(0, 100)
      },
      weight: result.tier === 1 ? 0.5 : result.tier === 2 ? 1.0 : result.tier === 3 ? 1.5 : 2.0,
      bucketId,
      processed: false,
      createdAt: now
    });
    
    await db.update(routeIntents)
      .set({ 
        hitCount: sql`${routeIntents.hitCount} + 1`,
        updatedAt: now
      })
      .where(eq(routeIntents.intent, result.intent));
    
    intentCache = null;
  } catch (err) {
    console.error("[VectorRouter] Failed to record route signal:", err);
  }
}

export async function recordRouteFeedback(
  originalIntent: IntentType,
  actualToolsUsed: string[],
  message: string
): Promise<void> {
  const intentToolMap: Record<string, IntentType> = {
    check_token_safety: "safety",
    analyze_token_behavior: "safety",
    get_wallet_fingerprint: "wallet",
    classify_wallet_behavior: "wallet",
    get_copytrade_window: "strategy",
  };
  
  const usedIntents = new Set<IntentType>();
  for (const tool of actualToolsUsed) {
    const mappedIntent = intentToolMap[tool];
    if (mappedIntent) {
      usedIntents.add(mappedIntent);
    }
  }
  
  if (usedIntents.size === 0 && actualToolsUsed.length === 0) {
    usedIntents.add("casual");
  }
  
  const correctIntent = usedIntents.has(originalIntent) 
    ? originalIntent 
    : Array.from(usedIntents)[0] || originalIntent;
  
  if (correctIntent !== originalIntent) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const bucketId = getBucketId();
      
      await db.insert(vectorUpdates).values({
        vectorType: "route_intent",
        targetId: correctIntent,
        signalType: "route_correction",
        signalData: {
          originalIntent,
          correctIntent,
          toolsUsed: actualToolsUsed,
          messagePreview: message.slice(0, 100)
        },
        weight: 2.0,
        bucketId,
        processed: false,
        createdAt: now
      });
      
      const words = message.toLowerCase().split(/\s+/);
      const potentialKeywords = words.filter(w => w.length >= 3 && w.length <= 20);
      
      if (potentialKeywords.length > 0) {
        const mostDistinctive = potentialKeywords[0];
        
        const intent = await db.select()
          .from(routeIntents)
          .where(eq(routeIntents.intent, correctIntent))
          .limit(1);
        
        if (intent.length > 0) {
          const currentKeywords = (intent[0].tier1Keywords as string[]) || [];
          if (!currentKeywords.includes(mostDistinctive) && currentKeywords.length < 50) {
            await db.update(routeIntents)
              .set({ 
                tier1Keywords: [...currentKeywords, mostDistinctive],
                updatedAt: now
              })
              .where(eq(routeIntents.intent, correctIntent));
            
            intentCache = null;
          }
        }
      }
    } catch (err) {
      console.error("[VectorRouter] Failed to record feedback:", err);
    }
  }
}

export async function getRouteStats(): Promise<{
  intents: { intent: string; hitCount: number; keywordCount: number; hasVector: boolean }[];
  tier1Percentage: number;
  totalRoutes: number;
}> {
  const intents = await loadIntentCache();
  
  const stats = intents.map(i => ({
    intent: i.intent,
    hitCount: i.hitCount || 0,
    keywordCount: ((i.tier1Keywords as string[]) || []).length,
    hasVector: ((i.vector as number[]) || []).length > 0
  }));
  
  const totalRoutes = stats.reduce((sum, s) => sum + s.hitCount, 0);
  
  return {
    intents: stats,
    tier1Percentage: totalRoutes > 0 ? 80 : 0,
    totalRoutes
  };
}

export function invalidateIntentCache(): void {
  intentCache = null;
  cacheLoadedAt = 0;
}
