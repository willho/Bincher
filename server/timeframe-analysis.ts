import { db } from "./db";
import { swaps, paperPositions, holdings, discoveryEvents, discoveryTriggers, monitoredWallets, tokenDataPool } from "@shared/schema";
import { eq, and, gte, lte, desc, sql, gt, asc } from "drizzle-orm";

export interface DailyWinnerAggregation {
  date: string;
  topWinners: Array<{
    tokenMint: string;
    tokenSymbol: string;
    totalPnlSol: number;
    avgPnlPercent: number;
    tradeCount: number;
    bestPnlPercent: number;
  }>;
  topLosers: Array<{
    tokenMint: string;
    tokenSymbol: string;
    totalPnlSol: number;
    avgPnlPercent: number;
    tradeCount: number;
    worstPnlPercent: number;
  }>;
  overallStats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    netPnlSol: number;
  };
}

export interface WeeklySourceReview {
  weekStart: string;
  weekEnd: string;
  sourcePerformance: Array<{
    sourceId: string;
    sourceType: string;
    tokensDiscovered: number;
    profitableTokens: number;
    successRate: number;
    avgPnlPercent: number;
    recommendation: "expand" | "maintain" | "reduce" | "remove";
  }>;
  walletPerformance: Array<{
    walletAddress: string;
    trades: number;
    wins: number;
    winRate: number;
    netPnlSol: number;
    recommendation: "promote" | "maintain" | "demote" | "remove";
  }>;
  systemHealth: {
    discoveryAccuracy: number;
    copyTradeSuccess: number;
    paperTradeAccuracy: number;
  };
}

export interface HourlyHotMover {
  tokenMint: string;
  tokenSymbol: string;
  priceChange1h: number;
  volumeChange1h: number;
  buyPressure: number;
  whaleActivity: boolean;
  heatScore: number;
  discoveredAt: number;
}

export async function getDailyWinnerAggregation(
  date: Date = new Date()
): Promise<DailyWinnerAggregation> {
  const dateStr = date.toISOString().slice(0, 10);
  const dayStart = Math.floor(new Date(dateStr).getTime() / 1000);
  const dayEnd = dayStart + 86400;
  
  const closedPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "closed"),
      gte(paperPositions.exitTimestamp, dayStart),
      lte(paperPositions.exitTimestamp, dayEnd)
    ));
  
  const tokenStats: Map<string, {
    tokenMint: string;
    tokenSymbol: string;
    totalPnlSol: number;
    pnlPercents: number[];
    tradeCount: number;
  }> = new Map();
  
  for (const pos of closedPositions) {
    const existing = tokenStats.get(pos.tokenMint) || {
      tokenMint: pos.tokenMint,
      tokenSymbol: pos.tokenSymbol || "UNKNOWN",
      totalPnlSol: 0,
      pnlPercents: [],
      tradeCount: 0,
    };
    
    existing.totalPnlSol += pos.realizedPnl || 0;
    if (pos.realizedPnlPercent) existing.pnlPercents.push(pos.realizedPnlPercent);
    existing.tradeCount++;
    tokenStats.set(pos.tokenMint, existing);
  }
  
  const sorted = Array.from(tokenStats.values());
  
  const topWinners = sorted
    .filter(t => t.totalPnlSol > 0)
    .sort((a, b) => b.totalPnlSol - a.totalPnlSol)
    .slice(0, 10)
    .map(t => ({
      tokenMint: t.tokenMint,
      tokenSymbol: t.tokenSymbol,
      totalPnlSol: t.totalPnlSol,
      avgPnlPercent: t.pnlPercents.length > 0 
        ? t.pnlPercents.reduce((a, b) => a + b, 0) / t.pnlPercents.length 
        : 0,
      tradeCount: t.tradeCount,
      bestPnlPercent: Math.max(...t.pnlPercents, 0),
    }));
  
  const topLosers = sorted
    .filter(t => t.totalPnlSol < 0)
    .sort((a, b) => a.totalPnlSol - b.totalPnlSol)
    .slice(0, 10)
    .map(t => ({
      tokenMint: t.tokenMint,
      tokenSymbol: t.tokenSymbol,
      totalPnlSol: t.totalPnlSol,
      avgPnlPercent: t.pnlPercents.length > 0 
        ? t.pnlPercents.reduce((a, b) => a + b, 0) / t.pnlPercents.length 
        : 0,
      tradeCount: t.tradeCount,
      worstPnlPercent: Math.min(...t.pnlPercents, 0),
    }));
  
  const winningTrades = closedPositions.filter(p => (p.realizedPnl || 0) > 0).length;
  const losingTrades = closedPositions.filter(p => (p.realizedPnl || 0) < 0).length;
  const netPnlSol = closedPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  
  return {
    date: dateStr,
    topWinners,
    topLosers,
    overallStats: {
      totalTrades: closedPositions.length,
      winningTrades,
      losingTrades,
      winRate: closedPositions.length > 0 ? winningTrades / closedPositions.length : 0,
      netPnlSol,
    },
  };
}

export async function getWeeklySourceReview(
  weekStart: Date = new Date(Date.now() - 7 * 24 * 3600 * 1000)
): Promise<WeeklySourceReview> {
  const weekStartTs = Math.floor(weekStart.getTime() / 1000);
  const weekEndTs = weekStartTs + 7 * 24 * 3600;
  
  const events = await db.select().from(discoveryEvents)
    .where(and(
      gte(discoveryEvents.firedAt, weekStartTs),
      lte(discoveryEvents.firedAt, weekEndTs)
    ));
  
  const triggers = await db.select().from(discoveryTriggers);
  const triggerMap = new Map(triggers.map(t => [t.id, t]));
  
  const sourceStats: Map<string, {
    sourceId: string;
    sourceType: string;
    tokensDiscovered: number;
    profitableTokens: number;
    pnlPercents: number[];
  }> = new Map();
  
  for (const event of events) {
    const trigger = triggerMap.get(event.triggerId);
    const sourceId = trigger?.name || `trigger_${event.triggerId}`;
    const sourceType = trigger?.metric || "unknown";
    
    const existing = sourceStats.get(sourceId) || {
      sourceId,
      sourceType,
      tokensDiscovered: 0,
      profitableTokens: 0,
      pnlPercents: [],
    };
    
    existing.tokensDiscovered++;
    if (event.outcome === "profit") {
      existing.profitableTokens++;
    }
    if (event.outcomePercent !== null) {
      existing.pnlPercents.push(event.outcomePercent);
    }
    
    sourceStats.set(sourceId, existing);
  }
  
  const sourcePerformance = Array.from(sourceStats.values())
    .map(s => {
      const successRate = s.tokensDiscovered > 0 
        ? s.profitableTokens / s.tokensDiscovered 
        : 0;
      const avgPnl = s.pnlPercents.length > 0
        ? s.pnlPercents.reduce((a, b) => a + b, 0) / s.pnlPercents.length
        : 0;
      
      let recommendation: "expand" | "maintain" | "reduce" | "remove";
      if (successRate >= 0.6 && avgPnl > 10) {
        recommendation = "expand";
      } else if (successRate >= 0.4) {
        recommendation = "maintain";
      } else if (successRate >= 0.25) {
        recommendation = "reduce";
      } else {
        recommendation = "remove";
      }
      
      return {
        sourceId: s.sourceId,
        sourceType: s.sourceType,
        tokensDiscovered: s.tokensDiscovered,
        profitableTokens: s.profitableTokens,
        successRate,
        avgPnlPercent: avgPnl,
        recommendation,
      };
    })
    .sort((a, b) => b.successRate - a.successRate);
  
  const wallets = await db.select().from(monitoredWallets)
    .where(eq(monitoredWallets.enabled, true));
  
  const walletPerformance = [];
  
  for (const wallet of wallets) {
    const walletHoldings = await db.select().from(holdings)
      .where(and(
        eq(holdings.signalWalletId, wallet.id),
        eq(holdings.positionStatus, "inactive"),
        gte(holdings.reclaimTimestamp, weekStartTs)
      ));
    
    const wins = walletHoldings.filter(h => {
      const currentValue = (h.currentAmount || 0) * (h.lastPrice || 0);
      return currentValue > (h.solSpent || 0);
    }).length;
    const netPnl = walletHoldings.reduce((sum, h) => {
      const currentValue = (h.currentAmount || 0) * (h.lastPrice || 0);
      return sum + (currentValue - (h.solSpent || 0));
    }, 0);
    const winRate = walletHoldings.length > 0 ? wins / walletHoldings.length : 0;
    
    let recommendation: "promote" | "maintain" | "demote" | "remove";
    if (winRate >= 0.55 && netPnl > 0) {
      recommendation = "promote";
    } else if (winRate >= 0.4) {
      recommendation = "maintain";
    } else if (winRate >= 0.25 || walletHoldings.length < 5) {
      recommendation = "demote";
    } else {
      recommendation = "remove";
    }
    
    walletPerformance.push({
      walletAddress: wallet.walletAddress,
      trades: walletHoldings.length,
      wins,
      winRate,
      netPnlSol: netPnl,
      recommendation,
    });
  }
  
  walletPerformance.sort((a, b) => b.winRate - a.winRate);
  
  const discoveryAccuracy = sourcePerformance.length > 0
    ? sourcePerformance.reduce((sum, s) => sum + s.successRate, 0) / sourcePerformance.length
    : 0;
  
  const walletStats = walletPerformance.filter(w => w.trades >= 3);
  const copyTradeSuccess = walletStats.length > 0
    ? walletStats.reduce((sum, w) => sum + w.winRate, 0) / walletStats.length
    : 0;
  
  const paperTrades = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "closed"),
      gte(paperPositions.exitTimestamp, weekStartTs)
    ));
  
  const paperWins = paperTrades.filter(p => (p.realizedPnl || 0) > 0).length;
  const paperTradeAccuracy = paperTrades.length > 0 ? paperWins / paperTrades.length : 0;
  
  return {
    weekStart: new Date(weekStartTs * 1000).toISOString().slice(0, 10),
    weekEnd: new Date(weekEndTs * 1000).toISOString().slice(0, 10),
    sourcePerformance,
    walletPerformance: walletPerformance.slice(0, 20),
    systemHealth: {
      discoveryAccuracy,
      copyTradeSuccess,
      paperTradeAccuracy,
    },
  };
}

export async function getHourlyHotMovers(
  limit: number = 20
): Promise<HourlyHotMover[]> {
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;
  
  const recentBuys = await db.select({
    tokenMint: swaps.toToken,
    symbol: swaps.toTokenSymbol,
    buyCount: sql<number>`count(*)`,
    totalSol: sql<number>`sum(from_amount)`,
    avgSol: sql<number>`avg(from_amount)`,
    maxSol: sql<number>`max(from_amount)`,
  })
    .from(swaps)
    .where(and(
      eq(swaps.type, "buy"),
      gte(swaps.timestamp, oneHourAgo)
    ))
    .groupBy(swaps.toToken, swaps.toTokenSymbol)
    .orderBy(desc(sql`sum(from_amount)`))
    .limit(limit * 2);
  
  const hotMovers: HourlyHotMover[] = [];
  
  for (const buy of recentBuys) {
    const [tokenData] = await db.select().from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, buy.tokenMint))
      .limit(1);
    
    const priceChange1h = tokenData?.priceChange24h 
      ? tokenData.priceChange24h / 24
      : 0;
    
    const volumeChange1h = buy.totalSol > 1 ? buy.totalSol / 10 : 0;
    const buyPressure = buy.buyCount > 3 ? Math.min(buy.buyCount / 10, 1) : 0;
    const whaleActivity = buy.maxSol >= 5;
    
    const heatScore = 
      Math.min(priceChange1h * 2, 30) +
      Math.min(volumeChange1h * 5, 30) +
      (buyPressure * 20) +
      (whaleActivity ? 15 : 0) +
      5;
    
    hotMovers.push({
      tokenMint: buy.tokenMint,
      tokenSymbol: buy.symbol || "UNKNOWN",
      priceChange1h,
      volumeChange1h,
      buyPressure,
      whaleActivity,
      heatScore: Math.min(100, Math.max(0, heatScore)),
      discoveredAt: now,
    });
  }
  
  return hotMovers
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, limit);
}

export async function runDailyAggregation(): Promise<{
  date: string;
  winnersCount: number;
  losersCount: number;
  netPnl: number;
}> {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const aggregation = await getDailyWinnerAggregation(yesterday);
  
  console.log(`[TimeframeAnalysis] Daily aggregation for ${aggregation.date}: ${aggregation.overallStats.winningTrades} wins, ${aggregation.overallStats.losingTrades} losses, net ${aggregation.overallStats.netPnlSol.toFixed(2)} SOL`);
  
  return {
    date: aggregation.date,
    winnersCount: aggregation.topWinners.length,
    losersCount: aggregation.topLosers.length,
    netPnl: aggregation.overallStats.netPnlSol,
  };
}

export async function runWeeklyReview(): Promise<{
  sourcesReviewed: number;
  walletsReviewed: number;
  recommendedRemovals: number;
}> {
  const review = await getWeeklySourceReview();
  
  const sourcesToRemove = review.sourcePerformance.filter(s => s.recommendation === "remove").length;
  const walletsToRemove = review.walletPerformance.filter(w => w.recommendation === "remove").length;
  
  console.log(`[TimeframeAnalysis] Weekly review: ${review.sourcePerformance.length} sources, ${review.walletPerformance.length} wallets, ${sourcesToRemove + walletsToRemove} removal candidates`);
  
  return {
    sourcesReviewed: review.sourcePerformance.length,
    walletsReviewed: review.walletPerformance.length,
    recommendedRemovals: sourcesToRemove + walletsToRemove,
  };
}
