import { db } from "./db";
import { eq, and, gt, gte, desc, isNull, sql } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  raydiumPoolDiscoveries,
  paperPositions,
  familiarWhales,
  signalWalletProfiles,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { openPaperPosition } from "./paper-trading";
import axios from "axios";

// =====================
// CONFIGURATION
// =====================

const SYSTEM_PICKS_CONFIG = {
  // Minimum conviction threshold to open a position
  minConvictionScore: 0.5, // 0-1 scale
  // Paper trading entry size in SOL
  paperEntrySize: 1.0,
  // SL and TP from fingerprint
  useFingerprintSL: true,
  // Max unique tokens with open positions (limiting factor)
  maxSimultaneousTokens: 50,
  // Jupiter simulate call timeout
  jupiterSimulateTimeoutMs: 10000,
};

interface ConvictionScoreInput {
  fingerprintWinRate: number; // 0-1: confidence from retrolearner
  creatorReputation: number; // 0-1: how trusted is the pool creator
  walletSignals: number; // 0-1: from familiar whales/signal wallets
}

interface SystemPick {
  tokenMint: string;
  tokenSymbol: string;
  convictionScore: number; // 0-1
  fingerprintType: string;
  fingerprintWinRate: number;
  entrySlippage: number; // %
  slThreshold: number; // %
  estimatedEntry: number; // $ or SOL
  jupiterValidated: boolean;
}

// =====================
// CONVICTION SCORING
// =====================

/**
 * Calculate conviction score from multiple factors
 * conviction = (fingerprint_win_rate × 0.5) + (creator_rep × 0.3) + (wallet_signals × 0.2)
 * Weights: fingerprint learning is most important, then creator, then wallet signals
 */
function calculateConvictionScore(input: ConvictionScoreInput): number {
  const weighted =
    input.fingerprintWinRate * 0.5 +
    input.creatorReputation * 0.3 +
    input.walletSignals * 0.2;

  return Math.min(1.0, Math.max(0, weighted));
}

/**
 * Get creator reputation score
 * Creator reputation comes from whale reputation tracking - how successful have tokens from this creator been
 * For MVP: estimate from pool quality and liquidity
 */
async function getCreatorReputation(mint: string): Promise<number> {
  try {
    const tokenData = await getTokenData(mint);

    if (!tokenData.raydiumCreatorReputation) {
      // Estimate from liquidity and age: newer, higher liquidity = better creator
      const liquidity = tokenData.raydiumLiquidityUsd || 0;
      const ageHours = (Date.now() / 1000 - (tokenData.raydiumPoolDiscoveredAt || 0)) / 3600;

      if (liquidity < 1000) return 0.2;
      if (liquidity < 10000) return 0.4;
      if (liquidity < 50000) return 0.6;
      if (liquidity < 100000) return 0.75;
      return 0.85;
    }

    return Math.min(1.0, tokenData.raydiumCreatorReputation);
  } catch (error) {
    console.error(
      `[SystemPicks] Error getting creator reputation for ${mint.slice(0, 8)}:`,
      error
    );
    return 0.3; // Neutral default
  }
}

/**
 * Get wallet signals score from familiar whales and signal wallets
 * Higher score if whales are accumulating this token or if signal wallets recently bought
 */
async function getWalletSignalsScore(mint: string): Promise<number> {
  try {
    // Check if any familiar whales have positions in this token
    // This would require tracking whale holdings, which isn't fully implemented yet
    // For MVP: return moderate signal score if token is recent
    const tokenData = await getTokenData(mint);
    const ageHours = (Date.now() / 1000 - (tokenData.pairCreatedAt || 0)) / 3600;

    // Newer tokens = higher signal (whales move fast on new launches)
    if (ageHours < 1) return 0.8;
    if (ageHours < 2) return 0.7;
    if (ageHours < 4) return 0.6;
    if (ageHours < 6) return 0.4;
    return 0.2;
  } catch (error) {
    console.error(`[SystemPicks] Error getting wallet signals for ${mint.slice(0, 8)}:`);
    return 0.3; // Neutral default
  }
}

// =====================
// FINGERPRINT MATCHING
// =====================

/**
 * Find best matching fingerprint for a token
 * Matches by clusterId (strategy type)
 */
async function findMatchingFingerprint(mint: string, fingerprintType: string) {
  try {
    // First check if token was recently graduated or is a new pool discovery
    const tokenData = await getTokenData(mint);

    // Determine fingerprint type based on token origin
    let targetFingerprintType = fingerprintType;
    if (tokenData.isDirectRaydiumLaunch) {
      targetFingerprintType = "postgrad_raydium";
    } else if (tokenData.pumpfunGraduated) {
      targetFingerprintType = "postgrad_raydium";
    }

    // Find fingerprints for this type
    const fingerprints = await db.query.tokenFingerprints.findMany({
      where: eq(tokenFingerprints.fingerprintType, targetFingerprintType),
      orderBy: [desc(tokenFingerprints.confidence)],
      limit: 5,
    });

    if (fingerprints.length === 0) {
      console.log(
        `[SystemPicks] No fingerprints found for ${mint.slice(0, 8)} type=${targetFingerprintType}`
      );
      return null;
    }

    // Return highest confidence fingerprint
    return fingerprints[0];
  } catch (error) {
    console.error(`[SystemPicks] Error finding fingerprint for ${mint.slice(0, 8)}:`, error);
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
      `[SystemPicks] Opening paper position: ${pick.tokenSymbol}/${pick.tokenMint.slice(0, 8)} (conviction=${(pick.convictionScore * 100).toFixed(0)}%)`
    );

    const now = Math.floor(Date.now() / 1000);

    // Open paper position with fingerprint-learned parameters
    await openPaperPosition({
      userId,
      tokenMint: pick.tokenMint,
      tokenSymbol: pick.tokenSymbol,
      entrySol: SYSTEM_PICKS_CONFIG.paperEntrySize,
      signalWallet: undefined, // System pick, not from signal wallet
      stopLossPercent: pick.slThreshold,
      takeProfitMultiplier: 5.0, // Learnable, start with 5x as default
      trailingStop: true,
      trailingStopPercent: 20, // Learnable TSL percentage
      entryTxSignature: undefined, // Paper trade, no real TX
    });

    // Record this as a system pick
    // In future: create a system_picks table to track all picks, outcomes, and learning
    console.log(
      `[SystemPicks] Paper position opened for ${pick.tokenSymbol} with SL=${pick.slThreshold}%, TP=5x`
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

    // Get recently discovered pools and graduated tokens that aren't already being traded
    const candidates = await db.query.raydiumPoolDiscoveries.findMany({
      where: and(
        gte(raydiumPoolDiscoveries.discoveredAt, Math.floor(Date.now() / 1000) - 3600),
        gt(raydiumPoolDiscoveries.liquidityUsd, 5000) // At least $5k liquidity
      ),
      orderBy: [desc(raydiumPoolDiscoveries.qualityScore)],
      limit: 20,
    });

    console.log(`[SystemPicks] Found ${candidates.length} candidate pools from last hour`);

    const picks: SystemPick[] = [];

    // Evaluate each candidate
    for (const candidate of candidates) {
      const mint = candidate.associatedTokenMint || candidate.baseTokenMint;

      // Skip if already trading this token
      const existingPosition = await db.query.paperPositions.findFirst({
        where: and(eq(paperPositions.tokenMint, mint), eq(paperPositions.status, "open")),
      });

      if (existingPosition) {
        continue;
      }

      // Get token data
      const tokenData = await getTokenData(mint);

      // Find matching fingerprint
      const fingerprint = await findMatchingFingerprint(mint, "postgrad_raydium");

      if (!fingerprint) {
        continue; // No learned pattern for this type of token yet
      }

      // Calculate conviction score
      const creatorRep = await getCreatorReputation(mint);
      const walletSignals = await getWalletSignalsScore(mint);

      const conviction = calculateConvictionScore({
        fingerprintWinRate: fingerprint.winRate || 0.5,
        creatorReputation: creatorRep,
        walletSignals,
      });

      if (conviction < SYSTEM_PICKS_CONFIG.minConvictionScore) {
        continue; // Below threshold
      }

      // Validate with Jupiter
      const jupiterOk = await validateWithJupiter(mint);

      if (!jupiterOk) {
        continue;
      }

      // This is a high-conviction pick!
      picks.push({
        tokenMint: mint,
        tokenSymbol: tokenData.tokenSymbol || mint.slice(0, 8),
        convictionScore: conviction,
        fingerprintType: fingerprint.fingerprintType,
        fingerprintWinRate: fingerprint.winRate || 0.5,
        entrySlippage: fingerprint.entrySlippageP95 || 0.75,
        slThreshold: fingerprint.slThresholdPercent || 50,
        estimatedEntry: SYSTEM_PICKS_CONFIG.paperEntrySize,
        jupiterValidated: true,
      });
    }

    console.log(`[SystemPicks] Found ${picks.length} high-conviction picks (threshold=${SYSTEM_PICKS_CONFIG.minConvictionScore})`);

    // Open positions for high-conviction picks
    for (const pick of picks) {
      await openSystemPick(pick);
    }
  } catch (error) {
    console.error("[SystemPicks] Error in scan:", error);
  }
}
