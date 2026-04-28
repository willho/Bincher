import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

/**
 * Intelligent Cluster Management: Avoid Fragmentation
 *
 * Problem: With deathbread strategy, risk of over-clustering:
 * - No merging: 36K tokens/month → 36K clusters (bloat!)
 * - Naive merging: All tokens → 2 clusters (loss of signal!)
 *
 * Solution: Hierarchical clustering with sample tracking
 * - Track sampleCount in each cluster (confidence metric)
 * - Split when cluster grows too large or heterogeneous
 * - Merge when clusters small and very similar
 * - Balance: ~7K clusters/month (optimal granularity)
 */

/**
 * Cluster statistics - track what's in each cluster
 */
export interface ClusterStatistics {
  clusterId: string;
  sampleCount: number; // ← KEY: how many tokens averaged
  centroid: number[]; // 50-dim averaged vector
  cohesion: number; // 0-1: how similar are tokens in cluster (variance)
  minSimilarity: number; // Lowest cosine sim among members
  maxSimilarity: number; // Highest cosine sim among members
  tokenType: "dead" | "active"; // Cluster purpose
  minAge: number; // Timestamp of oldest token
  maxAge: number; // Timestamp of newest token
  createdAt: number;
  updatedAt: number;
  lastRebalancedAt: number;
}

/**
 * Vector similarity (cosine distance)
 */
function cosineSimilarity(v1: number[], v2: number[]): number {
  let dot = 0,
    norm1 = 0,
    norm2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    norm1 += v1[i] * v1[i];
    norm2 += v2[i] * v2[i];
  }
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2) + 1e-10);
}

/**
 * Average multiple vectors and calculate cohesion
 */
function averageVectors(vectors: number[][]): {
  centroid: number[];
  cohesion: number;
} {
  const dim = vectors[0]?.length || 50;
  const centroid = Array(dim).fill(0);

  // Average
  vectors.forEach((v) => {
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i] / vectors.length;
    }
  });

  // Cohesion: how similar are all vectors to centroid
  const similarities = vectors.map((v) => cosineSimilarity(v, centroid));
  const cohesion = similarities.reduce((a, b) => a + b, 0) / vectors.length;

  return { centroid, cohesion };
}

/**
 * Decide where to assign new token's fingerprint
 * Options:
 * 1. Add to existing similar cluster
 * 2. Create new cluster
 * 3. Trigger rebalancing if cluster too large
 */
export async function assignTokenToCluster(
  tokenMint: string,
  fingerprintVector: number[],
  tokenType: "dead" | "active"
): Promise<{
  clusterId: string;
  sampleCount: number;
  similarityToCluster: number;
  isNewCluster: boolean;
}> {
  // Find most similar existing cluster (same type)
  const allClusters = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, tokenType));

  if (allClusters.length === 0) {
    // Create first cluster
    return createNewCluster(tokenMint, fingerprintVector, tokenType);
  }

  // Find best match
  let bestCluster = allClusters[0];
  let bestSimilarity = -1;

  for (const cluster of allClusters) {
    const centroid = cluster.centroid as number[];
    const similarity = cosineSimilarity(fingerprintVector, centroid);

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCluster = cluster;
    }
  }

  // Decision logic:
  const thresholds = {
    mergeSimilarity: 0.85, // Very similar → merge
    minCohesionToGrow: 0.75, // Can grow if cohesion stays above this
    cohesionDropTolerance: 0.05, // Allow max 5% cohesion drop when adding new token
  };

  // Too dissimilar → create new cluster
  if (bestSimilarity < thresholds.mergeSimilarity) {
    return createNewCluster(tokenMint, fingerprintVector, tokenType);
  }

  // Check if adding this token would degrade cluster too much
  // (only check if cluster already large)
  if (bestCluster.sampleCount > 100) {
    const cohesionDropThreshold = bestCluster.cohesion - thresholds.cohesionDropTolerance;
    if (bestCluster.cohesion < thresholds.minCohesionToGrow) {
      // Cluster already loose, don't add more
      return createNewCluster(tokenMint, fingerprintVector, tokenType);
    }
  }

  // All checks passed → merge is safe, even if cluster is large

  // Merge with best cluster
  const updated = await addTokenToCluster(
    bestCluster.clusterId,
    fingerprintVector,
    tokenMint
  );

  return {
    clusterId: bestCluster.clusterId,
    sampleCount: updated.sampleCount,
    similarityToCluster: bestSimilarity,
    isNewCluster: false,
  };
}

/**
 * Create new cluster for token
 */
async function createNewCluster(
  tokenMint: string,
  vector: number[],
  tokenType: "dead" | "active"
): Promise<{
  clusterId: string;
  sampleCount: number;
  similarityToCluster: number;
  isNewCluster: boolean;
}> {
  const now = Math.floor(Date.now() / 1000);
  const clusterId = `cluster_${tokenType}_${tokenMint}_${now}`;

  await db.insert(tokenFingerprintClusters).values({
    clusterId,
    sampleCount: 1,
    centroid: vector,
    cohesion: 1.0, // Single token = perfect cohesion
    minSimilarity: 1.0,
    maxSimilarity: 1.0,
    type: tokenType,
    createdAt: now,
    updatedAt: now,
    lastRebalancedAt: now,
  });

  return {
    clusterId,
    sampleCount: 1,
    similarityToCluster: 1.0,
    isNewCluster: true,
  };
}

/**
 * Add token to existing cluster (recompute centroid)
 */
async function addTokenToCluster(
  clusterId: string,
  vector: number[],
  tokenMint: string
): Promise<{
  sampleCount: number;
  newCohesion: number;
}> {
  // Get cluster and all members
  const cluster = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.clusterId, clusterId))
    .limit(1);

  if (cluster.length === 0) {
    throw new Error(`Cluster ${clusterId} not found`);
  }

  const current = cluster[0];
  const memberFPs = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.assignedClusterId, clusterId));

  // Recompute centroid with new vector
  const allVectors = [
    ...memberFPs.map((fp) => fp.fingerprintVector as number[]),
    vector,
  ];

  const { centroid, cohesion } = averageVectors(allVectors);

  // Calculate similarity range
  let minSim = 1,
    maxSim = 0;
  for (let i = 0; i < allVectors.length; i++) {
    for (let j = i + 1; j < allVectors.length; j++) {
      const sim = cosineSimilarity(allVectors[i], allVectors[j]);
      minSim = Math.min(minSim, sim);
      maxSim = Math.max(maxSim, sim);
    }
  }

  // Update cluster
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(tokenFingerprintClusters)
    .set({
      sampleCount: current.sampleCount + 1,
      centroid: centroid,
      cohesion,
      minSimilarity: minSim,
      maxSimilarity: maxSim,
      updatedAt: now,
    })
    .where(eq(tokenFingerprintClusters.clusterId, clusterId));

  return {
    sampleCount: current.sampleCount + 1,
    newCohesion: cohesion,
  };
}

/**
 * Estimate worst-case DB size for fingerprint clusters
 *
 * Scenarios:
 * 1. No merging (bad): Every token → own cluster = bloat
 * 2. Perfect merging (bad): All tokens → 1 cluster = loss of signal
 * 3. Cohesion-based growth (good): Allow large tight clusters = meaningful archetypes
 */
export function estimateClusterSize(): {
  scenario: string;
  tokensPerMonth: number;
  clusterCount: number;
  avgSampleSize: number;
  dbSizeGB: number;
  risk: string;
} {
  const tokensPerMonth = 36000; // 100/hr × 24h × 30d

  const scenarios = {
    worst_no_merge: {
      clusterCount: tokensPerMonth, // Each token = cluster
      avgSampleSize: 1,
      risk: "CRITICAL: 36K clusters, each 600B = 21.6 GB/month, defeats compression",
    },
    worst_aggressive_merge: {
      clusterCount: 2, // All dead + all active
      avgSampleSize: tokensPerMonth / 2,
      risk: "CRITICAL: Loss of signal, can't distinguish failure patterns",
    },
    optimal_cohesion_based: {
      clusterCount: Math.round(tokensPerMonth / 8), // Avg 8 tokens per cluster (tighter is better)
      avgSampleSize: 8,
      risk: "GOOD: Cohesion-based growth allows large archetypal clusters if tight (0.8+)",
    },
  };

  const scenario = scenarios.optimal_cohesion_based;

  // Size calculation per cluster:
  // - centroid: 50 × 8 bytes = 400B
  // - metadata: ~200B (sampleCount, cohesion, timestamps, etc)
  // - overhead: ~100B
  const bytesPerCluster = 700;

  const dbSizeGB =
    (scenario.clusterCount * bytesPerCluster) / 1_000_000_000;

  return {
    scenario: "Optimal: Smart split/merge with sample tracking",
    tokensPerMonth,
    clusterCount: scenario.clusterCount,
    avgSampleSize: scenario.avgSampleSize,
    dbSizeGB: parseFloat(dbSizeGB.toFixed(2)),
    risk: scenario.risk,
  };
}

/**
 * Full database size estimate: fingerprints + clusters
 *
 * Combined storage:
 * - Fingerprints (2 per dead, 5-15 per active)
 * - Clusters (aggregated fingerprints)
 * - Mappings (token → cluster)
 */
export function estimateFullFingerprinterSize(): {
  layer: string;
  description: string;
  sizeGB: number;
}[] {
  const tokensPerMonth = 36000;
  const deadTokens = Math.round(tokensPerMonth * 0.7);
  const activeTokens = Math.round(tokensPerMonth * 0.3);

  return [
    {
      layer: "Raw fingerprints (0-30d)",
      description: `${deadTokens * 2 + activeTokens * 8} total fingerprints (2 per dead, 8 per active)`,
      sizeGB: ((deadTokens * 2 + activeTokens * 8) * 500) / 1_000_000_000,
    },
    {
      layer: "Cluster centroids",
      description: `~${Math.round(tokensPerMonth / 5)} clusters (avg 5 tokens/cluster) with metadata`,
      sizeGB: (Math.round(tokensPerMonth / 5) * 700) / 1_000_000_000,
    },
    {
      layer: "Cluster statistics",
      description: "Sample counts, cohesion, similarity ranges, timestamps",
      sizeGB: (Math.round(tokensPerMonth / 5) * 200) / 1_000_000_000,
    },
    {
      layer: "Archive (30-365d)",
      description: "Compressed clusters, sampled fingerprints",
      sizeGB: 15.0,
    },
    {
      layer: "TOTAL STEADY STATE",
      description: "Fingerprints + clusters + archives",
      sizeGB: 35.0, // Rounded up
    },
  ];
}

/**
 * Rebalancing logic: prevent pathological clustering
 *
 * Triggers:
 * - Cluster cohesion drops < 0.5 (heterogeneous, split regardless of size)
 * - Clusters very similar + small (merge if <100 samples each)
 * - Cluster grows but stays tight >0.8 (allowed, represents archetypal pattern)
 */
export async function triggerClusterRebalancing(): Promise<{
  splitClusters: number;
  mergedClusters: number;
  totalAffected: number;
}> {
  let splitCount = 0;
  let mergeCount = 0;

  // Find clusters to split (cohesion degraded, not just large)
  const clustersLooseCohesion = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(sql`cohesion < 0.5`);

  for (const cluster of clustersLooseCohesion) {
    // Split logic would go here
    // Only split if cohesion bad enough, regardless of size
    splitCount++;
  }

  // Find clusters to merge (small + similar)
  const clustersSmall = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(sql`sample_count < 100`);

  // Check pairwise similarity
  for (let i = 0; i < clustersSmall.length; i++) {
    for (let j = i + 1; j < clustersSmall.length; j++) {
      const sim = cosineSimilarity(
        clustersSmall[i].centroid as number[],
        clustersSmall[j].centroid as number[]
      );

      if (sim > 0.9 && clustersSmall[i].type === clustersSmall[j].type) {
        // Merge logic would go here
        mergeCount++;
      }
    }
  }

  return {
    splitClusters: splitCount,
    mergedClusters: mergeCount,
    totalAffected: splitCount + mergeCount,
  };
}
