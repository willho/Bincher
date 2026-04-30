// @ts-nocheck
/**
 * API Delegation Strategy
 *
 * Pincher2 coordinates discovery/analysis but delegates API calls to proxies.
 * Proxies have separate keys/quotas and should do the heavy lifting.
 *
 * Strategy:
 * 1. High-frequency calls (token trades, wallet activity) → delegate to proxies
 * 2. Low-frequency analytical calls (historical lookups) → Pincher2 direct (reserve quota)
 * 3. Real-time streams (WebSocket) → proxies manage independently
 * 4. Critical metadata → Either source, failover available
 */

import { requestViaProxyWithFallback } from "./proxy-api-client";
import { rateLimiter } from "./unified-rate-limiter";

/**
 * API call categories and routing decisions
 */
export enum ApiCallPriority {
  // Delegate to proxies (they have higher quota)
  DELEGATE_PREFERRED = "delegate_preferred", // High-frequency, use proxy quota first
  DELEGATE_ONLY = "delegate_only", // Must use proxy, critical for redundancy

  // Pincher2 direct (reserve quota for critical ops)
  DIRECT_PREFERRED = "direct_preferred", // Low-frequency, use Pincher2 quota
  DIRECT_ONLY = "direct_only", // Only Pincher2 can do (e.g., internal db)

  // Either works
  EITHER = "either", // Route based on availability
}

/**
 * Classification of API calls by priority
 */
export const API_CALL_CLASSIFICATION: Record<
  string,
  {
    service: "shyft" | "chainstack" | "dexpaprika" | "dexscreener";
    priority: ApiCallPriority;
    reason: string;
  }
> = {
  // High-frequency: delegate to proxies
  "getSignaturesForAddress": {
    service: "chainstack",
    priority: ApiCallPriority.DELEGATE_PREFERRED,
    reason: "Wallet history lookups are high-frequency, proxies have separate quota",
  },
  "getTokenAccounts": {
    service: "chainstack",
    priority: ApiCallPriority.DELEGATE_PREFERRED,
    reason: "Holder enumeration is high-frequency per token",
  },
  "getProgramAccounts": {
    service: "chainstack",
    priority: ApiCallPriority.DELEGATE_PREFERRED,
    reason: "Cluster detection is expensive, proxies have separate quota",
  },
  "shyft_getTokensByOwner": {
    service: "shyft",
    priority: ApiCallPriority.DELEGATE_PREFERRED,
    reason: "Wallet holdings lookup is high-frequency",
  },

  // Critical real-time: must delegate (proxies run streams)
  "pumpportal_subscribeNewToken": {
    service: "dexpaprika", // Actually WebSocket, but grouped here for discovery
    priority: ApiCallPriority.DELEGATE_ONLY,
    reason: "Each proxy runs independent WebSocket stream for redundancy",
  },
  "pumpportal_subscribeTokenTrade": {
    service: "dexpaprika",
    priority: ApiCallPriority.DELEGATE_ONLY,
    reason: "Trade streams run on proxies, not Pincher2",
  },
  "dexpaprika_tradeStream": {
    service: "dexpaprika",
    priority: ApiCallPriority.DELEGATE_ONLY,
    reason: "Post-grad trade monitoring via proxy gRPC/SSE",
  },

  // Low-frequency analytical: Pincher2 direct
  "retrolearner_historicalAnalysis": {
    service: "chainstack",
    priority: ApiCallPriority.DIRECT_PREFERRED,
    reason: "Runs once per 4 hours, reserve Pincher2 quota",
  },
  "token_metadata_enrichment": {
    service: "dexscreener",
    priority: ApiCallPriority.DIRECT_PREFERRED,
    reason: "Batch metadata lookup, infrequent",
  },
  "rugcheck_safety": {
    service: "dexscreener", // RugCheck grouping
    priority: ApiCallPriority.DIRECT_PREFERRED,
    reason: "Safety checks run on new tokens, low frequency per token",
  },

  // Critical internal: Pincher2 only
  "system_health_check": {
    service: "chainstack",
    priority: ApiCallPriority.DIRECT_ONLY,
    reason: "Pincher2 internal health monitoring",
  },
};

/**
 * Router: Decide where API call should go
 */
export function routeApiCall(
  callName: string
): {
  useProxy: boolean;
  rateLimiterService: string;
  reason: string;
} {
  const classification = API_CALL_CLASSIFICATION[callName];

  if (!classification) {
    // Unknown call: default to Pincher2 direct with warning
    console.warn(
      `[ApiDelegation] Unknown API call: ${callName}, defaulting to Pincher2 direct`
    );
    return {
      useProxy: false,
      rateLimiterService: "unknown",
      reason: "Unknown call, conservative default",
    };
  }

  switch (classification.priority) {
    case ApiCallPriority.DELEGATE_PREFERRED:
      return {
        useProxy: true,
        rateLimiterService: classification.service,
        reason: classification.reason,
      };

    case ApiCallPriority.DELEGATE_ONLY:
      return {
        useProxy: true,
        rateLimiterService: classification.service,
        reason: classification.reason,
      };

    case ApiCallPriority.DIRECT_PREFERRED:
      return {
        useProxy: false,
        rateLimiterService: classification.service,
        reason: classification.reason,
      };

    case ApiCallPriority.DIRECT_ONLY:
      return {
        useProxy: false,
        rateLimiterService: classification.service,
        reason: classification.reason,
      };

    case ApiCallPriority.EITHER:
      // Route based on proxy availability
      return {
        useProxy: true, // Prefer proxy to spread load
        rateLimiterService: classification.service,
        reason: "Either works, preferring proxy for quota spread",
      };

    default:
      return {
        useProxy: false,
        rateLimiterService: classification.service,
        reason: "Unknown priority, conservative default",
      };
  }
}

/**
 * High-level delegated API call wrapper
 * Handles routing, rate limiting, fallback
 */
export async function makeDelegatedApiCall<T = any>(
  callName: string,
  path: string,
  options: {
    service: "shyft" | "chainstack" | "dexpaprika" | "dexscreener";
    method?: "GET" | "POST";
    body?: any;
    timeout?: number;
  }
): Promise<{
  success: boolean;
  data?: T;
  error?: string;
  routedTo: "proxy" | "pincher2";
  reason: string;
}> {
  const routing = routeApiCall(callName);

  if (routing.useProxy) {
    // Delegate to proxy
    try {
      // Enforce proxy rate limit before delegation
      await rateLimiter.waitUntilAllowed(routing.rateLimiterService);

      const result = await requestViaProxyWithFallback<T>(path, options);

      return {
        success: result.success,
        data: result.data,
        error: result.error,
        routedTo: "proxy",
        reason: routing.reason,
      };
    } catch (error) {
      console.error(`[ApiDelegation] Proxy call failed for ${callName}:`, error);
      throw error;
    }
  } else {
    // Direct call from Pincher2
    try {
      // Enforce Pincher2 rate limit before direct call
      await rateLimiter.waitUntilAllowed(routing.rateLimiterService);

      // TODO: Implement direct API call here
      // For now, return placeholder
      return {
        success: false,
        error: "Direct API call not yet implemented",
        routedTo: "pincher2",
        reason: routing.reason,
      };
    } catch (error) {
      console.error(`[ApiDelegation] Direct call failed for ${callName}:`, error);
      throw error;
    }
  }
}

/**
 * Quota utilization report
 * Shows how API calls are distributed across instances
 */
export function getQuotaUtilizationReport() {
  const delegated = Object.entries(API_CALL_CLASSIFICATION)
    .filter(
      ([_, config]) =>
        config.priority === ApiCallPriority.DELEGATE_PREFERRED ||
        config.priority === ApiCallPriority.DELEGATE_ONLY
    )
    .map(([name, _]) => name);

  const direct = Object.entries(API_CALL_CLASSIFICATION)
    .filter(
      ([_, config]) =>
        config.priority === ApiCallPriority.DIRECT_PREFERRED ||
        config.priority === ApiCallPriority.DIRECT_ONLY
    )
    .map(([name, _]) => name);

  return {
    summary: {
      totalClassifications: Object.keys(API_CALL_CLASSIFICATION).length,
      delegatedToProxies: delegated.length,
      directFromPincher2: direct.length,
    },
    delegatedCalls: delegated,
    directCalls: direct,
    quotaStrategy: {
      proxies:
        "3 proxies × separate API keys = 3× quota multiplication (Chainstack: 3M credits/month total)",
      pincher2:
        "Delegates high-frequency calls to proxies. Optional: reserve small quota for critical analytical calls",
      webSockets:
        "Proxies manage independent streams (PumpPortal, DexPaprika SSE) with separate connections",
    },
  };
}
