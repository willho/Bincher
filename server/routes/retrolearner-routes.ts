import { Router } from "express";
import { getLearnedParameters, getAllClusterMetrics } from "../retrolearner-phase-d";

const router = Router();

/**
 * GET /api/retrolearner/metrics - Get all cluster learning metrics
 */
router.get("/retrolearner/metrics", async (req, res) => {
  try {
    const metrics = await getAllClusterMetrics();

    res.json({
      success: true,
      data: metrics,
      count: metrics.length,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.error("[Retrolearner] Error fetching metrics:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch retrolearner metrics",
    });
  }
});

/**
 * GET /api/retrolearner/:clusterType - Get learned parameters for specific cluster
 */
router.get("/retrolearner/:clusterType", async (req, res) => {
  try {
    const clusterType = req.params.clusterType;

    const params = await getLearnedParameters(clusterType);

    res.json({
      success: true,
      data: {
        clusterType,
        ...params,
        note: "These learned values are updated via retrolearner as position outcomes accumulate",
      },
    });
  } catch (error) {
    console.error("[Retrolearner] Error fetching parameters:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch learned parameters",
    });
  }
});

export default router;
