/**
 * Monitored Pool Manager
 *
 * Maintains a 1900-token monitoring pool ranked by composite score
 * - Adds newly discovered high-scoring tokens
 * - Evicts low-scoring tokens when pool is full
 * - Supports wallet smart-money triggers for pool re-evaluation
 * - Auto-optimizes wallet voting threshold via retrolearner
 *
 * Architecture:
 * - Pool size: 1900 tokens (target), 2000 max (buffer)
 * - Ranking: Composite score (ANN × expected multiplier)
 * - Eviction: Volume-based + score-based (low volume + low score = first out)
 * - Entry trigger: New token exceeds ANN threshold OR wallet voting threshold
 * - Wallet voting: 0.5 SOL accumulation triggers token evaluation
 */

import { db } from "./db";
import { eq, and, gte, lte, desc, asc } from "drizzle-orm";
import { tokenDataPool, walletFingerprintDiscovery } from "@shared/schema";
import { calculateCompositeScore, getExpectedMultiplier, getTokensToEvict } from "./token-composite-scoring";
import { predictTokenSuccess } from "./token-success-ann";

const POOL_TARGET_SIZE = 1900;
const POOL_MAX_SIZE = 2000;
const VOLUME_THRESHOLD_24H = 1000; // SOL minimum for staying in pool
const WALLET_VOTE_THRESHOLD_SOL = 0.5; // SOL spent on token to trigger evaluation

/**
 * Pool state for monitoring
 */
export interface PoolState {
  currentSize: number;
  tier1Count: number; // Elite tokens
  tier2Count: number; // Standard tokens
  tier3Count: number; // Secondary tokens
  tier4Count: number; // Low priority
  lastUpdated: number;
  evictionCandidates: Array<{ mint: string; reason: string; score: number }>;
}

/**
 * Add a newly discovered token to pool if it qualifies
 *
 * Entry criteria:
 * - ANN score > 0.50 (50% confidence minimum)
 * - OR wallet smart-money trigger
 * - Pool size < 2000 (always add if room)
 * - Otherwise, replace lowest-scoring token if new score higher
 */
export async function considerTokenForPool(
  mint: string,
  annScore: number,
  reason: "discovery" | "wallet_signal" = "discovery"
): Promise<{ added: boolean; evicted?: string; reason: string }> {
  try {
    // Get current pool state
    const poolTokens = await db.query.tokenDataPool.findMany({
      where: eq(tokenDataPool.isMonitored, true),
    });

    const currentPoolSize = poolTokens.length;

    // Check if already in pool
    if (poolTokens.some((t) => t.tokenMint === mint)) {
      return { added: false, reason: "Already in pool" };
    }

    // Entry criteria
    if (annScore < 0.5 && reason !== "wallet_signal") {
      return { added: false, reason: `ANN score ${annScore.toFixed(2)} < 0.5 minimum` };
    }

    // Calculate composite score
    const expectedMultiplier = await getExpectedMultiplier(mint);
    const compositeScore = calculateCompositeScore(annScore, expectedMultiplier);

    // If pool has room, always add
    if (currentPoolSize < POOL_MAX_SIZE) {
      await db
        .update(tokenDataPool)
        .set({
          isMonitored: true,
          lastAnnScore: annScore,
          compositeScore: compositeScore,
          addedToPoolAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(tokenDataPool.tokenMint, mint));

      return {
        added: true,
        reason: `Added to pool (slot available, score ${compositeScore.toFixed(2)})`,
      };
    }

    // Pool is full: check if we should evict lowest-scoring token
    const lowestToken = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.isMonitored, true),
      orderBy: [asc(tokenDataPool.compositeScore ?? 0)],
    });

    if (!lowestToken) {
      return { added: false, reason: "Pool full, cannot determine eviction candidate" };
    }

    if (compositeScore > (lowestToken.compositeScore ?? 0)) {
      // Evict lowest-scoring token
      await db
        .update(tokenDataPool)
        .set({ isMonitored: false, evictedFromPoolAt: Math.floor(Date.now() / 1000) })
        .where(eq(tokenDataPool.tokenMint, lowestToken.tokenMint));

      // Add new token
      await db
        .update(tokenDataPool)
        .set({
          isMonitored: true,
          lastAnnScore: annScore,
          compositeScore: compositeScore,
          addedToPoolAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(tokenDataPool.tokenMint, mint));

      return {
        added: true,
        evicted: lowestToken.tokenMint,
        reason: `Evicted ${lowestToken.tokenMint} (score ${(lowestToken.compositeScore ?? 0).toFixed(2)}) for ${mint} (score ${compositeScore.toFixed(2)})`,
      };
    }

    return {
      added: false,
      reason: `Score ${compositeScore.toFixed(2)} lower than pool minimum ${(lowestToken.compositeScore ?? 0).toFixed(2)}`,
    };
  } catch (error) {
    console.error(`[PoolManager] Error considering token ${mint}:`, error);
    return { added: false, reason: `Error: ${(error as Error).message}` };
  }
}

/**
 * Remove low-volume tokens from pool
 * Tokens with <1000 SOL 24h volume are dropped to make room for active tokens
 */
export async function evictZeroVolumeTokens(): Promise<{ evicted: number; tokens: string[] }> {
  try {
    const evicted: string[] = [];

    const poolTokens = await db.query.tokenDataPool.findMany({
      where: eq(tokenDataPool.isMonitored, true),
    });

    for (const token of poolTokens) {
      const volume24h = token.volume24hSol ?? 0;

      if (volume24h < VOLUME_THRESHOLD_24H) {
        await db
          .update(tokenDataPool)
          .set({
            isMonitored: false,
            evictedFromPoolAt: Math.floor(Date.now() / 1000),
            evictionReason: "zero_volume",
          })
          .where(eq(tokenDataPool.tokenMint, token.tokenMint));

        evicted.push(token.tokenMint);
      }
    }

    if (evicted.length > 0) {
      console.log(`[PoolManager] Evicted ${evicted.length} zero-volume tokens`);
    }

    return { evicted: evicted.length, tokens: evicted };
  } catch (error) {
    console.error("[PoolManager] Error evicting zero-volume tokens:", error);
    return { evicted: 0, tokens: [] };
  }
}

/**
 * Handle wallet smart-money signal
 * When wallet spends 0.5 SOL on a token, evaluate it for pool entry
 *
 * @param tokenMint - Token being traded
 * @param walletAddress - Wallet making the trade
 * @param solSpent - SOL value of trade
 */
export async function handleWalletSmartMoneySignal(
  tokenMint: string,
  walletAddress: string,
  solSpent: number
): Promise<{ action: string; poolChange?: boolean }> {
  try {
    // Check if this wallet has accumulated 0.5 SOL on this token
    const walletHistory = await db.query.walletFingerprintDiscovery.findFirst({
      where: and(
        eq(walletFingerprintDiscovery.walletAddress, walletAddress),
        eq(walletFingerprintDiscovery.tokenMint, tokenMint)
      ),
    });

    const totalSpent = (walletHistory?.totalInvestmentSol ?? 0) + solSpent;

    // If threshold reached, trigger token evaluation
    if (totalSpent >= WALLET_VOTE_THRESHOLD_SOL && !walletHistory?.evaluationTriggeredAt) {
      console.log(
        `[PoolManager] Smart-money signal: ${walletAddress.slice(0, 8)}... spent ${totalSpent.toFixed(2)} SOL on ${tokenMint.slice(0, 16)}...`
      );

      // Evaluate token for pool entry
      const annScore = await predictTokenSuccess(tokenMint, Math.floor(Date.now() / 1000) - 600); // ~10 min old
      const result = await considerTokenForPool(tokenMint, annScore, "wallet_signal");

      return {
        action: `Wallet signal triggered (${totalSpent.toFixed(2)} SOL spent)`,
        poolChange: result.added,
      };
    }

    return { action: "Wallet signal detected but below threshold" };
  } catch (error) {
    console.error(`[PoolManager] Error handling wallet signal:`, error);
    return { action: `Error: ${(error as Error).message}` };
  }
}

/**
 * Get current pool status
 */
export async function getPoolStatus(): Promise<PoolState> {
  try {
    const poolTokens = await db.query.tokenDataPool.findMany({
      where: eq(tokenDataPool.isMonitored, true),
    });

    const tier1 = poolTokens.filter((t) => (t.compositeScore ?? 0) >= 5.0).length;
    const tier2 = poolTokens.filter((t) => (t.compositeScore ?? 0) >= 2.0 && (t.compositeScore ?? 0) < 5.0).length;
    const tier3 = poolTokens.filter((t) => (t.compositeScore ?? 0) >= 0.5 && (t.compositeScore ?? 0) < 2.0).length;
    const tier4 = poolTokens.filter((t) => (t.compositeScore ?? 0) < 0.5).length;

    // Get eviction candidates (lowest 10 scores + zero-volume tokens)
    const candidates = poolTokens
      .sort((a, b) => (a.compositeScore ?? 0) - (b.compositeScore ?? 0))
      .slice(0, 10)
      .map((t) => ({
        mint: t.tokenMint,
        reason: (t.volume24hSol ?? 0) < 100 ? "zero_volume" : "low_score",
        score: t.compositeScore ?? 0,
      }));

    return {
      currentSize: poolTokens.length,
      tier1Count: tier1,
      tier2Count: tier2,
      tier3Count: tier3,
      tier4Count: tier4,
      lastUpdated: Math.floor(Date.now() / 1000),
      evictionCandidates: candidates,
    };
  } catch (error) {
    console.error("[PoolManager] Error getting pool status:", error);
    return {
      currentSize: 0,
      tier1Count: 0,
      tier2Count: 0,
      tier3Count: 0,
      tier4Count: 0,
      lastUpdated: 0,
      evictionCandidates: [],
    };
  }
}

/**
 * Periodic maintenance task (run every 5 minutes)
 * - Remove zero-volume tokens to make room for active ones
 * - Log pool statistics
 */
export async function performPoolMaintenance(): Promise<void> {
  try {
    const status = await getPoolStatus();

    console.log(
      `[PoolManager] Pool status: ${status.currentSize}/${POOL_TARGET_SIZE} ` +
      `(Tier1: ${status.tier1Count}, Tier2: ${status.tier2Count}, Tier3: ${status.tier3Count}, Tier4: ${status.tier4Count})`
    );

    // Evict zero-volume if needed
    const eviction = await evictZeroVolumeTokens();
    if (eviction.evicted > 0) {
      console.log(`[PoolManager] Evicted ${eviction.evicted} zero-volume tokens`);
    }
  } catch (error) {
    console.error("[PoolManager] Error during maintenance:", error);
  }
}
