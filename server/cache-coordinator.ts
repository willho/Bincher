/**
 * Cache Coordinator
 *
 * Manages memory-cache ↔ database coherence:
 * - Invalidation signals when DB changes
 * - Write-through consistency
 * - Multi-instance cache coordination (via DB)
 * - Startup recovery from crashes
 */

import { db } from "./db";
import { cacheInvalidationLog } from "@shared/schema";
import { eq, gte, desc } from "drizzle-orm";

export interface CacheInvalidation {
  scope: "token" | "wallet" | "outcome" | "cluster" | "all";
  targetId?: string; // mint, wallet address, etc.
  reason: string;
  triggeredBy: string; // "retrolearner", "discovery-engine", "manual", etc.
  invalidatedAt: number;
}

/**
 * Track what's cached and when it was last written
 */
export class CacheCoordinator {
  private lastWriteTime: Map<string, number> = new Map(); // "token:mint" → timestamp
  private invalidationListeners: Map<string, Set<() => void>> = new Map();
  private startupRecoveryDone = false;

  /**
   * On startup: recover from crash
   * Check last known flush time vs current time
   */
  async startupRecovery(): Promise<void> {
    if (this.startupRecoveryDone) return;

    const lastInvalidation = await db
      .select()
      .from(cacheInvalidationLog)
      .orderBy(desc(cacheInvalidationLog.invalidatedAt))
      .limit(1);

    if (lastInvalidation.length > 0) {
      const lastFlushTime = lastInvalidation[0].invalidatedAt;
      const nowTime = Math.floor(Date.now() / 1000);
      const gapSeconds = nowTime - lastFlushTime;

      if (gapSeconds > 60) {
        console.warn(
          `[CacheCoordinator] Startup recovery: gap of ${gapSeconds}s since last flush. ` +
          `Data from ${gapSeconds}s ago lost (acceptable in Option B).`
        );
      }

      // Mark that we've recovered
      this.startupRecoveryDone = true;
      console.log("[CacheCoordinator] Startup recovery complete");
    }
  }

  /**
   * Register a cache write
   * Tracks when specific data was written to DB
   */
  registerWrite(scope: string, targetId?: string): void {
    const key = targetId ? `${scope}:${targetId}` : scope;
    this.lastWriteTime.set(key, Math.floor(Date.now() / 1000));
  }

  /**
   * Signal that cached data is stale and needs invalidation
   * Broadcast to all listeners in this instance
   */
  invalidate(invalidation: CacheInvalidation): void {
    // Log to DB for multi-instance coordination
    this.logInvalidation(invalidation);

    // Broadcast to local listeners
    if (invalidation.scope === "token" && invalidation.targetId) {
      const key = `token:${invalidation.targetId}`;
      this.notifyListeners(key);
    } else if (invalidation.scope === "wallet" && invalidation.targetId) {
      const key = `wallet:${invalidation.targetId}`;
      this.notifyListeners(key);
    } else if (invalidation.scope === "outcome") {
      this.notifyListeners("outcome:all");
    } else if (invalidation.scope === "all") {
      this.notifyListeners("cache:all");
    }
  }

  /**
   * Listen for cache invalidation on a specific scope
   */
  onInvalidate(
    scope: string,
    targetId: string | undefined,
    callback: () => void
  ): () => void {
    const key = targetId ? `${scope}:${targetId}` : scope;

    if (!this.invalidationListeners.has(key)) {
      this.invalidationListeners.set(key, new Set());
    }

    this.invalidationListeners.get(key)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.invalidationListeners.get(key)!.delete(callback);
    };
  }

  /**
   * Check if cached data is fresh
   */
  isCacheFresh(scope: string, targetId?: string, maxAgeSeconds: number = 60): boolean {
    const key = targetId ? `${scope}:${targetId}` : scope;
    const lastWrite = this.lastWriteTime.get(key);

    if (!lastWrite) return false; // Never written = cold cache

    const ageSec = Math.floor(Date.now() / 1000) - lastWrite;
    return ageSec <= maxAgeSeconds;
  }

  /**
   * Get age of cached item
   */
  getCacheAge(scope: string, targetId?: string): number {
    const key = targetId ? `${scope}:${targetId}` : scope;
    const lastWrite = this.lastWriteTime.get(key);

    if (!lastWrite) return -1;

    return Math.floor(Date.now() / 1000) - lastWrite;
  }

  /**
   * Log invalidation to DB for multi-instance coordination
   */
  private async logInvalidation(invalidation: CacheInvalidation): Promise<void> {
    try {
      await db.insert(cacheInvalidationLog).values({
        scope: invalidation.scope,
        targetId: invalidation.targetId,
        reason: invalidation.reason,
        triggeredBy: invalidation.triggeredBy,
        invalidatedAt: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      console.error("[CacheCoordinator] Failed to log invalidation:", error);
    }
  }

  /**
   * Notify all listeners for a scope
   */
  private notifyListeners(key: string): void {
    const listeners = this.invalidationListeners.get(key);
    if (!listeners) return;

    for (const callback of listeners) {
      try {
        callback();
      } catch (error) {
        console.error(`[CacheCoordinator] Listener error for ${key}:`, error);
      }
    }
  }

  /**
   * Poll for invalidations from other instances (if multi-instance)
   * Run this periodically to catch external writes
   */
  async pollForExternalInvalidations(sinceSeconds: number = 60): Promise<void> {
    const cutoffTime = Math.floor(Date.now() / 1000) - sinceSeconds;

    const recentInvalidations = await db
      .select()
      .from(cacheInvalidationLog)
      .where(gte(cacheInvalidationLog.invalidatedAt, cutoffTime));

    for (const inv of recentInvalidations) {
      this.invalidate({
        scope: inv.scope as any,
        targetId: inv.targetId || undefined,
        reason: inv.reason || "external_write",
        triggeredBy: inv.triggeredBy || "unknown",
        invalidatedAt: inv.invalidatedAt,
      });
    }
  }

  /**
   * Clear all cache state (for testing or manual reset)
   */
  clearAll(): void {
    this.lastWriteTime.clear();
    this.invalidationListeners.clear();
    this.invalidate({
      scope: "all",
      reason: "manual_clear",
      triggeredBy: "cache-coordinator",
      invalidatedAt: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Get cache stats
   */
  getStats() {
    return {
      trackedItems: this.lastWriteTime.size,
      listeners: Array.from(this.invalidationListeners.entries()).map(([key, set]) => ({
        key,
        listenerCount: set.size,
      })),
      startupRecoveryDone: this.startupRecoveryDone,
    };
  }
}

// Singleton instance
export const cacheCoordinator = new CacheCoordinator();
