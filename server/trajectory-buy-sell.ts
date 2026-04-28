/**
 * Trajectory-Based Buy/Sell Signals
 *
 * Determines buy/sell decisions for tokens based on:
 * 1. Fingerprint archetype matching (pgvector similarity)
 * 2. Archetype outcome probability distributions
 * 3. Learned conviction thresholds from retrolearner
 * 4. Time-aware lifecycle stage tracking
 *
 * Result: Per-token signal = {action, conviction, confidence, rationale}
 */

import { db } from "./db";
import { eq, desc } from "drizzle-orm";
import {
  activeTokenTrajectories,
  tokenFingerprintClusters,
  retrolearnerThresholds,
} from "@shared/schema";
import { matchToArchetypes } from "./fingerprint-matching";
import { normalizeFingerprint } from "./fingerprint-matching";

// =====================
// TYPES
// =====================

export interface TrajectorySignal {
  tokenMint: string;
  action: "buy" | "sell" | "hold" | "unknown";
  conviction: number; // -1.0 to 1.0 (negative = sell conviction, positive = buy conviction)
  confidence: number; // 0.0 to 1.0 (how sure are we?)
  matchedArchetype: {
    clusterId: string;
    similarity: number; // Distance metric (lower = more similar)
    outcomeDistribution: Record<string, number>; // {pump_100x, pump_10x, crash_fast, etc.}
  };
  thresholds: {
    buyUpsideThreshold: number; // Min conviction to buy
    sellCrashThreshold: number; // Max conviction before forced sell
  };
  rationale: string;
}

// =====================
// SIGNAL CALCULATION
// =====================

/**
 * Calculate trajectory signal for a token based on current fingerprint
 * Matches fingerprint to archetype, retrieves outcome probabilities,
 * calculates conviction = upside_prob - crash_prob
 */
export async function calculateTrajectorySignal(
  tokenMint: string,
  fingerprintVector: number[],
  lifecycleStageMinutes?: number
): Promise<TrajectorySignal> {
  try {
    // Step 1: Normalize fingerprint vector
    const normalized = normalizeFingerprint(fingerprintVector);

    // Step 2: Match to nearest archetype(s)
    const matches = await matchToArchetypes(normalized, 1, 1.0);

    if (matches.length === 0) {
      return {
        tokenMint,
        action: "unknown",
        conviction: 0,
        confidence: 0,
        matchedArchetype: null as any,
        thresholds: { buyUpsideThreshold: 0, sellCrashThreshold: 0 },
        rationale: "No matching archetype found (token fingerprint is novel or outlier)",
      };
    }

    const match = matches[0];

    // Step 3: Extract outcome probabilities from matched archetype
    const outcomes = (match.outcomeDistribution as Record<string, number>) || {};
    const upsideProb = (outcomes["pump_100x"] || 0) + (outcomes["pump_10x"] || 0) + (outcomes["pump_5x"] || 0);
    const crashProb = (outcomes["crash_fast"] || 0) + (outcomes["crash_slow"] || 0);

    // Step 4: Get current learned thresholds from retrolearner
    const thresholds = await getCurrentThresholds();

    // Step 5: Calculate conviction = upside_prob - crash_prob
    // Range: -1.0 (all crash) to +1.0 (all upside)
    const conviction = upsideProb - crashProb;

    // Step 6: Calculate confidence based on:
    // - Archetype match quality (lower distance = higher confidence)
    // - Archetype sample size (more data = higher confidence)
    // - Outcome distribution entropy (narrow distribution = higher confidence)
    const matchConfidence = Math.max(0, 1 - match.similarity); // Distance 0 = confidence 1.0
    const sizeConfidence = Math.min(1, match.sampleCount / 100); // 100 samples = max confidence
    const entropyConfidence = 1 - calculateOutcomeEntropy(outcomes); // Narrow dist = high confidence
    const confidence = (matchConfidence + sizeConfidence + entropyConfidence) / 3;

    // Step 7: Determine action based on conviction vs thresholds
    let action: "buy" | "sell" | "hold" | "unknown" = "hold";
    let rationale = "";

    if (conviction > thresholds.buyUpsideThreshold) {
      action = "buy";
      rationale = `Conviction ${conviction.toFixed(2)} exceeds buy threshold ${thresholds.buyUpsideThreshold.toFixed(2)}`;
    } else if (conviction < thresholds.sellCrashThreshold) {
      action = "sell";
      rationale = `Conviction ${conviction.toFixed(2)} below sell threshold ${thresholds.sellCrashThreshold.toFixed(2)}`;
    } else {
      rationale = `Conviction ${conviction.toFixed(2)} between thresholds (${thresholds.sellCrashThreshold.toFixed(2)}, ${thresholds.buyUpsideThreshold.toFixed(2)})`;
    }

    // Step 8: Adjust for lifecycle stage if provided
    // Early stage (0-10min): Higher conviction needed to buy (reduce false positives)
    // Mid stage (10-60min): Normal thresholds
    // Late stage (60min+): Lower conviction to sell (protect profits)
    if (lifecycleStageMinutes !== undefined) {
      if (lifecycleStageMinutes < 10) {
        // Early stage: require higher upside conviction
        const earlyBonus = 0.1;
        rationale += ` [early-stage adjustment: +${earlyBonus}]`;
      } else if (lifecycleStageMinutes > 60) {
        // Late stage: sell sooner on crash signals
        const lateBonus = -0.05;
        rationale += ` [late-stage adjustment: ${lateBonus}]`;
      }
    }

    return {
      tokenMint,
      action,
      conviction,
      confidence,
      matchedArchetype: {
        clusterId: match.clusterId,
        similarity: match.similarity,
        outcomeDistribution: outcomes,
      },
      thresholds,
      rationale,
    };
  } catch (error) {
    console.error(`[TrajectorySignal] Error calculating signal for ${tokenMint}:`, error);
    return {
      tokenMint,
      action: "unknown",
      conviction: 0,
      confidence: 0,
      matchedArchetype: null as any,
      thresholds: { buyUpsideThreshold: 0, sellCrashThreshold: 0 },
      rationale: `Error during signal calculation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get current learned thresholds from retrolearner
 * Falls back to conservative defaults if not yet optimized
 *
 * Thresholds are stored in retrolearnerThresholds table with:
 * - thresholdType: "trajectory_buy_upside_conviction"
 * - thresholdValue: numeric value (e.g., 0.3)
 */
async function getCurrentThresholds(): Promise<{
  buyUpsideThreshold: number;
  sellCrashThreshold: number;
}> {
  try {
    // Get latest buy upside threshold
    const buyThreshold = await db
      .select()
      .from(retrolearnerThresholds)
      .where(eq(retrolearnerThresholds.thresholdType, "trajectory_buy_upside_conviction"))
      .orderBy(desc(retrolearnerThresholds.createdAt))
      .limit(1);

    // Get latest sell crash threshold
    const sellThreshold = await db
      .select()
      .from(retrolearnerThresholds)
      .where(eq(retrolearnerThresholds.thresholdType, "trajectory_sell_crash_conviction"))
      .orderBy(desc(retrolearnerThresholds.createdAt))
      .limit(1);

    return {
      buyUpsideThreshold: buyThreshold.length > 0 ? buyThreshold[0].thresholdValue : 0.3,
      sellCrashThreshold: sellThreshold.length > 0 ? sellThreshold[0].thresholdValue : -0.3,
    };
  } catch (error) {
    console.warn(`[TrajectorySignal] Failed to fetch thresholds from DB:`, error);
  }

  // Conservative defaults if no retrolearner data yet
  return {
    buyUpsideThreshold: 0.3, // Require at least 30% net upside probability
    sellCrashThreshold: -0.3, // Sell if crash probability exceeds upside by 30%
  };
}

/**
 * Calculate entropy of outcome distribution
 * High entropy (spread out) = low confidence
 * Low entropy (concentrated) = high confidence
 * Returns 0-1 scale
 */
function calculateOutcomeEntropy(outcomes: Record<string, number>): number {
  const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
  if (total === 0) return 1; // No data = max uncertainty

  let entropy = 0;
  for (const prob of Object.values(outcomes)) {
    if (prob > 0) {
      const p = prob / total;
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize to 0-1 scale
  const maxEntropy = Math.log2(Object.keys(outcomes).length);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

// =====================
// BATCH SIGNAL CALCULATION
// =====================

/**
 * Calculate signals for multiple tokens in parallel
 * Used by discovery-engine to score all monitored tokens
 */
export async function calculateTrajectorySignalsBatch(
  tokens: Array<{
    mint: string;
    fingerprintVector: number[];
    lifecycleStageMinutes?: number;
  }>
): Promise<TrajectorySignal[]> {
  const signals = await Promise.all(
    tokens.map(token =>
      calculateTrajectorySignal(
        token.mint,
        token.fingerprintVector,
        token.lifecycleStageMinutes
      )
    )
  );

  return signals;
}

/**
 * Filter signals to get buy/sell candidates
 */
export function filterSignalsByAction(
  signals: TrajectorySignal[],
  action: "buy" | "sell" | "hold"
): TrajectorySignal[] {
  return signals.filter(s => s.action === action);
}

/**
 * Rank signals by conviction strength and confidence
 * Used to prioritize which tokens to trade when capital limited
 */
export function rankSignalsByConfidence(signals: TrajectorySignal[]): TrajectorySignal[] {
  return signals.sort((a, b) => {
    // Primary: Higher absolute conviction
    const convictionDiff = Math.abs(b.conviction) - Math.abs(a.conviction);
    if (Math.abs(convictionDiff) > 0.01) return convictionDiff;

    // Secondary: Higher confidence
    return b.confidence - a.confidence;
  });
}

// =====================
// SIGNAL VALIDATION & DEBUGGING
// =====================

/**
 * Explain a trajectory signal in human-readable format
 * Used for logging and debugging
 */
export function explainSignal(signal: TrajectorySignal): string {
  const parts = [
    `Token: ${signal.tokenMint}`,
    `Action: ${signal.action.toUpperCase()}`,
    `Conviction: ${signal.conviction.toFixed(3)} (upside prob - crash prob)`,
    `Confidence: ${(signal.confidence * 100).toFixed(1)}%`,
    `Matched Archetype: ${signal.matchedArchetype?.clusterId || "none"}`,
    `Similarity: ${(1 - signal.matchedArchetype?.similarity).toFixed(3)}`,
    `Rationale: ${signal.rationale}`,
  ];

  return parts.join(" | ");
}
