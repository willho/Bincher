import { Router, Request, Response } from "express";
import {
  getFundSession,
  getFundHistory,
  getValidationGates,
  resetFund,
} from "../system-picks";
import { systemPicksFund, type FundSession, type Position } from "../system-picks-fund";

const router = Router();

/**
 * GET /api/system-picks/fund/session
 * Get current active fund session state
 */
router.get("/fund/session", (req: Request, res: Response) => {
  try {
    const session = getFundSession();

    if (!session) {
      return res.status(404).json({ error: "No active fund session" });
    }

    return res.json({
      success: true,
      session,
      positions: systemPicksFund.getPositions(),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/system-picks/fund/history
 * Get all archived fund sessions (historical)
 */
router.get("/fund/history", (req: Request, res: Response) => {
  try {
    const history = getFundHistory();

    return res.json({
      success: true,
      sessions: history.map((s) => ({
        ...s,
        durationMinutes: s.endTime
          ? Math.round((s.endTime - s.startTime) / 60)
          : Math.round((Date.now() / 1000 - s.startTime) / 60),
      })),
      totalSessions: history.length,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/system-picks/fund/validation
 * Check if current session meets validation gates for live trading
 */
router.get("/fund/validation", (req: Request, res: Response) => {
  try {
    const gates = getValidationGates();

    return res.json({
      success: true,
      minimumsMet: gates.minimumsMet,
      conservativeThresholdMet: gates.conservativeThresholdMet,
      requirements: gates.reasons,
      recommendation: gates.conservativeThresholdMet
        ? "Ready for live trading (conservative thresholds met)"
        : gates.minimumsMet
          ? "Can enable live trading (minimum requirements met, but conservative threshold not met)"
          : "Not ready yet - see requirements",
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/system-picks/fund/reset
 * Archive current session and start fresh
 *
 * Body: { notes?: string }
 */
router.post("/fund/reset", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body;

    const newSession = await resetFund(notes);

    if (!newSession) {
      return res.status(400).json({
        error: "Could not reset fund - no active session",
      });
    }

    return res.json({
      success: true,
      message: `Fund reset. New session: ${newSession.sessionId}`,
      newSession,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/system-picks/positions
 * Get all open positions in current session
 */
router.get("/positions", (req: Request, res: Response) => {
  try {
    const positions = systemPicksFund.getPositions();
    const openPositions = positions.filter((p) => p.status === "open");

    return res.json({
      success: true,
      openPositions: openPositions.length,
      totalPositions: positions.length,
      positions: openPositions.map((p) => ({
        id: p.positionId,
        token: p.tokenSymbol,
        mint: p.tokenMint,
        entry: {
          price: p.entryPrice,
          size: p.entrySize,
          time: new Date(p.entryTime * 1000).toISOString(),
        },
        current: {
          multiplier: p.multiplier,
          unrealizedPnl: p.unrealized,
          unrealizedPercent: ((p.multiplier - 1) * 100).toFixed(2),
        },
        signals: {
          clusterConfidence: p.clusterConfidence,
          whaleConsensus: p.whaleConsensus,
          exitScore: p.exitScore,
        },
      })),
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/system-picks/metrics
 * Get aggregated metrics and statistics
 */
router.get("/metrics", (req: Request, res: Response) => {
  try {
    const currentSession = getFundSession();
    const history = getFundHistory();

    if (!currentSession) {
      return res.status(404).json({ error: "No active session" });
    }

    // Calculate historical averages
    let totalWins = 0;
    let totalLosses = 0;
    let totalTrades = 0;

    for (const session of history) {
      totalTrades += session.tradesClosed;
      totalWins += session.tradesClosed * (session.winRate / 100);
      totalLosses += session.tradesClosed * ((100 - session.winRate) / 100);
    }

    const historicalWinRate =
      totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "N/A";
    const historicalProfitFactor =
      totalLosses > 0
        ? (totalWins / totalLosses).toFixed(2)
        : totalWins > 0
          ? "∞"
          : "0";

    return res.json({
      success: true,
      current: {
        sessionId: currentSession.sessionId,
        status: currentSession.status,
        runtimeMinutes: Math.round((Date.now() / 1000 - currentSession.startTime) / 60),
        balance: currentSession.currentBalance.toFixed(3),
        totalPnl: currentSession.totalPnl.toFixed(3),
        totalPnlPercent: ((currentSession.totalPnl / currentSession.initialBalance) * 100).toFixed(1),
        winRate: currentSession.winRate.toFixed(1),
        profitFactor: currentSession.profitFactor.toFixed(2),
      },
      historical: {
        sessionCount: history.length,
        averageWinRate: historicalWinRate,
        averageProfitFactor: historicalProfitFactor,
        totalTradesClosed: totalTrades,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
