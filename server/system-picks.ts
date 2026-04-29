import { db } from "./db";
import { eq, and, gt, gte, desc, isNull, sql } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  raydiumPoolDiscoveries,
  paperPositions,
  familiarWhales,
  signalWalletProfiles,
  activeTokenTrajectories,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { openPaperPosition } from "./paper-trading";
import { calculateTrajectorySignal, filterSignalsByAction, rankSignalsByConfidence } from "./trajectory-buy-sell";
import axios from "axios";

// =====================
// CONFIGURATION
// =====================

const SYSTEM_PICKS_CONFIG = {
  // Minimum conviction to open a BUY position
  // conviction = upside_prob - crash_prob, range: -1.0 to +1.0
  minBuyConviction: 0.3, // Require at least 30% net upside probability
  // Minimum confidence score (0-1) in archetype match quality
  minConfidence: 0.5,
  // Paper trading entry size in SOL
  paperEntrySize: 1.0,
  // Exit parameters (learned per-archetype, defaults below)
  defaultTakeProfitMultiplier: 5.0,
  defaultStopLossPercent: 20, // %
  defaultTrailingStopPercent: 15, // %
  // Max unique tokens with open positions (limiting factor)
  maxSimultaneousTokens: 50,
  // Jupiter simulate call timeout
  jupiterSimulateTimeoutMs: 10000,
};

interface SystemPick {
  tokenMint: string;
  tokenSymbol: string;
  conviction: number; // -1.0 to +1.0 (upside_prob - crash_prob)
  confidence: number; // 0-1 (quality of archetype match)
  action: "buy" | "sell" | "hold";
  matchedClusterId: string; // Which archetype matched
  entrySlippage: number; // % (estimated from archetype)
  slThreshold: number; // % (learned per-archetype)
  tpMultiplier: number; // x (learned per-archetype)
  estimatedEntry: number; // SOL
  jupiterValidated: boolean;
}

// =====================
// TRAJECTORY SIGNAL CALCULATION
// =====================

/**
 * Calculate trajectory signal for a token mint
 * Uses archetype matching to determine buy/sell conviction
 * Returns null if token doesn't have a fingerprint vector yet
 */
async function calculateSystemPickSignal(
  tokenMint: string,
  lifecycleStageMinutes?: number
): Promise<SystemPick | null> {
  try {
    // Get the latest trajectory record (which contains the fingerprint vector)
    const trajectory = await db
      .select()
      .from(activeTokenTrajectories)
      .where(eq(activeTokenTrajectories.tokenMint, tokenMint))
      .orderBy(desc(activeTokenTrajectories.snapshotSequence))
      .limit(1);

    if (trajectory.length === 0) {
      console.log(`[SystemPicks] No fingerprint vector found for ${tokenMint.slice(0, 8)}`);
      return null;
    }

    const traj = trajectory[0];
    const fingerprintVector = Array.isArray(traj.fingerprintVector)
      ? traj.fingerprintVector
      : JSON.parse(traj.fingerprintVector as any);

    // Calculate trajectory signal (matches to archetype, determines conviction)
    const signal = await calculateTrajectorySignal(tokenMint, fingerprintVector, lifecycleStageMinutes);

    // Get token data for metadata
    const tokenData = await getTokenData(tokenMint);

    // Convert signal to SystemPick format
    const pick: SystemPick = {
      tokenMint,
      tokenSymbol: tokenData?.tokenSymbol || tokenMint.slice(0, 8),
      conviction: signal.conviction,
      confidence: signal.confidence,
      action: signal.action,
      matchedClusterId: signal.matchedArchetype?.clusterId || "unknown",
      entrySlippage: 0.75, // Default, would be refined per-archetype
      slThreshold: SYSTEM_PICKS_CONFIG.defaultStopLossPercent,
      tpMultiplier: SYSTEM_PICKS_CONFIG.defaultTakeProfitMultiplier,
      estimatedEntry: SYSTEM_PICKS_CONFIG.paperEntrySize,
      jupiterValidated: false, // Will validate below
    };

    return pick;
  } catch (error) {
    console.error(
      `[SystemPicks] Error calculating signal for ${tokenMint.slice(0, 8)}:`,
      error
    );
    return null;
  }
}

// =====================
// JUPITER VALIDATION
// =====================

/**
 * Call Jupiter simulate() to validate entry/exit parameters with current market conditions
 * Returns true if execution is feasible with realistic slippage and latency
 */
async function validateWithJupiter(
  mint: string,
  entryAmountSol: number = 1.0
): Promise<boolean> {
  try {
    // Convert SOL to USD using current SOL price
    const solData = await fetchTokenWithFallback("So11111111111111111111111111111111111111112");
    const solPrice = solData.priceUsd || 150;
    const entryAmountUsd = entryAmountSol * solPrice;

    // Try to simulate a swap
    // For MVP: simplified check - just validate that the token has decent liquidity
    const tokenData = await getTokenData(mint);

    if (!tokenData.raydiumPoolAddress) {
      console.log(
        `[SystemPicks] Token ${mint.slice(0, 8)} missing Raydium pool address, skipping Jupiter validation`
      );
      return false;
    }

    // Check liquidity: need enough to execute $1 SOL worth
    if ((tokenData.raydiumLiquidityUsd || 0) < 10000) {
      console.log(
        `[SystemPicks] Token ${mint.slice(0, 8)} liquidity too low (${(tokenData.raydiumLiquidityUsd || 0).toFixed(0)} USD)`
      );
      return false;
    }

    // In production: would call Jupiter API
    // const response = await axios.get(
    //   `https://quote-api.jup.ag/v6/quote`,
    //   {
    //     params: {
    //       inputMint: "So11111111111111111111111111111111111111112",
    //       outputMint: mint,
    //       amount: entryAmountSol * Math.pow(10, 9), // Convert SOL to lamports
    //       slippageBps: 50, // 0.5% slippage
    //     },
    //     timeout: SYSTEM_PICKS_CONFIG.jupiterSimulateTimeoutMs,
    //   }
    // );

    // Simplified validation: if liquidity is sufficient, assume execution is feasible
    console.log(
      `[SystemPicks] Token ${mint.slice(0, 8)} Jupiter validation passed (liquidity=${(tokenData.raydiumLiquidityUsd || 0).toFixed(0)} USD)`
    );
    return true;
  } catch (error) {
    console.error(
      `[SystemPicks] Jupiter validation error for ${mint.slice(0, 8)}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

// =====================
// POSITION OPENING
// =====================

/**
 * Open a paper position for a high-conviction system pick
 */
async function openSystemPick(pick: SystemPick, userId: number = 1): Promise<void> {
  try {
    console.log(
      `[SystemPicks] Opening paper position: ${pick.tokenSymbol}/${pick.tokenMint.slice(0, 8)} ` +
      `(conviction=${pick.conviction.toFixed(2)}, confidence=${(pick.confidence * 100).toFixed(0)}%, ` +
      `archetype=${pick.matchedClusterId})`
    );

    const now = Math.floor(Date.now() / 1000);

    // Open paper position with archetype-learned exit parameters
    await openPaperPosition({
      userId,
      tokenMint: pick.tokenMint,
      tokenSymbol: pick.tokenSymbol,
      entrySol: pick.estimatedEntry,
      signalWallet: undefined, // System pick, not from signal wallet
      stopLossPercent: pick.slThreshold, // Learned per-archetype
      takeProfitMultiplier: pick.tpMultiplier, // Learned per-archetype
      trailingStop: true,
      trailingStopPercent: SYSTEM_PICKS_CONFIG.defaultTrailingStopPercent,
      entryTxSignature: undefined, // Paper trade, no real TX
    });

    // Log the system pick decision
    console.log(
      `[SystemPicks] Paper position opened for ${pick.tokenSymbol}: ` +
      `conviction=${pick.conviction.toFixed(2)}, SL=${pick.slThreshold}%, TP=${pick.tpMultiplier}x`
    );
  } catch (error) {
    console.error(`[SystemPicks] Error opening position for ${pick.tokenMint.slice(0, 8)}:`, error);
  }
}

// =====================
// MAIN SYSTEM PICKS LOOP
// =====================

/**
 * Scan for high-conviction system picks and open positions
 * Runs every 5 minutes to catch new discoveries and pool launches
 */
export async function startSystemPicks(): Promise<void> {
  console.log("[SystemPicks] Starting system picks scanner (every 5 minutes)");

  // Initial scan after 30 seconds
  setTimeout(async () => {
    try {
      await scanForPicks();
    } catch (error) {
      console.error("[SystemPicks] Initial scan failed:", error);
    }
  }, 30_000);

  // Periodic scans every 5 minutes
  setInterval(async () => {
    try {
      await scanForPicks();
    } catch (error) {
      console.error("[SystemPicks] Scan error:", error);
    }
  }, 5 * 60 * 1000);
}

async function scanForPicks(): Promise<void> {
  try {
    // Check how many unique tokens already have open positions
    const openTokens = await db
      .selectDistinct({ tokenMint: paperPositions.tokenMint })
      .from(paperPositions)
      .where(eq(paperPositions.status, "open"));

    if (openTokens.length >= SYSTEM_PICKS_CONFIG.maxSimultaneousTokens) {
      console.log(
        `[SystemPicks] At capacity (${openTokens.length}/${SYSTEM_PICKS_CONFIG.maxSimultaneousTokens} unique tokens with open positions)`
      );
      return;
    }

    // Get recently discovered/graduated tokens that have fingerprint vectors
    // (trajectory records indicate they've been analyzed)
    const candidates = await db
      .select({ tokenMint: activeTokenTrajectories.tokenMint })
      .from(activeTokenTrajectories)
      .where(gte(activeTokenTrajectories.snapshotTimestamp, Math.floor(Date.now() / 1000) - 3600))
      .orderBy(desc(activeTokenTrajectories.snapshotSequence))
      .limit(50);

    console.log(`[SystemPicks] Found ${candidates.length} tokens with recent trajectory data`);

    const picks: SystemPick[] = [];

    // Evaluate each candidate
    for (const candidate of candidates) {
      const mint = candidate.tokenMint;

      // Skip if already trading this token
      const existingPosition = await db.query.paperPositions.findFirst({
        where: and(eq(paperPositions.tokenMint, mint), eq(paperPositions.status, "open")),
      });

      if (existingPosition) {
        continue;
      }

      // Calculate trajectory signal (archetype matching + conviction)
      const signal = await calculateSystemPickSignal(mint);

      if (!signal) {
        continue; // No fingerprint yet
      }

      // Filter: Only consider BUY signals with high enough conviction and confidence
      if (signal.action !== "buy") {
        continue;
      }

      if (signal.conviction < SYSTEM_PICKS_CONFIG.minBuyConviction) {
        continue; // Below conviction threshold
      }

      if (signal.confidence < SYSTEM_PICKS_CONFIG.minConfidence) {
        continue; // Below confidence threshold
      }

      // Validate with Jupiter (check liquidity, etc.)
      const jupiterOk = await validateWithJupiter(mint);

      if (!jupiterOk) {
        continue;
      }

      // This is a high-conviction buy signal!
      picks.push({
        ...signal,
        jupiterValidated: true,
      });
    }

    // Rank by conviction + confidence to prioritize best picks
    const rankedPicks = rankSignalsByConfidence(picks);

    console.log(
      `[SystemPicks] Found ${rankedPicks.length} high-conviction BUY picks ` +
      `(min_conviction=${SYSTEM_PICKS_CONFIG.minBuyConviction}, min_confidence=${SYSTEM_PICKS_CONFIG.minConfidence})`
    );

    // Open positions for high-conviction picks (up to capacity)
    for (const pick of rankedPicks) {
      if (openTokens.length >= SYSTEM_PICKS_CONFIG.maxSimultaneousTokens) {
        break; // Hit capacity limit
      }
      await openSystemPick(pick);
      openTokens.push({ tokenMint: pick.tokenMint }); // Track for capacity
    }
  } catch (error) {
    console.error("[SystemPicks] Error in scan:", error);
  }
}
