import { Router } from "express";
import { getPortfolioHistory } from "../portfolio-history";

const router = Router();

/**
 * Get portfolio history for current user
 * Shows transaction log and events
 */
router.get("/api/portfolio/history", async (req, res) => {
  try {
    // TODO: Get userId from auth context
    const userId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);
    const limit = parseInt(req.query.limit as string) || 100;

    const history = await getPortfolioHistory(userId, limit);

    // Format for display
    const formatted = history.map((event) => ({
      id: event.id,
      type: event.eventType,
      description: event.description,
      timestamp: event.recordedAt,
      // For buy/sell events
      ...(event.eventType === "buy" || event.eventType === "sell"
        ? {
            tokenSymbol: event.tokenSymbol,
            amount: event.amount,
            price: event.price,
            ...(event.eventType === "sell"
              ? { pnl: event.pnl, pnlPercent: event.pnlPercent }
              : {}),
          }
        : {}),
      // For topup events
      ...(event.eventType === "fund_topup" ? { amount: event.amount } : {}),
      // Session tracking
      sessionId: event.sessionId,
    }));

    return res.json({
      history: formatted.reverse(), // Most recent first
      count: formatted.length,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
