import { Router } from "express";
import {
  getWalletLeaderboard,
  getWalletDetail,
  getTopWalletsByRecentPerformance,
  getWalletsWithRedFlags,
} from "../wallet-leaderboard-scoring";

const router = Router();

/**
 * GET /api/wallets/leaderboard - Get ranked wallet list by unified score
 * Query params:
 *   limit: number (default 50, max 200)
 *   minScore: number (default 0, unbounded)
 *   minWinRate: number (default 0, 0-1)
 *   minTrades: number (default 0)
 */
router.get("/wallets/leaderboard", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const minScore = parseFloat(req.query.minScore as string) || 0;
    const minWinRate = parseFloat(req.query.minWinRate as string) || 0;
    const minTrades = parseInt(req.query.minTrades as string) || 0;

    const leaderboard = await getWalletLeaderboard(limit, minScore, minWinRate, minTrades);

    res.json({
      success: true,
      data: leaderboard,
      count: leaderboard.length,
      metadata: {
        limit,
        minScore,
        minWinRate,
        minTrades,
        timestamp: Math.floor(Date.now() / 1000),
      },
    });
  } catch (error) {
    console.error("[WalletLeaderboard] Error fetching leaderboard:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch wallet leaderboard",
    });
  }
});

/**
 * GET /api/wallets/:address - Get single wallet details with percentile
 */
router.get("/wallets/:address", async (req, res) => {
  try {
    const walletAddress = req.params.address;

    const wallet = await getWalletDetail(walletAddress);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        error: "Wallet not found in leaderboard",
      });
    }

    res.json({
      success: true,
      data: wallet,
    });
  } catch (error) {
    console.error("[WalletLeaderboard] Error fetching wallet:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch wallet details",
    });
  }
});

/**
 * GET /api/wallets/top/recent - Get top wallets by recent performance
 */
router.get("/wallets/top/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const topWallets = await getTopWalletsByRecentPerformance(limit);

    res.json({
      success: true,
      data: topWallets,
      count: topWallets.length,
    });
  } catch (error) {
    console.error("[WalletLeaderboard] Error fetching top recent:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch top recent wallets",
    });
  }
});

/**
 * GET /api/wallets/red-flags - Get wallets with red flags
 */
router.get("/wallets/red-flags", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const redFlagWallets = await getWalletsWithRedFlags(limit);

    res.json({
      success: true,
      data: redFlagWallets,
      count: redFlagWallets.length,
      warning: "These wallets have negative PnL, low win rate, or insufficient history",
    });
  } catch (error) {
    console.error("[WalletLeaderboard] Error fetching red flags:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch red flag wallets",
    });
  }
});

export default router;
