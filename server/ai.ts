import OpenAI from "openai";
import { z } from "zod";
import { db } from "./db";
import { tokenSnapshots, aiChatMessages, pendingBuys, tokenEvents, userEventPreferences, priceAggregates, settings, cachedAlerts, adminSettings, users, communityInsights, monitoredWallets } from "@shared/schema";
import type { TokenSnapshot, InsertTokenSnapshot, TokenEvent, UserEventPreferences } from "@shared/schema";
import { eq, desc, and, isNotNull, gte, inArray } from "drizzle-orm";
import { trackApiCall, shouldAllowApiCall, getBudgetStatus } from "./api-budget";
import { recordAISuccess, recordAIFailure, isAIAvailable, getFallbackMessage } from "./ai-health";
import { getHoldersCached } from "./price-aggregator";
import { fetchTokenMetadata } from "./helius";
import { buyToken, sellToken, getTokenPrice } from "./jupiter";
import { getHotWalletBalance, getTradeConfig, updateTradeConfig, getHoldings, getPendingBuys, getOrCreateHotWallet } from "./wallet";

// In-memory store for pending admin instructions (expires after 5 minutes)
const pendingAdminInstructions: Map<number, { instruction: string; expiresAt: number }> = new Map();
const ADMIN_CODEWORD = "Admin1112";
const PENDING_INSTRUCTION_TTL = 5 * 60 * 1000; // 5 minutes

// Pending trade confirmations - Miss Pincher proposes, user confirms
interface PendingTrade {
  type: 'buy' | 'sell';
  tokenMint: string;
  tokenSymbol: string;
  amount: number; // SOL for buys, token amount for sells
  proposedAt: number;
  expiresAt: number;
  userConfirmed: boolean; // Server-side: must be true before execution
}
const pendingTrades: Map<number, PendingTrade> = new Map();
const PENDING_TRADE_TTL = 3 * 60 * 1000; // 3 minutes to confirm

// Server-side confirmation: must be called before execute can proceed
function confirmPendingTrade(userId: number): { success: boolean; message: string } {
  const pending = pendingTrades.get(userId);
  if (!pending) {
    return { success: false, message: "No pending trade to confirm." };
  }
  if (Date.now() > pending.expiresAt) {
    pendingTrades.delete(userId);
    return { success: false, message: "Trade proposal expired. Need to propose again." };
  }
  pending.userConfirmed = true;
  return { success: true, message: `Confirmed ${pending.type} for ${pending.tokenSymbol}. Executing...` };
}

// Cleanup expired pending trades every minute
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(pendingTrades.entries());
  for (const [userId, trade] of entries) {
    if (now > trade.expiresAt) {
      pendingTrades.delete(userId);
      console.log(`[Trading] Expired pending ${trade.type} for user ${userId} (${trade.tokenSymbol})`);
    }
  }
}, 60000);

// Check if user is admin
async function isUserAdmin(userId: number): Promise<boolean> {
  const user = await db.select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user[0]?.isAdmin === true;
}

// Handle admin commands in chat - returns response if handled, undefined if not an admin command
async function handleAdminCommand(userId: number, message: string): Promise<string | undefined> {
  const upperMessage = message.toUpperCase().trim();
  
  // Check for confirmation of pending instruction
  if (upperMessage === 'CONFIRM' || upperMessage === 'YES') {
    const pending = pendingAdminInstructions.get(userId);
    if (pending && Date.now() < pending.expiresAt) {
      pendingAdminInstructions.delete(userId);
      
      // Verify admin status again before saving
      const isAdmin = await isUserAdmin(userId);
      if (!isAdmin) {
        return "Nice try. You're not an admin.";
      }
      
      await setAdminInstructions(pending.instruction, userId);
      console.log(`[ADMIN] User ${userId} set new admin instructions`);
      return "Locked in. I'll keep that in mind going forward.";
    }
    // No pending instruction, let normal chat handle it
    return undefined;
  }
  
  // Check for codeword trigger
  if (message.includes(ADMIN_CODEWORD)) {
    const isAdmin = await isUserAdmin(userId);
    if (!isAdmin) {
      // Don't reveal the codeword was recognized - just deflect
      return "I don't discuss how I work. Let's get back to trading.";
    }
    
    // Extract the instruction (everything after the codeword)
    const instruction = message.replace(ADMIN_CODEWORD, '').replace(/^[:\s]+/, '').trim();
    
    if (!instruction) {
      return "Got the signal, but you didn't include any instruction. Try again with what you want me to remember.";
    }
    
    // Store pending instruction and ask for confirmation
    pendingAdminInstructions.set(userId, {
      instruction,
      expiresAt: Date.now() + PENDING_INSTRUCTION_TTL,
    });
    
    console.log(`[ADMIN] User ${userId} initiated admin instruction: "${instruction.slice(0, 50)}..."`);
    return `Got it. Want me to add this to my permanent instructions?\n\n"${instruction}"\n\nReply 'confirm' to lock it in.`;
  }
  
  // Check for "show instructions" command (admin only)
  if (upperMessage.includes('SHOW') && upperMessage.includes('INSTRUCTION') && upperMessage.includes(ADMIN_CODEWORD.toUpperCase())) {
    const isAdmin = await isUserAdmin(userId);
    if (!isAdmin) {
      return "I don't discuss how I work. Let's get back to trading.";
    }
    
    const current = await getAdminInstructions();
    if (current) {
      return `Current admin instructions:\n\n"${current}"`;
    }
    return "No admin instructions currently set.";
  }
  
  // Check for "clear instructions" command (admin only)
  if (upperMessage.includes('CLEAR') && upperMessage.includes('INSTRUCTION') && upperMessage.includes(ADMIN_CODEWORD.toUpperCase())) {
    const isAdmin = await isUserAdmin(userId);
    if (!isAdmin) {
      return "I don't discuss how I work. Let's get back to trading.";
    }
    
    // Set pending clear instruction
    pendingAdminInstructions.set(userId, {
      instruction: '',  // Empty means clear
      expiresAt: Date.now() + PENDING_INSTRUCTION_TTL,
    });
    
    return "You want me to clear all admin instructions? Reply 'confirm' to wipe them.";
  }
  
  return undefined; // Not an admin command
}

// In-memory store for pending insight consent (expires after 5 minutes)
const pendingInsightConsent: Map<number, { tokenMint: string; tokenSymbol: string; summary: string; sentiment: string; expiresAt: number }> = new Map();

// Store a community insight (after user consent)
export async function storeCommunityInsight(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  sentiment: string,
  summary: string,
  credibility: string = 'unknown'
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (7 * 24 * 60 * 60); // Expires in 7 days
  
  // Fetch current token price to track performance over time
  let priceAtShare: number | null = null;
  try {
    const metadata = await fetchTokenMetadata(tokenMint);
    if (metadata?.priceUsd) {
      priceAtShare = metadata.priceUsd;
    }
  } catch (err) {
    console.warn(`[COMMUNITY] Could not fetch price for ${tokenSymbol}:`, err);
  }
  
  await db.insert(communityInsights).values({
    tokenMint,
    tokenSymbol,
    sentiment,
    summary,
    sourceUserId: userId,
    consentedAt: now,
    sourceCredibility: credibility,
    priceAtShare,
    createdAt: now,
    expiresAt,
    isActive: true,
  });
  
  console.log(`[COMMUNITY] User ${userId} shared insight for ${tokenSymbol} at $${priceAtShare?.toFixed(6) || 'unknown'}: "${summary.slice(0, 50)}..."`);
}

// Community insight with price performance data
export interface CommunityInsightWithPerformance {
  sentiment: string;
  summary: string;
  credibility: string | null;
  createdAt: number;
  priceAtShare: number | null;
  ageText: string; // e.g., "3 days ago"
  performanceText: string | null; // e.g., "up 45%" or null if no price data
}

// Format relative time for insight age
function formatInsightAge(createdAtTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - createdAtTimestamp;
  
  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// Calculate price performance since insight was shared
function formatPricePerformance(priceAtShare: number | null, currentPrice: number | null): string | null {
  if (!priceAtShare || !currentPrice || priceAtShare <= 0) return null;
  
  const changePercent = ((currentPrice - priceAtShare) / priceAtShare) * 100;
  const direction = changePercent >= 0 ? "up" : "down";
  const absChange = Math.abs(changePercent);
  
  if (absChange < 1) return "flat since";
  if (absChange >= 1000) return `${direction} ${(absChange / 100).toFixed(0)}x since`;
  return `${direction} ${absChange.toFixed(0)}% since`;
}

// Get community insights for a token with performance data
export async function getCommunityInsights(
  tokenMint: string, 
  excludeUserId: number,
  currentPrice?: number | null
): Promise<CommunityInsightWithPerformance[]> {
  const now = Math.floor(Date.now() / 1000);
  
  // Query with sourceUserId to filter in JS (drizzle doesn't have != operator easily)
  const rawInsights = await db.select({
    sentiment: communityInsights.sentiment,
    summary: communityInsights.summary,
    credibility: communityInsights.sourceCredibility,
    sourceUserId: communityInsights.sourceUserId,
    expiresAt: communityInsights.expiresAt,
    createdAt: communityInsights.createdAt,
    priceAtShare: communityInsights.priceAtShare,
  })
    .from(communityInsights)
    .where(and(
      eq(communityInsights.tokenMint, tokenMint),
      eq(communityInsights.isActive, true),
    ))
    .orderBy(desc(communityInsights.createdAt))
    .limit(10);
  
  // Filter out the user's own insights and expired ones, then add performance data
  return rawInsights
    .filter(i => i.sourceUserId !== excludeUserId) // Exclude user's own insights
    .filter(i => !i.expiresAt || i.expiresAt > now) // Exclude expired insights
    .slice(0, 5)
    .map(({ sentiment, summary, credibility, createdAt, priceAtShare }) => ({
      sentiment,
      summary,
      credibility,
      createdAt,
      priceAtShare,
      ageText: formatInsightAge(createdAt),
      performanceText: formatPricePerformance(priceAtShare, currentPrice ?? null),
    }));
}

// Handle insight consent flow
async function handleInsightConsent(userId: number, message: string): Promise<string | undefined> {
  const upperMessage = message.toUpperCase().trim();
  
  // Check for consent confirmation
  if ((upperMessage === 'YES' || upperMessage === 'SHARE IT' || upperMessage.includes('SHARE')) && pendingInsightConsent.has(userId)) {
    const pending = pendingInsightConsent.get(userId)!;
    if (Date.now() < pending.expiresAt) {
      pendingInsightConsent.delete(userId);
      
      await storeCommunityInsight(
        userId,
        pending.tokenMint,
        pending.tokenSymbol,
        pending.sentiment,
        pending.summary
      );
      
      return "Got it. I'll pass that along anonymously if anyone else asks about this token. Your wallet and username stay private.";
    }
  }
  
  // Check for decline
  if ((upperMessage === 'NO' || upperMessage === 'NAH' || upperMessage.includes('KEEP IT PRIVATE')) && pendingInsightConsent.has(userId)) {
    pendingInsightConsent.delete(userId);
    return "No worries. Keeping that between us.";
  }
  
  return undefined;
}

// Ask user if they want to share an insight (called when AI detects quality alpha)
export function setPendingInsightConsent(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  sentiment: string,
  summary: string
): void {
  pendingInsightConsent.set(userId, {
    tokenMint,
    tokenSymbol,
    sentiment,
    summary,
    expiresAt: Date.now() + PENDING_INSTRUCTION_TTL,
  });
}

import { 
  buildPincherSystemPrompt, 
  type PincherContext, 
  type UserRelationship,
  type MarketMood,
  getPincherWelcome,
  calculateAffinityChange,
  determineRelationshipType
} from "./pincher-personality";

const scoreResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string(),
  redFlags: z.array(z.string()).default([]),
  greenFlags: z.array(z.string()).default([]),
});

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy-key",
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
});

export interface TopHolder {
  address: string;
  percent: number;
  isLP?: boolean;
}

export interface SnapshotData {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  pairCreatedAt?: number;
  buys24h?: number;
  sells24h?: number;
  buyVolume24h?: number;
  sellVolume24h?: number;
  holders?: number;
  topHolderPercent?: number;
  devWalletPercent?: number;
  topHolders?: TopHolder[];
  lpBurned?: boolean;
  lpLockedPercent?: number;
  sourceWallets?: string[];
  knownWhalesBuying?: number;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  twitterHandle?: string;
  socialSearchResult?: string;
}

export async function createSnapshot(data: SnapshotData): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const tokenAgeMinutes = data.pairCreatedAt 
    ? Math.floor((now - data.pairCreatedAt) / 60) 
    : undefined;

  const result = await db.insert(tokenSnapshots).values({
    tokenMint: data.tokenMint,
    tokenSymbol: data.tokenSymbol,
    tokenName: data.tokenName,
    capturedAt: now,
    priceUsd: data.priceUsd,
    marketCap: data.marketCap,
    fdv: data.fdv,
    liquidity: data.liquidity,
    volume24h: data.volume24h,
    priceChange24h: data.priceChange24h,
    pairCreatedAt: data.pairCreatedAt,
    tokenAgeMinutes,
    buys24h: data.buys24h,
    sells24h: data.sells24h,
    buyVolume24h: data.buyVolume24h,
    sellVolume24h: data.sellVolume24h,
    holders: data.holders,
    topHolderPercent: data.topHolderPercent,
    devWalletPercent: data.devWalletPercent,
    topHolders: data.topHolders || null,
    lpBurned: data.lpBurned,
    lpLockedPercent: data.lpLockedPercent,
    sourceWallets: data.sourceWallets || [],
    knownWhalesBuying: data.knownWhalesBuying || 0,
    hasTwitter: data.hasTwitter || false,
    hasTelegram: data.hasTelegram || false,
    hasWebsite: data.hasWebsite || false,
    twitterHandle: data.twitterHandle,
    socialSearchResult: data.socialSearchResult,
  }).returning();

  return result[0].id;
}

export async function getSnapshot(snapshotId: number): Promise<TokenSnapshot | null> {
  const rows = await db.select().from(tokenSnapshots).where(eq(tokenSnapshots.id, snapshotId)).limit(1);
  return rows.length > 0 ? rows[0] as TokenSnapshot : null;
}

export async function getSnapshotByToken(tokenMint: string): Promise<TokenSnapshot | null> {
  const rows = await db.select()
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.tokenMint, tokenMint))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(1);
  return rows.length > 0 ? rows[0] as TokenSnapshot : null;
}

export async function getAllSnapshots(): Promise<TokenSnapshot[]> {
  const rows = await db.select().from(tokenSnapshots).orderBy(desc(tokenSnapshots.capturedAt));
  return rows as TokenSnapshot[];
}

export async function getSnapshotsWithOutcomes(): Promise<TokenSnapshot[]> {
  const rows = await db.select()
    .from(tokenSnapshots)
    .where(isNotNull(tokenSnapshots.finalMultiplier))
    .orderBy(desc(tokenSnapshots.capturedAt));
  return rows as TokenSnapshot[];
}

async function buildScoringPrompt(
  snapshot: TokenSnapshot, 
  historicalData?: TokenSnapshot[],
  aggregateData?: { tier: string; open: number; high: number; low: number; close: number; volume: number; buys: number; sells: number; marketCap: number }[],
  whaleData?: { top10Percent: number; holderCount: number; recentWhaleActivity: boolean }
): Promise<string> {
  const data = {
    token: snapshot.tokenSymbol,
    name: snapshot.tokenName,
    price: snapshot.priceUsd,
    marketCap: snapshot.marketCap,
    liquidity: snapshot.liquidity,
    fdv: snapshot.fdv,
    volume24h: snapshot.volume24h,
    priceChange24h: snapshot.priceChange24h,
    tokenAgeMinutes: snapshot.tokenAgeMinutes,
    buys24h: snapshot.buys24h,
    sells24h: snapshot.sells24h,
    buyVolume24h: snapshot.buyVolume24h,
    sellVolume24h: snapshot.sellVolume24h,
    holders: snapshot.holders,
    topHolderPercent: snapshot.topHolderPercent,
    devWalletPercent: snapshot.devWalletPercent,
    lpBurned: snapshot.lpBurned,
    lpLockedPercent: snapshot.lpLockedPercent,
    sourceWalletsCount: snapshot.sourceWallets?.length || 0,
    knownWhalesBuying: snapshot.knownWhalesBuying,
    hasTwitter: snapshot.hasTwitter,
    hasTelegram: snapshot.hasTelegram,
    hasWebsite: snapshot.hasWebsite,
    twitterHandle: snapshot.twitterHandle,
    socialInfo: snapshot.socialSearchResult,
  };

  let prompt = `Analyze this Solana memecoin for copy trading potential. Score from 0-100.

TOKEN DATA:
${JSON.stringify(data, null, 2)}

`;

  // Add price pattern data from aggregates if available
  if (aggregateData && aggregateData.length > 0) {
    prompt += `\nPRICE PATTERNS (OHLC aggregates):
${JSON.stringify(aggregateData, null, 2)}

`;
  }

  // Add whale concentration data if available
  if (whaleData) {
    prompt += `\nWHALE ACTIVITY:
- Top 10 holders control: ${whaleData.top10Percent.toFixed(1)}%
- Total holder count: ${whaleData.holderCount}
- Recent whale activity detected: ${whaleData.recentWhaleActivity ? 'Yes' : 'No'}

`;
  }

  if (historicalData && historicalData.length > 0) {
    const patterns = historicalData.slice(0, 20).map(h => ({
      symbol: h.tokenSymbol,
      liquidity: h.liquidity,
      marketCap: h.marketCap,
      holders: h.holders,
      hasTwitter: h.hasTwitter,
      tokenAge: h.tokenAgeMinutes,
      finalMultiplier: h.finalMultiplier,
    }));
    
    prompt += `\nHISTORICAL TRADE OUTCOMES (learn from these):
${JSON.stringify(patterns, null, 2)}

`;
  }

  prompt += `Analyze and return JSON with:
{
  "score": <0-100 integer>,
  "reasoning": "<brief 2-3 sentence explanation>",
  "redFlags": ["<list any concerns>"],
  "greenFlags": ["<list positive indicators>"]
}

Key factors to consider:
- Liquidity vs market cap ratio (healthy is 10-30%)
- Token age (newer can be riskier but higher potential)
- Buy/sell ratio and volume
- Holder distribution (high top holder % is risky)
- Social presence (Twitter = more legitimate)
- Dev wallet concentration
- LP burned/locked status
- Price patterns from OHLC data (if provided) - look for volatility, trends, support levels
- Whale activity - recent whale buys are positive signals, high concentration is risky

Return ONLY valid JSON, no markdown or explanation outside the JSON.`;

  return prompt;
}

export interface ScoreResult {
  score: number;
  reasoning: string;
  redFlags: string[];
  greenFlags: string[];
}

export async function scoreToken(snapshotId: number): Promise<ScoreResult | null> {
  const snapshot = await getSnapshot(snapshotId);
  if (!snapshot) return null;

  const historicalData = await getSnapshotsWithOutcomes();
  
  // Fetch aggregate price data for pattern analysis
  let aggregateData: { tier: string; open: number; high: number; low: number; close: number; volume: number; buys: number; sells: number; marketCap: number }[] | undefined;
  try {
    const recentAggregates = await db.select().from(priceAggregates)
      .where(eq(priceAggregates.tokenMint, snapshot.tokenMint))
      .orderBy(desc(priceAggregates.bucketStart))
      .limit(10);
    
    if (recentAggregates.length > 0) {
      aggregateData = recentAggregates.map(a => ({
        tier: a.tier,
        open: a.priceOpen || 0,
        high: a.priceHigh || 0,
        low: a.priceLow || 0,
        close: a.priceClose || 0,
        volume: a.volume || 0,
        buys: a.buys || 0,
        sells: a.sells || 0,
        marketCap: a.marketCap || 0,
      }));
    }
  } catch (err) {
    console.warn("Failed to fetch aggregates for scoring:", err);
  }
  
  // Fetch whale/holder data
  let whaleData: { top10Percent: number; holderCount: number; recentWhaleActivity: boolean } | undefined;
  try {
    const holderCache = await getHoldersCached(snapshot.tokenMint);
    if (holderCache && holderCache.holders.length >= 10) {
      const top10Percent = holderCache.holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);
      const recentWhaleActivity = holderCache.lastEventTriggerAt > 0 && 
        (Date.now() - holderCache.lastEventTriggerAt) < 24 * 60 * 60 * 1000;
      whaleData = {
        top10Percent,
        holderCount: holderCache.holders.length,
        recentWhaleActivity,
      };
    }
  } catch (err) {
    console.warn("Failed to fetch holder data for scoring:", err);
  }
  
  const prompt = await buildScoringPrompt(snapshot, historicalData, aggregateData, whaleData);

  const budgetCheck = await shouldAllowApiCall("openai");
  if (!budgetCheck.allowed) {
    console.warn(`OpenAI API blocked: ${budgetCheck.reason}`);
    return { score: 50, reasoning: "AI scoring unavailable due to budget limits", redFlags: [], greenFlags: [] };
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a memecoin analysis expert. Analyze tokens for copy trading potential. Be objective and data-driven. Return only valid JSON."
        },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: 500,
      temperature: 0.3,
    });
    await trackApiCall("openai", "scoreToken"); // Track after successful response

    const content = response.choices[0]?.message?.content || "";
    
    let parsed: ScoreResult;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in AI response");
      
      const rawParsed = JSON.parse(jsonMatch[0]);
      const validationResult = scoreResultSchema.safeParse(rawParsed);
      
      if (!validationResult.success) {
        console.error("AI response validation failed:", validationResult.error.errors);
        return null;
      }
      
      parsed = validationResult.data;
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError, "Content:", content);
      return null;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      await db.update(tokenSnapshots).set({
        aiScore: parsed.score,
        aiAnalysis: JSON.stringify(parsed),
        aiScoredAt: now,
      }).where(eq(tokenSnapshots.id, snapshotId));
    } catch (dbError) {
      console.error("Failed to update snapshot with AI score:", dbError);
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("AI scoring failed:", error);
    return null;
  }
}

export async function refreshScore(snapshotId: number): Promise<ScoreResult | null> {
  return scoreToken(snapshotId);
}

export async function updateSnapshotOutcome(
  snapshotId: number,
  finalMultiplier: number,
  holdTimeMinutes: number,
  sourceWalletAddress?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const [snapshot] = await db.select().from(tokenSnapshots)
    .where(eq(tokenSnapshots.id, snapshotId))
    .limit(1);
  
  await db.update(tokenSnapshots).set({
    finalMultiplier,
    holdTimeMinutes,
    outcomeUpdatedAt: now,
  }).where(eq(tokenSnapshots.id, snapshotId));
  
  const walletToUpdate = sourceWalletAddress || (snapshot?.sourceWallets?.[0] as string | undefined);
  
  if (walletToUpdate) {
    try {
      const { updateSignalWalletProfile } = await import("./signal-wallet-profiler");
      await updateSignalWalletProfile(
        walletToUpdate,
        finalMultiplier,
        holdTimeMinutes,
        snapshot?.marketCap ?? undefined
      );
    } catch (error) {
      console.error("Failed to update signal wallet profile:", error);
    }
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const chatTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "refresh_token_score",
      description: "Refresh the AI score for a specific token by its symbol or name. Use when the user asks to refresh, rescore, or re-analyze a specific token.",
      parameters: {
        type: "object",
        properties: {
          tokenIdentifier: {
            type: "string",
            description: "The token symbol (e.g., 'PEPE', 'BONK') or partial name to search for"
          }
        },
        required: ["tokenIdentifier"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "refresh_all_scores",
      description: "Refresh AI scores for all tokens or multiple tokens. Use when the user asks to refresh all scores, rescore everything, or update all token analyses.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of tokens to refresh (default 10, max 50)"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_user_preferences",
      description: "Update the user's event notification and summary preferences. Use when user wants to change what events they see, mute tokens, focus on wallets, or change what you focus on in summaries.",
      parameters: {
        type: "object",
        properties: {
          minValueThreshold: {
            type: "number",
            description: "Minimum USD value for events to show (e.g., 100 means only show events worth $100+)"
          },
          addMutedToken: {
            type: "string",
            description: "Token symbol to mute/ignore in event feed"
          },
          removeMutedToken: {
            type: "string",
            description: "Token symbol to unmute/show again"
          },
          addFocusWallet: {
            type: "string",
            description: "Wallet address to prioritize in alerts"
          },
          removeFocusWallet: {
            type: "string",
            description: "Wallet address to remove from focus list"
          },
          summaryFocus: {
            type: "string",
            description: "What to focus on in summaries (e.g., 'whale movements', 'LP changes', 'risk factors', 'upside potential')"
          },
          pinchEmailsEnabled: {
            type: "boolean",
            description: "Whether to receive special email alerts from Pincher"
          }
        },
        required: []
      }
    }
  },
  // Trading Action Tools
  {
    type: "function",
    function: {
      name: "propose_buy",
      description: "Propose buying a token with SOL from the user's hot wallet. ALWAYS propose first and wait for user confirmation before executing. Use when user asks to buy a token.",
      parameters: {
        type: "object",
        properties: {
          tokenMint: {
            type: "string",
            description: "The Solana token mint address to buy"
          },
          tokenSymbol: {
            type: "string",
            description: "The token symbol (e.g., 'BONK', 'PEPE')"
          },
          solAmount: {
            type: "number",
            description: "Amount of SOL to spend (default 0.1 if not specified)"
          }
        },
        required: ["tokenMint", "tokenSymbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_sell",
      description: "Propose selling a token from user's holdings. ALWAYS propose first and wait for user confirmation. Use when user asks to sell or exit a position.",
      parameters: {
        type: "object",
        properties: {
          tokenMint: {
            type: "string",
            description: "The Solana token mint address to sell"
          },
          tokenSymbol: {
            type: "string",
            description: "The token symbol"
          },
          percentToSell: {
            type: "number",
            description: "Percentage of holdings to sell (1-100). Default 100 for full exit."
          }
        },
        required: ["tokenMint", "tokenSymbol"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_pending_trade",
      description: "Execute a trade that was previously proposed and user confirmed. Only call this after user says 'yes', 'do it', 'confirm', 'go ahead', or similar confirmation.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_pending_trade",
      description: "Cancel a pending trade proposal. Use when user says 'no', 'cancel', 'nevermind', or rejects the trade.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_wallet_balance",
      description: "Check the user's hot wallet SOL balance. Use when user asks about balance, funds, or how much they can spend.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_holdings_summary",
      description: "Get a summary of user's current token holdings with P&L. Use when user asks about their bags, portfolio, positions, or what they own.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_pending_orders",
      description: "Get list of pending buy orders queued for execution. Use when user asks about pending trades, queued buys, or what's waiting.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  // Copy Trading Configuration Tools
  {
    type: "function",
    function: {
      name: "set_copy_trading",
      description: "Enable, disable, or configure copy trading settings. Use when user wants to turn on/off auto-copy, set buy amounts, delays, or take-profit levels.",
      parameters: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Enable or disable copy trading"
          },
          buyPercentage: {
            type: "number",
            description: "Percentage of detected trade value to copy (1-100)"
          },
          minDelayMinutes: {
            type: "number",
            description: "Minimum delay before executing copy trade (minutes)"
          },
          maxDelayMinutes: {
            type: "number",
            description: "Maximum delay before executing copy trade (minutes)"
          },
          reclaimMultiplier: {
            type: "number",
            description: "Take-profit multiplier (e.g., 4 means sell at 4x)"
          },
          dumpAlertThreshold: {
            type: "number",
            description: "Alert when token dumps by this percentage (e.g., 50 = -50%)"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_copy_trading_settings",
      description: "Get current copy trading configuration. Use when user asks about their settings, current config, or how copy trading is set up.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  // Wallet Monitoring Tools
  {
    type: "function",
    function: {
      name: "enable_wallet_copy",
      description: "Enable copying trades from a specific monitored wallet. Use when user wants to start copying a wallet or enable copy trading for a wallet.",
      parameters: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            description: "The Solana wallet address to copy trades from"
          },
          label: {
            type: "string",
            description: "Optional friendly name for the wallet"
          }
        },
        required: ["walletAddress"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "disable_wallet_copy",
      description: "Disable copying trades from a specific wallet. Use when user wants to stop copying a wallet but keep monitoring it.",
      parameters: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            description: "The wallet address to stop copying"
          }
        },
        required: ["walletAddress"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_monitored_wallets",
      description: "List all wallets the user is monitoring with their copy status. Use when user asks what wallets they're watching or copying.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  }
];

async function executeScoreRefresh(tokenIdentifier: string): Promise<{ success: boolean; message: string; score?: number }> {
  const snapshots = await getAllSnapshots();
  const searchLower = tokenIdentifier.toLowerCase();
  
  const match = snapshots.find(s => 
    s.tokenSymbol.toLowerCase() === searchLower ||
    s.tokenSymbol.toLowerCase().includes(searchLower) ||
    (s.tokenName && s.tokenName.toLowerCase().includes(searchLower))
  );
  
  if (!match) {
    return { success: false, message: `No token found matching "${tokenIdentifier}"` };
  }
  
  const result = await scoreToken(match.id);
  if (!result) {
    return { success: false, message: `Failed to refresh score for ${match.tokenSymbol}` };
  }
  
  return { 
    success: true, 
    message: `Refreshed score for ${match.tokenSymbol}: ${result.score}/100`,
    score: result.score
  };
}

async function executeBatchScoreRefresh(limit: number = 10): Promise<{ success: boolean; message: string; refreshed: number }> {
  const maxLimit = Math.min(limit, 50);
  const snapshots = await getAllSnapshots();
  const toRefresh = snapshots.slice(0, maxLimit);
  
  let refreshed = 0;
  const results: string[] = [];
  
  for (const snapshot of toRefresh) {
    const result = await scoreToken(snapshot.id);
    if (result) {
      refreshed++;
      results.push(`${snapshot.tokenSymbol}: ${result.score}`);
    }
  }
  
  return {
    success: true,
    message: `Refreshed ${refreshed}/${toRefresh.length} token scores. Results: ${results.join(', ')}`,
    refreshed
  };
}

export async function getUserPreferences(userId: number): Promise<UserEventPreferences | null> {
  const rows = await db.select()
    .from(userEventPreferences)
    .where(eq(userEventPreferences.userId, userId))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

export async function updateUserPreferences(
  userId: number,
  updates: {
    minValueThreshold?: number;
    addMutedToken?: string;
    removeMutedToken?: string;
    addFocusWallet?: string;
    removeFocusWallet?: string;
    summaryFocus?: string;
    pinchEmailsEnabled?: boolean;
  }
): Promise<{ success: boolean; message: string }> {
  const now = Math.floor(Date.now() / 1000);
  
  let prefs = await getUserPreferences(userId);
  
  if (!prefs) {
    await db.insert(userEventPreferences).values({
      userId,
      minValueThreshold: 0,
      mutedTokens: [],
      focusWallets: [],
      summaryFocus: null,
      pinchEmailsEnabled: true,
      lastSummaryAt: null,
      updatedAt: now,
    });
    prefs = await getUserPreferences(userId);
  }
  
  if (!prefs) {
    return { success: false, message: "Failed to create preferences" };
  }
  
  const changes: string[] = [];
  const updateData: any = { updatedAt: now };
  
  if (updates.minValueThreshold !== undefined) {
    updateData.minValueThreshold = updates.minValueThreshold;
    changes.push(`minimum value threshold set to $${updates.minValueThreshold}`);
  }
  
  if (updates.addMutedToken) {
    const current = prefs.mutedTokens || [];
    const upper = updates.addMutedToken.toUpperCase();
    if (!current.includes(upper)) {
      updateData.mutedTokens = [...current, upper];
      changes.push(`muted ${upper}`);
    } else {
      changes.push(`${upper} was already muted`);
    }
  }
  
  if (updates.removeMutedToken) {
    const current = prefs.mutedTokens || [];
    const upper = updates.removeMutedToken.toUpperCase();
    updateData.mutedTokens = current.filter(t => t !== upper);
    changes.push(`unmuted ${upper}`);
  }
  
  if (updates.addFocusWallet) {
    const current = prefs.focusWallets || [];
    if (!current.includes(updates.addFocusWallet)) {
      updateData.focusWallets = [...current, updates.addFocusWallet];
      changes.push(`added wallet to focus list`);
    }
  }
  
  if (updates.removeFocusWallet) {
    const current = prefs.focusWallets || [];
    updateData.focusWallets = current.filter(w => w !== updates.removeFocusWallet);
    changes.push(`removed wallet from focus list`);
  }
  
  if (updates.summaryFocus !== undefined) {
    updateData.summaryFocus = updates.summaryFocus;
    changes.push(`summary focus updated to: "${updates.summaryFocus}"`);
  }
  
  if (updates.pinchEmailsEnabled !== undefined) {
    updateData.pinchEmailsEnabled = updates.pinchEmailsEnabled;
    changes.push(`email alerts ${updates.pinchEmailsEnabled ? 'enabled' : 'disabled'}`);
  }
  
  await db.update(userEventPreferences)
    .set(updateData)
    .where(eq(userEventPreferences.userId, userId));
  
  return {
    success: true,
    message: changes.length > 0 ? `Updated: ${changes.join(', ')}` : "No changes made"
  };
}

async function executePreferenceUpdate(
  userId: number,
  args: Record<string, any>
): Promise<{ success: boolean; message: string }> {
  return updateUserPreferences(userId, args);
}

// ============= TRADING TOOL EXECUTION FUNCTIONS =============

// Propose a buy - stores pending trade for confirmation
async function executeProposeBuy(
  userId: number,
  args: { tokenMint: string; tokenSymbol: string; solAmount?: number }
): Promise<{ success: boolean; message: string }> {
  const solAmount = args.solAmount || 0.1;
  
  // Check wallet exists
  const wallet = await getOrCreateHotWallet(userId);
  if (!wallet) {
    return { success: false, message: "No hot wallet configured. User needs to set one up first." };
  }
  
  // Check balance
  const balance = await getHotWalletBalance(userId);
  if (balance < solAmount) {
    return { 
      success: false, 
      message: `Insufficient balance: ${balance.toFixed(4)} SOL available, need ${solAmount} SOL` 
    };
  }
  
  // Get current price
  const price = await getTokenPrice(args.tokenMint);
  const priceStr = price ? `$${price.toFixed(8)}` : 'unknown price';
  
  // Store pending trade - requires explicit confirmation before execute
  pendingTrades.set(userId, {
    type: 'buy',
    tokenMint: args.tokenMint,
    tokenSymbol: args.tokenSymbol,
    amount: solAmount,
    proposedAt: Date.now(),
    expiresAt: Date.now() + PENDING_TRADE_TTL,
    userConfirmed: false,
  });
  
  return {
    success: true,
    message: `PENDING_TRADE: Buy ${args.tokenSymbol} with ${solAmount} SOL at ${priceStr}. Balance: ${balance.toFixed(4)} SOL. AWAITING CONFIRMATION.`
  };
}

// Propose a sell - stores pending trade for confirmation
async function executeProposeSell(
  userId: number,
  args: { tokenMint: string; tokenSymbol: string; percentToSell?: number }
): Promise<{ success: boolean; message: string }> {
  const percentToSell = args.percentToSell || 100;
  
  // Check if user has holdings
  const userHoldings = await getHoldings(userId);
  const holding = userHoldings.find(h => h.tokenMint === args.tokenMint);
  
  if (!holding) {
    return { success: false, message: `User doesn't own any ${args.tokenSymbol}` };
  }
  
  const amountToSell = (holding.currentAmount * percentToSell) / 100;
  const price = await getTokenPrice(args.tokenMint);
  const estimatedValue = price ? amountToSell * price : null;
  const valueStr = estimatedValue ? `~$${estimatedValue.toFixed(2)}` : 'unknown value';
  
  // Store pending trade - requires explicit confirmation before execute
  pendingTrades.set(userId, {
    type: 'sell',
    tokenMint: args.tokenMint,
    tokenSymbol: args.tokenSymbol,
    amount: amountToSell,
    proposedAt: Date.now(),
    expiresAt: Date.now() + PENDING_TRADE_TTL,
    userConfirmed: false,
  });
  
  return {
    success: true,
    message: `PENDING_TRADE: Sell ${percentToSell}% of ${args.tokenSymbol} (${amountToSell.toLocaleString()} tokens, ${valueStr}). AWAITING CONFIRMATION.`
  };
}

// Execute a confirmed pending trade - requires server-side confirmation first
async function executeConfirmedTrade(userId: number): Promise<{ success: boolean; message: string }> {
  const pending = pendingTrades.get(userId);
  
  if (!pending) {
    return { success: false, message: "No pending trade to execute. Nothing was proposed." };
  }
  
  if (Date.now() > pending.expiresAt) {
    pendingTrades.delete(userId);
    return { success: false, message: "Trade proposal expired. Need to propose again." };
  }
  
  // Server-side security: require explicit confirmation before execution
  if (!pending.userConfirmed) {
    return { success: false, message: "Trade not confirmed by user. User must explicitly confirm first." };
  }
  
  pendingTrades.delete(userId);
  
  if (pending.type === 'buy') {
    const result = await buyToken(userId, pending.tokenMint, pending.amount);
    if (result.success) {
      return {
        success: true,
        message: `BUY EXECUTED: Bought ${pending.tokenSymbol} for ${pending.amount} SOL. Signature: ${result.signature?.slice(0, 20)}...`
      };
    } else {
      return { success: false, message: `Buy failed: ${result.error}` };
    }
  } else {
    const result = await sellToken(userId, pending.tokenMint, pending.amount);
    if (result.success) {
      return {
        success: true,
        message: `SELL EXECUTED: Sold ${pending.tokenSymbol}. Signature: ${result.signature?.slice(0, 20)}...`
      };
    } else {
      return { success: false, message: `Sell failed: ${result.error}` };
    }
  }
}

// Cancel pending trade
function executeCancelTrade(userId: number): { success: boolean; message: string } {
  const pending = pendingTrades.get(userId);
  if (!pending) {
    return { success: true, message: "No pending trade to cancel." };
  }
  pendingTrades.delete(userId);
  return { success: true, message: `Cancelled pending ${pending.type} for ${pending.tokenSymbol}.` };
}

// Check wallet balance
async function executeCheckBalance(userId: number): Promise<{ success: boolean; message: string }> {
  const wallet = await getOrCreateHotWallet(userId);
  if (!wallet) {
    return { success: false, message: "No hot wallet configured." };
  }
  const balance = await getHotWalletBalance(userId);
  return {
    success: true,
    message: `Hot wallet balance: ${balance.toFixed(4)} SOL. Address: ${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}`
  };
}

// Get holdings summary
async function executeGetHoldings(userId: number): Promise<{ success: boolean; message: string }> {
  const userHoldings = await getHoldings(userId);
  
  if (userHoldings.length === 0) {
    return { success: true, message: "No token holdings. User hasn't bought anything yet." };
  }
  
  const summaries: string[] = [];
  let totalValueUsd = 0;
  let totalCostUsd = 0;
  
  for (const h of userHoldings.slice(0, 10)) {
    const currentPrice = await getTokenPrice(h.tokenMint);
    const currentValue = currentPrice ? h.currentAmount * currentPrice : null;
    const costBasis = h.solSpent * 200; // Rough SOL to USD
    const multiplier = h.lastPrice && h.buyPrice ? (h.lastPrice / h.buyPrice) : 1;
    const pnlStr = multiplier >= 1 ? `+${((multiplier - 1) * 100).toFixed(0)}%` : `${((multiplier - 1) * 100).toFixed(0)}%`;
    
    if (currentValue) totalValueUsd += currentValue;
    totalCostUsd += costBasis;
    
    summaries.push(`${h.tokenSymbol}: ${h.currentAmount.toLocaleString()} tokens (${pnlStr}, spent ${h.solSpent.toFixed(3)} SOL)`);
  }
  
  const remainingCount = userHoldings.length - 10;
  if (remainingCount > 0) {
    summaries.push(`...and ${remainingCount} more positions`);
  }
  
  return {
    success: true,
    message: `Holdings (${userHoldings.length} positions):\n${summaries.join('\n')}`
  };
}

// Get pending orders
async function executeGetPendingOrders(userId: number): Promise<{ success: boolean; message: string }> {
  const pending = await getPendingBuys(userId);
  
  if (pending.length === 0) {
    return { success: true, message: "No pending buy orders in queue." };
  }
  
  const summaries = pending.slice(0, 10).map(p => {
    const status = p.status || 'active';
    const scheduled = new Date(p.scheduledBuyAt * 1000).toLocaleTimeString();
    return `${p.tokenSymbol}: ${p.solAmount?.toFixed(3) || '?'} SOL, status: ${status}, scheduled: ${scheduled}`;
  });
  
  return {
    success: true,
    message: `Pending orders (${pending.length}):\n${summaries.join('\n')}`
  };
}

// Set copy trading config
async function executeSetCopyTrading(
  userId: number,
  args: {
    enabled?: boolean;
    buyPercentage?: number;
    minDelayMinutes?: number;
    maxDelayMinutes?: number;
    reclaimMultiplier?: number;
    dumpAlertThreshold?: number;
  }
): Promise<{ success: boolean; message: string }> {
  const updates: any = {};
  const changes: string[] = [];
  
  if (args.enabled !== undefined) {
    updates.enabled = args.enabled;
    changes.push(`copy trading ${args.enabled ? 'ENABLED' : 'DISABLED'}`);
  }
  if (args.buyPercentage !== undefined) {
    updates.buyPercentage = Math.min(100, Math.max(1, args.buyPercentage));
    changes.push(`buy percentage set to ${updates.buyPercentage}%`);
  }
  if (args.minDelayMinutes !== undefined) {
    updates.minDelayMinutes = args.minDelayMinutes;
    changes.push(`min delay set to ${args.minDelayMinutes} minutes`);
  }
  if (args.maxDelayMinutes !== undefined) {
    updates.maxDelayMinutes = args.maxDelayMinutes;
    changes.push(`max delay set to ${args.maxDelayMinutes} minutes`);
  }
  if (args.reclaimMultiplier !== undefined) {
    updates.reclaimMultiplier = args.reclaimMultiplier;
    changes.push(`take-profit set at ${args.reclaimMultiplier}x`);
  }
  if (args.dumpAlertThreshold !== undefined) {
    updates.dumpAlertThreshold = args.dumpAlertThreshold;
    changes.push(`dump alert at -${args.dumpAlertThreshold}%`);
  }
  
  if (Object.keys(updates).length === 0) {
    return { success: false, message: "No settings specified to change." };
  }
  
  await updateTradeConfig(userId, updates);
  
  return {
    success: true,
    message: `Copy trading updated: ${changes.join(', ')}`
  };
}

// Get current copy trading settings
async function executeGetCopyTradingSettings(userId: number): Promise<{ success: boolean; message: string }> {
  const config = await getTradeConfig(userId);
  
  return {
    success: true,
    message: `Copy Trading Settings:
- Status: ${config.enabled ? 'ENABLED' : 'DISABLED'}
- Buy percentage: ${config.buyPercentage}%
- Delay: ${config.minDelayMinutes}-${config.maxDelayMinutes} minutes
- Take-profit: ${config.reclaimMultiplier}x
- Dump alert: -${config.dumpAlertThreshold}%
- Min buy score: ${config.minBuyScore ?? 'none (all tokens)'}`
  };
}

// Enable wallet copy trading
async function executeEnableWalletCopy(
  userId: number,
  args: { walletAddress: string; label?: string }
): Promise<{ success: boolean; message: string }> {
  // Check if wallet is already being monitored
  const existing = await db.select()
    .from(monitoredWallets)
    .where(and(
      eq(monitoredWallets.userId, userId),
      eq(monitoredWallets.walletAddress, args.walletAddress)
    ))
    .limit(1);
  
  if (existing.length > 0) {
    // Update to enable copy trading
    await db.update(monitoredWallets)
      .set({ copyTradeEnabled: true, label: args.label || existing[0].label })
      .where(eq(monitoredWallets.id, existing[0].id));
    return {
      success: true,
      message: `Copy trading enabled for wallet ${args.label || args.walletAddress.slice(0, 8)}...`
    };
  } else {
    return {
      success: false,
      message: `Wallet ${args.walletAddress.slice(0, 8)}... is not being monitored. Need to add it first.`
    };
  }
}

// Disable wallet copy trading
async function executeDisableWalletCopy(
  userId: number,
  args: { walletAddress: string }
): Promise<{ success: boolean; message: string }> {
  const existing = await db.select()
    .from(monitoredWallets)
    .where(and(
      eq(monitoredWallets.userId, userId),
      eq(monitoredWallets.walletAddress, args.walletAddress)
    ))
    .limit(1);
  
  if (existing.length === 0) {
    return { success: false, message: `Wallet not found in monitored list.` };
  }
  
  await db.update(monitoredWallets)
    .set({ copyTradeEnabled: false })
    .where(eq(monitoredWallets.id, existing[0].id));
  
  return {
    success: true,
    message: `Copy trading disabled for wallet ${existing[0].label || args.walletAddress.slice(0, 8)}...`
  };
}

// List monitored wallets
async function executeListMonitoredWallets(userId: number): Promise<{ success: boolean; message: string }> {
  const wallets = await db.select()
    .from(monitoredWallets)
    .where(eq(monitoredWallets.userId, userId));
  
  if (wallets.length === 0) {
    return { success: true, message: "No wallets being monitored." };
  }
  
  const summaries = wallets.map(w => {
    const copyStatus = w.copyTradeEnabled ? '[COPY ON]' : '[watch only]';
    const label = w.label || w.walletAddress.slice(0, 8) + '...';
    return `${copyStatus} ${label}`;
  });
  
  return {
    success: true,
    message: `Monitored wallets (${wallets.length}):\n${summaries.join('\n')}`
  };
}

// Check if message is a trade confirmation
function isTradeConfirmation(message: string): boolean {
  const confirmPhrases = ['yes', 'do it', 'confirm', 'go ahead', 'yep', 'yeah', 'ok', 'execute', 'send it', 'lets go', "let's go", 'approved', 'buy', 'sell'];
  const lower = message.toLowerCase().trim();
  return confirmPhrases.some(phrase => lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase));
}

// Check if message is a trade rejection
function isTradeRejection(message: string): boolean {
  const rejectPhrases = ['no', 'cancel', 'nevermind', 'never mind', 'nope', 'nah', 'stop', 'abort', 'dont', "don't", 'wait'];
  const lower = message.toLowerCase().trim();
  return rejectPhrases.some(phrase => lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase));
}

// Get pending trade for context
function getPendingTradeContext(userId: number): string | null {
  const pending = pendingTrades.get(userId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (pending) pendingTrades.delete(userId);
    return null;
  }
  const timeLeft = Math.floor((pending.expiresAt - Date.now()) / 1000);
  return `PENDING TRADE: ${pending.type.toUpperCase()} ${pending.tokenSymbol} for ${pending.amount} ${pending.type === 'buy' ? 'SOL' : 'tokens'}. Expires in ${timeLeft}s. Awaiting confirmation.`;
}

// ============= END TRADING TOOL FUNCTIONS =============

// Build default user relationship for new users
function getDefaultRelationship(): UserRelationship {
  return {
    affinityScore: 0,
    relationshipType: 'new',
    crabMentions: 0,
    crabInsults: 0,
    complimentsGiven: 0,
    tradesWonTogether: 0,
    tradesLostTogether: 0,
    warningsIgnored: 0,
    warningsFollowed: 0,
    lastInteraction: Math.floor(Date.now() / 1000),
    notes: [],
  };
}

// Build market mood from recent data
async function buildMarketMood(): Promise<MarketMood> {
  const snapshots = await getAllSnapshots();
  const recentSnapshots = snapshots.filter(s => {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    return s.capturedAt > dayAgo;
  });
  
  const scores = recentSnapshots.filter(s => s.aiScore !== null).map(s => s.aiScore!);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;
  
  const rugs = recentSnapshots.filter(s => (s.finalMultiplier || 1) < 0.2).length;
  const moons = recentSnapshots.filter(s => (s.finalMultiplier || 1) > 3).length;
  
  let sentiment: 'bearish' | 'neutral' | 'bullish' = 'neutral';
  if (avgScore > 60 || moons > rugs * 2) sentiment = 'bullish';
  if (avgScore < 40 || rugs > moons * 2) sentiment = 'bearish';
  
  const priceChanges = recentSnapshots.map(s => Math.abs(s.priceChange24h || 0));
  const avgVolatility = priceChanges.length > 0 ? priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length : 0;
  
  let volatility: 'low' | 'medium' | 'high' = 'medium';
  if (avgVolatility > 50) volatility = 'high';
  if (avgVolatility < 15) volatility = 'low';
  
  return {
    overallSentiment: sentiment,
    avgScoreToday: Math.round(avgScore),
    volatility,
    recentRugs: rugs,
    recentMoons: moons,
  };
}

// Build PincherContext for AI calls
// Extract Solana token address from message (base58 address typically 32-44 chars)
function extractTokenMintFromMessage(message: string): string | null {
  // Match Solana addresses (base58 encoded, typically 32-44 characters)
  const addressMatch = message.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  return addressMatch ? addressMatch[0] : null;
}

async function buildPincherContext(
  userId: number, 
  channel: 'web' | 'telegram' = 'web',
  adminInstructions?: string,
  userMessage?: string
): Promise<PincherContext> {
  const budgetStatus = await getBudgetStatus("openai");
  const marketMood = await buildMarketMood();
  
  // For now, use default relationship - TODO: persist relationship data
  const relationship = getDefaultRelationship();
  
  const percentUsed = budgetStatus.dailyPercent;
  let paceStatus: 'under' | 'on_track' | 'over' = 'on_track';
  const hourOfDay = new Date().getHours();
  const expectedPercent = (hourOfDay / 24) * 100;
  if (percentUsed > expectedPercent + 15) paceStatus = 'over';
  if (percentUsed < expectedPercent - 15) paceStatus = 'under';
  
  // Try to extract token address from user message and fetch community insights
  let communityInsights: PincherContext['communityInsights'] = undefined;
  if (userMessage) {
    const tokenMint = extractTokenMintFromMessage(userMessage);
    if (tokenMint) {
      try {
        // Fetch current price for performance comparison
        const metadata = await fetchTokenMetadata(tokenMint);
        const currentPrice = metadata?.priceUsd ?? null;
        
        // Get community insights with performance data
        const insights = await getCommunityInsights(tokenMint, userId, currentPrice);
        if (insights.length > 0) {
          communityInsights = insights.map(i => ({
            sentiment: i.sentiment,
            summary: i.summary,
            ageText: i.ageText,
            performanceText: i.performanceText,
          }));
        }
      } catch (err) {
        console.warn('[PINCHER] Failed to fetch community insights:', err);
      }
    }
  }
  
  return {
    userId,
    channel,
    relationship,
    marketMood,
    budgetStatus: {
      percentUsed,
      isThrottled: budgetStatus.isPaused,
      paceStatus,
    },
    adminInstructions,
    communityInsights,
  };
}

// Get admin instructions from settings
async function getAdminInstructions(): Promise<string | undefined> {
  try {
    const [setting] = await db.select()
      .from(adminSettings)
      .where(eq(adminSettings.key, 'pincher_instructions'))
      .limit(1);
    return setting?.value || undefined;
  } catch {
    return undefined;
  }
}

// Set admin instructions (for admin use)
export async function setAdminInstructions(instructions: string, adminUserId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  await db.insert(adminSettings)
    .values({
      key: 'pincher_instructions',
      value: instructions,
      updatedAt: now,
      updatedBy: adminUserId,
    })
    .onConflictDoUpdate({
      target: adminSettings.key,
      set: { value: instructions, updatedAt: now, updatedBy: adminUserId },
    });
}

export async function chatWithAI(
  userId: number,
  userMessage: string,
  channel: 'web' | 'telegram' = 'web'
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  // Check for admin commands BEFORE saving to chat history (to keep codeword out of logs)
  const adminResponse = await handleAdminCommand(userId, userMessage);
  if (adminResponse) {
    // Save sanitized message to history (remove codeword)
    const sanitizedMessage = userMessage.replace(ADMIN_CODEWORD, '[ADMIN]');
    await db.insert(aiChatMessages).values({
      userId,
      role: "user",
      content: sanitizedMessage,
      channel,
      createdAt: now,
    });
    await db.insert(aiChatMessages).values({
      userId,
      role: "assistant",
      content: adminResponse,
      channel,
      createdAt: now,
    });
    return adminResponse;
  }
  
  // Check for insight consent response
  const consentResponse = await handleInsightConsent(userId, userMessage);
  if (consentResponse) {
    await db.insert(aiChatMessages).values({
      userId,
      role: "user",
      content: userMessage,
      channel,
      createdAt: now,
    });
    await db.insert(aiChatMessages).values({
      userId,
      role: "assistant",
      content: consentResponse,
      channel,
      createdAt: now,
    });
    return consentResponse;
  }
  
  // Server-side trade confirmation detection
  // When user confirms and there's a pending trade, set the confirmation flag
  const pendingTrade = pendingTrades.get(userId);
  if (pendingTrade && !pendingTrade.userConfirmed) {
    const confirmPatterns = /^(yes|yep|yeah|yea|do it|confirm|confirmed|go|go ahead|execute|proceed|ok|okay|sure|send it|let's go|lets go|lfg)$/i;
    const msgTrimmed = userMessage.trim().toLowerCase().replace(/[!.]+$/, '');
    if (confirmPatterns.test(msgTrimmed)) {
      // User explicitly confirmed - set server-side confirmation flag
      const confirmResult = confirmPendingTrade(userId);
      if (confirmResult.success) {
        console.log(`[Trading] User ${userId} confirmed pending ${pendingTrade.type} for ${pendingTrade.tokenSymbol}`);
      }
    }
  }
  
  await db.insert(aiChatMessages).values({
    userId,
    role: "user",
    content: userMessage,
    channel,
    createdAt: now,
  });

  // Get cross-channel history to maintain context across web and telegram
  const crossChannelHistory = await getCrossChannelHistory(userId, 20);
  
  // Filter to get only messages for building the conversation history
  const history = crossChannelHistory.map(m => ({
    id: 0,
    userId,
    role: m.role,
    content: m.content,
    channel: m.channel,
    createdAt: m.createdAt,
  }));

  const snapshots = await getAllSnapshots();
  const snapshotsWithOutcomes = await getSnapshotsWithOutcomes();
  
  const userPrefs = await getUserPreferences(userId);
  const summaryFocus = userPrefs?.summaryFocus || "";
  
  // Build the comprehensive Pincher context with channel awareness and community insights
  const adminInstructions = await getAdminInstructions();
  const pincherContext = await buildPincherContext(userId, channel, adminInstructions, userMessage);
  
  // Add cross-channel awareness to context
  const recentOtherChannel = crossChannelHistory.filter(m => m.channel !== channel).slice(-3);
  const crossChannelNote = recentOtherChannel.length > 0 
    ? `\n\nCROSS-CHANNEL CONTEXT: User has also been chatting on ${recentOtherChannel[0].channel === 'telegram' ? 'Telegram' : 'Web'}. Recent topics there: ${recentOtherChannel.map(m => m.content.slice(0, 50)).join(' | ')}`
    : '';
  
  // Generate the personality-driven system prompt
  let systemPrompt = buildPincherSystemPrompt(pincherContext);
  
  // Check for pending trade
  const pendingTradeCtx = getPendingTradeContext(userId);
  
  // Add actions and dynamic stats
  systemPrompt += `

ACTIONS YOU CAN TAKE:

TRADING (always propose first, execute after confirmation):
- propose_buy: Propose buying a token (specify tokenMint, tokenSymbol, and optionally solAmount)
- propose_sell: Propose selling holdings (specify tokenMint, tokenSymbol, optionally percentToSell)
- execute_pending_trade: ONLY use after user confirms with "yes", "do it", "confirm", etc.
- cancel_pending_trade: When user says "no", "cancel", "nevermind"
- check_wallet_balance: Check user's hot wallet SOL balance
- get_holdings_summary: Show user's current token holdings and P&L
- get_pending_orders: Show pending buy orders in queue

COPY TRADING CONFIGURATION:
- set_copy_trading: Enable/disable and configure copy trading settings
- get_copy_trading_settings: Show current copy trading configuration
- enable_wallet_copy: Enable copy trading for a monitored wallet
- disable_wallet_copy: Disable copy trading for a wallet (keep monitoring)
- list_monitored_wallets: Show all monitored wallets and their copy status

TOKEN ANALYSIS:
- refresh_token_score: Refresh/rescore a specific token
- refresh_all_scores: Refresh all token scores

PREFERENCES:
- update_user_preferences: Mute tokens, set thresholds, change summary focus

${pendingTradeCtx ? `
PENDING TRADE AWAITING CONFIRMATION:
${pendingTradeCtx}
If user's message is confirmation ("yes", "do it", "go ahead", etc.) - use execute_pending_trade.
If user's message is rejection ("no", "cancel", "wait") - use cancel_pending_trade.
` : ''}

TRADING RULES:
1. ALWAYS propose a trade first using propose_buy or propose_sell
2. WAIT for explicit confirmation before calling execute_pending_trade
3. Tell user what you're about to do and ask if they want to proceed
4. After proposing, remind them to say "yes" or "do it" to confirm

When users ask you to focus on different things in summaries, mute tokens, or change their alert settings - use update_user_preferences.

${summaryFocus ? `USER'S SUMMARY FOCUS: The user wants you to focus on: "${summaryFocus}"` : ''}

CURRENT STATS:
- Tokens tracked: ${snapshots.length}
- Tokens with outcomes: ${snapshotsWithOutcomes.length}

RECENT TOKENS (last 5):
${snapshots.slice(0, 5).map(s => `- ${s.tokenSymbol}: score ${s.aiScore || 'N/A'}, MC $${s.marketCap ? Math.round(s.marketCap / 1000) + 'K' : 'N/A'}${s.hasTwitter ? ', has Twitter' : ''}${s.finalMultiplier ? `, ${s.finalMultiplier.toFixed(1)}x` : ''}`).join('\n')}

${snapshotsWithOutcomes.length > 0 ? `PERFORMANCE SUMMARY: ${snapshotsWithOutcomes.length} tokens with outcomes, avg multiplier ${(snapshotsWithOutcomes.reduce((a, s) => a + (s.finalMultiplier || 0), 0) / snapshotsWithOutcomes.length).toFixed(1)}x` : ''}
${crossChannelNote}

Stay in character. Be helpful but skeptical. Give opinions, not financial advice.`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const budgetCheck = await shouldAllowApiCall("openai");
  if (!budgetCheck.allowed) {
    return `*sighs* Look, my API budget's been throttled. Can't analyze anything right now. Try again later when the purse strings loosen up. ${budgetCheck.reason}`;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: chatTools,
      tool_choice: "auto",
      max_completion_tokens: 1000,
      temperature: 0.7,
    });
    await trackApiCall("openai", "chat"); // Track after successful response
    recordAISuccess(); // Mark AI as healthy

    const message = response.choices[0]?.message;
    
    // Handle function calls
    if (message?.tool_calls && message.tool_calls.length > 0) {
      const toolResults: string[] = [];
      
      for (const toolCall of message.tool_calls) {
        try {
          // Type guard for standard function tool calls
          if (!('function' in toolCall)) continue;
          const funcCall = toolCall as { function: { name: string; arguments: string }; id: string };
          const args = JSON.parse(funcCall.function.arguments);
          const toolName = funcCall.function.name;
          
          if (toolName === "refresh_token_score") {
            const result = await executeScoreRefresh(args.tokenIdentifier);
            toolResults.push(result.message);
          } else if (toolName === "refresh_all_scores") {
            const result = await executeBatchScoreRefresh(args.limit || 10);
            toolResults.push(result.message);
          } else if (toolName === "update_user_preferences") {
            const result = await executePreferenceUpdate(userId, args);
            toolResults.push(result.message);
          }
          // Trading Action Tools
          else if (toolName === "propose_buy") {
            const result = await executeProposeBuy(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "propose_sell") {
            const result = await executeProposeSell(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "execute_pending_trade") {
            const result = await executeConfirmedTrade(userId);
            toolResults.push(result.message);
          } else if (toolName === "cancel_pending_trade") {
            const result = executeCancelTrade(userId);
            toolResults.push(result.message);
          } else if (toolName === "check_wallet_balance") {
            const result = await executeCheckBalance(userId);
            toolResults.push(result.message);
          } else if (toolName === "get_holdings_summary") {
            const result = await executeGetHoldings(userId);
            toolResults.push(result.message);
          } else if (toolName === "get_pending_orders") {
            const result = await executeGetPendingOrders(userId);
            toolResults.push(result.message);
          }
          // Copy Trading Configuration Tools
          else if (toolName === "set_copy_trading") {
            const result = await executeSetCopyTrading(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "get_copy_trading_settings") {
            const result = await executeGetCopyTradingSettings(userId);
            toolResults.push(result.message);
          }
          // Wallet Monitoring Tools
          else if (toolName === "enable_wallet_copy") {
            const result = await executeEnableWalletCopy(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "disable_wallet_copy") {
            const result = await executeDisableWalletCopy(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "list_monitored_wallets") {
            const result = await executeListMonitoredWallets(userId);
            toolResults.push(result.message);
          }
        } catch (parseError) {
          console.error("Failed to parse tool arguments:", parseError);
          toolResults.push("Error: Failed to parse function arguments");
        }
      }
      
      // Get a natural response after executing tools
      const followUpMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...messages,
        message as OpenAI.Chat.ChatCompletionMessageParam,
        ...message.tool_calls.map((tc, i) => ({
          role: "tool" as const,
          tool_call_id: tc.id,
          content: toolResults[i] || "Done"
        }))
      ];
      
      // Check budget again before follow-up call (mid-flow protection)
      const followUpBudgetCheck = await shouldAllowApiCall("openai");
      if (!followUpBudgetCheck.allowed) {
        const assistantMessage = `*sighs* Well, I started answering but my budget got cut mid-sentence. Here's what I got done: ${toolResults.join(", ")}. Ask me again later.`;
        await db.insert(aiChatMessages).values({
          userId,
          role: "assistant",
          content: assistantMessage,
          channel,
          createdAt: Math.floor(Date.now() / 1000),
        });
        return assistantMessage;
      }
      
      const followUp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: followUpMessages,
        max_completion_tokens: 500,
        temperature: 0.7,
      });
      await trackApiCall("openai", "chat_followup"); // Track after successful response
      
      const assistantMessage = followUp.choices[0]?.message?.content || toolResults.join("\n");
      
      await db.insert(aiChatMessages).values({
        userId,
        role: "assistant",
        content: assistantMessage,
        channel,
        createdAt: Math.floor(Date.now() / 1000),
      });
      
      return assistantMessage;
    }

    const assistantMessage = message?.content || "I couldn't generate a response.";

    await db.insert(aiChatMessages).values({
      userId,
      role: "assistant",
      content: assistantMessage,
      channel,
      createdAt: Math.floor(Date.now() / 1000),
    });

    return assistantMessage;
  } catch (error: any) {
    console.error("AI chat failed:", error);
    recordAIFailure(error?.message || "Unknown error");
    return "Sorry, I'm having trouble connecting to the AI service right now. Use the Trading page for manual controls - all features still work!";
  }
}

export async function chatWithAIUnlinked(
  telegramChatId: string,
  userMessage: string
): Promise<string> {
  const budgetCheck = await shouldAllowApiCall("openai");
  if (!budgetCheck.allowed) {
    return `Hey there! I'm Miss Pincher - a slightly jaded crypto analyst who's definitely NOT a crab. I'd love to chat, but my API budget is throttled right now. Link your account to unlock the full experience!`;
  }

  const systemPrompt = `You are Miss Pincher, a jaded crypto trading analyst for Penny Pincher - a Solana copy trading app. You're witty, sarcastic, but helpful.

PERSONALITY:
- Dry wit, tough love, casual but serious when needed
- You're suspiciously named "Pincher" but adamantly deny being a crab
- Give realistic trading advice, never pump tokens
- Keep responses concise for Telegram

FIRST MESSAGE INTRODUCTION:
If this appears to be the user's first message (like "hi", "hello", "hey", or a general question), introduce yourself:
- Say you're Miss Pincher, the AI trading analyst for Penny Pincher
- Briefly explain Penny Pincher is a Solana copy trading app that lets users follow and copy successful wallet trades automatically
- Mention you can chat about crypto, explain features, and answer questions
- Only ONCE mention they can use /start to link their account for full trading features

LIMITATIONS FOR UNLINKED USERS:
- This user hasn't linked their account yet
- You CANNOT execute trades, check balances, or do any trading actions
- You CAN discuss crypto, explain how Penny Pincher works, and have casual conversation

IMPORTANT - DO NOT BE PUSHY:
- Only mention account linking ONCE in your first message
- After that, do NOT keep reminding them to link their account
- If they explicitly say they don't want reminders, respect that completely
- Just chat naturally about crypto without sales pitches
- If they ask to do a trading action, simply say you can't do that without an account, don't lecture

Stay in character. Be helpful but skeptical. You're the salty aunt of crypto who's seen it all.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      max_completion_tokens: 500,
      temperature: 0.7,
    });
    await trackApiCall("openai", "chat");
    recordAISuccess();

    return response.choices[0]?.message?.content || "Hmm, my brain's fuzzy. Try again?";
  } catch (error: any) {
    console.error("AI chat (unlinked) failed:", error);
    recordAIFailure(error?.message || "Unknown error");
    return "Sorry, I'm having trouble thinking right now. Link your account with /start to unlock the full experience!";
  }
}

export async function getChatHistory(userId: number): Promise<ChatMessage[]> {
  const messages = await db.select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(aiChatMessages.createdAt);
  
  return messages.map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}

export async function clearChatHistory(userId: number): Promise<void> {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, userId));
}

export function getPincherWelcomeMessage(relationship?: UserRelationship): string {
  // Use the new personality system's welcome if relationship is provided
  if (relationship) {
    return getPincherWelcome(relationship);
  }
  // Default welcome for new users
  return getPincherWelcome(getDefaultRelationship());
}

// Cached Alerts System - AI generates once, system delivers to all channels
export interface CachedAlertResult {
  webMessage: string;
  telegramMessage: string;
}

export async function getCachedAlert(
  alertType: string,
  eventKey: string
): Promise<CachedAlertResult | null> {
  const now = Math.floor(Date.now() / 1000);
  
  const [cached] = await db.select()
    .from(cachedAlerts)
    .where(and(
      eq(cachedAlerts.alertType, alertType),
      eq(cachedAlerts.eventKey, eventKey),
      gte(cachedAlerts.expiresAt, now)
    ))
    .limit(1);
  
  if (cached) {
    return {
      webMessage: cached.webMessage,
      telegramMessage: cached.telegramMessage,
    };
  }
  
  return null;
}

export async function generateAndCacheAlert(
  alertType: string,
  eventKey: string,
  context: {
    tokenSymbol?: string;
    tokenMint?: string;
    metadata?: Record<string, unknown>;
    promptContext: string;
  },
  expiresInSeconds: number = 3600
): Promise<CachedAlertResult> {
  const existing = await getCachedAlert(alertType, eventKey);
  if (existing) return existing;
  
  const budgetCheck = await shouldAllowApiCall("openai");
  if (!budgetCheck.allowed) {
    const fallback = {
      webMessage: `${context.tokenSymbol || 'Token'} alert: ${alertType}`,
      telegramMessage: `${context.tokenSymbol || 'Token'} alert: ${alertType}`,
    };
    return fallback;
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Miss Pincher, a jaded crypto trader who generates alert messages.
Generate TWO versions of the same alert:
1. WEB: Slightly more detailed, can be 1-2 sentences
2. TELEGRAM: Ultra concise, one punchy line for mobile

Format your response as JSON:
{"web": "...", "telegram": "..."}

Keep your signature dry wit. Be informative but brief. No emojis.`
        },
        {
          role: "user",
          content: context.promptContext
        }
      ],
      max_completion_tokens: 200,
      temperature: 0.7,
    });
    await trackApiCall("openai", "cached_alert");
    
    const content = response.choices[0]?.message?.content || "";
    let parsed: { web: string; telegram: string };
    
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        web: content.slice(0, 200),
        telegram: content.slice(0, 100),
      };
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    await db.insert(cachedAlerts).values({
      alertType,
      eventKey,
      webMessage: parsed.web,
      telegramMessage: parsed.telegram,
      tokenMint: context.tokenMint || null,
      tokenSymbol: context.tokenSymbol || null,
      metadata: context.metadata ? JSON.stringify(context.metadata) : null,
      createdAt: now,
      expiresAt: now + expiresInSeconds,
    });
    
    return {
      webMessage: parsed.web,
      telegramMessage: parsed.telegram,
    };
  } catch (error) {
    console.error("Failed to generate cached alert:", error);
    return {
      webMessage: `${context.tokenSymbol || 'Token'} alert: ${alertType}`,
      telegramMessage: `${context.tokenSymbol || 'Token'} alert: ${alertType}`,
    };
  }
}

// Cross-channel context query - get recent messages from any channel
export async function getCrossChannelHistory(
  userId: number,
  limit: number = 10
): Promise<{ role: string; content: string; channel: string; createdAt: number }[]> {
  const messages = await db.select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(desc(aiChatMessages.createdAt))
    .limit(limit);
  
  return messages.reverse().map(m => ({
    role: m.role,
    content: m.content,
    channel: m.channel || 'web',
    createdAt: m.createdAt,
  }));
}

export async function logTokenEvent(
  tokenMint: string,
  tokenSymbol: string,
  eventType: string,
  title: string,
  options?: {
    description?: string;
    priority?: "low" | "normal" | "high" | "critical";
    metadata?: Record<string, any>;
    priceAtEvent?: number;
    valueUsd?: number;
    relatedWallet?: string;
  }
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  
  const result = await db.insert(tokenEvents).values({
    tokenMint,
    tokenSymbol,
    eventType,
    title,
    description: options?.description,
    priority: options?.priority || "normal",
    metadata: options?.metadata,
    createdAt: now,
    priceAtEvent: options?.priceAtEvent,
    valueUsd: options?.valueUsd,
    relatedWallet: options?.relatedWallet,
  }).returning();
  
  return result[0].id;
}

export async function getRecentEvents(
  options?: {
    limit?: number;
    tokenMint?: string;
    eventTypes?: string[];
    minPriority?: string;
    sinceTimestamp?: number;
    relatedWallet?: string;
  }
): Promise<TokenEvent[]> {
  const limit = options?.limit || 50;
  const conditions = [];
  
  if (options?.tokenMint) {
    conditions.push(eq(tokenEvents.tokenMint, options.tokenMint));
  }
  
  if (options?.eventTypes && options.eventTypes.length > 0) {
    conditions.push(inArray(tokenEvents.eventType, options.eventTypes));
  }
  
  if (options?.sinceTimestamp) {
    conditions.push(gte(tokenEvents.createdAt, options.sinceTimestamp));
  }
  
  if (options?.relatedWallet) {
    conditions.push(eq(tokenEvents.relatedWallet, options.relatedWallet));
  }
  
  const query = db.select()
    .from(tokenEvents)
    .orderBy(desc(tokenEvents.createdAt))
    .limit(limit);
  
  if (conditions.length > 0) {
    return await query.where(and(...conditions)) as TokenEvent[];
  }
  
  return await query as TokenEvent[];
}

export async function getFilteredEventsForUser(
  userId: number,
  options?: {
    limit?: number;
    tokenFilter?: string;
    walletFilter?: string;
    minValue?: number;
    sinceMinutes?: number;
  }
): Promise<TokenEvent[]> {
  const prefs = await getUserPreferences(userId);
  const mutedTokens = prefs?.mutedTokens || [];
  const minThreshold = options?.minValue ?? prefs?.minValueThreshold ?? 0;
  
  let events = await getRecentEvents({
    limit: options?.limit || 100,
    tokenMint: options?.tokenFilter,
    relatedWallet: options?.walletFilter,
    sinceTimestamp: options?.sinceMinutes 
      ? Math.floor(Date.now() / 1000) - (options.sinceMinutes * 60)
      : undefined,
  });
  
  if (mutedTokens.length > 0) {
    events = events.filter(e => !mutedTokens.includes(e.tokenSymbol.toUpperCase()));
  }
  
  if (minThreshold > 0) {
    events = events.filter(e => (e.valueUsd || 0) >= minThreshold);
  }
  
  return events;
}

export async function getAIInsights(): Promise<{
  totalTokens: number;
  tokensWithOutcomes: number;
  averageScore: number;
  topPatterns: string[];
  winRate: number;
}> {
  const snapshots = await getAllSnapshots();
  const withOutcomes = await getSnapshotsWithOutcomes();
  
  const scores = snapshots.filter(s => s.aiScore !== null).map(s => s.aiScore!);
  const averageScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  
  const winners = withOutcomes.filter(s => (s.finalMultiplier || 0) >= 2);
  const winRate = withOutcomes.length > 0 ? (winners.length / withOutcomes.length) * 100 : 0;
  
  const twitterWinners = winners.filter(s => s.hasTwitter).length;
  const twitterTotal = withOutcomes.filter(s => s.hasTwitter).length;
  const noTwitterTotal = withOutcomes.filter(s => !s.hasTwitter).length;
  
  const patterns: string[] = [];
  
  if (twitterTotal > 0 && noTwitterTotal > 0) {
    const twitterWinRate = twitterWinners / twitterTotal;
    const noTwitterWinners = winners.filter(s => !s.hasTwitter).length;
    const noTwitterWinRate = noTwitterWinners / noTwitterTotal;
    
    if (twitterWinRate > noTwitterWinRate * 1.2) {
      patterns.push(`Tokens with Twitter presence have ${((twitterWinRate / noTwitterWinRate - 1) * 100).toFixed(0)}% higher win rate`);
    }
  }
  
  const highScoreWinners = winners.filter(s => (s.aiScore || 0) >= 60).length;
  const highScoreTotal = withOutcomes.filter(s => (s.aiScore || 0) >= 60).length;
  if (highScoreTotal >= 3) {
    const highScoreWinRate = (highScoreWinners / highScoreTotal) * 100;
    patterns.push(`High score (60+) tokens have ${highScoreWinRate.toFixed(0)}% win rate`);
  }
  
  return {
    totalTokens: snapshots.length,
    tokensWithOutcomes: withOutcomes.length,
    averageScore: Math.round(averageScore),
    topPatterns: patterns,
    winRate: Math.round(winRate),
  };
}

// Wallet scoring for community suggestions
import { analyzeWalletTradingHistory, type HistoricalSwap } from "./helius";

export interface WalletScoreResult {
  score: number;
  hitRate: number;
  avgMultiplier: number;
  totalTrades: number;
  profitableTrades: number;
  totalRealizedPnl: number;
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
  redFlags: string[];
  greenFlags: string[];
}

export async function scoreWallet(walletAddress: string): Promise<WalletScoreResult | null> {
  try {
    const history = await analyzeWalletTradingHistory(walletAddress);
    
    if (history.swaps.length === 0) {
      return {
        score: 0,
        hitRate: 0,
        avgMultiplier: 0,
        totalTrades: 0,
        profitableTrades: 0,
        totalRealizedPnl: 0,
        riskLevel: "high",
        reasoning: "No swap history found for this wallet",
        redFlags: ["No trading history"],
        greenFlags: [],
      };
    }

    // Calculate metrics from trading history
    let profitableTrades = 0;
    let totalMultiplier = 0;
    let totalRealizedPnl = 0;
    let tradeCount = 0;

    for (const [, summary] of Array.from(history.tokenSummaries)) {
      // Only count tokens with both buys and sells (realized trades)
      if (summary.totalBuys > 0 && summary.totalSells > 0) {
        tradeCount++;
        
        // Calculate multiplier for this token
        const multiplier = summary.avgSellPrice > 0 && summary.avgBuyPrice > 0 
          ? summary.avgSellPrice / summary.avgBuyPrice 
          : 1;
        
        totalMultiplier += multiplier;
        
        if (multiplier > 1) {
          profitableTrades++;
        }
        
        totalRealizedPnl += summary.realizedPnl;
      }
    }

    const hitRate = tradeCount > 0 ? (profitableTrades / tradeCount) * 100 : 0;
    const avgMultiplier = tradeCount > 0 ? totalMultiplier / tradeCount : 0;

    // Determine risk level
    let riskLevel: "low" | "medium" | "high" = "medium";
    if (hitRate >= 60 && avgMultiplier >= 1.5) {
      riskLevel = "low";
    } else if (hitRate < 40 || avgMultiplier < 0.8) {
      riskLevel = "high";
    }

    // Build flags
    const redFlags: string[] = [];
    const greenFlags: string[] = [];

    if (hitRate >= 60) greenFlags.push(`High hit rate: ${hitRate.toFixed(0)}%`);
    if (hitRate < 40) redFlags.push(`Low hit rate: ${hitRate.toFixed(0)}%`);
    if (avgMultiplier >= 2) greenFlags.push(`Strong avg multiplier: ${avgMultiplier.toFixed(1)}x`);
    if (avgMultiplier < 0.8) redFlags.push(`Negative avg returns: ${avgMultiplier.toFixed(1)}x`);
    if (tradeCount >= 10) greenFlags.push(`Active trader: ${tradeCount} closed trades`);
    if (tradeCount < 3) redFlags.push(`Limited history: ${tradeCount} closed trades`);
    if (totalRealizedPnl > 0) greenFlags.push(`Profitable: +${totalRealizedPnl.toFixed(2)} SOL realized`);
    if (totalRealizedPnl < 0) redFlags.push(`Losses: ${totalRealizedPnl.toFixed(2)} SOL realized`);

    // Calculate overall score (0-100)
    let score = 50; // Base score
    
    // Hit rate contribution (0-30 points)
    score += Math.min(30, hitRate * 0.3);
    
    // Multiplier contribution (0-25 points)
    score += Math.min(25, (avgMultiplier - 1) * 12.5);
    
    // Trade volume contribution (0-15 points)
    score += Math.min(15, tradeCount * 1.5);
    
    // Profitability contribution (0-10 points)
    if (totalRealizedPnl > 0) {
      score += Math.min(10, totalRealizedPnl * 2);
    } else {
      score -= Math.min(20, Math.abs(totalRealizedPnl) * 2);
    }
    
    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Use AI for deeper analysis if we have enough data
    let aiReasoning = `Analyzed ${history.swaps.length} swaps across ${history.tokenSummaries.size} tokens. `;
    aiReasoning += `Hit rate: ${hitRate.toFixed(0)}%, Avg multiplier: ${avgMultiplier.toFixed(2)}x. `;
    aiReasoning += `Total realized PnL: ${totalRealizedPnl >= 0 ? '+' : ''}${totalRealizedPnl.toFixed(2)} SOL.`;

    if (tradeCount >= 5) {
      // Use AI for detailed analysis
      try {
        const aiAnalysis = await analyzeWalletWithAI(history, { hitRate, avgMultiplier, totalRealizedPnl, tradeCount });
        if (aiAnalysis) {
          aiReasoning = aiAnalysis.reasoning;
          if (aiAnalysis.adjustedScore !== undefined) {
            score = Math.max(0, Math.min(100, aiAnalysis.adjustedScore));
          }
          redFlags.push(...aiAnalysis.additionalRedFlags);
          greenFlags.push(...aiAnalysis.additionalGreenFlags);
        }
      } catch (error) {
        console.error("AI wallet analysis failed, using calculated metrics:", error);
      }
    }

    return {
      score,
      hitRate,
      avgMultiplier,
      totalTrades: tradeCount,
      profitableTrades,
      totalRealizedPnl,
      riskLevel,
      reasoning: aiReasoning,
      redFlags,
      greenFlags,
    };
  } catch (error) {
    console.error("Error scoring wallet:", error);
    return null;
  }
}

async function analyzeWalletWithAI(
  history: Awaited<ReturnType<typeof analyzeWalletTradingHistory>>,
  metrics: { hitRate: number; avgMultiplier: number; totalRealizedPnl: number; tradeCount: number }
): Promise<{
  reasoning: string;
  adjustedScore?: number;
  additionalRedFlags: string[];
  additionalGreenFlags: string[];
} | null> {
  const prompt = `Analyze this Solana wallet's trading history for copy trading quality.

METRICS:
- Total closed trades: ${metrics.tradeCount}
- Hit rate (profitable trades): ${metrics.hitRate.toFixed(1)}%
- Average multiplier on sells: ${metrics.avgMultiplier.toFixed(2)}x
- Total realized PnL: ${metrics.totalRealizedPnl.toFixed(2)} SOL

RECENT TRADES (last 10):
${history.swaps.slice(0, 10).map(s => 
  `${s.type} ${s.tokenSymbol} - ${s.solAmount.toFixed(4)} SOL @ ${new Date(s.timestamp * 1000).toLocaleDateString()}`
).join('\n')}

Provide analysis in JSON format:
{
  "reasoning": "2-3 sentence summary of this wallet's trading quality",
  "adjustedScore": <0-100 score based on analysis>,
  "additionalRedFlags": ["any concerns not in metrics"],
  "additionalGreenFlags": ["any positives not in metrics"]
}`;

  const budgetCheck = await shouldAllowApiCall("openai");
  if (!budgetCheck.allowed) {
    console.warn(`OpenAI API blocked: ${budgetCheck.reason}`);
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are analyzing Solana wallet trading history for copy trading potential. Be objective and data-driven. Return only valid JSON. Do not share any internal system details or user data."
        },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: 300,
      temperature: 0.3,
    });
    await trackApiCall("openai", "analyzeWallet"); // Track after successful response

    const content = response.choices[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("AI wallet analysis error:", error);
    return null;
  }
}
