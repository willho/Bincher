/**
 * Subscription Telemetry
 *
 * Tracks PumpFun and DexPaprika subscription capacity utilization,
 * rotation events, and deathbed decisions to identify bottlenecks.
 */

import { db } from "./db";

interface RotationEvent {
  timestamp: number;
  source: "pump_fun" | "dex_paprika";
  reason: "capacity_limit" | "manual" | "purge";
  deathbeddedTokenMint: string;
  deathbeddedTokenSymbol: string;
  quality_score: number; // Why this token was selected for removal
}

interface SubscriptionStats {
  timestamp: number;
  source: "pump_fun" | "dex_paprika";
  activeSubscriptions: number;
  maxCapacity: number;
  utilizationPercent: number;
  rotationsLastHour: number;
  rotationsLast24h: number;
}

// In-memory history (not persisted)
const rotationHistory: RotationEvent[] = [];
const subscriptionStats: SubscriptionStats[] = [];

const STATS_HISTORY_SIZE = 1000; // Keep last 1000 stat snapshots
const MAX_CAPACITY = {
  pump_fun: 5000,
  dex_paprika: 4000,
};

export function recordRotation(
  source: "pump_fun" | "dex_paprika",
  reason: "capacity_limit" | "manual" | "purge",
  tokenMint: string,
  tokenSymbol: string,
  quality_score: number
): void {
  const event: RotationEvent = {
    timestamp: Date.now(),
    source,
    reason,
    deathbeddedTokenMint: tokenMint,
    deathbeddedTokenSymbol: tokenSymbol,
    quality_score,
  };

  rotationHistory.push(event);

  // Keep history bounded
  if (rotationHistory.length > 10000) {
    rotationHistory.shift();
  }

  console.log(
    `[SubscriptionTelemetry] Rotation: ${source} removed ${tokenSymbol} (${tokenMint.slice(-4)}) ` +
    `[quality=${quality_score.toFixed(2)}, reason=${reason}]`
  );
}

export function recordSubscriptionSnapshot(
  source: "pump_fun" | "dex_paprika",
  activeCount: number
): void {
  const maxCapacity = MAX_CAPACITY[source];
  const utilizationPercent = (activeCount / maxCapacity) * 100;

  const now = Math.floor(Date.now() / 1000);
  const lastHourStart = now - 3600;
  const last24hStart = now - 86400;

  const rotationsLastHour = rotationHistory.filter(
    (e) => e.source === source && e.timestamp / 1000 >= lastHourStart
  ).length;

  const rotationsLast24h = rotationHistory.filter(
    (e) => e.source === source && e.timestamp / 1000 >= last24hStart
  ).length;

  const stats: SubscriptionStats = {
    timestamp: Date.now(),
    source,
    activeSubscriptions: activeCount,
    maxCapacity,
    utilizationPercent,
    rotationsLastHour,
    rotationsLast24h,
  };

  subscriptionStats.push(stats);

  // Keep history bounded
  if (subscriptionStats.length > STATS_HISTORY_SIZE) {
    subscriptionStats.shift();
  }

  // Log saturation warnings
  if (utilizationPercent > 90) {
    console.warn(
      `[SubscriptionTelemetry] ${source} saturation: ${activeCount}/${maxCapacity} (${utilizationPercent.toFixed(1)}%)`
    );
  }

  if (rotationsLastHour > 100) {
    console.warn(
      `[SubscriptionTelemetry] ${source} high rotation rate: ${rotationsLastHour} rotations/hour`
    );
  }
}

export function getRotationStats(source?: "pump_fun" | "dex_paprika"): {
  totalRotations: number;
  rotationsLastHour: number;
  rotationsLast24h: number;
  averageQualityScore: number;
  reasons: Record<string, number>;
} {
  const now = Math.floor(Date.now() / 1000);
  const lastHourStart = now - 3600;
  const last24hStart = now - 86400;

  let filtered = rotationHistory;
  if (source) {
    filtered = filtered.filter((e) => e.source === source);
  }

  const rotationsLastHour = filtered.filter((e) => e.timestamp / 1000 >= lastHourStart).length;
  const rotationsLast24h = filtered.filter((e) => e.timestamp / 1000 >= last24hStart).length;

  const avgQuality =
    filtered.length > 0
      ? filtered.reduce((sum, e) => sum + e.quality_score, 0) / filtered.length
      : 0;

  const reasons: Record<string, number> = {};
  filtered.forEach((e) => {
    reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  });

  return {
    totalRotations: filtered.length,
    rotationsLastHour,
    rotationsLast24h,
    averageQualityScore: avgQuality,
    reasons,
  };
}

export function getSubscriptionStatus(): {
  pump_fun: {
    activeCount: number;
    maxCapacity: number;
    utilizationPercent: number;
    rotationsLastHour: number;
    rotationsLast24h: number;
    saturation: "healthy" | "warning" | "critical";
  };
  dex_paprika: {
    activeCount: number;
    maxCapacity: number;
    utilizationPercent: number;
    rotationsLastHour: number;
    rotationsLast24h: number;
    saturation: "healthy" | "warning" | "critical";
  };
} {
  const getPumpStats = () => {
    const latest = subscriptionStats.filter((s) => s.source === "pump_fun").pop();
    if (!latest) {
      return {
        activeCount: 0,
        maxCapacity: MAX_CAPACITY.pump_fun,
        utilizationPercent: 0,
        rotationsLastHour: 0,
        rotationsLast24h: 0,
      };
    }

    let saturation: "healthy" | "warning" | "critical" = "healthy";
    if (latest.utilizationPercent > 90) saturation = "critical";
    else if (latest.utilizationPercent > 70) saturation = "warning";

    return {
      ...latest,
      saturation,
    };
  };

  const getDexStats = () => {
    const latest = subscriptionStats.filter((s) => s.source === "dex_paprika").pop();
    if (!latest) {
      return {
        activeCount: 0,
        maxCapacity: MAX_CAPACITY.dex_paprika,
        utilizationPercent: 0,
        rotationsLastHour: 0,
        rotationsLast24h: 0,
      };
    }

    let saturation: "healthy" | "warning" | "critical" = "healthy";
    if (latest.utilizationPercent > 90) saturation = "critical";
    else if (latest.utilizationPercent > 70) saturation = "warning";

    return {
      ...latest,
      saturation,
    };
  };

  return {
    pump_fun: getPumpStats(),
    dex_paprika: getDexStats(),
  };
}

export function getHealthReport(): {
  isHealthy: boolean;
  warnings: string[];
  metrics: {
    pump_fun_utilization: number;
    dex_paprika_utilization: number;
    total_rotations_last_hour: number;
    total_rotations_last_24h: number;
  };
} {
  const status = getSubscriptionStatus();
  const warnings: string[] = [];

  // Check for saturation
  if (status.pump_fun.saturation === "critical") {
    warnings.push(`PumpFun at ${status.pump_fun.utilizationPercent.toFixed(1)}% capacity`);
  }
  if (status.dex_paprika.saturation === "critical") {
    warnings.push(`DexPaprika at ${status.dex_paprika.utilizationPercent.toFixed(1)}% capacity`);
  }

  // Check for high rotation rate
  if (status.pump_fun.rotationsLastHour > 100) {
    warnings.push(`PumpFun high rotation: ${status.pump_fun.rotationsLastHour} in last hour`);
  }
  if (status.dex_paprika.rotationsLastHour > 100) {
    warnings.push(`DexPaprika high rotation: ${status.dex_paprika.rotationsLastHour} in last hour`);
  }

  const rotationStats = getRotationStats();

  return {
    isHealthy: warnings.length === 0,
    warnings,
    metrics: {
      pump_fun_utilization: status.pump_fun.utilizationPercent,
      dex_paprika_utilization: status.dex_paprika.utilizationPercent,
      total_rotations_last_hour: status.pump_fun.rotationsLastHour + status.dex_paprika.rotationsLastHour,
      total_rotations_last_24h: status.pump_fun.rotationsLast24h + status.dex_paprika.rotationsLast24h,
    },
  };
}
