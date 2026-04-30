// @ts-nocheck
/**
 * Token Lifecycle Learning System
 *
 * Collects and learns from token performance across lifecycle phases:
 * 1. Pre-Graduation (Bonding Curve): pump.fun bonding curve metrics
 * 2. Post-Graduation (Raydium): Raydium pool performance
 *
 * Maintains separate fingerprints for each phase + cluster combination
 * Enables system picks to use learned patterns based on which phase token is in
 */

import { db } from "./db";
import { eq, and, gte, lte, isNull, ne, desc } from "drizzle-orm";
import {
  tokenFingerprints,
  tokenOutcomes,
  graduationEvents,
  tokenDataPool,
  paperPositions,
  InsertTokenFingerprint,
} from "@shared/schema";

// =====================
// CONFIGURATION
// =====================

const LIFECYCLE_LEARNING_CONFIG = {
  // Minimum samples before learning
  minSamplesForFingerprint: 10,

  // Learning frequency
  learningCycleIntervalMs: 6 * 60 * 60 * 1000, // Every 6 hours

  // Window for collecting metrics
  preGradMetricsWindow: 4 * 3600, // 4 hours (bonding curve phase)
  postGradMetricsWindow: 24 * 3600, // 24 hours (post-graduation)

  // Confidence adjustments
  highSampleConfidenceThreshold: 50,
  minConfidenceScore: 0.3,
};

// =====================
// PRE-GRADUATION (BONDING CURVE) LEARNING
// =====================

/**
 * Analyze pre-graduation bonding curve metrics for a token
 * Called when token graduates to extract what we learned during its curve phase
 */
export async function analyzePreGraduationPhase(
  tokenMint: string,
  clusterIds: string[]
): Promise<Partial<InsertTokenFingerprint>[]> {
  try {
    const token = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, tokenMint),
    });

    if (!token || !token.pumpfunGraduated) {
      return [];
    }

    const creationTime = token.pairCreatedAt || 0;
    const graduationTime = token.pumpfunGraduationTime || 0;
    const bondingDurationSeconds = graduationTime - creationTime;

    // Collect pre-grad outcome data
    const outcome = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, tokenMint),
    });

    if (!outcome) {
      return [];
    }

    // Create fingerprints for each cluster this token matched
    const fingerprints: Partial<InsertTokenFingerprint>[] = [];

    for (const clusterId of clusterIds) {
      // Estimate entry/exit metrics from bonding curve behavior
      const entrySlippageAvg = calculateBondingCurveEntrySlippage(outcome);
      const slThresholdPercent = calculateOptimalStopLoss(outcome);

      const fingerprint: Partial<InsertTokenFingerprint> = {
        fingerprintType: "pregrad_bonding_curve",
        clusterId,
        tokenMint,

        // Performance metrics
        winRate: outcome.earlyBuyerWinRate || 0,
        medianMultiplier: outcome.earlyBuyerMedianMultiplier || 1,
        sampleCount: outcome.profitableWalletCount || 0,

        // Entry metrics from bonding curve
        entrySlippageAvg,
        entrySlippageP95: entrySlippageAvg * 1.5, // Estimate P95 as 1.5x average

        // Stop loss metrics
        slHitRate: 0.15, // Typical stop loss hit rate
        slThresholdPercent,

        // TSL curve (bonding curve doesn't have typical TSL, but estimate for post-grad)
        tslCurveStartMultiplier: 2,
        tslCurveEndMultiplier: 5,
        tslCurveHoldMinutes: 120,

        // Hold time (bonding curve holders typically exit on graduation or shortly after)
        avgHoldMinutes: 30,
        medianHoldMinutes: 30,

        // Confidence based on sample size
        confidence: Math.min(1.0, outcome.profitableWalletCount! / LIFECYCLE_LEARNING_CONFIG.highSampleConfidenceThreshold),

        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };

      fingerprints.push(fingerprint);
    }

    return fingerprints;
  } catch (error) {
    console.error(
      `[TokenLifecycleLearn] Error analyzing pre-grad phase for ${tokenMint}:`,
      error
    );
    return [];
  }
}

/**
 * Estimate entry slippage from bonding curve metrics
 * Bonding curve buyers typically face less slippage than graduated pools
 */
function calculateBondingCurveEntrySlippage(outcome: any): number {
  // Bonding curve slippage is typically 0.5-2% depending on buy size
  // Early buyers (first 10%) get better prices
  const earlyConcentration = outcome.bondingEarlyBuyerConcentration || 0.3;

  // Lower concentration = more buyers = slightly higher slippage
  const baseSlippage = 0.015; // 1.5% base
  const concentrationFactor = (1 - earlyConcentration) * 0.01; // Up to +1%

  return baseSlippage + concentrationFactor;
}

/**
 * Determine optimal stop loss threshold from outcome data
 */
function calculateOptimalStopLoss(outcome: any): number {
  // Bonding curve volatility is moderate
  // Typical good stop loss is 30-50%
  const medianMultiplier = outcome.earlyBuyerMedianMultiplier || 2;

  // Use lower stop loss for tokens that usually go high
  if (medianMultiplier >= 10) {
    return 50; // Can afford wider stop loss
  } else if (medianMultiplier >= 5) {
    return 40;
  } else {
    return 30; // Tighter stop loss for lower multiplier tokens
  }
}

// =====================
// POST-GRADUATION (RAYDIUM) LEARNING
// =====================

/**
 * Analyze post-graduation Raydium phase metrics
 * Called periodically to update fingerprints with new Raydium data
 */
export async function analyzePostGraduationPhase(
  tokenMint: string,
  clusterIds: string[]
): Promise<Partial<InsertTokenFingerprint>[]> {
  try {
    const graduation = await db.query.graduationEvents.findFirst({
      where: eq(graduationEvents.tokenMint, tokenMint),
    });

    if (!graduation) {
      return [];
    }

    const now = Math.floor(Date.now() / 1000);
    const timesinceGraduation = now - graduation.graduationTime;

    // Only analyze if enough time has passed
    if (timesinceGraduation < 30 * 60) {
      return []; // Too fresh, not enough data yet
    }

    const outcome = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, tokenMint),
    });

    if (!outcome) {
      return [];
    }

    // Create updated fingerprints for post-grad phase
    const fingerprints: Partial<InsertTokenFingerprint>[] = [];

    for (const clusterId of clusterIds) {
      const entrySlippageAvg = calculateRaydiumEntrySlippage(outcome);
      const slThresholdPercent = calculateOptimalStopLoss(outcome);
      const tslCurve = calculateTSLCurve(outcome);

      const fingerprint: Partial<InsertTokenFingerprint> = {
        fingerprintType: "postgrad_raydium",
        clusterId,
        tokenMint,

        // Performance metrics from post-grad buyers
        winRate: outcome.earlyBuyerWinRate || 0,
        medianMultiplier: outcome.peakMultiplierCurrentWindow || outcome.peakMultiplierAllTime || 1,
        sampleCount: outcome.profitableWalletCount || 0,

        // Entry metrics for Raydium
        entrySlippageAvg,
        entrySlippageP95: entrySlippageAvg * 1.8, // Higher variance on Raydium

        // Stop loss metrics
        slHitRate: 0.25, // Raydium tokens are more volatile
        slThresholdPercent,

        // TSL curve that adjusts with token maturity
        tslCurveStartMultiplier: tslCurve.start,
        tslCurveEndMultiplier: tslCurve.end,
        tslCurveHoldMinutes: tslCurve.holdMinutes,

        // Hold time on Raydium
        avgHoldMinutes: outcome.timeToPeakMinutes || 120,
        medianHoldMinutes: outcome.timeToPeakMinutes || 120,

        // Confidence based on time since graduation and samples
        confidence: Math.min(
          1.0,
          (outcome.profitableWalletCount! / LIFECYCLE_LEARNING_CONFIG.highSampleConfidenceThreshold) *
          Math.min(1.0, timesinceGraduation / (2 * 3600)) // Increases confidence over time
        ),

        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };

      fingerprints.push(fingerprint);
    }

    return fingerprints;
  } catch (error) {
    console.error(
      `[TokenLifecycleLearn] Error analyzing post-grad phase for ${tokenMint}:`,
      error
    );
    return [];
  }
}

/**
 * Estimate Raydium entry slippage (typically higher than bonding curve)
 */
function calculateRaydiumEntrySlippage(outcome: any): number {
  // Raydium pools have variable slippage depending on liquidity
  // Typical range: 0.5-5% depending on pool size
  const volumeAccel = outcome.raydiumVolumeAcceleration || 0.5;

  // Higher volume acceleration = more stable = lower slippage
  if (volumeAccel > 2) {
    return 0.015; // Low slippage on high volume
  } else if (volumeAccel > 1) {
    return 0.025; // Medium slippage
  } else {
    return 0.04; // Higher slippage on low volume
  }
}

/**
 * Calculate trailing stop loss curve that adjusts with token maturity
 */
function calculateTSLCurve(outcome: any): { start: number; end: number; holdMinutes: number } {
  const multiplier = outcome.peakMultiplierAllTime || 2;

  // As token matures (higher multipliers achieved), widen TSL curve
  // Early tokens (2x): Start at 2x, end at 3x (tight, catch early profits)
  // Mid tokens (5x): Start at 2x, end at 5x (wider range)
  // Late tokens (10x+): Start at 2x, end at 10x (very wide, let winners run)

  return {
    start: Math.max(1.5, multiplier / 4), // Start TSL after 1.5-2x
    end: multiplier * 0.8, // Final TSL at ~80% of max observed
    holdMinutes: Math.min(1440, 60 + multiplier * 20), // Hold longer for high performers
  };
}

// =====================
// LEARNING CYCLE
// =====================

/**
 * Run the periodic learning cycle
 * Analyzes recent tokens and updates fingerprints
 */
export async function runTokenLifecycleLearning(): Promise<{
  preGradFingerprints: number;
  postGradFingerprints: number;
  tokensAnalyzed: number;
}> {
  try {
    console.log("[TokenLifecycleLearn] Starting learning cycle...");

    let preGradCount = 0;
    let postGradCount = 0;
    let tokensAnalyzed = 0;

    const now = Math.floor(Date.now() / 1000);

    // Find recently graduated tokens (past 24 hours)
    const recentGraduations = await db.query.graduationEvents.findMany({
      where: gte(graduationEvents.graduationTime, now - 24 * 3600),
      limit: 100,
    });

    for (const graduation of recentGraduations) {
      try {
        // Get the token to determine its cluster(s)
        const token = await db.query.tokenDataPool.findFirst({
          where: eq(tokenDataPool.tokenMint, graduation.tokenMint),
        });

        if (!token) continue;

        // Determine which clusters this token belonged to
        // For now, use a simple heuristic - could be enhanced to query actual cluster assignments
        const clusterIds = ["spike_and_bleed", "slow_moon", "pump_dump", "late_bloomer"];

        // Analyze pre-grad phase
        const preGradFingerprints = await analyzePreGraduationPhase(
          graduation.tokenMint,
          clusterIds
        );

        for (const fp of preGradFingerprints) {
          if (fp.sampleCount! >= LIFECYCLE_LEARNING_CONFIG.minSamplesForFingerprint) {
            await db.insert(tokenFingerprints).values(fp).onConflictDoNothing();
            preGradCount++;
          }
        }

        // Analyze post-grad phase
        const postGradFingerprints = await analyzePostGraduationPhase(
          graduation.tokenMint,
          clusterIds
        );

        for (const fp of postGradFingerprints) {
          if (fp.sampleCount! >= LIFECYCLE_LEARNING_CONFIG.minSamplesForFingerprint) {
            await db.insert(tokenFingerprints).values(fp).onConflictDoNothing();
            postGradCount++;
          }
        }

        tokensAnalyzed++;
      } catch (error) {
        console.debug(
          `[TokenLifecycleLearn] Error learning from ${graduation.tokenMint}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    console.log(
      `[TokenLifecycleLearn] Learning cycle complete. Pre-grad: ${preGradCount}, Post-grad: ${postGradCount}, Tokens: ${tokensAnalyzed}`
    );

    return {
      preGradFingerprints: preGradCount,
      postGradFingerprints: postGradCount,
      tokensAnalyzed,
    };
  } catch (error) {
    console.error("[TokenLifecycleLearn] Error in learning cycle:", error);
    return { preGradFingerprints: 0, postGradFingerprints: 0, tokensAnalyzed: 0 };
  }
}

// =====================
// API FUNCTIONS
// =====================

/**
 * Get best fingerprints for a cluster and phase
 */
export async function getBestFingerprint(
  clusterId: string,
  fingerprintType: "pregrad_bonding_curve" | "postgrad_raydium"
): Promise<InsertTokenFingerprint | null> {
  try {
    // Find fingerprints with highest confidence and win rate
    const fingerprints = await db.query.tokenFingerprints.findMany({
      where: and(
        eq(tokenFingerprints.clusterId, clusterId),
        eq(tokenFingerprints.fingerprintType, fingerprintType),
        gte(tokenFingerprints.confidence, LIFECYCLE_LEARNING_CONFIG.minConfidenceScore)
      ),
      orderBy: desc(tokenFingerprints.confidence),
      limit: 1,
    });

    return fingerprints[0] || null;
  } catch (error) {
    console.error(
      `[TokenLifecycleLearn] Error getting best fingerprint for ${clusterId}/${fingerprintType}:`,
      error
    );
    return null;
  }
}

/**
 * Start the learning cycle job
 */
let learningInterval: NodeJS.Timeout | null = null;

export function startTokenLifecycleLearning(): void {
  console.log("[TokenLifecycleLearn] Starting token lifecycle learning job");

  // Run immediately
  runTokenLifecycleLearning();

  // Then every 6 hours
  learningInterval = setInterval(
    () => runTokenLifecycleLearning(),
    LIFECYCLE_LEARNING_CONFIG.learningCycleIntervalMs
  );
}

export function stopTokenLifecycleLearning(): void {
  if (learningInterval) {
    clearInterval(learningInterval);
    learningInterval = null;
  }
}
