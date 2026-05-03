import { Router } from "express";
import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import { activePositions } from "@shared/schema";
import { exitPosition, analyzeOutcomes } from "../position-exit-manager";
import { getPositionBudget } from "../position-budget-forecaster";

const router = Router();

/**
 * GET /api/positions - Get all open positions for authenticated user
 */
router.get("/positions", async (req, res) => {
  try {
    const userId = req.user?.id || 1; // TODO: Get from session

    const positions = await db
      .select()
      .from(activePositions)
      .where(eq(activePositions.userId, userId))
      .orderBy(desc(activePositions.openedAt));

    // Return only open positions (no closedAt)
    const openPositions = positions.filter(p => !p.closedAt);

    res.json({
      success: true,
      data: openPositions,
      count: openPositions.length,
    });
  } catch (error) {
    console.error("[PositionAPI] Error fetching positions:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch positions",
    });
  }
});

/**
 * GET /api/positions/:id - Get single position details
 */
router.get("/positions/:id", async (req, res) => {
  try {
    const userId = req.user?.id || 1;
    const positionId = parseInt(req.params.id);

    const position = await db
      .select()
      .from(activePositions)
      .where(eq(activePositions.id, positionId))
      .limit(1);

    if (!position || position.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Position not found",
      });
    }

    // Verify ownership
    if (position[0].userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized",
      });
    }

    res.json({
      success: true,
      data: position[0],
    });
  } catch (error) {
    console.error("[PositionAPI] Error fetching position:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch position",
    });
  }
});

/**
 * GET /api/position-budget - Get budget forecast and allocation data
 */
router.get("/position-budget", async (req, res) => {
  try {
    const userId = req.user?.id || 1;

    const budget = await getPositionBudget(userId);

    res.json({
      success: true,
      data: budget || {
        expectedPositionsPerDay: 5,
        baseAllocationPerPosition: 0.1,
        apeBudget: 0,
        forecastBreakdown: [],
        nextBusyPeriods: [],
      },
    });
  } catch (error) {
    console.error("[PositionAPI] Error fetching budget:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch budget",
    });
  }
});

/**
 * GET /api/positions/closed - Get closed positions (for retrolearner analysis)
 */
router.get("/positions/closed", async (req, res) => {
  try {
    const userId = req.user?.id || 1;
    const limit = parseInt(req.query.limit as string) || 100;

    const closedPositions = await db
      .select()
      .from(activePositions)
      .where(eq(activePositions.userId, userId))
      .orderBy(desc(activePositions.closedAt))
      .limit(limit);

    res.json({
      success: true,
      data: closedPositions,
      count: closedPositions.length,
    });
  } catch (error) {
    console.error("[PositionAPI] Error fetching closed positions:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch closed positions",
    });
  }
});

/**
 * GET /api/position-analytics - Get position performance analytics
 */
router.get("/position-analytics", async (req, res) => {
  try {
    const userId = req.user?.id || 1;

    const outcomes = await analyzeOutcomes(userId);

    res.json({
      success: true,
      data: outcomes,
    });
  } catch (error) {
    console.error("[PositionAPI] Error fetching analytics:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch analytics",
    });
  }
});

/**
 * POST /api/positions/:id/close - Manually close a position
 */
router.post("/positions/:id/close", async (req, res) => {
  try {
    const userId = req.user?.id || 1;
    const positionId = parseInt(req.params.id);
    const { exitPrice } = req.body;

    if (!exitPrice || exitPrice <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid exit price",
      });
    }

    // Verify ownership
    const position = await db
      .select()
      .from(activePositions)
      .where(eq(activePositions.id, positionId))
      .limit(1);

    if (!position || position.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Position not found",
      });
    }

    if (position[0].userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized",
      });
    }

    // Close position
    const result = await exitPosition(positionId, "user_manual", exitPrice, userId);

    res.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    console.error("[PositionAPI] Error closing position:", error);
    res.status(500).json({
      success: false,
      error: "Failed to close position",
    });
  }
});

export default router;
