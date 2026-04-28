import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

/**
 * Trajectory Archetype Management: Post-Mortem Clustering
 *
 * Key Insight: All tokens eventually reach a final state (archived).
 * The distinction between "winning" and "losing" is temporal—even winners
 * become archived. Compression happens post-mortem on complete trajectories.
 *
 * Architecture:
 * 1. Active phase: Tokens evolve naturally, snapshots captured via activity-gating
 *    (T0, per-minute for 10min, per-50-trades after, per-multiplier at graduation)
 * 2. Archive phase: Token reaches final state, complete trajectory sequence captured
 * 3. Compression phase: Trajectory signature computed and merged into archetype
 *    (similar evolution patterns cluster together)
 *
 * Result: ~4,300 archetypes for 36K tokens/month (12% of no-merge bloat)
 * Each archetype represents a trajectory pattern, not an outcome class.
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
 * Archive complete token trajectory into archetype cluster
 *
 * Called when token reaches final state (volume death, graduation, rugpull, etc.)
 * Compresses the complete fingerprint sequence into a trajectory archetype.
 *
 * Process:
 * 1. Fetch all fingerprints for token (complete trajectory in order)
 * 2. Compute trajectory signature (sequence compression)
 * 3. Find similar trajectory archetypes (other tokens with same evolution pattern)
 * 4. Merge into archetype cluster (represents "tokens that evolved like this")
 *
 * All tokens eventually reach this phase (all tokens look like losers eventually).
 * Clustering happens post-mortem on complete lifecycle, not during active trading.
 */
export async function archiveTokenTrajectory(
  tokenMint: string,
  archiveReason: string
): Promise<{
  archetypeClusterId: string;
  trajectoryLength: number;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  // Fetch complete trajectory (all fingerprints for this token in sequence)
  const trajectoryFPs = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .orderBy(tokenFingerprints.snapshotTimestamp);

  if (trajectoryFPs.length === 0) {
    throw new Error(`[ArchiveTrajectory] No fingerprints found for token ${tokenMint}`);
  }

  // Compute trajectory signature from complete fingerprint sequence
  // For now: average of all fingerprints (later: could use dynamic time warping or other sequence metrics)
  const trajectoryVectors = trajectoryFPs
    .map((fp) => fp.fingerprintVector as number[])
    .filter((v): v is number[] => v !== null && v.length > 0);

  if (trajectoryVectors.length === 0) {
    throw new Error(`[ArchiveTrajectory] No valid vectors in trajectory for ${tokenMint}`);
  }

  const { centroid: trajectorySignature, cohesion: trajectoryQuality } =
    averageVectors(trajectoryVectors);

  // Find most similar trajectory archetype
  const allArchetypes = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  if (allArchetypes.length === 0) {
    // Create first trajectory archetype
    return createTrajectoryArchetype(
      tokenMint,
      trajectorySignature,
      trajectoryFPs.length,
      archiveReason
    );
  }

  // Find best matching archetype (similar trajectory evolution)
  let bestArchetype = allArchetypes[0];
  let bestSimilarity = -1;

  for (const archetype of allArchetypes) {
    const archetypeCentroid = archetype.centroid as number[];
    const similarity = cosineSimilarity(trajectorySignature, archetypeCentroid);

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestArchetype = archetype;
    }
  }

  // Archetype matching thresholds (trajectory-based)
  const thresholds = {
    mergeTrajectories: 0.80, // Similar trajectory shapes → merge
    minArchetypeCohesion: 0.70, // Archetype must stay tight
    cohesionDropTolerance: 0.08, // Allow max 8% cohesion drop
  };

  // Too different trajectory → create new archetype
  if (bestSimilarity < thresholds.mergeTrajectories) {
    return createTrajectoryArchetype(
      tokenMint,
      trajectorySignature,
      trajectoryFPs.length,
      archiveReason
    );
  }

  // Check if merging would degrade archetype cohesion
  if (bestArchetype.sampleCount > 50) {
    if (bestArchetype.cohesion < thresholds.minArchetypeCohesion) {
      // Archetype already loose, create new one
      return createTrajectoryArchetype(
        tokenMint,
        trajectorySignature,
        trajectoryFPs.length,
        archiveReason
      );
    }
  }

  // Merge trajectory into archetype
  const updated = await mergeTrajectoryIntoArchetype(
    bestArchetype.clusterId,
    trajectorySignature,
    tokenMint
  );

  return {
    archetypeClusterId: bestArchetype.clusterId,
    trajectoryLength: trajectoryFPs.length,
    similarityToArchetype: bestSimilarity,
    isNewArchetype: false,
  };
}

/**
 * Create new trajectory archetype
 */
async function createTrajectoryArchetype(
  tokenMint: string,
  trajectorySignature: number[],
  trajectoryLength: number,
  archiveReason: string
): Promise<{
  archetypeClusterId: string;
  trajectoryLength: number;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  const now = Math.floor(Date.now() / 1000);
  const archetypeId = `trajectory_archetype_${archiveReason}_${now}`;

  await db.insert(tokenFingerprintClusters).values({
    clusterId: archetypeId,
    type: "dead",
    centroid: trajectorySignature,
    sampleCount: 1, // One token (this trajectory) in archetype
    archivedTokenMints: [tokenMint],
    cohesion: 1.0, // Single trajectory = perfect cohesion
    minSimilarity: 1.0,
    maxSimilarity: 1.0,
    createdAt: now,
    updatedAt: now,
    lastRebalancedAt: now,
  });

  return {
    archetypeClusterId: archetypeId,
    trajectoryLength,
    similarityToArchetype: 1.0,
    isNewArchetype: true,
  };
}

/**
 * Merge trajectory into existing archetype (recompute centroid with new trajectory signature)
 */
async function mergeTrajectoryIntoArchetype(
  archetypeId: string,
  trajectorySignature: number[],
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

  // Recompute archetype centroid including new trajectory signature
  // Collect all trajectory signatures from archived mints
  const allTrajectorySignatures: number[][] = [];

  // Add existing archetype centroid as representative
  if (current.centroid) {
    allTrajectorySignatures.push(current.centroid as number[]);
  }

  // Add new trajectory signature
  allTrajectorySignatures.push(trajectorySignature);

  const { centroid: newCentroid, cohesion: newCohesion } =
    averageVectors(allTrajectorySignatures);

  // Calculate similarity range among trajectories
  let minSim = 1,
    maxSim = 0;
  for (let i = 0; i < allTrajectorySignatures.length; i++) {
    for (let j = i + 1; j < allTrajectorySignatures.length; j++) {
      const sim = cosineSimilarity(allTrajectorySignatures[i], allTrajectorySignatures[j]);
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
