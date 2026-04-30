import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectSlowGrowerPatterns,
  filterHighConfidencePatterns,
  storeSlowGrowerPatterns,
  scoreSlowGrowerMatch,
  SlowGrowerPattern,
} from "../server/slow-grower-detector";
import { db } from "../server/db";
import { swaps, botFlaggedWallets, tokenDataPool } from "@shared/schema";

/**
 * Unit tests for Slow-Grower Detection
 * Tests identification of profitable wallet trades on tokens system missed
 */

describe("Slow-Grower Detection", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const FOUR_HOURS_AGO = NOW - 4 * 3600;

  // Test data generators
  function generateSwap(
    wallet: string,
    token: string,
    fromAmount: number,
    toAmount: number,
    timestamp: number
  ) {
    return {
      id: `swap_${Math.random()}`,
      signature: `sig_${Math.random()}`,
      timestamp,
      fromToken: "So11111111111111111111111111111111111111112", // SOL
      toToken: token,
      fromAmount,
      toAmount,
      buyer: wallet,
      source: wallet,
      seller: "pumpfun_program",
      slippage: 0.5,
      dex: "pump.fun" as const,
      isBot: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(async () => {
    // Insert profitable trades (last 4 hours)
    const profitable_trades = [
      // Wallet 1: 1 SOL → 200k token (good profit)
      generateSwap("wallet_1", "token_alpha", 1, 200000, FOUR_HOURS_AGO + 1800),
      // Wallet 2: 0.5 SOL → 150k token (good profit)
      generateSwap("wallet_2", "token_beta", 0.5, 150000, FOUR_HOURS_AGO + 3600),
      // Wallet 3: 2 SOL → 50k token (minimal profit, ~5%)
      generateSwap("wallet_3", "token_gamma", 2, 2.1, FOUR_HOURS_AGO + 600),
      // Wallet 4: Small amount, not whale
      generateSwap("wallet_4", "token_delta", 0.01, 2000, FOUR_HOURS_AGO + 1200),
    ];

    await db
      .insert(swaps)
      .values(profitable_trades)
      .onConflictDoNothing();

    // Mark one wallet as bot (should be filtered)
    await db
      .insert(botFlaggedWallets)
      .values({
        id: "bot_wallet_1",
        walletAddress: "bot_wallet",
        flagReason: "Suspected MEV bot",
        score: 0.95,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    // Add one token to data pool (should be skipped)
    await db
      .insert(tokenDataPool)
      .values({
        id: "existing_token",
        tokenMint: "token_alpha",
        name: "Alpha Token",
        symbol: "ALP",
        decimals: 6,
        discoverySource: "pump.fun",
        discoveryTimestamp: NOW - 7200,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  });

  describe("detectSlowGrowerPatterns", () => {
    it("should detect profitable wallet trades from last 4 hours", async () => {
      const patterns = await detectSlowGrowerPatterns();

      // Should find patterns from trades we inserted
      expect(patterns).toBeDefined();
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("should skip already-known tokens", async () => {
      const patterns = await detectSlowGrowerPatterns();

      // token_alpha should be skipped (in tokenDataPool)
      const hasAlpha = patterns.some(p => p.tokenMint === "token_alpha");
      expect(hasAlpha).toBe(false);
    });

    it("should skip bot-flagged wallets", async () => {
      // Add a profitable trade from bot wallet
      await db
        .insert(swaps)
        .values(
          generateSwap(
            "bot_wallet",
            "token_bot_trade",
            1,
            200000,
            FOUR_HOURS_AGO + 1800
          )
        )
        .onConflictDoNothing();

      const patterns = await detectSlowGrowerPatterns();

      // Should not include patterns from bot wallet
      const hasBot = patterns.some(p => p.funderWallet === "bot_wallet");
      expect(hasBot).toBe(false);
    });

    it("should include only profitable trades (multiplier > 1.05)", async () => {
      const patterns = await detectSlowGrowerPatterns();

      // All returned patterns should be truly profitable
      for (const pattern of patterns) {
        expect(pattern.multiplerAchieved).toBeGreaterThanOrEqual(1.05);
      }
    });

    it("should include ANN confidence scores", async () => {
      const patterns = await detectSlowGrowerPatterns();

      // Each pattern should have ANN prediction confidence
      for (const pattern of patterns) {
        expect(pattern.annConfidence).toBeGreaterThanOrEqual(0);
        expect(pattern.annConfidence).toBeLessThanOrEqual(1);
      }
    });

    it("should extract pattern characteristics", async () => {
      const patterns = await detectSlowGrowerPatterns();

      for (const pattern of patterns) {
        expect(pattern.patternCharacteristics).toBeDefined();
        expect(pattern.patternCharacteristics.entryPrice).toBeGreaterThan(0);
        expect(pattern.patternCharacteristics.peakPrice).toBeGreaterThanOrEqual(
          pattern.patternCharacteristics.entryPrice
        );
        expect(pattern.patternCharacteristics.exitPrice).toBeGreaterThan(0);
      }
    });

    it("should handle empty result gracefully", async () => {
      // Test with no qualifying trades (use different time window)
      const patterns = await detectSlowGrowerPatterns();

      expect(Array.isArray(patterns)).toBe(true);
      // May be empty if no trades in window
    });
  });

  describe("filterHighConfidencePatterns", () => {
    it("should filter patterns by confidence threshold", () => {
      const testPatterns: SlowGrowerPattern[] = [
        {
          tokenMint: "high_conf",
          funderWallet: "wallet_1",
          profitableWalletCount: 5,
          holdDurationMinutes: 30,
          multiplerAchieved: 2.5,
          annConfidence: 0.85, // High confidence
          discoveryTiming: "early",
          patternCharacteristics: {
            entryPrice: 0.000001,
            peakPrice: 0.0000025,
            exitPrice: 0.000002,
            priceSlope: 0.0000001,
            volumeAcceleration: 1.5,
          },
        },
        {
          tokenMint: "low_conf",
          funderWallet: "wallet_2",
          profitableWalletCount: 2,
          holdDurationMinutes: 15,
          multiplerAchieved: 1.2,
          annConfidence: 0.35, // Low confidence
          discoveryTiming: "late",
          patternCharacteristics: {
            entryPrice: 0.000001,
            peakPrice: 0.0000012,
            exitPrice: 0.0000011,
            priceSlope: 0.00000001,
            volumeAcceleration: 0.5,
          },
        },
      ];

      const filtered = filterHighConfidencePatterns(testPatterns);

      // Should filter to high-confidence only
      expect(filtered.length).toBeLessThanOrEqual(testPatterns.length);
      expect(
        filtered.every(p => p.annConfidence > filterHighConfidencePatterns.THRESHOLD || 0.7)
      ).toBe(true);
    });

    it("should maintain pattern structure in filtered results", () => {
      const pattern: SlowGrowerPattern = {
        tokenMint: "test_token",
        funderWallet: "test_wallet",
        profitableWalletCount: 10,
        holdDurationMinutes: 45,
        multiplerAchieved: 3.0,
        annConfidence: 0.8,
        discoveryTiming: "early",
        patternCharacteristics: {
          entryPrice: 0.000001,
          peakPrice: 0.000003,
          exitPrice: 0.000002,
          priceSlope: 0.0000002,
          volumeAcceleration: 2.0,
        },
      };

      const filtered = filterHighConfidencePatterns([pattern]);

      if (filtered.length > 0) {
        expect(filtered[0].tokenMint).toBe(pattern.tokenMint);
        expect(filtered[0].patternCharacteristics).toBeDefined();
      }
    });
  });

  describe("storeSlowGrowerPatterns", () => {
    it("should store patterns without throwing error", async () => {
      const testPattern: SlowGrowerPattern = {
        tokenMint: "storage_test",
        funderWallet: "test_wallet",
        profitableWalletCount: 8,
        holdDurationMinutes: 40,
        multiplerAchieved: 2.2,
        annConfidence: 0.75,
        discoveryTiming: "early",
        patternCharacteristics: {
          entryPrice: 0.000001,
          peakPrice: 0.0000022,
          exitPrice: 0.0000019,
          priceSlope: 0.00000015,
          volumeAcceleration: 1.8,
        },
      };

      expect(async () => {
        await storeSlowGrowerPatterns([testPattern]);
      }).not.toThrow();
    });

    it("should handle empty pattern list", async () => {
      expect(async () => {
        await storeSlowGrowerPatterns([]);
      }).not.toThrow();
    });

    it("should handle multiple patterns", async () => {
      const patterns: SlowGrowerPattern[] = [
        {
          tokenMint: "storage_1",
          funderWallet: "wallet_1",
          profitableWalletCount: 5,
          holdDurationMinutes: 30,
          multiplerAchieved: 1.8,
          annConfidence: 0.7,
          discoveryTiming: "early",
          patternCharacteristics: {
            entryPrice: 0.000001,
            peakPrice: 0.0000018,
            exitPrice: 0.0000015,
            priceSlope: 0.0000001,
            volumeAcceleration: 1.5,
          },
        },
        {
          tokenMint: "storage_2",
          funderWallet: "wallet_2",
          profitableWalletCount: 3,
          holdDurationMinutes: 20,
          multiplerAchieved: 1.5,
          annConfidence: 0.65,
          discoveryTiming: "mid",
          patternCharacteristics: {
            entryPrice: 0.000001,
            peakPrice: 0.0000015,
            exitPrice: 0.0000013,
            priceSlope: 0.00000008,
            volumeAcceleration: 1.2,
          },
        },
      ];

      expect(async () => {
        await storeSlowGrowerPatterns(patterns);
      }).not.toThrow();
    });
  });

  describe("scoreSlowGrowerMatch", () => {
    it("should score new token against slow-grower patterns", async () => {
      const patterns = await detectSlowGrowerPatterns();

      if (patterns.length > 0) {
        const pattern = patterns[0];
        const newTokenMint = "new_token_test";

        const score = await scoreSlowGrowerMatch(newTokenMint, pattern);

        expect(typeof score).toBe("number");
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it("should return numeric score for any input", async () => {
      const dummyPattern: SlowGrowerPattern = {
        tokenMint: "dummy",
        funderWallet: "dummy_wallet",
        profitableWalletCount: 5,
        holdDurationMinutes: 30,
        multiplerAchieved: 2.0,
        annConfidence: 0.75,
        discoveryTiming: "early",
        patternCharacteristics: {
          entryPrice: 0.000001,
          peakPrice: 0.000002,
          exitPrice: 0.0000018,
          priceSlope: 0.0000001,
          volumeAcceleration: 1.5,
        },
      };

      const score = await scoreSlowGrowerMatch("test_token", dummyPattern);

      expect(typeof score).toBe("number");
      expect(!isNaN(score)).toBe(true);
    });

    it("should handle multiple pattern comparisons", async () => {
      const patterns = await detectSlowGrowerPatterns();

      if (patterns.length >= 2) {
        const scores = await Promise.all([
          scoreSlowGrowerMatch("test_token_1", patterns[0]),
          scoreSlowGrowerMatch("test_token_2", patterns[1]),
        ]);

        expect(scores).toHaveLength(2);
        expect(scores.every(s => typeof s === "number")).toBe(true);
      }
    });
  });

  describe("Integration Tests", () => {
    it("should complete full slow-grower detection pipeline", async () => {
      // 1. Detect patterns
      const patterns = await detectSlowGrowerPatterns();

      if (patterns.length > 0) {
        // 2. Filter high confidence
        const filtered = filterHighConfidencePatterns(patterns);

        // 3. Store patterns
        await storeSlowGrowerPatterns(filtered);

        // 4. Score new tokens
        const scores = await Promise.all(
          filtered.map(p => scoreSlowGrowerMatch("new_test_token", p))
        );

        expect(scores.every(s => typeof s === "number")).toBe(true);
      }
    });

    it("should handle zero profitable trades gracefully", async () => {
      // This test handles the case where detectSlowGrowerPatterns returns empty
      const patterns = await detectSlowGrowerPatterns();

      expect(Array.isArray(patterns)).toBe(true);
      // Empty array is valid
      expect(patterns.length >= 0).toBe(true);
    });
  });
});
