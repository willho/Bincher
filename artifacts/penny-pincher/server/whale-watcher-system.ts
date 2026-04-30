import { db } from "./db";
import { tokenDataPool, whaleTokenPositions } from "@shared/schema";
import { eq, and, gte, lt } from "drizzle-orm";

/**
 * Whale Watcher System: Real-Time Exit Signal Intelligence
 *
 * Separate system from token clustering - feeds exit signals without touching cluster structure.
 * Validates learned weight (0.01-0.50) through position outcomes.
 *
 * 3 Signals Generated:
 * - exit_consensus: % of tracked wallets showing exit behavior (0-1)
 * - cascade_risk: likelihood that one whale's exit triggers others (0-1)
 * - dominant_whale_pattern: "dumper_dominant" | "hodler_dominant" | "mixed"
 *
 * Used in system-picks exit decision:
 *   exit_score = (cluster_confidence × 0.95) + (whale_consensus × whale_weight)
 *   whale_weight starts at 0.05, learned through validation
 */

export interface WhaleSignal {
  tokenMint: string;
  timestamp: number;
  exitConsensus: number; // 0-1: % of tracked whales showing exit behavior
  cascadeRisk: number; // 0-1: likelihood of cascade effect
  dominantPattern: "dumper_dominant" | "hodler_dominant" | "mixed";
  trackedWalletCount: number;
  details: {
    walletAddress: string;
    behavior: "dumper" | "hodler" | "scalper" | "accumulator" | "unknown";
    confidence: number; // 0-1: how certain is this classification
    currentMultiplier: number;
    positionChange: number; // % change since entry
  }[];
}

export interface WhaleWeightMetrics {
  currentWeight: number; // 0.01-0.50
  predictionsCorrect: number;
  predictionsWrong: number;
  lastUpdated: number;
  trend: "improving" | "stable" | "declining"; // Based on recent 10 predictions
}

let whaleWeightMetrics: WhaleWeightMetrics = {
  currentWeight: 0.05, // Start conservative
  predictionsCorrect: 0,
  predictionsWrong: 0,
  lastUpdated: Math.floor(Date.now() / 1000),
  trend: "stable",
};

/**
 * Behavior Classification Logic
 *
 * Dumper: Exits at 8-12x multiplier (quick profits)
 * Hodler: Holds until 50x+ or death (patient, conviction)
 * Scalper: Flips at 2-3x (quick trades)
 * Accumulator: Buys dips, increases position (averaging down)
 * Unknown: No history or conflicting patterns
 */
function classifyWhaleBehavior(
  wallet: {
    walletAddress: string;
    historicalExits: Array<{ exitPrice: number; entryPrice: number; holdTimeMinutes: number }>;
    positionHistory: Array<{ timestamp: number; holdingAmount: number }>;
  }
): {
  behavior: "dumper" | "hodler" | "scalper" | "accumulator" | "unknown";
  confidence: number;
} {
  if (!wallet.historicalExits || wallet.historicalExits.length === 0) {
    return { behavior: "unknown", confidence: 0.1 };
  }

  const exits = wallet.historicalExits;
  const avgMultiplier = exits.reduce((sum, e) => sum + e.exitPrice / e.entryPrice, 0) / exits.length;
  const exitPriceRanges = exits.map((e) => e.exitPrice / e.entryPrice).sort((a, b) => a - b);

  // Check for accumulation pattern (positions increase over time)
  const isAccumulator =
    wallet.positionHistory &&
    wallet.positionHistory.length > 2 &&
    wallet.positionHistory.some(
      (h, i, arr) =>
        i > 0 && h.holdingAmount > arr[i - 1].holdingAmount * 1.1 // 10%+ increase
    );

  if (isAccumulator) {
    return { behavior: "accumulator", confidence: 0.8 };
  }

  // Dumper pattern: tight clustering around 8-12x
  if (avgMultiplier >= 8 && avgMultiplier <= 12) {
    const variance = Math.max(...exitPriceRanges) - Math.min(...exitPriceRanges);
    if (variance < 5) {
      return { behavior: "dumper", confidence: 0.9 };
    }
  }

  // Scalper pattern: very quick exits at 2-3x
  const avgHoldMinutes = exits.reduce((sum, e) => sum + e.holdTimeMinutes, 0) / exits.length;
  if (avgMultiplier >= 2 && avgMultiplier <= 3 && avgHoldMinutes < 30) {
    return { behavior: "scalper", confidence: 0.85 };
  }

  // Hodler pattern: patient, waits for large moves
  if (avgMultiplier > 20) {
    return { behavior: "hodler", confidence: 0.85 };
  }

  // Default: unknown
  return { behavior: "unknown", confidence: 0.4 };
}

/**
 * Track whale activity for a token
 * Called when token is being actively monitored
 *
 * Returns signal showing exit consensus and dominant pattern
 */
export async function generateWhaleSignal(
  tokenMint: string,
  trackedWalletAddresses: string[]
): Promise<WhaleSignal> {
  const now = Math.floor(Date.now() / 1000);

  if (trackedWalletAddresses.length === 0) {
    return {
      tokenMint,
      timestamp: now,
      exitConsensus: 0,
      cascadeRisk: 0,
      dominantPattern: "mixed",
      trackedWalletCount: 0,
      details: [],
    };
  }

  // Fetch current token state
  const tokenData = await db.query.tokenDataPool.findFirst({
    where: eq(tokenDataPool.tokenMint, tokenMint),
  });

  if (!tokenData) {
    return {
      tokenMint,
      timestamp: now,
      exitConsensus: 0,
      cascadeRisk: 0,
      dominantPattern: "mixed",
      trackedWalletCount: 0,
      details: [],
    };
  }

  const currentPrice = tokenData.priceUsd || 0;
  const details: WhaleSignal["details"] = [];
  let exitSignalCount = 0;
  let dumpersCount = 0;
  let holdersCount = 0;

  // Analyze each tracked wallet
  for (const walletAddress of trackedWalletAddresses) {
    // Get wallet's positions in this token
    const positions = await db.query.whaleTokenPositions.findMany({
      where: and(
        eq(whaleTokenPositions.walletAddress, walletAddress),
        eq(whaleTokenPositions.tokenMint, tokenMint)
      ),
    });

    if (positions.length === 0) continue;

    const latestPosition = positions[positions.length - 1];
    const entryPrice = latestPosition.entryPriceUsd || 1;
    const currentMultiplier = currentPrice / entryPrice;
    const positionChange = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Classify behavior (simplified: would need historical data in production)
    const { behavior } = classifyWhaleBehavior({
      walletAddress,
      historicalExits: [], // TODO: Fetch from DB
      positionHistory: [], // TODO: Fetch from DB
    });

    // Determine if whale is showing exit signals
    let showingExitSignal = false;
    if (behavior === "dumper" && currentMultiplier >= 8 && currentMultiplier <= 12) {
      showingExitSignal = true; // Dumper at expected exit price
      dumpersCount++;
    } else if (behavior === "scalper" && currentMultiplier >= 2 && currentMultiplier <= 3) {
      showingExitSignal = true; // Scalper at expected exit price
    } else if (behavior === "hodler" && currentMultiplier > 20 && currentMultiplier < 30) {
      showingExitSignal = true; // Hodler approaching expected exit range
      holdersCount++;
    } else if (behavior === "accumulator") {
      showingExitSignal = false; // Accumulators don't exit
    }

    if (showingExitSignal) {
      exitSignalCount++;
    }

    details.push({
      walletAddress,
      behavior,
      confidence: 0.7, // TODO: Calculate from pattern matching
      currentMultiplier,
      positionChange,
    });
  }

  // Calculate signals
  const exitConsensus = details.length > 0 ? exitSignalCount / details.length : 0;
  const dominantPattern =
    dumpersCount > holdersCount ? "dumper_dominant" : holdersCount > dumpersCount ? "hodler_dominant" : "mixed";

  // Cascade risk: high if dominant whale exiting
  const largestWallet = details.length > 0 ? details[0] : null; // TODO: Track by position size
  const cascadeRisk = largestWallet?.behavior === "dumper" && exitConsensus > 0.5 ? 0.8 : exitConsensus * 0.5;

  return {
    tokenMint,
    timestamp: now,
    exitConsensus,
    cascadeRisk,
    dominantPattern,
    trackedWalletCount: details.length,
    details,
  };
}

/**
 * Calculate exit signal for use in system-picks
 *
 * Formula:
 *   exit_score = (cluster_confidence × 0.95) + (whale_consensus × whale_weight)
 *   if exit_score > 0.75: exit, if > 0.60: tighten TSL, if cascade_risk > 0.8: monitor
 */
export function calculateExitSignal(
  clusterConfidence: number,
  whaleSignal: WhaleSignal
): {
  exitScore: number;
  recommendation: "hard_exit" | "tighten_tsl" | "monitor_closely" | "hold";
} {
  const exitScore =
    clusterConfidence * 0.95 + (whaleSignal?.exitConsensus || 0) * whaleWeightMetrics.currentWeight;

  if (exitScore > 0.75) {
    return { exitScore, recommendation: "hard_exit" };
  } else if (exitScore > 0.60) {
    return { exitScore, recommendation: "tighten_tsl" };
  } else if (whaleSignal?.cascadeRisk > 0.8) {
    return { exitScore, recommendation: "monitor_closely" };
  } else {
    return { exitScore, recommendation: "hold" };
  }
}

/**
 * Validate whale signal against actual outcome
 * Called after position closes
 *
 * Updates whale_weight based on whether prediction was correct
 */
export function validateWhaleSignal(
  whaleSignal: WhaleSignal,
  actualPrice: number,
  expectedMinPrice: number
): void {
  const wasCorrect = actualPrice >= expectedMinPrice;

  if (wasCorrect) {
    whaleWeightMetrics.predictionsCorrect++;
    whaleWeightMetrics.currentWeight = Math.min(
      0.5,
      whaleWeightMetrics.currentWeight + 0.01
    );
  } else {
    whaleWeightMetrics.predictionsWrong++;
    whaleWeightMetrics.currentWeight = Math.max(
      0.01,
      whaleWeightMetrics.currentWeight - 0.01
    );
  }

  whaleWeightMetrics.lastUpdated = Math.floor(Date.now() / 1000);

  // Update trend (last 10 predictions)
  const total = whaleWeightMetrics.predictionsCorrect + whaleWeightMetrics.predictionsWrong;
  if (total >= 10) {
    const recentAccuracy = whaleWeightMetrics.predictionsCorrect / total;
    if (recentAccuracy > 0.65) {
      whaleWeightMetrics.trend = "improving";
    } else if (recentAccuracy < 0.45) {
      whaleWeightMetrics.trend = "declining";
    } else {
      whaleWeightMetrics.trend = "stable";
    }
  }
}

/**
 * Get current whale weight metrics
 */
export function getWhaleWeightMetrics(): WhaleWeightMetrics {
  return { ...whaleWeightMetrics };
}

/**
 * Reset whale weight (e.g., if switching strategies)
 */
export function resetWhaleWeight(): void {
  whaleWeightMetrics = {
    currentWeight: 0.05,
    predictionsCorrect: 0,
    predictionsWrong: 0,
    lastUpdated: Math.floor(Date.now() / 1000),
    trend: "stable",
  };
}
