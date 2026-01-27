import { db } from "./db";
import { holdings, pendingBuys, tokenSnapshots } from "@shared/schema";
import { eq, gte, and, or, desc, sql } from "drizzle-orm";

export interface TokenHeatData {
  tokenMint: string;
  tokenSymbol: string;
  heatScore: number;
  heatTier: "hot" | "warm" | "cold";
  factors: {
    recentBuys: number;
    priceVolatility: number;
    userAttention: number;
    recency: number;
  };
  lastUpdated: number;
}

const heatCache = new Map<string, TokenHeatData>();
const CACHE_TTL_MS = 60 * 1000;

export async function calculateTokenHeat(tokenMint: string): Promise<TokenHeatData> {
  const cached = heatCache.get(tokenMint);
  if (cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
    return cached;
  }

  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;
  const oneHourAgo = now - 3600;

  let tokenSymbol = tokenMint.slice(0, 6) + "...";
  let recentBuysScore = 0;
  let priceVolatilityScore = 0;
  let userAttentionScore = 0;
  let recencyScore = 0;

  const recentHoldings = await db.select().from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      gte(holdings.buyTimestamp, oneDayAgo)
    ));

  if (recentHoldings.length > 0) {
    tokenSymbol = recentHoldings[0].tokenSymbol;
    recentBuysScore = Math.min(100, recentHoldings.length * 20);
    
    const latestBuy = Math.max(...recentHoldings.map(h => h.buyTimestamp));
    const hoursSinceBuy = (now - latestBuy) / 3600;
    recencyScore = Math.max(0, 100 - hoursSinceBuy * 4);
    
    const uniqueUsers = new Set(recentHoldings.map(h => h.userId)).size;
    userAttentionScore = Math.min(100, uniqueUsers * 25);
  }

  const recentPending = await db.select().from(pendingBuys)
    .where(and(
      eq(pendingBuys.tokenMint, tokenMint),
      gte(pendingBuys.detectedAt, oneDayAgo)
    ));

  if (recentPending.length > 0) {
    recentBuysScore = Math.min(100, recentBuysScore + recentPending.length * 15);
    
    const uniquePendingUsers = new Set(recentPending.map(p => p.userId)).size;
    userAttentionScore = Math.min(100, userAttentionScore + uniquePendingUsers * 20);
    
    const latestPending = Math.max(...recentPending.map(p => p.detectedAt));
    const hoursSincePending = (now - latestPending) / 3600;
    recencyScore = Math.max(recencyScore, 100 - hoursSincePending * 4);
  }

  const snapshots = await db.select().from(tokenSnapshots)
    .where(eq(tokenSnapshots.tokenMint, tokenMint))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(5);

  if (snapshots.length >= 2) {
    const priceChanges: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i].priceUsd || 0;
      const curr = snapshots[i - 1].priceUsd || 0;
      if (prev > 0) {
        priceChanges.push(Math.abs((curr - prev) / prev) * 100);
      }
    }
    const avgChange = priceChanges.reduce((a, b) => a + b, 0) / (priceChanges.length || 1);
    priceVolatilityScore = Math.min(100, avgChange * 2);
  } else if (snapshots.length === 1 && snapshots[0].priceChange24h) {
    priceVolatilityScore = Math.min(100, Math.abs(snapshots[0].priceChange24h) * 2);
  }

  const heatScore = Math.round(
    (recentBuysScore * 0.30) +
    (priceVolatilityScore * 0.25) +
    (userAttentionScore * 0.25) +
    (recencyScore * 0.20)
  );

  let heatTier: "hot" | "warm" | "cold";
  if (heatScore >= 60) {
    heatTier = "hot";
  } else if (heatScore >= 30) {
    heatTier = "warm";
  } else {
    heatTier = "cold";
  }

  const heatData: TokenHeatData = {
    tokenMint,
    tokenSymbol,
    heatScore,
    heatTier,
    factors: {
      recentBuys: recentBuysScore,
      priceVolatility: priceVolatilityScore,
      userAttention: userAttentionScore,
      recency: recencyScore,
    },
    lastUpdated: Date.now(),
  };

  heatCache.set(tokenMint, heatData);
  return heatData;
}

export async function getHotTokens(): Promise<TokenHeatData[]> {
  const allTokenMints = new Set<string>();

  const recentHoldings = await db.select({ tokenMint: holdings.tokenMint })
    .from(holdings)
    .where(gte(holdings.buyTimestamp, Math.floor(Date.now() / 1000) - 86400 * 3));

  recentHoldings.forEach(h => allTokenMints.add(h.tokenMint));

  const activePending = await db.select({ tokenMint: pendingBuys.tokenMint })
    .from(pendingBuys)
    .where(or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused")));

  activePending.forEach(p => allTokenMints.add(p.tokenMint));

  const heatScores: TokenHeatData[] = [];
  for (const tokenMint of allTokenMints) {
    const heat = await calculateTokenHeat(tokenMint);
    heatScores.push(heat);
  }

  return heatScores.sort((a, b) => b.heatScore - a.heatScore);
}

export async function getTokensByTier(tier: "hot" | "warm" | "cold"): Promise<TokenHeatData[]> {
  const allTokens = await getHotTokens();
  return allTokens.filter(t => t.heatTier === tier);
}

export function clearHeatCache(): void {
  heatCache.clear();
}
