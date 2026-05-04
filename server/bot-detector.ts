import { db } from "./db";
import { eq, and, gte, desc } from "drizzle-orm";
import { swaps, botFlaggedWallets } from "@shared/schema";

const BOT_CONFIG = {
  timingRegularityWeight: 0.25,
  replicationWeight: 0.25,
  profitabilityParadoxWeight: 0.20,
  pumpDumpWeight: 0.15,
  replenishmentWeight: 0.15,

  botFlagThreshold: 0.70,
  hardFlagThreshold: 0.85,
  unflagThreshold: 0.50,

  evaluationWindowDays: 7,
  timingStddevThresholds: { high: 10, medium: 60, low: 300 },
  replicationCorrelationThreshold: 0.85,
  minTradesForProfitabilityCheck: 50,
  winRateThresholdForZeroProfit: 0.05,
  roiThresholdForZeroProfit: -0.01,
  minVolumeForWastefulTrading: 100,
  pumpDumpEntryThreshold: 0.80,
  pumpDumpExitThreshold: 0.70,
};

interface WalletBotScores {
  walletAddress: string;
  timingRegularity: number;
  replicationScore: number;
  profitabilityParadox: number;
  pumpDumpScore: number;
  replenishmentAnomaly: number;
  compositeScore: number;
  recommendation: "flag" | "monitor" | "clean";
}

/**
 * Signal 1: Mechanical Timing Pattern
 * Real traders have irregular trade intervals; bots trade at fixed intervals
 */
export async function calculateTimingRegularity(
  walletAddress: string,
  lookbackDays: number = 7
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  const trades = await db
    .select({ timestamp: swaps.timestamp })
    .from(swaps)
    .where(and(eq(swaps.source, walletAddress), gte(swaps.timestamp, cutoff)))
    .orderBy(desc(swaps.timestamp));

  if (trades.length < 5) return 0; // Not enough data

  const intervals: number[] = [];
  for (let i = 0; i < trades.length - 1; i++) {
    intervals.push(trades[i].timestamp - trades[i + 1].timestamp);
  }

  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance =
    intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    intervals.length;
  const stddev = Math.sqrt(variance);

  // Score based on stddev thresholds
  if (stddev < BOT_CONFIG.timingStddevThresholds.high) return 1.0;
  if (stddev < BOT_CONFIG.timingStddevThresholds.medium) return 0.7;
  if (stddev < BOT_CONFIG.timingStddevThresholds.low) return 0.4;
  return 0.0;
}

/**
 * Signal 2: Identical Trade Replication
 * Legitimate wallets have independent sizes; bot rings copy exact amounts
 */
export async function calculateReplicationScore(
  walletAddresses: string[],
  lookbackDays: number = 7
): Promise<number> {
  if (walletAddresses.length < 2) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // Get recent trades for each wallet
  const walletTrades = await Promise.all(
    walletAddresses.map((addr) =>
      db
        .select({ amount: swaps.fromAmount })
        .from(swaps)
        .where(and(eq(swaps.source, addr), gte(swaps.timestamp, cutoff)))
        .orderBy(desc(swaps.timestamp))
        .limit(10)
    )
  );

  // Calculate correlation of amounts between wallets
  const correlations: number[] = [];

  for (let i = 0; i < walletTrades.length; i++) {
    for (let j = i + 1; j < walletTrades.length; j++) {
      const amounts1 = walletTrades[i].map((t) => t.amount);
      const amounts2 = walletTrades[j].map((t) => t.amount);

      if (amounts1.length > 0 && amounts2.length > 0) {
        const correlation = calculateCorrelation(amounts1, amounts2);
        correlations.push(correlation);
      }
    }
  }

  if (correlations.length === 0) return 0;

  const avgCorrelation =
    correlations.reduce((a, b) => a + b, 0) / correlations.length;

  // Score: high correlation = high bot probability
  if (avgCorrelation > BOT_CONFIG.replicationCorrelationThreshold) return 1.0;
  if (avgCorrelation > 0.7) return 0.6;
  if (avgCorrelation > 0.5) return 0.3;
  return 0.0;
}

/**
 * Signal 3: Zero Profit with High Volume
 * Real traders stop losing strategies; bots continue mechanically
 */
export async function calculateProfitabilityParadox(
  walletAddress: string,
  lookbackDays: number = 7
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  const trades = await db
    .select({
      type: swaps.type,
      amount: swaps.toAmount,
      fromAmount: swaps.fromAmount,
    })
    .from(swaps)
    .where(and(eq(swaps.source, walletAddress), gte(swaps.timestamp, cutoff)));

  if (trades.length < BOT_CONFIG.minTradesForProfitabilityCheck) return 0;

  // Count wins: trades where toAmount > fromAmount (profit)
  const wins = trades.filter(
    (t) => (t.amount || 0) > (t.fromAmount || 0)
  ).length;
  const winRate = wins / trades.length;

  // Track total volume
  const totalVolume = trades.reduce((sum, t) => sum + (t.fromAmount || 0), 0);

  // Paradox: >50 trades with <5% win rate OR >100 trades with <-1% ROI
  const hasLowWinRate =
    trades.length >= BOT_CONFIG.minTradesForProfitabilityCheck &&
    winRate < BOT_CONFIG.winRateThresholdForZeroProfit;

  const hasNegativeROI =
    trades.length > 100 &&
    (totalVolume -
      trades.reduce((sum, t) => sum + (t.amount || 0), 0)) /
      totalVolume <
      BOT_CONFIG.roiThresholdForZeroProfit;

  // Any single large losing trade = suspicious
  const hasLargeLosingTrades = trades.some(
    (t) =>
      (t.fromAmount || 0) > BOT_CONFIG.minVolumeForWastefulTrading &&
      (t.amount || 0) < (t.fromAmount || 0) * 0.9
  );

  if (hasLargeLosingTrades || hasLowWinRate || hasNegativeROI) return 1.0;
  if (hasLowWinRate && winRate < 0.1) return 0.7;
  return 0.0;
}

/**
 * Signal 4: Coordinated Pump-and-Dump
 * Bot rings enter/exit together in tight windows
 */
export async function calculatePumpDumpScore(
  walletAddresses: string[],
  lookbackDays: number = 7
): Promise<number> {
  if (walletAddresses.length < 2) return 0;

  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // Get trades grouped by token
  const tokenBuys = new Map<string, { wallet: string; timestamp: number }[]>();

  for (const wallet of walletAddresses) {
    const trades = await db
      .select({
        toToken: swaps.toToken,
        timestamp: swaps.timestamp,
      })
      .from(swaps)
      .where(
        and(
          eq(swaps.source, wallet),
          eq(swaps.type, "buy"),
          gte(swaps.timestamp, cutoff)
        )
      );

    trades.forEach((trade) => {
      if (!tokenBuys.has(trade.toToken)) {
        tokenBuys.set(trade.toToken, []);
      }
      tokenBuys.get(trade.toToken)!.push({
        wallet,
        timestamp: trade.timestamp,
      });
    });
  }

  // Check for coordinated entries: multiple wallets within 60 seconds
  let suspiciousTokens = 0;
  let totalTokens = 0;

  tokenBuys.forEach((buys) => {
    if (buys.length >= 2) {
      totalTokens++;
      const sortedByTime = buys.sort((a, b) => a.timestamp - b.timestamp);
      const timeWindow = sortedByTime[sortedByTime.length - 1].timestamp - sortedByTime[0].timestamp;

      if (timeWindow <= 60) {
        suspiciousTokens++;
      }
    }
  });

  if (totalTokens === 0) return 0;

  const coordinatedRatio = suspiciousTokens / totalTokens;

  if (coordinatedRatio > BOT_CONFIG.pumpDumpEntryThreshold) return 1.0;
  if (coordinatedRatio > 0.6) return 0.7;
  if (coordinatedRatio > 0.4) return 0.4;
  return 0.0;
}

/**
 * Signal 5: Constant Wallet Replenishment
 * Bot operators replenish wallets from same source
 */
export async function calculateReplenishmentAnomaly(
  walletAddress: string,
  lookbackDays: number = 7
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // This signal requires transaction analysis beyond swaps table
  // For now, estimate based on wallet activity patterns
  // Full implementation would need Helius enhanced API for all transaction types

  const trades = await db
    .select()
    .from(swaps)
    .where(and(eq(swaps.source, walletAddress), gte(swaps.timestamp, cutoff)));

  if (trades.length === 0) return 0;

  // Heuristic: if wallet has high trade frequency but low average amounts,
  // it might be getting constant replenishments
  const avgAmount = trades.reduce((sum, t) => sum + (t.fromAmount || 0), 0) / trades.length;
  const frequencyPerDay = trades.length / lookbackDays;

  // Suspicious: many small trades (high frequency, low amounts)
  if (frequencyPerDay > 10 && avgAmount < 1) {
    return 0.6; // Medium suspicion without full tx analysis
  }

  return 0.0;
}

/**
 * Calculate composite bot confidence score
 */
export async function calculateBotConfidence(
  walletAddress: string,
  clusterWallets?: string[]
): Promise<WalletBotScores> {
  const [timing, profitability, replenishment] = await Promise.all([
    calculateTimingRegularity(walletAddress),
    calculateProfitabilityParadox(walletAddress),
    calculateReplenishmentAnomaly(walletAddress),
  ]);

  // Replication and pump-dump require cluster context
  let replication = 0;
  let pumpDump = 0;

  if (clusterWallets && clusterWallets.length > 1) {
    [replication, pumpDump] = await Promise.all([
      calculateReplicationScore(clusterWallets),
      calculatePumpDumpScore(clusterWallets),
    ]);
  }

  const compositeScore =
    BOT_CONFIG.timingRegularityWeight * timing +
    BOT_CONFIG.replicationWeight * replication +
    BOT_CONFIG.profitabilityParadoxWeight * profitability +
    BOT_CONFIG.pumpDumpWeight * pumpDump +
    BOT_CONFIG.replenishmentWeight * replenishment;

  let recommendation: "flag" | "monitor" | "clean" = "clean";
  if (compositeScore > BOT_CONFIG.hardFlagThreshold) {
    recommendation = "flag";
  } else if (compositeScore > BOT_CONFIG.botFlagThreshold) {
    recommendation = "monitor";
  }

  return {
    walletAddress,
    timingRegularity: timing,
    replicationScore: replication,
    profitabilityParadox: profitability,
    pumpDumpScore: pumpDump,
    replenishmentAnomaly: replenishment,
    compositeScore,
    recommendation,
  };
}

/**
 * Flag a wallet as bot and skip monitoring
 */
export async function flagWalletAsBot(
  walletAddress: string,
  scores: WalletBotScores,
  reason: string = "automatic"
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await db.insert(botFlaggedWallets).values({
    walletAddress,
    botConfidence: scores.compositeScore,
    timingRegularity: scores.timingRegularity,
    replicationScore: scores.replicationScore,
    profitabilityParadox: scores.profitabilityParadox,
    pumpDumpScore: scores.pumpDumpScore,
    replenishmentAnomaly: scores.replenishmentAnomaly,
    flaggedAt: now,
    flaggedBy: reason,
    reflagEligibleAt: now + 7 * 86400, // Re-check in 7 days
    scoreHistory: JSON.stringify([
      { timestamp: now, score: scores.compositeScore },
    ]),
    createdAt: now,
  });

  console.log(
    `[BotDetector] Flagged ${walletAddress} as bot (confidence: ${(
      scores.compositeScore * 100
    ).toFixed(1)}%)`
  );
}

/**
 * Helper: Calculate Pearson correlation coefficient
 */
function calculateCorrelation(arr1: number[], arr2: number[]): number {
  const minLen = Math.min(arr1.length, arr2.length);
  if (minLen === 0) return 0;

  const mean1 = arr1.slice(0, minLen).reduce((a, b) => a + b) / minLen;
  const mean2 = arr2.slice(0, minLen).reduce((a, b) => a + b) / minLen;

  let numerator = 0;
  let denominator1 = 0;
  let denominator2 = 0;

  for (let i = 0; i < minLen; i++) {
    const diff1 = arr1[i] - mean1;
    const diff2 = arr2[i] - mean2;
    numerator += diff1 * diff2;
    denominator1 += diff1 * diff1;
    denominator2 += diff2 * diff2;
  }

  if (denominator1 === 0 || denominator2 === 0) return 0;

  return numerator / Math.sqrt(denominator1 * denominator2);
}
