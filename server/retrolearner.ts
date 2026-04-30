import { db } from "./db";
import { eq, and, gte, lte, desc, isNull, lt } from "drizzle-orm";
import {
  retrolearnerWalletAnalysis,
  jupiterLatencyStats,
  priceHistoryCache,
  paperPositions,
  rawTokenTrades,
  type InsertTokenOutcome,
} from "@shared/schema";
import axios from "axios";
import {
  discoverWalletsFromMissedTokens,
  assessWalletPnL,
  rankHoldersByMultipleCriteria,
  type WalletPnLMetrics
} from "./wallet-discovery";
import { predictTokenSuccess } from "./token-success-ann";

// =====================
// CONFIGURATION
// =====================

const RETROLEARNER_CONFIG = {
  pollIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  minEarlyBuyerWinRate: 0.60,
  minMedianMultiplier: 2.0,
  minProfitableWallets: 5,
  hoursBeforePlayedOut: 4,
  volumeDryThresholdPercent: 0.5,
  priceStabilityThresholdPercent: 2,
};

let lastRetrolearnerRun = 0;
let retrolearnerRunning = false;

// =====================
// LATENCY TRACKING
// =====================

async function sampleJupiterLatency(): Promise<void> {
  try {
    const startTime = Date.now();
    const response = await axios.post(
      "https://quote-api.jup.ag/v6/quote",
      {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5Au9sa7F1HQKFE9ZvDiqTKhYUfqZeQ2o2fJ8Q",
        amount: 1_000_000_000,
        slippageBps: 300,
      },
      { timeout: 10000 }
    );
    const latency = Date.now() - startTime;

    await db.insert(jupiterLatencyStats).values({
      method: "quote",
      latencyMs: latency,
      success: true,
      timestamp: Math.floor(Date.now() / 1000),
    });

    console.log(`[Retrolearner] Jupiter quote latency: ${latency}ms`);
  } catch (error) {
    console.error("[Retrolearner] Jupiter latency sampling failed:", error instanceof Error ? error.message : error);
  }
}

// =====================
// WALLET DISCOVERY
// =====================

async function summarizeRawTrades(cutoffTimestamp: number): Promise<{
  tradesSummarized: number;
  tokensProcessed: number;
  rawTradesDeleted: number;
}> {
  try {
    const trades = await db
      .select()
      .from(rawTokenTrades)
      .where(lt(rawTokenTrades.timestamp, cutoffTimestamp));

    if (trades.length === 0) {
      return { tradesSummarized: 0, tokensProcessed: 0, rawTradesDeleted: 0 };
    }

    // Group by token
    const tokenGroups = new Map<string, typeof trades>();
    for (const trade of trades) {
      const key = trade.tokenMint;
      if (!tokenGroups.has(key)) {
        tokenGroups.set(key, []);
      }
      tokenGroups.get(key)!.push(trade);
    }

    // Create OHLCV candles for each token
    let totalSummarized = 0;
    for (const [tokenMint, tokenTrades] of tokenGroups) {
      if (tokenTrades.length > 0) {
        const sorted = tokenTrades.sort((a, b) => a.timestamp - b.timestamp);
        const open = sorted[0].price;
        const close = sorted[sorted.length - 1].price;
        const high = Math.max(...sorted.map(t => t.price));
        const low = Math.min(...sorted.map(t => t.price));
        const volume = sorted.reduce((sum, t) => sum + t.amountSol, 0);

        await db.insert(priceHistoryCache).values({
          tokenMint,
          timestamp: Math.floor(cutoffTimestamp),
          timeframe: "1h",
          open,
          high,
          low,
          close,
          volume,
        });

        totalSummarized += tokenTrades.length;
      }
    }

    // Delete old raw trades
    await db.delete(rawTokenTrades).where(lt(rawTokenTrades.timestamp, cutoffTimestamp));

    return {
      tradesSummarized: totalSummarized,
      tokensProcessed: tokenGroups.size,
      rawTradesDeleted: trades.length,
    };
  } catch (error) {
    console.error("[Retrolearner] Error summarizing trades:", error);
    return { tradesSummarized: 0, tokensProcessed: 0, rawTradesDeleted: 0 };
  }
}

async function optimizeTrajectoryThresholds(): Promise<void> {
  try {
    const recentPositions = await db
      .select()
      .from(paperPositions)
      .where(gte(paperPositions.createdAt, Math.floor(Date.now() / 1000) - 7 * 86400))
      .limit(100);

    if (recentPositions.length === 0) {
      return;
    }

    const successes = recentPositions.filter(p => p.exitReason === "take_profit").length;
    const failures = recentPositions.filter(p => p.exitReason === "stop_loss").length;

    if (successes + failures > 0) {
      const successRate = successes / (successes + failures);
      console.log(`[Retrolearner] Paper trading success rate: ${(successRate * 100).toFixed(1)}% (${successes}/${successes + failures})`);
    }
  } catch (error) {
    console.error("[Retrolearner] Error optimizing thresholds:", error);
  }
}

// =====================
// MAIN CYCLE
// =====================

async function performRetrolearningCycle(): Promise<void> {
  const now = Date.now();

  if (retrolearnerRunning) {
    console.log("[Retrolearner] Cycle already running, skipping");
    return;
  }

  if (now - lastRetrolearnerRun < RETROLEARNER_CONFIG.pollIntervalMs / 2) {
    return;
  }

  retrolearnerRunning = true;
  lastRetrolearnerRun = now;

  try {
    console.log("[Retrolearner] Starting wallet discovery cycle...");

    // Step 1: Summarize raw trades (storage cleanup)
    const sixHoursAgoSeconds = Math.floor((now - 6 * 60 * 60 * 1000) / 1000);
    const tradeStats = await summarizeRawTrades(sixHoursAgoSeconds);
    if (tradeStats.tradesSummarized > 0) {
      console.log(
        `[Retrolearner] Summarized ${tradeStats.tradesSummarized} trades, ` +
        `deleted ${tradeStats.rawTradesDeleted} old entries`
      );
    }

    // Step 2: Sample Jupiter latency
    await sampleJupiterLatency();

    // Step 3: Discover wallets from tokens they profited on
    console.log("[Retrolearner] Discovering wallets from missed tokens...");
    const missedTokens = await discoverWalletsFromMissedTokens(24, 5);

    const walletMetrics = new Map<string, WalletPnLMetrics>();
    for (const [_, holders] of missedTokens.entries()) {
      for (const holder of holders) {
        if (!walletMetrics.has(holder.wallet)) {
          const pnlMetrics = await assessWalletPnL(holder.wallet, 7);
          walletMetrics.set(holder.wallet, pnlMetrics);
        }
      }
    }

    // Step 4: Store/update wallet analysis
    console.log(`[Retrolearner] Analyzing ${walletMetrics.size} wallets...`);
    let walletUpdateCount = 0;
    const nowSeconds = Math.floor(Date.now() / 1000);

    for (const [walletAddress, metrics] of walletMetrics.entries()) {
      const existing = await db.query.retrolearnerWalletAnalysis.findFirst({
        where: eq(retrolearnerWalletAnalysis.walletAddress, walletAddress),
      });

      // Skip if analyzed within last 12 hours
      if (existing && existing.lastAnalyzedAt && nowSeconds - existing.lastAnalyzedAt < 12 * 3600) {
        continue;
      }

      // Get discovery confidence from ANN
      let discoveryConfidence = 0.5;
      const tokensForWallet = Array.from(missedTokens.entries())
        .filter(([_, holders]) => holders.some(h => h.wallet === walletAddress))
        .map(([mint]) => mint);

      if (tokensForWallet.length > 0) {
        const annScores = await Promise.all(
          tokensForWallet.map(mint => predictTokenSuccess(mint, nowSeconds - 3600))
        );
        discoveryConfidence = annScores.reduce((a, b) => a + b, 0) / annScores.length;
      }

      if (existing) {
        await db.update(retrolearnerWalletAnalysis)
          .set({
            lastAnalyzedAt: nowSeconds,
            totalPnl7d: metrics.totalPnl7d,
            winRate7d: metrics.winRate7d,
            avgHoldMinutes: metrics.avgHoldMinutes,
            sharpeRatio: metrics.sharpeRatio,
            discoveredFromTokens: tokensForWallet,
            discoveryConfidence,
            updatedAt: nowSeconds,
          })
          .where(eq(retrolearnerWalletAnalysis.walletAddress, walletAddress));
      } else {
        await db.insert(retrolearnerWalletAnalysis)
          .values({
            walletAddress,
            lastAnalyzedAt: nowSeconds,
            totalPnl7d: metrics.totalPnl7d,
            winRate7d: metrics.winRate7d,
            avgHoldMinutes: metrics.avgHoldMinutes,
            sharpeRatio: metrics.sharpeRatio,
            discoveredFromTokens: tokensForWallet,
            discoveryConfidence,
            isActive: true,
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
          });
      }
      walletUpdateCount++;
    }

    // Step 5: Optimize trajectory thresholds
    await optimizeTrajectoryThresholds();

    console.log(
      `[Retrolearner] ✓ Cycle complete. Analyzed ${walletUpdateCount} wallets, ` +
      `discovered ${walletMetrics.size} total`
    );
  } catch (error) {
    console.error("[Retrolearner] Error:", error);
  } finally {
    retrolearnerRunning = false;
  }
}

export async function startRetrolearner(): Promise<void> {
  console.log("[Retrolearner] Starting wallet discovery job (every 6 hours)");

  setTimeout(async () => {
    try {
      await performRetrolearningCycle();
    } catch (error) {
      console.error("[Retrolearner] Initial cycle failed:", error);
    }
  }, 10_000);

  setInterval(async () => {
    try {
      await performRetrolearningCycle();
    } catch (error) {
      console.error("[Retrolearner] Cycle failed:", error);
    }
  }, RETROLEARNER_CONFIG.pollIntervalMs);
}
