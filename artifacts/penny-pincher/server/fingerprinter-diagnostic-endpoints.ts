// @ts-nocheck
/**
 * Fingerprinting & Clustering Diagnostic Endpoints
 *
 * Debug API for inspecting token fingerprints, archetypes, clusters,
 * and the relationships between them. Helps diagnose clustering issues
 * and understand feature space behavior.
 */

import type { Express, Request, Response } from "express";
import { db } from "./db";
import {
  tokenFingerprints,
  tokenDataPool,
  strategyClusters,
  tokenOutcomes,
} from "@shared/schema";
import { eq, and, desc, gte, lte, isNotNull, sql, count } from "drizzle-orm";

export function registerFingerprinterDiagnosticEndpoints(app: Express): void {
  /**
   * GET /api/debug/fingerprints
   * Query token fingerprints with filtering
   *
   * Query parameters:
   * - tokenMint: string (exact match)
   * - tokenPattern: string (ILIKE pattern matching)
   * - status: string (active, archived, deathbed)
   * - minSnapshots: number (filter by snapshot count)
   * - hasOutcome: boolean (only tokens with recorded outcomes)
   * - limit: number (default 50, max 500)
   * - offset: number (for pagination)
   *
   * Example:
   * GET /api/debug/fingerprints?status=active&minSnapshots=5&limit=20
   * GET /api/debug/fingerprints?tokenMint=ABC123
   */
  app.get("/api/debug/fingerprints", async (req: Request, res: Response) => {
    try {
      const {
        tokenMint,
        tokenPattern,
        status,
        minSnapshots,
        hasOutcome,
        limit = "50",
        offset = "0",
      } = req.query;

      let query = db.select().from(tokenFingerprints);
      const conditions: any[] = [];

      // Exact mint match
      if (tokenMint) {
        conditions.push(eq(tokenFingerprints.tokenMint, tokenMint as string));
      }

      // Pattern matching on token data pool
      if (tokenPattern) {
        // Would need to join to tokenDataPool for name/symbol filtering
        // For now, just use exact mint matching
      }

      // Filter by snapshot count if provided
      if (minSnapshots) {
        const minSnap = parseInt(minSnapshots as string);
        // This would require calculating snapshot count
        // Placeholder for future implementation
      }

      // Apply all conditions
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      // Apply ordering and pagination
      const limitNum = Math.min(parseInt(limit as string) || 50, 500);
      const offsetNum = parseInt(offset as string) || 0;

      const fingerprints = await query
        .orderBy(desc(tokenFingerprints.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      // Get total count for pagination info
      const totalCount = await db
        .select({ count: count() })
        .from(tokenFingerprints);

      return res.json({
        success: true,
        count: fingerprints.length,
        total: totalCount[0]?.count || 0,
        limit: limitNum,
        offset: offsetNum,
        fingerprints: fingerprints.map((fp) => ({
          id: fp.id,
          tokenMint: fp.tokenMint,
          snapshotIndex: fp.snapshotIndex,
          earlyDynamicsFeatures: fp.earlyDynamicsFeatures
            ? {
                dimensions: Object.keys(fp.earlyDynamicsFeatures).length,
                sample: Object.entries(fp.earlyDynamicsFeatures)
                  .slice(0, 5)
                  .reduce(
                    (acc, [k, v]) => ({ ...acc, [k]: v }),
                    {} as Record<string, any>
                  ),
              }
            : null,
          milestones: fp.milestones,
          trajectory: fp.trajectory,
          archetypeId: fp.archetypeId,
          archetypeConfidence: fp.archetypeConfidence,
          createdAt: new Date(fp.createdAt).toISOString(),
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/fingerprints:", error);
      return res.status(500).json({
        error: "Failed to query fingerprints",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/fingerprints/:tokenMint
   * Get detailed view of a specific token's fingerprints and trajectory
   *
   * Returns:
   * - All snapshots and their fingerprints in chronological order
   * - Current trajectory
   * - Archetype assignments
   * - Outcome if available
   */
  app.get("/api/debug/fingerprints/:tokenMint", async (req: Request, res: Response) => {
    try {
      const { tokenMint } = req.params;

      // Get token data
      const token = await db.query.tokenDataPool.findFirst({
        where: eq(tokenDataPool.tokenMint, tokenMint),
      });

      if (!token) {
        return res.status(404).json({ error: "Token not found" });
      }

      // Get all fingerprints for this token
      const fingerprints = await db
        .select()
        .from(tokenFingerprints)
        .where(eq(tokenFingerprints.tokenMint, tokenMint))
        .orderBy(tokenFingerprints.snapshotIndex);

      // Get outcome if exists
      const outcome = await db.query.tokenOutcomes.findFirst({
        where: eq(tokenOutcomes.tokenMint, tokenMint),
      });

      // Group fingerprints by snapshot index
      const snapshotTimeline = fingerprints.map((fp, idx) => ({
        snapshotIndex: fp.snapshotIndex,
        featureDimensions: fp.earlyDynamicsFeatures
          ? Object.keys(fp.earlyDynamicsFeatures).length
          : 0,
        hasArchetype: !!fp.archetypeId,
        archetypeId: fp.archetypeId,
        archetypeConfidence: fp.archetypeConfidence,
        trajectory: fp.trajectory,
        milestones: fp.milestones,
        createdAt: new Date(fp.createdAt).toISOString(),
      }));

      return res.json({
        success: true,
        token: {
          mint: token.tokenMint,
          name: token.name,
          symbol: token.symbol,
          isDeathbed: token.isDeathbed,
          status: token.pumpfunGraduated ? "graduated" : "pre-grad",
        },
        outcome: outcome
          ? {
              success: outcome.success,
              multiplier: outcome.multiplier,
              pnlPercent: outcome.pnlPercent,
              holdDurationSeconds: outcome.holdDurationSeconds,
            }
          : null,
        fingerprintTimeline: {
          totalSnapshots: snapshotTimeline.length,
          snapshots: snapshotTimeline,
        },
        archetypeAssignments: {
          firstAssignment: fingerprints.find((fp) => fp.archetypeId)?.archetypeId,
          lastAssignment: fingerprints[fingerprints.length - 1]?.archetypeId,
          assignmentHistory: fingerprints
            .filter((fp) => fp.archetypeId)
            .map((fp) => ({
              snapshotIndex: fp.snapshotIndex,
              archetypeId: fp.archetypeId,
              confidence: fp.archetypeConfidence,
            })),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/fingerprints/:tokenMint:", error);
      return res.status(500).json({
        error: "Failed to get fingerprint details",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/archetypes
   * Query strategy clusters (archetypes) with member statistics
   *
   * Query parameters:
   * - limit: number (default 50, max 500)
   * - offset: number (for pagination)
   * - minMembers: number (only clusters with N+ members)
   *
   * Returns:
   * - Cluster info (center, radius, member count)
   * - Member tokens and confidence scores
   * - Cluster quality metrics
   */
  app.get("/api/debug/archetypes", async (req: Request, res: Response) => {
    try {
      const { limit = "50", offset = "0", minMembers = "1" } = req.query;

      const limitNum = Math.min(parseInt(limit as string) || 50, 500);
      const offsetNum = parseInt(offset as string) || 0;
      const minMembersNum = parseInt(minMembers as string) || 1;

      const clusters = await db
        .select()
        .from(strategyClusters)
        .orderBy(desc(strategyClusters.createdAt))
        .limit(limitNum)
        .offset(offsetNum);

      // For each cluster, count members and calculate statistics
      const clusterStats = await Promise.all(
        clusters.map(async (cluster) => {
          const members = await db
            .select({ count: count() })
            .from(tokenFingerprints)
            .where(eq(tokenFingerprints.archetypeId, cluster.id));

          const memberCount = members[0]?.count || 0;

          // Get sample member tokens
          const sampleMembers = await db
            .select({
              tokenMint: tokenFingerprints.tokenMint,
              confidence: tokenFingerprints.archetypeConfidence,
            })
            .from(tokenFingerprints)
            .where(eq(tokenFingerprints.archetypeId, cluster.id))
            .limit(5);

          return {
            id: cluster.id,
            name: cluster.name,
            description: cluster.description,
            memberCount,
            centerDimensions: cluster.centerPoint
              ? Object.keys(cluster.centerPoint).length
              : 0,
            radiusThreshold: cluster.radiusThreshold,
            createdAt: new Date(cluster.createdAt).toISOString(),
            updatedAt: cluster.updatedAt ? new Date(cluster.updatedAt).toISOString() : null,
            sampleMembers: sampleMembers.map((m) => ({
              tokenMint: m.tokenMint,
              confidence: m.confidence,
            })),
          };
        })
      );

      // Filter by minMembers
      const filtered = clusterStats.filter((c) => c.memberCount >= minMembersNum);

      return res.json({
        success: true,
        count: filtered.length,
        limit: limitNum,
        offset: offsetNum,
        archetypes: filtered,
        statistics: {
          totalArchetypes: filtered.length,
          averageMembersPerArchetype:
            filtered.length > 0
              ? (filtered.reduce((sum, c) => sum + c.memberCount, 0) / filtered.length).toFixed(1)
              : 0,
          largestArchetype: filtered.length > 0
            ? filtered.reduce((max, c) => (c.memberCount > max.memberCount ? c : max))
            : null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/archetypes:", error);
      return res.status(500).json({
        error: "Failed to query archetypes",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/archetypes/:archetypeId
   * Get detailed view of a specific archetype and its members
   *
   * Returns:
   * - Archetype definition (center, radius)
   * - All member tokens with confidence scores
   * - Member outcome statistics
   * - Cluster quality metrics
   */
  app.get("/api/debug/archetypes/:archetypeId", async (req: Request, res: Response) => {
    try {
      const { archetypeId } = req.params;

      // Get archetype
      const archetype = await db.query.strategyClusters.findFirst({
        where: eq(strategyClusters.id, archetypeId),
      });

      if (!archetype) {
        return res.status(404).json({ error: "Archetype not found" });
      }

      // Get all members
      const members = await db
        .select({
          tokenMint: tokenFingerprints.tokenMint,
          confidence: tokenFingerprints.archetypeConfidence,
          snapshotIndex: tokenFingerprints.snapshotIndex,
          trajectory: tokenFingerprints.trajectory,
        })
        .from(tokenFingerprints)
        .where(eq(tokenFingerprints.archetypeId, archetypeId))
        .orderBy(desc(tokenFingerprints.archetypeConfidence));

      // Get outcome statistics for members
      const memberOutcomes = await db
        .select({
          tokenMint: tokenOutcomes.tokenMint,
          success: tokenOutcomes.success,
          multiplier: tokenOutcomes.multiplier,
          pnlPercent: tokenOutcomes.pnlPercent,
        })
        .from(tokenOutcomes)
        .where(
          sql`${tokenOutcomes.tokenMint} IN (${sql.join(
            members.map((m) => m.tokenMint),
            ","
          )})`
        );

      // Build outcome map
      const outcomeMap = new Map(memberOutcomes.map((o) => [o.tokenMint, o]));

      // Calculate cluster quality metrics
      const successfulMembers = Array.from(outcomeMap.values()).filter((o) => o.success);
      const successRate =
        memberOutcomes.length > 0
          ? ((successfulMembers.length / memberOutcomes.length) * 100).toFixed(1)
          : "0";
      const avgMultiplier =
        successfulMembers.length > 0
          ? (successfulMembers.reduce((sum, o) => sum + (o.multiplier || 0), 0) /
              successfulMembers.length).toFixed(2)
          : "0";

      return res.json({
        success: true,
        archetype: {
          id: archetype.id,
          name: archetype.name,
          description: archetype.description,
          centerDimensions: archetype.centerPoint
            ? Object.keys(archetype.centerPoint).length
            : 0,
          radiusThreshold: archetype.radiusThreshold,
          createdAt: new Date(archetype.createdAt).toISOString(),
          updatedAt: archetype.updatedAt ? new Date(archetype.updatedAt).toISOString() : null,
        },
        members: {
          total: members.length,
          list: members.map((m) => {
            const outcome = outcomeMap.get(m.tokenMint);
            return {
              tokenMint: m.tokenMint,
              confidence: m.confidence,
              snapshotIndex: m.snapshotIndex,
              trajectory: m.trajectory,
              outcome: outcome
                ? {
                    success: outcome.success,
                    multiplier: outcome.multiplier,
                    pnlPercent: outcome.pnlPercent,
                  }
                : null,
            };
          }),
        },
        clusterQuality: {
          memberCount: members.length,
          outcomeDataPoints: memberOutcomes.length,
          successRate: `${successRate}%`,
          averageMultiplier: successfulMembers.length > 0 ? avgMultiplier : "N/A",
          successfulMembers: successfulMembers.length,
          failedMembers: memberOutcomes.length - successfulMembers.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/archetypes/:archetypeId:", error);
      return res.status(500).json({
        error: "Failed to get archetype details",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/clustering-stats
   * Overall clustering statistics and health metrics
   *
   * Returns:
   * - Total fingerprints, archetypes, coverage %
   * - Feature space statistics
   * - Clustering quality metrics
   * - Problem areas (unclustered tokens, outliers)
   */
  app.get("/api/debug/clustering-stats", async (req: Request, res: Response) => {
    try {
      // Count total fingerprints and archetypes
      const totalFingerprints = await db
        .select({ count: count() })
        .from(tokenFingerprints);

      const totalArchetypes = await db
        .select({ count: count() })
        .from(strategyClusters);

      const clusteredFingerprints = await db
        .select({ count: count() })
        .from(tokenFingerprints)
        .where(isNotNull(tokenFingerprints.archetypeId));

      const unclustered = await db
        .select({ tokenMint: tokenFingerprints.tokenMint })
        .from(tokenFingerprints)
        .where(eq(tokenFingerprints.archetypeId, null));

      // Get archetype size distribution
      const archetypeSizes = await db
        .select({
          archetypeId: tokenFingerprints.archetypeId,
          memberCount: count(),
        })
        .from(tokenFingerprints)
        .where(isNotNull(tokenFingerprints.archetypeId))
        .groupBy(tokenFingerprints.archetypeId);

      const totalFP = totalFingerprints[0]?.count || 0;
      const totalAT = totalArchetypes[0]?.count || 0;
      const clusteredFP = clusteredFingerprints[0]?.count || 0;
      const unclusteredFP = unclustered.length;

      return res.json({
        success: true,
        overview: {
          totalFingerprints: totalFP,
          totalArchetypes: totalAT,
          clusteredFingerprints: clusteredFP,
          unclusteredFingerprints: unclusteredFP,
          clusteringCoverage: totalFP > 0 ? ((clusteredFP / totalFP) * 100).toFixed(1) : "0",
        },
        clusterSizeDistribution: {
          totalArchetypes: archetypeSizes.length,
          averageMembersPerArchetype:
            archetypeSizes.length > 0
              ? (archetypeSizes.reduce((sum, a) => sum + (a.memberCount || 0), 0) /
                  archetypeSizes.length).toFixed(1)
              : 0,
          minClusterSize: archetypeSizes.length > 0
            ? Math.min(...archetypeSizes.map((a) => a.memberCount || 0))
            : 0,
          maxClusterSize: archetypeSizes.length > 0
            ? Math.max(...archetypeSizes.map((a) => a.memberCount || 0))
            : 0,
          distribution: {
            singleton: archetypeSizes.filter((a) => (a.memberCount || 0) === 1).length,
            small: archetypeSizes.filter((a) => (a.memberCount || 0) >= 2 && (a.memberCount || 0) <= 5)
              .length,
            medium: archetypeSizes.filter((a) => (a.memberCount || 0) > 5 && (a.memberCount || 0) <= 20)
              .length,
            large: archetypeSizes.filter((a) => (a.memberCount || 0) > 20).length,
          },
        },
        problemAreas: {
          unclusteredTokens: unclusteredFP,
          singletonClusters: archetypeSizes.filter((a) => (a.memberCount || 0) === 1).length,
          largestCluster: Math.max(...archetypeSizes.map((a) => a.memberCount || 0)),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/clustering-stats:", error);
      return res.status(500).json({
        error: "Failed to get clustering statistics",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/fingerprint-features/:tokenMint
   * Get detailed feature vectors for a token's fingerprints
   *
   * Returns the full early dynamics feature vectors for each snapshot
   */
  app.get("/api/debug/fingerprint-features/:tokenMint", async (req: Request, res: Response) => {
    try {
      const { tokenMint } = req.params;

      const fingerprints = await db
        .select()
        .from(tokenFingerprints)
        .where(eq(tokenFingerprints.tokenMint, tokenMint))
        .orderBy(tokenFingerprints.snapshotIndex);

      if (fingerprints.length === 0) {
        return res.status(404).json({ error: "No fingerprints found for token" });
      }

      return res.json({
        success: true,
        tokenMint,
        fingerprints: fingerprints.map((fp) => ({
          snapshotIndex: fp.snapshotIndex,
          createdAt: new Date(fp.createdAt).toISOString(),
          featureCount: fp.earlyDynamicsFeatures
            ? Object.keys(fp.earlyDynamicsFeatures).length
            : 0,
          features: fp.earlyDynamicsFeatures || {},
          trajectory: fp.trajectory,
          archetypeId: fp.archetypeId,
          archetypeConfidence: fp.archetypeConfidence,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/fingerprint-features/:tokenMint:", error);
      return res.status(500).json({
        error: "Failed to get fingerprint features",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/debug/fingerprinting-health
   * Overall fingerprinting pipeline health check
   *
   * Returns:
   * - Recent errors or failures
   * - Processing delays
   * - Missing or anomalous data
   * - Recommendations
   */
  app.get("/api/debug/fingerprinting-health", async (req: Request, res: Response) => {
    try {
      // Get counts by status
      const activeTokens = await db
        .select({ count: count() })
        .from(tokenDataPool)
        .where(and(
          eq(tokenDataPool.isDeathbed, false),
          eq(tokenDataPool.pumpfunGraduated, false)
        ));

      const deathbedTokens = await db
        .select({ count: count() })
        .from(tokenDataPool)
        .where(eq(tokenDataPool.isDeathbed, true));

      const tokensWithFingerprints = await db
        .select({ distinctMint: tokenFingerprints.tokenMint })
        .from(tokenFingerprints)
        .groupBy(tokenFingerprints.tokenMint);

      // Get archetype coverage
      const fingerprintsWithArchetype = await db
        .select({ count: count() })
        .from(tokenFingerprints)
        .where(isNotNull(tokenFingerprints.archetypeId));

      const totalFingerprints = await db
        .select({ count: count() })
        .from(tokenFingerprints);

      const totalFP = totalFingerprints[0]?.count || 0;
      const totalArchivedFP = fingerprintsWithArchetype[0]?.count || 0;

      return res.json({
        success: true,
        health: {
          status: totalFP > 0 ? "operational" : "degraded",
          issues: [
            ...(totalFP === 0 ? ["No fingerprints found in database"] : []),
            ...(totalArchivedFP / totalFP < 0.5 && totalFP > 0
              ? ["Low archetype assignment rate (<50%)"]
              : []),
            ...((activeTokens[0]?.count || 0) === 0 ? ["No active tokens under monitoring"] : []),
          ],
        },
        tokenMetrics: {
          activeTokens: activeTokens[0]?.count || 0,
          deathbedTokens: deathbedTokens[0]?.count || 0,
          tokensWithFingerprints: tokensWithFingerprints.length,
          averageFingerprintsPerToken:
            tokensWithFingerprints.length > 0
              ? (totalFP / tokensWithFingerprints.length).toFixed(1)
              : 0,
        },
        fingerprintingMetrics: {
          totalFingerprints: totalFP,
          withArchetype: totalArchivedFP,
          withoutArchetype: totalFP - totalArchivedFP,
          archetypeAssignmentRate: totalFP > 0 ? ((totalArchivedFP / totalFP) * 100).toFixed(1) : "0",
        },
        recommendations: [
          ...(totalFP === 0 ? ["Run snapshots and fingerprinting on active tokens"] : []),
          ...(totalFP > 0 && totalArchivedFP / totalFP < 0.5
            ? ["Run clustering algorithm to assign more fingerprints to archetypes"]
            : []),
          ...((activeTokens[0]?.count || 0) === 0
            ? ["Monitor new tokens to generate fingerprints"]
            : []),
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[FingerprinterDiagnostics] Error in /api/debug/fingerprinting-health:", error);
      return res.status(500).json({
        error: "Failed to get fingerprinting health status",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
