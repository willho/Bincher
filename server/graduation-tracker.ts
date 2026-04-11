import { db } from "./db";
import { eq, isNull, and, gte } from "drizzle-orm";
import { tokenDataPool, graduationEvents } from "@shared/schema";
import { getTokenData, upsertTokenData, fetchTokenWithFallback } from "./data-pool";
import { emit } from "./discovery-event-bus";
import axios from "axios";

const GRADUATION_POLL_INTERVAL_MS = 60000; // Poll every minute
const GRADUATION_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // Look back 24 hours

interface GraduatedToken {
  mint: string;
  symbol?: string;
  name?: string;
  graduationTime: number;
}

interface RaydiumPoolInfo {
  address: string;
  baseToken: string;
  quoteToken: string;
  liquidity?: number;
}

let lastGraduationCheck = 0;
let trackedGraduations = new Set<string>();

/**
 * Fetch newly graduated tokens from tokenDataPool
 * Check for tokens that have pumpfunGraduated=true but no raydiumPoolAddress linked yet
 */
async function checkNewGraduations(): Promise<GraduatedToken[]> {
  try {
    const cutoffTime = Math.floor(Date.now() / 1000) - GRADUATION_HISTORY_WINDOW_MS / 1000;

    // Query tokens that recently graduated
    const recentGraduations = await db.query.tokenDataPool.findMany({
      where: and(
        eq(tokenDataPool.pumpfunGraduated, true),
        isNull(tokenDataPool.raydiumPoolAddress), // Not yet linked to Raydium pool
        gte(tokenDataPool.pumpfunGraduationTime, cutoffTime)
      ),
      columns: {
        tokenMint: true,
        tokenSymbol: true,
        tokenName: true,
        pumpfunGraduationTime: true,
      },
      limit: 50, // Process up to 50 per check
    });

    return recentGraduations.map((token) => ({
      mint: token.tokenMint,
      symbol: token.tokenSymbol || undefined,
      name: token.tokenName || undefined,
      graduationTime: token.pumpfunGraduationTime || 0,
    }));
  } catch (error) {
    console.error(
      "[GraduationTracker] Error checking new graduations:",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

/**
 * Find Raydium pool address for a token mint via DexScreener API
 */
async function findRaydiumPool(tokenMint: string): Promise<RaydiumPoolInfo | null> {
  try {
    // Query DexScreener for pools containing this token on Raydium
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 5000 }
    );

    if (!response.data?.pairs || response.data.pairs.length === 0) {
      return null;
    }

    // Find Raydium pools (filter by dexId)
    const raydiumPools = response.data.pairs.filter(
      (pair: any) => pair.dexId === "raydium" && pair.chainId === "solana"
    );

    if (raydiumPools.length === 0) {
      return null;
    }

    // Use the first Raydium pool found
    const pool = raydiumPools[0];

    return {
      address: pool.pairAddress,
      baseToken: pool.baseToken?.address || "",
      quoteToken: pool.quoteToken?.address || "",
      liquidity: pool.liquidity?.usd,
    };
  } catch (error) {
    console.error(
      `[GraduationTracker] Error finding Raydium pool for ${tokenMint}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Process a newly graduated token
 */
async function processGraduation(graduatedToken: GraduatedToken): Promise<void> {
  try {
    const { mint, graduationTime } = graduatedToken;
    const now = Math.floor(Date.now() / 1000);

    // Check if already processed
    if (trackedGraduations.has(mint)) {
      return;
    }

    // Try to find Raydium pool
    const poolInfo = await findRaydiumPool(mint);

    if (poolInfo) {
      // Update tokenDataPool with Raydium info
      const updateData: any = {
        raydiumPoolAddress: poolInfo.address,
        raydiumPoolDiscoveredAt: now,
        poolOriginType: "pumpfun_graduated",
      };

      if (poolInfo.liquidity) {
        updateData.raydiumLiquidityUsd = poolInfo.liquidity;
      }

      await upsertTokenData(mint, updateData, "graduation_tracker");

      // Create graduation event record
      const creationTime = await getCreationTime(mint);
      await db.insert(graduationEvents).values({
        tokenMint: mint,
        graduationTime,
        destinationPoolAddress: poolInfo.address,
        timeToGraduation: graduationTime - creationTime,
        liquidityOnGraduation: poolInfo.liquidity || 0,
        learningExported: false,
        createdAt: now,
      });

      // Emit event to discovery bus
      await emit({
        type: "pumpfun_graduated",
        tokenMint: mint,
        tokenSymbol: graduatedToken.symbol,
        source: "graduation_tracker",
        data: {
          poolAddress: poolInfo.address,
          baseToken: poolInfo.baseToken,
          quoteToken: poolInfo.quoteToken,
          liquidityUsd: poolInfo.liquidity,
        },
        timestamp: now,
        urgency: 85, // High urgency - graduation is significant
      });

      console.log(
        `[GraduationTracker] Processed graduation: ${mint} → ${poolInfo.address}`
      );
      trackedGraduations.add(mint);
    } else {
      console.warn(`[GraduationTracker] Could not find Raydium pool for ${mint}`);
    }
  } catch (error) {
    console.error(
      `[GraduationTracker] Error processing graduation for ${graduatedToken.mint}:`,
      error instanceof Error ? error.message : error
    );
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
 * Main polling loop for graduation tracking
 */
export async function startGraduationTracking(): Promise<void> {
  console.log("[GraduationTracker] Starting graduation tracking...");

  // Initial check
  await performGraduationCheck();

  // Set up periodic checks
  setInterval(performGraduationCheck, GRADUATION_POLL_INTERVAL_MS);
}

async function performGraduationCheck(): Promise<void> {
  try {
    const now = Date.now();

    // Skip if checking too frequently
    if (now - lastGraduationCheck < GRADUATION_POLL_INTERVAL_MS / 2) {
      return;
    }

    lastGraduationCheck = now;

    const newGraduations = await checkNewGraduations();
    console.log(
      `[GraduationTracker] Found ${newGraduations.length} new graduations to process`
    );

    for (const graduation of newGraduations) {
      await processGraduation(graduation);
    }
  } catch (error) {
    console.error("[GraduationTracker] Error in graduation check:", error);
  }
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
