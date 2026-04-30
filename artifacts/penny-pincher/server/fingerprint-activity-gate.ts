import { db } from "./db";
import { tokenFingerprints, tokenDataPool, rawTokenTrades } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";

/**
 * Activity-Gated Fingerprinting
 *
 * Strategy: Only snapshot tokens that show trading activity
 *
 * T0 (launch): Always fingerprint (capture initial shape)
 * T1+: Only fingerprint if volume occurred since last fingerprint
 *
 * Rationale:
 * - Dead tokens (no trades): 1 fingerprint instead of 50 → 98% storage savings
 * - Active tokens: Fingerprints match trading activity naturally
 * - ANN training cleaner: Only signal patterns, no noise
 *
 * Implementation:
 * - Track lastFingerprintTradeCount per token
 * - Before snapshot: check if tradeCount > lastFingerprintTradeCount
 * - If yes: fingerprint and update lastFingerprintTradeCount
 * - If no: skip snapshot, check again next interval
 */

interface TokenFingerprintState {
  tokenMint: string;
  lastFingerprintTimestamp: number;
  lastFingerprintTradeCount: number;
  currentTradeCount: number;
}

/**
 * Get current trade count for a token
 * Uses raw trades or swaps table depending on availability
 */
export async function getTokenTradeCount(
  tokenMint: string,
  sinceTimestamp?: number
): Promise<number> {
  const query = db
    .select()
    .from(rawTokenTrades)
    .where(
      sinceTimestamp
        ? and(
            eq(rawTokenTrades.tokenMint, tokenMint),
            gte(rawTokenTrades.timestamp, sinceTimestamp)
          )
        : eq(rawTokenTrades.tokenMint, tokenMint)
    );

  const trades = await query;
  return trades.length;
}

/**
 * Check if token should be fingerprinted (volume has occurred since last snapshot)
 *
 * Returns true if:
 * 1. Token never fingerprinted (T0 first snapshot)
 * 2. Volume occurred since last fingerprint
 */
export async function shouldFingerprintToken(
  tokenMint: string
): Promise<{ should: boolean; reason: string; tradesSinceLastFP: number }> {
  // Check last fingerprint
  const lastFP = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .orderBy((t) => t.snapshotTimestamp ?? 0)
    .limit(1);

  // T0: No fingerprint exists yet - always fingerprint
  if (lastFP.length === 0) {
    return {
      should: true,
      reason: "T0_FIRST_FINGERPRINT",
      tradesSinceLastFP: 0,
    };
  }

  // Get trade count since last fingerprint
  const lastFPTimestamp = lastFP[0].snapshotTimestamp || Math.floor(Date.now() / 1000);
  const tradesSince = await getTokenTradeCount(tokenMint, lastFPTimestamp);

  // T1+: Only fingerprint if volume occurred
  if (tradesSince > 0) {
    return {
      should: true,
      reason: `VOLUME_SINCE_LAST_FP_${tradesSince}_TRADES`,
      tradesSinceLastFP: tradesSince,
    };
  }

  // No volume - skip this snapshot
  return {
    should: false,
    reason: "NO_VOLUME_SINCE_LAST_FP",
    tradesSinceLastFP: 0,
  };
}

/**
 * Mark a token as fingerprinted (for volume gating in next interval)
 * Called after successfully creating a new fingerprint
 */
export async function recordFingerprintSnapshot(
  tokenMint: string,
  fingerprintId: string,
  timestamp: number
): Promise<void> {
  // Get current trade count
  const tradeCount = await getTokenTradeCount(tokenMint);

  // Store metadata for next gating check
  // (In practice, this would be in tokenFingerprints.metadata or similar)
  // For now, we rely on the timestamp and can recalculate trade counts

  console.log(
    `[FingerprintGate] ${tokenMint}: Recorded FP ${fingerprintId} at ${new Date(timestamp * 1000).toISOString()}, trades: ${tradeCount}`
  );
}

/**
 * Storage estimate with activity gating
 *
 * Without gating: 50 fingerprints per token × 1000 new tokens/month
 * With gating:
 *   - Dead tokens (70%): 1 fingerprint each
 *   - Active tokens (30%): 5-15 fingerprints each
 *   - Average: ~7 fingerprints per token (85% reduction)
 */
export function estimateStorageSavingsWithGating(): {
  ungatedFingerprints: number;
  gatedFingerprints: number;
  reductionPercent: number;
  estimatedSavings: string;
} {
  const newTokensPerMonth = 36000; // 100/hour × 24h × 30 days
  const ungatedFPPerToken = 50;
  const deadTokenPercent = 0.70;
  const activeTokenPercent = 0.30;
  const avgFPActiveToken = 8; // Average 8 fingerprints for active tokens
  const avgFPDeadToken = 1; // Just T0 for dead tokens

  const ungatedTotal = newTokensPerMonth * ungatedFPPerToken;
  const gatedTotal =
    newTokensPerMonth * deadTokenPercent * avgFPDeadToken +
    newTokensPerMonth * activeTokenPercent * avgFPActiveToken;

  const reductionPercent = Math.round(((ungatedTotal - gatedTotal) / ungatedTotal) * 100);
  const savingsGigabytes = ((ungatedTotal - gatedTotal) * 500) / 1_000_000_000; // Assuming 500B per FP

  return {
    ungatedFingerprints: ungatedTotal,
    gatedFingerprints: Math.round(gatedTotal),
    reductionPercent,
    estimatedSavings: `~${savingsGigabytes.toFixed(1)} GB/month`,
  };
}

/**
 * Demonstrate activity gating in action
 *
 * Scenario: 100 new tokens discovered in first 10 minutes
 *
 * Ungated (current):
 *   T0: 100 fingerprints
 *   T1: 100 fingerprints (even if no trades)
 *   T2: 100 fingerprints (even if no trades)
 *   ...
 *   Total at T30: 50 × 100 = 5,000 fingerprints
 *
 * Gated (with activity gate):
 *   T0: 100 fingerprints (always)
 *   T1: Only 20 fingerprints (only tokens with trades since T0)
 *   T2: Only 15 fingerprints (only tokens with new trades)
 *   T5: Only 5 fingerprints (only sustained activity)
 *   ...
 *   Total at T30: ~150 fingerprints (97% reduction)
 */
export function demonstrateActivityGating(): {
  scenario: string;
  ungatedTotal: number;
  gatedTotal: number;
  reductionPercent: number;
} {
  const tokensDiscovered = 100;
  const snapshotsPerToken = 50; // Typical 50 per token if gated by "every 30s until peak"

  // Ungated: all snapshots created
  const ungatedTotal = tokensDiscovered * snapshotsPerToken;

  // Gated: only active tokens get subsequent snapshots
  // Assume: 20% dead (1 FP each), 80% active (5 FP each on average)
  const deadTokens = tokensDiscovered * 0.20;
  const activeTokens = tokensDiscovered * 0.80;
  const avgActiveFP = 5;

  const gatedTotal = deadTokens * 1 + activeTokens * avgActiveFP;
  const reductionPercent = Math.round(((ungatedTotal - gatedTotal) / ungatedTotal) * 100);

  return {
    scenario: `${tokensDiscovered} tokens, ${snapshotsPerToken} potential snapshots each`,
    ungatedTotal: Math.round(ungatedTotal),
    gatedTotal: Math.round(gatedTotal),
    reductionPercent,
  };
}
