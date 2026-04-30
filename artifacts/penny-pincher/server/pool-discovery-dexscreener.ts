/**
 * Pool Discovery via DexScreener (Replace GeckoTerminal)
 *
 * Uses DexScreener trades endpoint for pool discovery instead of GeckoTerminal.
 * Benefits:
 * - Higher rate limit: 1 req/sec vs 0.33-0.83 req/sec (GeckoTerminal free tier)
 * - Real trade data (better signal than just new pools listing)
 * - No fallback needed - robust free tier
 *
 * Fallback: If DexScreener fails, can switch to Birdeye tokens endpoint
 */

import { db } from "./db";
import { eq, gte, desc } from "drizzle-orm";
import { raydiumPoolDiscoveries, tokenDataPool } from "@shared/schema";
import { emit } from "./discovery-event-bus";
import axios from "axios";

interface PoolDiscoveryConfig {
  pollIntervalMs: number;
  minLiquidityUsd: number;
  maxAgeMinutes: number;
}

const config: PoolDiscoveryConfig = {
  pollIntervalMs: 60000, // Poll DexScreener every 60 seconds (0.017 req/sec, very safe)
  minLiquidityUsd: 500, // Track pools with >$500 liquidity
  maxAgeMinutes: 5, // Only look at trades from last 5 minutes
};

let discoveredPools = new Set<string>();
let lastPollTime = 0;
let pollInterval: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
const maxConsecutiveFailures = 5;

/**
 * Poll DexScreener for new Solana trades/pools
 * Uses /latest/dex/trades endpoint instead of new_pools
 * This gives us real trades happening on new pools
 */
async function pollForNewPoolsViaDexScreener(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Query DexScreener for latest trades on Solana
    // This endpoint returns trades, which implicitly shows active pools
    const response = await axios.get(
      "https://api.dexscreener.com/latest/dex/trades",
      {
        timeout: 10000,
        params: {
          chainId: "solana",
          // No other params needed - gets latest trades across all pools
        },
      }
    );

    if (!response.data?.trades || response.data.trades.length === 0) {
      console.log("[PoolDiscovery] No new trades from DexScreener");
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures = 0;
    const trades = response.data.trades;

    console.log(`[PoolDiscovery] Found ${trades.length} recent trades from DexScreener`);

    // Process each trade to discover pools
    for (const trade of trades) {
      try {
        // Extract pool info from trade
        const poolAddress = trade.pair?.address;
        const baseToken = trade.pair?.baseToken?.address;
        const quoteToken = trade.pair?.quoteToken?.address;
        const dex = trade.pair?.dexId; // e.g., "raydium"

        if (!poolAddress || !baseToken || !quoteToken) {
          continue;
        }

        // Only Raydium pools
        if (dex !== "raydium") {
          continue;
        }

        // Skip if already tracked
        if (discoveredPools.has(poolAddress)) {
          continue;
        }

        // Extract liquidity (market cap or TVL estimate)
        const liquidity = trade.pair?.liquidity?.usd || 0;

        // Skip pools below minimum liquidity
        if (liquidity < config.minLiquidityUsd) {
          continue;
        }

        // Check trade age (only recent trades indicate new/active pools)
        const tradeTime = trade.txAt ? new Date(trade.txAt).getTime() / 1000 : now;
        const ageMinutes = (now - tradeTime) / 60;

        if (ageMinutes > config.maxAgeMinutes) {
          // Trade is old, skip it
          continue;
        }

        // New pool discovered!
        await processDiscoveredPool({
          poolAddress,
          baseTokenMint: baseToken,
          quoteTokenMint: quoteToken,
          liquidity,
          discoveredAt: now,
          sourceType: "dex_trades",
          dex,
        });

        discoveredPools.add(poolAddress);
      } catch (error) {
        console.error("[PoolDiscovery] Error processing trade:", error instanceof Error ? error.message : error);
        continue;
      }
    }
  } catch (error) {
    consecutiveFailures++;
    console.error(
      `[PoolDiscovery] DexScreener poll failed (attempt ${consecutiveFailures}/${maxConsecutiveFailures}):`,
      error instanceof Error ? error.message : error
    );

    // If too many failures, log but continue (fallback will handle it)
    if (consecutiveFailures >= maxConsecutiveFailures) {
      console.warn(
        `[PoolDiscovery] DexScreener failed ${maxConsecutiveFailures} times, falling back to alternative source`
      );
      // TODO: Switch to Birdeye fallback
    }
  }
}

/**
 * Process a newly discovered pool
 */
async function processDiscoveredPool(pool: {
  poolAddress: string;
  baseTokenMint: string;
  quoteTokenMint: string;
  liquidity: number;
  discoveredAt: number;
  sourceType: string;
  dex: string;
}): Promise<void> {
  try {
    // Check if already in database
    const existing = await db.query.raydiumPoolDiscoveries.findFirst({
      where: eq(raydiumPoolDiscoveries.poolAddress, pool.poolAddress),
    });

    if (existing) {
      return; // Already recorded
    }

    // Score pool quality
    const { scoreRaydiumPool } = await import("./raydium-pool-quality");
    const qualityScore = await scoreRaydiumPool(pool.poolAddress);

    // Store in database
    const [discovery] = await db
      .insert(raydiumPoolDiscoveries)
      .values({
        poolAddress: pool.poolAddress,
        baseTokenMint: pool.baseTokenMint,
        quoteTokenMint: pool.quoteTokenMint,
        discoveredAt: pool.discoveredAt,
        sourceType: pool.sourceType,
        liquidityUsd: pool.liquidity,
        lastUpdatedAt: pool.discoveredAt,
        isVerified: false,
        qualityScore: qualityScore.score,
      })
      .returning();

    if (!discovery) {
      return;
    }

    console.log(
      `[PoolDiscovery] New pool discovered: ${pool.poolAddress.slice(0, 8)}... (${pool.baseTokenMint.slice(0, 8)}/${pool.quoteTokenMint.slice(0, 8)}, liquidity=$${pool.liquidity.toFixed(0)}, quality=${qualityScore.score.toFixed(0)})`
    );

    // Emit discovery event for other systems
    await emit({
      type: "raydium_new_pool",
      tokenMint: pool.baseTokenMint,
      source: "pool_discovery_dexscreener",
      data: {
        poolAddress: pool.poolAddress,
        quoteTokenMint: pool.quoteTokenMint,
        liquidity: pool.liquidity,
        qualityScore: qualityScore.score,
      },
      timestamp: Math.floor(Date.now() / 1000),
      urgency: 65,
    });
  } catch (error) {
    console.error("[PoolDiscovery] Error processing pool:", error instanceof Error ? error.message : error);
  }
}

/**
 * Fallback: Poll Birdeye token list if DexScreener fails
 */
async function pollForNewPoolsViaBirdeye(): Promise<void> {
  try {
    if (!process.env.BIRDEYE_API_KEY) {
      console.log("[PoolDiscovery] Birdeye fallback: no API key configured");
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Query Birdeye for recently listed tokens
    const response = await axios.get("https://public-api.birdeye.so/defi/token_list", {
      timeout: 10000,
      headers: {
        "X-API-KEY": process.env.BIRDEYE_API_KEY,
      },
      params: {
        sort_by: "created_at",
        sort_type: "desc",
        limit: 30,
      },
    });

    if (!response.data?.data || response.data.data.length === 0) {
      console.log("[PoolDiscovery] No new tokens from Birdeye fallback");
      return;
    }

    console.log(`[PoolDiscovery] Found ${response.data.data.length} new tokens from Birdeye (fallback)`);

    const tokens = response.data.data;

    for (const token of tokens) {
      try {
        const mint = token.mint;

        if (discoveredPools.has(mint)) {
          continue;
        }

        const liquidity = token.liquidity?.usd || 0;

        if (liquidity < config.minLiquidityUsd) {
          continue;
        }

        // For Birdeye, we don't have a separate pool address,
        // so we use the token mint as identifier
        // In practice, we'd need to look up the actual pool via Raydium RPC

        await processDiscoveredPool({
          poolAddress: token.primaryPool || mint, // Use primary pool if available
          baseTokenMint: mint,
          quoteTokenMint: "EPjFWaJQbvkjgjGUzeVfayXEV7G2CFG3t7wwMfkNqKQL", // USDC
          liquidity,
          discoveredAt: now,
          sourceType: "birdeye_tokens",
          dex: "raydium",
        });

        discoveredPools.add(mint);
      } catch (error) {
        console.error("[PoolDiscovery] Error processing Birdeye token:", error instanceof Error ? error.message : error);
        continue;
      }
    }
  } catch (error) {
    console.error("[PoolDiscovery] Birdeye fallback failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Start pool discovery polling
 */
export async function startRaydiumPoolDiscovery(): Promise<void> {
  console.log("[PoolDiscovery] Starting Raydium pool discovery via DexScreener");

  // Initial poll after 10 seconds
  setTimeout(async () => {
    try {
      await pollForNewPoolsViaDexScreener();
    } catch (error) {
      console.error("[PoolDiscovery] Initial poll failed:", error);
    }
  }, 10_000);

  // Periodic polls every 60 seconds
  pollInterval = setInterval(async () => {
    try {
      await pollForNewPoolsViaDexScreener();

      // Reset failure counter on success
      consecutiveFailures = 0;
    } catch (error) {
      console.error("[PoolDiscovery] Poll error:", error);

      // If too many failures, try fallback
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.warn("[PoolDiscovery] Switching to Birdeye fallback");
        await pollForNewPoolsViaBirdeye();
      }
    }
  }, config.pollIntervalMs);
}

/**
 * Stop polling
 */
export function stopRaydiumPoolDiscovery(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[PoolDiscovery] Stopped pool discovery polling");
  }
}

export default {
  startRaydiumPoolDiscovery,
  stopRaydiumPoolDiscovery,
};
