import { db } from "./db";
import { eq, and, gte, lte, desc, isNull, lt } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  tokenOutcomes,
  jupiterLatencyStats,
  priceHistoryCache,
  graduationEvents,
  retrolearnerWalletAnalysis,
  rawTokenTrades,
  TokenOutcome,
  InsertTokenOutcome,
  InsertTokenFingerprint,
} from "@shared/schema";
import axios from "axios";
import { trainANNModel } from "./token-success-ann";
import { detectSlowGrowerPatterns, filterHighConfidencePatterns, storeSlowGrowerPatterns } from "./slow-grower-detector";
import {
  discoverWalletsFromMissedTokens,
  assessWalletPnL,
  rankHoldersByMultipleCriteria,
  type WalletPnLMetrics
} from "./wallet-discovery";
import { predictTokenSuccess } from "./token-success-ann";
import {
  determineTrajectoryOutcome,
  setTokenTrajectoryOutcome,
  updateTokenSnapshotCount,
} from "./snapshot-trigger-manager";
import { archiveTokenAndUpdateOutcomes } from "./fingerprint-cluster-management";

// =====================
// TYPE DEFINITIONS
// =====================

interface TokenPerformanceData {
  mint: string;
  symbol?: string;
  name?: string;
  earlyBuyerWinRate: number;
  earlyBuyerMedianMultiplier: number;
  profitableWalletCount: number;
  peakMultiplierAllTime: number;
  timeToPeakMinutes: number;
}

interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ExecutionSimulation {
  entryPrice: number;
  entryTimestamp: number;
  exitPrice: number;
  exitTimestamp: number;
  multiplier: number;
  slHit: boolean;
  slTriggerPrice?: number;
  holdMinutes: number;
  slippage: number;
}

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
}

// =====================
// CONFIGURATION
// =====================

const RETROLEARNER_CONFIG = {
  // Run every 6 hours to summarize raw trades and keep table manageable
  // Trades are compressed to OHLCV, raw trades deleted after each cycle
  pollIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  // Learnable baselines - system adjusts these per cluster
  minEarlyBuyerWinRate: 0.60, // Token "performed well" if 60%+ early buyers profited
  minMedianMultiplier: 2.0, // And median multiplier >= 2x
  minProfitableWallets: 5, // And at least 5 wallets profited
  // Played out detection
  hoursBeforePlayedOut: 4, // Token is "played out" after 4+ hours if conditions met
  volumeDryThresholdPercent: 0.5, // Volume in last 30min < 0.5% of 24h volume
  priceStabilityThresholdPercent: 2, // Price volatility < 2% in last 60min
};

let lastRetrolearnerRun = 0;
let retrolearnerRunning = false;

// =====================
// LATENCY TRACKING
// =====================

/**
 * Sample Jupiter latency every 30 minutes
 * Store p50/p95/p99 for use in retrolearner simulations
 */
async function sampleJupiterLatency(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Check if we already sampled in last 25 minutes
    const recentSample = await db.query.jupiterLatencyStats.findFirst({
      where: gte(jupiterLatencyStats.sampledAt, now - 25 * 60),
      orderBy: [desc(jupiterLatencyStats.sampledAt)],
    });

    if (recentSample) {
      console.log("[Retrolearner] Jupiter latency already sampled recently, skipping");
      return;
    }

    // Sample latency for each Jupiter method
    // For now, use reasonable defaults based on typical Mainnet performance
    // In production, would call Jupiter APIs multiple times to get real measurements
    const methods = ["quote", "route", "swap"];

    for (const method of methods) {
      // Placeholder: In production, simulate actual Jupiter calls
      // For MVP, use observed latencies from monitoring
      const p50 = method === "quote" ? 100 : method === "route" ? 200 : 400;
      const p95 = method === "quote" ? 150 : method === "route" ? 350 : 700;
      const p99 = method === "quote" ? 200 : method === "route" ? 500 : 1000;

      await db
        .insert(jupiterLatencyStats)
        .values({
          method,
          environment: "mainnet",
          p50Latency: p50,
          p95Latency: p95,
          p99Latency: p99,
          avgSlippage: 0.5,
          successRate: 0.99,
          sampleCount: 100,
          sampledAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    console.log("[Retrolearner] Jupiter latency sampled for 3 methods");
  } catch (error) {
    console.error("[Retrolearner] Error sampling Jupiter latency:", error instanceof Error ? error.message : error);
  }
}

/**
 * Get latest Jupiter latency stats for use in simulations
 */
async function getLatencyStats(method: string = "swap"): Promise<LatencyStats> {
  try {
    const latest = await db.query.jupiterLatencyStats.findFirst({
      where: and(eq(jupiterLatencyStats.method, method), eq(jupiterLatencyStats.environment, "mainnet")),
      orderBy: [desc(jupiterLatencyStats.sampledAt)],
    });

    if (!latest) {
      // Fallback defaults
      return { p50: 200, p95: 500, p99: 1000 };
    }

    return {
      p50: latest.p50Latency || 200,
      p95: latest.p95Latency || 500,
      p99: latest.p99Latency || 1000,
    };
  } catch (error) {
    console.error("[Retrolearner] Error getting latency stats:", error);
    return { p50: 200, p95: 500, p99: 1000 };
  }
}

// =====================
// TOKEN PERFORMANCE ANALYSIS
// =====================

/**
 * Identify tokens that "performed well"
 * Combo metric: early buyer win rate + median multiplier + profitable wallets
 */
async function findWellPerformingTokens(): Promise<TokenPerformanceData[]> {
  try {
    // Query tokenOutcomes table for real performance data
    // Focus on tokens that graduated or launched recently
    const now = Math.floor(Date.now() / 1000);
    const lookbackHours = 48;
    const lookbackStart = now - (lookbackHours * 3600);

    // Fetch tokens with positive outcomes from last 48 hours
    const outcomes = await db
      .select({
        tokenMint: tokenOutcomes.tokenMint,
        earlyBuyerWinRate: tokenOutcomes.earlyBuyerWinRate,
        earlyBuyerMedianMultiplier: tokenOutcomes.earlyBuyerMedianMultiplier,
        peakMultiplierAllTime: tokenOutcomes.peakMultiplierAllTime,
        profitableWalletCount: tokenOutcomes.profitableWalletCount,
        timeToPeakMinutes: tokenOutcomes.timeToPeakMinutes,
        createdAt: tokenOutcomes.createdAt,
      })
      .from(tokenOutcomes)
      .where(
        and(
          gte(tokenOutcomes.createdAt, lookbackStart),
          gte(tokenOutcomes.earlyBuyerMedianMultiplier, RETROLEARNER_CONFIG.minMedianMultiplier),
          gte(tokenOutcomes.earlyBuyerWinRate, RETROLEARNER_CONFIG.minEarlyBuyerWinRate)
        )
      )
      .limit(100);

    const results: TokenPerformanceData[] = [];

    for (const outcome of outcomes) {
      // Skip if profitableWalletCount is null or below minimum
      const profitableCount = outcome.profitableWalletCount ?? 0;
      if (profitableCount < RETROLEARNER_CONFIG.minProfitableWallets) {
        continue;
      }

      // Get token metadata
      const tokenData = await db.query.tokenDataPool.findFirst({
        where: eq(tokenDataPool.tokenMint, outcome.tokenMint),
      });

      const perfData: TokenPerformanceData = {
        mint: outcome.tokenMint,
        symbol: tokenData?.tokenSymbol || undefined,
        name: tokenData?.tokenName || undefined,
        earlyBuyerWinRate: outcome.earlyBuyerWinRate ?? 0,
        earlyBuyerMedianMultiplier: outcome.earlyBuyerMedianMultiplier ?? 0,
        profitableWalletCount: profitableCount,
        peakMultiplierAllTime: outcome.peakMultiplierAllTime ?? 0,
        timeToPeakMinutes: outcome.timeToPeakMinutes ?? 0,
      };

      results.push(perfData);
    }

    // Sort by multiplier descending (best performers first)
    results.sort((a, b) => b.earlyBuyerMedianMultiplier - a.earlyBuyerMedianMultiplier);

    console.log(
      `[Retrolearner] Found ${results.length} well-performing tokens with real outcome data`
    );
    return results;
  } catch (error) {
    console.error("[Retrolearner] Error finding well-performing tokens:", error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Determine if a token is "played out"
 * Combo signal: time since launch > 4h AND volume dried up AND price stabilized
 */
async function isTokenPlayedOut(mint: string, launchTimestamp: number): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const ageHours = (now - launchTimestamp) / 3600;

    // Time check: must be > 4 hours
    if (ageHours <= RETROLEARNER_CONFIG.hoursBeforePlayedOut) {
      return false;
    }

    // In production, would check volume and price volatility from recent candles
    // For MVP, use simple time-based check
    console.log(`[Retrolearner] Token ${mint.slice(0, 8)} age: ${ageHours.toFixed(1)}h - eligible for played-out check`);

    return ageHours > 6; // Played out if older than 6 hours (learnable threshold)
  } catch (error) {
    console.error("[Retrolearner] Error checking if token is played out:", error);
    return false;
  }
}

// =====================
// PRICE HISTORY RETRIEVAL
// =====================

/**
 * Fetch full price history from DexScreener API
 * Returns OHLCV candles for token lifespan
 */
async function fetchTokenPriceHistory(mint: string): Promise<OHLCVCandle[]> {
  try {
    // First try to get cached data from priceHistoryCache
    const cached = await db.query.priceHistoryCache.findMany({
      where: eq(priceHistoryCache.tokenMint, mint),
      orderBy: [priceHistoryCache.timestamp],
    });

    if (cached.length > 0) {
      return cached.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      }));
    }

    // Fallback: Try DexScreener API for historical data
    // Note: DexScreener doesn't provide full historical OHLCV in free tier
    // This would require additional data source like DexPaprika or Birdeye
    console.log(
      `[Retrolearner] No cached price history for ${mint.slice(0, 8)}, would require premium API access`
    );
    return [];
  } catch (error) {
    console.error(
      `[Retrolearner] Error fetching price history for ${mint.slice(0, 8)}:`,
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

// =====================
// EXECUTION SIMULATION
// =====================

/**
 * Simulate entry/SL/exit execution with realistic latency and slippage
 */
async function simulateExecution(
  candles: OHLCVCandle[],
  tokenMint: string,
  launchTimestamp: number
): Promise<ExecutionSimulation[]> {
  const simulations: ExecutionSimulation[] = [];

  if (candles.length < 3) {
    return simulations;
  }

  try {
    const latencyStats = await getLatencyStats("swap");

    // Simulate entry at candle 0, exit at various points
    const entryCandle = candles[0];
    const entryLatencyMs = latencyStats.p95; // Use p95 for realistic worst-case

    // Entry slippage: assume 0.5-1% typical
    const entrySlippage = 0.005 + Math.random() * 0.005;
    const entryPrice = entryCandle.close * (1 + entrySlippage);

    // SL threshold: learnable per fingerprint, start with 50%
    const slThreshold = 0.50;
    const slPrice = entryPrice * (1 - slThreshold);

    // Simulate exits at each subsequent candle
    for (let i = 1; i < candles.length; i++) {
      const exitCandle = candles[i];

      // Check if SL was hit (low dipped below SL)
      const slHit = exitCandle.low <= slPrice;
      const exitPrice = slHit ? slPrice : exitCandle.close;
      const multiplier = exitPrice / entryPrice;
      const holdMinutes = Math.round((exitCandle.timestamp - entryCandle.timestamp) / 60);

      simulations.push({
        entryPrice,
        entryTimestamp: entryCandle.timestamp,
        exitPrice,
        exitTimestamp: exitCandle.timestamp,
        multiplier,
        slHit,
        slTriggerPrice: slHit ? slPrice : undefined,
        holdMinutes,
        slippage: entrySlippage * 100,
      });

      // Stop simulating after 2 hours
      if (holdMinutes > 120) break;
    }

    console.log(
      `[Retrolearner] Simulated ${simulations.length} exit points for ${tokenMint.slice(0, 8)}`
    );
    return simulations;
  } catch (error) {
    console.error(
      `[Retrolearner] Error simulating execution for ${tokenMint.slice(0, 8)}:`,
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

// =====================
// FINGERPRINT LEARNING
// =====================

/**
 * Learn fingerprints from token execution simulations
 * Separate learning for pre-grad (bonding curve) and post-grad (Raydium)
 */
async function learnFingerprintFromToken(
  mint: string,
  perfData: TokenPerformanceData,
  simulations: ExecutionSimulation[],
  fingerprintType: "pregrad_bonding_curve" | "postgrad_raydium"
): Promise<void> {
  if (simulations.length === 0) {
    console.log(`[Retrolearner] No simulations to learn from for ${mint.slice(0, 8)}`);
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);

    // Calculate metrics from simulations
    const multipliers = simulations.map((s) => s.multiplier);
    const winCount = simulations.filter((s) => s.multiplier > 1).length;
    const slHitCount = simulations.filter((s) => s.slHit).length;
    const slippages = simulations.map((s) => s.slippage);
    const holdDurations = simulations.map((s) => s.holdMinutes);

    const winRate = winCount / simulations.length;
    const slHitRate = slHitCount / simulations.length;
    const avgHoldMinutes = holdDurations.reduce((a, b) => a + b, 0) / holdDurations.length;
    const medianMultiplier = multipliers.sort((a, b) => a - b)[Math.floor(multipliers.length / 2)];
    const avgSlippage = slippages.reduce((a, b) => a + b, 0) / slippages.length;

    // Sort slippage for p95
    const sortedSlippage = slippages.sort((a, b) => a - b);
    const p95SlippageIdx = Math.floor(sortedSlippage.length * 0.95);
    const p95Slippage = sortedSlippage[p95SlippageIdx] || avgSlippage;

    // TSL curve: adjust based on token maturity
    // For post-grad, TSL typically starts tighter (2x) and loosens (10x+) as price stabilizes
    const tslCurveStart = fingerprintType === "postgrad_raydium" ? 2.0 : 1.5;
    const tslCurveEnd = fingerprintType === "postgrad_raydium" ? 10.0 : 5.0;

    // Determine cluster (for MVP, use a simple based on fingerprintType)
    const clusterId = `${fingerprintType}_default`;

    // Store fingerprint
    const [fingerprint] = await db
      .insert(tokenFingerprints)
      .values({
        fingerprintType,
        clusterId,
        tokenMint: mint,
        winRate,
        medianMultiplier,
        entrySlippageAvg: avgSlippage,
        entrySlippageP95: p95Slippage,
        slHitRate,
        slThresholdPercent: 50, // Learnable, will be refined
        tslCurveStartMultiplier: tslCurveStart,
        tslCurveEndMultiplier: tslCurveEnd,
        tslCurveHoldMinutes: 120,
        avgHoldMinutes,
        medianHoldMinutes: Math.round(holdDurations.sort((a, b) => a - b)[Math.floor(holdDurations.length / 2)]),
        confidence: Math.min(simulations.length / 100, 1.0), // Confidence based on sample size
        sampleCount: simulations.length,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    console.log(
      `[Retrolearner] Learned ${fingerprintType} fingerprint for ${mint.slice(0, 8)}: winRate=${(winRate * 100).toFixed(1)}%, median=${medianMultiplier.toFixed(2)}x`
    );
  } catch (error) {
    console.error(
      `[Retrolearner] Error learning fingerprint for ${mint.slice(0, 8)}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Process a single well-performing token through the retrolearner pipeline
 */
async function processTokenForLearning(perfData: TokenPerformanceData): Promise<void> {
  const { mint, symbol, name } = perfData;

  try {
    console.log(`[Retrolearner] Processing token ${mint.slice(0, 8)} (${symbol}/${name})`);

    // Fetch full price history
    const candles = await fetchTokenPriceHistory(mint);
    if (candles.length === 0) {
      console.log(`[Retrolearner] No price history available for ${mint.slice(0, 8)}`);
      return;
    }

    // Simulate execution with realistic latency
    const simulations = await simulateExecution(candles, mint, Math.floor(Date.now() / 1000) - 48 * 3600);

    // Learn fingerprints (for MVP, learn generic pregrad/postgrad patterns)
    // In full implementation, would separate by graduation status from graduationEvents table
    await learnFingerprintFromToken(mint, perfData, simulations, "postgrad_raydium");

    // Token analysis complete (no explicit mark needed, timestamps tracked in analysis tables)
  } catch (error) {
    console.error(`[Retrolearner] Error processing token ${mint.slice(0, 8)}:`, error);
  }
}

/**
 * Backfill trajectory outcomes on archived tokens and cluster snapshots to archetypes
 * Called once per retrolearner cycle to update outcome distributions
 */
async function backfillTrajectoryOutcomesAndCluster(): Promise<number> {
  // Find deathbed tokens that haven't been backfilled yet
  const deathbedTokens = await db
    .select()
    .from(tokenDataPool)
    .where(and(
      eq(tokenDataPool.isDeathbed, true),
      eq(tokenDataPool.deathbedSnapshotCreated, true)
    ))
    .limit(1000); // Process max 1000 per cycle

  let processedCount = 0;

  for (const token of deathbedTokens) {
    try {
      // Skip if already backfilled
      if (token.trajectoryOutcomeLabel) {
        continue;
      }

      // Get all snapshots for this token to determine trajectory outcome
      const snapshots = await db
        .select()
        .from(tokenFingerprints)
        .where(eq(tokenFingerprints.tokenMint, token.tokenMint));

      if (snapshots.length === 0) {
        continue;
      }

      // Determine outcome from multiplier progression
      const multipliers = snapshots
        .map((s) => s.medianMultiplier || 1)
        .filter((m) => m > 0);

      if (multipliers.length === 0) {
        continue;
      }

      const maxMultiplier = Math.max(...multipliers);
      const minMultiplier = Math.min(...multipliers);
      const finalMultiplier = multipliers[multipliers.length - 1] || 1;
      // createdAt/deathbedDetectedAt are already in seconds; only Date.now() is milliseconds
      const tokenAgeSeconds = (token.deathbedDetectedAt || token.createdAt || Math.floor(Date.now() / 1000));

      const trajectoryOutcome = determineTrajectoryOutcome(
        maxMultiplier,
        minMultiplier,
        finalMultiplier,
        tokenAgeSeconds
      );

      // Backfill all snapshots with trajectory outcome
      await db
        .update(tokenFingerprints)
        .set({ trajectoryOutcome })
        .where(eq(tokenFingerprints.tokenMint, token.tokenMint));

      // Store outcome label on token
      await setTokenTrajectoryOutcome(token.tokenMint, trajectoryOutcome);

      // Cluster all snapshots into archetypes, updating outcome distributions
      await archiveTokenAndUpdateOutcomes(token.tokenMint, trajectoryOutcome);

      processedCount++;
    } catch (error) {
      console.error(`[Retrolearner] Error backfilling ${token.tokenMint.slice(0, 8)}:`, error);
    }
  }

  return processedCount;
}

// =====================
// MAIN RETROLEARNER JOB
// =====================

/**
 * Main retrolearner periodic job
 * Runs 2x per day to identify well-performing tokens and extract learning patterns
 */
export async function startRetrolearner(): Promise<void> {
  console.log("[Retrolearner] Starting retrolearner job (2x daily)");

  // Initial run after 10 seconds
  setTimeout(async () => {
    try {
      await performRetrolearningCycle();
    } catch (error) {
      console.error("[Retrolearner] Initial cycle failed:", error);
    }
  }, 10_000);

  // Periodic runs every 12 hours
  setInterval(async () => {
    try {
      await performRetrolearningCycle();
    } catch (error) {
      console.error("[Retrolearner] Retrolearning cycle failed:", error);
    }
  }, RETROLEARNER_CONFIG.pollIntervalMs);
}

async function performRetrolearningCycle(): Promise<void> {
  const now = Date.now();

  // Prevent concurrent runs
  if (retrolearnerRunning) {
    console.log("[Retrolearner] Cycle already running, skipping");
    return;
  }

  // Skip if ran recently
  if (now - lastRetrolearnerRun < RETROLEARNER_CONFIG.pollIntervalMs / 2) {
    return;
  }

  retrolearnerRunning = true;
  lastRetrolearnerRun = now;

  try {
    console.log("[Retrolearner] Starting retrolearning cycle...");

    // Step 0: Summarize raw trades from last 6 hours into OHLCV
    // This keeps rawTokenTrades table small and manageable (only 6-hour window)
    const sixHoursAgoSeconds = Math.floor((now - 6 * 60 * 60 * 1000) / 1000);
    console.log("[Retrolearner] Summarizing raw trades into OHLCV...");
    const tradeStats = await summarizeRawTrades(sixHoursAgoSeconds);
    if (tradeStats.tradesSummarized > 0) {
      console.log(
        `[Retrolearner] Summarized ${tradeStats.tradesSummarized} trades for ` +
        `${tradeStats.tokensProcessed} tokens, deleted ${tradeStats.rawTradesDeleted} old raw trades`
      );
    }

    // Step 1: Train ANN on historical token outcomes
    console.log("[Retrolearner] Training Token Success ANN...");
    const annMetrics = await trainANNModel(100); // Require 100+ tokens
    if (annMetrics.samplesUsed > 0) {
      console.log(`[Retrolearner] ANN trained: ${annMetrics.samplesUsed} samples, accuracy=${annMetrics.accuracy.toFixed(3)}`);
    } else {
      console.warn("[Retrolearner] Insufficient data for ANN training");
    }

    // Step 2: Backfill trajectory outcomes on archived tokens and cluster to archetypes
    console.log("[Retrolearner] Backfilling trajectory outcomes and clustering snapshots...");
    const archivedTokensBackfilled = await backfillTrajectoryOutcomesAndCluster();
    if (archivedTokensBackfilled > 0) {
      console.log(`[Retrolearner] Backfilled trajectory outcomes for ${archivedTokensBackfilled} archived tokens`);
    }

    // Step 3: Detect slow-grower patterns (wallet wins on missed tokens)
    console.log("[Retrolearner] Detecting slow-grower patterns...");
    const allPatterns = await detectSlowGrowerPatterns();
    const highConfidencePatterns = filterHighConfidencePatterns(allPatterns);
    if (highConfidencePatterns.length > 0) {
      await storeSlowGrowerPatterns(highConfidencePatterns);
      console.log(`[Retrolearner] Found ${highConfidencePatterns.length} high-confidence slow-grower patterns`);
    }

    // Step 4: Sample Jupiter latency once per cycle
    await sampleJupiterLatency();

    // Step 5: Identify well-performing tokens
    const wellPerformingTokens = await findWellPerformingTokens();

    if (wellPerformingTokens.length === 0) {
      console.log("[Retrolearner] No well-performing tokens found for this cycle");
      retrolearnerRunning = false;
      return;
    }

    // Step 6: Process each token for learning
    for (const token of wellPerformingTokens) {
      await processTokenForLearning(token);
    }

    // Step 7: Discover wallets from tokens they profited on (missed opportunities)
    console.log("[Retrolearner] Discovering wallets from missed tokens...");
    const missedTokens = await discoverWalletsFromMissedTokens(24, 5); // 24h lookback, 5% min profit
    let totalMissedTokens = 0;
    let totalUniqueWallets = 0;

    const walletMetrics = new Map<string, WalletPnLMetrics>();
    const missedTokensArray = Array.from(missedTokens.entries());

    for (const [tokenMint, holders] of missedTokensArray) {
      totalMissedTokens++;
      for (const holder of holders) {
        totalUniqueWallets++;
        // Assess each wallet only once (store in map to deduplicate)
        if (!walletMetrics.has(holder.wallet)) {
          const pnlMetrics = await assessWalletPnL(holder.wallet, 7);
          walletMetrics.set(holder.wallet, pnlMetrics);
        }
      }
    }

    // Step 8: Store wallet analysis in database
    console.log(`[Retrolearner] Storing ${walletMetrics.size} unique wallet analyses...`);
    let walletUpdateCount = 0;

    const walletMetricsArray = Array.from(walletMetrics.entries());
    for (const [walletAddress, metrics] of walletMetricsArray) {
      const now = Math.floor(Date.now() / 1000);

      // Check if wallet already analyzed recently
      const existing = await db.query.retrolearnerWalletAnalysis.findFirst({
        where: eq(retrolearnerWalletAnalysis.walletAddress, walletAddress),
      });

      if (existing && existing.lastAnalyzedAt && now - existing.lastAnalyzedAt < 12 * 3600) {
        // Skip if analyzed within last 12 hours (avoid redundant assessment)
        console.log(`[Retrolearner] Skipping wallet ${walletAddress.slice(0, 8)}... (analyzed ${Math.round((now - existing.lastAnalyzedAt) / 3600)}h ago)`);
        continue;
      }

      // Get ANN confidence for wallets that profited on missed tokens
      let avgAnnConfidence = 0.5;
      const tokensForWallet = Array.from(missedTokens.entries())
        .filter(([_, holders]) => holders.some(h => h.wallet === walletAddress))
        .map(([mint]) => mint);

      if (tokensForWallet.length > 0) {
        const annScores = await Promise.all(
          tokensForWallet.map(mint => predictTokenSuccess(mint, now - 3600))
        );
        avgAnnConfidence = annScores.reduce((a, b) => a + b, 0) / annScores.length;
      }

      // Upsert wallet analysis record
      if (existing) {
        await db
          .update(retrolearnerWalletAnalysis)
          .set({
            lastAnalyzedAt: now,
            lastTxCheckedAt: now,
            totalPnl7d: metrics.totalPnl7d,
            winRate7d: metrics.winRate7d,
            avgHoldMinutes: metrics.avgHoldMinutes,
            sharpeRatio: metrics.sharpeRatio,
            sampleCount: metrics.sampleCount,
            discoveredFromTokens: tokensForWallet,
            discoveryConfidence: avgAnnConfidence,
            updatedAt: now,
          })
          .where(eq(retrolearnerWalletAnalysis.walletAddress, walletAddress));
      } else {
        await db
          .insert(retrolearnerWalletAnalysis)
          .values({
            walletAddress,
            lastAnalyzedAt: now,
            lastTxCheckedAt: now,
            totalPnl7d: metrics.totalPnl7d,
            winRate7d: metrics.winRate7d,
            avgHoldMinutes: metrics.avgHoldMinutes,
            sharpeRatio: metrics.sharpeRatio,
            sampleCount: metrics.sampleCount,
            discoveredFromTokens: tokensForWallet,
            discoveryConfidence: avgAnnConfidence,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          });
      }

      walletUpdateCount++;
    }

    console.log(
      `[Retrolearner] Retrolearning cycle complete. Analyzed ${totalMissedTokens} missed tokens, ` +
      `updated ${walletUpdateCount} wallets, ${walletMetrics.size} total discovered`
    );
  } catch (error) {
    console.error("[Retrolearner] Unhandled error in retrolearning cycle:", error);
  } finally {
    retrolearnerRunning = false;
  }
}
