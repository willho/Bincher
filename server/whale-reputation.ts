import { db } from "./db";
import { swaps, holderCache, tokenBlacklist } from "@shared/schema";
import { eq, and, gte, desc, sql, lte, inArray } from "drizzle-orm";
import { classifyWalletBehavior } from "./cluster-detection";

export interface WhaleReputation {
  walletAddress: string;
  wins: number;
  losses: number;
  totalTrades: number;
  winRate: number;
  avgPnlPercent: number;
  totalPnlSol: number;
  reputationScore: number;
  flags: WhaleFlag[];
  lastTradeAt: number;
  trackedSince: number;
  isBlacklisted: boolean;
  blacklistReason?: string;
}

export interface WhaleFlag {
  type: "red" | "yellow" | "green";
  reason: string;
  value: number;
  threshold: number;
}

export interface WhaleTradeOutcome {
  tokenMint: string;
  tokenSymbol?: string;
  buyTime: number;
  buyAmountSol: number;
  sellTime?: number;
  sellAmountSol?: number;
  pnlSol?: number;
  pnlPercent?: number;
  isWin: boolean;
  isOpen: boolean;
}

const WHALE_REPUTATION_CACHE: Map<string, WhaleReputation> = new Map();
const WHALE_MIN_SOL_THRESHOLD = 5;
const RED_FLAG_WIN_RATE = 0.3;
const YELLOW_FLAG_WIN_RATE = 0.4;
const AUTO_BLACKLIST_WIN_RATE = 0.2;
const AUTO_BLACKLIST_MIN_TRADES = 20;

export async function trackWhaleOutcome(
  walletAddress: string,
  tokenMint: string,
  pnlSol: number,
  pnlPercent: number
): Promise<WhaleReputation> {
  const cached = WHALE_REPUTATION_CACHE.get(walletAddress);
  const now = Math.floor(Date.now() / 1000);
  
  const isWin = pnlSol > 0;
  
  if (cached) {
    cached.totalTrades++;
    if (isWin) {
      cached.wins++;
    } else {
      cached.losses++;
    }
    cached.winRate = cached.totalTrades > 0 ? cached.wins / cached.totalTrades : 0;
    cached.totalPnlSol += pnlSol;
    cached.avgPnlPercent = ((cached.avgPnlPercent * (cached.totalTrades - 1)) + pnlPercent) / cached.totalTrades;
    cached.lastTradeAt = now;
    cached.reputationScore = calculateReputationScore(cached);
    cached.flags = generateFlags(cached);
    
    if (shouldAutoBlacklist(cached)) {
      await suggestBlacklist(walletAddress, cached);
    }
    
    WHALE_REPUTATION_CACHE.set(walletAddress, cached);
    return cached;
  }
  
  const newReputation: WhaleReputation = {
    walletAddress,
    wins: isWin ? 1 : 0,
    losses: isWin ? 0 : 1,
    totalTrades: 1,
    winRate: isWin ? 1 : 0,
    avgPnlPercent: pnlPercent,
    totalPnlSol: pnlSol,
    reputationScore: 50,
    flags: [],
    lastTradeAt: now,
    trackedSince: now,
    isBlacklisted: false,
  };
  
  newReputation.reputationScore = calculateReputationScore(newReputation);
  newReputation.flags = generateFlags(newReputation);
  
  WHALE_REPUTATION_CACHE.set(walletAddress, newReputation);
  return newReputation;
}

export async function getWhaleOutcomes(
  walletAddress: string,
  windowDays: number = 30
): Promise<WhaleTradeOutcome[]> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowDays * 24 * 3600);
  
  const buys = await db.select().from(swaps)
    .where(and(
      eq(swaps.source, walletAddress),
      eq(swaps.type, "buy"),
      gte(swaps.timestamp, windowStart),
      gte(swaps.fromAmount, WHALE_MIN_SOL_THRESHOLD)
    ))
    .orderBy(desc(swaps.timestamp))
    .limit(100);
  
  const outcomes: WhaleTradeOutcome[] = [];
  
  for (const buy of buys) {
    const sells = await db.select().from(swaps)
      .where(and(
        eq(swaps.source, walletAddress),
        eq(swaps.fromToken, buy.toToken),
        eq(swaps.type, "sell"),
        gte(swaps.timestamp, buy.timestamp)
      ))
      .orderBy(swaps.timestamp)
      .limit(1);
    
    if (sells.length > 0) {
      const sell = sells[0];
      const pnlSol = (sell.toAmount || 0) - (buy.fromAmount || 0);
      const pnlPercent = buy.fromAmount > 0
        ? ((sell.toAmount || 0) - buy.fromAmount) / buy.fromAmount * 100
        : 0;
      
      outcomes.push({
        tokenMint: buy.toToken,
        tokenSymbol: buy.toTokenSymbol || undefined,
        buyTime: buy.timestamp,
        buyAmountSol: buy.fromAmount,
        sellTime: sell.timestamp,
        sellAmountSol: sell.toAmount,
        pnlSol,
        pnlPercent,
        isWin: pnlSol > 0,
        isOpen: false,
      });
    } else {
      outcomes.push({
        tokenMint: buy.toToken,
        tokenSymbol: buy.toTokenSymbol || undefined,
        buyTime: buy.timestamp,
        buyAmountSol: buy.fromAmount,
        isWin: false,
        isOpen: true,
      });
    }
  }
  
  return outcomes;
}

export async function buildWhaleReputation(
  walletAddress: string,
  windowDays: number = 30
): Promise<WhaleReputation> {
  const outcomes = await getWhaleOutcomes(walletAddress, windowDays);
  const now = Math.floor(Date.now() / 1000);
  
  const closedTrades = outcomes.filter(o => !o.isOpen);
  const wins = closedTrades.filter(o => o.isWin);
  const losses = closedTrades.filter(o => !o.isWin);
  
  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;
  const totalPnlSol = closedTrades.reduce((sum, o) => sum + (o.pnlSol || 0), 0);
  const avgPnlPercent = closedTrades.length > 0
    ? closedTrades.reduce((sum, o) => sum + (o.pnlPercent || 0), 0) / closedTrades.length
    : 0;
  
  const [blacklisted] = await db.select().from(tokenBlacklist)
    .where(eq(tokenBlacklist.tokenMint, walletAddress))
    .limit(1);
  
  const reputation: WhaleReputation = {
    walletAddress,
    wins: wins.length,
    losses: losses.length,
    totalTrades: closedTrades.length,
    winRate,
    avgPnlPercent,
    totalPnlSol,
    reputationScore: 50,
    flags: [],
    lastTradeAt: outcomes[0]?.buyTime || now,
    trackedSince: outcomes[outcomes.length - 1]?.buyTime || now,
    isBlacklisted: !!blacklisted,
    blacklistReason: blacklisted?.reason || undefined,
  };
  
  reputation.reputationScore = calculateReputationScore(reputation);
  reputation.flags = generateFlags(reputation);
  
  WHALE_REPUTATION_CACHE.set(walletAddress, reputation);
  return reputation;
}

function calculateReputationScore(rep: WhaleReputation): number {
  let score = 50;
  
  if (rep.winRate >= 0.5) {
    score += (rep.winRate - 0.5) * 60;
  } else if (rep.winRate < 0.3) {
    score -= (0.3 - rep.winRate) * 80;
  } else {
    score -= (0.5 - rep.winRate) * 30;
  }
  
  if (rep.totalPnlSol > 0) {
    score += Math.min(rep.totalPnlSol * 0.5, 15);
  } else {
    score += Math.max(rep.totalPnlSol * 0.8, -20);
  }
  
  if (rep.totalTrades >= 20) {
    score += 10;
  } else if (rep.totalTrades >= 10) {
    score += 5;
  } else if (rep.totalTrades < 5) {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

function generateFlags(rep: WhaleReputation): WhaleFlag[] {
  const flags: WhaleFlag[] = [];
  
  if (rep.totalTrades < 5) {
    return flags;
  }
  
  if (rep.winRate < AUTO_BLACKLIST_WIN_RATE && rep.totalTrades >= AUTO_BLACKLIST_MIN_TRADES) {
    flags.push({
      type: "red",
      reason: "Severely underperforming - blacklist candidate",
      value: rep.winRate,
      threshold: AUTO_BLACKLIST_WIN_RATE,
    });
  } else if (rep.winRate < RED_FLAG_WIN_RATE) {
    flags.push({
      type: "red",
      reason: "Win rate below 30% - high risk",
      value: rep.winRate,
      threshold: RED_FLAG_WIN_RATE,
    });
  } else if (rep.winRate < YELLOW_FLAG_WIN_RATE) {
    flags.push({
      type: "yellow",
      reason: "Win rate below 40% - moderate risk",
      value: rep.winRate,
      threshold: YELLOW_FLAG_WIN_RATE,
    });
  } else if (rep.winRate >= 0.6) {
    flags.push({
      type: "green",
      reason: "Strong win rate above 60%",
      value: rep.winRate,
      threshold: 0.6,
    });
  }
  
  if (rep.totalPnlSol < -10) {
    flags.push({
      type: "red",
      reason: `Large total loss: ${rep.totalPnlSol.toFixed(2)} SOL`,
      value: rep.totalPnlSol,
      threshold: -10,
    });
  }
  
  return flags;
}

function shouldAutoBlacklist(rep: WhaleReputation): boolean {
  return (
    rep.totalTrades >= AUTO_BLACKLIST_MIN_TRADES &&
    rep.winRate < AUTO_BLACKLIST_WIN_RATE &&
    !rep.isBlacklisted
  );
}

async function suggestBlacklist(
  walletAddress: string,
  rep: WhaleReputation
): Promise<void> {
  console.log(`[WhaleReputation] Auto-blacklist suggestion: ${walletAddress.slice(0, 8)}... (${rep.totalTrades} trades, ${(rep.winRate * 100).toFixed(1)}% win rate)`);
  
  try {
    const { publishInsight } = await import("./insight-bus");
    await publishInsight({
      source: "whale_detection",
      type: "pattern",
      title: `Whale ${walletAddress.slice(0, 8)}... flagged for blacklist`,
      payload: {
        walletAddress,
        totalTrades: rep.totalTrades,
        winRate: rep.winRate,
        totalPnlSol: rep.totalPnlSol,
        reason: "Consistently poor performance",
      },
      confidence: 0.85,
      expiresInHours: 168,
    });
  } catch (err) {
    console.error("[WhaleReputation] Failed to publish insight:", err);
  }
}

export function getHeatScorePenalty(rep: WhaleReputation): number {
  if (!rep || rep.totalTrades < 5) return 0;
  
  if (rep.winRate < AUTO_BLACKLIST_WIN_RATE) {
    return -25;
  } else if (rep.winRate < RED_FLAG_WIN_RATE) {
    return -15;
  } else if (rep.winRate < YELLOW_FLAG_WIN_RATE) {
    return -8;
  } else if (rep.winRate >= 0.6) {
    return 5;
  }
  
  return 0;
}

export async function getTopWhales(
  limit: number = 20,
  minTrades: number = 5
): Promise<WhaleReputation[]> {
  return Array.from(WHALE_REPUTATION_CACHE.values())
    .filter(w => w.totalTrades >= minTrades)
    .sort((a, b) => b.reputationScore - a.reputationScore)
    .slice(0, limit);
}

export async function getRedFlagWhales(
  minTrades: number = 10
): Promise<WhaleReputation[]> {
  return Array.from(WHALE_REPUTATION_CACHE.values())
    .filter(w => w.totalTrades >= minTrades && w.flags.some(f => f.type === "red"))
    .sort((a, b) => a.winRate - b.winRate);
}

export async function getBlacklistCandidates(): Promise<WhaleReputation[]> {
  return Array.from(WHALE_REPUTATION_CACHE.values())
    .filter(w => shouldAutoBlacklist(w))
    .sort((a, b) => a.winRate - b.winRate);
}

export function getWhaleReputationCache(): WhaleReputation[] {
  return Array.from(WHALE_REPUTATION_CACHE.values());
}

export function getCachedWhaleReputation(walletAddress: string): WhaleReputation | null {
  return WHALE_REPUTATION_CACHE.get(walletAddress) || null;
}

export async function runWhaleReputationScan(
  windowDays: number = 14
): Promise<{
  scanned: number;
  redFlags: number;
  blacklistCandidates: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowDays * 24 * 3600);
  
  const whaleBuys = await db.select({
    source: swaps.source,
    count: sql<number>`count(*)`,
    totalSol: sql<number>`sum(from_amount)`,
  })
    .from(swaps)
    .where(and(
      eq(swaps.type, "buy"),
      gte(swaps.timestamp, windowStart),
      gte(swaps.fromAmount, WHALE_MIN_SOL_THRESHOLD)
    ))
    .groupBy(swaps.source)
    .orderBy(desc(sql`sum(from_amount)`))
    .limit(100);
  
  let redFlags = 0;
  let blacklistCandidates = 0;
  
  for (const whale of whaleBuys) {
    const rep = await buildWhaleReputation(whale.source, windowDays);
    
    if (rep.flags.some(f => f.type === "red")) {
      redFlags++;
    }
    if (shouldAutoBlacklist(rep)) {
      blacklistCandidates++;
    }
  }
  
  console.log(`[WhaleReputation] Scanned ${whaleBuys.length} whales: ${redFlags} red flags, ${blacklistCandidates} blacklist candidates`);
  
  return {
    scanned: whaleBuys.length,
    redFlags,
    blacklistCandidates,
  };
}

export function clearWhaleReputationCache(): void {
  WHALE_REPUTATION_CACHE.clear();
}
