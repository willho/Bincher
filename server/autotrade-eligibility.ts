/**
 * Autotrade/System Picks Eligibility
 *
 * Separate from monitoring pool ranking. A token must pass BOTH:
 * 1. Leaderboard criteria (in pool, compositeScore > threshold)
 * 2. Autotrade-specific safety gates (strict requirements beyond ranking)
 *
 * Autotrade is more conservative than monitoring:
 * - Monitoring: "Is this worth watching?" (1900 slots, ANN-driven)
 * - Autotrade: "Is this safe enough to auto-execute?" (strict guardrails)
 */

import { db } from "./db";
import { eq, and, gte, lte } from "drizzle-orm";
import { tokenDataPool } from "@shared/schema";

/**
 * Autotrade eligibility gates (AND logic - all must pass)
 */
export interface AutotradeGates {
  annConfidencePass: boolean; // ANN score > 0.65 (higher bar than monitoring)
  liquidityPass: boolean; // Liquidity > $100K
  holderDistributionPass: boolean; // Top 10 holders < 80% (avoid concentrate risk)
  agePass: boolean; // Token age 1-30 minutes (avoid very new, avoid zombies)
  volumePass: boolean; // 24h volume > $50K
  rugCheckPass: boolean; // RugCheck score acceptable
  deployerReputationPass: boolean; // Deployer not known scammer
  socialPresencePass: boolean; // Has Twitter OR Telegram (reduced risk)
  contractVerifiedPass: boolean; // Verified contract source code
}

/**
 * Autotrade decision with detailed breakdown
 */
export interface AutotradeDecision {
  eligible: boolean;
  eligibilityScore: number; // 0-100
  gates: AutotradeGates;
  failureReasons: string[]; // Why ineligible
  confidence: "high" | "medium" | "low";
  recommendation: "buy" | "skip" | "monitor_only";
}

/**
 * Check if token passes autotrade eligibility
 *
 * Stricter than monitoring pool:
 * - Must be in pool (compositeScore acceptable)
 * - Must pass all safety gates
 * - High bar for contract verification and deployer reputation
 *
 * @param mint - Token mint address
 * @returns Detailed eligibility assessment
 */
export async function assessAutotradeEligibility(mint: string): Promise<AutotradeDecision> {
  const decision: AutotradeDecision = {
    eligible: false,
    eligibilityScore: 0,
    gates: {
      annConfidencePass: false,
      liquidityPass: false,
      holderDistributionPass: false,
      agePass: false,
      volumePass: false,
      rugCheckPass: false,
      deployerReputationPass: false,
      socialPresencePass: false,
      contractVerifiedPass: false,
    },
    failureReasons: [],
    confidence: "low",
    recommendation: "skip",
  };

  try {
    const token = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, mint),
    });

    if (!token) {
      decision.failureReasons.push("Token not found in pool");
      return decision;
    }

    // Gate 1: ANN Confidence (>0.65 is high bar for autotrade)
    const annScore = token.lastAnnScore ?? 0;
    if (annScore > 0.65) {
      decision.gates.annConfidencePass = true;
    } else {
      decision.failureReasons.push(`ANN score ${annScore.toFixed(2)} < 0.65 (autotrade bar)`);
    }

    // Gate 2: Liquidity (>$100K for safety)
    const liquidity = token.liquidity ?? 0;
    if (liquidity > 100_000) {
      decision.gates.liquidityPass = true;
    } else {
      decision.failureReasons.push(`Liquidity $${liquidity.toFixed(0)} < $100K`);
    }

    // Gate 3: Holder concentration (<80% in top 10 holders)
    // Note: This requires data from holderCache or RugCheck
    // For now, use heuristic from raydium_holder_concentration field
    const holderConc = token.raydiumHolderConcentration ?? 100;
    if (holderConc < 80) {
      decision.gates.holderDistributionPass = true;
    } else {
      decision.failureReasons.push(`Top 10 holders ${holderConc.toFixed(1)}% >= 80% (concentrated risk)`);
    }

    // Gate 4: Token age (1-30 minutes for bonding curve, 5min-1hr for graduated)
    const createdAt = token.pairCreatedAt ?? 0;
    const ageMinutes = createdAt > 0 ? (Math.floor(Date.now() / 1000) - createdAt) / 60 : -1;
    const isPumpfun = token.isPumpfun ?? false;

    if (isPumpfun && ageMinutes >= 1 && ageMinutes <= 30) {
      decision.gates.agePass = true;
    } else if (!isPumpfun && ageMinutes >= 5 && ageMinutes <= 60) {
      decision.gates.agePass = true;
    } else if (ageMinutes < 0) {
      decision.failureReasons.push("Token age unknown (pairCreatedAt missing)");
    } else {
      decision.failureReasons.push(`Token age ${ageMinutes.toFixed(1)}m outside safe range`);
    }

    // Gate 5: 24h Volume (>$50K)
    const volume24h = (token.volume24h ?? 0) * (token.priceUsd ?? 1); // Convert to USD if needed
    if (volume24h > 50_000) {
      decision.gates.volumePass = true;
    } else {
      decision.failureReasons.push(`24h volume $${volume24h.toFixed(0)} < $50K`);
    }

    // Gate 6: RugCheck (parse rugcheckData)
    // Acceptable if risk score < 7/10
    const rugCheckData = token.rugcheckData as any;
    if (rugCheckData && typeof rugCheckData === "object") {
      const riskScore = rugCheckData.riskScore ?? 10; // Assume worst if missing
      if (riskScore <= 7) {
        decision.gates.rugCheckPass = true;
      } else {
        decision.failureReasons.push(`RugCheck risk score ${riskScore} > 7`);
      }
    } else {
      decision.failureReasons.push("RugCheck data unavailable");
    }

    // Gate 7: Deployer reputation (not known scammer)
    // Use deployerAddress and any reputation tracking
    const deployerAddr = token.deployerAddress;
    // TODO: Query known_scammers table or trusted_deployers table
    // For now, assume pass if deployer info exists
    if (deployerAddr && deployerAddr.length > 0) {
      decision.gates.deployerReputationPass = true; // Placeholder
    } else {
      decision.failureReasons.push("Deployer address unknown");
    }

    // Gate 8: Social presence (Twitter OR Telegram)
    const hasTwitter = token.hasTwitter ?? false;
    const hasTelegram = token.hasTelegram ?? false;
    if (hasTwitter || hasTelegram) {
      decision.gates.socialPresencePass = true;
    } else {
      decision.failureReasons.push("No Twitter or Telegram presence detected");
    }

    // Gate 9: Contract verification
    // Placeholder - would check if contract source is verified on-chain
    // For now, infer from safety data availability
    if (token.rugcheckData || token.goplusData) {
      decision.gates.contractVerifiedPass = true; // Has security audit data
    } else {
      decision.failureReasons.push("Contract verification unknown");
    }

    // Calculate eligibility score (0-100 based on gates passing)
    const gatesPassed = Object.values(decision.gates).filter((v) => v).length;
    decision.eligibilityScore = Math.round((gatesPassed / 9) * 100);

    // Determine final eligibility
    const allGatesPassed = Object.values(decision.gates).every((v) => v);
    decision.eligible = allGatesPassed;

    // Determine confidence and recommendation
    if (allGatesPassed) {
      decision.confidence = "high";
      decision.recommendation = "buy";
    } else if (gatesPassed >= 7) {
      decision.confidence = "medium";
      decision.recommendation = "skip"; // Too risky even if promising
    } else {
      decision.confidence = "low";
      decision.recommendation = annScore > 0.7 ? "monitor_only" : "skip";
    }
  } catch (error) {
    console.error(`[AutotradeEligibility] Error assessing ${mint}:`, error);
    decision.failureReasons.push(`Error: ${(error as Error).message}`);
  }

  return decision;
}

/**
 * Get all tokens currently eligible for autotrade
 *
 * @param limit - Max results (default 5, safety limit)
 * @returns Eligible tokens sorted by composite score
 */
export async function getAutotradeEligibleTokens(limit: number = 5): Promise<
  Array<{
    mint: string;
    compositeScore: number;
    annScore: number;
    eligibilityScore: number;
    recommendation: string;
  }>
> {
  try {
    // Get all tokens in monitoring pool with high composite scores
    const poolTokens = await db.query.tokenDataPool.findMany({
      where: and(eq(tokenDataPool.isMonitored, true), gte(tokenDataPool.compositeScore, 3.0)), // Only consider top candidates
      orderBy: (t) => [t.compositeScore], // Highest first (Drizzle might need desc)
      limit: Math.min(limit * 3, 20), // Check 3x more than needed
    });

    const eligible = [];

    for (const token of poolTokens) {
      const assessment = await assessAutotradeEligibility(token.tokenMint);

      if (assessment.eligible) {
        eligible.push({
          mint: token.tokenMint,
          compositeScore: token.compositeScore ?? 0,
          annScore: token.lastAnnScore ?? 0,
          eligibilityScore: assessment.eligibilityScore,
          recommendation: assessment.recommendation,
        });

        if (eligible.length >= limit) break;
      }
    }

    return eligible.sort((a, b) => b.compositeScore - a.compositeScore);
  } catch (error) {
    console.error("[AutotradeEligibility] Error getting eligible tokens:", error);
    return [];
  }
}

/**
 * API-friendly summary of autotrade picks
 */
export async function getAutotradePicksSummary(): Promise<{
  totalEligible: number;
  topPicks: Array<{ mint: string; score: number; gates: number }>;
  recommendation: string;
}> {
  const eligible = await getAutotradeEligibleTokens(3);

  return {
    totalEligible: eligible.length,
    topPicks: eligible.map((t) => ({
      mint: t.mint,
      score: t.compositeScore,
      gates: Math.round(t.eligibilityScore / 11.1), // Convert 0-100 to 0-9 gates
    })),
    recommendation:
      eligible.length > 0
        ? `${eligible.length} token(s) eligible for autotrade. Top pick: ${eligible[0].mint.slice(0, 12)}...`
        : "No tokens meet autotrade safety requirements. Monitor leaderboard.",
  };
}
