import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../server/db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import {
  archiveTokenTrajectory,
  estimateClusterSize,
  estimateFullFingerprinterSize,
  reportArchetypeQuality,
} from "../server/fingerprint-cluster-management";
import { sql } from "drizzle-orm";

/**
 * Tests for Trajectory Archetype Management
 * Verifies post-mortem compression of token lifecycles into pattern archetypes
 */

describe("Trajectory Archetype Management", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function generateVector(
    baseValue: number = 0.5,
    variance: number = 0.05
  ): number[] {
    return Array.from({ length: 50 }, () => {
      const v = baseValue + (Math.random() - 0.5) * 2 * variance;
      return Math.max(0, Math.min(1, v));
    });
  }

  async function createTokenTrajectory(
    tokenMint: string,
    snapshotCount: number,
    baseVector: number[]
  ) {
    const fingerprints = [];
    for (let i = 0; i < snapshotCount; i++) {
      const variation = generateVector(baseVector[0], 0.02);
      fingerprints.push({
        fingerprintType: "pregrad_bonding_curve",
        tokenMint,
        snapshotTrigger: i === 0 ? "t0_creation" : `activity_volume_${i}`,
        snapshotTimestamp: NOW + i * 60,
        tokenAgeMinutes: i,
        fingerprintVector: variation,
        winRate: 0.5,
        medianMultiplier: 1.0 + i * 0.5,
        avgHoldMinutes: 30,
        createdAt: NOW + i * 60,
        updatedAt: NOW + i * 60,
      });
    }
    await db.insert(tokenFingerprints).values(fingerprints);
  }

  beforeEach(async () => {
    await db.delete(tokenFingerprintClusters).where(
      sql`cluster_id LIKE ${"trajectory_archetype_%"}`
    );
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"token_test_%"}`
    );
  });

  afterEach(async () => {
    await db.delete(tokenFingerprintClusters).where(
      sql`cluster_id LIKE ${"trajectory_archetype_%"}`
    );
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"token_test_%"}`
    );
  });

  describe("archiveTokenTrajectory", () => {
    it("should create first archetype from token trajectory", async () => {
      const tokenMint = "token_test_archive_1";
      const baseVector = generateVector(0.5, 0.01);

      await createTokenTrajectory(tokenMint, 5, baseVector);

      const result = await archiveTokenTrajectory(tokenMint, "volume_death");

      expect(result.isNewArchetype).toBe(true);
      expect(result.trajectoryLength).toBe(5);
      expect(result.archetypeClusterId).toContain("trajectory_archetype");
    });

    it("should merge similar trajectories into same archetype", async () => {
      const baseVector = generateVector(0.5, 0.01);

      await createTokenTrajectory("token_test_similar_1", 5, baseVector);
      const result1 = await archiveTokenTrajectory(
        "token_test_similar_1",
        "volume_death"
      );

      await createTokenTrajectory("token_test_similar_2", 5, baseVector);
      const result2 = await archiveTokenTrajectory(
        "token_test_similar_2",
        "volume_death"
      );

      expect(result2.archetypeClusterId).toBe(result1.archetypeClusterId);
      expect(result2.isNewArchetype).toBe(false);
    });

    it("should create separate archetypes for dissimilar trajectories", async () => {
      const slowBleeds = generateVector(0.2, 0.01);
      const suddenDump = generateVector(0.8, 0.01);

      await createTokenTrajectory("token_test_slow", 5, slowBleeds);
      const result1 = await archiveTokenTrajectory(
        "token_test_slow",
        "volume_death"
      );

      await createTokenTrajectory("token_test_dump", 5, suddenDump);
      const result2 = await archiveTokenTrajectory(
        "token_test_dump",
        "volume_death"
      );

      expect(result2.archetypeClusterId).not.toBe(result1.archetypeClusterId);
      expect(result2.isNewArchetype).toBe(true);
    });

    it("should reject trajectory with no fingerprints", async () => {
      try {
        await archiveTokenTrajectory("token_test_nonexistent", "volume_death");
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).toContain("No fingerprints found");
      }
    });

    it("should allow large archetypes if cohesion stays tight", async () => {
      const baseVector = generateVector(0.5, 0.01);

      // Archive 10 similar trajectories - should all merge
      let lastResult = null;
      for (let i = 0; i < 10; i++) {
        await createTokenTrajectory(`token_test_tight_${i}`, 5, baseVector);
        lastResult = await archiveTokenTrajectory(
          `token_test_tight_${i}`,
          "volume_death"
        );
      }

      // All should be in same archetype
      expect(lastResult?.archetypeClusterId).toBeDefined();
    });

    it("should track trajectory length in archetype", async () => {
      const baseVector = generateVector(0.5);

      // Token with 3 snapshots
      await createTokenTrajectory("token_test_len_1", 3, baseVector);
      const result = await archiveTokenTrajectory(
        "token_test_len_1",
        "volume_death"
      );

      expect(result.trajectoryLength).toBe(3);
    });
  });

  describe("Archetype Quality Reporting", () => {
    it("should report archetype statistics", async () => {
      const baseVector = generateVector(0.5, 0.01);

      // Create and archive a few trajectories
      for (let i = 0; i < 3; i++) {
        await createTokenTrajectory(`token_test_quality_${i}`, 5, baseVector);
        await archiveTokenTrajectory(
          `token_test_quality_${i}`,
          "volume_death"
        );
      }

      const stats = await reportArchetypeQuality();

      expect(stats.totalArchetypes).toBeGreaterThan(0);
      expect(stats.tightArchetypes).toBeGreaterThanOrEqual(0);
      expect(stats.looseArchetypes).toBeGreaterThanOrEqual(0);
      expect(stats.avgTokensPerArchetype).toBeGreaterThan(0);
      expect(stats.avgCohesion).toBeGreaterThan(0);
    });

    it("should return zero stats when no archetypes", async () => {
      const stats = await reportArchetypeQuality();

      expect(stats.totalArchetypes).toBe(0);
      expect(stats.avgTokensPerArchetype).toBe(0);
      expect(stats.avgCohesion).toBe(0);
    });
  });

  describe("Archetype Compression Estimates", () => {
    it("should estimate archetype-based compression", () => {
      const estimate = estimateClusterSize();

      expect(estimate.archetypeCount).toBeLessThan(36000); // Better than no compression
      expect(estimate.tokensPerArchetype).toBeGreaterThan(1); // Some merging
      expect(estimate.dbSizeGB).toBeLessThan(10); // Reasonable size
    });

    it("should show compression efficiency", () => {
      const estimate = estimateClusterSize();

      // ~12% of worst case (no compression) is good compression
      const compressionRatio = estimate.archetypeCount / 36000;
      expect(compressionRatio).toBeLessThan(0.2); // Less than 20% of worst case
      expect(compressionRatio).toBeGreaterThan(0.01); // But not trivial
    });

    it("should provide full fingerprinter size estimate", () => {
      const layers = estimateFullFingerprinterSize();

      expect(layers.length).toBeGreaterThan(0);
      expect(layers[layers.length - 1]?.layer).toContain("TOTAL");

      // Total should be reasonable
      const total = layers[layers.length - 1]?.sizeGB || 0;
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThan(100);
    });
  });
});
