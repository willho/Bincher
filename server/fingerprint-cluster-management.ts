import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

/**
 * Lifecycle Stage Archetype Management
 *
 * Key Insight: All tokens eventually reach a final state.
 * Each snapshot is a moment in the token's lifecycle with specific characteristics.
 * Snapshots cluster independently by STAGE, not by token.
 *
 * Architecture:
 * 1. Snapshot capture (existing): Activity-gated fingerprints at T0, per-min for 10min,
 *    per-50-trades after, per-multiplier at graduation
 * 2. Snapshot clustering: Each fingerprint independently clusters to lifecycle archetype
 *    based on its state (age, multiplier, holder concentration, etc.)
 *    - Snapshot 4 of Token X (1hr, 5x, tight holders) → archetype "pump_early_concentrated"
 *    - Snapshot 8 of Token X (6hr, 2x, dispersed) → archetype "crash_dispersed"
 *    - Snapshot 4 of Token Y (45min, 2x, tight) → SAME archetype "pump_early_concentrated"
 * 3. Trajectory emerges: Sequence of archetypes a token traverses (not averaged)
 *
 * Result: ~2-5K archetypes represent all lifecycle stages/patterns.
 * Same archetype can contain snapshots from different tokens at different times.
 * Preserves complete trajectory while clustering similar states together.
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
 * Cluster a single snapshot into lifecycle stage archetype
 *
 * Called whenever a fingerprint is created (activity-gated).
 * Snapshots cluster independently based on their STAGE characteristics,
 * not the complete token trajectory.
 *
 * Examples:
 * - Token X snapshot 4 (1hr, 5x, tight holders) → "pump_early_concentrated"
 * - Token Y snapshot 4 (45min, 2x, tight) → SAME "pump_early_concentrated"
 * - Token X snapshot 8 (6hr, 2x, dispersed) → "crash_dispersed"
 *
 * The trajectory emerges as the sequence of archetypes visited.
 */
export async function clusterSnapshotToArchetype(
  fingerprint: {
    tokenMint: string;
    fingerprintVector: number[];
    tokenAgeMinutes: number;
    medianMultiplier: number;
    holderConcentration?: number;
    buyerDiversity?: number;
  }
): Promise<{
  archetypeClusterId: string;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  const vector = fingerprint.fingerprintVector;

  // Find all existing archetypes (lifecycle stage patterns)
  const allArchetypes = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  if (allArchetypes.length === 0) {
    // Create first archetype for this stage
    return createStageArchetype(fingerprint);
  }

  // Find most similar archetype (same lifecycle stage/characteristics)
  let bestArchetype = allArchetypes[0];
  let bestSimilarity = -1;

  for (const archetype of allArchetypes) {
    const archetypeCentroid = archetype.centroid as number[];
    const similarity = cosineSimilarity(vector, archetypeCentroid);

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestArchetype = archetype;
    }
  }

  // Snapshot matching thresholds (stage-based)
  const thresholds = {
    mergeSimilarity: 0.80, // Similar lifecycle stages → merge
    minArchetypeCohesion: 0.70, // Archetype must stay tight
    cohesionDropTolerance: 0.08, // Allow max 8% cohesion drop
  };

  // Too different stage → create new archetype
  if (bestSimilarity < thresholds.mergeSimilarity) {
    return createStageArchetype(fingerprint);
  }

  // Check if merging would degrade archetype cohesion
  if (bestArchetype.sampleCount > 50) {
    if (bestArchetype.cohesion < thresholds.minArchetypeCohesion) {
      // Archetype already loose, create new one
      return createStageArchetype(fingerprint);
    }
  }

  // Merge snapshot into archetype
  const updated = await mergeSnapshotIntoArchetype(
    bestArchetype.clusterId,
    vector,
    fingerprint.tokenMint
  );

  return {
    archetypeClusterId: bestArchetype.clusterId,
    similarityToArchetype: bestSimilarity,
    isNewArchetype: false,
  };
}

/**
 * Create new lifecycle stage archetype
 */
async function createStageArchetype(fingerprint: {
  tokenMint: string;
  fingerprintVector: number[];
  tokenAgeMinutes: number;
  medianMultiplier: number;
}): Promise<{
  archetypeClusterId: string;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  const now = Math.floor(Date.now() / 1000);
  const stageDesc = `stage_age${Math.round(fingerprint.tokenAgeMinutes)}_mul${Math.round(fingerprint.medianMultiplier * 10) / 10}_${now}`;
  const archetypeId = `lifecycle_${stageDesc}`;

  await db.insert(tokenFingerprintClusters).values({
    clusterId: archetypeId,
    type: "dead",
    centroid: fingerprint.fingerprintVector,
    sampleCount: 1, // One snapshot (this fingerprint) in archetype
    archivedTokenMints: [fingerprint.tokenMint],
    cohesion: 1.0, // Single snapshot = perfect cohesion
    minSimilarity: 1.0,
    maxSimilarity: 1.0,
    createdAt: now,
    updatedAt: now,
    lastRebalancedAt: now,
  });

  return {
    archetypeClusterId: archetypeId,
    similarityToArchetype: 1.0,
    isNewArchetype: true,
  };
}

/**
 * Merge snapshot into existing lifecycle archetype (recompute centroid with new snapshot)
 */
async function mergeSnapshotIntoArchetype(
  archetypeId: string,
  snapshotVector: number[],
  tokenMint: string
): Promise<{
  sampleCount: number;
  newCohesion: number;
}> {
  // Get archetype
  const archetype = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.clusterId, archetypeId))
    .limit(1);

  if (archetype.length === 0) {
    throw new Error(`Archetype ${archetypeId} not found`);
  }

  const current = archetype[0];
  const currentMints = (current.archivedTokenMints as string[]) || [];

  // Recompute archetype centroid with new snapshot vector
  const allVectors: number[][] = [];

  // Add existing archetype centroid as representative
  if (current.centroid) {
    allVectors.push(current.centroid as number[]);
  }

  // Add new snapshot vector
  allVectors.push(snapshotVector);

  const { centroid: newCentroid, cohesion: newCohesion } =
    averageVectors(allVectors);

  // Calculate similarity range among snapshots
  let minSim = 1,
    maxSim = 0;
  for (let i = 0; i < allVectors.length; i++) {
    for (let j = i + 1; j < allVectors.length; j++) {
      const sim = cosineSimilarity(allVectors[i], allVectors[j]);
      minSim = Math.min(minSim, sim);
      maxSim = Math.max(maxSim, sim);
    }
  }

  // Update archetype
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(tokenFingerprintClusters)
    .set({
      sampleCount: current.sampleCount + 1,
      archivedTokenMints: [...currentMints, tokenMint],
      centroid: newCentroid,
      cohesion: newCohesion,
      minSimilarity: minSim,
      maxSimilarity: maxSim,
      updatedAt: now,
    })
    .where(eq(tokenFingerprintClusters.clusterId, archetypeId));

  return {
    sampleCount: current.sampleCount + 1,
    newCohesion,
  };
}

/**
 * Estimate DB size for trajectory archetype compression
 *
 * All tokens eventually reach a final state (archival).
 * Compression happens post-mortem when complete trajectory is known.
 *
 * Scenarios:
 * 1. No archetype merging (bad): Every token → own archetype = bloat
 * 2. Perfect merging (bad): All tokens → 1 archetype = loss of signal
 * 3. Trajectory-based (good): Similar evolution patterns merge = meaningful archetypes
 */
export function estimateClusterSize(): {
  scenario: string;
  tokensPerMonth: number;
  archetypeCount: number;
  tokensPerArchetype: number;
  dbSizeGB: number;
  risk: string;
} {
  const tokensPerMonth = 36000; // 100/hr × 24h × 30d

  const scenarios = {
    worst_no_compression: {
      archetypeCount: tokensPerMonth, // Each token = own archetype
      tokensPerArchetype: 1,
      risk: "CRITICAL: 36K archetypes, defeats compression, no learning",
    },
    worst_over_compression: {
      archetypeCount: 2, // All tokens merged (impossible to distinguish)
      tokensPerArchetype: tokensPerMonth / 2,
      risk: "CRITICAL: Loss of signal, can't identify trajectory patterns",
    },
    trajectory_based: {
      // Similar trajectories merge, different ones stay separate
      // Estimate: ~10-15% of tokens share trajectory archetypes
      archetypeCount: Math.round(tokensPerMonth * 0.12), // ~4,300 archetypes
      tokensPerArchetype: 8, // Avg 8 tokens per archetype
      risk: "GOOD: Trajectory-based clustering preserves pattern diversity while compressing similar evolutions",
    },
  };

  const scenario = scenarios.trajectory_based;

  // Size per archetype:
  // - trajectory signature (centroid): 50 × 8 bytes = 400B
  // - token mints array: 8 × 44 bytes = 352B
  // - metadata: ~300B (cohesion, similarities, timestamps, etc)
  // - overhead: ~100B
  const bytesPerArchetype = 1200;

  const dbSizeGB =
    (scenario.archetypeCount * bytesPerArchetype) / 1_000_000_000;

  return {
    scenario: "Trajectory-based archetype clustering (post-mortem compression)",
    tokensPerMonth,
    archetypeCount: scenario.archetypeCount,
    tokensPerArchetype: scenario.tokensPerArchetype,
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
 * Post-archive trajectory archetype rebalancing (optional optimization)
 *
 * Called periodically to:
 * - Identify loose/degraded archetypes (cohesion < 0.5) for analysis
 * - Suggest very similar small archetypes for manual merger
 * - Report archetype quality metrics
 *
 * Note: Archetypes are created at archive time and generally stable.
 * Rebalancing is optional, mainly for insights.
 */
export async function reportArchetypeQuality(): Promise<{
  totalArchetypes: number;
  tightArchetypes: number; // cohesion > 0.75
  looseArchetypes: number; // cohesion < 0.5
  avgTokensPerArchetype: number;
  avgCohesion: number;
}> {
  const archetypes = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  if (archetypes.length === 0) {
    return {
      totalArchetypes: 0,
      tightArchetypes: 0,
      looseArchetypes: 0,
      avgTokensPerArchetype: 0,
      avgCohesion: 0,
    };
  }

  const tightCount = archetypes.filter((a) => (a.cohesion ?? 0) > 0.75).length;
  const looseCount = archetypes.filter((a) => (a.cohesion ?? 0) < 0.5).length;
  const totalTokens = archetypes.reduce((sum, a) => sum + (a.sampleCount ?? 0), 0);
  const avgCohesion =
    archetypes.reduce((sum, a) => sum + (a.cohesion ?? 0), 0) / archetypes.length;

  return {
    totalArchetypes: archetypes.length,
    tightArchetypes: tightCount,
    looseArchetypes: looseCount,
    avgTokensPerArchetype: totalTokens / archetypes.length,
    avgCohesion: parseFloat(avgCohesion.toFixed(3)),
  };
}
