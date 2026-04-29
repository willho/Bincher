/**
 * Fingerprint Matching with pgvector
 *
 * Fast similarity search for matching tokens to archetypes
 * using pgvector's HNSW indexes for nearest-neighbor queries
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { tokenFingerprintClusters, activeTokenTrajectories } from "@shared/schema";

// =====================
// TYPES
// =====================

export interface ArchetypeMatch {
  id: number;
  clusterId: string;
  lifecycleStage: string | null;
  outcomeDistribution: Record<string, number> | null;
  sampleCount: number;
  cohesion: number;
  similarity: number; // Distance metric (lower = more similar)
}

export interface TrajectoryMatch {
  id: number;
  tokenMint: string;
  snapshotSequence: number;
  snapshotTimestamp: number;
  tokenAgeMinutes: number | null;
  currentMultiplier: number | null;
  similarity: number;
}

// =====================
// ARCHETYPE MATCHING
// =====================

/**
 * Find nearest archetype clusters to a fingerprint vector
 * Uses pgvector's HNSW index for fast similarity search
 * Distance metric: vector_cosine_ops (0 = identical, 1 = opposite)
 */
export async function matchToArchetypes(
  fingerprintVector: number[],
  limit: number = 5,
  maxDistance: number = 1.0 // 0-1 scale, lower = more similar
): Promise<ArchetypeMatch[]> {
  try {
    const results = await db.execute(
      sql`
        SELECT
          id,
          cluster_id as "clusterId",
          lifecycle_stage as "lifecycleStage",
          outcome_distribution as "outcomeDistribution",
          sample_count as "sampleCount",
          cohesion,
          centroid <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)} as similarity
        FROM token_fingerprint_clusters
        WHERE type = 'dead'
          AND centroid <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)} < ${maxDistance}
        ORDER BY centroid <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)}
        LIMIT ${limit}
      `
    );

    return results as ArchetypeMatch[];
  } catch (error) {
    console.error("[FingerprintMatching] Error matching to archetypes:", error);
    throw error;
  }
}

/**
 * Find the single best matching archetype
 * Returns null if no good match found
 */
export async function getBestArchetype(
  fingerprintVector: number[],
  maxDistance: number = 0.5
): Promise<ArchetypeMatch | null> {
  const matches = await matchToArchetypes(fingerprintVector, 1, maxDistance);
  return matches.length > 0 ? matches[0] : null;
}

// =====================
// TRAJECTORY MATCHING
// =====================

/**
 * Find similar token trajectories (active or archived)
 * Useful for finding tokens with similar evolution patterns
 */
export async function matchToTrajectories(
  fingerprintVector: number[],
  limit: number = 10,
  maxDistance: number = 1.0
): Promise<TrajectoryMatch[]> {
  try {
    const results = await db.execute(
      sql`
        SELECT
          id,
          token_mint as "tokenMint",
          snapshot_sequence as "snapshotSequence",
          snapshot_timestamp as "snapshotTimestamp",
          token_age_minutes as "tokenAgeMinutes",
          current_multiplier as "currentMultiplier",
          fingerprint_vector <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)} as similarity
        FROM active_token_trajectories
        WHERE fingerprint_vector <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)} < ${maxDistance}
        ORDER BY fingerprint_vector <-> ${sql.raw(`'[${fingerprintVector.join(",")}]'::vector`)}
        LIMIT ${limit}
      `
    );

    return results as TrajectoryMatch[];
  } catch (error) {
    console.error("[FingerprintMatching] Error matching to trajectories:", error);
    throw error;
  }
}

// =====================
// VECTOR UTILITIES
// =====================

/**
 * Normalize fingerprint vector to unit length (for cosine similarity)
 * pgvector handles normalization internally, but you can do it here if needed
 */
export function normalizeFingerprint(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

/**
 * Calculate cosine similarity between two vectors (0-1, higher = more similar)
 * For debugging/logging purposes (pgvector does this in the database)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector length mismatch");

  const dotProduct = a.reduce((sum, av, i) => sum + av * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, av) => sum + av * av, 0));
  const magB = Math.sqrt(b.reduce((sum, bv) => sum + bv * bv, 0));

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

// =====================
// DEBUG / LOGGING
// =====================

/**
 * Get archetype centroid for inspection (for testing)
 */
export async function getArchetypeCentroid(clusterId: string): Promise<number[] | null> {
  try {
    const result = await db
      .select({ centroid: tokenFingerprintClusters.centroid })
      .from(tokenFingerprintClusters)
      .where(sql`cluster_id = ${clusterId}`);

    return result.length > 0 ? (result[0].centroid as any as number[]) : null;
  } catch (error) {
    console.error(`[FingerprintMatching] Error getting centroid for ${clusterId}:`, error);
    return null;
  }
}

/**
 * Get count of archetypes for stats
 */
export async function getArchetypeCount(): Promise<number> {
  try {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM token_fingerprint_clusters`);
    return (result[0] as any).count;
  } catch (error) {
    console.error("[FingerprintMatching] Error counting archetypes:", error);
    return 0;
  }
}
