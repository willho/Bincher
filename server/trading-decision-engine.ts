import { db } from "./db";
import {
  creatorReputation,
  retrolearnerThresholds,
  tokenFingerprints,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

/**
 * Trading Decision Engine
 * Unified buying logic combining:
 * 1. Creator reputation (T+0)
 * 2. Smart money/whale entry (T+3)
 * 3. ANN confidence (T+5)
 * 4. Milestone conditions (T+10+)
 */

export interface TradingDecision {
  shouldBuy: boolean;
  confidence: number;
  triggers: string[];
  reason: string;
  metadata: {
    creatorScore?: number;
    whaleScore?: number;
    annScore?: number;
    milestoneScore?: number;
  };
}

/**
 * Evaluate creator reputation signal
 * Available at any time (from token metadata at launch)
 * Triggers immediately if creator_win_rate >= learned threshold
 */
export async function shouldBuyAtLaunch(
  tokenMint: string,
  creatorAddress: string
): Promise<TradingDecision> {
  // Get learned creator threshold
  const threshold = await db.query.retrolearnerThresholds.findFirst({
    where: eq(retrolearnerThresholds.thresholdType, "creator_launch_buy"),
  });

  if (!threshold) {
    // No threshold learned yet, use conservative default
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "Creator thresholds not yet learned",
      metadata: {},
    };
  }

  // Look up creator reputation
  const creator = await db.query.creatorReputation.findFirst({
    where: eq(creatorReputation.creatorAddress, creatorAddress),
  });

  if (!creator) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "Creator unknown (no history)",
      metadata: {},
    };
  }

  if (!creator.winRate) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "Creator has insufficient history",
      metadata: { creatorScore: 0 },
    };
  }

  const qualifies = creator.winRate >= threshold.thresholdValue;
  const expectedSuccessRate = threshold.expectedSuccessRate || 0.62;
  const finalConfidence = qualifies
    ? Math.min(creator.confidence || 0.2, expectedSuccessRate)
    : 0;

  return {
    shouldBuy: qualifies,
    confidence: finalConfidence,
    triggers: qualifies ? ["creator_reputation_high"] : [],
    reason: qualifies
      ? `Creator ${(creator.winRate * 100).toFixed(1)}% win rate, expected success ${(expectedSuccessRate * 100).toFixed(1)}%`
      : `Creator win rate ${(creator.winRate * 100).toFixed(1)}% below threshold ${(threshold.thresholdValue * 100).toFixed(1)}%`,
    metadata: { creatorScore: creator.winRate },
  };
}

/**
 * Evaluate whale entry signal
 * Triggers immediately when whale (>= learned threshold) detected
 * Confidence ramps up over first ~3 minutes of whale presence
 */
export async function shouldBuyOnSmartMoney(
  tokenMint: string,
  snapshot: {
    whaleEntered5Sol?: number;
    whaleEntered1Sol?: number;
    timeSinceFirstWhale5Sol?: number;
  }
): Promise<TradingDecision> {
  // Get learned whale threshold
  const threshold = await db.query.retrolearnerThresholds.findFirst({
    where: eq(retrolearnerThresholds.thresholdType, "whale_t3_buy"),
  });

  if (!threshold) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "Whale thresholds not yet learned",
      metadata: {},
    };
  }

  // Check if whale entered
  const whaleSize = threshold.thresholdValue || 5.0;
  const whaleEntered =
    whaleSize === 5.0 ? snapshot.whaleEntered5Sol : snapshot.whaleEntered1Sol;

  if (!whaleEntered) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: `No whale >=${whaleSize} SOL entry detected`,
      metadata: { whaleScore: 0 },
    };
  }

  const expectedSuccessRate = threshold.expectedSuccessRate || 0.75;

  // Confidence ramps up as whale presence duration increases
  // Full confidence after ~3 minutes of whale holding
  const timeSinceWhale = (snapshot.timeSinceFirstWhale5Sol || 0) / 60; // Convert to minutes
  const timeConfidence = Math.min(1.0, timeSinceWhale / 3); // Full confidence at 3 minutes

  const finalConfidence = expectedSuccessRate * timeConfidence;

  return {
    shouldBuy: true,
    confidence: finalConfidence,
    triggers: ["whale_entry_detected"],
    reason: `Whale >=${whaleSize} SOL detected, age ${timeSinceWhale.toFixed(1)}min, expected success ${(expectedSuccessRate * 100).toFixed(1)}%`,
    metadata: { whaleScore: expectedSuccessRate },
  };
}

/**
 * Evaluate ANN shape-matching signal
 * Available once early dynamics fingerprint is complete (usually T+5-T+10)
 * Triggers immediately if ANN score >= learned threshold
 */
export async function shouldBuyOnANNSignal(annScore: number): Promise<TradingDecision> {
  // Get learned ANN threshold
  const threshold = await db.query.retrolearnerThresholds.findFirst({
    where: eq(retrolearnerThresholds.thresholdType, "ann_score_buy"),
  });

  if (!threshold) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "ANN thresholds not yet learned",
      metadata: {},
    };
  }

  const minScore = threshold.thresholdValue || 0.70;
  const qualifies = annScore >= minScore;

  if (!qualifies) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: `ANN score ${annScore.toFixed(3)} below threshold ${minScore.toFixed(3)}`,
      metadata: { annScore },
    };
  }

  // Confidence = ANN score itself (0-1)
  const expectedSuccessRate = threshold.expectedSuccessRate || 0.65;
  const finalConfidence = Math.max(annScore, expectedSuccessRate);

  return {
    shouldBuy: true,
    confidence: finalConfidence,
    triggers: ["ann_shape_match"],
    reason: `Token shape matches successful patterns (ANN: ${annScore.toFixed(3)})`,
    metadata: { annScore },
  };
}

/**
 * Evaluate milestone signal (trader diversity + buy ratio)
 * Triggers whenever milestone conditions are met
 * Available once sufficient trader activity accumulated
 */
export async function shouldBuyOnMilestone(snapshot: {
  uniqueTraders?: number;
  buyRatio?: number;
  concentration?: number;
}): Promise<TradingDecision> {
  // Get learned milestone threshold
  const threshold = await db.query.retrolearnerThresholds.findFirst({
    where: eq(retrolearnerThresholds.thresholdType, "milestone_100_traders_buy"),
  });

  if (!threshold || !snapshot.uniqueTraders || !snapshot.buyRatio) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "Incomplete milestone data",
      metadata: {},
    };
  }

  const minBuyRatio = threshold.thresholdValue || 0.65;
  const qualifies =
    snapshot.uniqueTraders >= 100 &&
    snapshot.buyRatio >= minBuyRatio &&
    (snapshot.concentration || 100) < 70; // Not too concentrated

  if (!qualifies) {
    const reasons = [];
    if (snapshot.uniqueTraders < 100)
      reasons.push(`Only ${snapshot.uniqueTraders} traders (need 100)`);
    if (snapshot.buyRatio < minBuyRatio)
      reasons.push(`Buy ratio ${(snapshot.buyRatio * 100).toFixed(1)}% (need ${(minBuyRatio * 100).toFixed(1)}%)`);
    if ((snapshot.concentration || 100) >= 70)
      reasons.push(`Too concentrated: ${snapshot.concentration?.toFixed(1)}%`);

    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: reasons.join(", "),
      metadata: { milestoneScore: 0 },
    };
  }

  const expectedSuccessRate = threshold.expectedSuccessRate || 0.60;

  return {
    shouldBuy: true,
    confidence: expectedSuccessRate,
    triggers: ["milestone_conditions_met"],
    reason: `${snapshot.uniqueTraders} traders, ${(snapshot.buyRatio * 100).toFixed(1)}% buys, ${(snapshot.concentration || 100).toFixed(1)}% concentration`,
    metadata: { milestoneScore: expectedSuccessRate },
  };
}

/**
 * Combined decision: Evaluate ALL available signals immediately
 *
 * System acts on signals as they arrive, not on time-based gates.
 * Time gates removed - retrolearner learns confidence thresholds for each condition.
 *
 * Strategy:
 * - Creator available? Evaluate immediately → may trigger at T+0, T+1, any time
 * - Whale entered? Evaluate immediately → may trigger at T+1, T+3, any time
 * - ANN score ready? Evaluate immediately → may trigger at T+5, T+8, any time
 * - Milestones hit? Evaluate immediately → may trigger at T+10, T+20, any time
 *
 * Act on first qualified signal with confidence > 0.5, ignoring time entirely.
 */
export async function makeTradingDecision(
  tokenMint: string,
  creatorAddress: string,
  snapshot: {
    // Available signals (any subset may be present)
    whaleEntered5Sol?: number;
    whaleEntered1Sol?: number;
    timeSinceFirstWhale5Sol?: number;
    uniqueTraders?: number;
    buyRatio?: number;
    concentration?: number;
    annScore?: number;
  }
): Promise<TradingDecision> {
  const decisions: TradingDecision[] = [];
  const allMetadata: Record<string, any> = {};

  // 1. CREATOR SIGNAL - Check immediately if available
  // Creator signal is always available (from metadata at launch)
  const creatorDecision = await shouldBuyAtLaunch(tokenMint, creatorAddress);
  decisions.push(creatorDecision);
  allMetadata.creator = creatorDecision.metadata;

  // 2. WHALE SIGNAL - Check immediately if whale data available
  if (snapshot.whaleEntered5Sol !== undefined || snapshot.whaleEntered1Sol !== undefined) {
    const whaleDecision = await shouldBuyOnSmartMoney({
      whaleEntered5Sol: snapshot.whaleEntered5Sol,
      whaleEntered1Sol: snapshot.whaleEntered1Sol,
      timeSinceFirstWhale5Sol: snapshot.timeSinceFirstWhale5Sol,
    });
    decisions.push(whaleDecision);
    allMetadata.whale = whaleDecision.metadata;
  }

  // 3. ANN SIGNAL - Check immediately if ANN score available
  if (snapshot.annScore !== undefined) {
    const annDecision = await shouldBuyOnANNSignal(snapshot.annScore);
    decisions.push(annDecision);
    allMetadata.ann = annDecision.metadata;
  }

  // 4. MILESTONE SIGNAL - Check immediately if milestone data available
  if (
    snapshot.uniqueTraders !== undefined &&
    snapshot.buyRatio !== undefined
  ) {
    const milestoneDecision = await shouldBuyOnMilestone({
      uniqueTraders: snapshot.uniqueTraders,
      buyRatio: snapshot.buyRatio,
      concentration: snapshot.concentration,
    });
    decisions.push(milestoneDecision);
    allMetadata.milestone = milestoneDecision.metadata;
  }

  // DECISION RULE: Act on first qualified signal
  // Select first decision that meets confidence threshold (> 0.5)
  const qualifiedDecision = decisions.find((d) => d.shouldBuy && d.confidence > 0.5);

  if (!qualifiedDecision) {
    return {
      shouldBuy: false,
      confidence: 0,
      triggers: [],
      reason: "No signals qualified (all below 0.5 confidence threshold)",
      metadata: allMetadata,
    };
  }

  return {
    shouldBuy: true,
    confidence: qualifiedDecision.confidence,
    triggers: qualifiedDecision.triggers,
    reason: `Signal triggered: ${qualifiedDecision.triggers.join(", ")} (confidence: ${(qualifiedDecision.confidence * 100).toFixed(1)}%)`,
    metadata: allMetadata,
  };
}

/**
 * Default thresholds if retrolearner hasn't analyzed enough data yet
 */
export const DEFAULT_THRESHOLDS = {
  creator_win_rate: 0.55,
  whale_amount_sol: 5.0,
  ann_score: 0.70,
  buy_ratio_milestone: 0.65,
};
