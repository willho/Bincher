import { db } from "./db";
import { eq } from "drizzle-orm";
import { tokenDataPool, graduationEvents } from "@shared/schema";
import { getTokenData, upsertTokenData } from "./data-pool";
import { emit } from "./discovery-event-bus";
import { rpcProvider } from "./rpc-provider";
import { getParsedProgramAccounts } from "solders";

const RAYDIUM_LIQUIDITY_POOL_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const GRADUATION_POLL_INTERVAL_MS = 60000; // Poll every minute
const GRADUATION_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // Look back 24 hours

interface GraduatedToken {
  mint: string;
  symbol?: string;
  name?: string;
  graduationTime: number;
}

interface RaydiumPoolInfo {
  poolAddress: string;
  liquidityUsd: number;
  creatorAddress?: string;
  baseTokenMint: string;
  quoteTokenMint: string;
}

let lastGraduationCheck = 0;
let trackedGraduations = new Set<string>();

/**
 * Fetch newly graduated tokens from Moralis or Bitquery API
 * For now, we'll check for tokens that have pumpfunGraduated=true in our DB
 */
async function checkNewGraduations(): Promise<GraduatedToken[]> {
  try {
    // Query tokens that recently graduated (pumpfunGraduated=true but no graduationEvents entry)
    const recentGraduations = await db.query.tokenDataPool.findMany({
      where: (table, { sql, and, eq, isNull, gte }) =>
        and(
          eq(table.pumpfunGraduated, true),
          isNull(table.raydiumPoolAddress), // Not yet linked to Raydium pool
          gte(table.pumpfunGraduationTime, Math.floor(Date.now() / 1000) - GRADUATION_HISTORY_WINDOW_MS / 1000)
        ),
      columns: {
        tokenMint: true,
        tokenSymbol: true,
        tokenName: true,
        pumpfunGraduationTime: true,
      },
    });

    return recentGraduations.map((token) => ({
      mint: token.tokenMint,
      symbol: token.tokenSymbol || undefined,
      name: token.tokenName || undefined,
      graduationTime: token.pumpfunGraduationTime || 0,
    }));
  } catch (error) {
    console.error("[GraduationTracker] Error checking new graduations:", error);
    return [];
  }
}

/**
 * Find Raydium pool address for a token mint
 * Queries RPC for pool accounts containing this token
 */
async function findRaydiumPool(tokenMint: string): Promise<RaydiumPoolInfo | null> {
  try {
    const rpc = rpcProvider.getProvider();

    // Query for pool accounts that contain this token
    // This is a simplified approach - in production you'd want more sophisticated filtering
    const poolAccounts = await getParsedProgramAccounts(rpc, RAYDIUM_LIQUIDITY_POOL_V4, {
      filters: [
        {
          dataSize: 100, // Approximate size filter for pool accounts
        },
      ],
    });

    // For now, return null as the real implementation would require
    // more sophisticated pool discovery logic
    console.log(`[GraduationTracker] Found ${poolAccounts.length} pool candidates for ${tokenMint}`);
    return null;
  } catch (error) {
    console.error(`[GraduationTracker] Error finding Raydium pool for ${tokenMint}:`, error);
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
      await upsertTokenData(
        mint,
        {
          raydiumPoolAddress: poolInfo.poolAddress,
          raydiumLiquidityUsd: poolInfo.liquidityUsd,
          raydiumCreatorAddress: poolInfo.creatorAddress,
          poolOriginType: "pumpfun_graduated",
        },
        "graduation_tracker",
        undefined
      );

      // Create graduation event record
      await db.insert(graduationEvents).values({
        tokenMint: mint,
        graduationTime,
        destinationPoolAddress: poolInfo.poolAddress,
        timeToGraduation: graduationTime - (await getCreationTime(mint)),
        liquidityOnGraduation: poolInfo.liquidityUsd,
        learningExported: false,
        createdAt: now,
      });

      // Emit event to discovery bus
      await emit({
        type: "pumpfun_graduated" as any,
        tokenMint: mint,
        tokenSymbol: graduatedToken.symbol,
        source: "graduation_tracker",
        data: {
          poolAddress: poolInfo.poolAddress,
          liquidityUsd: poolInfo.liquidityUsd,
          creator: poolInfo.creatorAddress,
        },
        timestamp: now,
        urgency: 85, // High urgency - graduation is significant
      });

      trackedGraduations.add(mint);
    }
  } catch (error) {
    console.error(
      `[GraduationTracker] Error processing graduation for ${graduatedToken.mint}:`,
      error
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
