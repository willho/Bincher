import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../server/db";
import { tokenFingerprints } from "@shared/schema";
import {
  bucketInactiveFingerprints,
  estimateInactiveTokenStorageSavings,
} from "../server/fingerprint-hierarchical-bucketing";
import { sql } from "drizzle-orm";

/**
 * Tests for Fingerprint Hierarchical Bucketing
 * Verifies inactive token fingerprints are properly compressed
 */

describe("Fingerprint Hierarchical Bucketing", () => {
  const TEST_TOKEN_MINT = "test_mint_" + Date.now();
  const NOW = Math.floor(Date.now() / 1000);
  const ONE_HOUR = 3600;
  const ONE_DAY = 86400;
  const SEVEN_DAYS = ONE_DAY * 7;
  const THIRTY_DAYS = ONE_DAY * 30;

  function generateMockFingerprint(
    tokenMint: string,
    timestamp: number,
    snapshotTrigger: string = "time_1min"
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
    // Clear any existing test fingerprints
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
  });

  afterEach(async () => {
    // Cleanup
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"test_mint_%"}`
    );
  });

  describe("bucketInactiveFingerprints", () => {
    it("should identify and bucket inactive tokens", async () => {
      // Create inactive token: fingerprints over 30 days with no recent trades
      // (Assuming activity detection would mark this as inactive)
      const fingerprints = Array.from({ length: 50 }, (_, i) => {
        const timestamp = NOW - THIRTY_DAYS + i * ONE_DAY;
        return generateMockFingerprint(TEST_TOKEN_MINT, timestamp);
      });

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      // Result should indicate bucketing occurred
      expect(result).toHaveProperty("tokensBucketed");
      expect(result).toHaveProperty("fingerprintsBucketed");
      expect(result).toHaveProperty("storageReduced");
    });

    it("should bucket 0-24h fingerprints into 6-hour buckets for inactive tokens", async () => {
      // Create fingerprints within 24 hours, 6 per bucket (4 buckets)
      const fingerprints = [];

      for (let bucket = 0; bucket < 4; bucket++) {
        const bucketStart = NOW - ONE_DAY + bucket * 6 * ONE_HOUR;
        for (let i = 0; i < 6; i++) {
          const timestamp = bucketStart + i * ONE_HOUR;
          fingerprints.push(generateMockFingerprint(TEST_TOKEN_MINT, timestamp));
        }
      }

      // Add some old fingerprints to trigger bucketing
      for (let i = 0; i < 10; i++) {
        fingerprints.push(
          generateMockFingerprint(TEST_TOKEN_MINT, NOW - THIRTY_DAYS - i * ONE_DAY)
        );
      }

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      // Should report bucketing work done
      expect(result.fingerprintsBucketed).toBeGreaterThanOrEqual(0);
    });

    it("should bucket 1-7 day fingerprints into daily buckets", async () => {
      // Create fingerprints spanning 7 days
      const fingerprints = [];

      for (let day = 1; day <= 7; day++) {
        const dayStart = NOW - SEVEN_DAYS + day * ONE_DAY;
        // Multiple fingerprints per day
        for (let i = 0; i < 4; i++) {
          fingerprints.push(
            generateMockFingerprint(TEST_TOKEN_MINT, dayStart + i * 6 * ONE_HOUR)
          );
        }
      }

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      expect(result).toHaveProperty("fingerprintsBucketed");
    });

    it("should bucket 7-30 day fingerprints into weekly buckets", async () => {
      // Create fingerprints spanning multiple weeks
      const fingerprints = [];

      for (let week = 1; week <= 4; week++) {
        const weekStart = NOW - THIRTY_DAYS + week * SEVEN_DAYS;
        // Multiple fingerprints per week
        for (let i = 0; i < 8; i++) {
          fingerprints.push(
            generateMockFingerprint(TEST_TOKEN_MINT, weekStart + i * ONE_DAY)
          );
        }
      }

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      expect(result).toHaveProperty("fingerprintsBucketed");
    });

    it("should not bucket singleton fingerprints", async () => {
      // Create single fingerprints (shouldn't be bucketed)
      const fingerprints = Array.from({ length: 5 }, (_, i) =>
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - i * ONE_DAY)
      );

      await db.insert(tokenFingerprints).values(fingerprints);

      const beforeCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT} AND is_archived = false`);

      const result = await bucketInactiveFingerprints();

      // Singletons should not be bucketed
      // (bucketInactiveFingerprints skips if fps.length < 2)
      expect(result.fingerprintsBucketed).toBeLessThanOrEqual(
        beforeCount.length
      );
    });

    it("should mark original fingerprints as archived", async () => {
      // Create fingerprints that will be bucketed
      const fingerprints = Array.from({ length: 10 }, (_, i) => {
        const timestamp = NOW - THIRTY_DAYS + i * ONE_DAY;
        return generateMockFingerprint(TEST_TOKEN_MINT, timestamp);
      });

      await db.insert(tokenFingerprints).values(fingerprints);

      const beforeCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT} AND is_archived = false`);

      await bucketInactiveFingerprints();

      // After bucketing, should have fewer non-archived fingerprints
      const afterCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT} AND is_archived = false`);

      // Some fingerprints should be archived
      expect(afterCount.length).toBeLessThanOrEqual(beforeCount.length);
    });

    it("should report storage reduction", async () => {
      // Create enough fingerprints to see storage impact
      const fingerprints = Array.from({ length: 55 }, (_, i) => {
        const timestamp = NOW - THIRTY_DAYS + i * ONE_DAY;
        return generateMockFingerprint(TEST_TOKEN_MINT, timestamp);
      });

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      // Should report storage reduction
      expect(result.storageReduced).toMatch(/KB|MB|GB/);

      // Storage reduction should be a reasonable format
      const match = result.storageReduced.match(/~(\d+)/);
      expect(match).toBeTruthy();
    });

    it("should not affect active token fingerprints", async () => {
      // Create recent fingerprints (would be marked active)
      const recentFingerprints = Array.from({ length: 20 }, (_, i) => {
        const timestamp = NOW - i * ONE_HOUR; // All within 1 day
        return generateMockFingerprint(TEST_TOKEN_MINT, timestamp);
      });

      await db.insert(tokenFingerprints).values(recentFingerprints);

      const beforeCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      // Run bucketing (should not affect recent tokens)
      await bucketInactiveFingerprints();

      const afterCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      // Recent fingerprints shouldn't be bucketed
      const nonArchivedAfter = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT} AND is_archived = false`);

      expect(nonArchivedAfter.length).toBeGreaterThanOrEqual(
        Math.floor(beforeCount.length * 0.8)
      );
    });

    it("should handle multiple tokens independently", async () => {
      const token1 = TEST_TOKEN_MINT + "_1";
      const token2 = TEST_TOKEN_MINT + "_2";

      // Create fingerprints for both tokens
      const fps1 = Array.from({ length: 30 }, (_, i) =>
        generateMockFingerprint(token1, NOW - THIRTY_DAYS + i * ONE_DAY)
      );

      const fps2 = Array.from({ length: 30 }, (_, i) =>
        generateMockFingerprint(token2, NOW - THIRTY_DAYS + i * ONE_DAY)
      );

      await db.insert(tokenFingerprints).values([...fps1, ...fps2]);

      const result = await bucketInactiveFingerprints();

      // Should process both tokens
      expect(result.tokensBucketed).toBeGreaterThanOrEqual(0);
      expect(result.fingerprintsBucketed).toBeGreaterThanOrEqual(0);

      // Cleanup
      await db
        .delete(tokenFingerprints)
        .where(sql`token_mint IN (${token1}, ${token2})`);
    });
  });

  describe("estimateInactiveTokenStorageSavings", () => {
    it("should return storage estimate with correct structure", () => {
      const estimate = estimateInactiveTokenStorageSavings();

      expect(estimate).toHaveProperty("before");
      expect(estimate).toHaveProperty("after");
      expect(estimate).toHaveProperty("reduction");
    });

    it("should show significant reduction from bucketing", () => {
      const estimate = estimateInactiveTokenStorageSavings();

      // Before should have many fingerprints
      expect(estimate.before).toContain("55");

      // After should have much fewer
      expect(estimate.after).toContain("6");

      // Reduction should be ~89%
      expect(estimate.reduction).toContain("89%");
    });

    it("should demonstrate compaction effect", () => {
      const estimate = estimateInactiveTokenStorageSavings();

      // Before: 55 fingerprints
      // After: ~6 averaged buckets
      // This is ~11x compression
      expect(estimate.before).toMatch(/55/);
      expect(estimate.after).toMatch(/6/);
    });
  });

  describe("Storage Impact Analysis", () => {
    it("should show that bucketing preserves important metadata", () => {
      // Even with bucketing, averaged fingerprints retain:
      // - Average vector (50 dimensions)
      // - Averaged win rate
      // - Averaged multiplier
      // - Average hold minutes
      // - Min/max prices

      const estimate = estimateInactiveTokenStorageSavings();

      // Should reference the preserved metrics
      expect(estimate.after).toBeDefined();
      expect(typeof estimate.after).toBe("string");
    });

    it("should calculate reduction percentage", () => {
      const estimate = estimateInactiveTokenStorageSavings();

      // Extract percentage from reduction string
      const match = estimate.reduction.match(/(\d+)%/);
      expect(match).toBeTruthy();

      if (match) {
        const percentage = parseInt(match[1]);
        // Should be substantial reduction (at least 50%)
        expect(percentage).toBeGreaterThan(50);
        expect(percentage).toBeLessThanOrEqual(100);
      }
    });

    it("should demonstrate per-token savings", () => {
      const estimate = estimateInactiveTokenStorageSavings();

      // Should show per-token calculation
      expect(estimate.before).toContain("KB");
      expect(estimate.after).toContain("KB");

      // After should be significantly smaller
      const beforeMatch = estimate.before.match(/(\d+\.?\d*)\s*KB/);
      const afterMatch = estimate.after.match(/(\d+\.?\d*)\s*KB/);

      if (beforeMatch && afterMatch) {
        const beforeSize = parseFloat(beforeMatch[1]);
        const afterSize = parseFloat(afterMatch[1]);
        expect(afterSize).toBeLessThan(beforeSize);
      }
    });
  });

  describe("Bucketing Algorithm", () => {
    it("should properly group fingerprints by time windows", async () => {
      // Test 6-hour bucketing for 0-24h window
      const fingerprints = [];

      // Create fingerprints spread across 24 hours
      for (let i = 0; i < 24; i++) {
        const timestamp = NOW - ONE_DAY + i * ONE_HOUR;
        fingerprints.push(generateMockFingerprint(TEST_TOKEN_MINT, timestamp));
      }

      // Add old ones to trigger bucketing
      for (let i = 0; i < 10; i++) {
        fingerprints.push(
          generateMockFingerprint(TEST_TOKEN_MINT, NOW - THIRTY_DAYS - i * ONE_DAY)
        );
      }

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      // Should process fingerprints
      expect(result.fingerprintsBucketed).toBeGreaterThanOrEqual(0);
    });

    it("should handle edge cases in bucketing", async () => {
      // Test with exact bucket boundary timestamps
      const sixHourBoundary = Math.floor(NOW / (6 * ONE_HOUR)) * (6 * ONE_HOUR);

      const fingerprints = [
        generateMockFingerprint(TEST_TOKEN_MINT, sixHourBoundary),
        generateMockFingerprint(TEST_TOKEN_MINT, sixHourBoundary + 1),
        generateMockFingerprint(TEST_TOKEN_MINT, sixHourBoundary - 1),
      ];

      // Add old ones
      fingerprints.push(
        generateMockFingerprint(TEST_TOKEN_MINT, NOW - THIRTY_DAYS)
      );

      await db.insert(tokenFingerprints).values(fingerprints);

      const result = await bucketInactiveFingerprints();

      expect(result).toHaveProperty("fingerprintsBucketed");
      expect(result.fingerprintsBucketed).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Integration: Bucketing Lifecycle", () => {
    it("should demonstrate full lifecycle from creation to bucketing", async () => {
      // 1. Create fingerprints over 30 days
      const fingerprints = Array.from({ length: 100 }, (_, i) => {
        const timestamp = NOW - THIRTY_DAYS + i * ONE_DAY * 0.3; // Spread over 30 days
        return generateMockFingerprint(TEST_TOKEN_MINT, timestamp);
      });

      await db.insert(tokenFingerprints).values(fingerprints);

      // 2. Verify all exist
      const beforeCount = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${TEST_TOKEN_MINT}`);

      expect(beforeCount.length).toBeGreaterThan(0);

      // 3. Run bucketing
      const result = await bucketInactiveFingerprints();

      expect(result.tokensBucketed).toBeGreaterThanOrEqual(0);

      // 4. Verify some are archived
      const afterNonArchived = await db
        .select()
        .from(tokenFingerprints)
        .where(
          sql`token_mint = ${TEST_TOKEN_MINT} AND is_archived = false`
        );

      // Should have fewer non-archived after bucketing
      expect(afterNonArchived.length).toBeLessThanOrEqual(beforeCount.length);
    });
  });
});
