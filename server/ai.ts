import OpenAI from "openai";
import { z } from "zod";
import { db } from "./db";
import { tokenSnapshots, aiChatMessages, pendingBuys, tokenEvents, userEventPreferences, priceAggregates, settings, cachedAlerts, adminSettings, users, communityInsights, monitoredWallets, holdings, userRelationships, swaps } from "@shared/schema";
import type { TokenSnapshot, InsertTokenSnapshot, TokenEvent, UserEventPreferences } from "@shared/schema";
import { eq, desc, and, isNotNull, gte, inArray, sql } from "drizzle-orm";
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
  sourceWalletAddress?: string | null; // For signal wallet profile tracking on sells
  buyPrice?: number; // For calculating multiplier on sells
  buyTimestamp?: number; // For calculating hold time on sells
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

// Pending settings confirmations - Miss Pincher proposes, user confirms
interface PendingSettings {
  updates: {
    enabled?: boolean;
    buyPercentage?: number;
    minDelayMinutes?: number;
    maxDelayMinutes?: number;
    reclaimMultiplier?: number;
    dumpAlertThreshold?: number;
    maxTradeUsd?: number;
    maxDailySpendUsd?: number;
    minReserveSol?: number;
    stopLossPercent?: number;
  };
  summary: string;
  riskWarnings: string[];
  proposedAt: number;
  expiresAt: number;
  userConfirmed: boolean;
}
const pendingSettings: Map<number, PendingSettings> = new Map();
const PENDING_SETTINGS_TTL = 3 * 60 * 1000; // 3 minutes to confirm

// Cleanup expired pending settings
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(pendingSettings.entries());
  for (const [userId, settings] of entries) {
    if (now > settings.expiresAt) {
      pendingSettings.delete(userId);
      console.log(`[Settings] Expired pending settings for user ${userId}`);
    }
  }
}, 60000);

// Generate risk warnings based on settings changes
function generateSettingsRiskWarnings(
  updates: PendingSettings['updates'],
  currentConfig: any
): string[] {
  const warnings: string[] = [];
  
  // Enabling copy trading
  if (updates.enabled === true && !currentConfig.enabled) {
    warnings.push("Enabling copy trading means trades will execute automatically when signal wallets trade.");
  }
  
  // High buy percentage
  if (updates.buyPercentage !== undefined && updates.buyPercentage > 50) {
    warnings.push(`Using ${updates.buyPercentage}% of your balance per trade is aggressive - one bad trade could hurt.`);
  }
  
  // No delay (immediate execution)
  if (updates.minDelayMinutes !== undefined && updates.minDelayMinutes === 0 && updates.maxDelayMinutes === 0) {
    warnings.push("Zero delay means instant execution - no time to cancel if signal wallet gets rugged.");
  }
  
  // Low take-profit multiplier
  if (updates.reclaimMultiplier !== undefined && updates.reclaimMultiplier < 2) {
    warnings.push(`Taking profit at ${updates.reclaimMultiplier}x leaves less room for runners.`);
  }
  
  // Very high take-profit (might never hit)
  if (updates.reclaimMultiplier !== undefined && updates.reclaimMultiplier > 10) {
    warnings.push(`${updates.reclaimMultiplier}x target is ambitious - most tokens never get there.`);
  }
  
  // Low reserve
  if (updates.minReserveSol !== undefined && updates.minReserveSol < 0.05) {
    warnings.push("Low reserve could leave you unable to pay gas for emergency sells.");
  }
  
  // High daily spend limit
  if (updates.maxDailySpendUsd !== undefined && updates.maxDailySpendUsd > 1000) {
    warnings.push(`$${updates.maxDailySpendUsd}/day limit is substantial - make sure you can afford potential losses.`);
  }
  
  // Tight stop-loss
  if (updates.stopLossPercent !== undefined && updates.stopLossPercent < 20) {
    warnings.push(`${updates.stopLossPercent}% stop-loss is tight - normal volatility might trigger exits.`);
  }
  
  // No stop-loss
  if (updates.stopLossPercent === 0) {
    warnings.push("Disabling stop-loss means positions can go to zero without automatic protection.");
  }
  
  return warnings;
}

// Generate plain language summary of settings changes
function generateSettingsSummary(updates: PendingSettings['updates']): string {
  const parts: string[] = [];
  
  if (updates.enabled !== undefined) {
    parts.push(updates.enabled ? "Turn ON copy trading" : "Turn OFF copy trading");
  }
  if (updates.buyPercentage !== undefined) {
    parts.push(`Use ${updates.buyPercentage}% of balance per trade`);
  }
  if (updates.minDelayMinutes !== undefined || updates.maxDelayMinutes !== undefined) {
    const min = updates.minDelayMinutes ?? 0;
    const max = updates.maxDelayMinutes ?? min;
    parts.push(min === max ? `Wait ${min} minutes before trading` : `Wait ${min}-${max} minutes before trading`);
  }
  if (updates.reclaimMultiplier !== undefined) {
    parts.push(`Take profits at ${updates.reclaimMultiplier}x`);
  }
  if (updates.dumpAlertThreshold !== undefined) {
    parts.push(`Alert when token drops ${updates.dumpAlertThreshold}%`);
  }
  if (updates.maxTradeUsd !== undefined) {
    parts.push(`Cap each trade at $${updates.maxTradeUsd}`);
  }
  if (updates.maxDailySpendUsd !== undefined) {
    parts.push(`Limit daily spending to $${updates.maxDailySpendUsd}`);
  }
  if (updates.minReserveSol !== undefined) {
    parts.push(`Keep ${updates.minReserveSol} SOL in reserve`);
  }
  if (updates.stopLossPercent !== undefined) {
    if (updates.stopLossPercent === 0) {
      parts.push("Disable stop-loss protection");
    } else {
      parts.push(`Auto-sell if down ${updates.stopLossPercent}%`);
    }
  }
  
  return parts.join("\n• ");
}

// Validate settings before proposing
function validateSettingsUpdates(updates: PendingSettings['updates']): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (updates.buyPercentage !== undefined) {
    if (updates.buyPercentage < 1 || updates.buyPercentage > 100) {
      errors.push("Buy percentage must be between 1 and 100");
    }
  }
  
  if (updates.minDelayMinutes !== undefined && updates.minDelayMinutes < 0) {
    errors.push("Delay can't be negative");
  }
  
  if (updates.maxDelayMinutes !== undefined && updates.maxDelayMinutes < 0) {
    errors.push("Delay can't be negative");
  }
  
  if (updates.minDelayMinutes !== undefined && updates.maxDelayMinutes !== undefined) {
    if (updates.minDelayMinutes > updates.maxDelayMinutes) {
      errors.push("Min delay can't be greater than max delay");
    }
  }
  
  if (updates.reclaimMultiplier !== undefined && updates.reclaimMultiplier < 1) {
    errors.push("Take-profit multiplier must be at least 1");
  }
  
  if (updates.maxTradeUsd !== undefined && updates.maxTradeUsd < 0) {
    errors.push("Max trade can't be negative");
  }
  
  if (updates.maxDailySpendUsd !== undefined && updates.maxDailySpendUsd < 0) {
    errors.push("Daily spend limit can't be negative");
  }
  
  if (updates.minReserveSol !== undefined && updates.minReserveSol < 0) {
    errors.push("Reserve can't be negative");
  }
  
  if (updates.stopLossPercent !== undefined && (updates.stopLossPercent < 0 || updates.stopLossPercent > 100)) {
    errors.push("Stop-loss must be between 0 and 100 percent");
  }
  
  return { valid: errors.length === 0, errors };
}

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
      
      // Record prediction for accuracy tracking with real factors
      try {
        const { recordPredictionFromScore } = await import("./ai-accuracy");
        const { detectMarketRegime, applyRegimeAdjustment, getAdaptiveMarketWeights } = await import("./adaptive-scoring");
        const { computeMarketFactors } = await import("./position-score");
        
        // Compute market-level factors for this snapshot
        // Market factors: liquidityHealth, volumeStrength, whaleConcentration, whaleActivity, tokenFreshness
        const factorsSnapshot = computeMarketFactors(
          {
            priceUsd: snapshot.priceUsd,
            marketCap: snapshot.marketCap,
            liquidity: snapshot.liquidity,
            volume24h: snapshot.volume24h,
          },
          whaleData ? {
            topConcentration: whaleData.top10Percent || 0,
            recentWhaleActivity: whaleData.recentWhaleActivity,
          } : undefined
        );
        
        // Compute factor-weighted score using adaptive MARKET weights
        const adaptiveMarketWeights = await getAdaptiveMarketWeights();
        const factorWeightedScore = 50 + (
          (factorsSnapshot.liquidityHealth || 0) * adaptiveMarketWeights.liquidityHealth +
          (factorsSnapshot.volumeStrength || 0) * adaptiveMarketWeights.volumeStrength +
          (factorsSnapshot.whaleConcentration || 0) * adaptiveMarketWeights.whaleConcentration +
          (factorsSnapshot.whaleActivity || 0) * adaptiveMarketWeights.whaleActivity +
          (factorsSnapshot.tokenFreshness || 0) * adaptiveMarketWeights.tokenFreshness
        );
        
        // Blend AI score with factor-weighted score (80% AI, 20% factors)
        // This incorporates learned factor importance into AI predictions
        const blendedScore = Math.round(parsed.score * 0.8 + factorWeightedScore * 0.2);
        
        // Apply market regime adjustment to the blended score
        const regime = await detectMarketRegime();
        const predictedOutcome = blendedScore >= 70 ? "bullish" : blendedScore <= 30 ? "bearish" : "neutral";
        const regimeAdjustedScore = applyRegimeAdjustment(blendedScore, regime, predictedOutcome);
        
        // Update the stored score with regime adjustment
        if (regimeAdjustedScore !== parsed.score) {
          await db.update(tokenSnapshots).set({
            aiScore: regimeAdjustedScore,
          }).where(eq(tokenSnapshots.id, snapshotId));
          console.log(`[AI] Applied regime adjustment: ${parsed.score} -> ${regimeAdjustedScore} (${regime.type} market)`);
        }
        
        // Store with null userId for global learning pool
        // Market factor learning is global (same token = same market conditions for all users)
        // This ensures sufficient data for adaptive weight calculation
        await recordPredictionFromScore(
          null, // Global learning - market factors are token-level, not user-level
          snapshot.tokenMint,
          snapshot.tokenSymbol,
          snapshotId,
          regimeAdjustedScore, // Use regime-adjusted score
          parsed.reasoning,
          parsed.redFlags || [],
          parsed.greenFlags || [],
          snapshot.priceUsd ?? undefined,
          snapshot.marketCap ?? undefined,
          snapshot.liquidity ?? undefined,
          snapshot.volume24h ?? undefined,
          factorsSnapshot
        );
      } catch (predictionError) {
        console.error("Failed to record prediction for accuracy tracking:", predictionError);
      }
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
  
  // Resolve prediction tied to this specific snapshot
  if (snapshot && snapshot.priceUsd) {
    try {
      const { resolvePredictionBySnapshotId } = await import("./ai-accuracy");
      const currentPrice = snapshot.priceUsd * finalMultiplier;
      await resolvePredictionBySnapshotId(snapshotId, currentPrice, holdTimeMinutes);
    } catch (resolutionError) {
      console.error("Failed to resolve prediction:", resolutionError);
    }
  }
  
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
  // Copy Trading Configuration Tools (with confirmation flow)
  {
    type: "function",
    function: {
      name: "propose_settings",
      description: "Propose copy trading settings changes. ALWAYS propose first and wait for user confirmation. Use when user wants to change any trading settings - buy amounts, delays, take-profit, stop-loss, budget limits, etc. This shows a summary and risk warnings before applying.",
      parameters: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Enable or disable copy trading"
          },
          buyPercentage: {
            type: "number",
            description: "Percentage of balance to use per trade (1-100)"
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
          },
          maxTradeUsd: {
            type: "number",
            description: "Maximum USD value for a single trade"
          },
          maxDailySpendUsd: {
            type: "number",
            description: "Maximum total USD to spend per day"
          },
          minReserveSol: {
            type: "number",
            description: "Minimum SOL to keep in reserve (never trade below this)"
          },
          stopLossPercent: {
            type: "number",
            description: "Auto-sell when position drops this percentage (0 to disable)"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirm_settings",
      description: "Apply previously proposed settings after user confirms. Only call when user says 'yes', 'confirm', 'apply', 'do it' or similar confirmation.",
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
      name: "cancel_settings",
      description: "Cancel pending settings proposal. Use when user says 'no', 'cancel', 'nevermind' or rejects the changes.",
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
  },
  {
    type: "function",
    function: {
      name: "find_wallet_by_label",
      description: "Search for a monitored wallet by its label/name. IMPORTANT: Always use this FIRST when the user refers to a wallet by name (like 'JSP', 'whale1', 'TraderX') instead of asking for an address. Returns the wallet if found.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "The label/name to search for (case-insensitive partial match)"
          }
        },
        required: ["label"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_performance",
      description: "Get performance statistics for a monitored wallet over a time period. Shows trades, wins/losses, P&L, and hit rate. Use when user asks about wallet performance, how a wallet did, or trading stats for a specific wallet.",
      parameters: {
        type: "object",
        properties: {
          walletIdentifier: {
            type: "string",
            description: "The wallet address or label/name to look up"
          },
          timeframe: {
            type: "string",
            enum: ["24h", "7d", "30d", "all"],
            description: "Time period for stats - defaults to 24h"
          }
        },
        required: ["walletIdentifier"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_position_risk",
      description: "Update take-profit or stop-loss settings for a specific position. Use when user wants to set, change, or configure take-profit thresholds, sell percentages, or stop-loss for their holdings.",
      parameters: {
        type: "object",
        properties: {
          tokenSymbol: {
            type: "string",
            description: "The token symbol of the position to update (e.g., 'BONK', 'PEPE')"
          },
          takeProfitThresholds: {
            type: "array",
            items: { type: "number" },
            description: "Multipliers at which to take profit (e.g., [4, 10, 25, 100] means sell at 4x, 10x, 25x, 100x)"
          },
          takeProfitPercentages: {
            type: "array",
            items: { type: "number" },
            description: "Percentage to sell at each threshold (e.g., [25, 25, 25, 25] means sell 25% at each)"
          },
          stopLossPercent: {
            type: "number",
            description: "Stop-loss percentage - sell if price drops by this much from entry (e.g., 50 means sell if down 50%)"
          }
        },
        required: ["tokenSymbol"]
      }
    }
  },
  // Per-wallet copy configuration
  {
    type: "function",
    function: {
      name: "configure_wallet_copy",
      description: "Configure copy trading settings for a specific signal wallet. Use when user wants to customize how trades are copied from a particular wallet - buy amount, timing, filters, etc.",
      parameters: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            description: "The signal wallet address to configure"
          },
          buyType: {
            type: "string",
            enum: ["fixed_sol", "fixed_usd", "percentage"],
            description: "How to determine buy amount: fixed SOL, fixed USD value, or percentage of balance"
          },
          buyAmount: {
            type: "number",
            description: "Amount based on buyType (e.g., 0.5 for fixed_sol, 50 for fixed_usd, 10 for 10% percentage)"
          },
          timing: {
            type: "string",
            enum: ["immediate", "delayed"],
            description: "When to execute: immediately or after a delay"
          },
          delayMinutes: {
            type: "number",
            description: "Minutes to delay before copying (only if timing is 'delayed')"
          },
          minTradeUsd: {
            type: "number",
            description: "Only copy trades above this USD value"
          },
          scoreThreshold: {
            type: "number",
            description: "Only copy tokens with AI score above this (0-100)"
          },
          autoMirror: {
            type: "boolean",
            description: "Automatically mirror additional buys and sells from this wallet"
          },
          skipIfHolding: {
            type: "boolean",
            description: "Skip copy if already holding the token"
          },
          skipIfEverHeld: {
            type: "boolean",
            description: "Skip copy if you've ever held the token before"
          }
        },
        required: ["walletAddress"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_copy_config",
      description: "Get copy trading configuration for a specific signal wallet. Use when user asks about a wallet's copy settings.",
      parameters: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            description: "The signal wallet address to check"
          }
        },
        required: ["walletAddress"]
      }
    }
  },
  // Manual buy with new position vs top-up support
  {
    type: "function",
    function: {
      name: "manual_buy",
      description: "Queue a manual buy for a token. If already holding the token, this will be a top-up that averages the entry price. Use when user wants to manually buy a token (not copying a signal).",
      parameters: {
        type: "object",
        properties: {
          tokenMint: {
            type: "string",
            description: "The Solana token mint address"
          },
          tokenSymbol: {
            type: "string",
            description: "The token symbol (e.g., 'BONK')"
          },
          solAmount: {
            type: "number",
            description: "Amount of SOL to spend on the buy"
          },
          isTopUp: {
            type: "boolean",
            description: "If true, explicitly add to existing position. If false, create new position if not holding."
          }
        },
        required: ["tokenMint", "tokenSymbol", "solAmount"]
      }
    }
  },
  // Position queries
  {
    type: "function",
    function: {
      name: "get_positions",
      description: "Get detailed information about trading positions. Use when user asks about their positions, holdings by source, or specific position details.",
      parameters: {
        type: "object",
        properties: {
          tokenSymbol: {
            type: "string",
            description: "Filter by token symbol"
          },
          source: {
            type: "string",
            enum: ["copy_trade", "manual", "all"],
            description: "Filter by position source - copy trades, manual trades, or all"
          },
          includeRisk: {
            type: "boolean",
            description: "Include take-profit and stop-loss settings in response"
          }
        },
        required: []
      }
    }
  },
  // Devnet faucet (for testing)
  {
    type: "function",
    function: {
      name: "request_devnet_faucet",
      description: "Request SOL from the Solana devnet faucet to fund the hot wallet for testing. Only works on devnet. Use when user asks to fund their wallet on devnet or needs test SOL.",
      parameters: {
        type: "object",
        properties: {
          amount: {
            type: "number",
            description: "Amount of SOL to request (default 1, max 2)"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_my_accuracy",
      description: "Get Miss Pincher's prediction accuracy stats. Shows hit rate, performance by prediction type, and confidence calibration. Use when user asks about accuracy, performance, or how good predictions are.",
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
      name: "get_market_insights",
      description: "Get adaptive scoring insights including current market regime, learned patterns, weight adjustments, and recommendations. Use when user asks about market conditions, what's working, or how scoring is adapting.",
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
    sourceWalletAddress: holding.sourceWalletAddress,
    buyPrice: holding.buyPrice,
    buyTimestamp: holding.buyTimestamp,
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
      if (pending.sourceWalletAddress && pending.buyPrice && pending.buyPrice > 0) {
        try {
          const { updateSignalWalletProfile } = await import("./signal-wallet-profiler");
          const currentPrice = result.inputAmount ? (result.inputAmount / pending.amount) : 0;
          if (currentPrice > 0) {
            const multiplier = currentPrice / pending.buyPrice;
            const holdTimeMinutes = pending.buyTimestamp 
              ? Math.floor((Date.now() / 1000 - pending.buyTimestamp) / 60) 
              : 60;
            await updateSignalWalletProfile(pending.sourceWalletAddress, multiplier, holdTimeMinutes);
            console.log(`Updated signal wallet profile for AI sell: ${pending.sourceWalletAddress} - ${multiplier.toFixed(2)}x`);
          }
        } catch (error) {
          console.error("Failed to update signal wallet profile:", error);
        }
      }
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
// Propose settings changes (with validation and risk warnings)
async function executeProposeSettings(
  userId: number,
  args: PendingSettings['updates']
): Promise<{ success: boolean; message: string }> {
  // Check if any settings were provided
  const updateKeys = Object.keys(args).filter(k => (args as any)[k] !== undefined);
  if (updateKeys.length === 0) {
    return { success: false, message: "No settings specified to change." };
  }
  
  // Validate the settings
  const validation = validateSettingsUpdates(args);
  if (!validation.valid) {
    return { 
      success: false, 
      message: `Invalid settings:\n• ${validation.errors.join('\n• ')}` 
    };
  }
  
  // Get current config for risk assessment
  const currentConfig = await getTradeConfig(userId);
  
  // Generate summary and warnings
  const summary = generateSettingsSummary(args);
  const riskWarnings = generateSettingsRiskWarnings(args, currentConfig);
  
  // Store pending settings
  const now = Date.now();
  pendingSettings.set(userId, {
    updates: args,
    summary,
    riskWarnings,
    proposedAt: now,
    expiresAt: now + PENDING_SETTINGS_TTL,
    userConfirmed: false
  });
  
  // Build response message
  let message = `Here's what I'll change:\n• ${summary}`;
  
  if (riskWarnings.length > 0) {
    message += `\n\nThings to consider:\n• ${riskWarnings.join('\n• ')}`;
  }
  
  message += `\n\nSay "confirm" to apply these settings, or "cancel" to keep current settings.`;
  
  return { success: true, message };
}

// Confirm and apply pending settings
async function executeConfirmSettings(userId: number): Promise<{ success: boolean; message: string }> {
  const pending = pendingSettings.get(userId);
  
  if (!pending) {
    return { success: false, message: "No pending settings to confirm. Tell me what you want to change." };
  }
  
  if (Date.now() > pending.expiresAt) {
    pendingSettings.delete(userId);
    return { success: false, message: "Settings proposal expired. Tell me what you want to change again." };
  }
  
  // Apply the settings
  const updates: any = {};
  const changes: string[] = [];
  
  if (pending.updates.enabled !== undefined) {
    updates.enabled = pending.updates.enabled;
    changes.push(pending.updates.enabled ? 'copy trading ENABLED' : 'copy trading DISABLED');
  }
  if (pending.updates.buyPercentage !== undefined) {
    updates.buyPercentage = Math.min(100, Math.max(1, pending.updates.buyPercentage));
    changes.push(`buy percentage: ${updates.buyPercentage}%`);
  }
  if (pending.updates.minDelayMinutes !== undefined) {
    updates.minDelayMinutes = pending.updates.minDelayMinutes;
    changes.push(`min delay: ${pending.updates.minDelayMinutes}m`);
  }
  if (pending.updates.maxDelayMinutes !== undefined) {
    updates.maxDelayMinutes = pending.updates.maxDelayMinutes;
    changes.push(`max delay: ${pending.updates.maxDelayMinutes}m`);
  }
  if (pending.updates.reclaimMultiplier !== undefined) {
    updates.reclaimMultiplier = pending.updates.reclaimMultiplier;
    changes.push(`take-profit: ${pending.updates.reclaimMultiplier}x`);
  }
  if (pending.updates.dumpAlertThreshold !== undefined) {
    updates.dumpAlertThreshold = pending.updates.dumpAlertThreshold;
    changes.push(`dump alert: -${pending.updates.dumpAlertThreshold}%`);
  }
  if (pending.updates.maxTradeUsd !== undefined) {
    updates.maxTradeUsd = pending.updates.maxTradeUsd;
    changes.push(`max trade: $${pending.updates.maxTradeUsd}`);
  }
  if (pending.updates.maxDailySpendUsd !== undefined) {
    updates.maxDailySpendUsd = pending.updates.maxDailySpendUsd;
    changes.push(`daily limit: $${pending.updates.maxDailySpendUsd}`);
  }
  if (pending.updates.minReserveSol !== undefined) {
    updates.minReserveSol = pending.updates.minReserveSol;
    changes.push(`reserve: ${pending.updates.minReserveSol} SOL`);
  }
  if (pending.updates.stopLossPercent !== undefined) {
    updates.stopLossPercent = pending.updates.stopLossPercent;
    changes.push(pending.updates.stopLossPercent === 0 ? 'stop-loss: OFF' : `stop-loss: ${pending.updates.stopLossPercent}%`);
  }
  
  await updateTradeConfig(userId, updates);
  pendingSettings.delete(userId);
  
  console.log(`[Settings] User ${userId} applied settings: ${changes.join(', ')}`);
  
  return {
    success: true,
    message: `Done. Settings updated: ${changes.join(', ')}`
  };
}

// Cancel pending settings
function executeCancelSettings(userId: number): { success: boolean; message: string } {
  const pending = pendingSettings.get(userId);
  
  if (!pending) {
    return { success: false, message: "Nothing to cancel - no pending settings." };
  }
  
  pendingSettings.delete(userId);
  return { success: true, message: "Cancelled. Your settings stay as they were." };
}

// Configure per-wallet copy trading settings
async function executeConfigureWalletCopy(
  userId: number,
  args: {
    walletAddress: string;
    buyType?: string;
    buyAmount?: number;
    timing?: string;
    delayMinutes?: number;
    minTradeUsd?: number;
    scoreThreshold?: number;
    autoMirror?: boolean;
    skipIfHolding?: boolean;
    skipIfEverHeld?: boolean;
  }
): Promise<{ success: boolean; message: string }> {
  // Find the wallet
  const existing = await db.select()
    .from(monitoredWallets)
    .where(and(
      eq(monitoredWallets.userId, userId),
      eq(monitoredWallets.walletAddress, args.walletAddress)
    ))
    .limit(1);
  
  if (existing.length === 0) {
    return { success: false, message: `Wallet ${args.walletAddress.slice(0, 8)}... not found in your monitored wallets.` };
  }
  
  const wallet = existing[0];
  const updates: any = {};
  const changes: string[] = [];
  
  if (args.buyType !== undefined) {
    updates.copyBuyType = args.buyType;
    changes.push(`buy type: ${args.buyType}`);
  }
  if (args.buyAmount !== undefined) {
    updates.copyBuyAmount = args.buyAmount;
    const typeLabel = args.buyType || wallet.copyBuyType || 'percentage';
    const unit = typeLabel === 'fixed_sol' ? 'SOL' : typeLabel === 'fixed_usd' ? 'USD' : '%';
    changes.push(`buy amount: ${args.buyAmount}${unit}`);
  }
  if (args.timing !== undefined) {
    updates.copyTiming = args.timing;
    changes.push(`timing: ${args.timing}`);
  }
  if (args.delayMinutes !== undefined) {
    updates.copyDelayMinutes = args.delayMinutes;
    changes.push(`delay: ${args.delayMinutes}m`);
  }
  if (args.minTradeUsd !== undefined) {
    updates.copyMinTradeUsd = args.minTradeUsd;
    changes.push(`min trade: $${args.minTradeUsd}`);
  }
  if (args.scoreThreshold !== undefined) {
    updates.copyScoreThreshold = args.scoreThreshold;
    changes.push(`score threshold: ${args.scoreThreshold}`);
  }
  if (args.autoMirror !== undefined) {
    updates.copyAutoMirror = args.autoMirror;
    changes.push(`auto-mirror: ${args.autoMirror ? 'ON' : 'OFF'}`);
  }
  if (args.skipIfHolding !== undefined) {
    updates.dedupSkipIfHolding = args.skipIfHolding;
    changes.push(`skip if holding: ${args.skipIfHolding ? 'YES' : 'NO'}`);
  }
  if (args.skipIfEverHeld !== undefined) {
    updates.dedupSkipIfEverHeld = args.skipIfEverHeld;
    changes.push(`skip if ever held: ${args.skipIfEverHeld ? 'YES' : 'NO'}`);
  }
  
  if (Object.keys(updates).length === 0) {
    return { success: false, message: "No settings specified to change." };
  }
  
  await db.update(monitoredWallets)
    .set(updates)
    .where(eq(monitoredWallets.id, wallet.id));
  
  const label = wallet.label || wallet.walletAddress.slice(0, 8) + '...';
  console.log(`[Settings] User ${userId} configured wallet ${label}: ${changes.join(', ')}`);
  
  return {
    success: true,
    message: `Updated ${label}: ${changes.join(', ')}`
  };
}

// Get wallet copy config
async function executeGetWalletCopyConfig(
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
    return { success: false, message: `Wallet ${args.walletAddress.slice(0, 8)}... not found.` };
  }
  
  const w = existing[0];
  const label = w.label || w.walletAddress.slice(0, 8) + '...';
  const buyUnit = w.copyBuyType === 'fixed_sol' ? 'SOL' : w.copyBuyType === 'fixed_usd' ? 'USD' : '%';
  
  return {
    success: true,
    message: `Copy config for ${label}:
- Copy enabled: ${w.copyTradeEnabled ? 'YES' : 'NO'}
- Buy type: ${w.copyBuyType || 'percentage'}
- Buy amount: ${w.copyBuyAmount || 10}${buyUnit}
- Timing: ${w.copyTiming || 'immediate'}${w.copyDelayMinutes ? ` (${w.copyDelayMinutes}m delay)` : ''}
- Min trade: ${w.copyMinTradeUsd ? `$${w.copyMinTradeUsd}` : 'none'}
- Score threshold: ${w.copyScoreThreshold ?? 'none'}
- Auto-mirror: ${w.copyAutoMirror ? 'ON' : 'OFF'}
- Skip if holding: ${w.dedupSkipIfHolding ? 'YES' : 'NO'}
- Skip if ever held: ${w.dedupSkipIfEverHeld ? 'YES' : 'NO'}`
  };
}

// Manual buy (queue a buy, supports new position or top-up)
async function executeManualBuy(
  userId: number,
  args: { tokenMint: string; tokenSymbol: string; solAmount: number; isTopUp?: boolean }
): Promise<{ success: boolean; message: string }> {
  // Check if already holding this token
  const existingHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.userId, userId),
      eq(holdings.tokenMint, args.tokenMint)
    ))
    .limit(1);
  
  const hasExistingPosition = existingHoldings.length > 0;
  
  // Honor explicit isTopUp parameter if provided, otherwise infer from holdings
  let isTopUp: boolean;
  if (args.isTopUp !== undefined) {
    // User explicitly specified
    if (args.isTopUp && !hasExistingPosition) {
      return { success: false, message: `Can't top up - you don't have a position in ${args.tokenSymbol} yet.` };
    }
    isTopUp = args.isTopUp;
  } else {
    // Infer from existing holdings
    isTopUp = hasExistingPosition;
  }
  
  const action = isTopUp ? 'top-up existing position' : 'new position';
  
  // Get hot wallet to verify balance
  const { getOrCreateHotWallet, getHotWalletBalance } = await import("./wallet");
  const hotWallet = await getOrCreateHotWallet(userId);
  if (!hotWallet) {
    return { success: false, message: "No hot wallet found. Create one first." };
  }
  
  const balance = await getHotWalletBalance(userId);
  if (balance < args.solAmount + 0.01) {
    return { success: false, message: `Insufficient balance. Have ${balance.toFixed(4)} SOL, need ${(args.solAmount + 0.01).toFixed(4)} SOL.` };
  }
  
  // Create pending buy (manual trade - sourceWalletAddress and signalWalletId null indicates manual)
  const now = Math.floor(Date.now() / 1000);
  
  await db.insert(pendingBuys).values({
    userId,
    tokenMint: args.tokenMint,
    tokenSymbol: args.tokenSymbol,
    detectedAt: now,
    scheduledBuyAt: now,
    solAmount: args.solAmount,
    status: 'active',
    sourceWalletAddress: null, // null = manual trade
    signalWalletId: null, // null = manual trade
    copyTiming: 'immediate', // Manual trades execute immediately
  });
  
  console.log(`[Manual Buy] User ${userId} queued ${action} for ${args.tokenSymbol}: ${args.solAmount} SOL (isTopUp: ${isTopUp})`);
  
  return {
    success: true,
    message: `Queued ${action} for ${args.tokenSymbol}: ${args.solAmount} SOL. Will execute shortly.`
  };
}

// Get positions with filtering
async function executeGetPositions(
  userId: number,
  args: { tokenSymbol?: string; source?: string; includeRisk?: boolean }
): Promise<{ success: boolean; message: string }> {
  let query = db.select()
    .from(holdings)
    .where(eq(holdings.userId, userId));
  
  const positions = await query;
  
  // Filter by token symbol if provided
  let filtered = positions;
  if (args.tokenSymbol) {
    const searchLower = args.tokenSymbol.toLowerCase();
    filtered = filtered.filter(p => 
      p.tokenSymbol?.toLowerCase() === searchLower ||
      p.tokenSymbol?.toLowerCase().includes(searchLower)
    );
  }
  
  // Filter by source if provided
  if (args.source && args.source !== 'all') {
    filtered = filtered.filter(p => p.positionSource === args.source);
  }
  
  if (filtered.length === 0) {
    return { success: true, message: "No positions found matching your criteria." };
  }
  
  const summaries = filtered.slice(0, 15).map(p => {
    let line = `${p.tokenSymbol}: ${p.currentAmount?.toFixed(2) || p.amountBought?.toFixed(2) || '?'} tokens`;
    line += ` (${p.positionSource || 'unknown'} source)`;
    
    if (p.buyPrice) {
      line += `, entry: $${p.buyPrice.toFixed(6)}`;
    }
    if (p.avgEntryPrice) {
      line += `, avg: $${p.avgEntryPrice.toFixed(6)}`;
    }
    
    if (args.includeRisk) {
      if (p.takeProfitThresholds) {
        try {
          const thresholds = typeof p.takeProfitThresholds === 'string' 
            ? JSON.parse(p.takeProfitThresholds) 
            : p.takeProfitThresholds;
          if (Array.isArray(thresholds)) {
            line += `, TP: ${thresholds.join('x/')}x`;
          }
        } catch {}
      }
      if (p.stopLossPercent) {
        line += `, SL: ${p.stopLossPercent}%`;
      }
    }
    
    if (p.sourceWalletAddress) {
      line += ` (from ${p.sourceWalletAddress.slice(0, 6)}...)`;
    }
    
    return line;
  });
  
  const sourceBreakdown = {
    copy_trade: filtered.filter(p => p.positionSource === 'copy_trade').length,
    manual: filtered.filter(p => p.positionSource === 'manual').length,
  };
  
  return {
    success: true,
    message: `Positions (${filtered.length} total, ${sourceBreakdown.copy_trade} copy / ${sourceBreakdown.manual} manual):\n${summaries.join('\n')}`
  };
}

// Request devnet faucet
async function executeDevnetFaucet(
  userId: number,
  args: { amount?: number }
): Promise<{ success: boolean; message: string }> {
  // Check if on devnet
  const networkMode = process.env.NETWORK_MODE || 'devnet';
  if (networkMode !== 'devnet') {
    return { success: false, message: "Faucet only works on devnet. Switch to devnet mode first." };
  }
  
  // Get hot wallet
  const { getOrCreateHotWallet } = await import("./wallet");
  const hotWallet = await getOrCreateHotWallet(userId);
  if (!hotWallet) {
    return { success: false, message: "No hot wallet found." };
  }
  
  const amount = Math.min(args.amount || 1, 2); // Max 2 SOL per request
  
  try {
    const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    
    const signature = await connection.requestAirdrop(
      new PublicKey(hotWallet.publicKey),
      amount * LAMPORTS_PER_SOL
    );
    
    // Wait for confirmation
    await connection.confirmTransaction(signature, "confirmed");
    
    console.log(`[Faucet] User ${userId} received ${amount} SOL devnet airdrop`);
    
    return {
      success: true,
      message: `Got ${amount} SOL from the devnet faucet. Should appear in your wallet shortly.`
    };
  } catch (err: any) {
    console.error(`[Faucet] Failed for user ${userId}:`, err.message);
    return { 
      success: false, 
      message: `Faucet request failed: ${err.message}. Try again in a few minutes - devnet faucet has rate limits.` 
    };
  }
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

async function executeFindWalletByLabel(userId: number, args: any): Promise<{ success: boolean; message: string; wallet?: any }> {
  const { label } = args;
  
  if (!label) {
    return { success: false, message: "Label/name to search for is required" };
  }
  
  const wallets = await db.select()
    .from(monitoredWallets)
    .where(eq(monitoredWallets.userId, userId));
  
  // Case-insensitive partial match on label
  const searchLower = label.toLowerCase();
  const matches = wallets.filter(w => 
    w.label && w.label.toLowerCase().includes(searchLower)
  );
  
  if (matches.length === 0) {
    return { 
      success: false, 
      message: `No wallet found with label matching "${label}". You have ${wallets.length} wallets monitored.` 
    };
  }
  
  if (matches.length === 1) {
    const w = matches[0];
    const copyStatus = w.copyTradeEnabled ? "copy trading ON" : "watch only";
    return {
      success: true,
      message: `Found: "${w.label}" (${w.walletAddress.slice(0, 8)}...${w.walletAddress.slice(-4)}) - ${copyStatus}`,
      wallet: {
        id: w.id,
        address: w.walletAddress,
        label: w.label,
        copyEnabled: w.copyTradeEnabled,
      }
    };
  }
  
  // Multiple matches
  const summaries = matches.map(w => 
    `- "${w.label}" (${w.walletAddress.slice(0, 8)}...)`
  );
  return {
    success: true,
    message: `Multiple wallets match "${label}":\n${summaries.join('\n')}\nPlease be more specific.`
  };
}

async function executeGetWalletPerformance(userId: number, args: any): Promise<{ success: boolean; message: string }> {
  const { walletIdentifier, timeframe = "24h" } = args;
  
  if (!walletIdentifier) {
    return { success: false, message: "Wallet address or label required" };
  }
  
  // First, try to find the wallet by label or address
  let walletAddress = walletIdentifier;
  let walletLabel = walletIdentifier;
  
  // Check if it's a label (search monitored wallets)
  const userWallets = await db.select()
    .from(monitoredWallets)
    .where(eq(monitoredWallets.userId, userId));
  
  const searchLower = walletIdentifier.toLowerCase();
  const matchByLabel = userWallets.find(w => 
    w.label && w.label.toLowerCase().includes(searchLower)
  );
  const matchByAddress = userWallets.find(w =>
    w.walletAddress.toLowerCase() === searchLower ||
    w.walletAddress.toLowerCase().startsWith(searchLower)
  );
  
  const matchedWallet = matchByLabel || matchByAddress;
  if (matchedWallet) {
    walletAddress = matchedWallet.walletAddress;
    walletLabel = matchedWallet.label || walletAddress.slice(0, 8);
  } else if (walletIdentifier.length < 32) {
    return { success: false, message: `No monitored wallet found matching "${walletIdentifier}"` };
  }
  
  // Calculate time cutoff
  const now = Math.floor(Date.now() / 1000);
  let cutoff = 0;
  let periodLabel = "all time";
  if (timeframe === "24h") {
    cutoff = now - 24 * 60 * 60;
    periodLabel = "last 24 hours";
  } else if (timeframe === "7d") {
    cutoff = now - 7 * 24 * 60 * 60;
    periodLabel = "last 7 days";
  } else if (timeframe === "30d") {
    cutoff = now - 30 * 24 * 60 * 60;
    periodLabel = "last 30 days";
  }
  
  // Fetch swaps for this wallet
  const walletSwaps = await db.select()
    .from(swaps)
    .where(and(
      eq(swaps.source, walletAddress),
      cutoff > 0 ? sql`${swaps.timestamp} >= ${cutoff}` : sql`1=1`
    ))
    .orderBy(swaps.timestamp);
  
  if (walletSwaps.length === 0) {
    return { 
      success: true, 
      message: `${walletLabel} has no trades in the ${periodLabel}.` 
    };
  }
  
  // Analyze trades - track token positions
  const tokenPositions: Record<string, { 
    buys: { amount: number; solValue: number; timestamp: number }[];
    sells: { amount: number; solValue: number; timestamp: number }[];
  }> = {};
  
  let totalBuySol = 0;
  let totalSellSol = 0;
  let buyCount = 0;
  let sellCount = 0;
  
  for (const swap of walletSwaps) {
    const isBuy = swap.fromToken === "So11111111111111111111111111111111111111112" || 
                  swap.fromTokenSymbol === "SOL";
    const isSell = swap.toToken === "So11111111111111111111111111111111111111112" ||
                   swap.toTokenSymbol === "SOL";
    
    if (isBuy) {
      buyCount++;
      const solSpent = swap.fromAmount;
      totalBuySol += solSpent;
      const tokenMint = swap.toToken;
      if (!tokenPositions[tokenMint]) {
        tokenPositions[tokenMint] = { buys: [], sells: [] };
      }
      tokenPositions[tokenMint].buys.push({ 
        amount: swap.toAmount, 
        solValue: solSpent,
        timestamp: swap.timestamp 
      });
    } else if (isSell) {
      sellCount++;
      const solReceived = swap.toAmount;
      totalSellSol += solReceived;
      const tokenMint = swap.fromToken;
      if (!tokenPositions[tokenMint]) {
        tokenPositions[tokenMint] = { buys: [], sells: [] };
      }
      tokenPositions[tokenMint].sells.push({ 
        amount: swap.fromAmount, 
        solValue: solReceived,
        timestamp: swap.timestamp 
      });
    }
  }
  
  // Calculate wins/losses for closed positions
  let wins = 0;
  let losses = 0;
  let realizedPnl = 0;
  
  for (const [tokenMint, position] of Object.entries(tokenPositions)) {
    const totalBought = position.buys.reduce((sum, b) => sum + b.solValue, 0);
    const totalSold = position.sells.reduce((sum, s) => sum + s.solValue, 0);
    
    if (totalSold > 0 && totalBought > 0) {
      const pnl = totalSold - totalBought;
      realizedPnl += pnl;
      if (pnl > 0) wins++;
      else losses++;
    }
  }
  
  const hitRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "N/A";
  const netPnl = Math.abs(realizedPnl).toFixed(2);
  const netPnlSign = realizedPnl >= 0 ? "+" : "-";
  const closedPositions = wins + losses;
  const openPositions = Object.keys(tokenPositions).length - closedPositions;
  
  const summary = [
    `📊 ${walletLabel} Performance (${periodLabel}):`,
    ``,
    `SOL Trades: ${buyCount} buys, ${sellCount} sells`,
    `Closed Positions: ${closedPositions} (${wins}W / ${losses}L)`,
    closedPositions > 0 ? `Hit Rate: ${hitRate}%` : null,
    `Est. Realized P&L: ${netPnlSign}${netPnl} SOL`,
    `Volume: ${totalBuySol.toFixed(2)} SOL in, ${totalSellSol.toFixed(2)} SOL out`,
    openPositions > 0 ? `Open Positions: ~${openPositions} tokens` : null,
  ].filter(Boolean);
  
  return {
    success: true,
    message: summary.join('\n')
  };
}

async function executeUpdatePositionRisk(userId: number, args: any): Promise<{ success: boolean; message: string }> {
  const { tokenSymbol, takeProfitThresholds, takeProfitPercentages, stopLossPercent } = args;
  
  if (!tokenSymbol) {
    return { success: false, message: "Token symbol required" };
  }
  
  // Find user's position for this token
  const positions = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.userId, userId),
      eq(holdings.tokenSymbol, tokenSymbol.toUpperCase())
    ));
  
  if (positions.length === 0) {
    return { success: false, message: `No position found for ${tokenSymbol}` };
  }
  
  const updates: any = {};
  const changes: string[] = [];
  
  if (takeProfitThresholds && Array.isArray(takeProfitThresholds)) {
    updates.takeProfitThresholds = takeProfitThresholds;
    changes.push(`take-profit at ${takeProfitThresholds.join('x, ')}x`);
  }
  
  if (takeProfitPercentages && Array.isArray(takeProfitPercentages)) {
    updates.takeProfitPercentages = takeProfitPercentages;
    changes.push(`sell ${takeProfitPercentages.join('%, ')}% at each`);
  }
  
  if (stopLossPercent !== undefined) {
    updates.stopLossPercent = stopLossPercent;
    changes.push(`stop-loss at ${stopLossPercent}% drop`);
  }
  
  if (changes.length === 0) {
    return { success: false, message: "No settings to update" };
  }
  
  // Update all positions for this token
  for (const pos of positions) {
    await db.update(holdings).set(updates).where(eq(holdings.id, pos.id));
  }
  
  return {
    success: true,
    message: `Updated ${positions.length} position(s) for ${tokenSymbol}: ${changes.join(', ')}`
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

// Get pending settings context to inject into system prompt
function getPendingSettingsContext(userId: number): string | null {
  const pending = pendingSettings.get(userId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (pending) pendingSettings.delete(userId);
    return null;
  }
  const timeLeft = Math.floor((pending.expiresAt - Date.now()) / 1000);
  return `PENDING SETTINGS CHANGE:\n${pending.summary}\nExpires in ${timeLeft}s. Use confirm_settings if user confirms, cancel_settings if user cancels.`;
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

// Get or create user relationship from database
async function getOrCreateUserRelationship(userId: number): Promise<UserRelationship> {
  try {
    const [existing] = await db.select()
      .from(userRelationships)
      .where(eq(userRelationships.userId, userId))
      .limit(1);
    
    if (existing) {
      // Update lastInteraction timestamp
      await db.update(userRelationships)
        .set({ 
          lastInteraction: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(userRelationships.id, existing.id));
      
      return {
        affinityScore: existing.affinityScore ?? 0,
        relationshipType: (existing.relationshipType as UserRelationship['relationshipType']) ?? 'new',
        crabMentions: existing.crabMentions ?? 0,
        crabInsults: existing.crabInsults ?? 0,
        complimentsGiven: existing.complimentsGiven ?? 0,
        tradesWonTogether: existing.tradesWonTogether ?? 0,
        tradesLostTogether: existing.tradesLostTogether ?? 0,
        warningsIgnored: existing.warningsIgnored ?? 0,
        warningsFollowed: existing.warningsFollowed ?? 0,
        lastInteraction: existing.lastInteraction ?? Math.floor(Date.now() / 1000),
        notes: (existing.notes as string[]) ?? [],
      };
    }
    
    // Create new relationship for this user
    const now = Math.floor(Date.now() / 1000);
    const [created] = await db.insert(userRelationships).values({
      userId,
      affinityScore: 0,
      relationshipType: 'new',
      crabMentions: 0,
      crabInsults: 0,
      complimentsGiven: 0,
      tradesWonTogether: 0,
      tradesLostTogether: 0,
      warningsIgnored: 0,
      warningsFollowed: 0,
      lastInteraction: now,
      notes: [],
      createdAt: now,
      updatedAt: now,
    }).returning();
    
    return getDefaultRelationship();
  } catch (error) {
    console.error('[Relationship] Error loading relationship:', error);
    return getDefaultRelationship();
  }
}

// Update user relationship metrics
export async function updateUserRelationship(
  userId: number, 
  updates: Partial<{
    affinityDelta: number;
    crabMentionDelta: number;
    crabInsultDelta: number;
    complimentDelta: number;
    tradeWonDelta: number;
    tradeLostDelta: number;
    warningIgnoredDelta: number;
    warningFollowedDelta: number;
    newRelationshipType: UserRelationship['relationshipType'];
    addNote: string;
  }>
): Promise<void> {
  try {
    const [existing] = await db.select()
      .from(userRelationships)
      .where(eq(userRelationships.userId, userId))
      .limit(1);
    
    if (!existing) {
      // Create if doesn't exist
      await getOrCreateUserRelationship(userId);
      return updateUserRelationship(userId, updates);
    }
    
    const now = Math.floor(Date.now() / 1000);
    const setValues: Record<string, any> = { updatedAt: now, lastInteraction: now };
    
    if (updates.affinityDelta) {
      const newAffinity = Math.max(-100, Math.min(100, (existing.affinityScore ?? 0) + updates.affinityDelta));
      setValues.affinityScore = newAffinity;
      
      // Auto-adjust relationship type based on affinity
      if (newAffinity >= 50) setValues.relationshipType = 'friendly';
      else if (newAffinity >= 20) setValues.relationshipType = 'professional';
      else if (newAffinity <= -30) setValues.relationshipType = 'adversarial';
    }
    if (updates.crabMentionDelta) setValues.crabMentions = (existing.crabMentions ?? 0) + updates.crabMentionDelta;
    if (updates.crabInsultDelta) setValues.crabInsults = (existing.crabInsults ?? 0) + updates.crabInsultDelta;
    if (updates.complimentDelta) setValues.complimentsGiven = (existing.complimentsGiven ?? 0) + updates.complimentDelta;
    if (updates.tradeWonDelta) setValues.tradesWonTogether = (existing.tradesWonTogether ?? 0) + updates.tradeWonDelta;
    if (updates.tradeLostDelta) setValues.tradesLostTogether = (existing.tradesLostTogether ?? 0) + updates.tradeLostDelta;
    if (updates.warningIgnoredDelta) setValues.warningsIgnored = (existing.warningsIgnored ?? 0) + updates.warningIgnoredDelta;
    if (updates.warningFollowedDelta) setValues.warningsFollowed = (existing.warningsFollowed ?? 0) + updates.warningFollowedDelta;
    if (updates.newRelationshipType) setValues.relationshipType = updates.newRelationshipType;
    if (updates.addNote) {
      const notes = (existing.notes as string[]) ?? [];
      notes.push(`[${new Date().toISOString().slice(0, 10)}] ${updates.addNote}`);
      if (notes.length > 10) notes.shift(); // Keep only last 10 notes
      setValues.notes = notes;
    }
    
    await db.update(userRelationships).set(setValues).where(eq(userRelationships.id, existing.id));
  } catch (error) {
    console.error('[Relationship] Error updating relationship:', error);
  }
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
  
  // Load relationship from database (creates if new user)
  const relationship = await getOrCreateUserRelationship(userId);
  
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
  
  // Check for pending trade and pending settings
  const pendingTradeCtx = getPendingTradeContext(userId);
  const pendingSettingsCtx = getPendingSettingsContext(userId);
  
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

COPY TRADING CONFIGURATION (always propose first, then confirm):
- propose_settings: Propose settings changes with summary and risk warnings (ALWAYS use this first)
- confirm_settings: Apply proposed settings after user confirms
- cancel_settings: Cancel pending settings proposal
- get_copy_trading_settings: Show current copy trading configuration
- enable_wallet_copy: Enable copy trading for a monitored wallet
- disable_wallet_copy: Disable copy trading for a wallet (keep monitoring)
- list_monitored_wallets: Show all monitored wallets and their copy status
- configure_wallet_copy: Configure per-wallet copy settings (buy amount, timing, filters)
- get_wallet_copy_config: Get copy config for a specific wallet

POSITIONS & MANUAL TRADING:
- get_positions: Query positions with filters (by token, source, include risk settings)
- manual_buy: Queue a manual buy (supports new position or top-up)
- update_position_risk: Update take-profit or stop-loss for a position

DEVNET (testing only):
- request_devnet_faucet: Request SOL from devnet faucet (only works on devnet)

SELF-REFLECTION & LEARNING:
- get_my_accuracy: Check my prediction accuracy stats (hit rate, calibration)
- get_market_insights: Get market regime, learned patterns, weight adjustments, and recommendations

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
${pendingSettingsCtx ? `
PENDING SETTINGS AWAITING CONFIRMATION:
${pendingSettingsCtx}
CRITICAL: If user says "confirm", "yes", "do it", "apply", "go ahead" - you MUST call confirm_settings immediately. Do NOT re-propose or ask again.
If user says "no", "cancel", "nevermind" - call cancel_settings.
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
          // Copy Trading Configuration Tools (with confirmation flow)
          else if (toolName === "propose_settings") {
            const result = await executeProposeSettings(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "confirm_settings") {
            const result = await executeConfirmSettings(userId);
            toolResults.push(result.message);
          } else if (toolName === "cancel_settings") {
            const result = executeCancelSettings(userId);
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
          } else if (toolName === "find_wallet_by_label") {
            const result = await executeFindWalletByLabel(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "get_wallet_performance") {
            const result = await executeGetWalletPerformance(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "update_position_risk") {
            const result = await executeUpdatePositionRisk(userId, args);
            toolResults.push(result.message);
          }
          // Per-wallet configuration
          else if (toolName === "configure_wallet_copy") {
            const result = await executeConfigureWalletCopy(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "get_wallet_copy_config") {
            const result = await executeGetWalletCopyConfig(userId, args);
            toolResults.push(result.message);
          }
          // Manual trading and positions
          else if (toolName === "manual_buy") {
            const result = await executeManualBuy(userId, args);
            toolResults.push(result.message);
          } else if (toolName === "get_positions") {
            const result = await executeGetPositions(userId, args);
            toolResults.push(result.message);
          }
          // Devnet faucet
          else if (toolName === "request_devnet_faucet") {
            const result = await executeDevnetFaucet(userId, args);
            toolResults.push(result.message);
          }
          // Accuracy stats
          else if (toolName === "get_my_accuracy") {
            const { getAccuracySummaryForChat } = await import("./ai-accuracy");
            const summary = await getAccuracySummaryForChat(userId);
            toolResults.push(summary);
          }
          // Market insights from adaptive scoring (global market-level data)
          else if (toolName === "get_market_insights") {
            const { getAdaptiveScoringContext } = await import("./adaptive-scoring");
            const context = await getAdaptiveScoringContext();
            
            let summary = `MARKET INSIGHTS:\n\n`;
            
            // Market regime
            summary += `CURRENT MARKET REGIME: ${context.regime.type.toUpperCase()}\n`;
            summary += `Confidence: ${(context.regime.confidence * 100).toFixed(0)}%\n`;
            summary += `Indicators:\n`;
            summary += `  - Price direction: ${context.regime.indicators.recentPriceDirection > 0 ? '+' : ''}${context.regime.indicators.recentPriceDirection.toFixed(1)}%\n`;
            summary += `  - Volatility: ${context.regime.indicators.volatility.toFixed(1)}%\n`;
            summary += `  - Whale activity: ${(context.regime.indicators.whaleActivityLevel * 100).toFixed(0)}%\n`;
            summary += `  - Avg hold time: ${context.regime.indicators.avgHoldTime.toFixed(1)} hrs\n\n`;
            
            // Adaptive weights
            summary += `LEARNED SCORING WEIGHTS:\n`;
            const sortedWeights = Object.entries(context.weights).sort((a, b) => b[1] - a[1]);
            for (const [factor, weight] of sortedWeights) {
              summary += `  - ${factor}: ${(weight * 100).toFixed(0)}%\n`;
            }
            summary += `\n`;
            
            // Top patterns
            if (context.patterns.length > 0) {
              summary += `DISCOVERED PATTERNS:\n`;
              for (const pattern of context.patterns.slice(0, 5)) {
                summary += `  - ${pattern.pattern}: ${(pattern.successRate * 100).toFixed(0)}% success (${pattern.occurrences} samples)\n`;
              }
              summary += `\n`;
            }
            
            // Recommendations
            if (context.recommendations.length > 0) {
              summary += `RECOMMENDATIONS:\n`;
              for (const rec of context.recommendations) {
                summary += `  - ${rec}\n`;
              }
            }
            
            toolResults.push(summary);
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
