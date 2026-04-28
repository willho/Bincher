import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "./db";
import { tokenFingerprints, tokenDataPool, rawTokenTrades } from "@shared/schema";
import {
  recordDeathbreadFingerprint,
  createDeathPatternCluster,
  archiveTokenWithDeathbread,
  estimateDeathbreadSavings,
  estimateFullStrategy,
} from "./deathbread-fingerprinting";
import { sql } from "drizzle-orm";

/**
 * Tests for Deathbread Fingerprinting
 * Verifies dead token lifecycle: T0 + deathbread → anti-pattern
 */

describe("Deathbread Fingerprinting", () => {
  const TEST_TOKEN_MINT = "test_mint_" + Date.now();
  const NOW = Math.floor(Date.now() / 1000);

  function generateMockTrade(
    tokenMint: string,
    timestamp: number,
    direction: "buy" | "sell" = "buy",
    walletAddress: string = "wallet_" + Math.random(),
    amountSol: number = 0.5,
    amountTokens: number = 5000,
    price?: number
  ) {
    return {
      signature: `sig_${tokenMint}_${timestamp}_${Math.random()}`,
      tokenMint,
      walletAddress,
      direction,
      amountSol,
      amountTokens,
      price: price || amountSol / amountTokens,
      timestamp,
      createdAt: new Date(timestamp * 1000),
    };
  }

  function generateMockFingerprint(
    tokenMint: string,
    timestamp: number,
    snapshotTrigger: string = "launch"
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

  function generateMockTokenData(tokenMint: string) {
    return {
      tokenMint,
      name: `Test Token ${tokenMint}`,
      symbol: "TEST",
      supply: 1000000,
      bondsEstimate: 0,
      priceUsd: 0.00001,
      priceChange24h: -0.5, // Dead token losing value
      volume24h: 0.1,
      liquidity: 100,
      mcap: 10000,
      creatorAddress: "creator_" + Math.random().toString().slice(2),
      creatorReputation: 0.3, // Poor creator
      priceUpdatedAt: Math.floor(Date.now() / 1000),
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(async () => {
    // Clear test data
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
    await db.delete(tokenDataPool).where(
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
    await db.delete(tokenDataPool).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
    await db.delete(rawTokenTrades).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
  });

  describe("recordDeathbreadFingerprint", () => {
    it("should record deathbread when T0 exists", async () => {
      const t0Timestamp = NOW - 86400; // 1 day old

      // Create T0 fingerprint
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0Timestamp, "launch"),
      ]);

      const result = await recordDeathbreadFingerprint(
        TEST_TOKEN_MINT,
        "no_volume"
      );

      expect(result.success).toBe(true);
      expect(result.fpId).toBeDefined();
      expect(result.lifecycleDays).toBeGreaterThanOrEqual(0);
    });

    it("should calculate lifecycle duration", async () => {
      const t0Timestamp = NOW - 7 * 86400; // 7 days old

      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0Timestamp, "launch"),
      ]);

      const result = await recordDeathbreadFingerprint(TEST_TOKEN_MINT);

      expect(result.lifecycleDays).toBeGreaterThanOrEqual(6);
      expect(result.lifecycleDays).toBeLessThanOrEqual(8);
    });

    it("should return failure if no T0 fingerprint", async () => {
      const result = await recordDeathbreadFingerprint(TEST_TOKEN_MINT);

      expect(result.success).toBe(false);
      expect(result.fpId).toBeUndefined();
    });

    it("should include death reason in trigger", async () => {
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 3600, "launch"),
      ]);

      const result = await recordDeathbreadFingerprint(
        TEST_TOKEN_MINT,
        "rug"
      );

      expect(result.success).toBe(true);

      // Verify deathbread fingerprint was created
      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      const deathbread = fps.find((fp) =>
        fp.snapshotTrigger?.includes("deathbread")
      );
      expect(deathbread).toBeDefined();
      expect(deathbread?.snapshotTrigger).toContain("rug");
    });

    it("should create deathbread vector from final state", async () => {
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch"),
      ]);

      // Add some trades
      await db.insert(rawTokenTrades).values([
        generateMockTrade(TEST_TOKEN_MINT, NOW - 3600, "buy", "wallet1"),
        generateMockTrade(TEST_TOKEN_MINT, NOW - 1800, "buy", "wallet2"),
        generateMockTrade(
          TEST_TOKEN_MINT,
          NOW - 600,
          "sell",
          "wallet1",
          0.1,
          5000,
          0.00005
        ),
      ]);

      const result = await recordDeathbreadFingerprint(TEST_TOKEN_MINT);

      expect(result.success).toBe(true);

      // Verify deathbread has vector
      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      const deathbread = fps.find((fp) =>
        fp.snapshotTrigger?.includes("deathbread")
      );
      expect(deathbread?.fingerprintVector).toBeDefined();
      expect(deathbread?.fingerprintVector).toHaveLength(50);
    });

    it("should capture completely dead token state", async () => {
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch"),
      ]);

      // No trades at all - completely dead
      const result = await recordDeathbreadFingerprint(
        TEST_TOKEN_MINT,
        "no_volume"
      );

      expect(result.success).toBe(true);

      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      const deathbread = fps.find((fp) =>
        fp.snapshotTrigger?.includes("deathbread")
      );

      // Dead token should have low multiplier
      expect(deathbread?.medianMultiplier).toBeLessThan(0.0001);
      expect(deathbread?.buyerDiversity).toBe(0);
    });
  });

  describe("createDeathPatternCluster", () => {
    it("should average T0 and deathbread into cluster", async () => {
      // Create T0
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch"),
      ]);

      // Create deathbread
      await recordDeathbreadFingerprint(TEST_TOKEN_MINT, "no_volume");

      // Create cluster
      const result = await createDeathPatternCluster(TEST_TOKEN_MINT);

      expect(result.success).toBe(true);
      expect(result.clusterId).toBeDefined();
      expect(result.avgVector).toHaveLength(50);
      expect(result.pattern).toContain("launch");
      expect(result.pattern).toContain("deathbread");
    });

    it("should fail if lifecycle incomplete", async () => {
      // Only T0, no deathbread
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 3600, "launch"),
      ]);

      const result = await createDeathPatternCluster(TEST_TOKEN_MINT);

      expect(result.success).toBe(false);
    });

    it("should average vectors correctly", async () => {
      // Create T0 with known values
      const t0Vector = Array.from({ length: 50 }, (_, i) => i * 0.01);
      const t0 = generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch");
      t0.fingerprintVector = t0Vector;

      await db.insert(tokenFingerprints).values([t0]);

      // Create deathbread
      await recordDeathbreadFingerprint(TEST_TOKEN_MINT, "no_volume");

      const result = await createDeathPatternCluster(TEST_TOKEN_MINT);

      expect(result.success).toBe(true);

      // Average should be between T0 and deathbread values
      if (result.avgVector) {
        result.avgVector.forEach((val) => {
          expect(val).toBeGreaterThanOrEqual(0);
          expect(val).toBeLessThanOrEqual(1);
        });
      }
    });
  });

  describe("archiveTokenWithDeathbread", () => {
    it("should archive token and record deathbread", async () => {
      // Setup token
      await db.insert(tokenDataPool).values([
        generateMockTokenData(TEST_TOKEN_MINT),
      ]);

      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch"),
      ]);

      const result = await archiveTokenWithDeathbread(
        TEST_TOKEN_MINT,
        "no_volume"
      );

      expect(result.archived).toBe(true);
      expect(result.deathbreadRecorded).toBe(true);
      expect(result.deathPatternCreated).toBe(true);

      // Verify token marked as archived
      const tokenData = await db
        .select()
        .from(tokenDataPool)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      expect(tokenData[0]?.isArchived).toBe(true);
    });

    it("should handle missing token data gracefully", async () => {
      // Only fingerprint, no tokenDataPool entry
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 3600, "launch"),
      ]);

      const result = await archiveTokenWithDeathbread(TEST_TOKEN_MINT);

      expect(result.deathbreadRecorded).toBe(true);
    });

    it("should capture archive reason", async () => {
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 3600, "launch"),
      ]);

      await archiveTokenWithDeathbread(TEST_TOKEN_MINT, "rug");

      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      const deathbread = fps.find((fp) =>
        fp.snapshotTrigger?.includes("deathbread")
      );

      expect(deathbread?.snapshotTrigger).toContain("rug");
    });
  });

  describe("Storage Estimates", () => {
    it("should show deathbread storage savings", () => {
      const savings = estimateDeathbreadSavings();

      expect(savings.fingerprintsPerDeadToken).toBe(2);
      expect(savings.clustersPerDeadToken).toBe(1);
      expect(savings.savingsPercent).toBe(96);
      expect(savings.trainingBenefit).toContain("anti-pattern");
    });

    it("should demonstrate full strategy impact", () => {
      const strategy = estimateFullStrategy();

      expect(strategy.description).toContain("Activity-gated");
      expect(strategy.description).toContain("Deathbread");
      expect(strategy.totalReduction).toMatch(/\d+%/);
      expect(strategy.trainingQuality).toContain("Dual-label");
    });

    it("should show storage reduction numbers", () => {
      const strategy = estimateFullStrategy();

      // Should show significant reduction
      expect(strategy.totalReduction).toMatch(/\d+-\d+\s*GB\/month/);

      // Should mention improvement to training
      expect(strategy.trainingQuality).toContain("Success");
      expect(strategy.trainingQuality).toContain("Failure");
    });
  });

  describe("Deathbread Lifecycle", () => {
    it("should document complete dead token lifecycle", async () => {
      const t0 = NOW - 7 * 86400; // 7 days ago

      // T0: Token launches
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, t0, "launch"),
      ]);

      // T1-T6: No trades, activity gate skips snapshots
      // (not created in this test)

      // T_death: Record final state
      await recordDeathbreadFingerprint(TEST_TOKEN_MINT, "no_volume");

      // Create anti-pattern
      await createDeathPatternCluster(TEST_TOKEN_MINT);

      // Archive token
      await db.insert(tokenDataPool).values([
        generateMockTokenData(TEST_TOKEN_MINT),
      ]);

      const archive = await archiveTokenWithDeathbread(TEST_TOKEN_MINT);

      // Verify lifecycle
      expect(archive.archived).toBe(true);
      expect(archive.deathbreadRecorded).toBe(true);

      // Verify fingerprints
      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      expect(fps.length).toBe(2); // T0 + deathbread only
      expect(fps.find((f) => f.snapshotTrigger === "launch")).toBeDefined();
      expect(
        fps.find((f) => f.snapshotTrigger?.startsWith("deathbread"))
      ).toBeDefined();
    });

    it("should show contrast: active vs dead token fingerprints", async () => {
      const t0 = NOW - 86400;

      // Dead token: T0 + deathbread = 2 fingerprints
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint("dead_token", t0, "launch"),
      ]);
      await recordDeathbreadFingerprint("dead_token", "no_volume");

      // Active token: T0 + activity-gated snapshots = 5-10
      const activeFPs = Array.from({ length: 8 }, (_, i) =>
        generateMockFingerprint("active_token", t0 + i * 600, `snapshot_${i * 600}s`)
      );
      await db.insert(tokenFingerprints).values(activeFPs);

      const deadFPs = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${"dead_token"}`);

      const activeFPsResult = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${"active_token"}`);

      expect(deadFPs.length).toBe(2);
      expect(activeFPsResult.length).toBe(8);

      // Dead: 2 FPs, Active: 8 FPs (all meaningful)
      // vs ungated: both would have 50
    });
  });

  describe("Anti-Pattern Training Data", () => {
    it("should create negative labels for ANN training", async () => {
      // Dead token lifecycle: launch → death
      await db.insert(tokenFingerprints).values([
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - 86400, "launch"),
      ]);

      await recordDeathbreadFingerprint(TEST_TOKEN_MINT, "no_volume");

      const fps = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      // Both snapshots can be used for training
      // T0: "What did this token look like at launch?" (entry pattern)
      // Deathbread: "What did it look like at death?" (failure pattern)
      // Pair together: (entry_vector, death_vector) → label: "failure"

      expect(fps.length).toBe(2);
      expect(fps[0]?.snapshotTrigger).toBe("launch");
      expect(fps[1]?.snapshotTrigger).toContain("deathbread");

      // Both have vectors for training
      fps.forEach((fp) => {
        expect(fp.fingerprintVector).toBeDefined();
        expect(Array.isArray(fp.fingerprintVector)).toBe(true);
      });
    });

    it("should distinguish success vs failure patterns", async () => {
      // Success token (stays profitable)
      const successT0 = generateMockFingerprint("success_token", NOW - 3600, "launch");
      successT0.fingerprintVector = Array.from({ length: 50 }, () => 0.5);
      successT0.winRate = 0.8;
      successT0.medianMultiplier = 5.0;

      // Failure token (cratered)
      const failureT0 = generateMockFingerprint("failure_token", NOW - 3600, "launch");
      failureT0.fingerprintVector = Array.from({ length: 50 }, () => 0.3);
      failureT0.winRate = 0.2;

      const failureDeathbread = generateMockFingerprint(
        "failure_token",
        NOW,
        "deathbread_no_volume"
      );
      failureDeathbread.fingerprintVector = Array.from({ length: 50 }, () => 0.1);
      failureDeathbread.medianMultiplier = 0.00001;

      await db.insert(tokenFingerprints).values([
        successT0,
        failureT0,
        failureDeathbread,
      ]);

      // Success: high metrics across both timepoints
      // Failure: declining metrics (T0 → deathbread)

      const successFPs = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${"success_token"}`);

      const failureFPs = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${"failure_token"}`);

      expect(successFPs[0]?.winRate).toBeGreaterThan(0.5);
      expect(failureFPs.find((f) => f.snapshotTrigger === "launch")?.winRate).toBeLessThan(
        0.3
      );
    });
  });
});
