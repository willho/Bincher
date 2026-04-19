import { db } from "./db";
import { eq, and, gte, desc, count, ne, sql } from "drizzle-orm";
import { swaps, botFlaggedWallets, monitoredWallets, tokenDataPool } from "@shared/schema";
import { predictTokenSuccess, extractEarlyDynamicsFeatures } from "./token-success-ann";

// =====================
// SLOW-GROWER DETECTION
// =====================

interface SlowGrowerPattern {
  tokenMint: string;
  funderWallet: string;
  profitableWalletCount: number;
  holdDurationMinutes: number;
  multiplerAchieved: number;
  annConfidence: number; // What ANN predicted vs what actually happened
  discoveryTiming: string; // "early" | "mid" | "late" in token lifecycle
  patternCharacteristics: {
    entryPrice: number;
    peakPrice: number;
    exitPrice: number;
    priceSlope: number;
    volumeAcceleration: number;
  };
}

/**
 * Analyze profitable wallet trades to find slow-grower patterns
 * Only looks at trades system missed but wallets won on
 */
export async function detectSlowGrowerPatterns(): Promise<SlowGrowerPattern[]> {
  console.log("[SlowGrower] Starting detection...");

  const now = Math.floor(Date.now() / 1000);
  const fourHoursAgo = now - 4 * 3600;

  // Get profitable trades from last 4 hours where exit > entry * 1.05
  const profitableTrades = await db
    .select({
      wallet: swaps.source,
      token: swaps.toToken,
      entryAmount: swaps.fromAmount,
      exitAmount: swaps.toAmount,
      timestamp: swaps.timestamp,
    })
    .from(swaps)
    .where(
      and(
        gte(swaps.timestamp, fourHoursAgo),
        // Profitable trade: exit > entry * 1.05
        // Using raw SQL for comparison since drizzle may not support this directly
        sql`${swaps.toAmount} > ${swaps.fromAmount} * 1.05`,
        // Minimum entry amount (whale threshold)
        gte(swaps.fromAmount, 0.1)
      )
    )
    .orderBy(desc(swaps.timestamp))
    .limit(1000);

  const patterns: SlowGrowerPattern[] = [];

  for (const trade of profitableTrades) {
    const tokenMint = trade.token;
    const walletAddress = trade.wallet;

    // Skip if token already in system
    const existingToken = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, tokenMint),
    });

    if (existingToken) {
      continue; // Token already known, skip
    }

    // Skip if wallet is flagged as bot
    const isBotWallet = await db.query.botFlaggedWallets.findFirst({
      where: eq(botFlaggedWallets.walletAddress, walletAddress),
    });

    if (isBotWallet) {
      continue; // Skip bot wallets
    }

    // Check if this is a profitable trade (double-check profitability)
    const entryAmount = trade.entryAmount ?? 0;
    const exitAmount = trade.exitAmount ?? 0;
    const multiplier = entryAmount > 0 ? exitAmount / entryAmount : 0;

    if (multiplier < 1.05) {
      continue; // Not profitable enough
    }

    // Extract early dynamics to get ANN confidence
    // (In real scenario, would need to track entry timestamp)
    const estimatedLaunchTime = (trade.timestamp ?? 0) - 300; // Assume 5 min hold
    let annConfidence = 0.5; // Default

    try {
      annConfidence = await predictTokenSuccess(tokenMint, estimatedLaunchTime);
    } catch (error) {
      console.warn(`[SlowGrower] Could not get ANN confidence for ${tokenMint}`);
    }

    // Count other wallets that profited on same token
    const countResult = await db
      .select({ count: count() })
      .from(swaps)
      .where(
        and(
          eq(swaps.toToken, tokenMint),
          sql`${swaps.toAmount} > ${swaps.fromAmount} * 1.05`,
          ne(swaps.source, walletAddress)
        )
      );

    const profitableWalletCount = countResult[0]?.count ?? 0;

    patterns.push({
      tokenMint,
      funderWallet: walletAddress,
      profitableWalletCount,
      holdDurationMinutes: 5, // Placeholder - would calculate from actual trades
      multiplerAchieved: multiplier,
      annConfidence,
      discoveryTiming: "missed", // System didn't discover this token
      patternCharacteristics: {
        entryPrice: entryAmount,
        peakPrice: exitAmount,
        exitPrice: exitAmount,
        priceSlope: 0, // Would calculate from price history
        volumeAcceleration: 0, // Would calculate from volume data
      },
    });
  }

  console.log(`[SlowGrower] Found ${patterns.length} slow-grower patterns`);

  return patterns;
}

/**
 * Filter patterns to only high-confidence ones
 * (Filters out noise: single-wallet trades, low multipliers)
 */
export function filterHighConfidencePatterns(patterns: SlowGrowerPattern[]): SlowGrowerPattern[] {
  return patterns.filter(p => {
    // Must have profited multiple wallets (not noise)
    if (p.profitableWalletCount < 2) {
      return false;
    }

    // Must be solid multiplier
    if (p.multiplerAchieved < 1.5) {
      return false;
    }

    // ANN confidence should be low (system missed it) but outcome was good
    // This is the signal: outcome better than expected
    return true;
  });
}

/**
 * Store slow-grower patterns for future reference
 * (Could extend schema to have slow_grower_patterns table)
 */
export async function storeSlowGrowerPatterns(patterns: SlowGrowerPattern[]): Promise<void> {
  console.log(`[SlowGrower] Storing ${patterns.length} patterns for future matching`);

  for (const pattern of patterns) {
    // TODO: Store in database for later matching
    // Would create slow_grower_patterns table with:
    // - tokenMint
    // - patternCharacteristics (JSON)
    // - successRate (100% for now, since it was profitable)
    // - walletCount (how many profited)
    // - discoveredAt
    console.log(`  - Token ${pattern.tokenMint}: ${pattern.multiplerAchieved.toFixed(2)}x from ${pattern.funderWallet}`);
  }
}

/**
 * Score new tokens against learned slow-grower patterns
 * Called when new token discovered - check if it matches any learned patterns
 */
export async function scoreSlowGrowerMatch(
  tokenMint: string,
  launchTimestamp: number
): Promise<number> {
  // Extract early dynamics
  const features = await extractEarlyDynamicsFeatures(tokenMint, launchTimestamp);

  // Compare against stored slow-grower patterns
  // This would require similarity matching on pattern characteristics
  // For now, return neutral score
  return 0.5;
}
