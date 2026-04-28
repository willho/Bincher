import { db } from "./db";
import { tokenDataPool } from "@shared/schema";
import { eq, desc, lte, and, not } from "drizzle-orm";

/**
 * Monitoring Capacity Manager
 *
 * Tracks how many tokens we're actively monitoring and manages capacity
 * by automatically deathbedding tokens when usage approaches limits.
 *
 * Strategy:
 * - Keep all non-deathbed tokens monitored (via WebSocket subscriptions)
 * - When capacity reaches 85%, start deathbedding lowest-volume tokens
 * - Priority: deathbed already-dead tokens first (< 0.001x), then lowest-volume
 * - This frees up WebSocket slots and API quota for new promising tokens
 */

interface CapacityStatus {
  activeTokensCount: number;
  capacityTarget: number; // how many we can monitor simultaneously
  capacityPercent: number; // (activeTokensCount / capacityTarget) * 100
  isAtCapacity: boolean; // >= 85%
  needsCapacityManagement: boolean; // > 85%
}

// Estimate based on WebSocket 200 msg/sec limit and typical token activity
// Safe estimate: monitor ~300-500 tokens at once with rotating activity
// Conservative target: 400 tokens
const CAPACITY_TARGET = 400;
const CAPACITY_THRESHOLD_PERCENT = 85;
const CAPACITY_EMERGENCY_PERCENT = 95;

/**
 * Check current monitoring capacity status
 */
export async function getCapacityStatus(): Promise<CapacityStatus> {
  try {
    // Count active (non-deathbed) tokens
    const activeTokens = await db
      .select({ tokenMint: tokenDataPool.tokenMint })
      .from(tokenDataPool)
      .where(not(eq(tokenDataPool.isDeathbed, true)));

    const activeTokensCount = activeTokens.length;
    const capacityPercent = (activeTokensCount / CAPACITY_TARGET) * 100;

    return {
      activeTokensCount,
      capacityTarget: CAPACITY_TARGET,
      capacityPercent,
      isAtCapacity: capacityPercent >= CAPACITY_THRESHOLD_PERCENT,
      needsCapacityManagement: capacityPercent > CAPACITY_THRESHOLD_PERCENT,
    };
  } catch (error) {
    console.error("[MonitoringCapacity] Error checking capacity:", error instanceof Error ? error.message : error);
    return {
      activeTokensCount: 0,
      capacityTarget: CAPACITY_TARGET,
      capacityPercent: 0,
      isAtCapacity: false,
      needsCapacityManagement: false,
    };
  }
}

/**
 * Auto-deathbed tokens when capacity is tight (>85%)
 * Priority: Already-dead tokens first, then lowest-volume tokens
 *
 * Returns: number of tokens deathbedded
 */
export async function deathbedTokensIfNeeded(targetFreeCount: number = 50): Promise<number> {
  const status = await getCapacityStatus();

  if (!status.needsCapacityManagement) {
    return 0; // No action needed
  }

  console.log(
    `[MonitoringCapacity] Capacity at ${status.capacityPercent.toFixed(1)}% ` +
    `(${status.activeTokensCount}/${status.capacityTarget}). Deathbedding tokens to free capacity...`
  );

  let deathbeddedCount = 0;
  const now = Math.floor(Date.now() / 1000);

  try {
    // Priority 1: Already-identified dead tokens (volume24h is essentially zero)
    // These are truly dead and won't generate more activity
    const deadTokens = await db
      .select({ tokenMint: tokenDataPool.tokenMint })
      .from(tokenDataPool)
      .where(
        and(
          not(eq(tokenDataPool.isDeathbed, true)), // Not already deathbed
          lte(tokenDataPool.volume24h, 0.001) // No meaningful volume in 24h
        )
      )
      .limit(targetFreeCount);

    if (deadTokens.length > 0) {
      for (const token of deadTokens) {
        await db
          .update(tokenDataPool)
          .set({
            isDeathbed: true,
            deathbedDetectedAt: now,
          })
          .where(eq(tokenDataPool.tokenMint, token.tokenMint));
      }

      deathbeddedCount = deadTokens.length;
      console.log(
        `[MonitoringCapacity] Deathbedded ${deathbeddedCount} zero-volume tokens`
      );
    }

    // Priority 2: If more space still needed, deathbed lowest-volume tokens
    // These haven't shown promising activity, so free up their monitoring slots
    if (deathbeddedCount < targetFreeCount) {
      const spaceLimitNeeded = targetFreeCount - deathbeddedCount;
      const lowVolumeTokens = await db
        .select({ tokenMint: tokenDataPool.tokenMint, volume24h: tokenDataPool.volume24h })
        .from(tokenDataPool)
        .where(
          and(
            not(eq(tokenDataPool.isDeathbed, true)),
            // Exclude already-truly-dead ones (handled above)
            // ... but we can include lower multipliers since we already got <0.001x
          )
        )
        .orderBy(desc(tokenDataPool.volume24h)) // Start from lowest volume
        .limit(spaceLimitNeeded);

      if (lowVolumeTokens.length > 0) {
        // Update each low-volume token individually to mark as deathbed
        for (const token of lowVolumeTokens) {
          await db
            .update(tokenDataPool)
            .set({
              isDeathbed: true,
              deathbedDetectedAt: now,
            })
            .where(eq(tokenDataPool.tokenMint, token.tokenMint));
        }

        deathbeddedCount += lowVolumeTokens.length;
        console.log(
          `[MonitoringCapacity] Deathbedded ${lowVolumeTokens.length} low-volume tokens ` +
          `(avg volume: ${(
            lowVolumeTokens.reduce((sum, t) => sum + (t.volume24h || 0), 0) /
            lowVolumeTokens.length
          ).toFixed(2)} SOL)`
        );
      }
    }

    // Log new capacity status
    const newStatus = await getCapacityStatus();
    console.log(
      `[MonitoringCapacity] Capacity after deathbedding: ${newStatus.capacityPercent.toFixed(1)}% ` +
      `(${newStatus.activeTokensCount}/${newStatus.capacityTarget})`
    );
  } catch (error) {
    console.error("[MonitoringCapacity] Error deathbedding tokens:", error instanceof Error ? error.message : error);
  }

  return deathbeddedCount;
}

/**
 * Called periodically (e.g., every 10 minutes) to monitor and manage capacity
 * Returns status and actions taken
 */
export async function checkAndManageCapacity(): Promise<{
  status: CapacityStatus;
  deathbeddedCount: number;
  actionTaken: string;
}> {
  const status = await getCapacityStatus();

  let deathbeddedCount = 0;
  let actionTaken = "none";

  // If over 85%, start deathbedding
  if (status.needsCapacityManagement) {
    // Calculate how many slots to free up to get back to 75% capacity
    const targetCapacityPercent = 75;
    const targetActiveTokens = Math.floor(CAPACITY_TARGET * (targetCapacityPercent / 100));
    const tokensToFree = Math.max(50, status.activeTokensCount - targetActiveTokens);

    deathbeddedCount = await deathbedTokensIfNeeded(tokensToFree);
    actionTaken = deathbeddedCount > 0 ? `deathbedded_${deathbeddedCount}` : "attempted_deathbed_no_tokens";
  }

  return {
    status,
    deathbeddedCount,
    actionTaken,
  };
}

/**
 * Get tokens eligible for monitoring (not deathbed)
 * Used by discovery engine to rotate which tokens to monitor
 */
export async function getMonitorableTokens(): Promise<
  Array<{
    tokenMint: string;
    volume24h: number | null;
    lastSnapshotAt: number | null;
  }>
> {
  try {
    return await db
      .select({
        tokenMint: tokenDataPool.tokenMint,
        volume24h: tokenDataPool.volume24h,
        lastSnapshotAt: tokenDataPool.lastSnapshotAt,
      })
      .from(tokenDataPool)
      .where(not(eq(tokenDataPool.isDeathbed, true)))
      .orderBy(desc(tokenDataPool.volume24h)) // Prioritize high-volume tokens
      .limit(CAPACITY_TARGET);
  } catch (error) {
    console.error("[MonitoringCapacity] Error getting monitorable tokens:", error instanceof Error ? error.message : error);
    return [];
  }
}
