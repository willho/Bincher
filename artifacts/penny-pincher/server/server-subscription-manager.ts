// @ts-nocheck
import { db } from "./db";
import { serverSubscriptions } from "../shared/schema";
import { sql, eq, and } from "drizzle-orm";

/**
 * Server Subscription Manager
 *
 * Handles DB-driven 2/3 mesh coverage assignment for 3-server architecture.
 * Each server independently queries for its assigned subscriptions.
 *
 * Architecture:
 * - Pincher2, Proxy-1, Proxy-2 each subscribe to 2/3 of tokens/wallets
 * - 2/3 overlap creates redundancy: if 1 server down, ~67% coverage continues
 * - DB constraints prevent duplicate subscriptions per server
 */

export interface SubscriptionAssignment {
  tokenMints: string[];
  walletAddresses: string[];
  allSubscriptions: any[];
}

export class ServerSubscriptionManager {
  private serverName: string;
  private rateLimitByType: Record<string, number> = {
    newtoken: 175, // msg/sec per server (3 × 175 = 525 total, ~1.5x data volume)
    migration: 175,
    wallet_trade: 175,
  };

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  /**
   * Get all subscriptions assigned to this server
   */
  async getMySubscriptions(): Promise<SubscriptionAssignment> {
    try {
      const subscriptions = await db
        .select()
        .from(serverSubscriptions)
        .where(eq(serverSubscriptions.serverName, this.serverName))
        .execute();

      const tokenMints = [
        ...new Set(
          subscriptions
            .filter((s) => s.tokenMint && s.subscriptionType !== "wallet_trade")
            .map((s) => s.tokenMint!)
        ),
      ];

      const walletAddresses = [
        ...new Set(
          subscriptions
            .filter((s) => s.walletAddress && s.subscriptionType === "wallet_trade")
            .map((s) => s.walletAddress!)
        ),
      ];

      return {
        tokenMints,
        walletAddresses,
        allSubscriptions: subscriptions,
      };
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to get subscriptions for ${this.serverName}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Assign new tokens to servers (2/3 coverage pattern)
   * Distributes 3 new tokens across servers: each server gets 2 of 3
   *
   * Example: tokens [A, B, C]
   * - Pincher2: [A, B]
   * - Proxy-1: [B, C]
   * - Proxy-2: [C, A]
   * Result: 2/3 overlap, each token monitored by exactly 2 servers
   */
  async assignNewTokens(newTokenMints: string[]): Promise<void> {
    const servers = ["pincher2", "proxy-1", "proxy-2"];

    try {
      for (let i = 0; i < newTokenMints.length; i++) {
        const tokenMint = newTokenMints[i];

        // Determine which 2 servers monitor this token (2/3 pattern)
        // Using modulo to create rotation: each server handles 2/3 of tokens
        const serverIndices = [(i + 0) % 3, (i + 1) % 3]; // Skip one server
        const assignedServers = serverIndices.map((idx) => servers[idx]);

        // Insert subscription for each assigned server
        for (const serverName of assignedServers) {
          const dedup = `${serverName}|${tokenMint}||newtoken`;

          await db
            .insert(serverSubscriptions)
            .values({
              serverName,
              tokenMint,
              subscriptionType: "newtoken",
              assignedAt: Math.floor(Date.now() / 1000),
              status: "active",
              deduplicationKey: dedup,
            })
            .onConflictDoNothing()
            .execute();
        }
      }

      console.log(
        `[ServerSubscriptionManager] Assigned ${newTokenMints.length} tokens with 2/3 coverage`
      );
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to assign new tokens:`,
        error
      );
      throw error;
    }
  }

  /**
   * Assign wallet addresses for monitoring (2/3 coverage)
   */
  async assignWallets(walletAddresses: string[]): Promise<void> {
    const servers = ["pincher2", "proxy-1", "proxy-2"];

    try {
      for (let i = 0; i < walletAddresses.length; i++) {
        const walletAddress = walletAddresses[i];

        // 2/3 coverage pattern (same as tokens)
        const serverIndices = [(i + 0) % 3, (i + 1) % 3];
        const assignedServers = serverIndices.map((idx) => servers[idx]);

        for (const serverName of assignedServers) {
          const dedup = `${serverName}||${walletAddress}|wallet_trade`;

          await db
            .insert(serverSubscriptions)
            .values({
              serverName,
              walletAddress,
              subscriptionType: "wallet_trade",
              assignedAt: Math.floor(Date.now() / 1000),
              status: "active",
              deduplicationKey: dedup,
            })
            .onConflictDoNothing()
            .execute();
        }
      }

      console.log(
        `[ServerSubscriptionManager] Assigned ${walletAddresses.length} wallets with 2/3 coverage`
      );
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to assign wallets:`,
        error
      );
      throw error;
    }
  }

  /**
   * Mark subscription as failed, increment failure counter
   * Implements circuit breaker: after 3 failures, pause for 60s
   */
  async recordSubscriptionFailure(
    tokenMint?: string,
    walletAddress?: string,
    subscriptionType?: string
  ): Promise<void> {
    try {
      const subscription = await db
        .select()
        .from(serverSubscriptions)
        .where(
          and(
            eq(serverSubscriptions.serverName, this.serverName),
            tokenMint ? eq(serverSubscriptions.tokenMint, tokenMint) : undefined,
            walletAddress
              ? eq(serverSubscriptions.walletAddress, walletAddress)
              : undefined,
            subscriptionType
              ? eq(serverSubscriptions.subscriptionType, subscriptionType)
              : undefined
          )
        )
        .limit(1)
        .execute();

      if (!subscription.length) return;

      const sub = subscription[0];
      const newFailureCount = (sub.consecutiveFailures || 0) + 1;
      let newStatus = "reconnecting";
      let circuitBreakerUntil: number | null = sub.circuitBreakerUntil;

      // Circuit breaker: after 3 failures, pause for 60s
      if (newFailureCount >= 3) {
        newStatus = "paused";
        circuitBreakerUntil = Math.floor(Date.now() / 1000) + 60; // 60 second pause
        console.warn(
          `[ServerSubscriptionManager] Circuit breaker activated for ${this.serverName} ` +
            `(${tokenMint || walletAddress}) - pausing for 60s`
        );
      }

      await db
        .update(serverSubscriptions)
        .set({
          consecutiveFailures: newFailureCount,
          status: newStatus,
          circuitBreakerUntil,
          lastFailureAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(serverSubscriptions.id, sub.id))
        .execute();
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to record subscription failure:`,
        error
      );
    }
  }

  /**
   * Mark subscription as successful, reset failure counter
   */
  async recordSubscriptionSuccess(
    tokenMint?: string,
    walletAddress?: string,
    subscriptionType?: string
  ): Promise<void> {
    try {
      const subscription = await db
        .select()
        .from(serverSubscriptions)
        .where(
          and(
            eq(serverSubscriptions.serverName, this.serverName),
            tokenMint ? eq(serverSubscriptions.tokenMint, tokenMint) : undefined,
            walletAddress
              ? eq(serverSubscriptions.walletAddress, walletAddress)
              : undefined,
            subscriptionType
              ? eq(serverSubscriptions.subscriptionType, subscriptionType)
              : undefined
          )
        )
        .limit(1)
        .execute();

      if (!subscription.length) return;

      await db
        .update(serverSubscriptions)
        .set({
          consecutiveFailures: 0,
          status: "active",
          circuitBreakerUntil: null,
          lastRetryAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(serverSubscriptions.id, subscription[0].id))
        .execute();
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to record subscription success:`,
        error
      );
    }
  }

  /**
   * Check if subscription can reconnect (circuit breaker logic)
   */
  async canReconnect(
    tokenMint?: string,
    walletAddress?: string,
    subscriptionType?: string
  ): Promise<boolean> {
    try {
      const subscription = await db
        .select()
        .from(serverSubscriptions)
        .where(
          and(
            eq(serverSubscriptions.serverName, this.serverName),
            tokenMint ? eq(serverSubscriptions.tokenMint, tokenMint) : undefined,
            walletAddress
              ? eq(serverSubscriptions.walletAddress, walletAddress)
              : undefined,
            subscriptionType
              ? eq(serverSubscriptions.subscriptionType, subscriptionType)
              : undefined
          )
        )
        .limit(1)
        .execute();

      if (!subscription.length) return true;

      const sub = subscription[0];

      // Check circuit breaker
      if (
        sub.circuitBreakerUntil &&
        sub.circuitBreakerUntil > Math.floor(Date.now() / 1000)
      ) {
        return false; // Still paused
      }

      return true;
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to check reconnect status:`,
        error
      );
      return false;
    }
  }

  /**
   * Get subscriptions that need reconnection (failed, paused, or circuit breaker expired)
   */
  async getSubscriptionsNeedingReconnection(
    subscriptionType?: string
  ): Promise<any[]> {
    try {
      const now = Math.floor(Date.now() / 1000);

      let query = db
        .select()
        .from(serverSubscriptions)
        .where(eq(serverSubscriptions.serverName, this.serverName));

      if (subscriptionType) {
        query = query.where(
          eq(serverSubscriptions.subscriptionType, subscriptionType)
        );
      }

      const allSubs = await query.execute();

      // Filter for those needing reconnection
      return allSubs.filter((sub) => {
        // Failed subscriptions
        if (sub.status === "reconnecting") return true;

        // Circuit breaker expired subscriptions
        if (sub.status === "paused" && sub.circuitBreakerUntil! <= now) {
          return true;
        }

        return false;
      });
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to get subscriptions needing reconnection:`,
        error
      );
      return [];
    }
  }

  /**
   * Get stats on current subscriptions
   */
  async getStats(): Promise<any> {
    try {
      const subscriptions = await db
        .select()
        .from(serverSubscriptions)
        .where(eq(serverSubscriptions.serverName, this.serverName))
        .execute();

      const active = subscriptions.filter((s) => s.status === "active").length;
      const reconnecting = subscriptions.filter(
        (s) => s.status === "reconnecting"
      ).length;
      const paused = subscriptions.filter((s) => s.status === "paused").length;
      const failed = subscriptions.filter((s) => s.status === "failed").length;

      const tokens = [
        ...new Set(
          subscriptions
            .filter((s) => s.tokenMint && s.subscriptionType !== "wallet_trade")
            .map((s) => s.tokenMint!)
        ),
      ].length;

      const wallets = [
        ...new Set(
          subscriptions
            .filter((s) => s.walletAddress && s.subscriptionType === "wallet_trade")
            .map((s) => s.walletAddress!)
        ),
      ].length;

      return {
        serverName: this.serverName,
        total: subscriptions.length,
        active,
        reconnecting,
        paused,
        failed,
        uniqueTokens: tokens,
        uniqueWallets: wallets,
      };
    } catch (error) {
      console.error(
        `[ServerSubscriptionManager] Failed to get stats:`,
        error
      );
      return null;
    }
  }
}
