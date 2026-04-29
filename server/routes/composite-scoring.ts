/**
 * Composite Scoring API Routes
 *
 * Endpoints for token scoring, ranking, and pool management
 */

import { Router, Request, Response } from "express";
import {
  scoreTokenForPoolRanking,
  getTopTokensByCompositeScore,
  rankTokensByTier,
  explainCompositeScore,
  getTokensToEvict,
} from "../token-composite-scoring";
import { getPoolStatus, performPoolMaintenance } from "../monitored-pool-manager";

const router = Router();

/**
 * GET /api/token-score/:mint
 * Get composite score for a specific token
 */
router.get("/token-score/:mint", async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const { annScore } = req.query;

    if (!mint) {
      return res.status(400).json({ error: "Missing mint parameter" });
    }

    if (!annScore || typeof annScore !== "string") {
      return res.status(400).json({ error: "Missing annScore query parameter (0.0-1.0)" });
    }

    const ann = parseFloat(annScore);
    if (isNaN(ann) || ann < 0 || ann > 1) {
      return res.status(400).json({ error: "Invalid annScore: must be 0.0-1.0" });
    }

    const compositeScore = await scoreTokenForPoolRanking(mint, ann);
    const explanation = await explainCompositeScore(mint, ann);

    res.json({
      mint,
      compositeScore,
      ...explanation,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/top-tokens
 * Get top N tokens by composite score
 *
 * Query params:
 *   limit: number (default 1900, max 5000)
 */
router.get("/top-tokens", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(5000, parseInt(req.query.limit as string) || 1900);

    const tokens = await getTopTokensByCompositeScore(limit);

    res.json({
      count: tokens.length,
      limit,
      tokens: tokens.slice(0, 100), // Return top 100 for brevity in response
      summary: {
        topScore: tokens.length > 0 ? tokens[0].compositeScore : 0,
        avgScore:
          tokens.length > 0
            ? (tokens.reduce((sum, t) => sum + t.compositeScore, 0) / tokens.length).toFixed(2)
            : 0,
        medianScore:
          tokens.length > 0
            ? tokens[Math.floor(tokens.length / 2)].compositeScore.toFixed(2)
            : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/tokens-by-tier
 * Get tokens grouped by score tier
 *
 * Query params:
 *   limit: number (default 1900)
 */
router.get("/tokens-by-tier", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(5000, parseInt(req.query.limit as string) || 1900);

    const tiers = await rankTokensByTier(limit);

    res.json({
      tier1: {
        name: "Elite (5.0+)",
        count: tiers.tier1.length,
        description: "High confidence × high returns",
        tokens: tiers.tier1.slice(0, 20), // Top 20 per tier
      },
      tier2: {
        name: "Standard (2.0-5.0)",
        count: tiers.tier2.length,
        description: "Solid combination",
        tokens: tiers.tier2.slice(0, 20),
      },
      tier3: {
        name: "Secondary (0.5-2.0)",
        count: tiers.tier3.length,
        description: "Weaker but viable",
        tokens: tiers.tier3.slice(0, 20),
      },
      tier4: {
        name: "Low Priority (<0.5)",
        count: tiers.tier4.length,
        description: "Poor combination",
        tokens: tiers.tier4.slice(0, 20),
      },
      summary: {
        totalTokens: tiers.tier1.length + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length,
        distribution: {
          tier1Pct: ((tiers.tier1.length / (tiers.tier1.length + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length)) * 100).toFixed(1),
          tier2Pct: ((tiers.tier2.length / (tiers.tier1.length + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length)) * 100).toFixed(1),
          tier3Pct: ((tiers.tier3.length / (tiers.tier1.length + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length)) * 100).toFixed(1),
          tier4Pct: ((tiers.tier4.length / (tiers.tier1.length + tiers.tier2.length + tiers.tier3.length + tiers.tier4.length)) * 100).toFixed(1),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/pool/status
 * Get current monitoring pool status
 */
router.get("/pool/status", async (req: Request, res: Response) => {
  try {
    const status = await getPoolStatus();

    res.json({
      currentSize: status.currentSize,
      targetSize: 1900,
      maxSize: 2000,
      isFull: status.currentSize >= 2000,
      tiers: {
        tier1: status.tier1Count,
        tier2: status.tier2Count,
        tier3: status.tier3Count,
        tier4: status.tier4Count,
      },
      evictionCandidates: status.evictionCandidates.slice(0, 10),
      lastUpdated: new Date(status.lastUpdated * 1000).toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/pool/eviction-candidates
 * Get tokens that should be evicted from pool
 *
 * Query params:
 *   poolSize: number (current pool size)
 *   maxPoolSize: number (maximum allowed, default 1900)
 */
router.get("/pool/eviction-candidates", async (req: Request, res: Response) => {
  try {
    const poolSize = parseInt(req.query.poolSize as string) || 0;
    const maxPoolSize = Math.min(2000, parseInt(req.query.maxPoolSize as string) || 1900);

    const candidates = await getTokensToEvict(poolSize, maxPoolSize);

    res.json({
      poolSize,
      maxPoolSize,
      needsEviction: candidates.length > 0,
      evictionCount: candidates.length,
      candidates: candidates.slice(0, 50), // Top 50 eviction candidates
      recommendation:
        candidates.length > 0
          ? `Remove ${candidates.length} lowest-scoring tokens to bring pool below target`
          : "Pool size is acceptable",
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/pool/maintenance
 * Trigger pool maintenance task
 * (This would normally be called by a scheduled task)
 */
router.post("/pool/maintenance", async (req: Request, res: Response) => {
  try {
    await performPoolMaintenance();
    const status = await getPoolStatus();

    res.json({
      success: true,
      message: "Pool maintenance completed",
      poolStatus: status,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
