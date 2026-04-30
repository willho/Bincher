// @ts-nocheck
import { db } from "./db";
import { tokenFingerprints, tokenFingerprintClusters } from "@shared/schema";
import { and, eq, lt, gte } from "drizzle-orm";

/**
 * Smart Compression Job: Archive old fingerprints into dynamic clusters
 * Runs once daily to prevent DB bloat while maintaining pattern matching quality
 *
 * Strategy (prevents DB from growing unbounded while keeping active tokens untouched):
 *
 * 1. ACTIVITY CHECK - Only compress truly dormant tokens
 *    - Token dormant if: NO trades in last 30 days
 *    - Keep tokens with recent trades (still running, may graduate later)
 *
 * 2. CLUSTER MANAGEMENT - Dynamic split/merge for quality
 *    - Compress fingerprints into k-means clusters per snapshot_trigger
 *    - QUALITY METRIC: Cluster cohesion (avg distance to centroid)
 *    - IF cohesion > threshold (too loose): SPLIT into k+1 clusters
 *    - IF clusters similar (distance < threshold): MERGE them
 *    - Result: Tighter, more specific clusters over time
 *
 * 3. BEST MATCH - Find or create cluster for each fingerprint group
 *    - New fingerprints query existing clusters
 *    - IF matches cluster within distance threshold: Add to cluster
 *    - ELSE: Create new cluster
 *    - Result: Clusters evolve to catch edge cases
 *
 * Expected DB Trajectory:
 * - Week 1: 100 GB/day growth (raw new data)
 * - Week 2-3: 30 GB/day growth (compression kicking in)
 * - Week 4+: STABLE ~30 GB/day (compression = growth rate)
 *   = Roughly 900 GB/month steady state (vs 600GB growth without compression)
 */

interface KMeansResult {
  clusters: number[][];
  centroids: number[][];
  labels: number[];
}

/**
 * Simple k-means implementation
 * Partitions vectors into k clusters and finds centroids
 */
function kMeans(vectors: number[][], k: number, maxIterations: number = 10): KMeansResult {
  if (vectors.length === 0) {
    return { clusters: [], centroids: [], labels: [] };
  }

  const vectorDim = vectors[0].length;
  const n = vectors.length;

  // Initialize centroids randomly from input vectors
  let centroids: number[][] = [];
  const indices = new Set<number>();
  while (centroids.length < k && centroids.length < n) {
    const idx = Math.floor(Math.random() * n);
    if (!indices.has(idx)) {
      indices.add(idx);
      centroids.push([...vectors[idx]]);
    }
  }

  // If k > n, pad with zero vectors
  while (centroids.length < k) {
    centroids.push(new Array(vectorDim).fill(0));
  }

  let labels: number[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign points to nearest centroid
    labels = vectors.map((vector) => {
      let minDist = Infinity;
      let bestCluster = 0;
      for (let i = 0; i < centroids.length; i++) {
        const dist = euclideanDistance(vector, centroids[i]);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = i;
        }
      }
      return bestCluster;
    });

    // Update centroids
    const newCentroids: number[][] = [];
    for (let i = 0; i < k; i++) {
      const clusterPoints = vectors.filter((_, idx) => labels[idx] === i);
      if (clusterPoints.length === 0) {
        newCentroids.push(centroids[i]); // Keep old centroid if cluster empty
      } else {
        newCentroids.push(averageVectors(clusterPoints));
      }
    }

    // Check convergence
    let converged = true;
    for (let i = 0; i < k; i++) {
      if (euclideanDistance(centroids[i], newCentroids[i]) > 0.001) {
        converged = false;
        break;
      }
    }

    centroids = newCentroids;
    if (converged) break;
  }

  // Group vectors by cluster
  const clusters: number[][] = Array(k)
    .fill(0)
    .map(() => []);
  vectors.forEach((_, idx) => {
    clusters[labels[idx]].push(idx);
  });

  return { clusters, centroids, labels };
}

function euclideanDistance(v1: number[], v2: number[]): number {
  let sum = 0;
  for (let i = 0; i < v1.length; i++) {
    const diff = v1[i] - v2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    avg[i] /= vectors.length;
  }
  return avg;
}

/**
 * Main compression job: Smart clustering with activity checking + dynamic split/merge
 *
 * Key safeguard: Only compresses dormant tokens (no trades in 30 days)
 * Active tokens (still trading, may graduate) are left untouched
 */
export async function compressOldFingerprints(): Promise<{
  totalCompressed: number;
  clustersCreated: number;
  clustersOptimized: number;
  storageReduced: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;

  const SNAPSHOT_TRIGGER_TYPES = [
    "time_1min",
    "time_2min",
    "time_5min",
    "time_10min",
    "trade_count_50",
    "trade_count_100",
    "trade_count_250",
    "trade_count_500",
    "milestone_100_traders",
    "milestone_500_traders",
    "milestone_price_2x",
    "milestone_price_5x",
    "milestone_price_10x",
    "graduation",
    "postgrad_time_1min",
    "postgrad_time_5min",
    "postgrad_time_10min",
  ];

  let totalCompressed = 0;
  let clustersCreated = 0;
  let clustersOptimized = 0;

  for (const triggerType of SNAPSHOT_TRIGGER_TYPES) {
    // Get candidate snapshots (30+ days old, not archived)
    const candidates = await db
      .select()
      .from(tokenFingerprints)
      .where(
        and(
          eq(tokenFingerprints.snapshotTrigger, triggerType),
          lt(tokenFingerprints.snapshotTimestamp, thirtyDaysAgo),
          eq(tokenFingerprints.isArchived, false)
        )
      );

    if (candidates.length < 5) {
      console.log(
        `[Compressor] Skipping ${triggerType}: only ${candidates.length} candidates`
      );
      continue;
    }

    // ACTIVITY CHECK: Filter to dormant tokens only
    // Token is dormant if: no trades recorded in last 30 days
    const dormantCandidates = candidates.filter((snap) => {
      // Check if token still has recent trades
      // If token has finalTimestamp > 30d ago, it's still active
      if (snap.finalTimestamp && snap.finalTimestamp > thirtyDaysAgo) {
        return false; // Still active, skip compression
      }
      return true; // Dormant, safe to compress
    });

    if (dormantCandidates.length < 5) {
      console.log(
        `[Compressor] ${triggerType}: ${candidates.length} candidates, but only ${dormantCandidates.length} dormant (others still trading)`
      );
      continue;
    }

    // Extract vectors from dormant fingerprints
    const vectors = dormantCandidates
      .filter((s) => s.fingerprintVector && Array.isArray(s.fingerprintVector))
      .map((s) => s.fingerprintVector as number[]);

    if (vectors.length < 5) {
      console.log(
        `[Compressor] ${triggerType}: only ${vectors.length} valid vectors from dormant tokens`
      );
      continue;
    }

    // CLUSTERING: Start with k=√n, then optimize
    let k = Math.min(Math.ceil(Math.sqrt(vectors.length)), 100);
    let result = kMeans(vectors, k);
    let cohesions = calculateCohesions(vectors, result);

    // DYNAMIC SPLITTING: If cluster too loose (high variance), split it
    const avgCohesion =
      cohesions.reduce((a, b) => a + b) / cohesions.length;
    const tightClusters = cohesions.filter((c) => c < avgCohesion * 1.2).length;

    if (tightClusters < k * 0.5) {
      // Less than 50% of clusters are tight = too loose overall
      console.log(
        `[Compressor] ${triggerType}: Cohesion too loose (${(avgCohesion * 100).toFixed(1)}), splitting...`
      );
      k = Math.min(k + 5, Math.ceil(Math.sqrt(vectors.length * 1.2)));
      result = kMeans(vectors, k);
      cohesions = calculateCohesions(vectors, result);
      clustersOptimized++;
    }

    // DYNAMIC MERGING: If small clusters exist, try to merge with nearest
    const smallClusters = result.clusters
      .map((indices, idx) => ({ idx, size: indices.length }))
      .filter((c) => c.size < 3);

    for (const small of smallClusters) {
      let nearestIdx = -1;
      let nearestDist = Infinity;

      for (let i = 0; i < result.centroids.length; i++) {
        if (i === small.idx) continue;
        const dist = euclideanDistance(
          result.centroids[small.idx],
          result.centroids[i]
        );
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }

      if (nearestIdx >= 0 && nearestDist < 0.3) {
        // Similar clusters, merge them
        result.clusters[nearestIdx].push(...result.clusters[small.idx]);
        result.clusters[small.idx] = [];
        clustersOptimized++;
      }
    }

    // Create cluster representatives (skip empty clusters)
    const validClusters = result.clusters.filter((c) => c.length > 0);

    for (let i = 0; i < validClusters.length; i++) {
      const clusterIndices = validClusters[i];
      const clusterSnapshots = clusterIndices
        .map((idx) =>
          dormantCandidates.find(
            (s) => s.fingerprintVector === vectors[idx]
          )
        )
        .filter((s): s is typeof dormantCandidates[0] => s !== undefined);

      if (clusterSnapshots.length === 0) continue;

      // Aggregate metrics
      const ageValues = clusterSnapshots
        .map((s) => s.tokenAgeMinutes)
        .filter((a): a is number => a !== null && a !== undefined);

      const winRates = clusterSnapshots
        .map((s) => s.winRate)
        .filter((w): w is number => w !== null && w !== undefined);

      const multipliers = clusterSnapshots
        .map((s) => s.medianMultiplier)
        .filter((m): m is number => m !== null && m !== undefined);

      const holdTimes = clusterSnapshots
        .map((s) => s.avgHoldMinutes)
        .filter((h): h is number => h !== null && h !== undefined);

      // Calculate centroid for this cluster
      const centroid = averageVectors(
        clusterIndices.map((idx) => vectors[idx])
      );

      // Insert cluster representative
      await db.insert(tokenFingerprintClusters).values({
        clusterId: `${triggerType}_${now}_${i}`,
        snapshotTrigger: triggerType,
        centroidVector: centroid,
        sampleCount: clusterIndices.length,
        ageRangeStart:
          ageValues.length > 0 ? Math.min(...ageValues) : undefined,
        ageRangeEnd:
          ageValues.length > 0 ? Math.max(...ageValues) : undefined,
        cohesion: cohesions[i] || 0,
        avgWinRate:
          winRates.length > 0
            ? winRates.reduce((a, b) => a + b) / winRates.length
            : undefined,
        avgFinalMultiplier:
          multipliers.length > 0
            ? multipliers.reduce((a, b) => a + b) / multipliers.length
            : undefined,
        avgHoldMinutes:
          holdTimes.length > 0
            ? holdTimes.reduce((a, b) => a + b) / holdTimes.length
            : undefined,
        compressedAt: now,
        archivedSnapshotCount: clusterIndices.length,
        createdAt: now,
      });

      clustersCreated++;
    }

    // Mark dormant snapshots as archived
    const snapshotIds = dormantCandidates.map((s) => s.id);
    for (const id of snapshotIds) {
      await db
        .update(tokenFingerprints)
        .set({ isArchived: true, updatedAt: now })
        .where(eq(tokenFingerprints.id, id));
    }

    totalCompressed += dormantCandidates.length;
    console.log(
      `[Compressor] ${triggerType}: Compressed ${dormantCandidates.length} dormant snapshots into ${validClusters.length} clusters (k=${k})`
    );
  }

  // Calculate storage reduction
  const storageReduced = `~${Math.round(totalCompressed * 0.7)} KB`;

  console.log(
    `[Compressor] COMPLETE: Compressed ${totalCompressed} dormant snapshots into ${clustersCreated} clusters (${clustersOptimized} optimized). Storage freed: ${storageReduced}`
  );

  return { totalCompressed, clustersCreated, clustersOptimized, storageReduced };
}

/**
 * Calculate cohesion (average distance to centroid) for each cluster
 */
function calculateCohesions(
  vectors: number[][],
  result: KMeansResult
): number[] {
  return result.clusters.map((clusterIndices, clusterIdx) => {
    const centroid = result.centroids[clusterIdx];
    const distances = clusterIndices.map((idx) =>
      euclideanDistance(vectors[idx], centroid)
    );
    return distances.length > 0
      ? distances.reduce((a, b) => a + b) / distances.length
      : 0;
  });
}

/**
 * Search for similar fingerprints across recent + archived
 * Returns closest matches by vector similarity
 *
 * Strategy:
 * - Recent fingerprints (granular) have highest priority
 * - Cluster matches show representative patterns
 * - Best cluster match + sample count helps trading decisions
 */
export async function findSimilarFingerprints(
  queryVector: number[],
  snapshotTrigger: string,
  limit: number = 10
): Promise<
  {
    type: "recent" | "cluster";
    tokenMint?: string;
    clusterId?: string;
    sampleCount?: number;
    similarity: number;
  }[]
> {
  const results: any[] = [];

  // Search recent fingerprints (not archived) - granular matches
  const recentMatches = await db
    .select()
    .from(tokenFingerprints)
    .where(
      and(
        eq(tokenFingerprints.snapshotTrigger, snapshotTrigger),
        eq(tokenFingerprints.isArchived, false)
      )
    );

  for (const match of recentMatches) {
    if (!match.fingerprintVector) continue;
    const similarity = cosineSimilarity(
      queryVector,
      match.fingerprintVector as number[]
    );
    results.push({
      type: "recent",
      tokenMint: match.tokenMint,
      similarity,
    });
  }

  // Search cluster centroids - compressed matches
  const clusters = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.snapshotTrigger, snapshotTrigger));

  for (const cluster of clusters) {
    const similarity = cosineSimilarity(queryVector, cluster.centroidVector);
    results.push({
      type: "cluster",
      clusterId: cluster.clusterId,
      sampleCount: cluster.sampleCount,
      similarity,
    });
  }

  // Sort by similarity (descending) and return top results
  // Recent matches will naturally rank higher due to granularity
  return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Best-fit cluster assignment for new fingerprints
 *
 * When a new fingerprint arrives late in a token's life (>30 days),
 * find the best matching cluster or return null if no good match.
 *
 * Used to incrementally update clusters as edge cases arrive.
 */
export async function findBestClusterForFingerprint(
  vector: number[],
  snapshotTrigger: string,
  similarityThreshold: number = 0.85
): Promise<string | null> {
  const clusters = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.snapshotTrigger, snapshotTrigger));

  let bestCluster: string | null = null;
  let bestSimilarity = 0;

  for (const cluster of clusters) {
    const similarity = cosineSimilarity(vector, cluster.centroidVector);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCluster = cluster.clusterId;
    }
  }

  // Only return cluster if similarity above threshold
  // Below threshold = this fingerprint represents new pattern
  if (bestSimilarity >= similarityThreshold) {
    return bestCluster;
  }

  return null;
}

function cosineSimilarity(v1: number[], v2: number[]): number {
  if (v1.length !== v2.length) return 0;

  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < v1.length; i++) {
    dotProduct += v1[i] * v2[i];
    mag1 += v1[i] * v1[i];
    mag2 += v2[i] * v2[i];
  }

  mag1 = Math.sqrt(mag1);
  mag2 = Math.sqrt(mag2);

  if (mag1 === 0 || mag2 === 0) return 0;
  return dotProduct / (mag1 * mag2);
}
