// @ts-nocheck
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
  pollIntervalMs: 120000, // Poll GeckoTerminal every 120 seconds (0.5 req/sec, safe for free tier)
  minLiquidityUsd: 500, // Track pools with >$500 liquidity
  maxAgeMinutes: 60, // Only look at pools created in last hour
};

let discoveredPools = new Set<string>();
let lastPollTime = 0;
let pollInterval: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;

/**
 * Poll for new Solana pools via GeckoTerminal API
 * GeckoTerminal provides free access to new_pools endpoint with ~15-30s delay
 */
async function pollForNewPools(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Query GeckoTerminal for new Solana pools
    const response = await axios.get(
      "https://api.geckoterminal.com/api/v2/networks/solana/new_pools",
      {
        timeout: 10000,
        params: {
          include: "dex", // Include DEX info
          order: "created_at", // Order by creation time
        },
      }
    );

    if (!response.data?.data || response.data.data.length === 0) {
      console.log("[RaydiumDiscovery] No new pools from GeckoTerminal");
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures = 0;
    const pools = response.data.data;

    console.log(`[RaydiumDiscovery] Found ${pools.length} new pools from GeckoTerminal`);

    // Process each pool
    for (const pool of pools) {
      try {
        const poolAddress = pool.attributes?.address;
        if (!poolAddress) continue;

        // Skip if already tracked
        if (discoveredPools.has(poolAddress)) {
          continue;
        }

        // Extract token mints from the pool
        const baseToken = pool.relationships?.base_token?.data?.id;
        const quoteToken = pool.relationships?.quote_token?.data?.id;

        if (!baseToken || !quoteToken) {
          continue;
        }

        // Extract liquidity info
        const liquidity = pool.attributes?.reserve_in_usd || 0;

        // Skip pools below minimum liquidity
        if (liquidity < config.minLiquidityUsd) {
          continue;
        }

        // Check if pool is too old
        const createdAt = pool.attributes?.created_at;
        const poolAge = createdAt
          ? (now - Math.floor(new Date(createdAt).getTime() / 1000)) / 60
          : 0;

        if (poolAge > config.maxAgeMinutes) {
          continue;
        }

        discoveredPools.add(poolAddress);

        // Store pool discovery
        const dexId = pool.relationships?.dex?.data?.id || "unknown";

        await db
          .insert(raydiumPoolDiscoveries)
          .values({
            poolAddress,
            baseTokenMint: baseToken,
            quoteTokenMint: quoteToken,
            discoveredAt: now,
            sourceType: "rpc_scan",
            liquidityUsd: liquidity,
            lastUpdatedAt: now,
            isVerified: false,
            qualityScore: 0,
          })
          .onConflictDoNothing(); // Ignore if already exists

        // Try to link to tokenDataPool if we can identify the token
        // Use base token as primary token link
        const existingToken = await db.query.tokenDataPool.findFirst({
          where: eq(tokenDataPool.tokenMint, baseToken),
          limit: 1,
        });

        // Emit discovery event
        await emit({
          type: "raydium_new_pool",
          tokenMint: baseToken,
          source: "raydium_discovery",
          data: {
            poolAddress,
            baseToken,
            quoteToken,
            dexId,
            liquidityUsd: liquidity,
            poolAgeMinutes: poolAge,
          },
          timestamp: now,
          urgency: 65,
        });

        console.log(
          `[RaydiumDiscovery] New pool discovered: ${poolAddress} (${baseToken}/${quoteToken}, $${liquidity})`
        );
      } catch (error) {
        // Skip this pool on error
        console.debug(
          `[RaydiumDiscovery] Error processing pool:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  } catch (error) {
    consecutiveFailures++;
    console.error(
      `[RaydiumDiscovery] Poll error (failures: ${consecutiveFailures}):`,
      error instanceof Error ? error.message : error
    );

    if (consecutiveFailures >= 5) {
      console.warn("[RaydiumDiscovery] Too many consecutive failures, backing off...");
    }
  }

  lastPollTime = Date.now();
}

/**
 * Start the polling loop
 */
export async function startRaydiumPoolDiscovery(): Promise<void> {
  console.log(
    "[RaydiumDiscovery] Starting Raydium pool discovery via GeckoTerminal (30s interval)..."
  );

  // Load existing pools to avoid re-processing
  try {
    const existing = await db.query.raydiumPoolDiscoveries.findMany({
      columns: { poolAddress: true },
    });
    existing.forEach((p) => discoveredPools.add(p.poolAddress));
    console.log(`[RaydiumDiscovery] Loaded ${existing.length} known pools`);
  } catch (error) {
    console.error("[RaydiumDiscovery] Error loading existing pools:", error);
  }

  // Initial poll
  await pollForNewPools();

  // Set up polling with configured interval
  // Exponential backoff if failures
  const getInterval = () => {
    if (consecutiveFailures >= 5) {
      return config.pollIntervalMs * 5; // Back off to 2.5 minutes
    }
    return config.pollIntervalMs;
  };

  const scheduleNextPoll = () => {
    const interval = getInterval();
    pollInterval = setTimeout(() => {
      pollForNewPools().then(scheduleNextPoll).catch((error) => {
        console.error("[RaydiumDiscovery] Unhandled error in poll loop:", error);
        scheduleNextPoll();
      });
    }, interval);
  };

  scheduleNextPoll();
}

/**
 * Stop the polling
 */
export function stopRaydiumPoolDiscovery(): void {
  if (pollInterval) {
    clearTimeout(pollInterval);
    pollInterval = null;
    console.log("[RaydiumDiscovery] Stopped pool discovery");
  }
}

/**
 * Get recent pool discoveries
 */
export async function getRecentPools(limitMinutes: number = 10) {
  try {
    const cutoffTime = Math.floor((Date.now() - limitMinutes * 60 * 1000) / 1000);

    return await db.query.raydiumPoolDiscoveries.findMany({
      where: gte(raydiumPoolDiscoveries.discoveredAt, cutoffTime),
      orderBy: [desc(raydiumPoolDiscoveries.discoveredAt)],
      limit: 100,
    });
  } catch (error) {
    console.error("[RaydiumDiscovery] Error fetching recent pools:", error);
    return [];
  }
}

/**
 * Get pool info including quality score
 */
export async function getPoolInfo(poolAddress: string) {
  try {
    return await db.query.raydiumPoolDiscoveries.findFirst({
      where: eq(raydiumPoolDiscoveries.poolAddress, poolAddress),
    });
  } catch (error) {
    console.error(`[RaydiumDiscovery] Error fetching pool ${poolAddress}:`, error);
    return null;
  }
}
