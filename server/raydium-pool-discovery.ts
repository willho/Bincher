import { db } from "./db";
import { eq, and, gte } from "drizzle-orm";
import { raydiumPoolDiscoveries, tokenDataPool } from "@shared/schema";
import { emit } from "./discovery-event-bus";
import axios, { AxiosInstance } from "axios";

const RAYDIUM_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

interface RpcEndpoint {
  url: string;
  name: string;
  lastError?: Error;
  consecutiveFailures: number;
}

interface PoolDiscoveryConfig {
  pollIntervalMs: number;
  requestsPerSecond: number;
  minLiquidityUsd: number;
  maxAgeMinutes: number;
}

const config: PoolDiscoveryConfig = {
  pollIntervalMs: 500, // 2 per second (500ms interval)
  requestsPerSecond: 2,
  minLiquidityUsd: 1000, // Only track pools with >$1000 liquidity
  maxAgeMinutes: 60, // Only look at pools created in last hour
};

const endpoints: RpcEndpoint[] = [
  {
    url: "https://api.mainnet.solana.com",
    name: "Solana Official",
    consecutiveFailures: 0,
  },
  {
    url: "https://free.rpcpool.com",
    name: "RPCPool Free",
    consecutiveFailures: 0,
  },
];

let currentEndpointIndex = 0;
let lastPollTime = 0;
let discoveredPools = new Set<string>();
let lastKnownSlot = 0;
let pollInterval: NodeJS.Timeout | null = null;

/**
 * Get next RPC endpoint with round-robin + fallback
 */
function getNextEndpoint(): RpcEndpoint {
  let attempts = 0;
  while (attempts < endpoints.length) {
    const endpoint = endpoints[currentEndpointIndex];
    currentEndpointIndex = (currentEndpointIndex + 1) % endpoints.length;

    if (endpoint.consecutiveFailures < 5) {
      return endpoint;
    }
    attempts++;
  }

  // If all failed, reset and return first
  endpoints.forEach((ep) => {
    ep.consecutiveFailures = 0;
  });
  return endpoints[0];
}

/**
 * Poll for new Raydium pools via RPC getProgramAccounts
 */
async function pollForNewPools(): Promise<void> {
  try {
    const endpoint = getNextEndpoint();
    const now = Math.floor(Date.now() / 1000);

    // Create axios instance with timeout
    const rpc = axios.create({
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    // Query getProgramAccounts for Raydium V4
    // This returns all accounts owned by the program
    const response = await rpc.post(endpoint.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "getProgramAccounts",
      params: [
        RAYDIUM_PROGRAM_ID,
        {
          encoding: "jsonParsed",
          filters: [
            {
              dataSize: 100, // Approximate size of pool account
            },
          ],
        },
      ],
    });

    if (response.data.error) {
      throw new Error(`RPC Error: ${response.data.error.message}`);
    }

    endpoint.consecutiveFailures = 0;

    const accounts = response.data.result || [];
    console.log(
      `[RaydiumDiscovery] Fetched ${accounts.length} pool accounts from ${endpoint.name}`
    );

    // Process accounts
    for (const account of accounts) {
      try {
        // Extract pool info from account data
        const poolAddress = account.pubkey;

        if (discoveredPools.has(poolAddress)) {
          continue; // Already tracked
        }

        // Check if already in database
        const existing = await db.query.raydiumPoolDiscoveries.findFirst({
          where: eq(raydiumPoolDiscoveries.poolAddress, poolAddress),
        });

        if (!existing) {
          // New pool discovered
          discoveredPools.add(poolAddress);

          // Try to extract token mints from parsed data
          const data = account.account.data;
          const baseToken = extractTokenFromData(data, 0);
          const quoteToken = extractTokenFromData(data, 1);

          if (baseToken && quoteToken) {
            // Store pool discovery
            const discovery = await db.insert(raydiumPoolDiscoveries).values({
              poolAddress,
              baseTokenMint: baseToken,
              quoteTokenMint: quoteToken,
              discoveredAt: now,
              sourceType: "rpc_scan",
              liquidityUsd: 0, // Would need to calculate from pool state
              lastUpdatedAt: now,
              isVerified: false,
              qualityScore: 0,
            });

            // Try to link to tokenDataPool
            const linkToToken = baseToken; // Use base token as primary
            const existingToken = await db.query.tokenDataPool.findFirst({
              where: eq(tokenDataPool.tokenMint, linkToToken),
            });

            // Emit discovery event
            await emit({
              type: "raydium_new_pool",
              tokenMint: linkToToken,
              source: "raydium_discovery",
              data: {
                poolAddress,
                baseToken,
                quoteToken,
                discovered: true,
              },
              timestamp: now,
              urgency: 70,
            });

            console.log(
              `[RaydiumDiscovery] New pool discovered: ${poolAddress} (${baseToken}/${quoteToken})`
            );
          }
        }
      } catch (error) {
        // Skip this account on error
        console.debug(`[RaydiumDiscovery] Error processing account:`, error);
      }
    }
  } catch (error) {
    const endpoint = endpoints[currentEndpointIndex];
    endpoint.consecutiveFailures++;

    console.error(`[RaydiumDiscovery] Poll error (${endpoint.name}):`, error instanceof Error ? error.message : error);

    // Implement exponential backoff
    if (endpoint.consecutiveFailures >= 3) {
      console.warn(`[RaydiumDiscovery] Endpoint ${endpoint.name} failing, switching...`);
      getNextEndpoint();
    }
  }

  lastPollTime = Date.now();
}

/**
 * Extract token mint from raw pool account data
 * This is a simplified version - real implementation would parse Raydium account structure
 */
function extractTokenFromData(data: any, index: number): string | null {
  try {
    if (typeof data === "string") {
      // Base64 encoded
      // In production, would decode and parse binary format
      return null;
    }

    if (data.parsed?.info) {
      const info = data.parsed.info;
      if (index === 0 && info.baseToken) return info.baseToken;
      if (index === 1 && info.quoteToken) return info.quoteToken;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Start the polling loop
 */
export async function startRaydiumPoolDiscovery(): Promise<void> {
  console.log("[RaydiumDiscovery] Starting Raydium pool discovery polling at 2 req/sec...");

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
  pollInterval = setInterval(pollForNewPools, config.pollIntervalMs);
}

/**
 * Stop the polling
 */
export function stopRaydiumPoolDiscovery(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
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
      orderBy: (pools, { desc }) => desc(pools.discoveredAt),
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
