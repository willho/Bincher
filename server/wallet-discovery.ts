import { db } from "./db";
import { 
  swaps, holdings, paperPositions, monitoredWallets,
  discoveryEvents, strategyClusters
} from "@shared/schema";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { classifyWalletBehavior } from "./cluster-detection";

export interface DiscoveredWallet {
  address: string;
  discoveryMethod: "winner_backtrack" | "copy_chain" | "whale_detection" | "pattern_match";
  discoveredAt: number;
  sourceToken?: string;
  sourceTokenSymbol?: string;
  behaviorType?: string;
  behaviorConfidence?: number;
  score: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgHoldTime: number;
  followsLeaders: string[];
  leadsFollowers: string[];
  copyChainDepth: number;
}

export interface WalletOutcome {
  wallet: string;
  tokenMint: string;
  entryTime: number;
  exitTime: number | null;
  pnlPercent: number;
  pnlSol: number;
  isWin: boolean;
}

const DISCOVERED_WALLETS_CACHE: Map<string, DiscoveredWallet> = new Map();

export async function backtrackFromWinners(
  windowHours: number = 72,
  minPnlPercent: number = 20
): Promise<DiscoveredWallet[]> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowHours * 3600);
  
  const winningPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "closed"),
      gte(paperPositions.exitTimestamp, windowStart),
      gte(paperPositions.realizedPnlPercent, minPnlPercent)
    ))
    .orderBy(desc(paperPositions.realizedPnlPercent))
    .limit(50);
  
  const discoveredWallets: DiscoveredWallet[] = [];
  
  for (const position of winningPositions) {
    const entryTime = position.entryTimestamp;
    const earlyBuyers = await db.select().from(swaps)
      .where(and(
        eq(swaps.toToken, position.tokenMint),
        eq(swaps.type, "buy"),
        gte(swaps.timestamp, entryTime - 7200),
        lte(swaps.timestamp, entryTime - 60)
      ))
      .orderBy(swaps.timestamp)
      .limit(20);
    
    for (const buy of earlyBuyers) {
      if (DISCOVERED_WALLETS_CACHE.has(buy.source)) continue;
      
      const existingMonitored = await db.select().from(monitoredWallets)
        .where(eq(monitoredWallets.walletAddress, buy.source))
        .limit(1);
      
      if (existingMonitored.length > 0) continue;
      
      const behavior = await classifyWalletBehavior(buy.source, 7);
      const outcomes = await getWalletOutcomes(buy.source, 30);
      const stats = calculateOutcomeStats(outcomes);
      
      const wallet: DiscoveredWallet = {
        address: buy.source,
        discoveryMethod: "winner_backtrack",
        discoveredAt: now,
        sourceToken: position.tokenMint,
        sourceTokenSymbol: position.tokenSymbol || undefined,
        behaviorType: behavior.behaviorType,
        behaviorConfidence: behavior.confidence,
        score: calculateWalletScore(stats, behavior),
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate,
        totalPnl: stats.totalPnl,
        avgHoldTime: stats.avgHoldTime,
        followsLeaders: behavior.signals.followsLeaders || [],
        leadsFollowers: behavior.signals.leadsFollowers || [],
        copyChainDepth: 0,
      };
      
      discoveredWallets.push(wallet);
      DISCOVERED_WALLETS_CACHE.set(buy.source, wallet);
    }
  }
  
  console.log(`[WalletDiscovery] Backtracked ${discoveredWallets.length} new wallets from ${winningPositions.length} winning positions`);
  return discoveredWallets;
}

export async function trackCopyChain(
  seedWallet: string,
  maxDepth: number = 3
): Promise<{
  chain: string[][];
  totalFollowers: number;
  depth: number;
}> {
  const chain: string[][] = [];
  const visited = new Set<string>([seedWallet]);
  let currentLevel = [seedWallet];
  
  for (let depth = 0; depth < maxDepth; depth++) {
    const nextLevel: string[] = [];
    
    for (const wallet of currentLevel) {
      const behavior = await classifyWalletBehavior(wallet, 7);
      const followers = behavior.signals.leadsFollowers || [];
      
      for (const follower of followers) {
        if (!visited.has(follower)) {
          visited.add(follower);
          nextLevel.push(follower);
          
          if (!DISCOVERED_WALLETS_CACHE.has(follower)) {
            const followerBehavior = await classifyWalletBehavior(follower, 7);
            const outcomes = await getWalletOutcomes(follower, 14);
            const stats = calculateOutcomeStats(outcomes);
            
            DISCOVERED_WALLETS_CACHE.set(follower, {
              address: follower,
              discoveryMethod: "copy_chain",
              discoveredAt: Math.floor(Date.now() / 1000),
              behaviorType: followerBehavior.behaviorType,
              behaviorConfidence: followerBehavior.confidence,
              score: calculateWalletScore(stats, followerBehavior),
              wins: stats.wins,
              losses: stats.losses,
              winRate: stats.winRate,
              totalPnl: stats.totalPnl,
              avgHoldTime: stats.avgHoldTime,
              followsLeaders: followerBehavior.signals.followsLeaders || [],
              leadsFollowers: followerBehavior.signals.leadsFollowers || [],
              copyChainDepth: depth + 1,
            });
          }
        }
      }
    }
    
    if (nextLevel.length === 0) break;
    chain.push(nextLevel);
    currentLevel = nextLevel;
  }
  
  const totalFollowers = chain.reduce((sum, level) => sum + level.length, 0);
  console.log(`[WalletDiscovery] Copy chain from ${seedWallet.slice(0, 8)}...: ${totalFollowers} followers across ${chain.length} levels`);
  
  return {
    chain,
    totalFollowers,
    depth: chain.length,
  };
}

export async function getWalletOutcomes(
  wallet: string,
  windowDays: number = 30
): Promise<WalletOutcome[]> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowDays * 24 * 3600);
  
  const buys = await db.select().from(swaps)
    .where(and(
      eq(swaps.source, wallet),
      eq(swaps.type, "buy"),
      gte(swaps.timestamp, windowStart)
    ))
    .orderBy(swaps.timestamp);
  
  const outcomes: WalletOutcome[] = [];
  
  for (const buy of buys) {
    const sells = await db.select().from(swaps)
      .where(and(
        eq(swaps.source, wallet),
        eq(swaps.fromToken, buy.toToken),
        eq(swaps.type, "sell"),
        gte(swaps.timestamp, buy.timestamp)
      ))
      .orderBy(swaps.timestamp)
      .limit(1);
    
    if (sells.length > 0) {
      const sell = sells[0];
      const buyValue = buy.fromAmount || 0;
      const sellValue = sell.toAmount || 0;
      const pnlSol = sellValue - buyValue;
      const pnlPercent = buyValue > 0 ? ((sellValue - buyValue) / buyValue) * 100 : 0;
      
      outcomes.push({
        wallet,
        tokenMint: buy.toToken,
        entryTime: buy.timestamp,
        exitTime: sell.timestamp,
        pnlPercent,
        pnlSol,
        isWin: pnlPercent > 0,
      });
    }
  }
  
  return outcomes;
}

function calculateOutcomeStats(outcomes: WalletOutcome[]): {
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgHoldTime: number;
} {
  const wins = outcomes.filter(o => o.isWin).length;
  const losses = outcomes.filter(o => !o.isWin).length;
  const winRate = outcomes.length > 0 ? wins / outcomes.length : 0;
  const totalPnl = outcomes.reduce((sum, o) => sum + o.pnlSol, 0);
  
  const holdTimes = outcomes
    .filter(o => o.exitTime !== null)
    .map(o => (o.exitTime! - o.entryTime) / 60);
  
  const avgHoldTime = holdTimes.length > 0
    ? holdTimes.reduce((sum, t) => sum + t, 0) / holdTimes.length
    : 0;
  
  return { wins, losses, winRate, totalPnl, avgHoldTime };
}

function calculateWalletScore(
  stats: { wins: number; losses: number; winRate: number; totalPnl: number },
  behavior: { behaviorType: string; confidence: number }
): number {
  let score = 50;
  
  if (stats.winRate > 0.5) score += (stats.winRate - 0.5) * 40;
  if (stats.winRate < 0.3) score -= (0.3 - stats.winRate) * 30;
  
  if (stats.totalPnl > 0) score += Math.min(stats.totalPnl * 2, 20);
  if (stats.totalPnl < 0) score += Math.max(stats.totalPnl * 3, -25);
  
  if (behavior.behaviorType === "leader") score += 15 * behavior.confidence;
  if (behavior.behaviorType === "bot") score -= 20 * behavior.confidence;
  if (behavior.behaviorType === "follower") score -= 5 * behavior.confidence;
  
  const tradeCount = stats.wins + stats.losses;
  if (tradeCount >= 10) score += 10;
  if (tradeCount < 3) score -= 15;
  
  return Math.max(0, Math.min(100, score));
}

export async function getTopDiscoveredWallets(
  limit: number = 20,
  minScore: number = 60
): Promise<DiscoveredWallet[]> {
  const wallets = Array.from(DISCOVERED_WALLETS_CACHE.values())
    .filter(w => w.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  return wallets;
}

export async function getLeaderWallets(): Promise<DiscoveredWallet[]> {
  return Array.from(DISCOVERED_WALLETS_CACHE.values())
    .filter(w => w.behaviorType === "leader" && w.leadsFollowers.length >= 3)
    .sort((a, b) => b.leadsFollowers.length - a.leadsFollowers.length);
}

export async function getCopyChainStats(): Promise<{
  totalDiscovered: number;
  byMethod: Record<string, number>;
  avgScore: number;
  leaderCount: number;
  followerCount: number;
}> {
  const wallets = Array.from(DISCOVERED_WALLETS_CACHE.values());
  
  const byMethod: Record<string, number> = {};
  for (const w of wallets) {
    byMethod[w.discoveryMethod] = (byMethod[w.discoveryMethod] || 0) + 1;
  }
  
  const avgScore = wallets.length > 0
    ? wallets.reduce((sum, w) => sum + w.score, 0) / wallets.length
    : 0;
  
  return {
    totalDiscovered: wallets.length,
    byMethod,
    avgScore,
    leaderCount: wallets.filter(w => w.behaviorType === "leader").length,
    followerCount: wallets.filter(w => w.behaviorType === "follower").length,
  };
}

export async function runWalletDiscoveryCycle(): Promise<{
  backtracked: number;
  copyChains: number;
  totalDiscovered: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  
  const backtracked = await backtrackFromWinners(72, 20);
  
  const leaders = backtracked.filter(w => w.behaviorType === "leader");
  let copyChainFollowers = 0;
  
  for (const leader of leaders.slice(0, 5)) {
    const chain = await trackCopyChain(leader.address, 2);
    copyChainFollowers += chain.totalFollowers;
  }
  
  console.log(`[WalletDiscovery] Cycle complete: ${backtracked.length} backtracked, ${copyChainFollowers} from copy chains`);
  
  return {
    backtracked: backtracked.length,
    copyChains: copyChainFollowers,
    totalDiscovered: DISCOVERED_WALLETS_CACHE.size,
  };
}

export async function scoreWalletForSignal(
  wallet: string
): Promise<{
  score: number;
  recommendation: "add" | "skip" | "monitor";
  reasons: string[];
}> {
  const cached = DISCOVERED_WALLETS_CACHE.get(wallet);
  const behavior = cached || await (async () => {
    const b = await classifyWalletBehavior(wallet, 14);
    const outcomes = await getWalletOutcomes(wallet, 30);
    const stats = calculateOutcomeStats(outcomes);
    return {
      score: calculateWalletScore(stats, b),
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      behaviorType: b.behaviorType,
      behaviorConfidence: b.confidence,
      tradeCount: stats.wins + stats.losses,
      leadsFollowers: b.signals.leadsFollowers || [],
    };
  })();
  
  const score = cached?.score ?? (behavior as any).score ?? 50;
  const reasons: string[] = [];
  
  if (score >= 70) {
    reasons.push("High overall score");
  }
  
  const winRate = cached?.winRate ?? (behavior as any).winRate ?? 0;
  if (winRate >= 0.5) {
    reasons.push(`Good win rate: ${(winRate * 100).toFixed(0)}%`);
  } else if (winRate < 0.3) {
    reasons.push(`Low win rate: ${(winRate * 100).toFixed(0)}%`);
  }
  
  const behaviorType = cached?.behaviorType ?? (behavior as any).behaviorType;
  if (behaviorType === "leader") {
    reasons.push("Identified as market leader");
  } else if (behaviorType === "bot") {
    reasons.push("Appears to be a bot");
  }
  
  const tradeCount = cached ? cached.wins + cached.losses : (behavior as any).tradeCount ?? 0;
  if (tradeCount < 5) {
    reasons.push("Limited trade history");
  }
  
  let recommendation: "add" | "skip" | "monitor";
  if (score >= 70 && behaviorType !== "bot") {
    recommendation = "add";
  } else if (score < 40 || behaviorType === "bot") {
    recommendation = "skip";
  } else {
    recommendation = "monitor";
  }
  
  return { score, recommendation, reasons };
}

export function getDiscoveredWalletCache(): DiscoveredWallet[] {
  return Array.from(DISCOVERED_WALLETS_CACHE.values());
}

export function clearDiscoveredWalletCache(): void {
  DISCOVERED_WALLETS_CACHE.clear();
}

// =====================
// RETROLEARNER WALLET DISCOVERY
// =====================

export interface HolderRanking {
  wallet: string;
  criteria: ("earliest" | "largest_balance" | "largest_investment" | "best_pnl")[];
  score: number;
}

export interface WalletPnLMetrics {
  wallet: string;
  totalPnl7d: number;
  winRate7d: number;
  avgHoldMinutes: number;
  sharpeRatio: number;
  sampleCount: number;
}

/**
 * Rank holders of a token by multiple criteria
 * Returns top 40 wallets with diverse perspective:
 * - Top 10 earliest buyers (first-mover advantage)
 * - Top 10 by current holdings (conviction/belief)
 * - Top 10 by investment amount (whale vote)
 * - Top 10 by realized PnL (success metric)
 */
export async function rankHoldersByMultipleCriteria(
  tokenMint: string,
  limit: number = 40
): Promise<HolderRanking[]> {
  const now = Math.floor(Date.now() / 1000);

  try {
    // Get all wallets who bought this token
    const allBuyers = await db
      .select({
        wallet: swaps.source,
        firstBuyTime: sql<number>`min(${swaps.timestamp})`,
        totalInvested: sql<number>`sum(${swaps.fromAmount})`,
        totalBought: sql<number>`sum(${swaps.toAmount})`,
      })
      .from(swaps)
      .where(eq(swaps.toToken, tokenMint))
      .groupBy(swaps.source);

    if (allBuyers.length === 0) {
      return [];
    }

    // Rank 1: Earliest 10 buyers
    const earliestBuyers = allBuyers
      .sort((a, b) => (a.firstBuyTime || 0) - (b.firstBuyTime || 0))
      .slice(0, 10)
      .map(w => ({ wallet: w.wallet, criteria: ["earliest" as const] }));

    // Rank 2: Top 10 by investment amount (largest spenders)
    const largestInvestors = allBuyers
      .sort((a, b) => (b.totalInvested || 0) - (a.totalInvested || 0))
      .slice(0, 10)
      .map(w => ({ wallet: w.wallet, criteria: ["largest_investment" as const] }));

    // Rank 3: Top 10 by current holdings (would need on-chain query for actual balance)
    // For now, use total bought as proxy
    const largestHolders = allBuyers
      .sort((a, b) => (b.totalBought || 0) - (a.totalBought || 0))
      .slice(0, 10)
      .map(w => ({ wallet: w.wallet, criteria: ["largest_balance" as const] }));

    // Rank 4: Top 10 by PnL (from their sell transactions)
    const walletProfitsPromises = allBuyers.map(buyer =>
      calculateWalletPnLOnToken(buyer.wallet, tokenMint).then(profit => ({
        wallet: buyer.wallet,
        pnl: profit,
      }))
    );
    const walletProfits = await Promise.all(walletProfitsPromises);

    const bestPerformers = walletProfits
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 10)
      .map(w => ({ wallet: w.wallet, criteria: ["best_pnl" as const] }));

    // Merge all rankings, deduplicate
    const merged = new Map<string, HolderRanking>();

    [...earliestBuyers, ...largestInvestors, ...largestHolders, ...bestPerformers].forEach(
      (ranking) => {
        if (merged.has(ranking.wallet)) {
          const existing = merged.get(ranking.wallet)!;
          existing.criteria = Array.from(new Set([...existing.criteria, ...ranking.criteria]));
        } else {
          merged.set(ranking.wallet, {
            wallet: ranking.wallet,
            criteria: ranking.criteria,
            score: 0,
          });
        }
      }
    );

    // Score based on number of criteria matched
    const results = Array.from(merged.values())
      .map(r => ({
        ...r,
        score: r.criteria.length / 4, // Normalized to 0-1 based on criteria matched
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
  } catch (error) {
    console.error(`[WalletDiscovery] Error ranking holders for ${tokenMint}:`, error);
    return [];
  }
}

/**
 * Calculate wallet's PnL on a specific token
 */
async function calculateWalletPnLOnToken(wallet: string, tokenMint: string): Promise<number> {
  try {
    const trades = await db
      .select({
        type: swaps.type,
        fromAmount: swaps.fromAmount,
        toAmount: swaps.toAmount,
      })
      .from(swaps)
      .where(
        and(
          eq(swaps.source, wallet),
          eq(swaps.toToken, tokenMint)
        )
      );

    if (trades.length === 0) return 0;

    // Simple PnL: sum of (toAmount - fromAmount) for all trades
    let totalPnl = 0;
    trades.forEach(t => {
      const amount = t.type === "buy" ? -(t.fromAmount || 0) : (t.toAmount || 0);
      totalPnl += amount;
    });

    return totalPnl;
  } catch (error) {
    return 0;
  }
}

/**
 * Assess wallet's PnL metrics over past 7 days
 * Called at retrolearner execution time
 */
export async function assessWalletPnL(
  walletAddress: string,
  lookbackDays: number = 7
): Promise<WalletPnLMetrics> {
  const now = Math.floor(Date.now() / 1000);
  const lookbackStart = now - (lookbackDays * 86400);

  try {
    const trades = await db
      .select()
      .from(swaps)
      .where(
        and(
          eq(swaps.source, walletAddress),
          gte(swaps.timestamp, lookbackStart)
        )
      )
      .orderBy(swaps.timestamp);

    if (trades.length === 0) {
      return {
        wallet: walletAddress,
        totalPnl7d: 0,
        winRate7d: 0,
        avgHoldMinutes: 0,
        sharpeRatio: 0,
        sampleCount: 0,
      };
    }

    // Group trades by token to track positions
    type TradeRecord = typeof trades[0];
    interface Position {
      buys: TradeRecord[];
      sells: TradeRecord[];
    }
    const positions = new Map<string, Position>();

    trades.forEach(trade => {
      if (!positions.has(trade.toToken)) {
        positions.set(trade.toToken, { buys: [], sells: [] });
      }
      const pos = positions.get(trade.toToken)!;
      if (trade.type === "buy") {
        pos.buys.push(trade);
      } else {
        pos.sells.push(trade);
      }
    });

    // Calculate PnL and hold times
    let totalPnl = 0;
    let winCount = 0;
    let lossCount = 0;
    let holdTimes: number[] = [];
    let pnlValues: number[] = [];

    // Convert Map to Array to avoid Map iteration type issues
    const positionsArray = Array.from(positions.entries());
    for (const [_token, { buys, sells }] of positionsArray) {
      // Simple matching: pair buys with sells chronologically
      const buyQueue = [...buys].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const sellQueue = [...sells].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let buyIdx = 0;
      let remaining = 0;

      for (const sell of sellQueue) {
        while (buyIdx < buyQueue.length && remaining <= 0) {
          remaining += buyQueue[buyIdx].toAmount || 0;
          buyIdx++;
        }

        if (remaining > 0) {
          const sellAmount = Math.min(remaining, sell.toAmount || 0);
          remaining -= sellAmount;

          // Simple PnL: profit per unit
          const pnl = sellAmount - (sellAmount * ((buyQueue[buyIdx - 1]?.fromAmount || 0) / (buyQueue[buyIdx - 1]?.toAmount || 1)));
          totalPnl += pnl;
          pnlValues.push(pnl);

          if (pnl > 0) {
            winCount++;
          } else {
            lossCount++;
          }

          // Hold time
          const holdMinutes = ((sell.timestamp || 0) - (buyQueue[buyIdx - 1]?.timestamp || 0)) / 60;
          if (holdMinutes > 0) {
            holdTimes.push(holdMinutes);
          }
        }
      }
    }

    const sampleCount = winCount + lossCount;
    const winRate = sampleCount > 0 ? winCount / sampleCount : 0;
    const avgHoldMinutes = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b) / holdTimes.length : 0;

    // Calculate Sharpe ratio (simplified: std dev of returns)
    let sharpeRatio = 0;
    if (pnlValues.length > 1) {
      const mean = pnlValues.reduce((a, b) => a + b) / pnlValues.length;
      const variance = pnlValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / pnlValues.length;
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? mean / stdDev : 0;
    }

    return {
      wallet: walletAddress,
      totalPnl7d: totalPnl,
      winRate7d: winRate,
      avgHoldMinutes,
      sharpeRatio,
      sampleCount,
    };
  } catch (error) {
    console.error(`[WalletDiscovery] Error assessing PnL for ${walletAddress}:`, error);
    return {
      wallet: walletAddress,
      totalPnl7d: 0,
      winRate7d: 0,
      avgHoldMinutes: 0,
      sharpeRatio: 0,
      sampleCount: 0,
    };
  }
}

/**
 * Discover wallets from tokens they profited on in the past N hours
 * Used by retrolearner to find missed opportunities and extract wallets
 */
export async function discoverWalletsFromMissedTokens(
  lookbackHours: number = 24,
  minProfitPercent: number = 5
): Promise<Map<string, HolderRanking[]>> {
  const now = Math.floor(Date.now() / 1000);
  const lookbackStart = now - (lookbackHours * 3600);

  try {
    // Find all profitable trades in the lookback window
    const profitableTrades = await db
      .select({
        wallet: swaps.source,
        token: swaps.toToken,
        type: swaps.type,
        fromAmount: swaps.fromAmount,
        toAmount: swaps.toAmount,
        timestamp: swaps.timestamp,
      })
      .from(swaps)
      .where(gte(swaps.timestamp, lookbackStart))
      .orderBy(desc(swaps.timestamp));

    // Group by token and identify which ones had profitable trades
    const tokenProfitability = new Map<string, number>();
    const walletsByToken = new Map<string, Set<string>>();

    profitableTrades.forEach(trade => {
      // Simple profitability check: if it's a sell, check if amount increased
      if (trade.type === "sell") {
        const profitPercent = ((trade.toAmount || 0) - (trade.fromAmount || 0)) / (trade.fromAmount || 1) * 100;
        if (profitPercent > minProfitPercent) {
          tokenProfitability.set(trade.token, (tokenProfitability.get(trade.token) || 0) + profitPercent);
          if (!walletsByToken.has(trade.token)) {
            walletsByToken.set(trade.token, new Set());
          }
          walletsByToken.get(trade.token)?.add(trade.wallet);
        }
      }
    });

    // For each profitable token, rank its holders
    const results = new Map<string, HolderRanking[]>();
    const walletsByTokenArray = Array.from(walletsByToken.entries());
    for (const [tokenMint, _wallets] of walletsByTokenArray) {
      const holders = await rankHoldersByMultipleCriteria(tokenMint, 40);
      results.set(tokenMint, holders);
    }

    return results;
  } catch (error) {
    console.error(`[WalletDiscovery] Error discovering wallets from missed tokens:`, error);
    return new Map();
  }
}
