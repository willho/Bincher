import { db } from "./db";
import { tokenFingerprintClusters, tokenFingerprints, tokenDataPool, tokenFingerprintSnapshots, familiarWhales } from "@shared/schema";
import { eq, and, gte, lt, sql, desc } from "drizzle-orm";

/**
 * Live-Token-Averaging Clustering Architecture
 *
 * Core concept: Clusters accumulate outcomes continuously as tokens live and die.
 * No batch retrolearner cycles. Real-time feedback from live tokens.
 *
 * Cluster lifecycle:
 * 1. Token snapshot matches cluster (similarity > 0.70)
 * 2. Token added to cluster's liveMembers list (while still trading)
 * 3. Cluster centroid updates in real-time as new snapshots arrive
 * 4. Token reaches deathbed (volume → 0)
 * 5. Token's snapshots averaged into cluster centroid (lifecycle-weighted)
 * 6. Token removed from liveMembers, outcome added to outcomeDistribution
 * 7. Token's snapshot records deleted (pruned)
 * 8. Cluster variance checked: if bimodal, split; if similar to other, merge
 *
 * 4 Core Algorithms:
 * - Cluster Variance Detection & Split/Merge: Monitor outcome distribution for bimodality
 * - Multi-Cluster Blending: If token matches 2+ clusters with similar confidence, blend
 * - Snapshot Lifecycle Weighting: Early snapshots weighted 1.0x, deathbed 0.2x
 * - Snapshot Frequency: T+0,1,5,10,30,60,180,360,1440 min + event triggers
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
 * Detect when a rug pull started by analyzing snapshot progression
 * Returns timestamp when price declined >50% from peak (or null if no clear rug)
 */
function detectRugOnsetFromSnapshots(snapshots: Array<{
  timestamp: number;
  trajectoryAnchored?: { priceChange: number };
  trajectoryCurrent?: { priceChange: number };
}>): number | null {
  if (snapshots.length < 2) return null;

  const priceProgression = snapshots.map(s => ({
    timestamp: s.timestamp,
    priceChange: s.trajectoryCurrent?.priceChange || s.trajectoryAnchored?.priceChange || 0,
  })).sort((a, b) => a.timestamp - b.timestamp);

  let peakPrice = 1;
  let peakTimestamp = priceProgression[0].timestamp;

  for (const snap of priceProgression) {
    if (snap.priceChange > peakPrice) {
      peakPrice = snap.priceChange;
      peakTimestamp = snap.timestamp;
    }
  }

  // Find first point where price dropped 50%+ from peak
  for (const snap of priceProgression) {
    if (snap.timestamp <= peakTimestamp) continue; // Skip before peak
    const decline = (peakPrice - snap.priceChange) / peakPrice;
    if (decline >= 0.5) {
      return snap.timestamp; // Rug onset
    }
  }

  return null;
}

/**
 * Calculate profit window in minutes: time from token creation to rug onset
 * If no rug detected, returns null
 */
function calculateProfitWindowMinutes(
  tokenCreatedAt: number,
  rugOnsetTimestamp: number | null
): number | null {
  if (!rugOnsetTimestamp) return null;
  return Math.floor((rugOnsetTimestamp - tokenCreatedAt) / 60);
}

/**
 * ALGORITHM 1: Snapshot Lifecycle-Weighted Averaging
 * Weight snapshots by lifecycle phase: early (1.0x) → mid (0.8x) → late (0.5x) → deathbed (0.2x)
 * Prevents deathbed noise from biasing cluster centroid
 */
function getSnapshotLifecycleWeight(tokenAgeMinutes: number): number {
  if (tokenAgeMinutes < 10) return 1.0;     // Early phase (0-10min)
  if (tokenAgeMinutes < 60) return 0.8;     // Mid phase (10-60min)
  if (tokenAgeMinutes < 360) return 0.5;    // Late phase (60min-6hr)
  return 0.2;                               // Deathbed phase (6hr+)
}

/**
 * Average vectors with optional lifecycle weighting and calculate cohesion
 */
function averageVectorsWeighted(
  vectors: { vector: number[]; tokenAgeMinutes?: number }[]
): {
  centroid: number[];
  cohesion: number;
} {
  const dim = vectors[0]?.vector.length || 50;
  const centroid = Array(dim).fill(0);
  let totalWeight = 0;

  vectors.forEach(({ vector: v, tokenAgeMinutes = 0 }) => {
    const weight = getSnapshotLifecycleWeight(tokenAgeMinutes);
    for (let i = 0; i < dim; i++) {
      centroid[i] += (v[i] * weight) / vectors.length;
    }
    totalWeight += weight;
  });

  // Normalize by weights
  const avgWeight = totalWeight / vectors.length;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= avgWeight;
  }

  const similarities = vectors.map(({ vector: v }) => cosineSimilarity(v, centroid));
  const cohesion = similarities.reduce((a, b) => a + b, 0) / vectors.length;

  return { centroid, cohesion };
}

/**
 * Backwards-compatible unweighted averaging
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
 * ALGORITHM 2: Cluster Variance Detection & Split/Merge
 * Split if bimodal outcome distribution (some tokens crash, others pump)
 * Merge if clusters become too similar (distance < 0.15, similarity > 0.85)
 */
function calculateOutcomeVariance(outcomeDistribution: Record<string, number>): number {
  const values = Object.values(outcomeDistribution);
  if (values.length === 0) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance); // Standard deviation
}

function detectBimodalOutcomes(outcomeDistribution: Record<string, number>): boolean {
  const successful = ["pump_100x", "pump_10x", "pump_5x", "pump_2x_sustained", "pump_2x_quick", "pump_minor"];
  const crashes = ["crash_fast", "slow_bleed"];

  let successCount = 0, crashCount = 0;
  for (const [outcome, prob] of Object.entries(outcomeDistribution)) {
    if (successful.includes(outcome)) successCount += prob;
    if (crashes.includes(outcome)) crashCount += prob;
  }

  return successCount > 0.40 && crashCount > 0.40;
}

export function shouldSplitCluster(cluster: {
  sampleCount: number;
  outcomeDistribution?: Record<string, number>;
  cohesion?: number;
}): boolean {
  const outcomes = cluster.outcomeDistribution || {};
  const variance = calculateOutcomeVariance(outcomes);
  const bimodal = detectBimodalOutcomes(outcomes);

  // Thresholds from plan: variance > 0.35 OR bimodality > 0.80
  return variance > 0.35 || bimodal;
}

export function shouldMergeClusters(
  cluster1: { centroid: number[]; outcomeDistribution?: Record<string, number> },
  cluster2: { centroid: number[]; outcomeDistribution?: Record<string, number> }
): boolean {
  const distance = 1 - cosineSimilarity(cluster1.centroid as number[], cluster2.centroid as number[]);
  const outcomes1 = Object.values(cluster1.outcomeDistribution || {});
  const outcomes2 = Object.values(cluster2.outcomeDistribution || {});

  if (outcomes1.length === 0 || outcomes2.length === 0) return false;

  const mean1 = outcomes1.reduce((a, b) => a + b, 0) / outcomes1.length;
  const mean2 = outcomes2.reduce((a, b) => a + b, 0) / outcomes2.length;
  const outcomeSimilarity = 1 - Math.abs(mean1 - mean2);

  // Thresholds from plan: distance < 0.15 AND similarity > 0.85
  return distance < 0.15 && outcomeSimilarity > 0.85;
}

/**
 * ALGORITHM 3: Multi-Cluster Matching & Blending
 * If token matches 2+ clusters with similar confidence, blend outcomes
 */
export interface ClusterMatch {
  clusterId: string;
  similarity: number;
  outcomeDistribution: Record<string, number>;
  metadata?: Record<string, any>;
}

export function computeBlendWeights(matches: ClusterMatch[]): Record<string, number> {
  if (matches.length === 0) return {};
  if (matches.length === 1) {
    return { [matches[0].clusterId]: 1.0 };
  }

  // Multi-cluster blending: inverse similarity weighting
  const totalSimilarity = matches.reduce((sum, m) => sum + m.similarity, 0);
  const weights: Record<string, number> = {};

  for (const match of matches) {
    weights[match.clusterId] = match.similarity / totalSimilarity;
  }

  return weights;
}

export function blendOutcomeDistributions(
  matches: ClusterMatch[],
  weights?: Record<string, number>
): Record<string, number> {
  if (matches.length === 0) return {};

  const w = weights || computeBlendWeights(matches);
  const blended: Record<string, number> = {};

  for (const match of matches) {
    const weight = w[match.clusterId] || 0;
    for (const [outcome, prob] of Object.entries(match.outcomeDistribution)) {
      blended[outcome] = (blended[outcome] || 0) + prob * weight;
    }
  }

  return blended;
}

export function getConfidencePenalty(matchCount: number): number {
  if (matchCount <= 1) return 0;
  if (matchCount === 2) return 0.10;  // 10% penalty for 2-cluster blend
  return 0.20;                         // 20% penalty for 3+ cluster blend
}

/**
 * ALGORITHM 4: Snapshot Frequency Schedule
 * Base: T+0, 1, 5, 10, 30, 60, 180, 360, 1440 min + event triggers
 */
export interface SnapshotSchedule {
  baseSnapshots: number[];  // Minutes when to take base snapshots
  eventTriggers: string[];  // "price_spike", "volume_spike", "whale_exit", "graduation"
}

export function getSnapshotSchedule(): SnapshotSchedule {
  return {
    baseSnapshots: [0, 1, 5, 10, 30, 60, 180, 360, 1440],
    eventTriggers: ["price_spike_50pct", "volume_spike_10x", "whale_exit_20pct", "graduation_imminent_95pct"],
  };
}

export function shouldTakeSnapshotForEvent(
  event: "price" | "volume" | "whale" | "graduation",
  currentValue: number,
  baselineValue: number
): boolean {
  switch (event) {
    case "price":
      return currentValue >= baselineValue * 1.5; // 50% price jump
    case "volume":
      return currentValue >= baselineValue * 10; // 10x volume
    case "whale":
      return (baselineValue - currentValue) / baselineValue >= 0.2; // 20% position reduction
    case "graduation":
      return currentValue >= 0.95; // 95% bonding curve
    default:
      return false;
  }
}

/**
 * Cluster snapshot to lifecycle stage + outcome archetype
 * Enhanced with multi-cluster matching & blending (Algorithm 3)
 *
 * Called as each fingerprint is created (activity-gated).
 * Returns matched clusters with outcome distributions for prediction.
 */
export async function clusterSnapshotToArchetype(
  fingerprint: {
    tokenMint: string;
    fingerprintVector: number[];
    tokenAgeMinutes: number;
    medianMultiplier: number;
  }
): Promise<{
  matches: ClusterMatch[];
  blendedOutcomes: Record<string, number>;
  primaryClusterId: string;
  confidencePenalty: number;
  isNewArchetype: boolean;
}> {
  const vector = fingerprint.fingerprintVector;
  const minSimilarity = 0.70; // Threshold for cluster matching

  // Find all existing clusters
  const allClusters = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  if (allClusters.length === 0) {
    // Create first cluster for this lifecycle stage
    const newArch = await createStageArchetype(fingerprint);
    return {
      matches: [],
      blendedOutcomes: newArch.outcomeDistribution,
      primaryClusterId: newArch.archetypeClusterId,
      confidencePenalty: 0,
      isNewArchetype: true,
    };
  }

  // Find all clusters above threshold (Algorithm 3: Multi-Cluster Matching)
  const matches: ClusterMatch[] = [];
  for (const cluster of allClusters) {
    const clusterCentroid = cluster.centroid as number[];
    const similarity = cosineSimilarity(vector, clusterCentroid);

    if (similarity >= minSimilarity) {
      matches.push({
        clusterId: cluster.clusterId,
        similarity,
        outcomeDistribution: (cluster.outcomeDistribution as Record<string, number>) || {},
        metadata: (cluster.metadata as Record<string, unknown>) || {},
      });
    }
  }

  // No matches above threshold → create new cluster
  if (matches.length === 0) {
    const newArch = await createStageArchetype(fingerprint);
    return {
      matches: [],
      blendedOutcomes: newArch.outcomeDistribution,
      primaryClusterId: newArch.archetypeClusterId,
      confidencePenalty: 0,
      isNewArchetype: true,
    };
  }

  // Sort by similarity (highest first)
  matches.sort((a, b) => b.similarity - a.similarity);

  // Decide: single cluster vs blending
  const topGap = matches[0].similarity - (matches[1]?.similarity ?? 0);
  const useBlending = topGap <= 0.10 && matches.length >= 2;

  // Blend outcomes if close match (Algorithm 3)
  const blendedOutcomes = useBlending
    ? blendOutcomeDistributions(matches)
    : matches[0].outcomeDistribution;

  const confidencePenalty = useBlending ? getConfidencePenalty(matches.length) : 0;

  // Merge snapshot into primary (best match) cluster
  const primaryMatch = matches[0];
  await mergeSnapshotIntoArchetype(primaryMatch.clusterId, vector, fingerprint.tokenMint);

  return {
    matches,
    blendedOutcomes,
    primaryClusterId: primaryMatch.clusterId,
    confidencePenalty,
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
 * Calculate whale quality score for a token (0.2-1.0)
 * Scores the top 20 holders AT SNAPSHOT TIME to determine outcome weight
 *
 * IMPORTANT: This evaluates whale judgment at the snapshot moment, not post-death state.
 * A token that did 5x at snapshot then crashed is still a success (pump_5x outcome).
 * Don't penalize outcomes just because token died naturally afterward.
 *
 * High quality (0.8-1.0) = many profitable whales, high median multiplier at snapshot
 * Low quality (0.2-0.4) = few profitable whales, unknown/sniper holdings at snapshot
 *
 * Used to weight outcome contributions: strong whale backing = higher cluster impact
 */
async function getWhaleQualityScore(tokenMint: string): Promise<number> {
  try {
    // Get latest snapshot with holder metrics (captured AT that moment in time)
    const snapshot = await db.query.tokenFingerprintSnapshots.findFirst({
      where: eq(tokenFingerprintSnapshots.tokenMint, tokenMint),
      orderBy: desc(tokenFingerprintSnapshots.timestamp),
    });

    if (!snapshot?.top20HolderMetrics) return 0.5; // Default neutral

    const metrics = snapshot.top20HolderMetrics as any;

    // Score based on snapshot state, not post-death state
    // If 15+ whales profitable at snapshot = pattern was recognizable by quality wallets
    // If median multiplier > 2x at snapshot = whales got in early
    const medianMultiplier = metrics.medianMultiplier || 1;
    const profitableCount = metrics.profitableCount || 0;

    let score = 0.5; // Start neutral

    // Strong whale backing (many profitable at snapshot moment)
    if (profitableCount >= 15) {
      score += 0.3;
    } else if (profitableCount >= 10) {
      score += 0.15;
    }

    // Early recognition (high multiplier at snapshot = whales caught early)
    if (medianMultiplier > 2) {
      score += 0.2;
    } else if (medianMultiplier > 1.5) {
      score += 0.1;
    }

    return Math.max(0.2, Math.min(1.0, score));
  } catch (error) {
    console.warn(`[WhaleQuality] Error for ${tokenMint}:`, error);
    return 0.5;
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
  tokenAgeMinutes: number,
  rugOnsetTimestamp?: number,
  profitWindowMinutes?: number
): Promise<{
  snapshotCount: number;
  archetypesUpdated: number;
  trajectoryOutcome: string;
  rugOnsetTimestamp?: number;
  profitWindowMinutes?: number;
}> {
  // Determine trajectory outcome shape
  const trajectoryOutcome = determineTrajectoryOutcome(
    finalMultiplier,
    tokenAgeMinutes,
    maxMultiplierReached
  );

  // Calculate whale quality score (weights outcome contribution to clusters)
  // High-quality whale backing (0.8-1.0) = outcome heavily influences cluster
  // Low-quality/unknown (0.2-0.4) = outcome lightly influences cluster
  const whaleQualityScore = await getWhaleQualityScore(tokenMint);

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

      // Update outcome distribution with whale quality weighting
      // High-quality whale backing (score 0.8-1.0) = outcome weighted heavily
      // Low-quality holdings (score 0.2-0.4) = outcome weighted lightly
      const newOutcomes = { ...currentOutcomes };
      const weightedCount = bestArchetype.sampleCount + whaleQualityScore;
      for (const outcome of Object.keys(newOutcomes)) {
        newOutcomes[outcome] =
          (newOutcomes[outcome] * bestArchetype.sampleCount) / weightedCount;
      }
      newOutcomes[trajectoryOutcome] =
        ((newOutcomes[trajectoryOutcome] || 0) * bestArchetype.sampleCount +
          whaleQualityScore) /
        weightedCount;

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

      // Store profit window metadata if rug was detected
      let clusterMetadata = (bestArchetype.metadata as Record<string, any>) || {};
      if (profitWindowMinutes !== undefined) {
        if (!clusterMetadata.rugProfitWindows) clusterMetadata.rugProfitWindows = [];
        clusterMetadata.rugProfitWindows.push({
          tokenMint,
          windowMinutes: profitWindowMinutes,
          recordedAt: now,
        });
        // Keep only recent 100 records per cluster
        if (clusterMetadata.rugProfitWindows.length > 100) {
          clusterMetadata.rugProfitWindows = clusterMetadata.rugProfitWindows.slice(-100);
        }
      }

      await db
        .update(tokenFingerprintClusters)
        .set({
          sampleCount: weightedCount,
          snapshotTokenMints: [...currentMints, tokenMint],
          centroid: newCentroid,
          outcomeDistribution: newOutcomes,
          cohesion: newCohesion,
          minSimilarity: minSim,
          maxSimilarity: maxSim,
          metadata: clusterMetadata,
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
    rugOnsetTimestamp,
    profitWindowMinutes,
  };
}

/**
 * Get average profit window (minutes before rug) for a cluster
 * Returns null if cluster has no rug data
 */
export function getClusterAverageProfitWindow(clusterMetadata: any): number | null {
  const windows = (clusterMetadata?.rugProfitWindows as Array<{ windowMinutes: number }>) || [];
  if (windows.length === 0) return null;
  const avg = windows.reduce((sum, w) => sum + w.windowMinutes, 0) / windows.length;
  return Math.round(avg);
}

/**
 * Handle token deathbed: lifecycle-weighted averaging + pruning
 * Called when token reaches volume → 0 (end of trading)
 *
 * 1. Determine final outcome (crash, pump, etc.)
 * 2. Lifecycle-weight all snapshots (early 1.0x, late 0.2x)
 * 3. Find best matching cluster
 * 4. Merge weighted snapshots into cluster centroid
 * 5. Update cluster outcome distribution
 * 6. Delete snapshot records (pruning)
 * 7. Check cluster for split/merge conditions
 */
export async function handleTokenDeathbed(
  tokenMint: string,
  finalMultiplier: number,
  maxMultiplierReached: number,
  tokenAgeMinutes: number
): Promise<{
  outcome: string;
  clusterId: string;
  snapshotsPruned: number;
  clusterSplit: boolean;
  clusterMerged: boolean;
}> {
  // 1. Determine final outcome
  const outcome = determineTrajectoryOutcome(finalMultiplier, tokenAgeMinutes, maxMultiplierReached);

  // 2. Fetch all snapshots for this token
  const snapshots = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .orderBy(tokenFingerprints.snapshotTimestamp);

  if (snapshots.length === 0) {
    return {
      outcome,
      clusterId: "none",
      snapshotsPruned: 0,
      clusterSplit: false,
      clusterMerged: false,
    };
  }

  // 3. Find best matching cluster
  const allClusters = await db
    .select()
    .from(tokenFingerprintClusters)
    .where(eq(tokenFingerprintClusters.type, "dead"));

  let bestCluster = allClusters[0];
  let bestSimilarity = -1;

  for (const cluster of allClusters) {
    // Use first snapshot for cluster matching (most representative of early shape)
    const firstSnapshotVector = snapshots[0].fingerprintVector as number[];
    const similarity = cosineSimilarity(firstSnapshotVector, cluster.centroid as number[]);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCluster = cluster;
    }
  }

  // Create new cluster if no good match
  if (bestSimilarity < 0.75) {
    const now = Math.floor(Date.now() / 1000);
    const stageDesc = `age${Math.round(tokenAgeMinutes)}_outcome${outcome}`;
    const clusterId = `lifecycle_${stageDesc}_${now}`;

    await db.insert(tokenFingerprintClusters).values({
      clusterId,
      type: "dead",
      lifecycleStage: stageDesc,
      centroid: (snapshots[0].fingerprintVector ?? []) as number[],
      outcomeDistribution: { [outcome]: 1.0 },
      sampleCount: 1,
      snapshotTokenMints: [tokenMint],
      cohesion: 1.0,
      minSimilarity: 1.0,
      maxSimilarity: 1.0,
      createdAt: now,
      updatedAt: now,
      lastRebalancedAt: now,
    });

    // Prune snapshots
    await db.delete(tokenFingerprints).where(eq(tokenFingerprints.tokenMint, tokenMint));

    return {
      outcome,
      clusterId,
      snapshotsPruned: snapshots.length,
      clusterSplit: false,
      clusterMerged: false,
    };
  }

  // 4. Merge lifecycle-weighted snapshots into cluster
  const weightedSnapshots = snapshots.map((snap) => ({
    vector: snap.fingerprintVector as number[],
    tokenAgeMinutes: snap.tokenAgeMinutes || 0,
  }));

  const { centroid: newCentroid, cohesion: newCohesion } = averageVectorsWeighted(weightedSnapshots);

  // 5. Update outcome distribution
  const currentMints = (bestCluster.snapshotTokenMints as string[]) || [];
  const currentOutcomes = (bestCluster.outcomeDistribution as Record<string, number>) || {};
  const totalCount = bestCluster.sampleCount + 1;

  const newOutcomes: Record<string, number> = {};
  for (const [outcomeType, prob] of Object.entries(currentOutcomes)) {
    newOutcomes[outcomeType] = (prob * bestCluster.sampleCount) / totalCount;
  }
  newOutcomes[outcome] =
    ((newOutcomes[outcome] || 0) * bestCluster.sampleCount + 1) / totalCount;

  // Calculate new cohesion
  const testVectors = snapshots.map((s) => s.fingerprintVector as number[]);
  testVectors.push(newCentroid);
  const { cohesion: mergedCohesion } = averageVectors(testVectors);

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(tokenFingerprintClusters)
    .set({
      sampleCount: totalCount,
      snapshotTokenMints: [...currentMints, tokenMint],
      centroid: newCentroid,
      outcomeDistribution: newOutcomes,
      cohesion: mergedCohesion,
      updatedAt: now,
    })
    .where(eq(tokenFingerprintClusters.clusterId, bestCluster.clusterId));

  // 6. Prune snapshots
  await db.delete(tokenFingerprints).where(eq(tokenFingerprints.tokenMint, tokenMint));

  // 7. Check for split/merge conditions (Algorithm 1 & 2)
  let clusterSplit = false;
  let clusterMerged = false;

  const updatedCluster = {
    sampleCount: totalCount,
    outcomeDistribution: newOutcomes,
    cohesion: mergedCohesion,
  };

  if (shouldSplitCluster(updatedCluster)) {
    // TODO: Implement cluster split logic
    clusterSplit = true;
  }

  // Check for merge with similar clusters
  const otherClusters = allClusters.filter((c) => c.clusterId !== bestCluster.clusterId);
  for (const otherCluster of otherClusters) {
    if (shouldMergeClusters({ centroid: newCentroid, outcomeDistribution: newOutcomes },
                             { centroid: otherCluster.centroid as number[], outcomeDistribution: otherCluster.outcomeDistribution as Record<string, number> })) {
      // TODO: Implement cluster merge logic
      clusterMerged = true;
      break;
    }
  }

  return {
    outcome,
    clusterId: bestCluster.clusterId,
    snapshotsPruned: snapshots.length,
    clusterSplit,
    clusterMerged,
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
