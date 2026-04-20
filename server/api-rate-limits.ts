/**
 * STRICT PER-SECOND RATE LIMITS
 * Hard-coded to prevent API overages
 * All limits are STRICTEST (daily / 86400 seconds)
 */

export const STRICT_RATE_LIMITS = {
  // Chainstack: 2,500 calls/day max
  // 2,500 / 86,400 = 0.0289 calls/sec = 1 call every 34.6 seconds
  chainstack: {
    perSecond: 0.0289,
    perMinute: 1.73,
    perHour: 103.8,
    perDay: 2500,
    description: "1 call every ~34 seconds",
  },

  // Helius: 30,000 calls/day max
  // 30,000 / 86,400 = 0.347 calls/sec = 1 call every 2.88 seconds
  helius: {
    perSecond: 0.347,
    perMinute: 20.8,
    perHour: 1250,
    perDay: 30000,
    description: "1 call every ~3 seconds",
  },

  // DexPaprika: 200 req/min strict limit (from their docs)
  // 200 / 60 = 3.33 req/sec
  dexPaprika: {
    perSecond: 3.33,
    perMinute: 200,
    perHour: 12000,
    perDay: 288000,
    description: "3.33 requests per second (200/min)",
  },

  // DexScreener: 20 req/min strict limit (conservative)
  // 20 / 60 = 0.33 req/sec
  dexScreener: {
    perSecond: 0.33,
    perMinute: 20,
    perHour: 1200,
    perDay: 28800,
    description: "0.33 requests per second (1 every 3 seconds)",
  },

  // Shyft HTTP RPC: UNLIMITED
  // Use max safe rate (not to overload servers)
  shyftHttp: {
    perSecond: 100, // Conservative unlimited rate
    perMinute: 6000,
    perHour: 360000,
    perDay: Infinity,
    description: "Unlimited (capped at 100/sec for safety)",
  },

  // Shyft gRPC: 1 concurrent connection only (free tier)
  // Connection-based, not per-second
  shyftGrpc: {
    maxConcurrentConnections: 1,
    maxConcurrentSubscriptions: 1,
    description: "1 concurrent stream (must unsubscribe before subscribing to another)",
  },

  // PumpPortal WebSocket: 200 msg/sec (from their docs)
  pumpPortal: {
    perSecond: 200,
    perMinute: 12000,
    perHour: 720000,
    perDay: 17280000,
    description: "200 messages per second",
    subscriptionMessagesPerSecond: 200,
    maxSubscriptionBatchSize: 5000,
  },

  // RugCheck: Rate limited (exact unknown, use conservative)
  // Estimate: ~1 request per second based on typical API patterns
  rugCheck: {
    perSecond: 1,
    perMinute: 60,
    perHour: 3600,
    perDay: 86400,
    description: "Conservative: 1 request per second",
  },

  // Constant•K: Free tier unknown, use Chainstack estimate as fallback
  // 2,500 calls/day = 0.0289 calls/sec
  constantK: {
    perSecond: 0.0289,
    perMinute: 1.73,
    perHour: 103.8,
    perDay: 2500,
    description: "1 call every ~34 seconds (free tier estimate)",
  },

  // OnFinality: RU-based, not per-request count
  // Skip until clearer documentation available
  onFinality: {
    disabled: true,
    description: "Disabled - opaque RU pricing model",
  },
};

/**
 * CIRCUIT BREAKER THRESHOLDS
 * Stop accepting requests at 95% of daily limit
 */
export const CIRCUIT_BREAKER_THRESHOLDS = {
  // 95% of daily limit triggers circuit breaker
  // Returns cached data instead of making API call
  chainstack: 0.95,
  helius: 0.95,
  dexPaprika: 0.95,
  dexScreener: 0.95,
  rugCheck: 0.95,
  constantK: 0.95,
};

/**
 * RATE LIMITER IMPLEMENTATION
 * Token bucket algorithm for per-second enforcement
 */
export class StrictRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private lastRefill: number = Date.now();

  constructor(perSecondLimit: number) {
    this.refillRate = perSecondLimit;
    this.maxTokens = Math.max(1, Math.ceil(perSecondLimit)); // Min 1 token bucket
    this.tokens = this.maxTokens;
  }

  /**
   * Attempt to consume tokens
   * Returns true if allowed, false if rate limited
   */
  tryConsume(amount: number = 1): boolean {
    this.refill();

    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }

    return false;
  }

  /**
   * Wait until tokens available (blocking)
   * Used for critical operations that must succeed
   */
  async waitAndConsume(amount: number = 1): Promise<void> {
    const waitTime = (amount - this.tokens) / this.refillRate;
    if (waitTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
    }
    this.tokens -= amount;
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * DAILY QUOTA TRACKER
 * Prevents going over daily limits even with token bucket
 */
export class DailyQuotaTracker {
  private dayStart: number = Date.now();
  private dayStartDate: string = this.getTodayDate();
  private used: number = 0;
  private readonly dailyLimit: number;

  constructor(dailyLimit: number) {
    this.dailyLimit = dailyLimit;
  }

  /**
   * Check if quota allows usage
   */
  canUse(amount: number = 1): boolean {
    this.checkDayReset();
    return this.used + amount <= this.dailyLimit;
  }

  /**
   * Record usage
   */
  use(amount: number = 1): void {
    this.checkDayReset();
    this.used += amount;
  }

  /**
   * Get usage percentage (0-100)
   */
  getUsagePercent(): number {
    this.checkDayReset();
    return (this.used / this.dailyLimit) * 100;
  }

  /**
   * Get remaining quota for today
   */
  getRemaining(): number {
    this.checkDayReset();
    return Math.max(0, this.dailyLimit - this.used);
  }

  /**
   * Get total used today
   */
  getUsed(): number {
    this.checkDayReset();
    return this.used;
  }

  /**
   * Check if day changed and reset if needed
   */
  private checkDayReset(): void {
    const today = this.getTodayDate();
    if (today !== this.dayStartDate) {
      this.dayStartDate = today;
      this.used = 0;
      this.dayStart = Date.now();
    }
  }

  /**
   * Get today's date as YYYY-MM-DD for comparison
   */
  private getTodayDate(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
  }
}

/**
 * GLOBAL API RATE LIMITERS
 * One limiter per API service
 */
export const rateLimiters = {
  chainstack: new StrictRateLimiter(STRICT_RATE_LIMITS.chainstack.perSecond),
  helius: new StrictRateLimiter(STRICT_RATE_LIMITS.helius.perSecond),
  dexPaprika: new StrictRateLimiter(STRICT_RATE_LIMITS.dexPaprika.perSecond),
  dexScreener: new StrictRateLimiter(STRICT_RATE_LIMITS.dexScreener.perSecond),
  shyftHttp: new StrictRateLimiter(STRICT_RATE_LIMITS.shyftHttp.perSecond),
  rugCheck: new StrictRateLimiter(STRICT_RATE_LIMITS.rugCheck.perSecond),
  constantK: new StrictRateLimiter(STRICT_RATE_LIMITS.constantK.perSecond),
};

/**
 * GLOBAL DAILY QUOTA TRACKERS
 * One tracker per API service
 */
export const quotaTrackers = {
  chainstack: new DailyQuotaTracker(STRICT_RATE_LIMITS.chainstack.perDay),
  helius: new DailyQuotaTracker(STRICT_RATE_LIMITS.helius.perDay),
  dexPaprika: new DailyQuotaTracker(STRICT_RATE_LIMITS.dexPaprika.perDay),
  dexScreener: new DailyQuotaTracker(STRICT_RATE_LIMITS.dexScreener.perDay),
  rugCheck: new DailyQuotaTracker(STRICT_RATE_LIMITS.rugCheck.perDay),
  constantK: new DailyQuotaTracker(STRICT_RATE_LIMITS.constantK.perDay),
};

/**
 * CHECK IF API CALL IS ALLOWED
 * Respects both per-second rate limit AND daily quota
 */
export function canMakeApiCall(
  apiName: keyof typeof rateLimiters,
  amount: number = 1
): { allowed: boolean; reason?: string; remainingToday?: number; usagePercent?: number } {
  const quotaTracker = quotaTrackers[apiName];
  const rateLimiter = rateLimiters[apiName];

  // Check daily quota first
  if (!quotaTracker.canUse(amount)) {
    return {
      allowed: false,
      reason: `Daily quota exhausted for ${apiName}`,
      remainingToday: quotaTracker.getRemaining(),
      usagePercent: quotaTracker.getUsagePercent(),
    };
  }

  // Check circuit breaker (95% threshold)
  const usagePercent = quotaTracker.getUsagePercent();
  if (usagePercent >= CIRCUIT_BREAKER_THRESHOLDS[apiName] * 100) {
    return {
      allowed: false,
      reason: `Circuit breaker triggered for ${apiName} at ${usagePercent.toFixed(1)}% usage`,
      remainingToday: quotaTracker.getRemaining(),
      usagePercent,
    };
  }

  // Check per-second rate limit
  if (!rateLimiter.tryConsume(amount)) {
    return {
      allowed: false,
      reason: `Rate limited for ${apiName} (${STRICT_RATE_LIMITS[apiName].description})`,
      remainingToday: quotaTracker.getRemaining(),
      usagePercent,
    };
  }

  // All checks passed
  quotaTracker.use(amount);
  return {
    allowed: true,
    remainingToday: quotaTracker.getRemaining(),
    usagePercent,
  };
}

/**
 * GET API STATUS
 * For monitoring dashboard
 */
export function getApiStatus() {
  return {
    chainstack: {
      perSecond: STRICT_RATE_LIMITS.chainstack.perSecond,
      used: quotaTrackers.chainstack.getUsed(),
      remaining: quotaTrackers.chainstack.getRemaining(),
      usagePercent: quotaTrackers.chainstack.getUsagePercent(),
      circuitBreakerActive: quotaTrackers.chainstack.getUsagePercent() >= 95,
    },
    helius: {
      perSecond: STRICT_RATE_LIMITS.helius.perSecond,
      used: quotaTrackers.helius.getUsed(),
      remaining: quotaTrackers.helius.getRemaining(),
      usagePercent: quotaTrackers.helius.getUsagePercent(),
      circuitBreakerActive: quotaTrackers.helius.getUsagePercent() >= 95,
    },
    dexPaprika: {
      perSecond: STRICT_RATE_LIMITS.dexPaprika.perSecond,
      used: quotaTrackers.dexPaprika.getUsed(),
      remaining: quotaTrackers.dexPaprika.getRemaining(),
      usagePercent: quotaTrackers.dexPaprika.getUsagePercent(),
      circuitBreakerActive: quotaTrackers.dexPaprika.getUsagePercent() >= 95,
    },
    dexScreener: {
      perSecond: STRICT_RATE_LIMITS.dexScreener.perSecond,
      used: quotaTrackers.dexScreener.getUsed(),
      remaining: quotaTrackers.dexScreener.getRemaining(),
      usagePercent: quotaTrackers.dexScreener.getUsagePercent(),
      circuitBreakerActive: quotaTrackers.dexScreener.getUsagePercent() >= 95,
    },
    rugCheck: {
      perSecond: STRICT_RATE_LIMITS.rugCheck.perSecond,
      used: quotaTrackers.rugCheck.getUsed(),
      remaining: quotaTrackers.rugCheck.getRemaining(),
      usagePercent: quotaTrackers.rugCheck.getUsagePercent(),
      circuitBreakerActive: quotaTrackers.rugCheck.getUsagePercent() >= 95,
    },
  };
}
