/**
 * Pump.fun Bonding Curve Token Discovery & Tracking
 *
 * Monitors pump.fun for new token launches and tracks them through their bonding curve phase
 * until graduation to Raydium. This captures the critical first 4 hours when prices are lowest.
 *
 * Architecture:
 * - Phase 1: Poll pump.fun /coins every 30-60s for new bonding curve tokens
 * - Phase 2: Track bonding curve progress (~every 1-5 min) for tokens in curve phase
 * - Phase 3: Detect graduation (100% progress) and link to Raydium pool
 * - Integration: Emit discovery events for system picks evaluation
 */

import { db } from "./db";
import { eq, and, gte, isNull } from "drizzle-orm";
import { tokenDataPool, raydiumPoolDiscoveries, graduationEvents } from "@shared/schema";
import { emit } from "./discovery-event-bus";
import { upsertTokenData, getTokenData } from "./data-pool";
import axios from "axios";

// =====================
// CONFIGURATION
// =====================

const PUMPFUN_CONFIG = {
  // API endpoints (free frontend API, no authentication needed)
  apiBaseUrl: "https://frontend-api.pump.fun",

  // Polling intervals
  newTokensCheckInterval: 60000, // 60 seconds for new tokens (conservative, safe rate)
  progressCheckInterval: 300000, // 5 minutes for tracking progress (20 req/min tracked tokens)

  // Rate limiting (pump.fun appears permissive, likely 100+ req/min)
  maxNewTokensPerCheck: 30, // API returns 30 per request

  // Bonding curve tracking
  minBondingCurveAge: 30, // seconds - only track tokens old enough to be real
  maxBondingCurveAge: 4 * 3600, // 4 hours - graduation cutoff
  graduationProgressThreshold: 99, // Trigger graduation search at 99% progress

  // Token filters
  minMarketCapForTracking: 1000, // $1k USD market cap minimum
};

// =====================
// STATE TRACKING
// =====================

interface BondingCurveToken {
  mint: string;
  symbol: string;
  name: string;
  createdTimestamp: number;
  usdMarketCap: number;
  bondingCurveProgress: number;
  creatorAddress?: string;
  replyCount?: number;
  kingOfTheHill?: boolean;
}

interface TrackedToken {
  mint: string;
  discoveredAt: number;
  lastProgressCheck: number;
  lastKnownProgress: number;
}

let seenTokens = new Set<string>(); // Tokens we've ever discovered
let trackedTokens = new Map<string, TrackedToken>(); // Tokens currently on bonding curve
let lastNewTokenCheck = 0;
let lastProgressCheck = 0;
let pollIntervals: { newTokens?: NodeJS.Timeout; progress?: NodeJS.Timeout } = {};
let consecutiveApiFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;

// =====================
// PHASE 1: NEW TOKEN DISCOVERY
// =====================

/**
 * Poll pump.fun /coins endpoint for new/trending tokens on bonding curve
 * Returns tokens that are currently in bonding curve phase (not graduated)
 */
async function pollNewBondingCurveTokens(): Promise<BondingCurveToken[]> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Query pump.fun API for latest tokens
    const response = await axios.get(`${PUMPFUN_CONFIG.apiBaseUrl}/coins`, {
      params: {
        offset: 0,
        limit: PUMPFUN_CONFIG.maxNewTokensPerCheck,
        sort: "latest", // or "trending"
        order: "desc",
      },
      timeout: 5000,
    });

    if (!response.data?.coins || response.data.coins.length === 0) {
      consecutiveApiFailures = 0;
      return [];
    }

    consecutiveApiFailures = 0;
    const coins = response.data.coins as any[];

    console.log(`[PumpFun] Polling new tokens: found ${coins.length} tokens on bonding curve`);

    const newTokens: BondingCurveToken[] = [];

    for (const coin of coins) {
      try {
        const mint = coin.mint;

        // Skip if we've already tracked this
        if (seenTokens.has(mint)) {
          continue;
        }

        // Verify token age (ignore extremely fresh tokens that might be spam)
        const ageSeconds = now - (coin.created_timestamp || 0);
        if (ageSeconds < PUMPFUN_CONFIG.minBondingCurveAge) {
          continue; // Too fresh, skip
        }

        // Skip if already graduated (progress at 100%)
        if (coin.bonding_curve_progress >= 100) {
          continue;
        }

        // Skip very small market cap tokens
        if ((coin.usd_market_cap || 0) < PUMPFUN_CONFIG.minMarketCapForTracking) {
          continue;
        }

        seenTokens.add(mint);

        const token: BondingCurveToken = {
          mint,
          symbol: coin.symbol || "?",
          name: coin.name || "",
          createdTimestamp: coin.created_timestamp || now,
          usdMarketCap: coin.usd_market_cap || 0,
          bondingCurveProgress: coin.bonding_curve_progress || 0,
          creatorAddress: coin.creator || undefined,
          replyCount: coin.reply_count || 0,
          kingOfTheHill: coin.king_of_the_hill || false,
        };

        newTokens.push(token);
      } catch (error) {
        console.debug(`[PumpFun] Error processing token:`, error instanceof Error ? error.message : error);
      }
    }

    return newTokens;
  } catch (error) {
    consecutiveApiFailures++;
    if (consecutiveApiFailures % 3 === 0) {
      console.error(
        `[PumpFun] Error polling new tokens (failures: ${consecutiveApiFailures}):`,
        error instanceof Error ? error.message : error
      );
    }
    return [];
  }
}

/**
 * Register a new bonding curve token for tracking
 */
async function registerBondingCurveToken(token: BondingCurveToken): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Upsert into tokenDataPool
    await upsertTokenData(
      token.mint,
      {
        tokenSymbol: token.symbol,
        tokenName: token.name,
        pairCreatedAt: token.createdTimestamp,
        isPumpfun: true,
        pumpfunGraduated: false,
        pumpfunBondingCurveProgress: token.bondingCurveProgress,
        marketCap: token.usdMarketCap,
        deployerAddress: token.creatorAddress,
      },
      "pumpfun_discovery"
    );

    // Track for progress monitoring
    trackedTokens.set(token.mint, {
      mint: token.mint,
      discoveredAt: now,
      lastProgressCheck: now,
      lastKnownProgress: token.bondingCurveProgress,
    });

    // Evaluate for system picks immediately
    await evaluateTokenForSystemPicks(token);

    // Emit discovery event
    await emit({
      type: "pumpfun_bonding_curve",
      tokenMint: token.mint,
      source: "pumpfun_discovery",
      data: {
        symbol: token.symbol,
        name: token.name,
        marketCap: token.usdMarketCap,
        bondingProgress: token.bondingCurveProgress,
        creator: token.creatorAddress,
        kingOfTheHill: token.kingOfTheHill,
      },
      timestamp: now,
      urgency: 70, // High urgency - fresh tokens
    });

    console.log(
      `[PumpFun] Registered new token: ${token.symbol} (${token.mint.slice(0, 8)}...) - Progress: ${token.bondingCurveProgress.toFixed(1)}%`
    );
  } catch (error) {
    console.error(`[PumpFun] Error registering token ${token.mint}:`, error);
  }
}

// =====================
// PHASE 2: PROGRESS TRACKING
// =====================

/**
 * Get current bonding curve progress for a token
 */
async function getBondingCurveProgress(mint: string): Promise<number | null> {
  try {
    const response = await axios.get(`${PUMPFUN_CONFIG.apiBaseUrl}/coin/${mint}`, {
      timeout: 5000,
    });

    if (!response.data?.coin) {
      return null;
    }

    return response.data.coin.bonding_curve_progress || 0;
  } catch (error) {
    console.debug(`[PumpFun] Error fetching progress for ${mint.slice(0, 8)}...:`,
      error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Poll all tracked tokens for progress updates
 */
async function trackBondingCurveProgress(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const tokensToCheck = Array.from(trackedTokens.values());

    if (tokensToCheck.length === 0) {
      return;
    }

    console.log(`[PumpFun] Tracking ${tokensToCheck.length} tokens on bonding curve`);

    for (const tracked of tokensToCheck) {
      try {
        // Get current progress
        const progress = await getBondingCurveProgress(tracked.mint);

        if (progress === null) {
          // Token might be gone, skip
          continue;
        }

        // Update in database
        await upsertTokenData(
          tracked.mint,
          {
            pumpfunBondingCurveProgress: progress,
          },
          "pumpfun_progress"
        );

        // Update tracking state
        tracked.lastProgressCheck = now;
        tracked.lastKnownProgress = progress;

        // Check if approaching graduation (>99%)
        if (progress >= PUMPFUN_CONFIG.graduationProgressThreshold &&
            tracked.lastKnownProgress < PUMPFUN_CONFIG.graduationProgressThreshold) {
          console.log(
            `[PumpFun] Token approaching graduation: ${tracked.mint.slice(0, 8)}... (${progress.toFixed(1)}%)`
          );
          // Will be picked up by graduation tracker shortly
        }

        // Clean up if too old (> 4 hours)
        const ageSeconds = now - tracked.discoveredAt;
        if (ageSeconds > PUMPFUN_CONFIG.maxBondingCurveAge) {
          trackedTokens.delete(tracked.mint);
          console.log(`[PumpFun] Stopped tracking (too old): ${tracked.mint.slice(0, 8)}...`);
        }
      } catch (error) {
        console.debug(`[PumpFun] Error tracking token ${tracked.mint.slice(0, 8)}...:`,
          error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.error("[PumpFun] Error in progress tracking:", error);
  }
}

// =====================
// SYSTEM PICKS EVALUATION
// =====================

/**
 * Immediately evaluate bonding curve token for system picks
 * This is called when token is first discovered, before graduation
 */
async function evaluateTokenForSystemPicks(token: BondingCurveToken): Promise<void> {
  try {
    // Import system picks evaluator
    const { calculateConviction } = await import("./system-picks-v2");

    // Get conviction score
    const conviction = await calculateConviction(token.mint);

    if (!conviction || conviction.finalConviction < 0.5) {
      return; // Not high enough conviction for system pick
    }

    console.log(
      `[PumpFun] System pick candidate: ${token.symbol} - Conviction: ${(conviction.finalConviction * 100).toFixed(0)}%`
    );

    // In production, could trigger immediate paper trade or signal
    // For now just logging for analysis
  } catch (error) {
    console.debug(`[PumpFun] Error evaluating ${token.symbol} for system picks:`,
      error instanceof Error ? error.message : error);
  }
}

// =====================
// LIFECYCLE MANAGEMENT
// =====================

/**
 * Start bonding curve monitoring
 */
export async function startPumpFunMonitoring(): Promise<void> {
  console.log("[PumpFun] Starting pump.fun bonding curve monitoring");

  // Phase 1: Poll for new tokens
  pollIntervals.newTokens = setInterval(async () => {
    const newTokens = await pollNewBondingCurveTokens();

    for (const token of newTokens) {
      await registerBondingCurveToken(token);
    }
  }, PUMPFUN_CONFIG.newTokensCheckInterval);

  // Phase 2: Track progress of tokens on bonding curve
  pollIntervals.progress = setInterval(async () => {
    await trackBondingCurveProgress();
  }, PUMPFUN_CONFIG.progressCheckInterval);

  // Initial poll
  const initialTokens = await pollNewBondingCurveTokens();
  for (const token of initialTokens) {
    await registerBondingCurveToken(token);
  }

  console.log(`[PumpFun] Monitoring started. Initial tokens: ${initialTokens.length}`);
}

/**
 * Stop monitoring
 */
export async function stopPumpFunMonitoring(): Promise<void> {
  if (pollIntervals.newTokens) clearInterval(pollIntervals.newTokens);
  if (pollIntervals.progress) clearInterval(pollIntervals.progress);
  console.log("[PumpFun] Monitoring stopped");
}

/**
 * Get current monitoring stats
 */
export function getPumpFunMonitoringStats() {
  return {
    seenTokensTotal: seenTokens.size,
    currentlyTracked: trackedTokens.size,
    consecutiveApiFailures,
  };
}

/**
 * Manually trigger new token polling (for testing)
 */
export async function forceNewTokenCheck(): Promise<BondingCurveToken[]> {
  return pollNewBondingCurveTokens();
}

/**
 * Get tracked tokens (for API endpoints)
 */
export function getTrackedBondingCurveTokens(): TrackedToken[] {
  return Array.from(trackedTokens.values());
}
