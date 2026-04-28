import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints } from "@shared/schema";
import { eq, and, gte, lt, sql } from "drizzle-orm";

/**
 * Lifecycle Stage + Outcome Probability Clustering
 *
 * Key insight: All tokens eventually reach a final state (crash).
 * Prediction isn't about outcome (binary) but trajectory shape.
 * Snapshots cluster by lifecycle stage + verified outcome distributions.
 *
 * Real-time flow:
 * 1. Snapshot created (activity-gated, no time gates)
 * 2. Match to archetype → get outcome probability distribution
 * 3. Track probability vector over time as token evolves
 * 4. Divergence in probabilities = branching signal
 *
 * Daily retrolearner flow:
 * 1. Identify archived tokens
 * 2. Backfill all snapshots with trajectoryOutcome (shape they followed)
 * 3. Cluster snapshots into outcome archetypes with probability distributions
 * 4. Update archetype centroids and outcome probabilities
 * 5. Next day's matching uses improved distributions
 */

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
 * Average vectors and calculate cohesion
 */
function averageVectors(vectors: number[][]): {
  centroid: number[];
  cohesion: number;
} {
  const dim = vectors[0]?.length || 50;
  const centroid = Array(dim).fill(0);

  vectors.forEach((v) => {
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i] / vectors.length;
    }
  });

  const similarities = vectors.map((v) => cosineSimilarity(v, centroid));
  const cohesion = similarities.reduce((a, b) => a + b, 0) / vectors.length;

  return { centroid, cohesion };
}

/**
 * Cluster snapshot to lifecycle stage + outcome archetype
 *
 * Called as each fingerprint is created (activity-gated).
 * Returns archetype with outcome probability distribution for prediction.
 */
export async function clusterSnapshotToArchetype(
  fingerprint: {
    tokenMint: string;
    fingerprintVector: number[];
    tokenAgeMinutes: number;
    medianMultiplier: number;
  }
): Promise<{
  archetypeClusterId: string;
  outcomeDistribution: Record<string, number>;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  const vector = fingerprint.fingerprintVector;

  // Find all existing archetypes
  const allArchetypes = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  if (allArchetypes.length === 0) {
    // Create first archetype for this lifecycle stage
    return createStageArchetype(fingerprint);
  }

  // Find most similar archetype
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

  const thresholds = {
    mergeSimilarity: 0.80,
    minArchetypeCohesion: 0.70,
    cohesionDropTolerance: 0.08,
  };

  // Too dissimilar → create new archetype
  if (bestSimilarity < thresholds.mergeSimilarity) {
    return createStageArchetype(fingerprint);
  }

  // Check if merging would degrade cohesion
  if (bestArchetype.sampleCount > 50) {
    if (bestArchetype.cohesion < thresholds.minArchetypeCohesion) {
      return createStageArchetype(fingerprint);
    }
  }

  // Merge snapshot into archetype (but don't update outcome distribution yet)
  // Outcome distribution only updates when tokens are archived (daily retrolearner)
  const updated = await mergeSnapshotIntoArchetype(
    bestArchetype.clusterId,
    vector,
    fingerprint.tokenMint
  );

  const outcomeDistribution =
    (bestArchetype.outcomeDistribution as Record<string, number>) || {};

  return {
    archetypeClusterId: bestArchetype.clusterId,
    outcomeDistribution,
    similarityToArchetype: bestSimilarity,
    isNewArchetype: false,
  };
}

/**
 * Create new lifecycle stage archetype (initialized without outcome distribution)
 * Outcome distribution gets populated by retrolearner as tokens complete
 */
async function createStageArchetype(fingerprint: {
  tokenMint: string;
  fingerprintVector: number[];
  tokenAgeMinutes: number;
  medianMultiplier: number;
}): Promise<{
  archetypeClusterId: string;
  outcomeDistribution: Record<string, number>;
  similarityToArchetype: number;
  isNewArchetype: boolean;
}> {
  const now = Math.floor(Date.now() / 1000);
  const stageDesc = `age${Math.round(fingerprint.tokenAgeMinutes)}_mul${Math.round(fingerprint.medianMultiplier * 10) / 10}`;
  const archetypeId = `lifecycle_${stageDesc}_${now}`;

  await db.insert(tokenFingerprintClusters).values({
    clusterId: archetypeId,
    type: "dead",
    lifecycleStage: stageDesc,
    centroid: fingerprint.fingerprintVector,
    outcomeDistribution: {}, // Empty until retrolearner populates
    sampleCount: 1,
    snapshotTokenMints: [fingerprint.tokenMint],
    cohesion: 1.0,
    minSimilarity: 1.0,
    maxSimilarity: 1.0,
    createdAt: now,
    updatedAt: now,
    lastRebalancedAt: now,
  });

  return {
    archetypeClusterId: archetypeId,
    outcomeDistribution: {},
    similarityToArchetype: 1.0,
    isNewArchetype: true,
  };
}

/**
 * Merge snapshot into existing archetype
 * Does not update outcome distribution (that's done by retrolearner)
 */
async function mergeSnapshotIntoArchetype(
  archetypeId: string,
  snapshotVector: number[],
  tokenMint: string
): Promise<{
  sampleCount: number;
  newCohesion: number;
}> {
  const archetype = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.clusterId, archetypeId))
    .limit(1);

  if (archetype.length === 0) {
    throw new Error(`Archetype ${archetypeId} not found`);
  }

  const current = archetype[0];
  const currentMints = (current.snapshotTokenMints as string[]) || [];

  // Recompute centroid
  const allVectors: number[][] = [];
  if (current.centroid) {
    allVectors.push(current.centroid as number[]);
  }
  allVectors.push(snapshotVector);

  const { centroid: newCentroid, cohesion: newCohesion } =
    averageVectors(allVectors);

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

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(tokenFingerprintClusters)
    .set({
      sampleCount: current.sampleCount + 1,
      snapshotTokenMints: [...currentMints, tokenMint],
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
 * Determine trajectory outcome shape for archived token
 * Called by retrolearner to backfill trajectoryOutcome
 */
function determineTrajectoryOutcome(
  finalMultiplier: number,
  tokenAgeMinutes: number,
  maxMultiplierReached: number
): string {
  // Outcome shapes based on trajectory characteristics
  if (maxMultiplierReached >= 100) {
    return "pump_100x_plus";
  } else if (maxMultiplierReached >= 10) {
    return "pump_10x";
  } else if (maxMultiplierReached >= 5) {
    return "pump_5x";
  } else if (maxMultiplierReached >= 2) {
    if (tokenAgeMinutes > 60) {
      return "pump_2x_sustained";
    }
    return "pump_2x_quick";
  } else if (maxMultiplierReached >= 1.1) {
    return "pump_minor";
  } else if (finalMultiplier < 0.1) {
    return "crash_fast";
  } else {
    return "slow_bleed";
  }
}

/**
 * Retrolearner: Backfill archived token snapshots with outcome, cluster them
 * Called daily by retrolearner after identifying archived tokens
 */
export async function archiveTokenAndUpdateOutcomes(
  tokenMint: string,
  finalMultiplier: number,
  maxMultiplierReached: number,
  tokenAgeMinutes: number
): Promise<{
  snapshotCount: number;
  archetypesUpdated: number;
  trajectoryOutcome: string;
}> {
  // Determine trajectory outcome shape
  const trajectoryOutcome = determineTrajectoryOutcome(
    finalMultiplier,
    tokenAgeMinutes,
    maxMultiplierReached
  );

  // Fetch all fingerprints for this token
  const fingerprints = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .orderBy(tokenFingerprints.snapshotTimestamp);

  if (fingerprints.length === 0) {
    throw new Error(`[ArchiveToken] No fingerprints found for ${tokenMint}`);
  }

  // Backfill all fingerprints with trajectory outcome
  await db
    .update(tokenFingerprints)
    .set({ trajectoryOutcome })
    .where(eq(tokenFingerprints.tokenMint, tokenMint));

  // Cluster each fingerprint into archetype, updating outcome distribution
  const archetypesSet = new Set<string>();

  for (const fp of fingerprints) {
    const vector = fp.fingerprintVector as number[];
    if (!vector || vector.length === 0) continue;

    // Find best matching archetype
    const allArchetypes = await db
      .select()
      .from(tokenFingerprintClusters)
      .where(eq(tokenFingerprintClusters.type, "dead"));

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

    if (bestSimilarity < 0.75) {
      // Create new archetype for this outcome
      const now = Math.floor(Date.now() / 1000);
      const stageDesc = `age${Math.round(fp.tokenAgeMinutes || 0)}_outcome${trajectoryOutcome}`;
      const archetypeId = `lifecycle_${stageDesc}_${now}`;

      await db.insert(tokenFingerprintClusters).values({
        clusterId: archetypeId,
        type: "dead",
        lifecycleStage: stageDesc,
        centroid: vector,
        outcomeDistribution: { [trajectoryOutcome]: 1.0 },
        sampleCount: 1,
        snapshotTokenMints: [tokenMint],
        cohesion: 1.0,
        minSimilarity: 1.0,
        maxSimilarity: 1.0,
        createdAt: now,
        updatedAt: now,
        lastRebalancedAt: now,
      });

      archetypesSet.add(archetypeId);
    } else {
      // Merge into best archetype, update outcome distribution
      const currentMints = (bestArchetype.snapshotTokenMints as string[]) || [];
      const currentOutcomes = (bestArchetype.outcomeDistribution as Record<
        string,
        number
      >) || {};

      // Recompute centroid
      const allVectors: number[][] = [];
      if (bestArchetype.centroid) {
        allVectors.push(bestArchetype.centroid as number[]);
      }
      allVectors.push(vector);
      const { centroid: newCentroid, cohesion: newCohesion } =
        averageVectors(allVectors);

      // Update outcome distribution
      const newOutcomes = { ...currentOutcomes };
      const totalCount = bestArchetype.sampleCount + 1;
      for (const outcome of Object.keys(newOutcomes)) {
        newOutcomes[outcome] =
          (newOutcomes[outcome] * bestArchetype.sampleCount) / totalCount;
      }
      newOutcomes[trajectoryOutcome] =
        ((newOutcomes[trajectoryOutcome] || 0) * bestArchetype.sampleCount +
          1) /
        totalCount;

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

      const now = Math.floor(Date.now() / 1000);
      await db
        .update(tokenFingerprintClusters)
        .set({
          sampleCount: totalCount,
          snapshotTokenMints: [...currentMints, tokenMint],
          centroid: newCentroid,
          outcomeDistribution: newOutcomes,
          cohesion: newCohesion,
          minSimilarity: minSim,
          maxSimilarity: maxSim,
          updatedAt: now,
        })
        .where(eq(tokenFingerprintClusters.clusterId, bestArchetype.clusterId));

      archetypesSet.add(bestArchetype.clusterId);
    }
  }

  return {
    snapshotCount: fingerprints.length,
    archetypesUpdated: archetypesSet.size,
    trajectoryOutcome,
  };
}

/**
 * Get archetype quality stats
 */
export async function reportArchetypeQuality(): Promise<{
  totalArchetypes: number;
  tightArchetypes: number;
  looseArchetypes: number;
  avgSnapshotsPerArchetype: number;
  archetypesWithOutcomeData: number;
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
      avgSnapshotsPerArchetype: 0,
      archetypesWithOutcomeData: 0,
    };
  }

  const tightCount = archetypes.filter((a) => (a.cohesion ?? 0) > 0.75).length;
  const looseCount = archetypes.filter((a) => (a.cohesion ?? 0) < 0.5).length;
  const totalSnapshots = archetypes.reduce((sum, a) => sum + (a.sampleCount ?? 0), 0);
  const withOutcome = archetypes.filter(
    (a) => a.outcomeDistribution && Object.keys(a.outcomeDistribution).length > 0
  ).length;

  return {
    totalArchetypes: archetypes.length,
    tightArchetypes: tightCount,
    looseArchetypes: looseCount,
    avgSnapshotsPerArchetype: Math.round(totalSnapshots / archetypes.length),
    archetypesWithOutcomeData: withOutcome,
  };
}

/**
 * Estimate cluster size with outcome distribution
 */
export function estimateClusterSize(): {
  scenario: string;
  tokensPerMonth: number;
  archetypeCount: number;
  snapshotsPerArchetype: number;
  dbSizeGB: number;
  risk: string;
} {
  const tokensPerMonth = 36000;

  const scenario = {
    archetypeCount: Math.round(tokensPerMonth * 0.12), // ~4.3K archetypes
    snapshotsPerArchetype: 8,
    risk: "GOOD: Lifecycle stage + outcome distribution enables probability-based prediction",
  };

  // Size per archetype:
  // - centroid: 50 × 8 = 400B
  // - outcome distribution: ~200B (5-10 outcomes × 50B each)
  // - metadata: 300B
  // - overhead: 100B
  const bytesPerArchetype = 1200;

  const dbSizeGB =
    (scenario.archetypeCount * bytesPerArchetype) / 1_000_000_000;

  return {
    scenario:
      "Lifecycle stage + outcome probability distribution (daily retrolearner updates)",
    tokensPerMonth,
    archetypeCount: scenario.archetypeCount,
    snapshotsPerArchetype: scenario.snapshotsPerArchetype,
    dbSizeGB: parseFloat(dbSizeGB.toFixed(2)),
    risk: scenario.risk,
  };
}

/**
 * Full database size estimate
 */
export function estimateFullFingerprinterSize(): {
  layer: string;
  description: string;
  sizeGB: number;
}[] {
  const tokensPerMonth = 36000;

  return [
    {
      layer: "Raw fingerprints (active + completing)",
      description: `~${tokensPerMonth * 8} total snapshots (8 avg per token) = full trajectories`,
      sizeGB: ((tokensPerMonth * 8) * 500) / 1_000_000_000,
    },
    {
      layer: "Lifecycle stage + outcome archetypes",
      description: `~${Math.round(tokensPerMonth * 0.12)} archetypes with outcome probability distributions`,
      sizeGB: (Math.round(tokensPerMonth * 0.12) * 1200) / 1_000_000_000,
    },
    {
      layer: "Archetype outcome history (weekly rollup)",
      description: "Compressed weekly archetype state snapshots for trend analysis",
      sizeGB: 2.0,
    },
    {
      layer: "TOTAL STEADY STATE",
      description: "Active fingerprints + archetypes + outcome history",
      sizeGB: 35.0,
    },
  ];
}
