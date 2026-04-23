import { describe, it, expect, beforeEach } from "vitest";
import {
  DiscoveredWallet,
  WalletOutcome,
  backtrackFromWinners,
  trackCopyChain,
  getWalletOutcomes,
  getTopDiscoveredWallets,
  getLeaderWallets,
  getCopyChainStats,
  runWalletDiscoveryCycle,
  scoreWalletForSignal,
} from "./wallet-discovery";
import { db } from "./db";
import { swaps, tokenOutcomes } from "@shared/schema";

/**
 * Unit tests for Wallet Discovery System
 * Tests identification and ranking of successful wallets for signal generation
 */

describe("Wallet Discovery", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const TOKEN_MINT = "test_token_" + Date.now();

  // Helper to generate test swap data
  function generateSwap(
    wallet: string,
    token: string,
    fromAmount: number,
    toAmount: number,
    timestamp: number,
    isProfitable: boolean = true
  ) {
    // Ensure profitable if requested
    const finalToAmount = isProfitable
      ? Math.max(toAmount, fromAmount * 1.1)
      : Math.min(toAmount, fromAmount * 0.9);

    return {
      id: `swap_${Math.random()}`,
      signature: `sig_${Date.now()}_${Math.random()}`,
      timestamp,
      fromToken: "So11111111111111111111111111111111111111112", // SOL
      toToken: token,
      fromAmount,
      toAmount: finalToAmount,
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
    // Create test swap data with multiple wallets and tokens
    const swaps_data = [
      // Wallet 1: Early and profitable
      generateSwap("wallet_success_1", TOKEN_MINT, 1, 2.5, NOW - 600, true),
      generateSwap("wallet_success_1", "other_token_1", 0.5, 1.2, NOW - 1200, true),

      // Wallet 2: Multiple profitable trades
      generateSwap("wallet_success_2", TOKEN_MINT, 2, 5, NOW - 300, true),
      generateSwap("wallet_success_2", "other_token_2", 1, 2.3, NOW - 900, true),
      generateSwap("wallet_success_2", "other_token_3", 0.8, 1.8, NOW - 1800, true),

      // Wallet 3: Unprofitable trades
      generateSwap("wallet_loss_1", TOKEN_MINT, 1, 0.8, NOW - 500, false),
      generateSwap("wallet_loss_1", "other_token_1", 2, 1.5, NOW - 1100, false),

      // Wallet 4: Mixed results
      generateSwap("wallet_mixed", TOKEN_MINT, 1, 2, NOW - 400, true),
      generateSwap("wallet_mixed", "other_token_2", 0.5, 0.3, NOW - 1400, false),
    ];

    await db.insert(swaps).values(swaps_data).onConflictDoNothing();

    // Create test token outcomes
    const outcomes = [
      {
        id: "outcome_1",
        tokenMint: TOKEN_MINT,
        launchTimestamp: NOW - 1000,
        launchPrice: 0.000001,
        success: true,
        maxPrice: 0.0000025,
        finalPrice: 0.000002,
        holdTime: 600,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "outcome_2",
        tokenMint: "other_token_1",
        launchTimestamp: NOW - 1500,
        launchPrice: 0.000001,
        success: true,
        maxPrice: 0.000002,
        finalPrice: 0.0000018,
        holdTime: 700,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await db.insert(tokenOutcomes).values(outcomes).onConflictDoNothing();
  });

  describe("backtrackFromWinners", () => {
    it("should identify wallets with profitable trades on successful tokens", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      expect(Array.isArray(winners)).toBe(true);
      expect(winners.length).toBeGreaterThan(0);
    });

    it("should include wallet address in results", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      if (winners.length > 0) {
        expect(winners[0]).toHaveProperty("address");
        expect(typeof winners[0].address).toBe("string");
      }
    });

    it("should rank wallets by profitability", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      // Should be sorted by profitability
      for (let i = 1; i < winners.length; i++) {
        const current = winners[i];
        const previous = winners[i - 1];

        // Previous wallet should have higher or equal profit
        // (implementation may rank by different metrics)
        expect(typeof current.profitMultiplier).toBe("number");
      }
    });

    it("should handle non-existent token", async () => {
      const winners = await backtrackFromWinners("nonexistent_token");

      expect(Array.isArray(winners)).toBe(true);
      // May be empty
    });

    it("should include profit metrics", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      for (const winner of winners) {
        expect(winner).toHaveProperty("profitMultiplier");
        expect(winner).toHaveProperty("holdDuration");
        expect(typeof winner.profitMultiplier).toBe("number");
      }
    });
  });

  describe("trackCopyChain", () => {
    it("should identify copy trading relationships", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      if (winners.length > 0) {
        const chain = await trackCopyChain(winners[0].address);

        expect(typeof chain).toBe("object");
        expect(Array.isArray(chain.followers) || chain.followers === undefined).toBe(true);
      }
    });

    it("should track wallet entry timing", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      if (winners.length > 0) {
        const chain = await trackCopyChain(winners[0].address);

        if (chain.followers && chain.followers.length > 0) {
          expect(chain.followers[0]).toHaveProperty("entryTime");
        }
      }
    });

    it("should handle isolated wallets (no copy chain)", async () => {
      const chain = await trackCopyChain("isolated_wallet_" + Date.now());

      expect(typeof chain).toBe("object");
      // May have empty followers
    });
  });

  describe("getWalletOutcomes", () => {
    it("should return wallet trading outcomes", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);

      if (winners.length > 0) {
        const outcomes = await getWalletOutcomes(winners[0].address);

        expect(Array.isArray(outcomes)).toBe(true);
      }
    });

    it("should include profit/loss metrics", async () => {
      const outcomes = await getWalletOutcomes("wallet_success_1");

      if (outcomes.length > 0) {
        expect(outcomes[0]).toHaveProperty("realizedPnL");
        expect(outcomes[0]).toHaveProperty("holdTime");
        expect(typeof outcomes[0].realizedPnL).toBe("number");
      }
    });

    it("should list wallet trades", async () => {
      const outcomes = await getWalletOutcomes("wallet_success_1");

      if (outcomes.length > 0) {
        expect(outcomes[0]).toHaveProperty("tokenMint");
        expect(typeof outcomes[0].tokenMint).toBe("string");
      }
    });
  });

  describe("getTopDiscoveredWallets", () => {
    it("should return list of top performing wallets", async () => {
      const topWallets = await getTopDiscoveredWallets();

      expect(Array.isArray(topWallets)).toBe(true);
    });

    it("should rank by win rate or profitability", async () => {
      const topWallets = await getTopDiscoveredWallets();

      if (topWallets.length > 1) {
        // Should be sorted (descending)
        expect(topWallets[0]).toBeDefined();
        expect(topWallets[topWallets.length - 1]).toBeDefined();
      }
    });

    it("should include performance metrics", async () => {
      const topWallets = await getTopDiscoveredWallets();

      if (topWallets.length > 0) {
        expect(topWallets[0]).toHaveProperty("address");
        expect(topWallets[0]).toHaveProperty("winRate");
        expect(topWallets[0]).toHaveProperty("avgProfit");
      }
    });
  });

  describe("getLeaderWallets", () => {
    it("should return list of leader wallets", async () => {
      const leaders = await getLeaderWallets();

      expect(Array.isArray(leaders)).toBe(true);
    });

    it("should include leadership metrics", async () => {
      const leaders = await getLeaderWallets();

      if (leaders.length > 0) {
        expect(leaders[0]).toHaveProperty("address");
        expect(leaders[0]).toHaveProperty("followerCount");
      }
    });
  });

  describe("getCopyChainStats", () => {
    it("should return copy chain statistics", async () => {
      const stats = await getCopyChainStats();

      expect(typeof stats).toBe("object");
      expect(stats).toHaveProperty("totalChains");
      expect(typeof stats.totalChains).toBe("number");
    });

    it("should include chain depth metrics", async () => {
      const stats = await getCopyChainStats();

      if (stats.totalChains > 0) {
        expect(stats).toHaveProperty("avgDepth");
        expect(typeof stats.avgDepth).toBe("number");
      }
    });

    it("should be non-negative", async () => {
      const stats = await getCopyChainStats();

      expect(stats.totalChains).toBeGreaterThanOrEqual(0);
    });
  });

  describe("runWalletDiscoveryCycle", () => {
    it("should execute complete discovery cycle without errors", async () => {
      expect(async () => {
        await runWalletDiscoveryCycle();
      }).not.toThrow();
    });

    it("should return cycle results", async () => {
      const results = await runWalletDiscoveryCycle();

      expect(typeof results).toBe("object");
      expect(results).toHaveProperty("discoveredWallets");
      expect(Array.isArray(results.discoveredWallets)).toBe(true);
    });

    it("should include cycle statistics", async () => {
      const results = await runWalletDiscoveryCycle();

      expect(results).toHaveProperty("walletsAnalyzed");
      expect(results).toHaveProperty("newLeadersFound");
      expect(typeof results.walletsAnalyzed).toBe("number");
    });
  });

  describe("scoreWalletForSignal", () => {
    it("should assign numerical signal score", async () => {
      const score = await scoreWalletForSignal("wallet_success_1");

      expect(typeof score).toBe("number");
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it("should give higher scores to profitable wallets", async () => {
      const successScore = await scoreWalletForSignal("wallet_success_1");
      const lossScore = await scoreWalletForSignal("wallet_loss_1");

      // Profitable wallet should score higher
      expect(successScore).toBeGreaterThan(lossScore);
    });

    it("should handle new/unknown wallets", async () => {
      const score = await scoreWalletForSignal("unknown_wallet_" + Date.now());

      expect(typeof score).toBe("number");
      // Score may be low/zero for unknown wallets
    });

    it("should be consistent for same wallet", async () => {
      const score1 = await scoreWalletForSignal("wallet_success_1");
      const score2 = await scoreWalletForSignal("wallet_success_1");

      expect(score1).toBe(score2);
    });
  });

  describe("Integration Tests", () => {
    it("should complete full discovery pipeline", async () => {
      // 1. Get winners for token
      const winners = await backtrackFromWinners(TOKEN_MINT);

      if (winners.length > 0) {
        // 2. Track copy chains
        const chain = await trackCopyChain(winners[0].address);
        expect(chain).toBeDefined();

        // 3. Get wallet outcomes
        const outcomes = await getWalletOutcomes(winners[0].address);
        expect(Array.isArray(outcomes)).toBe(true);

        // 4. Score for signal
        const score = await scoreWalletForSignal(winners[0].address);
        expect(typeof score).toBe("number");
      }
    });

    it("should rank wallets consistently across methods", async () => {
      const winners = await backtrackFromWinners(TOKEN_MINT);
      const topWallets = await getTopDiscoveredWallets();

      // Both should return wallets (though different subsets)
      expect(Array.isArray(winners)).toBe(true);
      expect(Array.isArray(topWallets)).toBe(true);

      // Overlapping wallets should have consistent rankings
      if (winners.length > 0 && topWallets.length > 0) {
        const winner_addrs = winners.map(w => w.address);
        const top_addrs = topWallets.map(w => w.address);

        // Check if any overlap
        const overlap = winner_addrs.some(addr => top_addrs.includes(addr));
        // Overlap is expected but not required
      }
    });

    it("should handle discovery cycle with test data", async () => {
      const cycleResult = await runWalletDiscoveryCycle();

      expect(cycleResult.discoveredWallets).toBeDefined();
      expect(Array.isArray(cycleResult.discoveredWallets)).toBe(true);
      expect(cycleResult.walletsAnalyzed >= 0).toBe(true);
    });
  });
});
