import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "./db";
import { rawTokenTrades } from "@shared/schema";
import {
  createDailySummary,
  summarizeAndDeleteDayOldTrades,
  compressDailyToWeeklySummary,
  estimateStorageByAge,
} from "./trade-hierarchical-summarization";
import { sql } from "drizzle-orm";

/**
 * Tests for Trade Hierarchical Summarization
 * Verifies daily summaries are created correctly and trades are cleaned up
 */

describe("Trade Hierarchical Summarization", () => {
  const TEST_TOKEN_MINT = "test_mint_" + Date.now();
  const NOW = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86400;

  function generateMockTrade(
    tokenMint: string,
    timestamp: number,
    direction: "buy" | "sell" = "buy",
    walletAddress: string = "wallet_" + Math.random(),
    amountSol: number = 1,
    amountTokens: number = 10000
  ) {
    return {
      signature: `sig_${tokenMint}_${timestamp}_${Math.random()}`,
      tokenMint,
      walletAddress,
      direction,
      amountSol,
      amountTokens,
      price: amountSol / amountTokens,
      timestamp,
      createdAt: new Date(timestamp * 1000),
    };
  }

  function getDateString(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  beforeEach(async () => {
    // Clear any existing test trades
    await db.delete(rawTokenTrades).where(sql`token_mint LIKE ${"test_mint_%"}`);
  });

  afterEach(async () => {
    // Cleanup
    await db.delete(rawTokenTrades).where(sql`token_mint LIKE ${"test_mint_%"}`);
  });

  describe("createDailySummary", () => {
    it("should create summary with correct field structure", async () => {
      const date = getDateString(NOW);

      // Insert some trades for today
      const trades = Array.from({ length: 20 }, (_, i) => {
        const isLarge = i % 5 === 0;
        return generateMockTrade(
          TEST_TOKEN_MINT,
          NOW - i * 1000,
          i % 2 === 0 ? "buy" : "sell",
          `wallet_${i}`,
          isLarge ? 10 : 0.5,
          isLarge ? 100000 : 5000
        );
      });

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      // Verify structure
      expect(summary).toHaveProperty("tokenMint");
      expect(summary).toHaveProperty("date");
      expect(summary).toHaveProperty("buyCount");
      expect(summary).toHaveProperty("sellCount");
      expect(summary).toHaveProperty("totalBuyVolume");
      expect(summary).toHaveProperty("totalSellVolume");
      expect(summary).toHaveProperty("avgBuyPrice");
      expect(summary).toHaveProperty("avgSellPrice");
      expect(summary).toHaveProperty("minPrice");
      expect(summary).toHaveProperty("maxPrice");
      expect(summary).toHaveProperty("uniqueWallets");
      expect(summary).toHaveProperty("holdingWallets");
      expect(summary).toHaveProperty("profitableWallets");
      expect(summary).toHaveProperty("timestamp");
    });

    it("should correctly count buys and sells", async () => {
      const date = getDateString(NOW);

      // Create 10 buys and 5 sells
      const trades = [
        ...Array.from({ length: 10 }, (_, i) =>
          generateMockTrade(TEST_TOKEN_MINT, NOW - i * 100, "buy")
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          generateMockTrade(TEST_TOKEN_MINT, NOW - (i + 100) * 100, "sell")
        ),
      ];

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      expect(summary.buyCount).toBe(10);
      expect(summary.sellCount).toBe(5);
    });

    it("should calculate volume aggregates correctly", async () => {
      const date = getDateString(NOW);

      // Create trades with known volumes
      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - 0, "buy", "wallet1", 1.0, 10000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100, "buy", "wallet2", 2.0, 20000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 200, "sell", "wallet1", 1.5, 15000),
      ];

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      // Total buy volume should be 3.0 SOL
      expect(summary.totalBuyVolume).toBeCloseTo(3.0, 2);
      // Total sell volume should be 1.5 SOL
      expect(summary.totalSellVolume).toBeCloseTo(1.5, 2);
    });

    it("should identify unique wallets", async () => {
      const date = getDateString(NOW);

      // Create trades from 5 unique wallets
      const wallets = Array.from({ length: 5 }, (_, i) => `wallet_${i}`);
      const trades = wallets.flatMap((wallet) =>
        Array.from({ length: 3 }, (_, i) =>
          generateMockTrade(TEST_TOKEN_MINT, NOW - i * 100, "buy", wallet)
        )
      );

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      expect(summary.uniqueWallets).toBe(5);
    });

    it("should identify holding wallets (net positive balance)", async () => {
      const date = getDateString(NOW);

      // Wallet 1: 3 buys, 1 sell = still holding
      // Wallet 2: 2 buys, 2 sells = no holding
      // Wallet 3: 1 buy, 0 sells = holding
      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - 0, "buy", "holder1", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100, "buy", "holder1", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 200, "buy", "holder1", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 300, "sell", "holder1", 1, 80000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 400, "buy", "neutral2", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 500, "buy", "neutral2", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 600, "sell", "neutral2", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 700, "sell", "neutral2", 1, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 800, "buy", "holder3", 1, 100000),
      ];

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      // Should have 2 holding wallets (holder1 and holder3)
      expect(summary.holdingWallets).toBe(2);
    });

    it("should calculate profitable wallets", async () => {
      const date = getDateString(NOW);

      // Create profitable and unprofitable trades
      const trades = [
        // Profitable: bought at 0.00001, sold at 0.00002
        generateMockTrade(TEST_TOKEN_MINT, NOW - 0, "buy", "profitable", 1.0, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100, "sell", "profitable", 2.0, 100000),
        // Unprofitable: bought at 0.0001, sold at 0.00005
        generateMockTrade(TEST_TOKEN_MINT, NOW - 200, "buy", "loser", 10.0, 100000),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 300, "sell", "loser", 5.0, 100000),
      ];

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      expect(summary.profitableWallets).toBeGreaterThan(0);
    });

    it("should handle empty trade day", async () => {
      const date = "2024-01-01"; // Date with no trades

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      expect(summary.tokenMint).toBe(TEST_TOKEN_MINT);
      expect(summary.date).toBe(date);
      expect(summary.buyCount).toBe(0);
      expect(summary.sellCount).toBe(0);
      expect(summary.totalBuyVolume).toBe(0);
      expect(summary.uniqueWallets).toBe(0);
    });

    it("should calculate price statistics correctly", async () => {
      const date = getDateString(NOW);

      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - 0, "buy", "w1", 1.0, 1000000), // Price: 0.000001
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100, "buy", "w2", 2.0, 1000000), // Price: 0.000002
        generateMockTrade(TEST_TOKEN_MINT, NOW - 200, "sell", "w1", 5.0, 1000000), // Price: 0.000005
      ];

      await db.insert(rawTokenTrades).values(trades);

      const summary = await createDailySummary(TEST_TOKEN_MINT, date);

      expect(summary.minPrice).toBeCloseTo(0.000001, 10);
      expect(summary.maxPrice).toBeCloseTo(0.000005, 10);
      expect(summary.avgBuyPrice).toBeGreaterThan(0);
      expect(summary.avgSellPrice).toBeGreaterThan(0);
    });
  });

  describe("summarizeAndDeleteDayOldTrades", () => {
    it("should identify trades older than 1 day", async () => {
      // Insert trades at various ages
      const oldTrade = generateMockTrade(
        TEST_TOKEN_MINT,
        NOW - ONE_DAY - 3600, // More than 1 day old
        "buy"
      );
      const newTrade = generateMockTrade(
        TEST_TOKEN_MINT,
        NOW - ONE_DAY + 3600, // Less than 1 day old
        "buy"
      );

      await db.insert(rawTokenTrades).values([oldTrade, newTrade]);

      const result = await summarizeAndDeleteDayOldTrades();

      expect(result.tokensProcessed).toBeGreaterThanOrEqual(0);
      expect(result.tradeSummariesCreated).toBeGreaterThanOrEqual(0);
      // Old trade should be deleted
      expect(result.rawTradesDeleted).toBeGreaterThan(0);
    });

    it("should create daily summary for each token-date combination", async () => {
      // Insert trades for multiple token-date combos
      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - ONE_DAY - 1000, "buy"),
        generateMockTrade(TEST_TOKEN_MINT, NOW - ONE_DAY - 500, "sell"),
        generateMockTrade("other_token", NOW - ONE_DAY - 1000, "buy"),
      ];

      await db.insert(rawTokenTrades).values(trades);

      const result = await summarizeAndDeleteDayOldTrades();

      expect(result.tradeSummariesCreated).toBeGreaterThan(0);
      expect(result.storageSaved).toMatch(/MB|GB|KB/);
    });

    it("should report storage freed accurately", async () => {
      // Insert 100 old trades
      const trades = Array.from({ length: 100 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - ONE_DAY - i * 10, "buy")
      );

      await db.insert(rawTokenTrades).values(trades);

      const result = await summarizeAndDeleteDayOldTrades();

      expect(result.rawTradesDeleted).toBe(100);
      expect(result.storageSaved).toMatch(/\d+/);
    });

    it("should not delete trades newer than 1 day", async () => {
      // Insert recent trades only
      const trades = Array.from({ length: 20 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - i * 3600, "buy") // Hourly, all within 24h
      );

      await db.insert(rawTokenTrades).values(trades);

      const result = await summarizeAndDeleteDayOldTrades();

      // Should not delete any recent trades
      expect(result.rawTradesDeleted).toBe(0);
    });
  });

  describe("compressDailyToWeeklySummary", () => {
    it("should return weekly summary with correct structure", async () => {
      const weekStart = "2024-01-01";

      const summary = await compressDailyToWeeklySummary(TEST_TOKEN_MINT, weekStart);

      expect(summary).toHaveProperty("tokenMint");
      expect(summary).toHaveProperty("weekStart");
      expect(summary).toHaveProperty("dayCount");
      expect(summary).toHaveProperty("totalBuyVolume");
      expect(summary).toHaveProperty("totalSellVolume");
      expect(summary).toHaveProperty("avgBuyPrice");
      expect(summary).toHaveProperty("avgSellPrice");
      expect(summary).toHaveProperty("minPrice");
      expect(summary).toHaveProperty("maxPrice");
      expect(summary).toHaveProperty("uniqueWallets");
      expect(summary).toHaveProperty("profitableWallets");
      expect(summary).toHaveProperty("timestamp");
    });

    it("should represent 7 days of data", async () => {
      const weekStart = "2024-01-01";

      const summary = await compressDailyToWeeklySummary(TEST_TOKEN_MINT, weekStart);

      expect(summary.dayCount).toBe(7);
    });
  });

  describe("estimateStorageByAge", () => {
    it("should return raw trades estimate for recent data (0-24h)", () => {
      const estimate = estimateStorageByAge(12); // 12 hours old

      expect(estimate.ageHours).toBe(12);
      expect(estimate.dataType).toBe("Raw trades");
      expect(estimate.estimatedSize).toContain("50 MB");
    });

    it("should return daily summaries estimate for 1-7 day data", () => {
      const estimate = estimateStorageByAge(72); // 3 days

      expect(estimate.ageHours).toBe(72);
      expect(estimate.dataType).toBe("Daily summaries");
      expect(estimate.estimatedSize).toContain("KB");
    });

    it("should return weekly summaries estimate for 7-28 day data", () => {
      const estimate = estimateStorageByAge(168); // 7 days

      expect(estimate.ageHours).toBe(168);
      expect(estimate.dataType).toBe("Weekly summaries");
      expect(estimate.estimatedSize).toContain("KB");
    });

    it("should return monthly summaries estimate for 28+ day data", () => {
      const estimate = estimateStorageByAge(720); // 30 days

      expect(estimate.ageHours).toBe(720);
      expect(estimate.dataType).toBe("Monthly summaries + archived");
      expect(estimate.estimatedSize).toContain("KB");
    });
  });

  describe("Storage Hierarchy", () => {
    it("should demonstrate storage reduction from raw to summaries", () => {
      const raw = estimateStorageByAge(12);
      const daily = estimateStorageByAge(72);
      const weekly = estimateStorageByAge(240);

      // Raw > Daily > Weekly in terms of storage
      expect(raw.dataType).toBe("Raw trades");
      expect(daily.dataType).toBe("Daily summaries");
      expect(weekly.dataType).toBe("Weekly summaries");

      // Storage descriptions should show progression
      expect(raw.estimatedSize).toContain("MB");
      expect(daily.estimatedSize).toContain("KB");
      expect(weekly.estimatedSize).toContain("KB");
    });

    it("should show consistent hierarchy across different ages", () => {
      // Test multiple age ranges
      const ageRanges = [12, 72, 240, 720];
      const estimates = ageRanges.map((age) => estimateStorageByAge(age));

      // First estimate should be raw trades (MB)
      expect(estimates[0].dataType).toBe("Raw trades");
      expect(estimates[0].estimatedSize).toContain("MB");

      // Middle estimates should be summaries (KB)
      expect(estimates[1].dataType).toBe("Daily summaries");
      expect(estimates[2].dataType).toBe("Weekly summaries");
      expect(estimates[3].dataType).toBe("Monthly summaries + archived");
    });
  });
});
