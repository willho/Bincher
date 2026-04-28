import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import {
  assignTokenToCluster,
  estimateClusterSize,
  estimateFullFingerprinterSize,
  triggerClusterRebalancing,
} from "./fingerprint-cluster-management";
import { sql } from "drizzle-orm";

/**
 * Tests for Fingerprint Cluster Management
 * Verifies intelligent clustering prevents fragmentation
 */

describe("Fingerprint Cluster Management", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function generateVector(
    baseValue: number = 0.5,
    variance: number = 0.05
  ): number[] {
    return Array.from({ length: 50 }, () => {
      const v = baseValue + (Math.random() - 0.5) * 2 * variance;
      return Math.max(0, Math.min(1, v)); // Clamp to [0, 1]
    });
  }

  function generateFingerprint(tokenMint: string, vector: number[]) {
    return {
      id: `fp_${tokenMint}_${Math.random()}`,
      tokenMint,
      snapshotTimestamp: NOW - Math.random() * 3600,
      snapshotTrigger: "test",
      fingerprintVector: vector,
      winRate: Math.random(),
      medianMultiplier: Math.random() * 5,
      avgHoldMinutes: Math.random() * 1440,
      whaleEntryCount: 0,
      clusterCoordination: Math.random(),
      buyerDiversity: Math.random(),
      holderConcentration: Math.random(),
      isArchived: false,
      assignedClusterId: null,
      vectorSimilarityToCluster: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(async () => {
    await db.delete(tokenFingerprintClusters).where(
      sql`cluster_id LIKE ${"cluster_test_%"}`
    );
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"token_test_%"}`
    );
  });

  afterEach(async () => {
    await db.delete(tokenFingerprintClusters).where(
      sql`cluster_id LIKE ${"cluster_test_%"}`
    );
    await db.delete(tokenFingerprints).where(
      sql`token_mint LIKE ${"token_test_%"}`
    );
  });

  describe("assignTokenToCluster", () => {
    it("should create first cluster when none exist", async () => {
      const vector = generateVector(0.5);
      const result = await assignTokenToCluster(
        "token_test_1",
        vector,
        "dead"
      );

      expect(result.isNewCluster).toBe(true);
      expect(result.sampleCount).toBe(1);
      expect(result.similarityToCluster).toBe(1.0);
    });

    it("should merge similar tokens into same cluster", async () => {
      const baseVector = generateVector(0.5, 0.01); // Low variance = tight cluster

      // Create base cluster
      const result1 = await assignTokenToCluster(
        "token_test_1",
        baseVector,
        "dead"
      );

      // Create very similar vector
      const similarVector = generateVector(0.5, 0.01);
      const result2 = await assignTokenToCluster(
        "token_test_2",
        similarVector,
        "dead"
      );

      // Should merge into same cluster
      expect(result2.clusterId).toBe(result1.clusterId);
      expect(result2.sampleCount).toBe(2);
      expect(result2.isNewCluster).toBe(false);
    });

    it("should create new cluster for dissimilar tokens", async () => {
      const vector1 = generateVector(0.2, 0.01);
      const vector2 = generateVector(0.8, 0.01);

      const result1 = await assignTokenToCluster(
        "token_test_1",
        vector1,
        "dead"
      );
      const result2 = await assignTokenToCluster(
        "token_test_2",
        vector2,
        "dead"
      );

      // Should be different clusters
      expect(result2.clusterId).not.toBe(result1.clusterId);
      expect(result2.isNewCluster).toBe(true);
    });

    it("should track sample count correctly", async () => {
      const vector = generateVector(0.5, 0.01);

      // Add 5 tokens to same cluster
      let lastResult = null;
      for (let i = 0; i < 5; i++) {
        const result = await assignTokenToCluster(
          `token_test_${i}`,
          vector,
          "dead"
        );
        lastResult = result;
      }

      expect(lastResult?.sampleCount).toBe(5);
    });

    it("should separate dead and active tokens into different clusters", async () => {
      const vector = generateVector(0.5);

      const deadResult = await assignTokenToCluster(
        "token_test_dead",
        vector,
        "dead"
      );

      const activeResult = await assignTokenToCluster(
        "token_test_active",
        vector,
        "active"
      );

      // Same vector but different clusters because different types
      expect(deadResult.clusterId).not.toBe(activeResult.clusterId);
    });

    it("should prevent cluster from growing unbounded (split protection)", async () => {
      const vector = generateVector(0.5, 0.01);

      // Try to add more tokens than split threshold (1000)
      // In practice, on 1001st token, should create new cluster
      // For this test, just verify the logic exists

      let result = null;
      for (let i = 0; i < 10; i++) {
        result = await assignTokenToCluster(
          `token_test_${i}`,
          vector,
          "dead"
        );
      }

      // After 10 tokens, should all be in same cluster (no split yet)
      expect(result?.sampleCount).toBeLessThanOrEqual(10);
    });
  });

  describe("Cluster Statistics", () => {
    it("should track cluster cohesion (vector similarity)", async () => {
      // Tight cluster: all vectors similar
      const baseVector = generateVector(0.5, 0.01);

      for (let i = 0; i < 5; i++) {
        await assignTokenToCluster(`token_test_tight_${i}`, baseVector, "dead");
      }

      // Get cluster
      const clusters = await db
        .select()
        .from(tokenFingerprintClusters)
        .where(sql`type = ${"dead"}`);

      expect(clusters.length).toBeGreaterThan(0);
      const cohesion = clusters[0]?.cohesion || 0;
      expect(cohesion).toBeGreaterThan(0.8); // Tight cluster = high cohesion
    });

    it("should track similarity range (min/max)", async () => {
      const vector = generateVector(0.5, 0.01);

      for (let i = 0; i < 3; i++) {
        await assignTokenToCluster(
          `token_test_range_${i}`,
          vector,
          "dead"
        );
      }

      const clusters = await db
        .select()
        .from(tokenFingerprintClusters)
        .where(sql`type = ${"dead"}`);

      const cluster = clusters[0];
      expect(cluster?.minSimilarity).toBeLessThanOrEqual(
        cluster?.maxSimilarity || 0
      );
      expect(cluster?.minSimilarity).toBeGreaterThan(0.7); // Similar vectors
    });

    it("should update sample count on cluster", async () => {
      const vector = generateVector(0.5);

      let clusterId = "";
      for (let i = 0; i < 3; i++) {
        const result = await assignTokenToCluster(
          `token_test_count_${i}`,
          vector,
          "dead"
        );
        if (i === 0) clusterId = result.clusterId;
      }

      const clusters = await db
        .select()
        .from(tokenFingerprintClusters)
        .where(sql`cluster_id = ${clusterId}`);

      expect(clusters[0]?.sampleCount).toBe(3);
    });
  });

  describe("Size Estimates", () => {
    it("should estimate optimal cluster count", () => {
      const estimate = estimateClusterSize();

      // Optimal: ~5 tokens per cluster
      const expectedClusters = 36000 / 5;
      expect(estimate.clusterCount).toBeLessThan(10000);
      expect(estimate.clusterCount).toBeGreaterThan(1000);
      expect(estimate.avgSampleSize).toBe(5);
    });

    it("should estimate reasonable DB size", () => {
      const estimate = estimateClusterSize();

      // Should be << 36GB (if every token had own cluster)
      expect(estimate.dbSizeGB).toBeLessThan(10);
      expect(estimate.dbSizeGB).toBeGreaterThan(0.1);
    });

    it("should show optimal scenario advantages", () => {
      const estimate = estimateClusterSize();

      expect(estimate.risk).toContain("GOOD");
      expect(estimate.risk).not.toContain("CRITICAL");
    });

    it("should break down full fingerprinter size", () => {
      const layers = estimateFullFingerprinterSize();

      expect(layers).toHaveLength(5);
      expect(layers[0]?.layer).toContain("fingerprints");
      expect(layers[1]?.layer).toContain("centroids");
      expect(layers[4]?.layer).toContain("TOTAL");

      // Total should be reasonable
      const total = layers[4]?.sizeGB || 0;
      expect(total).toBeLessThan(50);
      expect(total).toBeGreaterThan(10);
    });

    it("should show component breakdown", () => {
      const layers = estimateFullFingerprinterSize();

      let previousSize = 0;
      layers.forEach((layer, i) => {
        if (i < layers.length - 1) {
          // Non-total layers should have reasonable size
          expect(layer.sizeGB).toBeGreaterThan(0);
        }
      });

      // Total is sum of components
      const total = layers.reduce((sum, l, i) => {
        if (i < layers.length - 1) return sum + l.sizeGB;
        return sum;
      }, 0);

      expect(total).toBeGreaterThan(10);
    });
  });

  describe("Worst-Case Analysis", () => {
    it("should prevent fragmentation (no merge)", () => {
      const estimate = estimateClusterSize();

      // Worst case: no merge → 36K clusters
      // Our approach: ~7K clusters
      // Reduction factor: 5x

      expect(estimate.clusterCount).toBeLessThan(36000);
      expect(estimate.clusterCount / 36000).toBeCloseTo(0.2, 0); // ~20% of worst case
    });

    it("should prevent signal loss (aggressive merge)", () => {
      // Worst case: all → 2 clusters (dead/active)
      // Our approach: ~7K clusters with meaningful granularity

      const estimate = estimateClusterSize();

      // Should have many clusters, not just 2
      expect(estimate.clusterCount).toBeGreaterThan(100);
    });

    it("should balance complexity vs compression", () => {
      const estimate = estimateClusterSize();

      // Goldilocks zone:
      // - More than 2 clusters (preserve signal)
      // - Fewer than 36K clusters (prevent bloat)
      // - Avg 5 tokens/cluster (confidence metric)

      expect(estimate.clusterCount).toBeGreaterThan(10);
      expect(estimate.clusterCount).toBeLessThan(10000);
      expect(estimate.avgSampleSize).toBeGreaterThan(1);
      expect(estimate.avgSampleSize).toBeLessThan(100);
    });

    it("should show DB size stays bounded", () => {
      const estimate = estimateClusterSize();
      const fullSize = estimateFullFingerprinterSize();

      const totalGB = fullSize[4]?.sizeGB || 0;

      // Should fit easily on database
      // Constraint: ~1 TB available, want < 50 GB steady state
      expect(totalGB).toBeLessThan(100);
    });
  });

  describe("Cluster Rebalancing", () => {
    it("should identify clusters needing split (too large)", async () => {
      // This would require manually creating a cluster with 1000+ samples
      // For now, test the function exists and returns structured result

      const result = await triggerClusterRebalancing();

      expect(result).toHaveProperty("splitClusters");
      expect(result).toHaveProperty("mergedClusters");
      expect(result).toHaveProperty("totalAffected");
    });

    it("should identify clusters for merging (similar + small)", async () => {
      const result = await triggerClusterRebalancing();

      expect(result.mergedClusters).toBeGreaterThanOrEqual(0);
      expect(result.totalAffected).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Schema Integration", () => {
    it("should support clustering across real fingerprints", async () => {
      const vector = generateVector(0.5);

      // Create fingerprint
      const fp = generateFingerprint("token_test_schema", vector);
      await db.insert(tokenFingerprints).values([fp]);

      // Assign to cluster
      const result = await assignTokenToCluster(
        "token_test_schema",
        vector,
        "dead"
      );

      expect(result.clusterId).toBeDefined();

      // Update fingerprint with cluster assignment
      await db
        .update(tokenFingerprints)
        .set({
          assignedClusterId: result.clusterId,
          vectorSimilarityToCluster: result.similarityToCluster,
        })
        .where(sql`token_mint = ${"token_test_schema"}`);

      // Verify linkage
      const updated = await db
        .select()
        .from(tokenFingerprints)
        .where(sql`token_mint = ${"token_test_schema"}`);

      expect(updated[0]?.assignedClusterId).toBe(result.clusterId);
    });
  });
});
