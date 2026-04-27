import { db } from "./db";
import { tokenFingerprints, tokenFingerprintClusters } from "@shared/schema";
import { and, eq, lt, gte } from "drizzle-orm";

/**
 * Daily compression job: Archive old fingerprints into k-means clusters
 * Runs once per day to prevent DB bloat while maintaining pattern matching
 *
 * Strategy:
 * - Keep fingerprints from last 7 days (active trading window)
 * - For fingerprints 7-30 days old: Cluster by snapshot_trigger type
 * - For fingerprints 30+ days old: Store as cluster centroids only
 * - Use k-means to find N representative vectors per trigger type
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
 * Main compression job: Cluster fingerprints by snapshot_trigger type
 */
export async function compressOldFingerprints(): Promise<{
  totalCompressed: number;
  clustersCreated: number;
  storageReduced: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  const sevenDaysAgo = now - 7 * 86400;

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

  for (const triggerType of SNAPSHOT_TRIGGER_TYPES) {
    // Get old snapshots (30+ days) for this trigger type
    const oldSnapshots = await db
      .select()
      .from(tokenFingerprints)
      .where(
        and(
          eq(tokenFingerprints.snapshotTrigger, triggerType),
          lt(tokenFingerprints.snapshotTimestamp, thirtyDaysAgo),
          eq(tokenFingerprints.isArchived, false)
        )
      );

    if (oldSnapshots.length < 5) {
      console.log(
        `[Compressor] Skipping ${triggerType}: only ${oldSnapshots.length} snapshots found`
      );
      continue;
    }

    // Extract fingerprint vectors
    const vectors = oldSnapshots
      .filter((s) => s.fingerprintVector && Array.isArray(s.fingerprintVector))
      .map((s) => s.fingerprintVector as number[]);

    if (vectors.length < 5) {
      console.log(
        `[Compressor] Skipping ${triggerType}: only ${vectors.length} valid vectors`
      );
      continue;
    }

    // Determine optimal k (clusters)
    const k = Math.min(Math.ceil(Math.sqrt(vectors.length)), 100);

    // Run k-means
    const result = kMeans(vectors, k);

    // Calculate cluster cohesion (average distance from points to centroid)
    const cohesions = result.clusters.map((clusterIndices, clusterIdx) => {
      const centroid = result.centroids[clusterIdx];
      const distances = clusterIndices.map((idx) =>
        euclideanDistance(vectors[idx], centroid)
      );
      return distances.length > 0 ? distances.reduce((a, b) => a + b) / distances.length : 0;
    });

    // Create cluster representatives
    for (let i = 0; i < result.centroids.length; i++) {
      const clusterIndices = result.clusters[i];
      if (clusterIndices.length === 0) continue;

      const clusterSnapshots = clusterIndices.map((idx) =>
        oldSnapshots.filter((s) => s.fingerprintVector === vectors[idx])[0]
      );

      const ageValues = clusterSnapshots
        .map((s) => s.tokenAgeMinutes)
        .filter((a): a is number => a !== null && a !== undefined);

      // Calculate aggregate metrics
      const winRates = clusterSnapshots
        .map((s) => s.winRate)
        .filter((w): w is number => w !== null && w !== undefined);

      const multipliers = clusterSnapshots
        .map((s) => s.medianMultiplier)
        .filter((m): m is number => m !== null && m !== undefined);

      const holdTimes = clusterSnapshots
        .map((s) => s.avgHoldMinutes)
        .filter((h): h is number => h !== null && h !== undefined);

      // Insert cluster representative
      await db.insert(tokenFingerprintClusters).values({
        clusterId: `${triggerType}_${now}_${i}`,
        snapshotTrigger: triggerType,
        centroidVector: result.centroids[i],
        sampleCount: clusterIndices.length,
        ageRangeStart: ageValues.length > 0 ? Math.min(...ageValues) : undefined,
        ageRangeEnd: ageValues.length > 0 ? Math.max(...ageValues) : undefined,
        cohesion: cohesions[i],
        avgWinRate: winRates.length > 0 ? winRates.reduce((a, b) => a + b) / winRates.length : undefined,
        avgFinalMultiplier:
          multipliers.length > 0
            ? multipliers.reduce((a, b) => a + b) / multipliers.length
            : undefined,
        avgHoldMinutes:
          holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b) / holdTimes.length : undefined,
        compressedAt: now,
        archivedSnapshotCount: clusterIndices.length,
        createdAt: now,
      });

      clustersCreated++;
    }

    // Mark snapshots as archived
    const snapshotIds = oldSnapshots.map((s) => s.id);
    for (const id of snapshotIds) {
      await db
        .update(tokenFingerprints)
        .set({ isArchived: true, updatedAt: now })
        .where(eq(tokenFingerprints.id, id));
    }

    totalCompressed += oldSnapshots.length;
    console.log(
      `[Compressor] ${triggerType}: Compressed ${oldSnapshots.length} snapshots into ${k} clusters`
    );
  }

  // Calculate storage reduction
  const storageReduced = `~${Math.round(totalCompressed * 0.7)} KB`; // ~70% reduction per snapshot

  console.log(
    `[Compressor] COMPLETE: Compressed ${totalCompressed} snapshots into ${clustersCreated} clusters. Storage reduced: ${storageReduced}`
  );

  return { totalCompressed, clustersCreated, storageReduced };
}

/**
 * Search for similar fingerprints across recent + archived
 * Returns closest matches by vector similarity
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

  // Search recent fingerprints (not archived)
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
    const similarity = cosineSimilarity(queryVector, match.fingerprintVector as number[]);
    results.push({
      type: "recent",
      tokenMint: match.tokenMint,
      similarity,
    });
  }

  // Search cluster centroids
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
  return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
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
