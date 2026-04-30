/**
 * Tiered Token Monitoring System
 *
 * Strategy from old price-monitor.ts:
 * - For first 5 minutes of pump.fun tokens: Webhook monitoring (real-time)
 * - After 5 minutes: Switch to polling tiers based on creator reputation
 *   * HOT (5 min intervals): Unknown/risky creators
 *   * WARM (15 min intervals): Decent creators
 *   * COLD (no polling): Trusted creators
 *
 * This prevents wasting API calls on tokens with strong creators
 * while ensuring close monitoring of risky tokens.
 */

import { db } from "./db";
import { eq, and, gte, lt } from "drizzle-orm";
import { raydiumPoolDiscoveries, tokenDataPool } from "@shared/schema";
import { getCreatorReputation, scoreCreatorReputation, getMonitoringTier, classifyCreator } from "./creator-reputation";
import { fetchTokenWithFallback } from "./data-pool";

interface TokenMonitoringState {
  tokenMint: string;
  discoveredAt: number;
  creatorAddress?: string;
  creatorScore?: number;
  monitoringTier: "hot" | "warm" | "cold" | "webhook";
  lastPolledAt: number;
  status: "webhook" | "polling" | "inactive";
}

const monitoringStates = new Map<string, TokenMonitoringState>();

// Polling intervals (from price-monitor.ts)
const HOT_POLLING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WARM_POLLING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const WEBHOOK_DURATION_MS = 5 * 60 * 1000; // 5 minutes of webhook monitoring

/**
 * Register a newly discovered token for monitoring
 *
 * For pump.fun tokens: Start with WEBHOOK monitoring for first 5 minutes
 * Then transition to POLLING based on creator reputation
 */
export async function registerTokenForMonitoring(
  tokenMint: string,
  discoveredAt: number,
  poolOriginType: "pumpfun_graduated" | "direct_raydium"
): Promise<void> {
  try {
    // Get token data
    const tokenData = await fetchTokenWithFallback(tokenMint);
    const creatorAddress = tokenData.creatorAddress;

    // For pump.fun tokens: Start with webhook monitoring
    const initialTier = poolOriginType === "pumpfun_graduated" ? "webhook" : "polling";

    let creatorScore = 0.5; // Default neutral

    if (creatorAddress) {
      try {
        const creatorHistory = await getCreatorReputation(creatorAddress);
        creatorScore = scoreCreatorReputation(creatorHistory);

        console.log(
          `[TokenMonitoring] Registered ${tokenMint.slice(0, 8)}... (creator: ${classifyCreator(creatorHistory)}, score: ${(creatorScore * 100).toFixed(0)}%)`
        );
      } catch (error) {
        console.error(`[TokenMonitoring] Error fetching creator history:`, error);
      }
    }

    // Store monitoring state
    monitoringStates.set(tokenMint, {
      tokenMint,
      discoveredAt,
      creatorAddress,
      creatorScore,
      monitoringTier: initialTier === "webhook" ? "hot" : "warm", // Will be 'webhook' initially for pump.fun
      lastPolledAt: discoveredAt,
      status: initialTier,
    });
  } catch (error) {
    console.error(`[TokenMonitoring] Error registering token for monitoring:`, error);
  }
}

/**
 * Get the next monitoring action for a token
 *
 * Returns:
 * - "webhook": Use webhook (real-time), don't poll
 * - "poll": Use polling interval
 * - "skip": Don't monitor this token
 */
export function getMonitoringAction(
  tokenMint: string,
  nowMs: number
): { action: "webhook" | "poll" | "skip"; nextCheckMs: number } {
  const state = monitoringStates.get(tokenMint);

  if (!state) {
    return { action: "skip", nextCheckMs: Number.MAX_SAFE_INTEGER };
  }

  // Phase 1: First 5 minutes - WEBHOOK monitoring (real-time)
  const ageMs = nowMs - state.discoveredAt;
  if (ageMs < WEBHOOK_DURATION_MS && state.status === "webhook") {
    return {
      action: "webhook",
      nextCheckMs: nowMs + 1000, // Check every second if webhook is still active
    };
  }

  // Phase 2: Transition from webhook to polling
  if (ageMs >= WEBHOOK_DURATION_MS && state.status === "webhook") {
    // Determine polling tier based on creator score
    const newTier = getMonitoringTier(
      {
        totalLaunches: state.creatorScore ? 10 : 0, // Rough estimate
        successRate: state.creatorScore || 0.5,
        rugRate: 0.2,
        avgMultiplier: 2,
        confidence: state.creatorScore ? 0.6 : 0.1,
      },
      ageMs / 60000
    );

    state.status = "polling";
    state.monitoringTier = newTier;

    console.log(
      `[TokenMonitoring] Transitioned ${tokenMint.slice(0, 8)}... from webhook to ${newTier} polling`
    );
  }

  // Phase 3: Polling-based monitoring
  if (state.status === "polling") {
    const pollingInterval = state.monitoringTier === "hot" ? HOT_POLLING_INTERVAL_MS : WARM_POLLING_INTERVAL_MS;

    const timeSinceLastPoll = nowMs - state.lastPolledAt;

    if (timeSinceLastPoll >= pollingInterval) {
      state.lastPolledAt = nowMs;
      return {
        action: "poll",
        nextCheckMs: nowMs + pollingInterval,
      };
    }

    return {
      action: "skip",
      nextCheckMs: state.lastPolledAt + pollingInterval,
    };
  }

  // Cold tier or inactive
  return {
    action: "skip",
    nextCheckMs: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Process webhook events for pump.fun token (first 5 minutes)
 *
 * In production, this would be called by the Helius webhook handler
 * for swap/trade events on the token during the first 5 minutes.
 */
export async function processWebhookEvent(
  tokenMint: string,
  eventType: "swap" | "price_update",
  data: {
    price?: number;
    volume?: number;
    timestamp: number;
    trader?: string;
  }
): Promise<void> {
  const state = monitoringStates.get(tokenMint);

  if (!state || state.status !== "webhook") {
    return; // Not in webhook phase
  }

  // Check if still in 5-minute window
  const ageMs = Date.now() - state.discoveredAt;
  if (ageMs > WEBHOOK_DURATION_MS) {
    state.status = "polling"; // Transition to polling
    return;
  }

  console.log(
    `[TokenMonitoring] Webhook event for ${tokenMint.slice(0, 8)}...: ${eventType} at $${data.price?.toFixed(8) || "?"}`
  );

  // In production: Update position tracking, check SL/TP, etc.
  // For now: Just log the event
}

/**
 * Poll token prices and check exit conditions
 *
 * Called by checkPricesAndReclaim() in price-monitor.ts
 */
export async function pollTokenPrice(
  tokenMint: string
): Promise<{ price: number; shouldExit: boolean } | null> {
  const state = monitoringStates.get(tokenMint);

  if (!state || state.status !== "polling") {
    return null; // Not in polling phase
  }

  try {
    // Fetch current price
    const tokenData = await fetchTokenWithFallback(tokenMint);
    const price = tokenData.priceUsd || 0;

    if (price <= 0) {
      return null;
    }

    // Check if token is dead or should stop monitoring
    const shouldExit = price < 0.0000000001 || tokenData.liquidity === null;

    if (shouldExit) {
      console.log(`[TokenMonitoring] Stopping monitoring for ${tokenMint.slice(0, 8)}... (dead token)`);
      monitoringStates.delete(tokenMint);
    }

    return { price, shouldExit };
  } catch (error) {
    console.error(`[TokenMonitoring] Error polling token ${tokenMint.slice(0, 8)}...:`, error);
    return null;
  }
}

/**
 * Get monitoring statistics (for debugging/monitoring)
 */
export function getMonitoringStats() {
  const now = Date.now();
  const byStatus = { webhook: 0, hot: 0, warm: 0, cold: 0, inactive: 0 };
  const byStatus2 = { webhook: 0, polling: 0, inactive: 0 };

  for (const state of monitoringStates.values()) {
    const key = state.monitoringTier as keyof typeof byStatus;
    if (key in byStatus) {
      byStatus[key]++;
    }
    const key2 = state.status as keyof typeof byStatus2;
    if (key2 in byStatus2) {
      byStatus2[key2]++;
    }
  }

  return {
    totalTokens: monitoringStates.size,
    byTier: byStatus,
    byStatus: byStatus2,
    averageCreatorScore: Array.from(monitoringStates.values()).reduce(
      (sum, s) => sum + (s.creatorScore || 0.5),
      0
    ) / Math.max(1, monitoringStates.size),
  };
}

/**
 * Start the monitoring coordinator
 *
 * Periodically checks which tokens need polling and coordinates
 * with the main price monitor.
 */
export async function startTokenMonitoringCoordinator(): Promise<void> {
  console.log("[TokenMonitoring] Starting tiered monitoring coordinator");

  // Initial check after 10 seconds
  setTimeout(async () => {
    try {
      await coordinateMonitoring();
    } catch (error) {
      console.error("[TokenMonitoring] Initial coordination failed:", error);
    }
  }, 10_000);

  // Periodic coordination every 30 seconds
  setInterval(async () => {
    try {
      await coordinateMonitoring();
    } catch (error) {
      console.error("[TokenMonitoring] Coordination error:", error);
    }
  }, 30_000);
}

/**
 * Coordinate monitoring actions for all tracked tokens
 */
async function coordinateMonitoring(): Promise<void> {
  const now = Date.now();
  let webhookCount = 0;
  let pollCount = 0;

  for (const [tokenMint, state] of monitoringStates) {
    const { action, nextCheckMs } = getMonitoringAction(tokenMint, now);

    if (action === "webhook") {
      webhookCount++;
    } else if (action === "poll") {
      pollCount++;
      // This token is due for polling - handled by price-monitor.ts
    }
  }

  if ((webhookCount + pollCount) % 10 === 0) {
    const stats = getMonitoringStats();
    console.log(`[TokenMonitoring] Status: ${stats.totalTokens} tokens, webhook: ${webhookCount}, polling: ${pollCount}`);
  }
}

/**
 * Get tier assignment for a token based on creator reputation
 * Used by WebSocket client to determine subscription tier
 */
export function getTierForToken(creatorScore: number, ageMinutes: number): "webhook" | "hot" | "warm" | "cold" {
  // First 5 minutes: webhook (real-time monitoring)
  if (ageMinutes < 5) {
    return "webhook";
  }

  // After 5 minutes: determine based on creator score
  // Low score (risky): hot (frequent polling)
  // Medium score: warm (less frequent polling)
  // High score (trusted): cold (no polling)
  if (creatorScore < 0.4) {
    return "hot";
  } else if (creatorScore < 0.7) {
    return "warm";
  } else {
    return "cold";
  }
}

/**
 * Called by WebSocket when new tokens are discovered
 * Returns the tier the token should be subscribed at
 */
export async function assessNewTokenForWebSocketSubscription(
  tokenMint: string,
  creatorAddress?: string
): Promise<"webhook" | "hot" | "warm" | "cold" | null> {
  try {
    if (!creatorAddress) {
      // Unknown creator - default to hot tier (close monitoring)
      return "hot";
    }

    const creatorHistory = await getCreatorReputation(creatorAddress);
    const creatorScore = scoreCreatorReputation(creatorHistory);

    const tier = getTierForToken(creatorScore, 0); // Age is 0 for brand new tokens

    console.log(
      `[TokenMonitoring] New token ${tokenMint.slice(0, 8)}... (creator: ${classifyCreator(creatorHistory)}, score: ${(creatorScore * 100).toFixed(0)}%, tier: ${tier})`
    );

    return tier;
  } catch (error) {
    console.error(`[TokenMonitoring] Error assessing token for subscription:`, error);
    // Default to hot on error
    return "hot";
  }
}

export default {
  registerTokenForMonitoring,
  getMonitoringAction,
  processWebhookEvent,
  pollTokenPrice,
  getMonitoringStats,
  startTokenMonitoringCoordinator,
  getTierForToken,
  assessNewTokenForWebSocketSubscription,
};
