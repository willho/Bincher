import { db } from "./db";
import { walletLeaderboard } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

/**
 * Calculate unified wallet score: (reliability × discovery_quality) × (1 - risk_factor)
 * Unbounded: no ceiling, allows clear differentiation
 * 80% win rate always scores higher than 60% win rate
 */
export function calculateUnifiedWalletScore(
  reliabilityScore: number, // 0-1: from familiar whales
  discoveryQuality: number, // 0-1: from wallet discovery
  riskFactor: number // 0-1: penalty for negative PnL, low win rate
): number {
  // Unbounded scoring: product of two factors penalized by risk
  const score = reliabilityScore * discoveryQuality * (1 - riskFactor);
  return Math.max(0, score);
}

/**
 * Calculate risk factor based on wallet metrics
 * 0 = low risk (good PnL, high win rate)
 * 1 = high risk (negative PnL, low win rate)
 */
export function calculateRiskFactor(winRate: number, totalPnlPercent: number): number {
  let risk = 0.5; // Base risk

  // Penalty for low win rate (<30%)
  if (winRate < 0.3) {
    risk += (0.3 - winRate) * 0.3; // Up to +0.3 penalty
  }

  // Penalty for negative PnL
  if (totalPnlPercent < 0) {
    risk += Math.min(0.2, Math.abs(totalPnlPercent) / 100 * 0.2); // Up to +0.2 penalty
  }

  return Math.min(1.0, risk);
}

/**
 * Consolidate wallet score from multiple sources
 */
export async function updateWalletLeaderboard(
  walletAddress: string,
  walletLabel: string | undefined,
  reliabilityScore: number, // From familiar-whales system
  discoveryQuality: number, // From wallet-discovery system
  totalTrades: number,
  winRate: number, // 0-1
  averageMultiplier: number,
  totalPnlPercent: number,
  recentPerformance: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Calculate risk factor
  const riskFactor = calculateRiskFactor(winRate, totalPnlPercent);

  // Calculate unified score
  const unifiedScore = calculateUnifiedWalletScore(reliabilityScore, discoveryQuality, riskFactor);

  // Determine flags
  const hasNegativePnl = totalPnlPercent < 0;
  const isLowWinRate = winRate < 0.3;
  const isInsufficientHistory = totalTrades < 10;

  const existing = await db
    .select()
    .from(walletLeaderboard)
    .where(eq(walletLeaderboard.walletAddress, walletAddress))
    .limit(1);

  if (existing.length > 0) {
    // Update existing entry
    await db
      .update(walletLeaderboard)
      .set({
        walletLabel: walletLabel || existing[0].walletLabel,
        unifiedScore,
        reliabilityScore,
        discoveryQuality,
        riskFactor,
        totalTrades,
        winRate,
        averageMultiplier,
        totalPnlPercent,
        recentPerformance,
        hasNegativePnl,
        isLowWinRate,
        isInsufficientHistory,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(walletLeaderboard.walletAddress, walletAddress));
  } else {
    // Create new entry
    await db.insert(walletLeaderboard).values({
      walletAddress,
      walletLabel,
      unifiedScore,
      reliabilityScore,
      discoveryQuality,
      riskFactor,
      totalTrades,
      winRate,
      averageMultiplier,
      totalPnlPercent,
      recentPerformance,
      hasNegativePnl,
      isLowWinRate,
      isInsufficientHistory,
      lastActivityAt: now,
      createdAt: now,
    });
  }
}

/**
 * Get wallet leaderboard with percentile rankings
 */
export async function getWalletLeaderboard(
  limit: number = 50,
  minScore: number = 0,
  minWinRate: number = 0,
  minTrades: number = 0
): Promise<
  Array<{
    rank: number;
    percentile: number;
    walletAddress: string;
    walletLabel: string | null;
    unifiedScore: number;
    winRate: number;
    totalTrades: number;
    averageMultiplier: number;
    totalPnlPercent: number;
    recentPerformance: number;
  }>
> {
  // Get all wallets ordered by unified score
  const allWallets = await db
    .select()
    .from(walletLeaderboard)
    .where(eq(walletLeaderboard.isInsufficientHistory, false))
    .orderBy(desc(walletLeaderboard.unifiedScore))
    .limit(Math.max(limit, 500));

  // Filter by criteria
  const filtered = allWallets.filter(
    w =>
      w.unifiedScore >= minScore &&
      w.winRate >= minWinRate &&
      w.totalTrades >= minTrades
  );

  // Calculate percentiles
  const totalCount = allWallets.length;
  const leaderboard = filtered.slice(0, limit).map((wallet, idx) => {
    const rank = idx + 1;
    const walletIndex = allWallets.findIndex(w => w.walletAddress === wallet.walletAddress);
    const percentile = totalCount > 0 ? ((totalCount - walletIndex) / totalCount) * 100 : 0;

    return {
      rank,
      percentile: Math.round(percentile * 10) / 10,
      walletAddress: wallet.walletAddress,
      walletLabel: wallet.walletLabel,
      unifiedScore: wallet.unifiedScore,
      winRate: wallet.winRate,
      totalTrades: wallet.totalTrades,
      averageMultiplier: wallet.averageMultiplier,
      totalPnlPercent: wallet.totalPnlPercent,
      recentPerformance: wallet.recentPerformance,
    };
  });

  return leaderboard;
}

/**
 * Get single wallet details with percentile
 */
export async function getWalletDetail(walletAddress: string): Promise<{
  rank: number;
  percentile: number;
  walletAddress: string;
  walletLabel: string | null;
  unifiedScore: number;
  reliabilityScore: number;
  discoveryQuality: number;
  riskFactor: number;
  winRate: number;
  totalTrades: number;
  averageMultiplier: number;
  totalPnlPercent: number;
  recentPerformance: number;
  flags: {
    hasNegativePnl: boolean;
    isLowWinRate: boolean;
    isInsufficientHistory: boolean;
  };
} | null> {
  const wallet = await db
    .select()
    .from(walletLeaderboard)
    .where(eq(walletLeaderboard.walletAddress, walletAddress))
    .limit(1);

  if (wallet.length === 0) return null;

  const w = wallet[0];

  // Get all wallets for percentile calculation
  const allWallets = await db
    .select()
    .from(walletLeaderboard)
    .where(eq(walletLeaderboard.isInsufficientHistory, false));

  const allScores = allWallets
    .map(w => w.unifiedScore)
    .sort((a, b) => b - a);
  const rank = allScores.findIndex(score => score === w.unifiedScore) + 1;
  const percentile = allWallets.length > 0 ? ((allWallets.length - rank + 1) / allWallets.length) * 100 : 0;

  return {
    rank,
    percentile: Math.round(percentile * 10) / 10,
    walletAddress: w.walletAddress,
    walletLabel: w.walletLabel,
    unifiedScore: w.unifiedScore,
    reliabilityScore: w.reliabilityScore,
    discoveryQuality: w.discoveryQuality,
    riskFactor: w.riskFactor,
    winRate: w.winRate,
    totalTrades: w.totalTrades,
    averageMultiplier: w.averageMultiplier,
    totalPnlPercent: w.totalPnlPercent,
    recentPerformance: w.recentPerformance,
    flags: {
      hasNegativePnl: w.hasNegativePnl,
      isLowWinRate: w.isLowWinRate,
      isInsufficientHistory: w.isInsufficientHistory,
    },
  };
}

/**
 * Get top wallets by different criteria
 */
export async function getTopWalletsByRecentPerformance(limit: number = 20): Promise<
  Array<{
    rank: number;
    percentile: number;
    walletAddress: string;
    recentPerformance: number;
    totalTrades: number;
  }>
> {
  const wallets = await db
    .select()
    .from(walletLeaderboard)
    .where(eq(walletLeaderboard.isInsufficientHistory, false))
    .orderBy(desc(walletLeaderboard.recentPerformance))
    .limit(limit);

  return wallets.map((w, idx) => ({
    rank: idx + 1,
    percentile: 100 - (idx / limit) * 100,
    walletAddress: w.walletAddress,
    recentPerformance: w.recentPerformance,
    totalTrades: w.totalTrades,
  }));
}

/**
 * Get wallets with red flags (negative PnL, low win rate, etc.)
 */
export async function getWalletsWithRedFlags(limit: number = 20): Promise<
  Array<{
    walletAddress: string;
    walletLabel: string | null;
    unifiedScore: number;
    flags: string[];
  }>
> {
  const wallets = await db
    .select()
    .from(walletLeaderboard)
    .limit(limit);

  return wallets
    .map(w => {
      const flags: string[] = [];
      if (w.hasNegativePnl) flags.push("negative_pnl");
      if (w.isLowWinRate) flags.push("low_win_rate");
      if (w.isInsufficientHistory) flags.push("insufficient_history");
      return { walletAddress: w.walletAddress, walletLabel: w.walletLabel, unifiedScore: w.unifiedScore, flags };
    })
    .filter(w => w.flags.length > 0)
    .sort((a, b) => a.flags.length - b.flags.length);
}
