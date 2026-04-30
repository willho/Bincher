import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../server/db";
import { tokenFingerprints, rawTokenTrades } from "@shared/schema";
import {
  shouldFingerprintToken,
  getTokenTradeCount,
  recordFingerprintSnapshot,
  estimateStorageSavingsWithGating,
  demonstrateActivityGating,
} from "../server/fingerprint-activity-gate";
import { sql } from "drizzle-orm";

/**
 * Tests for Activity-Gated Fingerprinting
 * Verifies T0 always fingerprints, but T1+ only if volume occurred
 */

describe("Fingerprint Activity Gate", () => {
  const TEST_TOKEN_MINT = "test_mint_" + Date.now();
  const NOW = Math.floor(Date.now() / 1000);

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

  function generateMockFingerprint(
    tokenMint: string,
    timestamp: number,
    snapshotTrigger: string = "time_30s"
  ) {
    return {
      id: `fp_${tokenMint}_${timestamp}_${Math.random()}`,
      tokenMint,
      snapshotTimestamp: timestamp,
      snapshotTrigger,
      fingerprintVector: Array.from({ length: 50 }, () => Math.random()),
      winRate: Math.random() * 0.8,
      medianMultiplier: Math.random() * 5,
      avgHoldMinutes: Math.random() * 1440,
      whaleEntryCount: Math.floor(Math.random() * 5),
      clusterCoordination: Math.random(),
      buyerDiversity: Math.random(),
      holderConcentration: Math.random(),
      isArchived: false,
      createdAt: new Date(timestamp * 1000),
      updatedAt: new Date(),
    };
  }

  beforeEach(async () => {
    // Clear test data
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
    await db.delete(rawTokenTrades).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
  });

  afterEach(async () => {
    // Cleanup
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
    await db.delete(rawTokenTrades).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
  });

  describe("shouldFingerprintToken", () => {
    it("should return T0_FIRST_FINGERPRINT when token has no fingerprints", async () => {
      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      expect(result.should).toBe(true);
      expect(result.reason).toBe("T0_FIRST_FINGERPRINT");
      expect(result.tradesSinceLastFP).toBe(0);
    });

    it("should fingerprint T0 even with no trades", async () => {
      // Create token but no trades
      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      expect(result.should).toBe(true);
      expect(result.reason).toBe("T0_FIRST_FINGERPRINT");
    });

    it("should skip snapshot if no volume since last fingerprint", async () => {
      // Create first fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 60),
      ]);

      // Check without any trades
      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      expect(result.should).toBe(false);
      expect(result.reason).toBe("NO_VOLUME_SINCE_LAST_FP");
      expect(result.tradesSinceLastFP).toBe(0);
    });

    it("should fingerprint T1 if volume occurred since T0", async () => {
      const t0 = NOW - 60;
      const t1 = NOW;

      // Create T0 fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0),
      ]);

      // Add trades after T0
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, t1 - 10),
        generateMockTrade(TEST_TOKEN_MINT, t1 - 5),
      ]);

      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      expect(result.should).toBe(true);
      expect(result.reason).toContain("VOLUME_SINCE_LAST_FP");
      expect(result.tradesSinceLastFP).toBe(2);
    });

    it("should return correct trade count since last fingerprint", async () => {
      const t0 = NOW - 120;
      const t1 = NOW - 60;

      // T0 fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0),
      ]);

      // Add 10 trades after T0
      const trades = Array.from({ length: 10 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, t0 + i * 10)
      );
      await db.insert(rawTokenTrades).values(trades);

      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      expect(result.tradesSinceLastFP).toBe(10);
    });

    it("should handle multiple fingerprints and only look at last one", async () => {
      const t0 = NOW - 180;
      const t1 = NOW - 120;
      const t2 = NOW - 60;
      const t3 = NOW;

      // Create multiple fingerprints
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0),
        generateMockFingerprint(TEST_TOKEN_MINT, t1),
        generateMockFingerprint(TEST_TOKEN_MINT, t2),
      ]);

      // Add trades only after t2
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, t3 - 10),
        generateMockTrade(TEST_TOKEN_MINT, t3 - 5),
      ]);

      const result = await shouldFingerprintToken(TEST_TOKEN_MINT);

      // Should only count trades since last FP (t2)
      expect(result.tradesSinceLastFP).toBe(2);
      expect(result.should).toBe(true);
    });
  });

  describe("getTokenTradeCount", () => {
    it("should return 0 for token with no trades", async () => {
      const count = await getTokenTradeCount(TEST_TOKEN_MINT);
      expect(count).toBe(0);
    });

    it("should return correct trade count for token", async () => {
      const trades = Array.from({ length: 25 }, (_, i) =>
        generateMockTrade(TEST_TOKEN_MINT, NOW - i * 60)
      );

      await db.insert(rawTokenTrades).values(trades);

      const count = await getTokenTradeCount(TEST_TOKEN_MINT);
      expect(count).toBe(25);
    });

    it("should filter by timestamp when provided", async () => {
      const trades = [
        generateMockTrade(TEST_TOKEN_MINT, NOW - 200),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 150),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 100),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 50),
      ];

      await db.insert(rawTokenTrades).values(trades);

      // Count trades since 120 seconds ago
      const cutoff = NOW - 120;
      const count = await getTokenTradeCount(TEST_TOKEN_MINT, cutoff);

      expect(count).toBe(2); // Only last 2 trades
    });

    it("should handle multiple tokens independently", async () => {
      const token1 = TEST_TOKEN_MINT + "_1";
      const token2 = TEST_TOKEN_MINT + "_2";

      const trades1 = Array.from({ length: 10 }, (_, i) =>
        generateMockTrade(token1, NOW - i * 10)
      );
      const trades2 = Array.from({ length: 5 }, (_, i) =>
        generateMockTrade(token2, NOW - i * 10)
      );

      await db.insert(rawTokenTrades).values([...trades1, ...trades2]);

      const count1 = await getTokenTradeCount(token1);
      const count2 = await getTokenTradeCount(token2);

      expect(count1).toBe(10);
      expect(count2).toBe(5);
    });
  });

  describe("recordFingerprintSnapshot", () => {
    it("should record fingerprint without errors", async () => {
      const fpId = `fp_${TEST_TOKEN_MINT}_${NOW}`;

      await expect(
        recordFingerprintSnapshot(TEST_TOKEN_MINT, fpId, NOW)
      ).resolves.not.toThrow();
    });

    it("should handle recorded snapshots for gating logic", async () => {
      const t0 = NOW - 60;
      const fpId = `fp_${TEST_TOKEN_MINT}_${t0}`;

      // Record a fingerprint
      await recordFingerprintSnapshot(TEST_TOKEN_MINT, fpId, t0);

      // Create actual fingerprint entry
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0),
      ]);

      // Next check should detect no volume
      let result = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(result.should).toBe(false);

      // Add trades
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, NOW - 10),
      ]);

      // Now should fingerprint
      result = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(result.should).toBe(true);
    });
  });

  describe("Storage Estimates", () => {
    it("should demonstrate storage savings with activity gating", () => {
      const savings = estimateStorageSavingsWithGating();

      expect(savings.ungatedFingerprints).toBeGreaterThan(
        savings.gatedFingerprints
      );
      expect(savings.reductionPercent).toBeGreaterThan(50);
      expect(savings.reductionPercent).toBeLessThanOrEqual(100);
      expect(savings.estimatedSavings).toMatch(/GB\/month/);
    });

    it("should show significant savings in typical scenario", () => {
      const savings = estimateStorageSavingsWithGating();

      // With gating, should save significant amount
      // Ungated: 1.8M fingerprints/month
      // Gated: ~250K-300K = ~85% reduction
      expect(savings.reductionPercent).toBeGreaterThan(80);
    });

    it("should demonstrate activity gating in action", () => {
      const demo = demonstrateActivityGating();

      expect(demo.scenario).toContain("100 tokens");
      expect(demo.ungatedTotal).toBeGreaterThan(demo.gatedTotal);
      expect(demo.reductionPercent).toBeGreaterThan(90); // 97% reduction in scenario
    });

    it("should show realistic T0-only for dead tokens", () => {
      const demo = demonstrateActivityGating();

      // In 100 tokens with 50 potential snapshots:
      // Ungated: 5000 total
      // Gated: 20% dead (1 each) + 80% active (5 each) = 20 + 400 = 420
      // Reduction: ~92%
      expect(demo.gatedTotal).toBeLessThan(500);
      expect(demo.reductionPercent).toBeGreaterThan(90);
    });
  });

  describe("Activity Gating Lifecycle", () => {
    it("should demonstrate full token lifecycle with gating", async () => {
      const t0 = NOW - 180;
      const t1 = NOW - 120;
      const t2 = NOW - 60;
      const t3 = NOW;

      // T0: Token discovered, create first fingerprint (always)
      let shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(true);
      expect(shouldFP.reason).toBe("T0_FIRST_FINGERPRINT");

      // Create T0 fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0, "launch"),
      ]);

      // T1 (30 sec later): No trades yet, skip snapshot
      shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(false);
      expect(shouldFP.reason).toBe("NO_VOLUME_SINCE_LAST_FP");

      // T2 (30 sec later): Volume occurs, fingerprint
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, t2 - 10),
        generateMockTrade(TEST_TOKEN_MINT, t2 - 5),
      ]);

      shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(true);
      expect(shouldFP.tradesSinceLastFP).toBe(2);

      // Record T2 fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t2, "volume"),
      ]);

      // T3 (30 sec later): No new trades, skip
      shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(false);

      // Add volume at T3
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, t3 - 10),
      ]);

      // Now should fingerprint
      shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(true);
    });

    it("should show dead token gets only 1 fingerprint", async () => {
      // Create token at T0, no trades ever
      let shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
      expect(shouldFP.should).toBe(true); // T0 always

      // Create T0 FP
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 3600),
      ]);

      // Check at T1, T2, T3... all skip
      for (let i = 0; i < 10; i++) {
        shouldFP = await shouldFingerprintToken(TEST_TOKEN_MINT);
        expect(shouldFP.should).toBe(false);
      }

      // Verify only 1 fingerprint exists
      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      expect(fps.length).toBe(1);
    });
  });
});
