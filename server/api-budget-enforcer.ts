import { db } from "./db";

export interface ApiQuota {
  service: string;
  monthlyLimit: number;
  monthlyUsage: number;
  lastResetDate: Date;
  circuitBreakerAt: number; // 95% of limit
  circuitBreakerTriggered: boolean;
}

const quotas: Map<string, ApiQuota> = new Map([
  ["chainstack", {
    service: "chainstack",
    monthlyLimit: 950_000,
    monthlyUsage: 0,
    lastResetDate: new Date(),
    circuitBreakerAt: 902_500,
    circuitBreakerTriggered: false,
  }],
  ["helius", {
    service: "helius",
    monthlyLimit: 950_000,
    monthlyUsage: 0,
    lastResetDate: new Date(),
    circuitBreakerAt: 902_500,
    circuitBreakerTriggered: false,
  }],
  ["dexPaprika", {
    service: "dexPaprika",
    monthlyLimit: 244_800,
    monthlyUsage: 0,
    lastResetDate: new Date(),
    circuitBreakerAt: 232_560,
    circuitBreakerTriggered: false,
  }],
  ["dexScreener", {
    service: "dexScreener",
    monthlyLimit: 86_400,
    monthlyUsage: 0,
    lastResetDate: new Date(),
    circuitBreakerAt: 82_080,
    circuitBreakerTriggered: false,
  }],
  ["pumpPortal", {
    service: "pumpPortal",
    monthlyLimit: 8_640_000,
    monthlyUsage: 0,
    lastResetDate: new Date(),
    circuitBreakerAt: 8_208_000,
    circuitBreakerTriggered: false,
  }],
]);

export class ShyftGrpcLimiter {
  private activeConnections = 0;
  private maxConnections = 1;

  async acquireConnection(): Promise<void> {
    if (this.activeConnections >= this.maxConnections) {
      console.error(
        `[ShyftGrpc] Cannot exceed ${this.maxConnections} concurrent connection. ` +
        `Current: ${this.activeConnections}. Switch subscriptions instead.`
      );
      throw new Error(
        `[ShyftGrpc] Cannot exceed ${this.maxConnections} concurrent connection. ` +
        `Current: ${this.activeConnections}. Switch subscriptions instead.`
      );
    }
    this.activeConnections++;
    console.log(`[ShyftGrpc] Connection acquired (${this.activeConnections}/${this.maxConnections})`);
  }

  releaseConnection(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    console.log(`[ShyftGrpc] Connection released (${this.activeConnections}/${this.maxConnections})`);
  }

  getStatus(): { active: number; max: number } {
    return { active: this.activeConnections, max: this.maxConnections };
  }
}

/**
 * Check if API call is allowed. Throws error if would exceed limit.
 * CIRCUIT BREAKER: Hard stop at 95% of monthly limit
 */
export async function checkApiQuota(
  service: string,
  creditsNeeded: number = 1
): Promise<{ allowed: boolean; remaining: number }> {
  const quota = quotas.get(service);
  if (!quota) throw new Error(`Unknown service: ${service}`);

  // Reset monthly counter if month changed
  const now = new Date();
  if (now.getMonth() !== quota.lastResetDate.getMonth() ||
      now.getFullYear() !== quota.lastResetDate.getFullYear()) {
    quota.monthlyUsage = 0;
    quota.lastResetDate = now;
    quota.circuitBreakerTriggered = false;
    console.log(`[ApiQuota] Reset monthly counter for ${service}`);
  }

  const projectedUsage = quota.monthlyUsage + creditsNeeded;

  // HARD STOP: Reject if would exceed circuit breaker
  if (projectedUsage > quota.circuitBreakerAt) {
    if (!quota.circuitBreakerTriggered) {
      quota.circuitBreakerTriggered = true;
      console.error(
        `[ApiQuota] ⚠️ CIRCUIT BREAKER triggered for ${service}. ` +
        `Current: ${quota.monthlyUsage}/${quota.monthlyLimit}, ` +
        `Requested: +${creditsNeeded}, ` +
        `CB at: ${quota.circuitBreakerAt}`
      );

      // Log to database for audit
      await logQuotaExceeded(service, quota.monthlyUsage, creditsNeeded);
    }

    throw new Error(
      `[ApiQuota] ${service} monthly limit reached (${quota.monthlyUsage}/${quota.monthlyLimit}). ` +
      `Circuit breaker at 95%. Request rejected. Remaining this month: ${quota.circuitBreakerAt - quota.monthlyUsage}`
    );
  }

  // Log warning at 85% utilization
  const usagePercent = projectedUsage / quota.monthlyLimit * 100;
  if (usagePercent > 85 && usagePercent <= 90) {
    console.warn(
      `[ApiQuota] ⚠️ ${service} approaching limit. ` +
      `${quota.monthlyUsage}/${quota.monthlyLimit} (${usagePercent.toFixed(1)}%)`
    );
  }

  // Allow the call
  quota.monthlyUsage += creditsNeeded;
  const remaining = quota.circuitBreakerAt - quota.monthlyUsage;

  if (remaining < 10_000) {
    console.warn(
      `[ApiQuota] ⚠️ CRITICAL: ${service} quota remaining: ${remaining} ` +
      `(${(remaining / quota.monthlyLimit * 100).toFixed(2)}% of monthly limit)`
    );
  }

  return {
    allowed: true,
    remaining: remaining
  };
}

/**
 * Log quota exceeded event to database for audit trail
 */
async function logQuotaExceeded(
  service: string,
  currentUsage: number,
  requestedCredits: number
): Promise<void> {
  try {
    // TODO: Insert into api_quota_events table when schema is updated
    console.log(
      `[ApiQuota] Logged quota exceeded: ${service} ` +
      `(${currentUsage} + ${requestedCredits})`
    );
  } catch (error) {
    console.error(`[ApiQuota] Failed to log quota exceeded:`, error);
  }
}

export function getQuotaStatus(): Record<string, any> {
  const status: Record<string, any> = {};
  for (const [name, quota] of quotas) {
    const percentUsed = (quota.monthlyUsage / quota.monthlyLimit * 100);
    const nextMonth = new Date(quota.lastResetDate);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);

    status[name] = {
      service: name,
      used: quota.monthlyUsage,
      limit: quota.monthlyLimit,
      circuitBreaker: quota.circuitBreakerAt,
      percentUsed: `${percentUsed.toFixed(1)}%`,
      remaining: quota.circuitBreakerAt - quota.monthlyUsage,
      circuitBreakerTriggered: quota.circuitBreakerTriggered,
      nextReset: nextMonth.toISOString(),
      status: quota.circuitBreakerTriggered ? "CIRCUIT_BREAKER_ACTIVE" :
              percentUsed > 85 ? "WARNING" : "OK",
    };
  }
  return status;
}

export function resetQuotaForService(service: string): void {
  const quota = quotas.get(service);
  if (!quota) throw new Error(`Unknown service: ${service}`);

  quota.monthlyUsage = 0;
  quota.lastResetDate = new Date();
  quota.circuitBreakerTriggered = false;
  console.log(`[ApiQuota] Manually reset quota for ${service}`);
}

export const shyftGrpcLimiter = new ShyftGrpcLimiter();
