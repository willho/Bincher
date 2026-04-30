// @ts-nocheck
/**
 * Pump.fun Graduation Tracker - Event Handler
 * Processes tokens when they graduate from bonding curve
 * Detection is done by SDK checks in discovery-engine.ts
 */

import { db } from "./db";
import { eq } from "drizzle-orm";
import { tokenDataPool, graduationEvents } from "@shared/schema";
import { getTokenData, upsertTokenData } from "./data-pool";
import { emit } from "./discovery-event-bus";
import { canMakeApiCall } from "./api-rate-limits";
import axios from "axios";

interface PumpSwapPoolInfo {
  address: string;
  baseToken: string;
  quoteToken: string;
  liquidity?: number;
}

let processedGraduations = new Set<string>();

/**
 * Find PumpSwap pool address for a graduated token via DexScreener API
 * Token mint stays the same, but liquidity moves to PumpSwap
 */
async function findPumpSwapPool(tokenMint: string): Promise<PumpSwapPoolInfo | null> {
  try {
    const rateCheck = canMakeApiCall("dexScreener", 1);
    if (!rateCheck.allowed) {
      console.warn(`[GraduationTracker] Rate limit hit for DexScreener: ${rateCheck.reason}`);
      return null;
    }

    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 5000 }
    );

    if (!response.data?.pairs || response.data.pairs.length === 0) {
      return null;
    }

    // Look for PumpSwap pools first, then fall back to Raydium (for transition period)
    const pumpswapPools = response.data.pairs.filter(
      (pair: any) => pair.dexId === "pumpswap" && pair.chainId === "solana"
    );

    const poolsToCheck = pumpswapPools.length > 0 ? pumpswapPools : response.data.pairs.filter(
      (pair: any) => (pair.dexId === "pumpswap" || pair.dexId === "raydium") && pair.chainId === "solana"
    );

    if (poolsToCheck.length === 0) {
      return null;
    }

    const pool = poolsToCheck[0];

    return {
      address: pool.pairAddress,
      baseToken: pool.baseToken?.address || "",
      quoteToken: pool.quoteToken?.address || "",
      liquidity: pool.liquidity?.usd,
    };
  } catch (error) {
    console.error(
      `[GraduationTracker] Error finding pool for ${tokenMint}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Get approximate token creation time from tokenDataPool
 */
async function getCreationTime(mint: string): Promise<number> {
  try {
    const token = await getTokenData(mint);
    return token?.pairCreatedAt || Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

/**
 * Handle token graduation event
 * Called when SDK detects isGraduated=true
 */
export async function handleGraduation(mint: string): Promise<void> {
  try {
    // Avoid duplicate processing
    if (processedGraduations.has(mint)) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    console.log(`[GraduationTracker] Processing graduation for ${mint}`);

    // Get token data for symbol/name
    const tokenData = await getTokenData(mint);
    if (!tokenData) {
      console.warn(`[GraduationTracker] No token data found for ${mint}`);
      return;
    }

    // Find pool address
    const poolInfo = await findPumpSwapPool(mint);
    if (!poolInfo) {
      console.warn(`[GraduationTracker] Could not find pool for ${mint}`);
      return;
    }

    // Mark in DB as graduated
    await upsertTokenData(mint, {
      pumpfunGraduated: true,
      pumpfunGraduationTime: now,
      raydiumPoolAddress: poolInfo.address,
      raydiumPoolDiscoveredAt: now,
      poolOriginType: "pumpfun_graduated",
      raydiumLiquidityUsd: poolInfo.liquidity,
    }, "graduation_tracker");

    // Create graduation event record
    const creationTime = await getCreationTime(mint);
    await db.insert(graduationEvents).values({
      tokenMint: mint,
      graduationTime: now,
      destinationPoolAddress: poolInfo.address,
      timeToGraduation: now - creationTime,
      liquidityOnGraduation: poolInfo.liquidity || 0,
      learningExported: false,
      createdAt: now,
    });

    // Emit graduation event
    await emit({
      type: "pumpfun_graduated",
      tokenMint: mint,
      tokenSymbol: tokenData.tokenSymbol,
      source: "graduation_tracker",
      data: {
        poolAddress: poolInfo.address,
        baseToken: poolInfo.baseToken,
        quoteToken: poolInfo.quoteToken,
        liquidityUsd: poolInfo.liquidity,
      },
      timestamp: now,
      urgency: 85, // High urgency
    });

    processedGraduations.add(mint);
    console.log(`[GraduationTracker] ✓ Graduated ${mint} → ${poolInfo.address}`);
  } catch (error) {
    console.error(
      `[GraduationTracker] Error handling graduation for ${mint}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Initialize graduation tracking (minimal - handler is now event-driven)
 */
export async function startGraduationTracking(): Promise<void> {
  console.log("[GraduationTracker] Initialized (event-driven mode)");
  // Graduation detection happens in discovery-engine.ts
  // This module just handles the processing
}

/**
 * Get graduation status for a token
 */
export async function getGraduationStatus(tokenMint: string) {
  try {
    const event = await db.query.graduationEvents.findFirst({
      where: eq(graduationEvents.tokenMint, tokenMint),
    });

    return event || null;
  } catch (error) {
    console.error(`[GraduationTracker] Error getting graduation status for ${tokenMint}:`, error);
    return null;
  }
}
