/**
 * Paper Trading Simulation & Validation Layer
 *
 * Before opening a paper position:
 * 1. Simulate trade on Jupiter API (verify liquidity, slippage, price impact)
 * 2. Calculate dynamic exit strategies based on retrolearner outcomes
 * 3. Validate strategy theory in real-time with latency
 * 4. Track validation success rate for continuous learning
 *
 * Exit strategies are influenced by:
 * - Retrolearner peak multiplier projections
 * - Early buyer win rates on similar tokens
 * - Time-to-peak from historical patterns
 * - Bonding curve velocity indicators
 */

import { db } from "./db";
import { tokenOutcomes, paperPositions, strategyValidations } from "@shared/schema";
import { eq, gte, lte, desc, and } from "drizzle-orm";
import { getQuote } from "./jupiter";
import { addRecentEvent } from "./log-buckets";

// =====================
// TYPES
// =====================

export interface TradeSimulation {
  success: boolean;
  tokenMint: string;
  amountInLamports: number;
  expectedTokens: number;
  priceImpactPercent: number;
  slippageLamports: number;
  executableAtSlippage: boolean;
  error?: string;
}

export interface DynamicExitStrategy {
  takeProfitMultiplier: number;
  stopLossPercent: number;
  trailingStopPercent?: number;
  estimatedTimeToPeakMinutes?: number;
  confidenceScore: number;
  basedOnPatterns: string[];
  rationale: string;
}

export interface StrategyValidation {
  positionId: number;
  simulationPassed: boolean;
  strategyTheory: string;
  expectedOutcome: number; // Predicted multiplier from retrolearner
  actualOutcome?: number;
  actualExitReason?: string;
  validationStatus: "pending" | "confirmed" | "refuted";
  latencyMs: number;
  createdAt: number;
}

// =====================
// JUPITER SIMULATION
// =====================

/**
 * Simulate a trade on Jupiter before opening position
 * Validates: liquidity, price impact, slippage
 */
export async function simulateTradeOnJupiter(
  tokenMint: string,
  solAmountLamports: number,
  maxSlippagePercent: number = 5
): Promise<TradeSimulation> {
  const startTime = Date.now();

  try {
    // Simulate: SOL → Token
    const quote = await getQuote("So11111111111111111111111111111111111111112", tokenMint, solAmountLamports, {
      mode: "fixed",
      maxBps: Math.round(maxSlippagePercent * 100), // Convert % to basis points
      minBps: 0,
    });

    if (!quote || !quote.outAmount) {
      return {
        success: false,
        tokenMint,
        amountInLamports: solAmountLamports,
        expectedTokens: 0,
        priceImpactPercent: 0,
        slippageLamports: 0,
        executableAtSlippage: false,
        error: "No quote available - token may have insufficient liquidity",
      };
    }

    // Calculate metrics
    const expectedTokens = parseInt(quote.outAmount);
    const priceImpactPercent = parseFloat(quote.priceImpactPct || "0");
    const slippageLamports = solAmountLamports - parseInt(quote.inAmount);
    const isExecutable = priceImpactPercent <= maxSlippagePercent;

    addRecentEvent({
      timestamp: Date.now(),
      category: "api",
      level: "debug",
      message: `Jupiter simulation: ${(solAmountLamports / 1e9).toFixed(2)} SOL → ${expectedTokens.toLocaleString()} tokens`,
      tokenMint,
      metrics: {
        apiCalls: 1,
        latencyMs: Date.now() - startTime,
      },
    });

    return {
      success: isExecutable,
      tokenMint,
      amountInLamports: solAmountLamports,
      expectedTokens,
      priceImpactPercent,
      slippageLamports,
      executableAtSlippage: isExecutable,
      error: isExecutable
        ? undefined
        : `Price impact ${priceImpactPercent.toFixed(2)}% exceeds max ${maxSlippagePercent}%`,
    };
  } catch (error) {
    console.error("[PaperTradingSimulation] Jupiter simulation failed:", error);

    addRecentEvent({
      timestamp: Date.now(),
      category: "api",
      level: "error",
      message: `Jupiter simulation failed for token ${tokenMint}`,
      tokenMint,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      tokenMint,
      amountInLamports: solAmountLamports,
      expectedTokens: 0,
      priceImpactPercent: 0,
      slippageLamports: 0,
      executableAtSlippage: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// =====================
// RETROLEARNER-INFLUENCED EXIT STRATEGIES
// =====================

/**
 * Calculate dynamic exit strategy based on retrolearner outcomes
 * Uses historical patterns to set take profit, stop loss, trailing stops
 */
export async function calculateDynamicExitStrategy(
  tokenMint: string,
  entrySolAmount: number
): Promise<DynamicExitStrategy> {
  // Query retrolearner outcomes for this token (if it exists from previous cycle)
  const tokenOutcome = await db.query.tokenOutcomes.findFirst({
    where: eq(tokenOutcomes.tokenMint, tokenMint),
  });

  // Query similar successful tokens for pattern matching
  const similarSuccessfulTokens = await db
    .select()
    .from(tokenOutcomes)
    .where(
      gte(
        tokenOutcomes.earlyBuyerMedianMultiplier,
        2 // Only tokens that achieved 2x+
      )
    )
    .orderBy(desc(tokenOutcomes.createdAt))
    .limit(20);

  // Calculate baseline from successful token patterns
  let avgPeakMultiplier = 10; // Conservative default
  let avgTimeToPeakMinutes = 45; // Default 45 min
  let avgWinRate = 0.65;
  let avgEarlyBuyerMultiplier = 5;

  if (similarSuccessfulTokens.length > 0) {
    avgPeakMultiplier =
      similarSuccessfulTokens.reduce((sum, t) => sum + (t.peakMultiplierAllTime || 10), 0) /
      similarSuccessfulTokens.length;
    avgTimeToPeakMinutes =
      similarSuccessfulTokens.reduce((sum, t) => sum + (t.timeToPeakMinutes || 45), 0) /
      similarSuccessfulTokens.length;
    avgWinRate =
      similarSuccessfulTokens.reduce((sum, t) => sum + (t.earlyBuyerWinRate || 0.65), 0) /
      similarSuccessfulTokens.length /
      100; // Convert from percentage
    avgEarlyBuyerMultiplier =
      similarSuccessfulTokens.reduce((sum, t) => sum + (t.earlyBuyerMedianMultiplier || 5), 0) /
      similarSuccessfulTokens.length;
  }

  // Override with this token's actual data if available
  if (tokenOutcome) {
    avgPeakMultiplier = tokenOutcome.peakMultiplierAllTime || avgPeakMultiplier;
    avgTimeToPeakMinutes = tokenOutcome.timeToPeakMinutes || avgTimeToPeakMinutes;
    avgWinRate = (tokenOutcome.earlyBuyerWinRate || avgWinRate * 100) / 100;
    avgEarlyBuyerMultiplier = tokenOutcome.earlyBuyerMedianMultiplier || avgEarlyBuyerMultiplier;
  }

  // Calculate confidence: Higher if we have specific outcome data, lower if using patterns
  const hasTokenOutcome = !!tokenOutcome;
  const confidenceScore = hasTokenOutcome ? 0.95 : Math.min(0.75, 0.5 + similarSuccessfulTokens.length * 0.05);

  // Dynamic exit strategy based on patterns
  const basePatterns = ["historical_peak_multiplier", "early_buyer_win_rate"];

  // Take profit: Set at 60% of historical peak (safe exit point)
  // But not too aggressive - early buyers often exit before peak
  const takeProfitMultiplier = Math.max(2, avgEarlyBuyerMultiplier * 0.8);

  // Stop loss: Set based on win rate
  // Higher win rate = tighter stop loss (can risk more per trade)
  // Lower win rate = looser stop loss (need larger losses to be "wrong")
  const stopLossPercent = avgWinRate > 0.7 ? 0.15 : avgWinRate > 0.5 ? 0.25 : 0.35;

  // Trailing stop: Use for tokens with high peak multipliers (catch the moon)
  // Only if we can reach peak quickly and have time to benefit
  let trailingStopPercent: number | undefined;
  const hasUpside = avgPeakMultiplier > 20 && avgTimeToPeakMinutes < 120;
  if (hasUpside) {
    trailingStopPercent = 0.2; // Trail down 20% from highest price
    basePatterns.push("trailing_stop_on_high_upside");
  }

  addRecentEvent({
    timestamp: Date.now(),
    category: "retrolearner",
    level: "info",
    message: `Dynamic exit strategy: TP=${takeProfitMultiplier.toFixed(1)}x, SL=${(stopLossPercent * 100).toFixed(0)}%`,
    tokenMint,
    metrics: {
      dbReads: similarSuccessfulTokens.length + (hasTokenOutcome ? 1 : 0),
    },
  });

  return {
    takeProfitMultiplier,
    stopLossPercent,
    trailingStopPercent,
    estimatedTimeToPeakMinutes: Math.round(avgTimeToPeakMinutes),
    confidenceScore,
    basedOnPatterns: basePatterns,
    rationale: `Based on ${similarSuccessfulTokens.length} similar successful tokens: ` +
      `avg peak=${avgPeakMultiplier.toFixed(1)}x, ` +
      `avg time-to-peak=${Math.round(avgTimeToPeakMinutes)}min, ` +
      `win-rate=${(avgWinRate * 100).toFixed(0)}%${hasTokenOutcome ? " (+ token-specific data)" : ""}`,
  };
}

// =====================
// VALIDATION & LEARNING FEEDBACK
// =====================

/**
 * Record a paper position as a strategy validation
 * Tracks if our predicted exit strategy worked in reality
 */
export async function recordStrategyValidation(
  positionId: number,
  strategyTheory: string,
  expectedOutcome: number,
  latencyMs: number
): Promise<StrategyValidation> {
  const now = Math.floor(Date.now() / 1000);

  const validation: StrategyValidation = {
    positionId,
    simulationPassed: true, // Simulation passed (trade was opened)
    strategyTheory,
    expectedOutcome,
    validationStatus: "pending",
    latencyMs,
    createdAt: now,
  };

  // Store validation record
  try {
    await db.insert(strategyValidations).values({
      positionId,
      strategyTheory,
      expectedOutcome,
      validationStatus: "pending",
      latencyMs,
      createdAt: now,
    } as any);
  } catch (error) {
    console.error("[PaperTradingSimulation] Failed to record validation:", error);
  }

  return validation;
}

/**
 * Update validation record when position closes
 * Compare predicted outcome vs actual outcome
 */
export async function updateValidationWithResult(
  positionId: number,
  actualOutcome: number,
  exitReason: string
): Promise<void> {
  try {
    const validation = await db.query.strategyValidations.findFirst({
      where: eq(strategyValidations.positionId, positionId),
    } as any);

    if (!validation) return;

    const now = Math.floor(Date.now() / 1000);
    const expectedOutcome = validation.expectedOutcome;

    // Determine if validation confirmed or refuted
    const predictionAccuracy = actualOutcome / expectedOutcome;
    const validationStatus =
      predictionAccuracy > 0.5 ? "confirmed" : predictionAccuracy > 0.1 ? "pending" : "refuted";

    await db
      .update(strategyValidations)
      .set({
        actualOutcome,
        actualExitReason: exitReason,
        validationStatus,
      } as any)
      .where(eq(strategyValidations.positionId, positionId));

    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "info",
      message: `Strategy validation: predicted=${expectedOutcome.toFixed(1)}x, actual=${actualOutcome.toFixed(1)}x, status=${validationStatus}`,
      metrics: {
        dbWrites: 1,
      },
    });
  } catch (error) {
    console.error("[PaperTradingSimulation] Failed to update validation:", error);
  }
}

/**
 * Get validation success rate for a strategy
 * Used to refine exit strategies based on what actually works
 */
export async function getStrategyValidationRate(
  strategyTheory: string,
  lookbackHours: number = 24
): Promise<{
  totalValidations: number;
  confirmedCount: number;
  refutedCount: number;
  successRate: number;
  avgAccuracy: number;
}> {
  const sinceTimestamp = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);

  const validations = await db
    .select()
    .from(strategyValidations)
    .where(
      and(
        eq(strategyValidations.strategyTheory, strategyTheory),
        gte(strategyValidations.createdAt, sinceTimestamp)
      )
    );

  const confirmedCount = validations.filter((v) => v.validationStatus === "confirmed").length;
  const refutedCount = validations.filter((v) => v.validationStatus === "refuted").length;

  const avgAccuracy =
    validations.length > 0
      ? validations.reduce((sum, v) => {
          if (!v.actualOutcome) return sum;
          return sum + (v.actualOutcome / v.expectedOutcome);
        }, 0) / validations.length
      : 0;

  return {
    totalValidations: validations.length,
    confirmedCount,
    refutedCount,
    successRate: validations.length > 0 ? confirmedCount / validations.length : 0,
    avgAccuracy,
  };
}

// =====================
// INTEGRATION WITH PAPER POSITION OPENING
// =====================

/**
 * Complete validation workflow before opening paper position
 *
 * 1. Simulate trade on Jupiter (verify liquidity)
 * 2. Calculate dynamic exit strategy based on retrolearner
 * 3. Record validation expectation
 * 4. Only open position if simulation passed
 */
export async function validateAndOpenPaperPosition(params: {
  userId: number;
  tokenMint: string;
  entrySol: number;
  strategyTheory?: string;
  signalWallet?: string;
  maxSlippagePercent?: number;
}): Promise<{
  success: boolean;
  simulation: TradeSimulation;
  exitStrategy?: DynamicExitStrategy;
  validation?: StrategyValidation;
  error?: string;
}> {
  const startTime = Date.now();

  // Step 1: Simulate trade on Jupiter
  console.log(`[PaperTradingSimulation] Simulating trade for ${params.tokenMint}...`);
  const simulation = await simulateTradeOnJupiter(
    params.tokenMint,
    Math.floor(params.entrySol * 1e9),
    params.maxSlippagePercent || 5
  );

  if (!simulation.success) {
    return {
      success: false,
      simulation,
      error: simulation.error,
    };
  }

  // Step 2: Calculate dynamic exit strategy from retrolearner
  console.log(`[PaperTradingSimulation] Calculating exit strategy...`);
  const exitStrategy = await calculateDynamicExitStrategy(params.tokenMint, params.entrySol);

  // Step 3: Record validation expectation (before opening position)
  const latencyMs = Date.now() - startTime;
  const validation = await recordStrategyValidation(
    0, // Position ID will be set after position opens
    params.strategyTheory || "retrolearner_guided_entry",
    exitStrategy.takeProfitMultiplier,
    latencyMs
  );

  addRecentEvent({
    timestamp: Date.now(),
    category: "capacity",
    level: "info",
    message: `Position validation passed: simulation OK, exit strategy calculated (${latencyMs}ms latency)`,
    tokenMint: params.tokenMint,
    metrics: {
      latencyMs,
      apiCalls: 1, // Jupiter simulation
      dbReads: 1, // Outcomes query
      dbWrites: 1, // Validation record
    },
  });

  return {
    success: true,
    simulation,
    exitStrategy,
    validation,
  };
}
