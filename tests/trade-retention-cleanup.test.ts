import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../server/db";
import { rawTokenTrades } from "@shared/schema";
import { cleanupOldTrades, getTradeTableStats } from "../server/trade-retention-cleanup";
import { sql } from "drizzle-orm";

/**
 * Tests for Trade Retention Cleanup Job
 * Verifies old raw trades are properly deleted to prevent storage bloat
 */

describe("Trade Retention Cleanup", () => {
  const TEST_TOKEN_MINT = "test_mint_" + Date.now();
  const NOW = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86400;
  const TWO_DAYS = ONE_DAY * 2;
  const SEVEN_DAYS = ONE_DAY * 7;

  function generateMockTrade(
    tokenMint: string,
    timestamp: number,
    walletAddress: string = "wallet_" + Math.random()
  ) {
    return {
      signature: `sig_${tokenMint}_${timestamp}_${Math.random()}`,
      tokenMint,
      walletAddress,
      direction: Math.random() > 0.5 ? ("buy" as const) : ("sell" as const),
      amountSol: Math.random() * 10,
      amountTokens: Math.random() * 1000000,
      price: Math.random() * 0.0001,
      timestamp,
      createdAt: new Date(timestamp * 1000),
    };
  }

  beforeEach(async () => {
    // Clear any existing test trades
    await db.delete(rawTokenTrades).where(sql`token_mint LIKE ${"test_mint_%"}`);
  });

  afterEach(async () => {
    // Cleanup
    await db.delete(rawTokenTrades).where(sql`token_mint LIKE ${"test_mint_%"}`);
  });

  describe("cleanupOldTrades", () => {
    it("should delete trades older than specified days", async () => {
      // Insert trades at various ages
      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - TWO_DAYS - 1000), // Older than 2 days
        generateMockTrade(TEST_TOKEN_MINT, NOW - TWO_DAYS + 1000), // Newer than 2 days
        generateMockTrade(TEST_TOKEN_MINT, NOW - ONE_DAY), // 1 day old
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100), // < 1 day old
      ];

      await db.insert(rawTokenTrades).values(trades);

      // Verify all inserted
      let allTrades = await db.select().from(rawTokenTrades).where(
        sql`token_mint = ${TEST_TOKEN_MINT}`
      );
      expect(allTrades).toHaveLength(4);

      // Cleanup trades older than 2 days
      const result = await cleanupOldTrades(2);

      // Should have deleted at least 1 trade
      expect(result.deletedCount).toBeGreaterThanOrEqual(1);

      // Verify only recent trades remain
      allTrades = await db.select().from(rawTokenTrades).where(
        sql`token_mint = ${TEST_TOKEN_MINT}`
      );
      expect(allTrades.length).toBeLessThan(4);
    });

    it("should estimate storage cleaned correctly", async () => {
      // Insert 100 trades (100 bytes each)
      const trades = Array.from({ length: 100 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - TWO_DAYS - i)
      );

      await db.insert(rawTokenTrades).values(trades);

      const result = await cleanupOldTrades(1);

      // Should report storage cleaned
      expect(result.storageCleaned).toBeDefined();
      expect(result.storageCleaned).toMatch(/MB|GB|KB/);

      // Should show meaningful number
      expect(result.deletedCount).toBeGreaterThan(0);
    });

    it("should handle default maxAgeDays of 1 day", async () => {
      // Insert old trade
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, NOW - ONE_DAY - 1000),
      ]);

      // Call without parameter (should default to maxAgeDays=1)
      const result = await cleanupOldTrades();

      // Should have deleted the trade
      expect(result.deletedCount).toBeGreaterThan(0);
    });

    it("should not delete trades within retention window", async () => {
      // Insert recent trades (within 1 day)
      const trades = Array.from({ length: 10 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - i * 3600) // Hourly trades
      );

      await db.insert(rawTokenTrades).values(trades);

      // Cleanup with 1 day retention
      const result = await cleanupOldTrades(1);

      // Should not delete recent trades
      expect(result.deletedCount).toBe(0);

      // Verify all trades still exist
      const remaining = await db.select().from(rawTokenTrades).where(
        sql`token_mint = ${TEST_TOKEN_MINT}`
      );
      expect(remaining).toHaveLength(10);
    });

    it("should handle multiple tokens", async () => {
      const token1 = "test_mint_1_" + Date.now();
      const token2 = "test_mint_2_" + Date.now();

      // Insert old trades for both tokens
      await db.insert(rawTokenTrades).values([
        generateMockTrade(token1, NOW - TWO_DAYS),
        generateMockTrade(token1, NOW - TWO_DAYS - 100),
        generateMockTrade(token2, NOW - TWO_DAYS),
        generateMockTrade(token2, NOW - TWO_DAYS - 100),
      ]);

      const result = await cleanupOldTrades(1);

      // Should delete old trades from both tokens
      expect(result.deletedCount).toBeGreaterThanOrEqual(2);

      // Cleanup
      await db.delete(rawTokenTrades).where(sql`token_mint IN (${token1}, ${token2})`);
    });
  });

  describe("getTradeTableStats", () => {
    it("should return estimated row count", async () => {
      // Insert some trades
      const trades = Array.from({ length: 50 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - i * 60)
      );

      await db.insert(rawTokenTrades).values(trades);

      const stats = await getTradeTableStats();

      expect(stats.estimatedRowCount).toBeGreaterThan(0);
      expect(stats.estimatedSizeGB).toBeGreaterThan(0);
    });

    it("should return oldest trade age in hours", async () => {
      // Insert trades at known ages
      const hoursAgo = 5;
      const timestamp = NOW - hoursAgo * 3600;

      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, timestamp),
      ]);

      const stats = await getTradeTableStats();

      // Should report age close to 5 hours
      expect(stats.oldestTradeAgeHours).toBeGreaterThan(hoursAgo - 1);
      expect(stats.oldestTradeAgeHours).toBeLessThan(hoursAgo + 1);
    });

    it("should estimate size in GB for large datasets", async () => {
      // Insert 1000 trades
      const trades = Array.from({ length: 1000 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - i * 10)
      );

      // Insert in batches to avoid memory issues
      for (let i = 0; i < trades.length; i += 100) {
        const batch = trades.slice(i, i + 100);
        await db.insert(rawTokenTrades).values(batch);
      }

      const stats = await getTradeTableStats();

      // With 1000 trades × 100 bytes = ~100KB
      // Estimate should be in reasonable range
      expect(stats.estimatedSizeGB).toBeGreaterThan(0);
      expect(stats.estimatedSizeGB).toBeLessThan(1); // Should be < 1GB
    });

    it("should handle empty table gracefully", async () => {
      // Ensure no trades for test mint
      await db.delete(rawTokenTrades).where(sql`token_mint LIKE ${"test_mint_%"}`);

      const stats = await getTradeTableStats();

      expect(stats.estimatedRowCount).toBeDefined();
      expect(stats.estimatedSizeGB).toBeDefined();
      expect(stats.oldestTradeAgeHours).toBeDefined();
      // Can be 0 for empty table
      expect(stats.oldestTradeAgeHours).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Storage Strategy", () => {
    it("should maintain sliding 1-day window", async () => {
      // Simulate one day of trading with multiple tokens
      const tokens = Array.from({ length: 5 }, (_, i) => `token_${i}_${Date.now()}`);
      const trades = [];

      tokens.forEach((token) => {
        // Add 10 trades per token at various times during the day
        for (let i = 0; i < 10; i++) {
          trades.push(generateMockTrade(token, NOW - i * 3600)); // Hourly trades
        }
      });

      await db.insert(rawTokenTrades).values(trades);

      // Cleanup at end of day
      const result = await cleanupOldTrades(1);

      // No trades should be deleted (all within 24h)
      expect(result.deletedCount).toBe(0);

      // Simulate next day
      trades.forEach((t) => {
        t.timestamp = NOW - ONE_DAY - 1;
        t.createdAt = new Date((NOW - ONE_DAY - 1) * 1000);
      });

      await db.insert(rawTokenTrades).values(trades);

      // Next cleanup should delete day 1 trades
      const result2 = await cleanupOldTrades(1);
      expect(result2.deletedCount).toBeGreaterThan(0);

      // Cleanup
      tokens.forEach((token) => {
        db.delete(rawTokenTrades).where(sql`token_mint = ${token}`);
      });
    });

    it("should provide storage reduction metrics", async () => {
      // Insert 500 trades (represents ~50KB)
      const trades = Array.from({ length: 500 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - TWO_DAYS - i * 10)
      );

      await db.insert(rawTokenTrades).values(trades);

      const result = await cleanupOldTrades(1);

      expect(result.deletedCount).toBeGreaterThan(0);

      // Storage should be reported
      const storageSaved = result.storageCleaned;
      expect(storageSaved).toMatch(/(\d+\.?\d*)\s*(MB|GB|KB)/);

      // Extract number from string like "50.0 MB"
      const match = storageSaved.match(/(\d+\.?\d*)/);
      if (match) {
        const amount = parseFloat(match[1]);
        expect(amount).toBeGreaterThan(0);
      }
    });
  });
});
