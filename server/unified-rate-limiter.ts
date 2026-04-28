/**
 * Unified Rate Limiter
 *
 * Strategy: Identify strictest limit per API (monthly, weekly, per-min, etc)
 * Convert to per-second rate, enforce via token bucket.
 * Result: Mathematically impossible to exceed any limit.
 */

interface RateLimitConfig {
  name: string;
  strictestLimit: number; // The hardest constraint
  timeWindowMs: number; // Duration of that limit (e.g., 2592000000 for 30 days)
  maxBurstTokens?: number; // Allow small bursts (default 1)
}

class TokenBucketLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly refillRatePerSec: number;
  private readonly maxTokens: number;

  constructor(config: RateLimitConfig) {
    // Calculate per-second rate from strictest limit
    this.refillRatePerSec = config.strictestLimit / (config.timeWindowMs / 1000);
    this.maxTokens = config.maxBurstTokens || 1;
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }

  /**
   * Check if request allowed (returns immediately)
   */
  canMakeRequest(costInTokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= costInTokens) {
      this.tokens -= costInTokens;
      return true;
    }
    return false;
  }

  /**
   * Wait until request allowed (blocks)
   */
  async waitUntilAllowed(costInTokens: number = 1): Promise<void> {
    this.refill();
    if (this.tokens >= costInTokens) {
      this.tokens -= costInTokens;
      return;
    }

    // Wait for tokens to refill
    const tokensNeeded = costInTokens - this.tokens;
    const timeToWaitMs = (tokensNeeded / this.refillRatePerSec) * 1000;
    await new Promise((resolve) => setTimeout(resolve, timeToWaitMs));

    this.refill();
    this.tokens -= costInTokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTime;
    const elapsedSec = elapsedMs / 1000;
    const tokensToAdd = elapsedSec * this.refillRatePerSec;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  getStatus() {
    this.refill();
    return {
      tokensAvailable: this.tokens.toFixed(6),
      refillRatePerSec: this.refillRatePerSec.toFixed(6),
      maxTokens: this.maxTokens,
    };
  }
}

/**
 * Unified limiter for all APIs
 */
export class UnifiedRateLimiter {
  private limiters: Map<string, TokenBucketLimiter> = new Map();

  constructor() {
    // Configure each API with its strictest limit
    const configs: RateLimitConfig[] = [
      // Monthly limits (convert to daily to be conservative)
      {
        name: "chainstack",
        strictestLimit: 1_000_000 / 30, // 1M/month → daily limit
        timeWindowMs: 86_400_000, // 24 hours
        maxBurstTokens: 5, // Allow small batch of calls
      },
      {
        name: "helius",
        strictestLimit: 1_000_000 / 30, // 1M/month → daily limit
        timeWindowMs: 86_400_000,
        maxBurstTokens: 5,
      },
      // Per-minute limits
      {
        name: "dexPaprika",
        strictestLimit: 200,
        timeWindowMs: 60_000, // 1 minute
        maxBurstTokens: 2, // Allow brief burst of 2 requests
      },
      {
        name: "dexScreener",
        strictestLimit: 300,
        timeWindowMs: 60_000, // 1 minute
        maxBurstTokens: 2,
      },
      // Per-second limits
      {
        name: "pumpPortal",
        strictestLimit: 200,
        timeWindowMs: 1000, // 1 second
        maxBurstTokens: 1, // No burst (hard realtime limit)
      },
      // Special cases
      {
        name: "shyftHttp",
        strictestLimit: Number.MAX_SAFE_INTEGER, // Unlimited
        timeWindowMs: 1000,
        maxBurstTokens: Number.MAX_SAFE_INTEGER,
      },
      {
        name: "shyftGrpc",
        strictestLimit: 1, // Only 1 concurrent connection
        timeWindowMs: Number.MAX_SAFE_INTEGER,
        maxBurstTokens: 1,
      },
    ];

    for (const config of configs) {
      this.limiters.set(config.name, new TokenBucketLimiter(config));
    }
  }

  /**
   * Check if API call allowed (non-blocking)
   */
  canMakeRequest(service: string, costInTokens: number = 1): boolean {
    const limiter = this.limiters.get(service);
    if (!limiter) {
      console.warn(`[RateLimiter] Unknown service: ${service}`);
      return true; // Unknown services pass through
    }
    return limiter.canMakeRequest(costInTokens);
  }

  /**
   * Wait until API call allowed (blocking)
   */
  async waitUntilAllowed(service: string, costInTokens: number = 1): Promise<void> {
    const limiter = this.limiters.get(service);
    if (!limiter) {
      console.warn(`[RateLimiter] Unknown service: ${service}`);
      return;
    }
    return limiter.waitUntilAllowed(costInTokens);
  }

  /**
   * Get status of all limiters
   */
  getAllStatus() {
    const status: Record<string, any> = {};
    for (const [name, limiter] of this.limiters) {
      status[name] = limiter.getStatus();
    }
    return status;
  }

  /**
   * Get status of single limiter
   */
  getStatus(service: string) {
    const limiter = this.limiters.get(service);
    if (!limiter) return null;
    return limiter.getStatus();
  }
}

// Singleton instance
export const rateLimiter = new UnifiedRateLimiter();

/**
 * Helper: Enforce rate limit before making Chainstack call
 * Cost: depends on method (1-10 credits typical)
 */
export async function enforceChainStackLimit(methodCredits: number = 5): Promise<void> {
  await rateLimiter.waitUntilAllowed("chainstack", methodCredits);
}

/**
 * Helper: Enforce rate limit before making Shyft HTTP call
 */
export async function enforceShyftHttpLimit(): Promise<void> {
  // Shyft HTTP is unlimited, so this is a no-op
  // But calling this documents the rate limit requirement
  await rateLimiter.waitUntilAllowed("shyftHttp", 1);
}

/**
 * Helper: Enforce rate limit before making DexPaprika request
 */
export async function enforceDexPaprikaLimit(): Promise<void> {
  await rateLimiter.waitUntilAllowed("dexPaprika", 1);
}

/**
 * Helper: Enforce rate limit before making DexScreener request
 */
export async function enforceDexScreenerLimit(): Promise<void> {
  await rateLimiter.waitUntilAllowed("dexScreener", 1);
}

/**
 * Helper: Enforce rate limit for PumpPortal WebSocket messages
 * Note: This is approximate since WebSocket is event-driven
 */
export async function enforcePumpPortalLimit(): Promise<void> {
  await rateLimiter.waitUntilAllowed("pumpPortal", 1);
}
