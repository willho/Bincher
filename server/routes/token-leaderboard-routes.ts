import { Router } from "express";
import { getTokenLeaderboard, getTokenDetail } from "../token-trajectory-scoring";

const router = Router();

/**
 * GET /api/tokens/leaderboard - Get ranked token list by trajectory score
 * Query params:
 *   limit: number (default 50, max 200)
 *   minScore: number (default 0)
 *   minConfidence: number (default 0, 0-1)
 */
router.get("/tokens/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const minScore = parseFloat(req.query.minScore as string) || 0;
    const minConfidence = parseFloat(req.query.minConfidence as string) || 0;

    const leaderboard = await getTokenLeaderboard(limit, minScore, minConfidence);

    res.json({
      success: true,
      data: leaderboard,
      count: leaderboard.length,
      metadata: {
        limit,
        minScore,
        minConfidence,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  } catch (error) {
    console.error("[TokenLeaderboard] Error fetching leaderboard:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch token leaderboard",
    });
  }
});

/**
 * GET /api/tokens/:mint - Get single token details with percentile ranking
 */
router.get("/tokens/:mint", async (req, res) => {
  try {
    const tokenMint = req.params.mint;

    const token = await getTokenDetail(tokenMint);

    if (!token) {
      return res.status(404).json({
        success: false,
        error: "Token not found in leaderboard",
      });
    }

    res.json({
      success: true,
      data: token,
    });
  } catch (error) {
    console.error("[TokenLeaderboard] Error fetching token:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch token details",
    });
  }
});

/**
 * GET /api/tokens/top/moonshots - Get top moonshot candidates (high 100x/10x probability)
 */
router.get("/tokens/top/moonshots", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);

    // Get leaderboard sorted by trajectory score
    const leaderboard = await getTokenLeaderboard(limit, 0.5, 0.3); // Min score 0.5, confidence 30%

    // Filter for high moonshot probability
    const moonshots = leaderboard.filter(
      t =>
        (t.outcomes.pump_100x || 0) > 0.1 || (t.outcomes.pump_10x || 0) > 0.2
    );

    res.json({
      success: true,
      data: moonshots.slice(0, limit),
      count: moonshots.length,
    });
  } catch (error) {
    console.error("[TokenLeaderboard] Error fetching moonshots:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch moonshot tokens",
    });
  }
});

/**
 * GET /api/tokens/top/safe - Get safest bets (high 2x probability, low crash)
 */
router.get("/tokens/top/safe", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);

    const leaderboard = await getTokenLeaderboard(200, 0.2, 0.3);

    // Filter for safe bets: high 2x probability, low crash
    const safeBets = leaderboard
      .filter(
        t =>
          (t.outcomes.pump_2x || 0) > 0.4 &&
          (t.outcomes.crash_fast || 0) < 0.2 &&
          t.outcomes.deathbed === 0
      )
      .sort((a, b) => {
        // Sort by 2x probability descending
        return (b.outcomes.pump_2x || 0) - (a.outcomes.pump_2x || 0);
      });

    res.json({
      success: true,
      data: safeBets.slice(0, limit),
      count: safeBets.length,
    });
  } catch (error) {
    console.error("[TokenLeaderboard] Error fetching safe bets:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch safe token bets",
    });
  }
});

export default router;
