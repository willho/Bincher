import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl, getSwapWalletAddress, isBaseCurrency, isBaseCurrencySymbol, fetchWalletTokenHoldings, cleanupStaleWebhooks, fetchWalletSwapHistory, SOL_MINT } from "./helius";
import { sendSwapNotification, sendPasswordResetEmail } from "./email";
import type { HeliusWebhookPayload } from "@shared/schema";
import {
  getUserApiKeys,
  addUserApiKey,
  removeUserApiKey,
  validateUserApiKey,
  getUserWalletLimit,
  canAddWallet,
  getWalletLimitsConfig,
  updateWalletLimitsConfig,
  getAdminApiKeys,
  addAdminApiKey,
  removeAdminApiKey,
  toggleAdminApiKey,
  maskApiKey,
  getUserResendApiKey,
  getNextAdminApiKey,
} from "./api-keys";
import { notificationSettingsSchema, tradeConfigSchema, insertWalletRuleDefaultsSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
import { createUser, authenticateUser, createSession, getSession, destroySession, getUserCount, findUserByEmail, createPasswordResetToken, validateResetToken, resetPassword } from "./auth";
import { 
  getOrCreateHotWallet, 
  createHotWallet, 
  getHotWalletBalance, 
  getTradeConfig, 
  updateTradeConfig, 
  getHoldings, 
  getPendingBuys,
  addPendingBuy,
  hasTokenBeenBought,
  withdrawSol,
  getTokenWalletKeypair,
  sendProfitsToMainWallet,
  exportHotWalletPrivateKey,
  exportTokenWalletPrivateKey
} from "./wallet";
import { sellToken, sellTokenWithWallet, buyToken, getTokenPrice, getTokenInfo, estimatePriorityFee, priorityFeeToSol } from "./jupiter";
import { db } from "./db";
import { holdings, monitoredWallets, swaps, tradeRules, tradeRulePresets, signalWalletProfiles, walletRuleDefaults, tokenBlacklist, signalCumulativeTracking, copyTradingDefaults, discoveryTriggers, discoveryJobRuns, apiQueue, userBudgetUsage, adminChatMessages, userTokenViews, errorLogs, tokenDataPool, walletStrategies, discoveryEvents, systemInsights } from "@shared/schema";
import { eq, and, or, isNotNull, desc, gte, sql, like, inArray, count, asc } from "drizzle-orm";
import { startTradeProcessor, updateBuyCount, checkPriceRiseTrigger } from "./trade-processor";
import { startPriceMonitor } from "./price-monitor";
import { startSystemLogCleanup, logError, logInfo, logWarn, logSuccess, querySystemLogs, logWebhook, logErrorToTable, logCopyTradeDecision, type CopyTradeDecision } from "./system-logger";
import { scoreToken, refreshScore, chatWithAI, getChatHistory, clearChatHistory, getAIInsights, getSnapshot, getAllSnapshots, getPincherWelcomeMessage, getFilteredEventsForUser, getUserPreferences, updateUserPreferences, setAdminInstructions, logTokenEvent, generateAndCacheAlert, reviewTradingRules } from "./ai";
import { 
  isWalletInTop100, 
  getHolderTier, 
  triggerHolderRefresh,
  getHoldersCached,
  getAggregatesForAI,
  checkEmergingWhale
} from "./price-aggregator";
import {
  handleWebhookUpdate,
  createLinkToken,
  verifyBotToken,
  setWebhook,
  getWebhookInfo,
  unlinkTelegram,
  sendSwapAlert as sendTelegramSwapAlert,
  sendWhaleAlert as sendTelegramWhaleAlert,
  sendActivityAlert as sendTelegramActivityAlert,
  log as telegramLog,
} from "./telegram";
import { isAIAvailable } from "./ai-health";
import { getNetworkMode, setNetworkMode, getSolanaFaucetUrl, type NetworkMode } from "./network-mode";
import { markSignalWalletSold, updateScoreOnWhaleActivity, resolvePositionScoreSnapshots } from "./position-score";
import { recordWhaleActivity, checkForFamiliarWhalesInToken, type FamiliarWhaleAlert } from "./familiar-whales";

let wss: WebSocketServer;

// Webhook secret for verification (you can set this as env var for extra security)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret";

function broadcastSwap(swap: any) {
  if (!wss) return;
  const message = JSON.stringify({ type: "NEW_SWAP", swap });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastStatus(status: any) {
  if (!wss) return;
  const message = JSON.stringify({ type: "STATUS_UPDATE", status });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Signal Cumulative Tracking helpers
async function updateSignalCumulativeTracking(
  userId: number,
  signalWalletId: number,
  tokenMint: string,
  tokenSymbol: string | undefined,
  action: "buy" | "sell",
  amount: number,
  solValue: number | undefined,
  signature: string
): Promise<void> {
  try {
    const existing = await db.select().from(signalCumulativeTracking)
      .where(and(
        eq(signalCumulativeTracking.userId, userId),
        eq(signalCumulativeTracking.signalWalletId, signalWalletId),
        eq(signalCumulativeTracking.tokenMint, tokenMint)
      ))
      .limit(1);

    if (existing.length > 0) {
      const record = existing[0];
      if (action === "buy") {
        await db.update(signalCumulativeTracking)
          .set({
            totalBoughtTokens: (record.totalBoughtTokens || 0) + amount,
            totalBoughtSol: (record.totalBoughtSol || 0) + (solValue || 0),
            buyCount: (record.buyCount || 0) + 1,
            lastBuyAt: new Date(),
            lastBuySignature: signature,
            updatedAt: new Date()
          })
          .where(eq(signalCumulativeTracking.id, record.id));
      } else {
        await db.update(signalCumulativeTracking)
          .set({
            totalSoldTokens: (record.totalSoldTokens || 0) + amount,
            totalSoldSol: (record.totalSoldSol || 0) + (solValue || 0),
            sellCount: (record.sellCount || 0) + 1,
            lastSellAt: new Date(),
            lastSellSignature: signature,
            updatedAt: new Date()
          })
          .where(eq(signalCumulativeTracking.id, record.id));
      }
      console.log(`[SignalTracking] Updated ${action} for signal ${signalWalletId} token ${tokenSymbol || tokenMint.slice(0,8)}`);
    } else {
      await db.insert(signalCumulativeTracking).values({
        userId,
        signalWalletId,
        tokenMint,
        tokenSymbol: tokenSymbol || null,
        totalBoughtTokens: action === "buy" ? amount : 0,
        totalBoughtSol: action === "buy" ? (solValue || 0) : 0,
        buyCount: action === "buy" ? 1 : 0,
        lastBuyAt: action === "buy" ? new Date() : null,
        lastBuySignature: action === "buy" ? signature : null,
        totalSoldTokens: action === "sell" ? amount : 0,
        totalSoldSol: action === "sell" ? (solValue || 0) : 0,
        sellCount: action === "sell" ? 1 : 0,
        lastSellAt: action === "sell" ? new Date() : null,
        lastSellSignature: action === "sell" ? signature : null,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log(`[SignalTracking] Created tracking record for signal ${signalWalletId} token ${tokenSymbol || tokenMint.slice(0,8)}`);
    }
  } catch (error) {
    console.error(`[SignalTracking] Error updating tracking:`, error);
  }
}

async function getSignalCumulativePosition(
  userId: number,
  signalWalletId: number,
  tokenMint: string
): Promise<{ totalBought: number; totalSold: number; netPosition: number; sellPercent: number } | null> {
  try {
    const record = await db.select().from(signalCumulativeTracking)
      .where(and(
        eq(signalCumulativeTracking.userId, userId),
        eq(signalCumulativeTracking.signalWalletId, signalWalletId),
        eq(signalCumulativeTracking.tokenMint, tokenMint)
      ))
      .limit(1);

    if (record.length === 0) return null;

    const totalBought = record[0].totalBoughtTokens || 0;
    const totalSold = record[0].totalSoldTokens || 0;
    const netPosition = totalBought - totalSold;
    const sellPercent = totalBought > 0 ? (totalSold / totalBought) * 100 : 0;

    return { totalBought, totalSold, netPosition, sellPercent };
  } catch (error) {
    console.error(`[SignalTracking] Error getting position:`, error);
    return null;
  }
}

// Token Blacklist helpers
async function isTokenBlacklisted(userId: number, tokenMint: string): Promise<boolean> {
  try {
    const record = await db.select().from(tokenBlacklist)
      .where(and(
        eq(tokenBlacklist.userId, userId),
        eq(tokenBlacklist.tokenMint, tokenMint)
      ))
      .limit(1);
    return record.length > 0;
  } catch (error) {
    console.error(`[TokenBlacklist] Error checking blacklist:`, error);
    return false;
  }
}

async function addToBlacklist(
  userId: number,
  tokenMint: string,
  tokenSymbol: string | undefined,
  reason: string | undefined
): Promise<boolean> {
  try {
    const existing = await isTokenBlacklisted(userId, tokenMint);
    if (existing) return false;
    
    await db.insert(tokenBlacklist).values({
      userId,
      tokenMint,
      tokenSymbol: tokenSymbol || null,
      reason: reason || null,
      createdAt: new Date()
    });
    console.log(`[TokenBlacklist] Added ${tokenSymbol || tokenMint.slice(0,8)} for user ${userId}`);
    return true;
  } catch (error) {
    console.error(`[TokenBlacklist] Error adding to blacklist:`, error);
    return false;
  }
}

async function removeFromBlacklist(userId: number, tokenMint: string): Promise<boolean> {
  try {
    const result = await db.delete(tokenBlacklist)
      .where(and(
        eq(tokenBlacklist.userId, userId),
        eq(tokenBlacklist.tokenMint, tokenMint)
      ));
    console.log(`[TokenBlacklist] Removed ${tokenMint.slice(0,8)} for user ${userId}`);
    return true;
  } catch (error) {
    console.error(`[TokenBlacklist] Error removing from blacklist:`, error);
    return false;
  }
}

async function getBlacklist(userId: number): Promise<any[]> {
  try {
    return await db.select().from(tokenBlacklist)
      .where(eq(tokenBlacklist.userId, userId))
      .orderBy(desc(tokenBlacklist.createdAt));
  } catch (error) {
    console.error(`[TokenBlacklist] Error getting blacklist:`, error);
    return [];
  }
}

// Schema for updating notification settings
const updateSettingsSchema = notificationSettingsSchema.partial();

// Schema for validating Helius webhook payload
const heliusPayloadSchema = z.object({
  signature: z.string(),
  timestamp: z.number().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  slot: z.number(),
  events: z.object({
    swap: z.any().optional(),
  }).optional(),
  tokenTransfers: z.array(z.any()).optional(),
  nativeTransfers: z.array(z.any()).optional(),
  accountData: z.array(z.any()).optional(),
  description: z.string().optional(),
}).passthrough();

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Set up WebSocket server
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");
    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
  });

  // Cookie parser middleware
  app.use(cookieParser());

  // Extend Express Request type
  interface AuthenticatedRequest extends Request {
    userId?: number;
    username?: string;
    isAdmin?: boolean;
  }

  // Auth middleware - extracts user from session cookie
  const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = req.cookies?.session;
    if (token) {
      const session = getSession(token);
      if (session) {
        req.userId = session.userId;
        req.username = session.username;
        req.isAdmin = session.isAdmin;
      }
    }
    if (!req.userId && req.query._devbypass === "1" && process.env.NODE_ENV === "development") {
      req.userId = 4;
      req.username = "Willho";
      req.isAdmin = true;
    }
    next();
  };

  // Require auth middleware - blocks unauthenticated requests
  const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  // Require admin middleware - blocks non-admin requests
  const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!req.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  };

  // Apply auth middleware to all routes
  app.use(authMiddleware);

  // Auth routes (public - no auth required)
  app.get("/api/auth/check-setup", async (req, res) => {
    try {
      const userCount = await getUserCount();
      res.json({ needsSetup: userCount === 0 });
    } catch (error) {
      res.status(500).json({ error: "Failed to check setup" });
    }
  });

  app.get("/api/auth/session", (req: AuthenticatedRequest, res) => {
    if (req.userId && req.username) {
      res.json({ authenticated: true, username: req.username, userId: req.userId, isAdmin: req.isAdmin ?? false });
    } else if (req.query._devbypass === "1" && process.env.NODE_ENV === "development") {
      res.json({ authenticated: true, username: "Willho", userId: 4, isAdmin: true });
    } else {
      res.json({ authenticated: false });
    }
  });

  app.post("/api/auth/dev-login", async (req: AuthenticatedRequest, res) => {
    if (process.env.NODE_ENV !== "development") {
      return res.status(403).json({ error: "Not available in production" });
    }
    const token = createSession(4, "Willho", true, true);
    res.cookie("session", token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ success: true, username: "Willho" });
  });

  const ADMIN_CODEWORD = "Admin1112";

  // Health check function for install wizard
  async function runInstallHealthChecks(heliusApiKey: string, networkMode?: "mainnet" | "devnet"): Promise<{
    helius: { ok: boolean; message: string };
    database: { ok: boolean; message: string };
    telegram: { ok: boolean; message: string };
    email: { ok: boolean; message: string };
    ai: { ok: boolean; message: string };
  }> {
    const results = {
      helius: { ok: false, message: "Not tested" },
      database: { ok: false, message: "Not tested" },
      telegram: { ok: false, message: "Not configured" },
      email: { ok: false, message: "Not configured" },
      ai: { ok: false, message: "Not available" },
    };

    // Determine the network to test against
    const network = networkMode || await getNetworkMode();
    const heliusApiBase = network === "devnet" ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";

    // Test Helius API key
    try {
      const response = await fetch(`${heliusApiBase}/v0/webhooks?api-key=${heliusApiKey}`);
      if (response.ok) {
        results.helius = { ok: true, message: "API key valid" };
      } else if (response.status === 401) {
        results.helius = { ok: false, message: "Invalid API key" };
      } else {
        results.helius = { ok: false, message: `API error: ${response.status}` };
      }
    } catch (e) {
      results.helius = { ok: false, message: "Connection failed" };
    }

    // Test database connection
    try {
      await db.execute("SELECT 1");
      results.database = { ok: true, message: "Connected" };
    } catch (e) {
      results.database = { ok: false, message: "Connection failed" };
    }

    // Check Telegram bot token
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const valid = await verifyBotToken();
        results.telegram = valid 
          ? { ok: true, message: "Bot token valid" }
          : { ok: false, message: "Invalid bot token" };
      } catch (e) {
        results.telegram = { ok: false, message: "Verification failed" };
      }
    } else {
      results.telegram = { ok: false, message: "Not configured (optional)" };
    }

    // Check Resend API key
    if (process.env.RESEND_API_KEY) {
      results.email = { ok: true, message: "API key configured" };
    } else {
      results.email = { ok: false, message: "Not configured (optional)" };
    }

    // Check AI availability
    if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
      results.ai = isAIAvailable() 
        ? { ok: true, message: "Available" }
        : { ok: false, message: "Configured but currently unavailable" };
    } else {
      results.ai = { ok: false, message: "Not configured" };
    }

    return results;
  }

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password, recoveryEmail, heliusApiKey, cashoutWallet, adminCodeword } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      // Helius API key is now optional - will fall back to admin pool if not provided
      const useAdminPool = !heliusApiKey;
      if (useAdminPool) {
        // Check if admin pool has a Helius key available
        const adminKey = await getNextAdminApiKey("helius");
        if (!adminKey && !process.env.HELIUS_API_KEY) {
          return res.status(400).json({ error: "Helius API key is required (no admin pool available)" });
        }
      }

      // Validate Solana wallet address if provided
      if (cashoutWallet && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cashoutWallet)) {
        return res.status(400).json({ error: "Invalid Solana wallet address" });
      }

      // Check if this is first user (install wizard)
      const userCount = await getUserCount();
      const isFirstUser = userCount === 0;
      let grantAdmin = false;

      if (isFirstUser) {
        // First user MUST provide correct admin codeword
        if (!adminCodeword) {
          return res.status(400).json({ error: "Admin codeword required for first user setup", requiresCodeword: true });
        }
        if (adminCodeword !== ADMIN_CODEWORD) {
          return res.status(400).json({ error: "Invalid admin codeword" });
        }
        grantAdmin = true;
      }

      const result = await createUser(username, password, {
        defaultCashoutWallet: cashoutWallet,
        recoveryEmail,
        isAdmin: grantAdmin
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Store the Helius API key for the new user (if provided, otherwise uses admin pool)
      if (result.userId && heliusApiKey) {
        try {
          await addUserApiKey(result.userId, "helius", heliusApiKey, "Helius API Key");
        } catch (keyError) {
          console.error("Failed to store API key:", keyError);
          return res.status(500).json({ error: "Account created but failed to store API key. Please add it in settings." });
        }
      }

      res.json({ success: true, isAdmin: grantAdmin, showWizard: grantAdmin, usingAdminPool: useAdminPool });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password, rememberMe } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }

      const result = await authenticateUser(username, password);
      if (!result.success || !result.userId) {
        return res.status(401).json({ error: result.error || "Invalid credentials" });
      }

      const token = createSession(result.userId, username, result.isAdmin ?? false, rememberMe === true);
      
      const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      res.cookie("session", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge,
      });

      res.json({ success: true, username });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies?.session;
    if (token) {
      destroySession(token);
    }
    res.clearCookie("session");
    res.json({ success: true });
  });

  // Rate limiting for password reset requests (simple in-memory)
  const resetAttempts = new Map<string, { count: number; lastAttempt: number }>();
  const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
  const MAX_RESET_ATTEMPTS = 3;

  // Request password reset
  app.post("/api/auth/request-reset", async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required" });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Rate limiting check
      const clientIp = req.ip || req.connection.remoteAddress || "unknown";
      const rateLimitKey = `${clientIp}:${normalizedEmail}`;
      const now = Date.now();
      const attempts = resetAttempts.get(rateLimitKey);
      
      if (attempts) {
        if (now - attempts.lastAttempt < RATE_LIMIT_WINDOW && attempts.count >= MAX_RESET_ATTEMPTS) {
          // Don't reveal rate limiting - same response as success
          return res.json({ success: true, message: "If an account with that email exists, a reset link has been sent." });
        }
        if (now - attempts.lastAttempt >= RATE_LIMIT_WINDOW) {
          resetAttempts.set(rateLimitKey, { count: 1, lastAttempt: now });
        } else {
          attempts.count++;
          attempts.lastAttempt = now;
        }
      } else {
        resetAttempts.set(rateLimitKey, { count: 1, lastAttempt: now });
      }

      // Find user by email (always return same response to prevent email enumeration)
      const user = await findUserByEmail(normalizedEmail);
      
      if (user) {
        const token = await createPasswordResetToken(user.userId);
        
        // Construct reset link using current host
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || "localhost:5000";
        const resetLink = `${protocol}://${host}/reset-password?token=${token}`;
        
        await sendPasswordResetEmail(normalizedEmail, resetLink, user.username);
      }

      // Always return success to prevent email enumeration
      res.json({ success: true, message: "If an account with that email exists, a reset link has been sent." });
    } catch (error) {
      console.error("Password reset request error:", error);
      // Still return success to prevent enumeration
      res.json({ success: true, message: "If an account with that email exists, a reset link has been sent." });
    }
  });

  // Validate reset token (for frontend to check before showing form)
  app.get("/api/auth/validate-reset-token", async (req, res) => {
    try {
      const { token } = req.query;
      
      if (!token || typeof token !== "string") {
        return res.status(400).json({ valid: false, error: "Token is required" });
      }

      const result = await validateResetToken(token);
      res.json(result);
    } catch (error) {
      console.error("Token validation error:", error);
      res.status(500).json({ valid: false, error: "Validation failed" });
    }
  });

  // Complete password reset
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      
      if (!token || typeof token !== "string") {
        return res.status(400).json({ success: false, error: "Token is required" });
      }
      
      if (!newPassword || typeof newPassword !== "string") {
        return res.status(400).json({ success: false, error: "New password is required" });
      }
      
      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
      }

      const result = await resetPassword(token, newPassword);
      
      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json({ success: true, message: "Password has been reset successfully" });
    } catch (error) {
      console.error("Password reset error:", error);
      res.status(500).json({ success: false, error: "Password reset failed" });
    }
  });

  // Get monitoring status
  app.get("/api/status", async (req, res) => {
    try {
      const status = await storage.getMonitoringStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  // Get SOL price in USD
  app.get("/api/sol-price", async (req, res) => {
    try {
      const { getSolPriceUsd } = await import("./jupiter");
      const price = await getSolPriceUsd();
      res.json({ price });
    } catch (error) {
      console.error("Failed to get SOL price:", error);
      res.status(500).json({ error: "Failed to get SOL price" });
    }
  });

  // Start monitoring
  app.post("/api/monitoring/start", async (req, res) => {
    try {
      const status = await storage.getMonitoringStatus();
      
      // Get all monitored wallet addresses from all users
      const allWallets = await storage.getAllMonitoredWallets();
      const walletAddresses = allWallets.map(w => w.walletAddress);
      
      if (walletAddresses.length === 0) {
        return res.status(400).json({ error: "No wallets to monitor. Add a wallet first." });
      }

      if (status.isActive && status.webhookId) {
        // Update existing webhook with current wallet list
        const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
        await updateWebhookUrl(status.webhookId, webhookUrl, walletAddresses);
        return res.json({ success: true, status });
      }

      const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
      console.log("Creating webhook with URL:", webhookUrl, "for", walletAddresses.length, "wallet(s)");
      const webhookId = await createWebhook(webhookUrl, walletAddresses);

      if (!webhookId) {
        return res.status(500).json({ error: "Failed to create webhook" });
      }

      const updatedStatus = await storage.updateMonitoringStatus({
        isActive: true,
        webhookId,
      });

      broadcastStatus(updatedStatus);
      res.json({ success: true, status: updatedStatus });
    } catch (error) {
      console.error("Error starting monitoring:", error);
      res.status(500).json({ error: "Failed to start monitoring" });
    }
  });

  // Stop monitoring
  app.post("/api/monitoring/stop", async (req, res) => {
    try {
      const status = await storage.getMonitoringStatus();
      
      if (status.webhookId) {
        await deleteWebhook(status.webhookId);
      }

      const updatedStatus = await storage.updateMonitoringStatus({
        isActive: false,
        webhookId: undefined,
      });

      broadcastStatus(updatedStatus);
      res.json({ success: true, status: updatedStatus });
    } catch (error) {
      console.error("Error stopping monitoring:", error);
      res.status(500).json({ error: "Failed to stop monitoring" });
    }
  });

  // Helius webhook endpoint with secret verification
  app.post("/api/webhook/helius", async (req, res) => {
    try {
      // Verify webhook secret
      const providedSecret = req.query.secret as string;
      if (providedSecret !== WEBHOOK_SECRET) {
        console.warn("Invalid webhook secret provided");
        return res.status(401).json({ error: "Unauthorized" });
      }

      console.log("Received webhook payload:", JSON.stringify(req.body, null, 2));
      
      const payloads: HeliusWebhookPayload[] = Array.isArray(req.body) ? req.body : [req.body];
      
      for (const payload of payloads) {
        // Validate payload structure
        const parseResult = heliusPayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          console.warn("Invalid webhook payload structure:", parseResult.error);
          continue;
        }

        // Extract wallet address that made the swap
        const swapWalletAddress = getSwapWalletAddress(payload);
        if (!swapWalletAddress) {
          console.log("Could not extract wallet address from swap");
          continue;
        }

        // Unified webhook routing: classify this event by address type
        const { routeWebhookEvent } = await import("./unified-webhook");
        const routing = routeWebhookEvent(swapWalletAddress);
        
        if (routing && routing.type === "whale_active") {
          // Whale wallet swap - extract price data and emit whale event
          const whaleParsed = parseSwapFromWebhook(payload);
          if (whaleParsed) {
            const whaleIsBuy = isBaseCurrency(whaleParsed.fromToken);
            const whaleTokenMint = whaleIsBuy ? whaleParsed.toToken : whaleParsed.fromToken;
            const whaleTokenSymbol = whaleIsBuy ? whaleParsed.toTokenSymbol : whaleParsed.fromTokenSymbol;
            
            console.log(`[UnifiedWebhook] Whale ${swapWalletAddress.slice(0,8)} ${whaleIsBuy ? 'bought' : 'sold'} ${whaleTokenSymbol || whaleTokenMint.slice(0,8)}`);
            
            // Update price from whale swap
            const { getSolPriceUsd } = await import("./jupiter");
            const solPriceWhale = await getSolPriceUsd();
            const baseAmtW = whaleIsBuy ? whaleParsed.fromAmount : whaleParsed.toAmount;
            const tokenAmtW = whaleIsBuy ? whaleParsed.toAmount : whaleParsed.fromAmount;
            if (tokenAmtW && tokenAmtW > 0 && baseAmtW && baseAmtW > 0 && solPriceWhale) {
              const priceSolW = baseAmtW / tokenAmtW;
              const priceUsdW = priceSolW * solPriceWhale;
              const { upsertTokenData } = await import("./data-pool");
              await upsertTokenData(whaleTokenMint, {
                tokenSymbol: whaleTokenSymbol || undefined,
                priceUsd: priceUsdW,
              }, 'whale_swap');
            }
            
            // Whale-sourced token discovery
            try {
              const { processWhaleTokenDiscovery, discoverNewWhalesFromToken } = await import("./whale-discovery");
              await processWhaleTokenDiscovery(
                swapWalletAddress,
                whaleTokenMint,
                whaleTokenSymbol || undefined,
                whaleIsBuy ? "buy" : "sell"
              );
              // Multi-hop: discover new whales from this token's holders
              if (whaleIsBuy) {
                discoverNewWhalesFromToken(whaleTokenMint, swapWalletAddress).catch(() => {});
              }
            } catch (_) {}
            
            // Emit whale discovery event for the event bus
            try {
              const { emit } = await import("./discovery-event-bus");
              await emit({
                type: whaleIsBuy ? "whale_buy" as any : "whale_sell" as any,
                tokenMint: whaleTokenMint,
                tokenSymbol: whaleTokenSymbol || undefined,
                source: "unified_webhook",
                data: {
                  walletAddress: swapWalletAddress,
                  action: whaleIsBuy ? "buy" : "sell",
                  fromAmount: whaleParsed.fromAmount,
                  toAmount: whaleParsed.toAmount,
                },
                timestamp: Date.now(),
                urgency: 7,
              });
            } catch (_) {}
          }
          continue; // Skip signal wallet processing
        }
        
        if (routing && (routing.type === "paper_position_token" || routing.type === "real_position_token")) {
          // Token mint swap event - extract price update only
          const tokenParsed = parseSwapFromWebhook(payload);
          if (tokenParsed) {
            const tokenIsBuy = isBaseCurrency(tokenParsed.fromToken);
            const trackedMint = tokenIsBuy ? tokenParsed.toToken : tokenParsed.fromToken;
            const trackedSymbol = tokenIsBuy ? tokenParsed.toTokenSymbol : tokenParsed.fromTokenSymbol;
            
            const { getSolPriceUsd } = await import("./jupiter");
            const solPriceToken = await getSolPriceUsd();
            const baseAmtT = tokenIsBuy ? tokenParsed.fromAmount : tokenParsed.toAmount;
            const tokenAmtT = tokenIsBuy ? tokenParsed.toAmount : tokenParsed.fromAmount;
            
            if (tokenAmtT && tokenAmtT > 0 && baseAmtT && baseAmtT > 0 && solPriceToken) {
              const priceUsdT = (baseAmtT / tokenAmtT) * solPriceToken;
              const { upsertTokenData } = await import("./data-pool");
              await upsertTokenData(trackedMint, {
                tokenSymbol: trackedSymbol || undefined,
                priceUsd: priceUsdT,
              }, 'position_swap');
              
              console.log(`[UnifiedWebhook] Price update for ${routing.type} ${trackedSymbol || trackedMint.slice(0,8)}: $${priceUsdT.toFixed(10)}`);
            }
          }
          continue; // Skip signal wallet processing
        }

        // Look up which user is monitoring this wallet (only enabled wallets)
        const userId = await storage.getUserIdByWalletAddress(swapWalletAddress);
        if (!userId) {
          console.log("No user monitoring wallet:", swapWalletAddress);
          continue;
        }

        // Check if we already processed this transaction for this user
        const existing = await storage.getSwapBySignature(payload.signature, userId);
        if (existing) {
          console.log("Swap already processed for user:", userId, payload.signature);
          continue;
        }

        const swap = parseSwapFromWebhook(payload);
        if (!swap) {
          console.log("Not a swap transaction:", payload.type);
          continue;
        }

        // Associate swap with user
        swap.userId = userId;

        // Fetch token metadata for the token being bought and update symbols
        const toTokenMetadata = await fetchTokenMetadata(swap.toToken);
        if (toTokenMetadata) {
          swap.toTokenMetadata = toTokenMetadata;
          if (toTokenMetadata.symbol && (swap.toTokenSymbol === "???" || swap.toTokenSymbol?.includes("..."))) {
            swap.toTokenSymbol = toTokenMetadata.symbol;
          }
          console.log("Token metadata fetched:", toTokenMetadata.symbol, "MC:", toTokenMetadata.marketCap);
        }
        
        // Also fetch metadata for fromToken if it's not a base currency (SOL/USDC/USDT)
        if (!isBaseCurrency(swap.fromToken) && (swap.fromTokenSymbol === "???" || swap.fromTokenSymbol?.includes("..."))) {
          const fromTokenMetadata = await fetchTokenMetadata(swap.fromToken);
          if (fromTokenMetadata?.symbol) {
            swap.fromTokenSymbol = fromTokenMetadata.symbol;
          }
        }

        // Get cached SOL price for historical USD value (uses cache, no extra API call)
        const { getSolPriceUsd } = await import("./jupiter");
        const solPrice = await getSolPriceUsd();
        swap.solPriceAtTrade = solPrice;

        const savedSwap = await storage.addSwap(swap);
        console.log("Swap detected and saved:", savedSwap.id, "for user:", userId);

        // Wrap all post-swap processing in try/catch to capture errors
        try {
          // Store swap-derived price in tokenDataPool (primary price source)
          const isBuy = isBaseCurrency(swap.fromToken);
          const swapTokenMint = isBuy ? swap.toToken : swap.fromToken;
          const swapTokenSymbol = isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol;

          if (isBuy) {
            try {
              const { emit } = await import("./discovery-event-bus");
              await emit({
                type: "signal_buy",
                tokenMint: swapTokenMint,
                tokenSymbol: swapTokenSymbol || undefined,
                source: "swap_webhook",
                data: {
                  walletAddress: swapWalletAddress,
                  fromAmount: swap.fromAmount,
                  toAmount: swap.toAmount,
                  solPriceAtTrade: swap.solPriceAtTrade,
                },
                timestamp: Date.now(),
                urgency: 6,
              });
            } catch (_) {}
          }
          const baseAmount = isBuy ? swap.fromAmount : swap.toAmount; // SOL/USDC amount
          const tokenAmount = isBuy ? swap.toAmount : swap.fromAmount;
          
          if (tokenAmount && tokenAmount > 0 && baseAmount && baseAmount > 0 && solPrice) {
            const pricePerTokenSol = baseAmount / tokenAmount;
            const pricePerTokenUsd = pricePerTokenSol * solPrice;
            
            // Store in tokenDataPool as primary price source
            const { upsertTokenData, getTokenData } = await import("./data-pool");
            
            // Check for price discrepancy against cached DexScreener price (>10% difference)
            const cachedData = await getTokenData(swapTokenMint);
            if (cachedData?.priceUsd && cachedData.priceSource === 'dexscreener_batch') {
              const discrepancyPercent = Math.abs((pricePerTokenUsd - cachedData.priceUsd) / cachedData.priceUsd) * 100;
              if (discrepancyPercent > 10) {
                console.error(`[Price Discrepancy] ${swapTokenSymbol}: Swap price $${pricePerTokenUsd.toFixed(10)} differs from DexScreener $${cachedData.priceUsd.toFixed(10)} by ${discrepancyPercent.toFixed(1)}%`);
                logError("price_monitor", "discrepancy", `${swapTokenSymbol} price discrepancy: ${discrepancyPercent.toFixed(1)}%`, {
                  tokenMint: swapTokenMint,
                  swapPriceUsd: pricePerTokenUsd,
                  dexscreenerPriceUsd: cachedData.priceUsd,
                  discrepancyPercent,
                }).catch(() => {});
              }
            }
            
            await upsertTokenData(swapTokenMint, {
              tokenSymbol: swapTokenSymbol || undefined,
              tokenName: swap.toTokenMetadata?.name || undefined,
              priceUsd: pricePerTokenUsd,
            }, 'swap');
            
            console.log(`[Swap Price] ${swapTokenSymbol}: $${pricePerTokenUsd.toFixed(10)} (${pricePerTokenSol.toFixed(10)} SOL)`);
          }

          // Log that we're starting post-swap processing (fail-safe)
          logInfo("webhook", "post_swap_start", `Processing swap ${savedSwap.id} for user ${userId}`, {
            swapId: savedSwap.id,
            walletAddress: swapWalletAddress,
            fromToken: swap.fromTokenSymbol,
            toToken: swap.toTokenSymbol,
          }, userId).catch(() => {});

        // Log token event for AI tracking
        const isBuyEvent = isBaseCurrency(swap.fromToken);
        const tokenMint = isBuyEvent ? swap.toToken : swap.fromToken;
        const tokenSymbol = isBuyEvent ? swap.toTokenSymbol || "???" : swap.fromTokenSymbol || "???";
        const eventType = isBuyEvent ? "signal_buy" : "signal_sell";
        const eventTitle = isBuyEvent 
          ? `Signal wallet bought ${tokenSymbol}` 
          : `Signal wallet sold ${tokenSymbol}`;
        
        logTokenEvent(tokenMint, tokenSymbol, eventType, eventTitle, {
          description: `From: ${swap.fromTokenSymbol} (${swap.fromAmount}) → To: ${swap.toTokenSymbol} (${swap.toAmount})`,
          priority: "normal",
          metadata: { 
            signature: swap.signature,
            walletAddress: swapWalletAddress,
            userId,
          },
          valueUsd: swap.solPriceAtTrade && swap.fromAmount 
            ? swap.fromAmount * swap.solPriceAtTrade 
            : undefined,
          relatedWallet: swapWalletAddress,
        }).catch(err => console.error("[logTokenEvent] Error:", err));

        // Broadcast to WebSocket clients
        broadcastSwap(savedSwap);

        // Whale detection: Check if the swapper is in top 100 holders of the token
        // For BUYs (SOL/USDC -> Token), check the toToken; for SELLs (Token -> SOL/USDC), check the fromToken
        // Use mint-based detection for robustness (doesn't depend on symbol mapping)
        // Note: isBuy is already defined above for swap price persistence
        const tokenForWhaleCheck = isBuy ? swap.toToken : swap.fromToken;
        let whaleCheck = isWalletInTop100(tokenForWhaleCheck, swapWalletAddress);
        
        // If cache is empty, try to populate it first then check again
        if (!whaleCheck.found) {
          const holderCache = await getHoldersCached(tokenForWhaleCheck, true);
          if (holderCache && holderCache.holders.length > 0) {
            whaleCheck = isWalletInTop100(tokenForWhaleCheck, swapWalletAddress);
          }
        }
        
        if (whaleCheck.found && whaleCheck.rank) {
          const tier = getHolderTier(whaleCheck.rank);
          const action = isBuy ? "BUY" : "SELL";
          console.log(`Whale activity detected: Rank #${whaleCheck.rank} (${tier}) ${action} on ${swap.toTokenSymbol || swap.fromTokenSymbol}`);
          
          // Log whale activity token event
          const whaleTokenSymbol = isBuy ? swap.toTokenSymbol || "???" : swap.fromTokenSymbol || "???";
          logTokenEvent(tokenForWhaleCheck, whaleTokenSymbol, "whale_activity", `Whale (#${whaleCheck.rank}) ${action.toLowerCase()}`, {
            description: `${tier} holder (rank #${whaleCheck.rank}) ${action.toLowerCase()} ${whaleTokenSymbol}`,
            priority: whaleCheck.rank <= 10 ? "high" : "normal",
            metadata: {
              rank: whaleCheck.rank,
              tier,
              action: action.toLowerCase(),
              holdPercent: whaleCheck.percent,
              walletAddress: swapWalletAddress,
            },
            relatedWallet: swapWalletAddress,
          }).catch(err => console.error("[logTokenEvent] Whale error:", err));
          
          // Trigger holder refresh for this token since we just saw whale activity
          triggerHolderRefresh(tokenForWhaleCheck);
          
          // Update position scores for this token due to whale activity
          updateScoreOnWhaleActivity(tokenForWhaleCheck).catch(err => 
            console.error(`[PositionScore] Error updating scores on whale activity:`, err)
          );
          
          // Record whale activity for familiar whale tracking
          recordWhaleActivity({
            walletAddress: swapWalletAddress,
            tokenMint: tokenForWhaleCheck,
            tokenSymbol: isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol,
            action: isBuy ? "buy" : "sell",
            rank: whaleCheck.rank,
            priceUsd: undefined, // Would need DexScreener price here
            marketCap: undefined,
          }).then(alert => {
            if (alert && wss) {
              const familiarWhaleEvent = {
                type: "FAMILIAR_WHALE",
                tokenMint: tokenForWhaleCheck,
                tokenSymbol: isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol,
                walletAddress: swapWalletAddress,
                isKnownSuccessful: alert.isKnownSuccessful,
                successRate: alert.successRate,
                tokensTraded: alert.tokensTraded,
                message: alert.message,
                timestamp: Date.now(),
              };
              const msg = JSON.stringify(familiarWhaleEvent);
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(msg);
                }
              });
              console.log(`[FamiliarWhale] Alert: ${alert.message}`);
            }
          }).catch(err => console.error("[FamiliarWhale] Error:", err));
          
          // Broadcast whale event to connected clients
          if (wss) {
            const whaleEvent = {
              type: "WHALE_ACTIVITY",
              tokenMint: tokenForWhaleCheck,
              tokenSymbol: isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol,
              walletAddress: swapWalletAddress,
              action,
              rank: whaleCheck.rank,
              tier,
              holdPercent: whaleCheck.percent,
              timestamp: Date.now(),
            };
            const msg = JSON.stringify(whaleEvent);
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
              }
            });
          }
          
          // Send Telegram whale alert (reuse whaleTokenSymbol from above)
          sendTelegramWhaleAlert(userId, {
            tokenSymbol: whaleTokenSymbol,
            tokenMint: tokenForWhaleCheck,
            whaleAddress: swapWalletAddress,
            tier: tier as "top10" | "top50" | "top100",
            action: action.toLowerCase() as "buy" | "sell",
            amount: swap.toAmount,
          }).catch(err => console.error("Telegram whale alert error:", err));
        }
        
        // Emerging whale detection: Check if this BUY would make someone a top-10 holder
        if (isBuy && swap.toAmount) {
          const emergingCheck = checkEmergingWhale(swap.toToken, swap.toAmount, swapWalletAddress);
          if (emergingCheck.isEmergingWhale && emergingCheck.wouldBeRank) {
            console.log(`Emerging whale detected: Potential rank #${emergingCheck.wouldBeRank} holder for ${swap.toTokenSymbol} (bought ${swap.toAmount} tokens)`);
            
            // Trigger holder refresh to update the list
            triggerHolderRefresh(swap.toToken);
            
            // Broadcast NEW_TOP_HOLDER event
            if (wss) {
              const newTopHolderEvent = {
                type: "NEW_TOP_HOLDER",
                tokenMint: swap.toToken,
                tokenSymbol: swap.toTokenSymbol,
                walletAddress: swapWalletAddress,
                potentialRank: emergingCheck.wouldBeRank,
                tokensAcquired: swap.toAmount,
                top10Threshold: emergingCheck.top10Threshold,
                timestamp: Date.now(),
              };
              const msg = JSON.stringify(newTopHolderEvent);
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(msg);
                }
              });
            }
            
            // Send Telegram emerging whale alert
            sendTelegramWhaleAlert(userId, {
              tokenSymbol: swap.toTokenSymbol,
              tokenMint: swap.toToken,
              whaleAddress: swapWalletAddress,
              tier: "top10",
              action: "buy",
              amount: swap.toAmount,
              isEmergingWhale: true,
            }).catch(err => console.error("Telegram emerging whale alert error:", err));
          }
        }

        // Send email notification to user's recipients
        const settings = await storage.getNotificationSettings(userId);
        if (settings.enabled) {
          const minAmount = settings.minSwapAmount ?? 0;
          if (savedSwap.fromAmount >= minAmount) {
            const allEmails = settings.emails?.length ? settings.emails : [settings.email];
            // Use user's Resend API key if available, otherwise fall back to system default
            const userResendKey = await getUserResendApiKey(userId);
            const sent = await sendSwapNotification(savedSwap, allEmails, userResendKey ?? undefined);
            if (sent) {
              await storage.markSwapNotified(savedSwap.id);
              console.log("Notification sent for swap:", savedSwap.id, "to", allEmails.length, "recipients", userResendKey ? "(using user's Resend key)" : "(using system default)");
            }
          }
        }

        // Get the monitored wallet details (used for alerts and copy trading)
        const sourceWallet = await storage.getMonitoredWalletByAddress(swapWalletAddress);
        
        // Check if user has a position for this token (for sell button context)
        const tokenMintForAlert = isBuy ? swap.toToken : swap.fromToken;
        const userHasPosition = await db.select({ id: holdings.id }).from(holdings)
          .where(and(
            eq(holdings.userId, userId),
            eq(holdings.tokenMint, tokenMintForAlert),
            eq(holdings.reclaimed, false)
          ))
          .limit(1);
        
        // Send Telegram activity alert with actionable buttons
        console.log(`[Webhook] Sending Telegram activity alert for user ${userId}...`);
        logInfo("webhook", "telegram_alert_attempt", `Sending Telegram alert for ${swap.toTokenSymbol || swap.fromTokenSymbol}`, {
          walletLabel: sourceWallet?.label,
          tokenSymbol: isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol,
          type: isBuy ? "buy" : "sell",
        }, userId).catch(() => {});
        
        sendTelegramActivityAlert(userId, {
          walletLabel: sourceWallet?.label || "Wallet",
          walletAddress: swapWalletAddress,
          tokenSymbol: isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol,
          tokenMint: tokenMintForAlert,
          type: isBuy ? "buy" : "sell",
          amount: isBuy ? swap.toAmount : swap.fromAmount,
          solAmount: isBuy ? swap.fromAmount : swap.toAmount,
          priceUsd: toTokenMetadata?.priceUsd,
          walletId: sourceWallet?.id,
          hasPosition: userHasPosition.length > 0,
        }).catch(err => console.error("Telegram activity alert error:", err));

        // Copy trading: Queue pending buy if this is a BUY (SOL/USDC -> Token)
        // Per-wallet copy trading - no global toggle required
        const walletCopyEnabled = sourceWallet?.copyTradeEnabled === true;
        
        // Skip stablecoin swaps (SOL -> USDC or USDC -> SOL)
        // These are cash-out operations, not token buys
        const isStablecoinSwap = isBaseCurrency(swap.fromToken) && isBaseCurrency(swap.toToken);
        
        // Build copy settings for logging
        const copySettingsForLog = sourceWallet ? {
          copyTradeEnabled: sourceWallet.copyTradeEnabled ?? false,
          copyMirrorBuys: sourceWallet.copyMirrorBuys,
          copyMirrorSells: sourceWallet.copyMirrorSells,
          copyBuyType: sourceWallet.copyBuyType || undefined,
          copyBuyAmount: sourceWallet.copyBuyAmount || undefined,
          dedupSkipIfHolding: sourceWallet.dedupSkipIfHolding ?? true,
          dedupSkipIfEverHeld: sourceWallet.dedupSkipIfEverHeld ?? false,
          dedupSkipIfPending: sourceWallet.dedupSkipIfPending ?? true,
          dedupFirstBuyOnly: sourceWallet.dedupFirstBuyOnly ?? false,
          dedupCrossSignalPrevention: sourceWallet.dedupCrossSignalPrevention ?? false,
        } : {
          copyTradeEnabled: false,
          copyMirrorBuys: null,
          copyMirrorSells: null,
        };
        
        // Log copy trading decision for debugging
        console.log(`[CopyTrade] Swap detected: ${isBuy ? 'BUY' : 'SELL'} ${swap.toTokenSymbol || swap.toToken.slice(0,8)} | walletCopyEnabled=${walletCopyEnabled} | wallet=${sourceWallet?.label || swapWalletAddress.slice(0,8)}${isStablecoinSwap ? ' | STABLECOIN_SWAP' : ''}`);
        
        // Update signal cumulative tracking for proportional mirror sells
        if (sourceWallet && !isStablecoinSwap) {
          const tokenForTracking = isBuy ? swap.toToken : swap.fromToken;
          const tokenSymbolForTracking = isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol;
          const tokenAmount = isBuy ? (swap.toAmount || 0) : (swap.fromAmount || 0);
          const solValue = isBuy ? (swap.fromAmount || 0) : (swap.toAmount || 0);
          
          updateSignalCumulativeTracking(
            userId,
            sourceWallet.id,
            tokenForTracking,
            tokenSymbolForTracking,
            isBuy ? "buy" : "sell",
            tokenAmount,
            solValue,
            payload.signature
          ).catch(err => console.error("[SignalTracking] Error:", err));
        }
        
        // Check token blacklist before copy trading
        const tokenForBlacklistCheck = swap.toToken;
        const isBlacklisted = await isTokenBlacklisted(userId, tokenForBlacklistCheck);
        
        // Calculate source trade USD value for filtering and logging
        const sourceTradeUsd = toTokenMetadata?.priceUsd && swap.toAmount 
          ? parseFloat(swap.toAmount) * toTokenMetadata.priceUsd 
          : undefined;
        const signalAmountSol = isBuy ? (swap.fromAmount ? parseFloat(swap.fromAmount) : undefined) : (swap.toAmount ? parseFloat(swap.toAmount) : undefined);
        
        // Build base log details for all decision paths
        const baseLogDetails = {
          userId,
          signalWalletId: sourceWallet?.id || 0,
          signalWalletLabel: sourceWallet?.label || swapWalletAddress.slice(0,8),
          tokenMint: swap.toToken,
          tokenSymbol: swap.toTokenSymbol || undefined,
          swapType: isBuy ? "buy" as const : "sell" as const,
          signalAmountSol,
          signalAmountUsd: sourceTradeUsd,
          copySettings: copySettingsForLog,
          checks: {
            isStablecoinSwap,
            isBlacklisted,
          },
        };
        
        // Per-wallet copy trading enabled check (skip stablecoin swaps and blacklisted tokens)
        if (!isBuy) {
          // Log sell transactions (not processed for initial copy)
          logCopyTradeDecision("skipped_sell", baseLogDetails).catch(() => {});
        } else if (!walletCopyEnabled) {
          // Log disabled wallet
          logCopyTradeDecision("skipped_disabled", baseLogDetails).catch(() => {});
        } else if (isStablecoinSwap) {
          // Log stablecoin swap
          logCopyTradeDecision("skipped_stablecoin", baseLogDetails).catch(() => {});
        } else if (isBlacklisted) {
          // Log blacklisted token
          logCopyTradeDecision("skipped_blacklist", baseLogDetails).catch(() => {});
        } else if (walletCopyEnabled && isBuy && !isStablecoinSwap && !isBlacklisted) {
            // Build per-wallet copy config
            const walletCopyConfig = sourceWallet ? {
              copyBuyType: sourceWallet.copyBuyType || undefined,
              copyBuyAmount: sourceWallet.copyBuyAmount || undefined,
              copyMinBalance: sourceWallet.copyMinBalance || undefined,
              copyMinTradeUsd: sourceWallet.copyMinTradeUsd || undefined,
              copyScoreThreshold: sourceWallet.copyScoreThreshold || undefined,
              copyTiming: sourceWallet.copyTiming || undefined,
              copyDelayMinutes: sourceWallet.copyDelayMinutes || undefined,
              copyAutoMirror: sourceWallet.copyAutoMirror || undefined,
              dedupSkipIfHolding: sourceWallet.dedupSkipIfHolding ?? true,
              dedupSkipIfEverHeld: sourceWallet.dedupSkipIfEverHeld ?? false,
              dedupSkipIfPending: sourceWallet.dedupSkipIfPending ?? true,
            } : undefined;
            
            console.log(`[CopyTrade] Attempting to queue pending buy for ${swap.toTokenSymbol || swap.toToken.slice(0,8)}...`);
            
            const pendingBuy = await addPendingBuy(
              userId,
              swap.toToken,
              swap.toTokenSymbol,
              toTokenMetadata?.name,
              toTokenMetadata?.priceUsd,
              toTokenMetadata?.liquidity,
              {
                swapId: savedSwap.id,
                walletAddress: swapWalletAddress,
                walletLabel: sourceWallet?.label || undefined,
                signalWalletId: sourceWallet?.id,
              },
              walletCopyConfig,
              sourceTradeUsd,
              undefined // tokenAiScore - will be determined later
            );
            if (pendingBuy) {
              console.log(`[CopyTrade] SUCCESS: Queued pending buy for ${swap.toTokenSymbol} for user ${userId} from wallet ${sourceWallet?.label || swapWalletAddress}`);
              logCopyTradeDecision("queued", baseLogDetails).catch(() => {});
            } else {
              console.log(`[CopyTrade] SKIPPED: addPendingBuy returned null (check trade_logs for specific reason)`);
              // addPendingBuy logs the specific skip reason (dedup, score, balance, etc.)
            }
        }
        
        // Get trade config for other settings (budget limits, timing, etc.)
        const tradeConf = await getTradeConfig(userId);
        
        // Auto-mirror logic: Check if signal wallet is trading a token we already hold from them
        // Uses per-wallet copyTradeEnabled setting, not global toggle
        if (sourceWallet && walletCopyEnabled) {
          const tokenMint = isBuy ? swap.toToken : swap.fromToken;
          
          // Look for existing positions from this signal wallet
          const existingPositions = await db.select().from(holdings)
            .where(
              and(
                eq(holdings.userId, userId),
                eq(holdings.tokenMint, tokenMint),
                eq(holdings.signalWalletId, sourceWallet.id)
              )
            );
          
          for (const position of existingPositions) {
            if (position.currentAmount <= 0) continue;
            
            // Use copyMirrorBuys if set, else fall back to legacy copyAutoMirror
            const mirrorBuysEnabled = sourceWallet.copyMirrorBuys ?? sourceWallet.copyAutoMirror ?? false;
            if (isBuy && mirrorBuysEnabled) {
              // Auto-mirror BUY: Signal wallet is buying more of a token we already hold from them
              // Top up our position proportionally (add to pending buy instead of immediate)
              console.log(`Auto-mirror BUY detected: ${sourceWallet.label} bought more ${swap.toTokenSymbol}, we already hold from this signal`);
              
              // Queue a top-up buy using existing pending buy logic
              // The position manager will handle it as a top-up
              const walletCopyConfig = {
                copyBuyType: sourceWallet.copyBuyType || undefined,
                copyBuyAmount: sourceWallet.copyBuyAmount || undefined,
                copyMinBalance: sourceWallet.copyMinBalance || undefined,
                copyMinTradeUsd: sourceWallet.copyMinTradeUsd || undefined,
                copyScoreThreshold: sourceWallet.copyScoreThreshold || undefined,
                copyTiming: sourceWallet.copyTiming || undefined,
                copyDelayMinutes: sourceWallet.copyDelayMinutes || undefined,
                copyAutoMirror: true,
                dedupSkipIfHolding: false, // Allow top-ups
                dedupSkipIfEverHeld: false,
                dedupSkipIfPending: true,
              };
              
              const sourceTradeUsd = toTokenMetadata?.priceUsd && swap.toAmount 
                ? parseFloat(swap.toAmount) * toTokenMetadata.priceUsd 
                : undefined;
              
              await addPendingBuy(
                userId,
                swap.toToken,
                swap.toTokenSymbol,
                toTokenMetadata?.name,
                toTokenMetadata?.priceUsd,
                toTokenMetadata?.liquidity,
                {
                  swapId: savedSwap.id,
                  walletAddress: swapWalletAddress,
                  walletLabel: sourceWallet.label || undefined,
                  signalWalletId: sourceWallet.id,
                },
                walletCopyConfig,
                sourceTradeUsd,
                undefined
              );
              console.log(`Auto-mirror: Queued top-up buy for ${swap.toTokenSymbol}`);
              
            } else if (!isBuy) {
              // Signal wallet is selling this token - update position scores
              // Mark this signal wallet as having sold, which affects position scoring
              const tokenMintForSell = swap.fromToken;
              try {
                const markedCount = await markSignalWalletSold(sourceWallet.id, tokenMintForSell);
                if (markedCount > 0) {
                  console.log(`[PositionScore] Marked ${markedCount} positions as signal wallet sold for ${swap.fromTokenSymbol}`);
                }
              } catch (error) {
                console.error(`[PositionScore] Error marking signal wallet sold:`, error);
              }
              
              // Use copyMirrorSells if set, else fall back to legacy copyAutoMirror
              const mirrorSellsEnabled = sourceWallet.copyMirrorSells ?? sourceWallet.copyAutoMirror ?? false;
              if (position.autoMirrorSells && mirrorSellsEnabled) {
                // Auto-mirror SELL: Signal wallet is selling a token we hold from them
                // Mirror proportionally based on signal wallet's original buy vs current sell
                console.log(`Auto-mirror SELL detected: ${sourceWallet.label} sold ${swap.fromTokenSymbol}, mirroring for position ${position.id}`);
                
                // Get the original swap that triggered our copy trade
                let signalOriginalBuyAmount: number | null = null;
                if (position.sourceSwapId) {
                  const [sourceSwap] = await db.select().from(swaps)
                    .where(eq(swaps.id, position.sourceSwapId))
                    .limit(1);
                  if (sourceSwap && sourceSwap.toAmount) {
                    signalOriginalBuyAmount = sourceSwap.toAmount;
                  }
                }
                
                const sellAmountTokens = parseFloat(swap.fromAmount?.toString() || "0");
                
                // Calculate sell percentage: what % of their original position did they sell?
                let sellPercent = 100; // Default to full sell
                if (signalOriginalBuyAmount && signalOriginalBuyAmount > 0 && sellAmountTokens > 0) {
                  // sellPercent = (tokens they're selling / tokens they originally bought) * 100
                  sellPercent = Math.min(100, Math.max(10, (sellAmountTokens / signalOriginalBuyAmount) * 100));
                  console.log(`Auto-mirror: Signal sold ${sellAmountTokens.toLocaleString()} of ${signalOriginalBuyAmount.toLocaleString()} original tokens (${sellPercent.toFixed(1)}%)`);
                } else {
                  console.log(`Auto-mirror: No original buy data, defaulting to 100% sell`);
                }
                
                try {
                  const { executeAutoMirrorSell } = await import("./price-monitor");
                  await executeAutoMirrorSell(
                    userId,
                    position,
                    sellPercent,
                    `Signal wallet ${sourceWallet.label} sold ${sellPercent.toFixed(0)}%`
                  );
                  console.log(`Auto-mirror: Executed ${sellPercent.toFixed(1)}% sell for ${position.tokenSymbol}`);
                } catch (error) {
                  console.error(`Auto-mirror sell failed for ${position.tokenSymbol}:`, error);
                }
              }
            }
          }
        }

        } catch (postSwapError) {
          // Log any error that occurs during post-swap processing
          console.error("[Webhook] Post-swap processing error:", postSwapError);
          const errorMsg = postSwapError instanceof Error ? postSwapError.message : String(postSwapError);
          try {
            const errorObj = postSwapError instanceof Error 
              ? postSwapError 
              : new Error(String(postSwapError));
            // Log to legacy system logs
            await logError("webhook", "post_swap_error", errorObj, {
              swapId: savedSwap.id,
              walletAddress: swapWalletAddress,
              fromToken: swap.fromTokenSymbol,
              toToken: swap.toTokenSymbol,
            }, userId);
            // Log to dedicated error logs
            await logErrorToTable("webhook", "post_swap_error", "unknown", errorMsg, {
              userId,
              context: { swapId: savedSwap.id, walletAddress: swapWalletAddress },
            });
          } catch (logErr) {
            console.error("[Webhook] Failed to log error:", logErr);
          }
          // Continue processing other webhooks even if one fails
        }

        // Update status
        const status = await storage.getMonitoringStatus();
        broadcastStatus(status);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error processing webhook:", error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Log to legacy system logs
      logError("webhook", "process_webhook", error instanceof Error ? error : new Error(String(error)), {
        body: req.body ? JSON.stringify(req.body).slice(0, 500) : undefined,
      }).catch(() => {});
      // Log to dedicated error logs
      logErrorToTable("webhook", "process_webhook", "unknown", errorMsg, {
        context: { body: req.body ? JSON.stringify(req.body).slice(0, 200) : undefined },
      }).catch(() => {});
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Get all swaps
  app.get("/api/swaps", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const swaps = await storage.getSwaps(req.userId!);
      res.json(swaps);
    } catch (error) {
      res.status(500).json({ error: "Failed to get swaps" });
    }
  });

  // Get notification settings
  app.get("/api/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const settings = await storage.getNotificationSettings(req.userId!);
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  // Update notification settings with validation
  app.patch("/api/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parseResult = updateSettingsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid settings data", 
          details: parseResult.error.flatten() 
        });
      }

      const settings = await storage.updateNotificationSettings(req.userId!, parseResult.data);
      res.json(settings);
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Get email provider settings
  app.get("/api/settings/email-provider", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const [user] = await db.select({
        emailProvider: users.emailProvider,
        emailFromAddress: users.emailFromAddress,
        hasApiKey: users.emailApiKey,
      }).from(users).where(eq(users.id, req.userId!));
      
      res.json({
        emailProvider: user?.emailProvider || null,
        emailFromAddress: user?.emailFromAddress || null,
        hasApiKey: !!user?.hasApiKey
      });
    } catch (error) {
      console.error("Error getting email provider:", error);
      res.status(500).json({ error: "Failed to get email provider" });
    }
  });

  // Update email provider settings for alerts
  app.post("/api/settings/email-provider", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { emailProvider, emailApiKey, emailFromAddress, smtpConfig } = req.body;
      
      if (emailProvider && !["resend", "sendgrid", "mailgun", "smtp"].includes(emailProvider)) {
        return res.status(400).json({ error: "Invalid email provider" });
      }
      
      if (emailProvider === "smtp" && smtpConfig) {
        if (!smtpConfig.host || !smtpConfig.port) {
          return res.status(400).json({ error: "SMTP requires host and port" });
        }
      }
      
      const [updated] = await db.update(users)
        .set({
          emailProvider: emailProvider || null,
          emailApiKey: emailApiKey || null,
          emailFromAddress: emailFromAddress || null,
          smtpConfig: smtpConfig || null
        })
        .where(eq(users.id, req.userId!))
        .returning();
      
      // Clear email service cache for this user
      const { EmailService } = await import("./email-service");
      EmailService.clearCache(req.userId!);
      
      res.json({ success: true, emailProvider: updated.emailProvider });
    } catch (error) {
      console.error("Error updating email provider:", error);
      res.status(500).json({ error: "Failed to update email provider" });
    }
  });

  // ==================== Security Settings Routes ====================

  // Get security settings
  app.get("/api/settings/security", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const [user] = await db.select({
        withdrawalPinHash: users.withdrawalPinHash,
        pinMode: users.pinMode,
        pinThresholdUsd: users.pinThresholdUsd,
        dailySpendLimitUsd: users.dailySpendLimitUsd,
        withdrawalWhitelist: users.withdrawalWhitelist,
        telegramConfirmLargeTransfers: users.telegramConfirmLargeTransfers,
        largeTransferThresholdUsd: users.largeTransferThresholdUsd,
      }).from(users).where(eq(users.id, req.userId!));
      
      res.json({
        hasPinSet: !!user?.withdrawalPinHash,
        pinMode: user?.pinMode || "withdrawals_only",
        pinThresholdUsd: user?.pinThresholdUsd || 100,
        dailySpendLimitUsd: user?.dailySpendLimitUsd || null,
        withdrawalWhitelist: (user?.withdrawalWhitelist as string[]) || [],
        telegramConfirmLargeTransfers: user?.telegramConfirmLargeTransfers || false,
        largeTransferThresholdUsd: user?.largeTransferThresholdUsd || 500,
      });
    } catch (error) {
      console.error("Error getting security settings:", error);
      res.status(500).json({ error: "Failed to get security settings" });
    }
  });

  // Update security settings (except PIN)
  app.post("/api/settings/security", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { 
        pinMode, 
        pinThresholdUsd, 
        dailySpendLimitUsd, 
        withdrawalWhitelist,
        telegramConfirmLargeTransfers,
        largeTransferThresholdUsd
      } = req.body;
      
      if (pinMode && !["withdrawals_only", "all_trades", "threshold"].includes(pinMode)) {
        return res.status(400).json({ error: "Invalid PIN mode" });
      }
      
      await db.update(users)
        .set({
          pinMode: pinMode || "withdrawals_only",
          pinThresholdUsd: pinThresholdUsd ?? 100,
          dailySpendLimitUsd: dailySpendLimitUsd === 0 ? 0 : (dailySpendLimitUsd || null),
          withdrawalWhitelist: withdrawalWhitelist || [],
          telegramConfirmLargeTransfers: telegramConfirmLargeTransfers || false,
          largeTransferThresholdUsd: largeTransferThresholdUsd ?? 500,
        })
        .where(eq(users.id, req.userId!));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating security settings:", error);
      res.status(500).json({ error: "Failed to update security settings" });
    }
  });

  // Set PIN
  app.post("/api/settings/security/set-pin", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { pin } = req.body;
      
      if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
        return res.status(400).json({ error: "PIN must be 4-6 digits" });
      }
      
      // Hash the PIN using PBKDF2 (same pattern as password hashing)
      const { scryptSync, randomBytes } = await import("crypto");
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(pin, salt, 64).toString("hex");
      const pinHash = `${salt}:${hash}`;
      
      await db.update(users)
        .set({ withdrawalPinHash: pinHash })
        .where(eq(users.id, req.userId!));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error setting PIN:", error);
      res.status(500).json({ error: "Failed to set PIN" });
    }
  });

  // Verify PIN (used by AI tools before executing sensitive actions)
  app.post("/api/settings/security/verify-pin", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { pin } = req.body;
      
      const [user] = await db.select({ withdrawalPinHash: users.withdrawalPinHash })
        .from(users).where(eq(users.id, req.userId!));
      
      if (!user?.withdrawalPinHash) {
        return res.json({ valid: true, noPinSet: true }); // No PIN required
      }
      
      if (!pin) {
        return res.json({ valid: false, pinRequired: true });
      }
      
      // Verify PIN using timing-safe comparison
      const { scryptSync, timingSafeEqual } = await import("crypto");
      const [salt, storedHash] = user.withdrawalPinHash.split(":");
      const hash = scryptSync(pin, salt, 64);
      const storedHashBuffer = Buffer.from(storedHash, "hex");
      const valid = timingSafeEqual(hash, storedHashBuffer);
      
      res.json({ valid, pinRequired: true });
    } catch (error) {
      console.error("Error verifying PIN:", error);
      res.status(500).json({ error: "Failed to verify PIN" });
    }
  });

  // Execute pending trade with PIN verification (direct endpoint, bypasses AI)
  app.post("/api/trade/execute-pending", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { pin } = req.body;
      const { executePendingTradeWithPin } = await import("./ai");
      
      const result = await executePendingTradeWithPin(req.userId!, pin);
      
      if (result.pinRequired) {
        return res.json({ 
          success: false, 
          pinRequired: true,
          description: result.description 
        });
      }
      
      res.json({ 
        success: result.success, 
        message: result.message 
      });
    } catch (error) {
      console.error("Error executing trade:", error);
      res.status(500).json({ error: "Failed to execute trade" });
    }
  });

  // Get user's monitored wallet addresses
  app.get("/api/wallet", requireAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.userId!;
    const wallets = await storage.getMonitoredWallets(userId);
    const addresses = wallets.map(w => w.walletAddress);
    // Return first wallet for backward compatibility, plus full list
    res.json({ 
      address: addresses.length > 0 ? addresses[0] : null,
      addresses: addresses
    });
  });

  // ==================== Telegram Integration Routes ====================

  // Telegram webhook endpoint - receives updates from Telegram
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      // Respond immediately to Telegram
      res.status(200).json({ ok: true });
      
      // Process update asynchronously
      handleWebhookUpdate(req.body).catch(err => {
        console.error("Telegram webhook error:", err);
      });
    } catch (error) {
      console.error("Telegram webhook error:", error);
      res.status(200).json({ ok: true }); // Always 200 to prevent Telegram retries
    }
  });

  // Generate Telegram link token for current user
  app.post("/api/telegram/link", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId!;
      const token = await createLinkToken(userId);
      
      // Get bot username for deep link
      const botInfo = await verifyBotToken();
      if (!botInfo.valid || !botInfo.username) {
        return res.status(500).json({ error: "Telegram bot not configured" });
      }
      
      const deepLink = `https://t.me/${botInfo.username}?start=${token}`;
      res.json({ success: true, deepLink, token });
    } catch (error) {
      console.error("Error creating Telegram link:", error);
      res.status(500).json({ error: "Failed to create link" });
    }
  });

  // Unlink Telegram from current user
  app.post("/api/telegram/unlink", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId!;
      await unlinkTelegram(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error unlinking Telegram:", error);
      res.status(500).json({ error: "Failed to unlink" });
    }
  });

  // Get Telegram link status for current user
  app.get("/api/telegram/status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.userId!;
      const user = await storage.getUserById(userId);
      
      // If not linked, generate a link token
      let linkToken: string | undefined;
      if (!user?.telegramChatId) {
        try {
          linkToken = await createLinkToken(userId);
        } catch (tokenError) {
          console.error("Error creating link token:", tokenError);
        }
      }
      
      res.json({
        linked: !!user?.telegramChatId,
        linkedAt: user?.telegramLinkedAt,
        linkToken,
      });
    } catch (error) {
      console.error("Error getting Telegram status:", error);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  // Admin: Get Telegram bot info and webhook status
  app.get("/api/admin/telegram/status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }

      const botInfo = await verifyBotToken();
      const webhookInfo = await getWebhookInfo();
      
      res.json({
        bot: botInfo,
        webhook: webhookInfo,
      });
    } catch (error) {
      console.error("Error getting Telegram admin status:", error);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  // Admin: Set Telegram webhook URL
  app.post("/api/admin/telegram/webhook", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }

      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL required" });
      }

      const result = await setWebhook(url);
      res.json(result);
    } catch (error) {
      console.error("Error setting Telegram webhook:", error);
      res.status(500).json({ error: "Failed to set webhook" });
    }
  });

  // Admin: Get system logs (AI usage, errors, etc.)
  app.get("/api/admin/system-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }

      const { service, status, limit, hoursAgo, search } = req.query;
      
      const logs = await querySystemLogs({
        service: service as any,
        status: status as any,
        limit: limit ? parseInt(limit as string) : 50,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
        search: search as string,
      });

      // Calculate AI usage summary if filtering by AI service
      let aiSummary = null;
      if (!service || service === "ai") {
        const aiLogs = logs.filter(l => l.service === "ai");
        const totalTokens = aiLogs.reduce((sum, l) => sum + ((l.context as any)?.totalTokens || 0), 0);
        const totalCost = aiLogs.reduce((sum, l) => sum + ((l.context as any)?.estimatedCostUsd || 0), 0);
        const avgLatency = aiLogs.length > 0 
          ? aiLogs.reduce((sum, l) => sum + (l.latencyMs || 0), 0) / aiLogs.length 
          : 0;
        
        aiSummary = {
          callCount: aiLogs.length,
          totalTokens,
          estimatedCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
          avgLatencyMs: Math.round(avgLatency),
        };
      }

      // Get API usage summary
      const apiServices = ["helius", "jupiter", "dexscreener", "geckoterminal"];
      const apiLogs = logs.filter(l => apiServices.includes(l.service));
      const apiSummary = {
        callCount: apiLogs.length,
        byService: apiServices.reduce((acc, svc) => {
          acc[svc] = apiLogs.filter(l => l.service === svc).length;
          return acc;
        }, {} as Record<string, number>),
        avgLatencyMs: apiLogs.length > 0
          ? Math.round(apiLogs.reduce((sum, l) => sum + (l.latencyMs || 0), 0) / apiLogs.length)
          : 0,
      };

      res.json({ logs, aiSummary, apiSummary });
    } catch (error) {
      console.error("Error getting system logs:", error);
      res.status(500).json({ error: "Failed to get logs" });
    }
  });

  // Admin: Get usage analytics (time-series, projections, user breakdown)
  app.get("/api/admin/usage-analytics", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }

      const { getUsageTimeSeries, getUserUsageBreakdown, getUsageProjections } = await import("./system-logger");
      
      const [timeSeries, userBreakdown, projections] = await Promise.all([
        getUsageTimeSeries(24),
        getUserUsageBreakdown(24),
        getUsageProjections(),
      ]);

      // Enrich user breakdown with usernames
      const enrichedUserBreakdown = await Promise.all(
        userBreakdown.map(async (u) => {
          const userData = await storage.getUserById(u.userId);
          return { ...u, username: userData?.username || `User #${u.userId}` };
        })
      );

      res.json({ timeSeries, userBreakdown: enrichedUserBreakdown, projections });
    } catch (error) {
      console.error("Error getting usage analytics:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });

  // Admin: Get dedicated AI logs
  app.get("/api/admin/ai-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { queryAiLogs } = await import("./system-logger");
      const { userId, limit, hoursAgo } = req.query;
      
      const logs = await queryAiLogs({
        userId: userId ? parseInt(userId as string) : undefined,
        limit: limit ? parseInt(limit as string) : 50,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
      });

      res.json({ logs });
    } catch (error) {
      console.error("Error getting AI logs:", error);
      res.status(500).json({ error: "Failed to get AI logs" });
    }
  });

  // Admin: Get dedicated API logs
  app.get("/api/admin/api-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { queryApiLogs } = await import("./system-logger");
      const { service, limit, hoursAgo } = req.query;
      
      const logs = await queryApiLogs({
        service: service as any,
        limit: limit ? parseInt(limit as string) : 50,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
      });

      res.json({ logs });
    } catch (error) {
      console.error("Error getting API logs:", error);
      res.status(500).json({ error: "Failed to get API logs" });
    }
  });

  // Admin: Get dedicated webhook logs
  app.get("/api/admin/webhook-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { queryWebhookLogs } = await import("./system-logger");
      const { status, limit, hoursAgo } = req.query;
      
      const logs = await queryWebhookLogs({
        status: status as string,
        limit: limit ? parseInt(limit as string) : 50,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
      });

      res.json({ logs });
    } catch (error) {
      console.error("Error getting webhook logs:", error);
      res.status(500).json({ error: "Failed to get webhook logs" });
    }
  });

  // Admin: Get dedicated trade logs
  app.get("/api/admin/trade-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { queryTradeLogs } = await import("./system-logger");
      const { userId, signalWalletId, status, action, limit, hoursAgo } = req.query;
      
      const logs = await queryTradeLogs({
        userId: userId ? parseInt(userId as string) : undefined,
        signalWalletId: signalWalletId ? parseInt(signalWalletId as string) : undefined,
        status: status as string,
        action: action as string,
        limit: limit ? parseInt(limit as string) : 50,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
      });

      res.json({ logs });
    } catch (error) {
      console.error("Error getting trade logs:", error);
      res.status(500).json({ error: "Failed to get trade logs" });
    }
  });

  // Admin: Get dedicated error logs
  app.get("/api/admin/error-logs", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { queryErrorLogs } = await import("./system-logger");
      const { service, resolved, limit, hoursAgo } = req.query;
      
      const logs = await queryErrorLogs({
        service: service as string,
        resolved: resolved === "true" ? true : resolved === "false" ? false : undefined,
        limit: limit ? parseInt(limit as string) : 100,
        hoursAgo: hoursAgo ? parseInt(hoursAgo as string) : undefined,
      });

      res.json({ logs });
    } catch (error) {
      console.error("Error getting error logs:", error);
      res.status(500).json({ error: "Failed to get error logs" });
    }
  });

  // Admin: Get log summary (counts for all types)
  app.get("/api/admin/log-summary", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { getLogSummary } = await import("./system-logger");
      const summary = await getLogSummary();

      res.json(summary);
    } catch (error) {
      console.error("Error getting log summary:", error);
      res.status(500).json({ error: "Failed to get log summary" });
    }
  });

  // Admin: Budget pool status for all users
  app.get("/api/admin/budget-pool-status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { getPoolSummary, cleanupOldQueueItems } = await import("./budget-manager");
      
      const poolSummary = await getPoolSummary();
      const queueItemsCleaned = await cleanupOldQueueItems();
      
      // Get queue stats from db
      const queueStats = await db.select({
        status: apiQueue.status,
        count: sql<number>`count(*)`,
        avgWait: sql<number>`avg(extract(epoch from (now() - ${apiQueue.createdAt})))`,
      })
        .from(apiQueue)
        .groupBy(apiQueue.status);
      
      const userBudgets = await db.select({
        userId: userBudgetUsage.userId,
        monthlyBudget: userBudgetUsage.monthlyBudget,
        usedCredits: userBudgetUsage.usedCredits,
        projectedEndOfMonth: userBudgetUsage.projectedEndOfMonth,
        throttleRate: userBudgetUsage.throttleRate,
        lastThrottleAt: userBudgetUsage.lastThrottleAt,
      })
        .from(budgetUsage)
        .limit(50);

      res.json({
        pool: poolSummary,
        queueStats,
        queueItemsCleaned,
        userBudgets,
      });
    } catch (error) {
      console.error("Error getting budget pool status:", error);
      res.status(500).json({ error: "Failed to get budget pool status" });
    }
  });

  // Admin: RPC provider stats
  app.get("/api/admin/rpc-stats", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { getProviderStats, getCurrentProvider } = await import("./rpc-provider");
      const { getRpcProviderUsage, getTotalRpcPoolCapacity, getProviderCapacities } = await import("./budget-manager");
      
      const stats = getProviderStats();
      const currentProvider = await getCurrentProvider();
      const chainstackConfigured = !!process.env.CHAINSTACK_API_KEY;
      const quicknodeConfigured = !!process.env.QUICKNODE_API_KEY;
      
      const budgetUsage = getRpcProviderUsage();
      const totalCapacity = getTotalRpcPoolCapacity();
      const providerCapacities = getProviderCapacities();

      res.json({
        currentProvider,
        chainstackConfigured,
        quicknodeConfigured,
        providers: stats,
        budget: {
          totalCapacity,
          providerCapacities,
          usage: budgetUsage,
        },
      });
    } catch (error) {
      console.error("Error getting RPC stats:", error);
      res.status(500).json({ error: "Failed to get RPC stats" });
    }
  });

  // Admin: Reset RPC provider stats
  app.post("/api/admin/rpc-stats/reset", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { resetProviderStats } = await import("./rpc-provider");
      resetProviderStats();

      res.json({ success: true, message: "RPC stats reset" });
    } catch (error) {
      console.error("Error resetting RPC stats:", error);
      res.status(500).json({ error: "Failed to reset RPC stats" });
    }
  });

  // Discovery Worker: Get next task for browser worker
  app.get("/api/discovery/task", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { assignTaskToWorker } = await import("./discovery-worker");
      const task = await assignTaskToWorker(req.userId!);
      
      if (!task) {
        return res.json({ task: null, message: "No tasks available" });
      }
      
      res.json({
        task: {
          id: task.id,
          type: task.taskType,
          payload: task.payload,
          ttlSeconds: task.ttlSeconds,
        },
      });
    } catch (error) {
      console.error("Error getting discovery task:", error);
      res.status(500).json({ error: "Failed to get discovery task" });
    }
  });

  // Discovery Worker: Submit task result
  app.post("/api/discovery/task/:taskId/complete", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const taskId = parseInt(req.params.taskId);
      const { result, error: errorMessage } = req.body;
      
      const { completeTask, failTask } = await import("./discovery-worker");
      
      if (errorMessage) {
        const failed = await failTask(taskId, errorMessage);
        return res.json({ success: !!failed, task: failed });
      }
      
      const completed = await completeTask(taskId, result || {});
      res.json({ success: !!completed, task: completed });
    } catch (error) {
      console.error("Error completing discovery task:", error);
      res.status(500).json({ error: "Failed to complete discovery task" });
    }
  });

  // Discovery Worker: Get task stats (admin only)
  app.get("/api/admin/discovery/stats", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { getTaskStats } = await import("./discovery-worker");
      const stats = await getTaskStats();
      
      res.json(stats);
    } catch (error) {
      console.error("Error getting discovery stats:", error);
      res.status(500).json({ error: "Failed to get discovery stats" });
    }
  });

  // Discovery Worker: Queue token metadata task (admin only)
  app.post("/api/admin/discovery/queue-token", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { mint, priority } = req.body;
      if (!mint) {
        return res.status(400).json({ error: "mint is required" });
      }

      const { createTokenMetadataTask } = await import("./discovery-worker");
      const task = await createTokenMetadataTask(mint, priority || 10);
      
      res.json({ success: true, task });
    } catch (error) {
      console.error("Error queuing discovery task:", error);
      res.status(500).json({ error: "Failed to queue discovery task" });
    }
  });

  // Admin: Data pool status
  app.get("/api/admin/data-pool-status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { getDataPoolStats, isSystemIdle, getStaleTokensForRefresh, getStaleHoldersForRefresh } = await import("./data-pool");
      
      const stats = await getDataPoolStats();
      const idle = isSystemIdle();
      const staleTokens = await getStaleTokensForRefresh(5);
      const staleHolders = await getStaleHoldersForRefresh(5);

      res.json({
        ...stats,
        systemIdle: idle,
        staleTokensSample: staleTokens,
        staleHoldersSample: staleHolders,
      });
    } catch (error) {
      console.error("Error getting data pool status:", error);
      res.status(500).json({ error: "Failed to get data pool status" });
    }
  });

  // Admin: Throttle status across users
  app.get("/api/admin/throttle-status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const throttledUsers = await db.select({
        userId: userBudgetUsage.userId,
        throttleRate: userBudgetUsage.throttleRate,
        usedCredits: userBudgetUsage.usedCredits,
        monthlyBudget: userBudgetUsage.monthlyBudget,
        lastThrottleAt: userBudgetUsage.lastThrottleAt,
      })
        .from(budgetUsage)
        .where(sql`${userBudgetUsage.throttleRate} > 0`);

      const queueBacklog = await db.select({
        priority: apiQueue.priority,
        count: sql<number>`count(*)`,
        oldestItem: sql<string>`min(${apiQueue.createdAt})`,
      })
        .from(apiQueue)
        .where(eq(apiQueue.status, "pending"))
        .groupBy(apiQueue.priority);

      res.json({
        throttledUserCount: throttledUsers.length,
        throttledUsers,
        queueBacklog,
      });
    } catch (error) {
      console.error("Error getting throttle status:", error);
      res.status(500).json({ error: "Failed to get throttle status" });
    }
  });

  // ==================== Monitored Wallets Routes ====================

  // Sync webhook with all monitored wallets
  app.post("/api/monitored-wallets/sync", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const status = await storage.getMonitoringStatus();
      if (!status.isActive || !status.webhookId) {
        return res.json({ success: true, message: "Monitoring not active" });
      }
      
      const allWallets = await storage.getAllMonitoredWallets();
      const walletAddresses = allWallets.map(w => w.walletAddress);
      
      // If no wallets to monitor, deactivate monitoring
      if (walletAddresses.length === 0) {
        await deleteWebhook(status.webhookId);
        await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
        return res.json({ success: true, message: "No wallets to monitor, monitoring deactivated" });
      }
      
      const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
      await updateWebhookUrl(status.webhookId, webhookUrl, walletAddresses);
      
      res.json({ success: true, walletCount: walletAddresses.length });
    } catch (error) {
      console.error("Error syncing wallets:", error);
      res.status(500).json({ error: "Failed to sync wallets" });
    }
  });

  // ==================== Community Wallets Routes ====================

  // Get community wallets (approved shared wallets from other users)
  app.get("/api/community-wallets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      // Get all approved shared wallets (excluding user's own)
      const approvedWallets = await db.select()
        .from(monitoredWallets)
        .where(and(
          eq(monitoredWallets.isShared, true),
          eq(monitoredWallets.shareStatus, "approved")
        ));

      // Group by wallet address and aggregate scores
      const walletMap = new Map<string, {
        walletAddress: string;
        label: string;
        aiScore: number | null;
        aiScoreDetails: string | null;
        monitoredByCount: number;
        isMonitoredByUser: boolean;
      }>();

      // Get user's own wallets to check if already monitoring
      const userWallets = await db.select()
        .from(monitoredWallets)
        .where(eq(monitoredWallets.userId, req.userId!));
      const userWalletAddresses = new Set(userWallets.map(w => w.walletAddress));

      for (const wallet of approvedWallets) {
        const existing = walletMap.get(wallet.walletAddress);
        if (existing) {
          existing.monitoredByCount++;
          // Keep highest score
          if (wallet.aiScore && (!existing.aiScore || wallet.aiScore > existing.aiScore)) {
            existing.aiScore = wallet.aiScore;
            existing.aiScoreDetails = wallet.aiScoreDetails;
          }
        } else {
          walletMap.set(wallet.walletAddress, {
            walletAddress: wallet.walletAddress,
            label: wallet.label || wallet.walletAddress.slice(0, 8) + "...",
            aiScore: wallet.aiScore,
            aiScoreDetails: wallet.aiScoreDetails,
            monitoredByCount: 1,
            isMonitoredByUser: userWalletAddresses.has(wallet.walletAddress),
          });
        }
      }

      // Convert to array and sort by score
      const communityWallets = Array.from(walletMap.values())
        .filter(w => !w.isMonitoredByUser) // Exclude wallets user already monitors
        .sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));

      res.json(communityWallets);
    } catch (error) {
      console.error("Error fetching community wallets:", error);
      res.status(500).json({ error: "Failed to fetch community wallets" });
    }
  });

  // Submit wallet for community sharing (requires admin approval)
  app.post("/api/monitored-wallets/:id/share", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Verify ownership
      const wallet = await db.select()
        .from(monitoredWallets)
        .where(and(
          eq(monitoredWallets.id, walletId),
          eq(monitoredWallets.userId, req.userId!)
        ))
        .limit(1);

      if (wallet.length === 0) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      // Update to pending status
      await db.update(monitoredWallets)
        .set({ isShared: true, shareStatus: "pending" })
        .where(eq(monitoredWallets.id, walletId));

      // Score the wallet asynchronously
      const { scoreWallet } = await import("./ai");
      scoreWallet(wallet[0].walletAddress).then(async (score) => {
        if (score) {
          await db.update(monitoredWallets)
            .set({
              aiScore: score.score,
              aiScoreDetails: JSON.stringify(score),
              aiScoreUpdatedAt: Math.floor(Date.now() / 1000),
            })
            .where(eq(monitoredWallets.id, walletId));
        }
      }).catch(err => console.error("Error scoring wallet:", err));

      res.json({ success: true, message: "Submitted for community sharing approval" });
    } catch (error) {
      console.error("Error submitting wallet for sharing:", error);
      res.status(500).json({ error: "Failed to submit wallet for sharing" });
    }
  });

  // Cancel community sharing request
  app.post("/api/monitored-wallets/:id/unshare", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Verify ownership
      const wallet = await db.select()
        .from(monitoredWallets)
        .where(and(
          eq(monitoredWallets.id, walletId),
          eq(monitoredWallets.userId, req.userId!)
        ))
        .limit(1);

      if (wallet.length === 0) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      await db.update(monitoredWallets)
        .set({ isShared: false, shareStatus: "none" })
        .where(eq(monitoredWallets.id, walletId));

      res.json({ success: true });
    } catch (error) {
      console.error("Error unsharing wallet:", error);
      res.status(500).json({ error: "Failed to unshare wallet" });
    }
  });

  // Add a community wallet to user's monitored list
  app.post("/api/community-wallets/add", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { walletAddress, label } = req.body;
      
      if (!walletAddress) {
        return res.status(400).json({ error: "Wallet address is required" });
      }

      // Check if user already monitors this wallet
      const existing = await db.select()
        .from(monitoredWallets)
        .where(and(
          eq(monitoredWallets.userId, req.userId!),
          eq(monitoredWallets.walletAddress, walletAddress)
        ))
        .limit(1);

      if (existing.length > 0) {
        return res.status(400).json({ error: "You are already monitoring this wallet" });
      }

      // Add to user's monitored wallets
      const [newWallet] = await db.insert(monitoredWallets)
        .values({
          userId: req.userId!,
          walletAddress,
          label: label || walletAddress.slice(0, 8) + "...",
          enabled: true,
          createdAt: Math.floor(Date.now() / 1000),
          isShared: false,
          shareStatus: "none",
        })
        .returning();

      // Sync webhook
      const status = await storage.getMonitoringStatus();
      if (status.isActive && status.webhookId) {
        const allWallets = await storage.getAllMonitoredWallets();
        const walletAddresses = allWallets.map(w => w.walletAddress);
        const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
        await updateWebhookUrl(status.webhookId, webhookUrl, walletAddresses);
      }

      res.json(newWallet);
    } catch (error) {
      console.error("Error adding community wallet:", error);
      res.status(500).json({ error: "Failed to add wallet" });
    }
  });

  app.get("/api/monitored-wallets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const wallets = await storage.getMonitoredWallets(req.userId!);
      res.json(wallets);
    } catch (error) {
      console.error("Error getting monitored wallets:", error);
      res.status(500).json({ error: "Failed to get monitored wallets" });
    }
  });

  app.get("/api/signal-wallet-profile/:address", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getSignalWalletProfile, getProfileSummary } = await import("./signal-wallet-profiler");
      const profile = await getSignalWalletProfile(req.params.address);
      
      if (!profile) {
        return res.json({ profile: null, summary: "No trading history recorded" });
      }
      
      const summary = getProfileSummary(profile);
      res.json({ profile, summary });
    } catch (error) {
      console.error("Error getting signal wallet profile:", error);
      res.status(500).json({ error: "Failed to get signal wallet profile" });
    }
  });

  app.get("/api/position-config-suggestion/:address", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { suggestPositionConfig } = await import("./signal-wallet-profiler");
      
      const input = {
        walletAddress: req.params.address as string,
        tokenScore: req.query.tokenScore ? parseInt(req.query.tokenScore as string) : undefined,
        hasWhaleActivity: req.query.hasWhaleActivity === "true",
        riskProfile: (req.query.riskProfile as "conservative" | "balanced" | "aggressive" | "custom") || undefined,
        recentVolatility: req.query.volatility ? parseFloat(req.query.volatility as string) : undefined,
        marketTrend: (req.query.marketTrend as "bullish" | "bearish" | "neutral") || undefined,
      };
      
      const suggestion = await suggestPositionConfig(input);
      res.json(suggestion);
    } catch (error) {
      console.error("Error getting position config suggestion:", error);
      res.status(500).json({ error: "Failed to get position config suggestion" });
    }
  });

  app.post("/api/monitored-wallets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { walletAddress, label } = req.body;
      if (!walletAddress || typeof walletAddress !== 'string') {
        return res.status(400).json({ error: "Wallet address is required" });
      }
      
      if (walletAddress.length < 32 || walletAddress.length > 44) {
        return res.status(400).json({ error: "Invalid Solana wallet address" });
      }
      
      const limitCheck = await canAddWallet(req.userId!);
      if (!limitCheck.allowed) {
        return res.status(403).json({ error: limitCheck.reason });
      }
      
      const wallet = await storage.addMonitoredWallet(req.userId!, walletAddress, label);
      
      // Backfill recent swap history asynchronously (don't block the response)
      const userId = req.userId!;
      (async () => {
        try {
          const { backfillWalletSwaps } = await import("./helius");
          const result = await backfillWalletSwaps(walletAddress, 100);
          
          if (result.swaps.length > 0) {
            let stored = 0;
            for (const swap of result.swaps) {
              try {
                const existing = await db.select({ id: swaps.id }).from(swaps)
                  .where(eq(swaps.signature, swap.signature))
                  .limit(1);
                
                if (existing.length === 0) {
                  // Enrich token symbols from DexScreener if unknown
                  let fromSymbol = swap.fromTokenSymbol;
                  let toSymbol = swap.toTokenSymbol;
                  
                  if (!isBaseCurrency(swap.fromToken) && (fromSymbol === "???" || fromSymbol?.includes("..."))) {
                    const meta = await fetchTokenMetadata(swap.fromToken);
                    if (meta?.symbol) fromSymbol = meta.symbol;
                  }
                  if (!isBaseCurrency(swap.toToken) && (toSymbol === "???" || toSymbol?.includes("..."))) {
                    const meta = await fetchTokenMetadata(swap.toToken);
                    if (meta?.symbol) toSymbol = meta.symbol;
                  }
                  
                  await db.insert(swaps).values({
                    userId,
                    signature: swap.signature,
                    timestamp: swap.timestamp,
                    type: swap.type,
                    source: swap.source,
                    fromToken: swap.fromToken,
                    fromTokenSymbol: fromSymbol,
                    fromAmount: swap.fromAmount,
                    toToken: swap.toToken,
                    toTokenSymbol: toSymbol,
                    toAmount: swap.toAmount,
                    fee: swap.fee || null,
                    slot: swap.slot,
                    notificationSent: true,
                  });
                  stored++;
                }
              } catch (e) {
                // Ignore duplicate key errors
              }
            }
            console.log(`Backfill on add: Stored ${stored} swaps for ${walletAddress}`);
          }
        } catch (e) {
          console.error("Backfill on add error:", e);
        }
      })();
      
      res.json(wallet);
    } catch (error) {
      console.error("Error adding monitored wallet:", error);
      res.status(500).json({ error: "Failed to add monitored wallet" });
    }
  });

  const walletUpdateSchema = z.object({
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    copyTradeEnabled: z.boolean().optional(),
    copyBuyType: z.enum(["fixed_sol", "fixed_usd", "percentage"]).optional(),
    copyBuyAmount: z.number().positive().optional(),
    copyMinBalance: z.number().nonnegative().nullish(),
    copyMinTradeUsd: z.number().nonnegative().nullish(),
    copyScoreThreshold: z.number().int().min(0).max(100).nullish(),
    copyTiming: z.enum(["immediate", "delayed", "triggered"]).optional(),
    copyDelayMinutes: z.number().int().nonnegative().nullish(),
    copyAutoMirror: z.boolean().optional(),
    copyMirrorBuys: z.boolean().optional(),
    copyMirrorSells: z.boolean().optional(),
    copyMirrorBuyMode: z.enum(["same", "fixed", "percent_wallet", "proportional"]).optional(),
    copyMirrorBuyAmount: z.number().nonnegative().nullish(),
    copyPositionCapUsd: z.number().nonnegative().nullish(),
    copyMirrorSellMode: z.enum(["match_percent", "fixed_percent", "fixed_amount", "full_exit_only"]).optional(),
    copyMirrorSellPercent: z.number().nonnegative().nullish(),
    copyMirrorSellAmount: z.number().nonnegative().nullish(),
    dedupSkipIfHolding: z.boolean().optional(),
    dedupSkipIfEverHeld: z.boolean().optional(),
    dedupSkipIfPending: z.boolean().optional(),
    userNotes: z.string().nullish(),
  });
  
  // Get single monitored wallet by ID
  app.get("/api/monitored-wallets/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      if (isNaN(walletId)) {
        return res.status(400).json({ error: "Invalid wallet ID" });
      }
      const wallet = await storage.getMonitoredWallet(req.userId!, walletId);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json(wallet);
    } catch (error) {
      console.error("Error fetching monitored wallet:", error);
      res.status(500).json({ error: "Failed to fetch monitored wallet" });
    }
  });

  app.patch("/api/monitored-wallets/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const parsed = walletUpdateSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid update data", details: parsed.error.issues });
      }
      
      const updateData = parsed.data;
      
      const wallet = await storage.updateMonitoredWallet(req.userId!, walletId, updateData);
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json(wallet);
    } catch (error) {
      console.error("Error updating monitored wallet:", error);
      res.status(500).json({ error: "Failed to update monitored wallet" });
    }
  });

  app.delete("/api/monitored-wallets/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const deleted = await storage.deleteMonitoredWallet(req.userId!, walletId);
      if (!deleted) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting monitored wallet:", error);
      res.status(500).json({ error: "Failed to delete monitored wallet" });
    }
  });
  
  // Get per-wallet copy config
  app.get("/api/monitored-wallets/:id/copy-config", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      ).limit(1);
      
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      res.json({
        walletId: wallet.id,
        walletAddress: wallet.walletAddress,
        label: wallet.label,
        copyTradeEnabled: wallet.copyTradeEnabled,
        copyBuyType: wallet.copyBuyType || "percentage",
        copyBuyAmount: wallet.copyBuyAmount || 10,
        copyMinBalance: wallet.copyMinBalance,
        copyMinTradeUsd: wallet.copyMinTradeUsd,
        copyScoreThreshold: wallet.copyScoreThreshold,
        copyTiming: wallet.copyTiming || "delayed",
        copyDelayMinutes: wallet.copyDelayMinutes,
        copyAutoMirror: wallet.copyAutoMirror ?? false,
        copyMirrorBuys: wallet.copyMirrorBuys ?? wallet.copyAutoMirror ?? false,
        copyMirrorSells: wallet.copyMirrorSells ?? wallet.copyAutoMirror ?? false,
        dedupSkipIfHolding: wallet.dedupSkipIfHolding ?? true,
        dedupSkipIfEverHeld: wallet.dedupSkipIfEverHeld ?? false,
        dedupSkipIfPending: wallet.dedupSkipIfPending ?? true,
      });
    } catch (error) {
      console.error("Error getting wallet copy config:", error);
      res.status(500).json({ error: "Failed to get wallet copy config" });
    }
  });
  
  // Update per-wallet copy config
  const copyConfigSchema = z.object({
    copyTradeEnabled: z.boolean().optional(),
    copyBuyType: z.enum(["fixed_sol", "fixed_usd", "percentage"]).optional(),
    copyBuyAmount: z.number().positive().optional(),
    copyMinBalance: z.number().nonnegative().nullish(),
    copyMinTradeUsd: z.number().nonnegative().nullish(),
    copyScoreThreshold: z.number().int().min(0).max(100).nullish(),
    copyTiming: z.enum(["immediate", "delayed", "triggered"]).optional(),
    copyDelayMinutes: z.number().int().nonnegative().nullish(),
    copyAutoMirror: z.boolean().optional(),
    copyMirrorBuys: z.boolean().optional(),
    copyMirrorSells: z.boolean().optional(),
    dedupSkipIfHolding: z.boolean().optional(),
    dedupSkipIfEverHeld: z.boolean().optional(),
    dedupSkipIfPending: z.boolean().optional(),
  });
  
  app.patch("/api/monitored-wallets/:id/copy-config", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const parsed = copyConfigSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid copy config", details: parsed.error.issues });
      }
      
      // Verify wallet belongs to user
      const [existing] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      ).limit(1);
      
      if (!existing) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      const updateData = parsed.data;
      
      await db.update(monitoredWallets).set({
        copyTradeEnabled: updateData.copyTradeEnabled ?? existing.copyTradeEnabled,
        copyBuyType: updateData.copyBuyType ?? existing.copyBuyType,
        copyBuyAmount: updateData.copyBuyAmount ?? existing.copyBuyAmount,
        copyMinBalance: updateData.copyMinBalance !== undefined ? updateData.copyMinBalance : existing.copyMinBalance,
        copyMinTradeUsd: updateData.copyMinTradeUsd !== undefined ? updateData.copyMinTradeUsd : existing.copyMinTradeUsd,
        copyScoreThreshold: updateData.copyScoreThreshold !== undefined ? updateData.copyScoreThreshold : existing.copyScoreThreshold,
        copyTiming: updateData.copyTiming ?? existing.copyTiming,
        copyDelayMinutes: updateData.copyDelayMinutes !== undefined ? updateData.copyDelayMinutes : existing.copyDelayMinutes,
        copyAutoMirror: updateData.copyAutoMirror ?? existing.copyAutoMirror,
        copyMirrorBuys: updateData.copyMirrorBuys ?? existing.copyMirrorBuys,
        copyMirrorSells: updateData.copyMirrorSells ?? existing.copyMirrorSells,
        dedupSkipIfHolding: updateData.dedupSkipIfHolding ?? existing.dedupSkipIfHolding,
        dedupSkipIfEverHeld: updateData.dedupSkipIfEverHeld ?? existing.dedupSkipIfEverHeld,
        dedupSkipIfPending: updateData.dedupSkipIfPending ?? existing.dedupSkipIfPending,
      }).where(eq(monitoredWallets.id, walletId));
      
      // Return updated config
      const [updated] = await db.select().from(monitoredWallets).where(eq(monitoredWallets.id, walletId)).limit(1);
      
      res.json({
        success: true,
        walletId: updated.id,
        copyTradeEnabled: updated.copyTradeEnabled,
        copyBuyType: updated.copyBuyType || "percentage",
        copyBuyAmount: updated.copyBuyAmount || 10,
        copyMinBalance: updated.copyMinBalance,
        copyMinTradeUsd: updated.copyMinTradeUsd,
        copyScoreThreshold: updated.copyScoreThreshold,
        copyTiming: updated.copyTiming || "delayed",
        copyDelayMinutes: updated.copyDelayMinutes,
        copyAutoMirror: updated.copyAutoMirror ?? false,
        copyMirrorBuys: updated.copyMirrorBuys ?? updated.copyAutoMirror ?? false,
        copyMirrorSells: updated.copyMirrorSells ?? updated.copyAutoMirror ?? false,
        dedupSkipIfHolding: updated.dedupSkipIfHolding ?? true,
        dedupSkipIfEverHeld: updated.dedupSkipIfEverHeld ?? false,
        dedupSkipIfPending: updated.dedupSkipIfPending ?? true,
      });
    } catch (error) {
      console.error("Error updating wallet copy config:", error);
      res.status(500).json({ error: "Failed to update wallet copy config" });
    }
  });

  // Get signal wallet activity (trades, stats, hit rate)
  app.get("/api/signal-wallets/:id/activity", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const timeframe = req.query.timeframe as string || "24h";
      
      // Get wallet and verify ownership
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      ).limit(1);
      
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      // Calculate timeframe cutoff
      const now = Math.floor(Date.now() / 1000);
      let cutoff = 0;
      switch (timeframe) {
        case "24h": cutoff = now - 86400; break;
        case "7d": cutoff = now - 7 * 86400; break;
        case "30d": cutoff = now - 30 * 86400; break;
        case "all": cutoff = 0; break;
        default: cutoff = now - 86400;
      }
      
      // Query swaps for this wallet address
      const walletSwaps = await db.select().from(swaps)
        .where(
          and(
            eq(swaps.source, wallet.walletAddress),
            gte(swaps.timestamp, cutoff)
          )
        )
        .orderBy(sql`${swaps.timestamp} DESC`)
        .limit(500);
      
      // Get signal wallet profile for aggregated stats
      const [profile] = await db.select().from(signalWalletProfiles)
        .where(eq(signalWalletProfiles.walletAddress, wallet.walletAddress))
        .limit(1);
      
      // Calculate stats from swaps
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const buys = walletSwaps.filter(s => s.fromToken === SOL_MINT);
      const sells = walletSwaps.filter(s => s.toToken === SOL_MINT);
      
      // Token tracking for hit rate
      const tokenBuys: Record<string, { amount: number; solSpent: number; timestamp: number }> = {};
      const tokenSells: Record<string, { solReceived: number }> = {};
      
      for (const swap of buys) {
        const token = swap.toToken;
        if (!tokenBuys[token]) {
          tokenBuys[token] = { amount: 0, solSpent: 0, timestamp: swap.timestamp };
        }
        tokenBuys[token].amount += swap.toAmount;
        tokenBuys[token].solSpent += swap.fromAmount;
      }
      
      for (const swap of sells) {
        const token = swap.fromToken;
        if (!tokenSells[token]) {
          tokenSells[token] = { solReceived: 0 };
        }
        tokenSells[token].solReceived += swap.toAmount;
      }
      
      // Calculate P&L for closed positions
      let totalSolSpent = 0;
      let totalSolReceived = 0;
      let profitableTrades = 0;
      let closedTrades = 0;
      
      for (const token of Object.keys(tokenBuys)) {
        const buy = tokenBuys[token];
        const sell = tokenSells[token];
        
        totalSolSpent += buy.solSpent;
        
        if (sell) {
          totalSolReceived += sell.solReceived;
          closedTrades++;
          if (sell.solReceived > buy.solSpent) {
            profitableTrades++;
          }
        }
      }
      
      const hitRate = closedTrades > 0 ? (profitableTrades / closedTrades) * 100 : 0;
      const realizedPnl = totalSolReceived - totalSolSpent;
      
      // Get most traded tokens
      const tokenCounts: Record<string, { symbol: string; count: number }> = {};
      for (const swap of walletSwaps) {
        const token = swap.fromToken === SOL_MINT ? swap.toToken : swap.fromToken;
        const symbol = swap.fromToken === SOL_MINT ? swap.toTokenSymbol : swap.fromTokenSymbol;
        if (!tokenCounts[token]) {
          tokenCounts[token] = { symbol, count: 0 };
        }
        tokenCounts[token].count++;
      }
      const mostTraded = Object.entries(tokenCounts)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5)
        .map(([mint, data]) => ({ mint, symbol: data.symbol, tradeCount: data.count }));
      
      res.json({
        wallet: {
          id: wallet.id,
          address: wallet.walletAddress,
          label: wallet.label,
          copyTradeEnabled: wallet.copyTradeEnabled,
          enabled: wallet.enabled,
          userNotes: wallet.userNotes || null,
        },
        timeframe,
        trades: walletSwaps.map(s => ({
          id: s.id,
          signature: s.signature,
          timestamp: s.timestamp,
          type: s.type,
          fromToken: s.fromToken,
          fromTokenSymbol: s.fromTokenSymbol,
          fromAmount: s.fromAmount,
          toToken: s.toToken,
          toTokenSymbol: s.toTokenSymbol,
          toAmount: s.toAmount,
          isBuy: s.fromToken === SOL_MINT,
          solPriceAtTrade: s.solPriceAtTrade,
          toTokenMetadata: s.toTokenMetadata,
        })),
        stats: {
          totalTrades: walletSwaps.length,
          buys: buys.length,
          sells: sells.length,
          closedPositions: closedTrades,
          profitableTrades,
          hitRate: Math.round(hitRate * 10) / 10,
          totalSolSpent: Math.round(totalSolSpent * 1000) / 1000,
          totalSolReceived: Math.round(totalSolReceived * 1000) / 1000,
          realizedPnl: Math.round(realizedPnl * 1000) / 1000,
          mostTradedTokens: mostTraded,
        },
        profile: profile ? {
          tradingStyle: profile.tradingStyle,
          winRate: profile.winRate,
          avgExitMultiplier: profile.avgExitMultiplier,
          totalTrades: profile.totalTrades,
          lastTradeAt: profile.lastTradeAt,
        } : null,
      });
    } catch (error) {
      console.error("Error getting signal wallet activity:", error);
      res.status(500).json({ error: "Failed to get wallet activity" });
    }
  });

  // Get signal wallet current token holdings
  app.get("/api/signal-wallets/:id/holdings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Get wallet and verify ownership
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      ).limit(1);
      
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      // Fetch current token holdings from blockchain
      const holdings = await fetchWalletTokenHoldings(wallet.walletAddress);
      
      res.json({ holdings });
    } catch (error) {
      console.error("Error getting signal wallet holdings:", error);
      res.status(500).json({ error: "Failed to get wallet holdings" });
    }
  });

  // Backfill signal wallet swap history from Helius
  app.post("/api/signal-wallets/:id/backfill", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Get wallet and verify ownership
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      ).limit(1);
      
      if (!wallet) {
        return res.status(404).json({ error: "Wallet not found" });
      }
      
      // Import and call backfill function
      const { backfillWalletSwaps } = await import("./helius");
      const result = await backfillWalletSwaps(wallet.walletAddress, 100);
      
      if (result.error) {
        return res.status(500).json({ error: result.error });
      }
      
      // Get current SOL price for new swaps, and historical prices for existing swaps
      const { getSolPriceUsd, getHistoricalSolPrice } = await import("./jupiter");
      const currentSolPrice = await getSolPriceUsd();
      
      // Store swaps that don't already exist, and update existing swaps with missing metadata
      let stored = 0;
      let updated = 0;
      for (const swap of result.swaps) {
        try {
          // Check if swap already exists
          const existing = await db.select({ 
            id: swaps.id, 
            fromTokenSymbol: swaps.fromTokenSymbol, 
            toTokenSymbol: swaps.toTokenSymbol,
            fromToken: swaps.fromToken,
            toToken: swaps.toToken,
            solPriceAtTrade: swaps.solPriceAtTrade,
            timestamp: swaps.timestamp,
          }).from(swaps)
            .where(eq(swaps.signature, swap.signature))
            .limit(1);
          
          if (existing.length === 0) {
            // Enrich token symbols from DexScreener if unknown
            let fromSymbol = swap.fromTokenSymbol;
            let toSymbol = swap.toTokenSymbol;
            
            if (!isBaseCurrency(swap.fromToken) && (fromSymbol === "???" || fromSymbol?.includes("..."))) {
              const meta = await fetchTokenMetadata(swap.fromToken);
              if (meta?.symbol) fromSymbol = meta.symbol;
            }
            if (!isBaseCurrency(swap.toToken) && (toSymbol === "???" || toSymbol?.includes("..."))) {
              const meta = await fetchTokenMetadata(swap.toToken);
              if (meta?.symbol) toSymbol = meta.symbol;
            }
            
            await db.insert(swaps).values({
              userId: req.userId,
              signature: swap.signature,
              timestamp: swap.timestamp,
              type: swap.type,
              source: swap.source,
              fromToken: swap.fromToken,
              fromTokenSymbol: fromSymbol,
              fromAmount: swap.fromAmount,
              toToken: swap.toToken,
              toTokenSymbol: toSymbol,
              toAmount: swap.toAmount,
              fee: swap.fee || null,
              slot: swap.slot,
              solPriceAtTrade: currentSolPrice,
              notificationSent: true, // Don't notify for backfilled swaps
            });
            stored++;
          } else {
            // Update existing swap if it has missing metadata (??? or missing SOL price)
            const existingSwap = existing[0];
            const needsFromUpdate = existingSwap.fromTokenSymbol === "???" || existingSwap.fromTokenSymbol?.includes("...");
            const needsToUpdate = existingSwap.toTokenSymbol === "???" || existingSwap.toTokenSymbol?.includes("...");
            const needsPriceUpdate = existingSwap.solPriceAtTrade === null || existingSwap.solPriceAtTrade === undefined;
            
            if (needsFromUpdate || needsToUpdate || needsPriceUpdate) {
              const updates: { fromTokenSymbol?: string; toTokenSymbol?: string; solPriceAtTrade?: number } = {};
              
              if (needsFromUpdate && !isBaseCurrency(existingSwap.fromToken)) {
                const meta = await fetchTokenMetadata(existingSwap.fromToken);
                if (meta?.symbol) updates.fromTokenSymbol = meta.symbol;
              }
              if (needsToUpdate && !isBaseCurrency(existingSwap.toToken)) {
                const meta = await fetchTokenMetadata(existingSwap.toToken);
                if (meta?.symbol) updates.toTokenSymbol = meta.symbol;
              }
              if (needsPriceUpdate && existingSwap.timestamp) {
                // Try to get historical price from Binance, fall back to current
                const historicalPrice = await getHistoricalSolPrice(existingSwap.timestamp);
                updates.solPriceAtTrade = historicalPrice || currentSolPrice;
              } else if (needsPriceUpdate) {
                updates.solPriceAtTrade = currentSolPrice;
              }
              
              if (Object.keys(updates).length > 0) {
                await db.update(swaps).set(updates).where(eq(swaps.id, existingSwap.id));
                updated++;
              }
            }
          }
        } catch (e) {
          // Ignore duplicate key errors
        }
      }
      
      res.json({
        success: true,
        walletAddress: wallet.walletAddress,
        swapsFound: result.swaps.length,
        swapsStored: stored,
        swapsUpdated: updated,
      });
    } catch (error) {
      console.error("Error backfilling signal wallet:", error);
      res.status(500).json({ error: "Failed to backfill wallet history" });
    }
  });

  // Get wallet rule defaults
  app.get("/api/signal-wallets/:id/rule-defaults", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Verify wallet ownership
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      );
      
      if (!wallet) {
        return res.status(404).json({ error: "Signal wallet not found" });
      }
      
      // Get existing rule defaults or return null (will use system defaults)
      const [defaults] = await db.select().from(walletRuleDefaults).where(
        and(eq(walletRuleDefaults.walletId, walletId), eq(walletRuleDefaults.userId, req.userId!))
      );
      
      res.json(defaults || null);
    } catch (error) {
      console.error("Error fetching wallet rule defaults:", error);
      res.status(500).json({ error: "Failed to fetch rule defaults" });
    }
  });

  // Create or update wallet rule defaults - using partial of shared schema
  const updateRuleDefaultsSchema = insertWalletRuleDefaultsSchema
    .pick({
      takeProfitThresholds: true,
      takeProfitPercentages: true,
      stopLossPercent: true,
      stopLossFloorUsd: true,
      stopLossMode: true,
      autoMirrorSells: true,
      autonomyEnabled: true,
    })
    .partial();

  app.put("/api/signal-wallets/:id/rule-defaults", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      // Validate request body
      const validationResult = updateRuleDefaultsSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid input", details: validationResult.error.errors });
      }
      const { takeProfitThresholds, takeProfitPercentages, stopLossPercent, stopLossFloorUsd, stopLossMode, autoMirrorSells, autonomyEnabled } = validationResult.data;
      
      // Verify wallet ownership
      const [wallet] = await db.select().from(monitoredWallets).where(
        and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, req.userId!))
      );
      
      if (!wallet) {
        return res.status(404).json({ error: "Signal wallet not found" });
      }
      
      // Check if defaults already exist (get first one if multiple due to lack of unique constraint)
      const existingDefaults = await db.select().from(walletRuleDefaults).where(
        and(eq(walletRuleDefaults.walletId, walletId), eq(walletRuleDefaults.userId, req.userId!))
      ).limit(1);
      const existing = existingDefaults[0];
      
      if (existing) {
        // Update existing
        const [updated] = await db.update(walletRuleDefaults)
          .set({
            takeProfitThresholds: takeProfitThresholds ?? existing.takeProfitThresholds,
            takeProfitPercentages: takeProfitPercentages ?? existing.takeProfitPercentages,
            stopLossPercent: stopLossPercent ?? existing.stopLossPercent,
            stopLossFloorUsd: stopLossFloorUsd !== undefined ? stopLossFloorUsd : existing.stopLossFloorUsd,
            stopLossMode: stopLossMode ?? existing.stopLossMode,
            autoMirrorSells: autoMirrorSells ?? existing.autoMirrorSells,
            autonomyEnabled: autonomyEnabled ?? existing.autonomyEnabled,
            updatedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(walletRuleDefaults.id, existing.id))
          .returning();
        res.json(updated);
      } else {
        // Create new
        const [created] = await db.insert(walletRuleDefaults).values({
          walletId,
          userId: req.userId!,
          takeProfitThresholds: takeProfitThresholds ?? [4, 10, 25, 100],
          takeProfitPercentages: takeProfitPercentages ?? [25, 25, 25, 25],
          stopLossPercent: stopLossPercent ?? 50,
          stopLossFloorUsd: stopLossFloorUsd ?? null,
          stopLossMode: stopLossMode ?? "auto",
          autoMirrorSells: autoMirrorSells ?? false,
          autonomyEnabled: autonomyEnabled ?? false,
          createdAt: Math.floor(Date.now() / 1000),
        }).returning();
        res.json(created);
      }
    } catch (error) {
      console.error("Error updating wallet rule defaults:", error);
      res.status(500).json({ error: "Failed to update rule defaults" });
    }
  });

  // Update position rule source (inherit vs override)
  const updateRuleSourceSchema = z.object({
    ruleSource: z.enum(["inherited", "override"]),
  });

  app.patch("/api/positions/:id/rule-source", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const positionId = parseInt(req.params.id);
      
      // Validate request body
      const validationResult = updateRuleSourceSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Invalid rule source. Must be 'inherited' or 'override'" });
      }
      const { ruleSource } = validationResult.data;
      
      // Verify position ownership
      const [position] = await db.select().from(holdings).where(
        and(eq(holdings.id, positionId), eq(holdings.userId, req.userId!))
      );
      
      if (!position) {
        return res.status(404).json({ error: "Position not found" });
      }
      
      const [updated] = await db.update(holdings)
        .set({ ruleSource })
        .where(eq(holdings.id, positionId))
        .returning();
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating position rule source:", error);
      res.status(500).json({ error: "Failed to update rule source" });
    }
  });

  // Backfill missing token metadata for existing swaps (admin only)
  let lastBackfillTime = 0;
  app.post("/api/admin/backfill-swap-metadata", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      // Rate limit: max once per 60 seconds
      const now = Date.now();
      if (now - lastBackfillTime < 60000) {
        return res.status(429).json({ 
          error: "Rate limited - wait 60 seconds between backfill requests",
          waitSeconds: Math.ceil((60000 - (now - lastBackfillTime)) / 1000)
        });
      }
      lastBackfillTime = now;
      
      // Find swaps with missing token symbols
      const swapsWithMissingData = await db.select()
        .from(swaps)
        .where(
          or(
            eq(swaps.fromTokenSymbol, "???"),
            eq(swaps.toTokenSymbol, "???"),
            like(swaps.fromTokenSymbol, "%...%"),
            like(swaps.toTokenSymbol, "%...%")
          )
        )
        .limit(50); // Reduced limit for safety
      
      // Cache metadata lookups to avoid duplicate API calls for same mint
      const metadataCache = new Map<string, { symbol?: string } | null>();
      
      const getMetadataCached = async (mint: string) => {
        if (metadataCache.has(mint)) return metadataCache.get(mint);
        const meta = await fetchTokenMetadata(mint);
        metadataCache.set(mint, meta);
        return meta;
      };
      
      let updated = 0;
      for (const swap of swapsWithMissingData) {
        let fromSymbol = swap.fromTokenSymbol;
        let toSymbol = swap.toTokenSymbol;
        let hasUpdate = false;
        
        // Fetch fromToken metadata if needed
        if (!isBaseCurrency(swap.fromToken) && (fromSymbol === "???" || fromSymbol?.includes("..."))) {
          const meta = await getMetadataCached(swap.fromToken);
          if (meta?.symbol) {
            fromSymbol = meta.symbol;
            hasUpdate = true;
          }
        }
        
        // Fetch toToken metadata if needed
        if (!isBaseCurrency(swap.toToken) && (toSymbol === "???" || toSymbol?.includes("..."))) {
          const meta = await getMetadataCached(swap.toToken);
          if (meta?.symbol) {
            toSymbol = meta.symbol;
            hasUpdate = true;
          }
        }
        
        if (hasUpdate) {
          await db.update(swaps)
            .set({ fromTokenSymbol: fromSymbol, toTokenSymbol: toSymbol })
            .where(eq(swaps.id, swap.id));
          updated++;
        }
      }
      
      res.json({
        success: true,
        checked: swapsWithMissingData.length,
        updated,
        remaining: swapsWithMissingData.length === 50 ? "More swaps may need updating - run again" : "None",
        message: updated > 0 ? `Updated ${updated} swaps with token metadata` : "All swaps already have metadata"
      });
    } catch (error) {
      console.error("Error backfilling swap metadata:", error);
      res.status(500).json({ error: "Failed to backfill swap metadata" });
    }
  });

  // Debug: list webhooks
  app.get("/api/webhooks", async (req, res) => {
    const webhooks = await getWebhooks();
    res.json(webhooks);
  });

  // ==================== Copy Trading Routes ====================

  // Get or create hot wallet
  app.get("/api/copy-trade/wallet", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const wallet = await getOrCreateHotWallet(req.userId!);
      if (!wallet) {
        return res.json({ exists: false });
      }
      const balance = await getHotWalletBalance(req.userId!);
      res.json({ exists: true, publicKey: wallet.publicKey, balance, createdAt: wallet.createdAt });
    } catch (error) {
      console.error("Error getting hot wallet:", error);
      res.status(500).json({ error: "Failed to get wallet" });
    }
  });

  // Create hot wallet
  app.post("/api/copy-trade/wallet", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const wallet = await createHotWallet(req.userId!);
      const balance = await getHotWalletBalance(req.userId!);
      res.json({ success: true, publicKey: wallet.publicKey, balance, createdAt: wallet.createdAt });
    } catch (error) {
      console.error("Error creating hot wallet:", error);
      res.status(500).json({ error: "Failed to create wallet" });
    }
  });

  // Get hot wallet balance
  app.get("/api/copy-trade/balance", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const balance = await getHotWalletBalance(req.userId!);
      res.json({ balance });
    } catch (error) {
      console.error("Error getting balance:", error);
      res.status(500).json({ error: "Failed to get balance" });
    }
  });

  // Get trade config
  app.get("/api/copy-trade/config", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const config = await getTradeConfig(req.userId!);
      res.json(config);
    } catch (error) {
      console.error("Error getting trade config:", error);
      res.status(500).json({ error: "Failed to get config" });
    }
  });

  // Update trade config
  app.patch("/api/copy-trade/config", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const config = await updateTradeConfig(req.userId!, req.body);
      res.json(config);
    } catch (error) {
      console.error("Error updating trade config:", error);
      res.status(500).json({ error: "Failed to update config" });
    }
  });

  // Get holdings
  app.get("/api/copy-trade/holdings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const holdingsList = await getHoldings(req.userId!);
      res.json(holdingsList);
    } catch (error) {
      console.error("Error getting holdings:", error);
      res.status(500).json({ error: "Failed to get holdings" });
    }
  });

  // Get pending buys
  app.get("/api/copy-trade/pending", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const pending = await getPendingBuys(req.userId!);
      res.json(pending);
    } catch (error) {
      console.error("Error getting pending buys:", error);
      res.status(500).json({ error: "Failed to get pending buys" });
    }
  });

  // Pause a pending buy
  app.post("/api/copy-trade/pending/:pendingId/pause", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const pendingId = parseInt(req.params.pendingId);
      if (isNaN(pendingId)) {
        return res.status(400).json({ error: "Invalid pending buy ID" });
      }
      const { userPausePendingBuy } = await import("./trade-processor");
      const success = await userPausePendingBuy(pendingId, req.userId!);
      if (!success) {
        return res.status(400).json({ error: "Could not pause pending buy (may already be paused, cancelled, or completed)" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error pausing pending buy:", error);
      res.status(500).json({ error: "Failed to pause pending buy" });
    }
  });

  // Resume a paused pending buy
  app.post("/api/copy-trade/pending/:pendingId/resume", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const pendingId = parseInt(req.params.pendingId);
      if (isNaN(pendingId)) {
        return res.status(400).json({ error: "Invalid pending buy ID" });
      }
      const { userResumePendingBuy } = await import("./trade-processor");
      const success = await userResumePendingBuy(pendingId, req.userId!);
      if (!success) {
        return res.status(400).json({ error: "Could not resume pending buy (may not be paused)" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error resuming pending buy:", error);
      res.status(500).json({ error: "Failed to resume pending buy" });
    }
  });

  // Cancel a pending buy
  app.post("/api/copy-trade/pending/:pendingId/cancel", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const pendingId = parseInt(req.params.pendingId);
      if (isNaN(pendingId)) {
        return res.status(400).json({ error: "Invalid pending buy ID" });
      }
      const { userCancelPendingBuy } = await import("./trade-processor");
      const success = await userCancelPendingBuy(pendingId, req.userId!);
      if (!success) {
        return res.status(400).json({ error: "Could not cancel pending buy (may already be cancelled, completed, or not found)" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling pending buy:", error);
      res.status(500).json({ error: "Failed to cancel pending buy" });
    }
  });

  // Withdraw SOL from hot wallet
  const withdrawSchema = z.object({
    destination: z.string().min(32).max(44),
    amount: z.number().positive().finite(),
  });
  
  app.post("/api/copy-trade/withdraw", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = withdrawSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid destination address and amount are required" });
      }
      
      const { destination, amount } = parsed.data;
      
      const result = await withdrawSol(req.userId!, destination, amount);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      res.json({ 
        success: true, 
        signature: result.signature,
        amount: result.amount 
      });
    } catch (error) {
      console.error("Error withdrawing SOL:", error);
      res.status(500).json({ error: "Failed to withdraw SOL" });
    }
  });

  // Export hot wallet private key (requires password confirmation)
  app.post("/api/copy-trade/wallet/export-key", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { password } = req.body;
      
      if (!password) {
        return res.status(400).json({ error: "Password is required" });
      }
      
      // Verify password
      const user = await authenticateUser(req.username!, password);
      if (!user) {
        return res.status(401).json({ error: "Invalid password" });
      }
      
      const privateKey = await exportHotWalletPrivateKey(req.userId!);
      
      if (!privateKey) {
        return res.status(404).json({ error: "No wallet found" });
      }
      
      res.json({ privateKey });
    } catch (error) {
      console.error("Error exporting hot wallet key:", error);
      res.status(500).json({ error: "Failed to export key" });
    }
  });

  // Export token wallet private key for a holding (requires password confirmation)
  app.post("/api/copy-trade/holdings/:holdingId/export-key", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const holdingId = parseInt(req.params.holdingId);
      const { password } = req.body;
      
      if (!password || isNaN(holdingId)) {
        return res.status(400).json({ error: "Password and valid holding ID are required" });
      }
      
      // Verify password
      const user = await authenticateUser(req.username!, password);
      if (!user) {
        return res.status(401).json({ error: "Invalid password" });
      }
      
      const privateKey = await exportTokenWalletPrivateKey(holdingId, req.userId!);
      
      if (!privateKey) {
        return res.status(404).json({ error: "No token wallet found for this holding" });
      }
      
      res.json({ privateKey });
    } catch (error) {
      console.error("Error exporting token wallet key:", error);
      res.status(500).json({ error: "Failed to export key" });
    }
  });

  // Manually sell a token holding
  const sellSchema = z.object({
    percentage: z.number().min(1).max(100).optional().default(100),
  });
  
  app.post("/api/copy-trade/sell/:holdingId", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const holdingId = parseInt(req.params.holdingId);
      if (isNaN(holdingId)) {
        return res.status(400).json({ error: "Invalid holding ID" });
      }
      
      const parsed = sellSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Percentage must be between 1 and 100" });
      }
      
      const sellPercentage = parsed.data.percentage;
      
      const holdingRows = await db.select().from(holdings).where(
        and(eq(holdings.id, holdingId), eq(holdings.userId, req.userId!))
      );
      
      if (holdingRows.length === 0) {
        return res.status(404).json({ error: "Holding not found" });
      }
      
      const holding = holdingRows[0];
      const tokensToSell = holding.currentAmount * (sellPercentage / 100);
      
      if (tokensToSell <= 0) {
        return res.status(400).json({ error: "No tokens to sell" });
      }
      
      console.log(`Manual sell: ${tokensToSell.toLocaleString()} tokens of ${holding.tokenSymbol} (${sellPercentage}%)`);
      
      let result;
      
      // Use token wallet if available, otherwise fall back to main wallet
      if (holding.tokenWalletEncryptedKey) {
        const tokenWalletKeypair = getTokenWalletKeypair(holding.tokenWalletEncryptedKey);
        if (!tokenWalletKeypair) {
          console.error(`Failed to decrypt token wallet for ${holding.tokenSymbol}, falling back to main wallet`);
          // Fallback to main wallet if token wallet decryption fails
          result = await sellToken(req.userId!, holding.tokenMint, tokensToSell);
        } else {
          result = await sellTokenWithWallet(tokenWalletKeypair, holding.tokenMint, tokensToSell);
          
          // Send profits back to main wallet (keep 4x gas reserve)
          if (result.success) {
            const mainWallet = await getOrCreateHotWallet(req.userId!);
            if (mainWallet) {
              const gasReserve = priorityFeeToSol(await estimatePriorityFee());
              const profitResult = await sendProfitsToMainWallet(
                tokenWalletKeypair,
                mainWallet.publicKey,
                gasReserve
              );
              if (profitResult.success && profitResult.amountSent && profitResult.amountSent > 0) {
                console.log(`Sent ${profitResult.amountSent.toFixed(4)} SOL profits to main wallet`);
              }
            }
          }
        }
      } else {
        // Legacy: use main wallet
        result = await sellToken(req.userId!, holding.tokenMint, tokensToSell);
      }
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      const newAmount = holding.currentAmount - tokensToSell;
      
      await db.update(holdings).set({
        currentAmount: newAmount,
      }).where(eq(holdings.id, holdingId));
      
      // Resolve position score snapshots for learning
      const currentPrice = result.inputAmount ? (result.inputAmount / tokensToSell) : 0;
      const entryPrice = holding.avgEntryPrice || holding.buyPrice || 0;
      const outcomeType = entryPrice > 0 && currentPrice >= entryPrice ? "profit_exit" : "loss_exit";
      try {
        await resolvePositionScoreSnapshots(holdingId, currentPrice, outcomeType);
      } catch (e) {
        console.error(`Failed to resolve position snapshots:`, e);
      }
      
      if (sellPercentage === 100 && holding.sourceWalletAddress && holding.buyPrice > 0) {
        try {
          const { updateSignalWalletProfile } = await import("./signal-wallet-profiler");
          const currentPrice = result.inputAmount ? (result.inputAmount / tokensToSell) : 0;
          if (currentPrice > 0) {
            const multiplier = currentPrice / holding.buyPrice;
            const holdTimeMinutes = Math.floor((Date.now() / 1000 - holding.buyTimestamp) / 60);
            await updateSignalWalletProfile(holding.sourceWalletAddress, multiplier, holdTimeMinutes);
            console.log(`Updated signal wallet profile for manual sell: ${holding.sourceWalletAddress} - ${multiplier.toFixed(2)}x`);
          }
        } catch (error) {
          console.error("Failed to update signal wallet profile:", error);
        }
      }
      
      // Record trade result for autonomous mode (proportional cost basis)
      try {
        const { getSolPriceUsd } = await import("./jupiter");
        const { recordTradeResult } = await import("./autonomous-mode");
        const solPrice = await getSolPriceUsd();
        const percentSold = sellPercentage / 100;
        const proportionalCostSol = (holding.solSpent || 0) * percentSold;
        const profitSol = (result.inputAmount || 0) - proportionalCostSol;
        const profitUsd = profitSol * solPrice;
        await recordTradeResult(req.userId!, profitUsd);
      } catch (e) {
        console.error("Failed to record manual sell trade result:", e);
      }
      
      res.json({ 
        success: true, 
        signature: result.signature,
        tokensSold: tokensToSell,
        remainingTokens: newAmount,
        solReceived: result.inputAmount
      });
    } catch (error) {
      console.error("Error selling token:", error);
      res.status(500).json({ error: "Failed to sell token" });
    }
  });

  // Update position risk settings (take-profit/stop-loss)
  const updatePositionRiskSchema = z.object({
    takeProfitThresholds: z.array(z.number().min(1)).optional(), // [4, 10, 25, 100]
    takeProfitPercentages: z.array(z.number().min(1).max(100)).optional(), // [25, 25, 25, 25]
    stopLossPercent: z.number().min(1).max(100).optional(),
    stopLossFloorUsd: z.number().min(0).optional(),
  }).refine(data => {
    // Validate matching lengths if both provided
    if (data.takeProfitThresholds && data.takeProfitPercentages) {
      return data.takeProfitThresholds.length === data.takeProfitPercentages.length;
    }
    return true;
  }, { message: "Take-profit thresholds and percentages must have matching lengths" });

  app.patch("/api/positions/:holdingId/risk", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const holdingId = parseInt(req.params.holdingId);
      if (isNaN(holdingId)) {
        return res.status(400).json({ error: "Invalid holding ID" });
      }

      const parsed = updatePositionRiskSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid risk settings", details: parsed.error.errors });
      }

      const holdingRows = await db.select().from(holdings).where(
        and(eq(holdings.id, holdingId), eq(holdings.userId, req.userId!))
      );

      if (holdingRows.length === 0) {
        return res.status(404).json({ error: "Position not found" });
      }

      const updates: Partial<typeof holdings.$inferInsert> = {};
      if (parsed.data.takeProfitThresholds) {
        updates.takeProfitThresholds = parsed.data.takeProfitThresholds;
      }
      if (parsed.data.takeProfitPercentages) {
        updates.takeProfitPercentages = parsed.data.takeProfitPercentages;
      }
      if (parsed.data.stopLossPercent !== undefined) {
        updates.stopLossPercent = parsed.data.stopLossPercent;
      }
      if (parsed.data.stopLossFloorUsd !== undefined) {
        updates.stopLossFloorUsd = parsed.data.stopLossFloorUsd;
      }

      await db.update(holdings).set(updates).where(eq(holdings.id, holdingId));

      const updatedRows = await db.select().from(holdings).where(eq(holdings.id, holdingId));
      
      console.log(`Updated risk settings for position ${holdingId}: TP thresholds=${JSON.stringify(parsed.data.takeProfitThresholds)}, SL=${parsed.data.stopLossPercent}%`);
      
      res.json({ success: true, position: updatedRows[0] });
    } catch (error) {
      console.error("Error updating position risk settings:", error);
      res.status(500).json({ error: "Failed to update position risk settings" });
    }
  });

  // Manual buy endpoint - buy any token by mint address
  // Supports: action="new" (create new position), action="topup" (add to existing), positionId (specific position to top up)
  const manualBuySchema = z.object({
    tokenMint: z.string().min(32).max(44),
    solAmount: z.number().positive().finite().max(100),
    action: z.enum(["new", "topup", "auto"]).optional().default("auto"),
    positionId: z.number().optional(),
  });
  
  app.post("/api/copy-trade/manual-buy", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = manualBuySchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid token mint and SOL amount are required" });
      }
      
      const { tokenMint, solAmount, action, positionId } = parsed.data;
      
      // Find existing manual positions for this token
      const existingPositions = await db.select().from(holdings).where(
        and(
          eq(holdings.tokenMint, tokenMint), 
          eq(holdings.userId, req.userId!),
          eq(holdings.reclaimed, false)
        )
      );
      
      const manualPositions = existingPositions.filter(p => p.positionSource === "manual" || !p.positionSource);
      
      // If action is "new", always create new position
      // If action is "topup", find position to top up
      // If action is "auto", top up if exactly one manual position exists, otherwise create new
      let targetPosition: typeof existingPositions[0] | null = null;
      let isTopUp = false;
      
      if (action === "topup") {
        if (positionId) {
          targetPosition = existingPositions.find(p => p.id === positionId) || null;
          if (!targetPosition) {
            return res.status(404).json({ error: "Position not found" });
          }
          // Only allow topping up manual positions via manual buy
          if (targetPosition.positionSource && targetPosition.positionSource !== "manual") {
            return res.status(400).json({ 
              error: `Cannot manually top up ${targetPosition.positionSource} position. Use copy trading for copy positions.`
            });
          }
        } else if (manualPositions.length === 1) {
          targetPosition = manualPositions[0];
        } else if (manualPositions.length > 1) {
          return res.status(400).json({ 
            error: "Multiple positions exist. Specify positionId to top up.",
            positions: manualPositions.map(p => ({
              id: p.id,
              tokenSymbol: p.tokenSymbol,
              currentAmount: p.currentAmount,
              solSpent: p.solSpent,
              positionSource: p.positionSource
            }))
          });
        } else {
          return res.status(400).json({ error: "No existing manual position to top up" });
        }
        isTopUp = true;
      } else if (action === "auto" && manualPositions.length === 1) {
        targetPosition = manualPositions[0];
        isTopUp = true;
      }
      
      // Check autonomous mode stop conditions before executing buy
      const { canExecuteTrade } = await import("./autonomous-mode");
      const tradeCheck = await canExecuteTrade(req.userId!);
      if (!tradeCheck.allowed) {
        console.log(`[Autonomous] Manual buy blocked: ${tradeCheck.reason}`);
        return res.status(400).json({ error: `Trade blocked by autonomous mode: ${tradeCheck.reason}` });
      }
      
      // Check hot wallet balance
      const balance = await getHotWalletBalance(req.userId!);
      if (balance < solAmount + 0.005) {
        return res.status(400).json({ error: `Insufficient balance. Have ${balance.toFixed(4)} SOL, need ${(solAmount + 0.005).toFixed(4)} SOL` });
      }
      
      // Get token info from DexScreener before buying
      const tokenPrice = await getTokenPrice(tokenMint);
      const tokenInfo = await getTokenInfo(tokenMint);
      
      // Require valid price to prevent division by zero in multiplier calculations
      if (!tokenPrice || tokenPrice <= 0 || !isFinite(tokenPrice)) {
        return res.status(400).json({ error: "Cannot determine token price. Try again later or check token mint address." });
      }
      
      console.log(`Manual buy: ${solAmount} SOL for token ${tokenMint} at price ${tokenPrice}, action: ${action}, topUp: ${isTopUp}`);
      
      const result = await buyToken(req.userId!, tokenMint, solAmount);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      const now = Math.floor(Date.now() / 1000);
      const tokensReceived = result.outputAmount || 0;
      const solSpentActual = result.inputAmount || solAmount;
      
      if (isTopUp && targetPosition) {
        // Top up existing position
        const prevTotalSol = targetPosition.totalSolInvested ?? targetPosition.solSpent;
        const prevTotalTokens = targetPosition.totalTokensBought ?? targetPosition.amountBought;
        const prevBuys = targetPosition.totalBuys ?? 1;
        
        const newTotalSol = prevTotalSol + solSpentActual;
        const newTotalTokens = prevTotalTokens + tokensReceived;
        const newCurrentAmount = targetPosition.currentAmount + tokensReceived;
        const newBuys = prevBuys + 1;
        const newAvgPrice = newTotalSol / newTotalTokens;
        
        await db.update(holdings).set({
          currentAmount: newCurrentAmount,
          amountBought: targetPosition.amountBought + tokensReceived,
          solSpent: targetPosition.solSpent + solSpentActual,
          avgEntryPrice: newAvgPrice,
          totalBuys: newBuys,
          totalTokensBought: newTotalTokens,
          totalSolInvested: newTotalSol,
          lastTopUpTimestamp: now,
          lastPrice: tokenPrice,
          lastPriceCheck: now,
        }).where(eq(holdings.id, targetPosition.id));
        
        res.json({ 
          success: true, 
          action: "topped_up",
          positionId: targetPosition.id,
          signature: result.signature,
          tokenSymbol: tokenInfo?.symbol || targetPosition.tokenSymbol,
          tokensBought: tokensReceived,
          solSpent: solSpentActual,
          newTotalBuys: newBuys,
          newTotalSolInvested: newTotalSol,
          newAvgEntryPrice: newAvgPrice,
          newCurrentAmount: newCurrentAmount
        });
      } else {
        // Create new holding record
        const [newHolding] = await db.insert(holdings).values({
          userId: req.userId!,
          tokenMint: tokenMint,
          tokenSymbol: tokenInfo?.symbol || "UNKNOWN",
          tokenName: tokenInfo?.name || "Unknown Token",
          amountBought: tokensReceived,
          solSpent: solSpentActual,
          buyPrice: tokenPrice || 0,
          buyTimestamp: now,
          buySignature: result.signature || "",
          currentAmount: tokensReceived,
          reclaimed: false,
          lastPriceCheck: now,
          lastPrice: tokenPrice,
          highestMultiplier: 1,
          alertedMilestones: [],
          positionSource: "manual",
          totalBuys: 1,
          avgEntryPrice: tokenPrice,
          totalTokensBought: tokensReceived,
          totalSolInvested: solSpentActual,
        }).returning();
        
        res.json({ 
          success: true,
          action: "new_position",
          positionId: newHolding.id,
          signature: result.signature,
          tokenSymbol: tokenInfo?.symbol || "UNKNOWN",
          tokensBought: tokensReceived,
          solSpent: solSpentActual
        });
      }
    } catch (error) {
      console.error("Error in manual buy:", error);
      res.status(500).json({ error: "Failed to execute manual buy" });
    }
  });
  
  // Get positions for a token - shows all positions user has for this token
  app.get("/api/positions/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { tokenMint } = req.params;
      
      const positions = await db.select().from(holdings).where(
        and(
          eq(holdings.tokenMint, tokenMint),
          eq(holdings.userId, req.userId!),
          eq(holdings.reclaimed, false)
        )
      );
      
      res.json(positions.map(p => ({
        id: p.id,
        tokenMint: p.tokenMint,
        tokenSymbol: p.tokenSymbol,
        tokenName: p.tokenName,
        currentAmount: p.currentAmount,
        solSpent: p.solSpent,
        buyPrice: p.buyPrice,
        avgEntryPrice: p.avgEntryPrice ?? p.buyPrice,
        totalBuys: p.totalBuys ?? 1,
        totalSolInvested: p.totalSolInvested ?? p.solSpent,
        positionSource: p.positionSource ?? "unknown",
        signalWalletId: p.signalWalletId,
        sourceWalletAddress: p.sourceWalletAddress,
        sourceWalletLabel: p.sourceWalletLabel,
        buyTimestamp: p.buyTimestamp,
        lastTopUpTimestamp: p.lastTopUpTimestamp,
        lastPrice: p.lastPrice,
        highestMultiplier: p.highestMultiplier,
      })));
    } catch (error) {
      console.error("Error getting positions:", error);
      res.status(500).json({ error: "Failed to get positions" });
    }
  });

  // ==================== Token Blacklist Routes ====================

  // Get user's token blacklist
  app.get("/api/blacklist", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const list = await getBlacklist(req.userId!);
      res.json(list);
    } catch (error) {
      console.error("Error getting blacklist:", error);
      res.status(500).json({ error: "Failed to get blacklist" });
    }
  });

  // Add token to blacklist
  app.post("/api/blacklist", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { tokenMint, tokenSymbol, reason } = req.body;
      if (!tokenMint || typeof tokenMint !== "string") {
        return res.status(400).json({ error: "Token mint address required" });
      }
      
      const added = await addToBlacklist(req.userId!, tokenMint, tokenSymbol, reason);
      if (!added) {
        return res.status(409).json({ error: "Token already blacklisted" });
      }
      
      res.json({ success: true, message: `Added ${tokenSymbol || tokenMint.slice(0,8)} to blacklist` });
    } catch (error) {
      console.error("Error adding to blacklist:", error);
      res.status(500).json({ error: "Failed to add to blacklist" });
    }
  });

  // Remove token from blacklist
  app.delete("/api/blacklist/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { tokenMint } = req.params;
      await removeFromBlacklist(req.userId!, tokenMint);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing from blacklist:", error);
      res.status(500).json({ error: "Failed to remove from blacklist" });
    }
  });

  // Check if token is blacklisted
  app.get("/api/blacklist/check/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { tokenMint } = req.params;
      const blacklisted = await isTokenBlacklisted(req.userId!, tokenMint);
      res.json({ blacklisted });
    } catch (error) {
      console.error("Error checking blacklist:", error);
      res.status(500).json({ error: "Failed to check blacklist" });
    }
  });

  // ==================== Admin Routes ====================

  // Get all users (admin only)
  app.get("/api/admin/users", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error getting users:", error);
      res.status(500).json({ error: "Failed to get users" });
    }
  });

  // Delete a user (admin only)
  app.delete("/api/admin/users/:userId", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = parseInt(req.params.userId);
      if (isNaN(userId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }
      
      // Prevent admin from deleting themselves
      if (userId === req.userId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }
      
      await storage.deleteUser(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // Get all monitored wallets across all users (admin only)
  app.get("/api/admin/wallets", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const wallets = await storage.getAllWalletsAdmin();
      res.json(wallets);
    } catch (error) {
      console.error("Error getting all wallets:", error);
      res.status(500).json({ error: "Failed to get wallets" });
    }
  });

  // Get system statistics (admin only)
  app.get("/api/admin/stats", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const stats = await storage.getAdminStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting stats:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  // ==================== Admin Wallet Approval Routes ====================

  // Get pending wallet submissions (admin only)
  app.get("/api/admin/pending-wallets", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const pendingWallets = await db.select()
        .from(monitoredWallets)
        .where(and(
          eq(monitoredWallets.isShared, true),
          eq(monitoredWallets.shareStatus, "pending")
        ));

      // Get user info for each wallet
      const walletsWithInfo = await Promise.all(pendingWallets.map(async (wallet) => {
        const user = await storage.getUserById(wallet.userId);
        return {
          ...wallet,
          username: user?.username || "Unknown",
          aiScoreDetails: wallet.aiScoreDetails ? JSON.parse(wallet.aiScoreDetails) : null,
        };
      }));

      res.json(walletsWithInfo);
    } catch (error) {
      console.error("Error getting pending wallets:", error);
      res.status(500).json({ error: "Failed to get pending wallets" });
    }
  });

  // Approve wallet for community sharing (admin only)
  app.post("/api/admin/wallets/:id/approve", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      await db.update(monitoredWallets)
        .set({ shareStatus: "approved" })
        .where(eq(monitoredWallets.id, walletId));

      res.json({ success: true });
    } catch (error) {
      console.error("Error approving wallet:", error);
      res.status(500).json({ error: "Failed to approve wallet" });
    }
  });

  // Reject wallet for community sharing (admin only)
  app.post("/api/admin/wallets/:id/reject", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      await db.update(monitoredWallets)
        .set({ shareStatus: "rejected" })
        .where(eq(monitoredWallets.id, walletId));

      res.json({ success: true });
    } catch (error) {
      console.error("Error rejecting wallet:", error);
      res.status(500).json({ error: "Failed to reject wallet" });
    }
  });

  // Refresh AI score for a wallet (admin only)
  app.post("/api/admin/wallets/:id/rescore", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      
      const wallet = await db.select()
        .from(monitoredWallets)
        .where(eq(monitoredWallets.id, walletId))
        .limit(1);

      if (wallet.length === 0) {
        return res.status(404).json({ error: "Wallet not found" });
      }

      const { scoreWallet } = await import("./ai");
      const score = await scoreWallet(wallet[0].walletAddress);

      if (score) {
        await db.update(monitoredWallets)
          .set({
            aiScore: score.score,
            aiScoreDetails: JSON.stringify(score),
            aiScoreUpdatedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(monitoredWallets.id, walletId));

        res.json({ success: true, score });
      } else {
        res.status(500).json({ error: "Failed to score wallet" });
      }
    } catch (error) {
      console.error("Error rescoring wallet:", error);
      res.status(500).json({ error: "Failed to rescore wallet" });
    }
  });

  // ==================== Admin Messages Routes ====================

  // Get all admin messages (admin only)
  app.get("/api/admin/messages", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const messages = await storage.getAllAdminMessages();
      res.json(messages);
    } catch (error) {
      console.error("Error getting admin messages:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // Create admin message (admin only)
  app.post("/api/admin/messages", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { title, content, priority, targetUserId, expiresAt } = req.body;
      
      if (!title || !content) {
        return res.status(400).json({ error: "Title and content are required" });
      }
      
      const message = await storage.createAdminMessage({
        title,
        content,
        priority: priority || "normal",
        targetUserId: targetUserId || null,
        createdBy: req.userId!,
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: expiresAt || null,
      });
      
      res.json(message);
    } catch (error) {
      console.error("Error creating admin message:", error);
      res.status(500).json({ error: "Failed to create message" });
    }
  });

  // Delete admin message (admin only)
  app.delete("/api/admin/messages/:messageId", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const messageId = parseInt(req.params.messageId);
      await storage.deleteAdminMessage(messageId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting admin message:", error);
      res.status(500).json({ error: "Failed to delete message" });
    }
  });

  // ==================== Admin Pincher Instructions ====================
  
  // Set Miss Pincher's instructions (admin only)
  app.post("/api/admin/pincher-instructions", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { instructions } = req.body;
      
      if (typeof instructions !== 'string') {
        return res.status(400).json({ error: "Instructions must be a string" });
      }
      
      await setAdminInstructions(instructions, req.userId!);
      res.json({ success: true, message: "Pincher instructions updated" });
    } catch (error) {
      console.error("Error setting pincher instructions:", error);
      res.status(500).json({ error: "Failed to set instructions" });
    }
  });

  // ==================== Admin Chat Routes ====================
  
  app.get("/api/admin/chat", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const messages = await db.select()
        .from(adminChatMessages)
        .orderBy(adminChatMessages.createdAt)
        .limit(100);
      res.json(messages.map(m => ({ role: m.role, content: m.content })));
    } catch (error) {
      console.error("Error getting admin chat:", error);
      res.status(500).json({ error: "Failed to get chat history" });
    }
  });

  app.post("/api/admin/chat", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: "Message is required" });
      }
      const now = Math.floor(Date.now() / 1000);
      await db.insert(adminChatMessages).values({
        role: "user",
        content: message.trim(),
        createdAt: now,
      });
      const { getSystemSummaryForAdmin, chatWithAdminAI } = await import("./admin-ai");
      const systemContext = await getSystemSummaryForAdmin();
      const aiResponse = await chatWithAdminAI(message.trim(), systemContext);
      await db.insert(adminChatMessages).values({
        role: "assistant",
        content: aiResponse,
        createdAt: Math.floor(Date.now() / 1000),
      });
      res.json({ response: aiResponse });
    } catch (error) {
      console.error("Error in admin chat:", error);
      res.status(500).json({ error: "Failed to process message" });
    }
  });

  app.delete("/api/admin/chat", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      await db.delete(adminChatMessages);
      res.json({ success: true });
    } catch (error) {
      console.error("Error clearing admin chat:", error);
      res.status(500).json({ error: "Failed to clear chat" });
    }
  });

  app.get("/api/admin/system-summary", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { getSystemSummaryForAdmin } = await import("./admin-ai");
      const summary = await getSystemSummaryForAdmin();
      res.json(summary);
    } catch (error) {
      console.error("Error getting system summary:", error);
      res.status(500).json({ error: "Failed to get system summary" });
    }
  });

  // ==================== API Budget Routes (Admin Only) ====================
  
  // Get all API budget statuses
  app.get("/api/admin/api-budget", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { getAllBudgetStatuses } = await import("./api-budget");
      const statuses = await getAllBudgetStatuses();
      res.json(statuses);
    } catch (error) {
      console.error("Error getting API budget statuses:", error);
      res.status(500).json({ error: "Failed to get API budget statuses" });
    }
  });

  // Get budget status for specific service
  app.get("/api/admin/api-budget/:service", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { getBudgetStatus } = await import("./api-budget");
      const service = req.params.service as "helius" | "dexscreener" | "openai";
      const status = await getBudgetStatus(service);
      res.json(status);
    } catch (error) {
      console.error("Error getting API budget status:", error);
      res.status(500).json({ error: "Failed to get API budget status" });
    }
  });

  // Update budget config for a service
  app.patch("/api/admin/api-budget/:service", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { updateBudgetConfig, getBudgetStatus } = await import("./api-budget");
      const service = req.params.service as "helius" | "dexscreener" | "openai";
      await updateBudgetConfig(service, req.body);
      const status = await getBudgetStatus(service);
      res.json(status);
    } catch (error) {
      console.error("Error updating API budget config:", error);
      res.status(500).json({ error: "Failed to update API budget config" });
    }
  });

  // Get usage history for a service
  app.get("/api/admin/api-budget/:service/history", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { getUsageHistory } = await import("./api-budget");
      const service = req.params.service as "helius" | "dexscreener" | "openai";
      const days = parseInt(req.query.days as string) || 7;
      const history = await getUsageHistory(service, days);
      res.json(history);
    } catch (error) {
      console.error("Error getting API usage history:", error);
      res.status(500).json({ error: "Failed to get API usage history" });
    }
  });

  // ==================== User API Keys & Wallet Limits ====================

  // Get user's wallet limit info
  app.get("/api/wallet-limits", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const limits = await getUserWalletLimit(req.userId!);
      res.json(limits);
    } catch (error) {
      console.error("Error getting wallet limits:", error);
      res.status(500).json({ error: "Failed to get wallet limits" });
    }
  });

  // Get user's API keys (masked)
  app.get("/api/api-keys", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const keys = await getUserApiKeys(req.userId!);
      const maskedKeys = keys.map(k => ({
        id: k.id,
        service: k.service,
        keyLabel: k.keyLabel,
        isValid: k.isValid,
        lastValidatedAt: k.lastValidatedAt,
        createdAt: k.createdAt,
      }));
      res.json(maskedKeys);
    } catch (error) {
      console.error("Error getting API keys:", error);
      res.status(500).json({ error: "Failed to get API keys" });
    }
  });

  // Add user API key
  app.post("/api/api-keys", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { service, apiKey, keyLabel } = req.body;
      
      if (!service || !apiKey) {
        return res.status(400).json({ error: "Service and API key are required" });
      }
      
      if (!["helius", "dexscreener"].includes(service)) {
        return res.status(400).json({ error: "Invalid service. Must be 'helius' or 'dexscreener'" });
      }
      
      const key = await addUserApiKey(req.userId!, service, apiKey, keyLabel);
      
      // Validate the key immediately
      const isValid = await validateUserApiKey(key.id);
      
      res.json({
        id: key.id,
        service: key.service,
        keyLabel: key.keyLabel,
        isValid,
        createdAt: key.createdAt,
      });
    } catch (error) {
      console.error("Error adding API key:", error);
      res.status(500).json({ error: "Failed to add API key" });
    }
  });

  // Delete user API key
  app.delete("/api/api-keys/:keyId", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const keyId = parseInt(req.params.keyId);
      await removeUserApiKey(req.userId!, keyId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing API key:", error);
      res.status(500).json({ error: "Failed to remove API key" });
    }
  });

  // Revalidate user API key
  app.post("/api/api-keys/:keyId/validate", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const keyId = parseInt(req.params.keyId);
      const keys = await getUserApiKeys(req.userId!);
      const key = keys.find(k => k.id === keyId);
      
      if (!key) {
        return res.status(404).json({ error: "API key not found" });
      }
      
      const isValid = await validateUserApiKey(keyId);
      res.json({ isValid });
    } catch (error) {
      console.error("Error validating API key:", error);
      res.status(500).json({ error: "Failed to validate API key" });
    }
  });

  // ==================== Admin API Key Pool ====================

  // Get admin API key pool (masked)
  app.get("/api/admin/api-keys", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const keys = await getAdminApiKeys();
      const maskedKeys = keys.map(k => ({
        id: k.id,
        service: k.service,
        keyLabel: k.keyLabel,
        isActive: k.isActive,
        priority: k.priority,
        usageCount: k.usageCount,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      }));
      res.json(maskedKeys);
    } catch (error) {
      console.error("Error getting admin API keys:", error);
      res.status(500).json({ error: "Failed to get admin API keys" });
    }
  });

  // Add admin API key
  app.post("/api/admin/api-keys", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { service, apiKey, keyLabel, priority } = req.body;
      
      if (!service || !apiKey || !keyLabel) {
        return res.status(400).json({ error: "Service, API key, and label are required" });
      }
      
      if (!["helius", "dexscreener"].includes(service)) {
        return res.status(400).json({ error: "Invalid service. Must be 'helius' or 'dexscreener'" });
      }
      
      const key = await addAdminApiKey(service, apiKey, keyLabel, priority || 0);
      
      res.json({
        id: key.id,
        service: key.service,
        keyLabel: key.keyLabel,
        isActive: key.isActive,
        priority: key.priority,
        createdAt: key.createdAt,
      });
    } catch (error) {
      console.error("Error adding admin API key:", error);
      res.status(500).json({ error: "Failed to add admin API key" });
    }
  });

  // Delete admin API key
  app.delete("/api/admin/api-keys/:keyId", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const keyId = parseInt(req.params.keyId);
      await removeAdminApiKey(keyId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing admin API key:", error);
      res.status(500).json({ error: "Failed to remove admin API key" });
    }
  });

  // Toggle admin API key active status
  app.patch("/api/admin/api-keys/:keyId", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const keyId = parseInt(req.params.keyId);
      const { isActive } = req.body;
      
      if (typeof isActive !== "boolean") {
        return res.status(400).json({ error: "isActive must be a boolean" });
      }
      
      const key = await toggleAdminApiKey(keyId, isActive);
      if (!key) {
        return res.status(404).json({ error: "API key not found" });
      }
      
      res.json({
        id: key.id,
        service: key.service,
        keyLabel: key.keyLabel,
        isActive: key.isActive,
        priority: key.priority,
      });
    } catch (error) {
      console.error("Error toggling admin API key:", error);
      res.status(500).json({ error: "Failed to toggle admin API key" });
    }
  });

  // Get/update wallet limits config (admin only)
  app.get("/api/admin/wallet-limits", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const config = await getWalletLimitsConfig();
      res.json(config);
    } catch (error) {
      console.error("Error getting wallet limits config:", error);
      res.status(500).json({ error: "Failed to get wallet limits config" });
    }
  });

  app.patch("/api/admin/wallet-limits", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { baseWalletLimit, walletsPerApiKey, maxWalletLimit } = req.body;
      const config = await updateWalletLimitsConfig(baseWalletLimit, walletsPerApiKey, maxWalletLimit);
      res.json(config);
    } catch (error) {
      console.error("Error updating wallet limits config:", error);
      res.status(500).json({ error: "Failed to update wallet limits config" });
    }
  });

  // ==================== Network Mode (Devnet/Mainnet) ====================

  app.get("/api/network-mode", async (req, res) => {
    try {
      const mode = await getNetworkMode();
      res.json({ mode, faucetUrl: mode === "devnet" ? getSolanaFaucetUrl() : null });
    } catch (error) {
      console.error("Error getting network mode:", error);
      res.status(500).json({ error: "Failed to get network mode" });
    }
  });

  app.post("/api/admin/network-mode", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { mode } = req.body;
      if (mode !== "devnet" && mode !== "mainnet") {
        return res.status(400).json({ error: "Invalid mode. Use 'devnet' or 'mainnet'" });
      }

      const oldMode = await getNetworkMode();
      await setNetworkMode(mode as NetworkMode, req.userId!);

      if (oldMode !== mode) {
        console.log(`[NetworkSwitch] ${oldMode} -> ${mode}, cleaning up old webhooks and recreating...`);
        const status = await storage.getMonitoringStatus();
        if (status.isActive && status.webhookId) {
          await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
        }
        const currentUrl = getWebhookUrl();
        await cleanupStaleWebhooks(currentUrl);
        
        const allWallets = await storage.getAllMonitoredWallets();
        const uniqueAddresses = [...new Set(allWallets.filter(w => w.enabled).map(w => w.walletAddress))];
        if (uniqueAddresses.length > 0) {
          const webhookSecret = process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret";
          const fullUrl = `${currentUrl}?secret=${webhookSecret}`;
          const webhookId = await createWebhook(fullUrl, uniqueAddresses);
          if (webhookId) {
            await storage.updateMonitoringStatus({ isActive: true, webhookId });
            console.log(`[NetworkSwitch] New webhook created on ${mode}:`, webhookId);
          } else {
            console.warn(`[NetworkSwitch] Failed to create webhook on ${mode}, starting retry loop`);
            startMonitoringRetryLoop();
          }
        }
      }

      res.json({ success: true, mode, faucetUrl: mode === "devnet" ? getSolanaFaucetUrl() : null });
    } catch (error) {
      console.error("Error setting network mode:", error);
      res.status(500).json({ error: "Failed to set network mode" });
    }
  });

  // ==================== Install Wizard Health Check ====================
  
  // Health check endpoint for install wizard (requires helius key in query for validation)
  app.post("/api/health-check", async (req, res) => {
    try {
      const { heliusApiKey, networkMode } = req.body;
      if (!heliusApiKey) {
        return res.status(400).json({ error: "Helius API key required" });
      }
      const validMode = networkMode === "devnet" || networkMode === "mainnet" ? networkMode : undefined;
      const results = await runInstallHealthChecks(heliusApiKey, validMode);
      res.json(results);
    } catch (error) {
      console.error("Health check error:", error);
      res.status(500).json({ error: "Health check failed" });
    }
  });

  // ==================== Production Setup / Webhook Management ====================

  // Get production status and webhook info
  app.get("/api/admin/production-status", requireAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const isProduction = process.env.REPLIT_DEPLOYMENT === "1";
      const currentHeliusUrl = getWebhookUrl();
      const currentTelegramUrl = process.env.REPLIT_DEPLOYMENT === "1" && process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}/api/telegram/webhook`
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/telegram/webhook`
          : "https://localhost:5000/api/telegram/webhook";
      
      // Get current monitoring status
      const status = await storage.getMonitoringStatus();
      
      // Check Helius webhooks
      let heliusWebhooks: any[] = [];
      let heliusWebhookMismatch = false;
      try {
        heliusWebhooks = await getWebhooks();
        if (status?.webhookId) {
          const activeWebhook = heliusWebhooks.find(w => w.webhookID === status.webhookId);
          if (activeWebhook && !activeWebhook.webhookURL.startsWith(currentHeliusUrl.split("?")[0])) {
            heliusWebhookMismatch = true;
          }
        }
      } catch (e) {
        console.error("Failed to fetch Helius webhooks:", e);
      }
      
      res.json({
        environment: isProduction ? "production" : "development",
        domain: isProduction 
          ? process.env.REPLIT_DOMAINS?.split(",")[0] 
          : process.env.REPLIT_DEV_DOMAIN,
        webhooks: {
          helius: {
            expectedUrl: currentHeliusUrl,
            activeWebhookId: status?.webhookId || null,
            mismatch: heliusWebhookMismatch,
            totalWebhooks: heliusWebhooks.length,
          },
          telegram: {
            expectedUrl: currentTelegramUrl,
            configured: !!process.env.TELEGRAM_BOT_TOKEN,
          }
        },
        warnings: [
          ...(heliusWebhookMismatch ? ["Helius webhook URL doesn't match current environment - click 'Sync Webhooks' to fix"] : []),
          ...(status?.isActive && !status?.webhookId ? ["Monitoring is active but no webhook ID found"] : []),
        ],
        tips: [
          "When publishing to production, webhook URLs change automatically",
          "Use 'Sync Webhooks' after publishing to update Helius and Telegram",
          "Telegram webhook must be HTTPS with valid certificate (handled by Replit)",
        ],
      });
    } catch (error) {
      console.error("Error getting production status:", error);
      res.status(500).json({ error: "Failed to get production status" });
    }
  });

  // Sync all webhooks to current environment
  app.post("/api/admin/sync-webhooks", requireAdmin, async (req: AuthenticatedRequest, res) => {
    const results: { helius: { success: boolean; message: string }; telegram: { success: boolean; message: string } } = {
      helius: { success: false, message: "" },
      telegram: { success: false, message: "" },
    };

    try {
      // 1. Update or recreate Helius webhook
      const status = await storage.getMonitoringStatus();
      const wallets = await storage.getAllWalletsAdmin();
      const walletAddresses = wallets.filter((w: { enabled: boolean; walletAddress: string }) => w.enabled).map((w: { walletAddress: string }) => w.walletAddress);
      const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
      
      if (walletAddresses.length === 0) {
        // No wallets to monitor
        if (status?.webhookId) {
          await deleteWebhook(status.webhookId);
          await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
          results.helius = { success: true, message: "Deleted webhook - no active wallets" };
        } else {
          results.helius = { success: true, message: "No active wallets to monitor" };
        }
      } else if (status?.webhookId) {
        // Try to update existing webhook
        const updated = await updateWebhookUrl(status.webhookId, webhookUrl, walletAddresses);
        if (updated) {
          results.helius = { success: true, message: `Updated to ${webhookUrl.split("?")[0]}` };
        } else {
          // Update failed, try to recreate
          console.log("Webhook update failed, recreating...");
          await deleteWebhook(status.webhookId).catch(() => {});
          const newId = await createWebhook(webhookUrl, walletAddresses);
          if (newId) {
            await storage.updateMonitoringStatus({ isActive: true, webhookId: newId });
            results.helius = { success: true, message: `Recreated webhook at ${webhookUrl.split("?")[0]}` };
          } else {
            results.helius = { success: false, message: "Failed to recreate webhook" };
          }
        }
      } else if (status?.isActive || walletAddresses.length > 0) {
        // No webhookId but monitoring should be active or we have wallets - create new
        const newId = await createWebhook(webhookUrl, walletAddresses);
        if (newId) {
          await storage.updateMonitoringStatus({ isActive: true, webhookId: newId });
          results.helius = { success: true, message: `Created new webhook at ${webhookUrl.split("?")[0]}` };
        } else {
          results.helius = { success: false, message: "Failed to create webhook" };
        }
      } else {
        results.helius = { success: true, message: "No active monitoring - no update needed" };
      }
    } catch (error: any) {
      results.helius = { success: false, message: error.message || "Helius sync failed" };
    }

    try {
      // 2. Update Telegram webhook
      const telegramUrl = process.env.REPLIT_DEPLOYMENT === "1" && process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}/api/telegram/webhook`
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/telegram/webhook`
          : null;
      
      if (telegramUrl && process.env.TELEGRAM_BOT_TOKEN) {
        const result = await setWebhook(telegramUrl);
        if (result.success) {
          results.telegram = { success: true, message: `Updated to ${telegramUrl}` };
        } else {
          results.telegram = { success: false, message: result.error || "Failed to set webhook" };
        }
      } else if (!process.env.TELEGRAM_BOT_TOKEN) {
        results.telegram = { success: true, message: "Telegram not configured - skipped" };
      } else {
        results.telegram = { success: false, message: "Could not determine webhook URL" };
      }
    } catch (error: any) {
      results.telegram = { success: false, message: error.message || "Telegram sync failed" };
    }

    const allSuccess = results.helius.success && results.telegram.success;
    res.json({
      success: allSuccess,
      results,
    });
  });

  // Get messages for current user (includes unread count)
  app.get("/api/messages", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const messages = await storage.getMessagesForUser(req.userId!);
      res.json(messages);
    } catch (error) {
      console.error("Error getting messages:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  });

  // Get unread message count for current user
  app.get("/api/messages/unread-count", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const count = await storage.getUnreadMessageCount(req.userId!);
      res.json({ count });
    } catch (error) {
      console.error("Error getting unread count:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  // Mark message as read
  app.post("/api/messages/:messageId/read", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const messageId = parseInt(req.params.messageId);
      await storage.markMessageAsRead(messageId, req.userId!);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking message as read:", error);
      res.status(500).json({ error: "Failed to mark as read" });
    }
  });

  // ==================== AI Insights Routes ====================

  // Get AI health status
  app.get("/api/ai/health", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getAIHealth, getUnavailableFeatures, getAvailableFeatures, getFallbackMessage } = await import("./ai-health");
      const health = getAIHealth();
      res.json({
        available: health.available,
        lastCheck: health.lastCheck,
        lastSuccessfulCall: health.lastSuccessfulCall,
        consecutiveFailures: health.consecutiveFailures,
        unavailableFeatures: getUnavailableFeatures(),
        availableFeatures: getAvailableFeatures(),
        fallbackMessage: health.available ? null : getFallbackMessage(),
      });
    } catch (error) {
      console.error("Error getting AI health:", error);
      res.status(500).json({ error: "Failed to get AI health" });
    }
  });

  // Get AI insights summary
  app.get("/api/ai/insights", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const insights = await getAIInsights();
      res.json(insights);
    } catch (error) {
      console.error("Error getting AI insights:", error);
      res.status(500).json({ error: "Failed to get AI insights" });
    }
  });

  // Get all token snapshots
  app.get("/api/ai/snapshots", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshots = await getAllSnapshots();
      res.json(snapshots);
    } catch (error) {
      console.error("Error getting snapshots:", error);
      res.status(500).json({ error: "Failed to get snapshots" });
    }
  });

  // Get single snapshot
  app.get("/api/ai/snapshots/:snapshotId", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshotId = parseInt(req.params.snapshotId);
      if (isNaN(snapshotId)) {
        return res.status(400).json({ error: "Invalid snapshot ID" });
      }
      const snapshot = await getSnapshot(snapshotId);
      if (!snapshot) {
        return res.status(404).json({ error: "Snapshot not found" });
      }
      res.json(snapshot);
    } catch (error) {
      console.error("Error getting snapshot:", error);
      res.status(500).json({ error: "Failed to get snapshot" });
    }
  });

  // Refresh AI score for a snapshot
  app.post("/api/ai/snapshots/:snapshotId/score", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const snapshotId = parseInt(req.params.snapshotId);
      if (isNaN(snapshotId)) {
        return res.status(400).json({ error: "Invalid snapshot ID" });
      }
      const result = await refreshScore(snapshotId);
      if (!result) {
        return res.status(500).json({ error: "Failed to score token" });
      }
      res.json(result);
    } catch (error) {
      console.error("Error scoring token:", error);
      res.status(500).json({ error: "Failed to score token" });
    }
  });

  // Score a token by mint address - creates snapshot on-the-fly if none exists
  app.post("/api/ai/score-token/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      const { getSnapshotByToken, createSnapshot, refreshScore } = await import("./ai");
      
      let snapshot = await getSnapshotByToken(tokenMint);
      
      if (!snapshot) {
        const { fetchTokenWithFallback } = await import("./data-pool");
        const tokenData = await fetchTokenWithFallback(tokenMint, 300);
        
        if (!tokenData.priceUsd && !tokenData.tokenSymbol) {
          return res.status(404).json({ error: "Could not find token data. Try refreshing first." });
        }
        
        const snapshotId = await createSnapshot({
          tokenMint,
          tokenSymbol: tokenData.tokenSymbol || tokenMint.slice(0, 6),
          tokenName: tokenData.tokenName || "",
          priceUsd: tokenData.priceUsd,
          marketCap: tokenData.marketCap,
          fdv: tokenData.fdv,
          liquidity: tokenData.liquidity,
          volume24h: tokenData.volume24h,
          priceChange24h: tokenData.priceChange24h,
        });
        
        snapshot = await import("./ai").then(ai => ai.getSnapshot(snapshotId));
        if (!snapshot) {
          return res.status(500).json({ error: "Failed to create snapshot" });
        }
      }
      
      const result = await refreshScore(snapshot.id);
      if (!result) {
        return res.status(500).json({ error: "Failed to score token" });
      }
      res.json(result);
    } catch (error) {
      console.error("Error scoring token by mint:", error);
      res.status(500).json({ error: "Failed to score token" });
    }
  });

  app.get("/api/snapshots/token/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      const { getSnapshotByToken } = await import("./ai");
      const snapshot = await getSnapshotByToken(tokenMint);
      
      if (snapshot) {
        return res.json(snapshot);
      }
      
      // Fallback: Try to get data from tokenDataPool
      const { getTokenData } = await import("./data-pool");
      const poolData = await getTokenData(tokenMint);
      
      if (poolData) {
        return res.json({
          tokenMint: poolData.tokenMint,
          tokenSymbol: poolData.tokenSymbol,
          tokenName: poolData.tokenName,
          priceUsd: poolData.priceUsd,
          marketCap: poolData.marketCap,
          fdv: poolData.fdv,
          liquidity: poolData.liquidity,
          volume24h: poolData.volume24h,
          priceChange24h: poolData.priceChange24h,
          pairAddress: poolData.pairAddress || null,
          source: 'tokenDataPool',
          lastUpdated: poolData.priceUpdatedAt ? poolData.priceUpdatedAt * 1000 : null,
          isFallback: true,
        });
      }
      
      const swapRecord = await db.select({
        fromToken: swaps.fromToken,
        fromTokenSymbol: swaps.fromTokenSymbol,
        toToken: swaps.toToken,
        toTokenSymbol: swaps.toTokenSymbol,
      }).from(swaps)
        .where(or(eq(swaps.fromToken, tokenMint), eq(swaps.toToken, tokenMint)))
        .orderBy(desc(swaps.timestamp))
        .limit(1);
      
      if (swapRecord.length > 0) {
        const s = swapRecord[0];
        const symbol = s.fromToken === tokenMint ? s.fromTokenSymbol : s.toTokenSymbol;
        return res.json({
          tokenMint,
          tokenSymbol: symbol && symbol !== "???" ? symbol : tokenMint.slice(0, 6),
          tokenName: null,
          priceUsd: null,
          source: 'swapRecord',
          isFallback: true,
        });
      }
      
      return res.status(404).json({ error: "No snapshot found for this token" });
    } catch (error) {
      console.error("Error getting snapshot by token:", error);
      res.status(500).json({ error: "Failed to get snapshot" });
    }
  });

  app.get("/api/token/:tokenMint/signal-sources", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      
      const userWallets = await db.select({
        id: monitoredWallets.id,
        walletAddress: monitoredWallets.walletAddress,
        label: monitoredWallets.label,
      }).from(monitoredWallets).where(eq(monitoredWallets.userId, req.userId!));

      if (userWallets.length === 0) {
        return res.json([]);
      }

      const walletAddresses = userWallets.map(w => w.walletAddress);
      const walletLabelMap = new Map(userWallets.map(w => [w.walletAddress.toLowerCase(), w.label]));

      const signalSwaps = await db.select({
        source: swaps.source,
        timestamp: swaps.timestamp,
        fromToken: swaps.fromToken,
        toToken: swaps.toToken,
        fromAmount: swaps.fromAmount,
        toAmount: swaps.toAmount,
      })
        .from(swaps)
        .where(
          and(
            or(eq(swaps.toToken, tokenMint), eq(swaps.fromToken, tokenMint)),
            inArray(swaps.source, walletAddresses)
          )
        )
        .orderBy(desc(swaps.timestamp))
        .limit(100);

      const uniqueSources = signalSwaps.reduce((acc, swap) => {
        const key = swap.source.toLowerCase();
        const isBuy = swap.toToken === tokenMint;
        const solAmount = isBuy ? swap.fromAmount : swap.toAmount;
        if (!acc.has(key)) {
          acc.set(key, {
            walletAddress: swap.source,
            walletLabel: walletLabelMap.get(key) || null,
            firstSignal: swap.timestamp,
            totalBuys: isBuy ? 1 : 0,
            totalSolSpent: isBuy ? solAmount : 0,
          });
        } else {
          const existing = acc.get(key)!;
          if (isBuy) {
            existing.totalBuys++;
            existing.totalSolSpent += solAmount;
          }
          if (swap.timestamp < existing.firstSignal) {
            existing.firstSignal = swap.timestamp;
          }
        }
        return acc;
      }, new Map<string, { walletAddress: string | null; walletLabel: string | null; firstSignal: number; totalBuys: number; totalSolSpent: number }>());
      
      res.json(Array.from(uniqueSources.values()));
    } catch (error) {
      console.error("Error getting signal sources:", error);
      res.status(500).json({ error: "Failed to get signal sources" });
    }
  });

  // Get top holders for a specific token
  app.get("/api/token/:tokenMint/top-holders", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      const { getHoldersCached } = await import("./price-aggregator");
      
      const holderCache = await getHoldersCached(tokenMint, false);
      if (!holderCache || !holderCache.holders || holderCache.holders.length === 0) {
        return res.json({
          holders: [],
          totalCount: 0,
          lastFetchedAt: null,
          top10Concentration: 0,
        });
      }

      // Calculate top 10 concentration
      const top10Concentration = holderCache.holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);

      // Get user's monitored wallets to check which holders are tracked
      const userWallets = await db.select({
        id: monitoredWallets.id,
        walletAddress: monitoredWallets.walletAddress,
      }).from(monitoredWallets).where(eq(monitoredWallets.userId, req.userId!));
      
      const walletMap = new Map(userWallets.map(w => [w.walletAddress.toLowerCase(), w.id]));

      // Return top 20 holders with formatted data and tracking status
      const holders = holderCache.holders.slice(0, 20).map((holder, index) => {
        const signalId = walletMap.get(holder.address.toLowerCase());
        return {
          rank: index + 1,
          address: holder.address,
          percent: holder.percent,
          amount: holder.amount,
          isTracked: signalId !== undefined,
          signalId: signalId ?? null,
        };
      });

      res.json({
        holders,
        totalCount: holderCache.totalCount,
        lastFetchedAt: holderCache.lastFetchedAt,
        top10Concentration,
      });
    } catch (error) {
      console.error("Error getting top holders:", error);
      res.status(500).json({ error: "Failed to get top holders" });
    }
  });

  // Lookup monitored wallet by address (read-only, no auto-creation)
  app.get("/api/wallet-lookup/:address", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const address = req.params.address as string;
      
      // Try to find existing monitored wallet for this user
      const wallet = await db.query.monitoredWallets.findFirst({
        where: and(
          eq(monitoredWallets.userId, req.userId!),
          eq(monitoredWallets.walletAddress, address)
        )
      });

      if (wallet) {
        return res.json({ id: wallet.id, exists: true, label: wallet.label });
      }

      // Not found - return exists: false without creating
      res.json({ id: null, exists: false, label: null });
    } catch (error) {
      console.error("Error looking up wallet:", error);
      res.status(500).json({ error: "Failed to lookup wallet" });
    }
  });

  // Create temporary wallet for in-app navigation (auto-created when viewing untracked wallet)
  app.post("/api/wallet/temporary", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { address, label } = req.body;
      if (!address) {
        return res.status(400).json({ error: "Address is required" });
      }

      const now = Math.floor(Date.now() / 1000);

      // Check if wallet already exists for this user
      const existing = await db.query.monitoredWallets.findFirst({
        where: and(
          eq(monitoredWallets.userId, req.userId!),
          eq(monitoredWallets.walletAddress, address)
        )
      });

      if (existing) {
        // Update lastViewedAt to reset decay timer
        await db.update(monitoredWallets)
          .set({ lastViewedAt: now })
          .where(eq(monitoredWallets.id, existing.id));
        return res.json({ id: existing.id, created: false });
      }

      // Create temporary wallet
      const [newWallet] = await db.insert(monitoredWallets).values({
        userId: req.userId!,
        walletAddress: address,
        label: label || `Temp: ${address.slice(0, 6)}...`,
        enabled: false, // Not for copy trading
        temporary: true,
        lastViewedAt: now,
        createdAt: now,
      }).returning({ id: monitoredWallets.id });

      res.json({ id: newWallet.id, created: true });
    } catch (error) {
      console.error("Error creating temporary wallet:", error);
      res.status(500).json({ error: "Failed to create temporary wallet" });
    }
  });

  // Touch signal wallet - refresh lastViewedAt to reset decay timer
  app.put("/api/signal/:id/touch", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const now = Math.floor(Date.now() / 1000);

      await db.update(monitoredWallets)
        .set({ lastViewedAt: now })
        .where(and(
          eq(monitoredWallets.id, walletId),
          eq(monitoredWallets.userId, req.userId!)
        ));

      res.json({ success: true, viewedAt: now });
    } catch (error) {
      console.error("Error touching signal wallet:", error);
      res.status(500).json({ error: "Failed to touch signal wallet" });
    }
  });

  // Touch token - record/refresh user view for discovery signals
  app.put("/api/token/:mint/touch", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.mint;
      const { aiAnalysisScore, pnlPercent, sourceWalletId } = req.body;
      const now = Math.floor(Date.now() / 1000);

      // Upsert user token view (unique per user+token)
      await db.insert(userTokenViews)
        .values({
          userId: req.userId!,
          tokenMint,
          viewedAt: now,
          aiAnalysisScore: aiAnalysisScore ?? null,
          pnlPercent: pnlPercent ?? null,
          sourceWalletId: sourceWalletId ?? null,
        })
        .onConflictDoUpdate({
          target: [userTokenViews.userId, userTokenViews.tokenMint],
          set: {
            viewedAt: now,
            aiAnalysisScore: aiAnalysisScore ?? sql`${userTokenViews.aiAnalysisScore}`,
            pnlPercent: pnlPercent ?? sql`${userTokenViews.pnlPercent}`,
            sourceWalletId: sourceWalletId ?? sql`${userTokenViews.sourceWalletId}`,
          },
        });

      // Queue high-priority DexScreener fetch so token data loads quickly
      const { getTokenData, addToFetchQueue } = await import("./data-pool");
      const existing = await getTokenData(tokenMint);
      if (!existing || !existing.priceUsd) {
        await addToFetchQueue('dexscreener', tokenMint, 90, req.userId!);
      }

      res.json({ success: true, viewedAt: now });
    } catch (error) {
      console.error("Error touching token:", error);
      res.status(500).json({ error: "Failed to touch token" });
    }
  });

  // Refresh token - immediate DexScreener fetch for a specific token
  app.post("/api/token/:mint/refresh", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.mint;
      const { fetchTokenWithFallback } = await import("./data-pool");
      const result = await fetchTokenWithFallback(tokenMint, 30);
      res.json({ 
        success: true, 
        source: result.source, 
        priceUsd: result.priceUsd,
        tokenSymbol: result.tokenSymbol,
        tokenName: result.tokenName,
        marketCap: result.marketCap,
        liquidity: result.liquidity,
        volume24h: result.volume24h,
        fdv: result.fdv,
      });
    } catch (error) {
      console.error("Error refreshing token:", error);
      res.status(500).json({ error: "Failed to refresh token data" });
    }
  });

  // Get trade history for a specific token
  app.get("/api/token/:tokenMint/trades", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      
      // Get user's monitored wallets
      const userWallets = await db.select({
        walletAddress: monitoredWallets.walletAddress,
        label: monitoredWallets.label,
      }).from(monitoredWallets).where(eq(monitoredWallets.userId, req.userId!));
      const walletLabelMap = new Map(userWallets.map(w => [w.walletAddress.toLowerCase(), w.label]));
      const signalAddresses = userWallets.map(w => w.walletAddress);

      // Get all swaps involving this token (user's own + signal wallet trades)
      const tokenTrades = await db.select()
        .from(swaps)
        .where(
          and(
            or(
              eq(swaps.toToken, tokenMint),
              eq(swaps.fromToken, tokenMint)
            ),
            or(
              eq(swaps.userId, req.userId!),
              ...(signalAddresses.length > 0 ? [inArray(swaps.source, signalAddresses)] : [])
            )
          )
        )
        .orderBy(desc(swaps.timestamp))
        .limit(100);
      
      // Format trades for display with signal flag
      const formattedTrades = tokenTrades.map(trade => {
        const isSignal = signalAddresses.some(a => a.toLowerCase() === trade.source.toLowerCase());
        return {
          id: trade.id,
          signature: trade.signature,
          timestamp: trade.timestamp,
          type: trade.toToken === tokenMint ? "buy" : "sell",
          amount: trade.toToken === tokenMint ? trade.toAmount : trade.fromAmount,
          tokenSymbol: trade.toToken === tokenMint ? trade.toTokenSymbol : trade.fromTokenSymbol,
          solAmount: trade.toToken === tokenMint ? trade.fromAmount : trade.toAmount,
          source: trade.source,
          isSignal,
          signalLabel: isSignal ? (walletLabelMap.get(trade.source.toLowerCase()) || trade.source.slice(0, 6) + '...' + trade.source.slice(-4)) : null,
        };
      });
      
      res.json(formattedTrades);
    } catch (error) {
      console.error("Error getting token trades:", error);
      res.status(500).json({ error: "Failed to get token trades" });
    }
  });

  // Chat with AI
  app.post("/api/ai/chat", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      console.log(`[AIChat] Request from userId: ${req.userId}`);
      const { message, pageContext } = req.body;
      if (!message || typeof message !== 'string') {
        console.log(`[AIChat] Invalid message format`);
        return res.status(400).json({ error: "Message is required" });
      }
      
      let enrichedMessage = message;
      if (pageContext && typeof pageContext === 'string' && pageContext.startsWith('token:')) {
        const contextMint = pageContext.replace('token:', '');
        if (contextMint && !message.includes(contextMint)) {
          enrichedMessage = `[Currently viewing token: ${contextMint}] ${message}`;
        }
      } else if (pageContext && typeof pageContext === 'string' && pageContext.startsWith('signal:')) {
        const walletId = parseInt(pageContext.replace('signal:', ''));
        if (!isNaN(walletId)) {
          try {
            const wallet = await storage.getMonitoredWallet(req.userId!, walletId);
            if (wallet) {
              const recentSwaps = await db.select()
                .from(swaps)
                .where(and(
                  eq(swaps.userId, req.userId!),
                  eq(swaps.source, wallet.walletAddress)
                ))
                .orderBy(desc(swaps.timestamp))
                .limit(10);
              
              let contextParts: string[] = [];
              contextParts.push(`[Viewing signal wallet: "${wallet.label || 'Unlabeled'}" (${wallet.walletAddress})`);
              contextParts.push(`Copy trading: ${wallet.copyTradeEnabled ? 'enabled' : 'disabled'}`);
              
              if (recentSwaps.length > 0) {
                const tradeLines = recentSwaps.map(s => {
                  const isBuy = s.toToken !== SOL_MINT;
                  const symbol = isBuy ? s.toTokenSymbol : s.fromTokenSymbol;
                  const solAmt = isBuy ? s.fromAmount : s.toAmount;
                  const date = new Date((s.timestamp || 0) * 1000).toLocaleDateString();
                  return `  ${isBuy ? 'BUY' : 'SELL'} ${symbol || '???'} for ${solAmt ? parseFloat(solAmt).toFixed(3) : '?'} SOL (${date})`;
                });
                contextParts.push(`Recent trades:\n${tradeLines.join('\n')}`);
              } else {
                contextParts.push('No recent trades detected');
              }
              contextParts.push(']');
              
              enrichedMessage = contextParts.join('\n') + '\n' + message;
            }
          } catch (err) {
            console.error("[AIChat] Error enriching signal wallet context:", err);
          }
        }
      }
      
      console.log(`[AIChat] Processing message: "${enrichedMessage.slice(0, 80)}..."`);
      
      const { handleMessage } = await import("./intent-parser");
      const { isAIAvailable, getFallbackMessage } = await import("./ai-health");
      
      console.log(`[AIChat] Checking intent parser...`);
      const intentResult = await handleMessage(req.userId!, enrichedMessage);
      
      if (intentResult.handled && intentResult.response) {
        console.log(`[AIChat] Intent handled directly`);
        res.json({ response: intentResult.response });
        return;
      }
      
      console.log(`[AIChat] Checking AI availability...`);
      if (!isAIAvailable()) {
        console.log(`[AIChat] AI unavailable`);
        const fallbackMsg = getFallbackMessage() + " Use the Trading page for full manual control.";
        res.json({ response: fallbackMsg, aiUnavailable: true });
        return;
      }
      
      console.log(`[AIChat] Calling chatWithAI...`);
      const startTime = Date.now();
      const response = await chatWithAI(req.userId!, enrichedMessage, 'web');
      const latency = Date.now() - startTime;
      console.log(`[AIChat] Response received in ${latency}ms`);
      
      res.json({ response });
    } catch (error: any) {
      console.error("[AIChat] Error:", error?.message || error);
      console.error("[AIChat] Stack:", error?.stack);
      res.status(500).json({ error: "Failed to get AI response", details: error?.message });
    }
  });

  // Get chat history
  app.get("/api/ai/chat", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const history = await getChatHistory(req.userId!);
      res.json(history);
    } catch (error) {
      console.error("Error getting chat history:", error);
      res.status(500).json({ error: "Failed to get chat history" });
    }
  });

  // Clear chat history
  app.delete("/api/ai/chat", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      await clearChatHistory(req.userId!);
      res.json({ success: true });
    } catch (error) {
      console.error("Error clearing chat history:", error);
      res.status(500).json({ error: "Failed to clear chat history" });
    }
  });

  // Get Pincher welcome message
  app.get("/api/ai/welcome", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const message = getPincherWelcomeMessage();
      res.json({ message });
    } catch (error) {
      console.error("Error getting welcome message:", error);
      res.status(500).json({ error: "Failed to get welcome message" });
    }
  });

  // Review trading rules before applying
  app.post("/api/ai/review-rules", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { rules } = req.body;
      if (!rules) {
        return res.status(400).json({ error: "Rules are required" });
      }
      const review = await reviewTradingRules(req.userId!, rules);
      res.json(review);
    } catch (error) {
      console.error("Error reviewing rules:", error);
      res.status(500).json({ error: "Failed to review rules" });
    }
  });

  // Get token events with filtering
  app.get("/api/ai/events", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { token, wallet, minValue, sinceMinutes, limit } = req.query;
      const events = await getFilteredEventsForUser(req.userId!, {
        tokenFilter: token as string | undefined,
        walletFilter: wallet as string | undefined,
        minValue: minValue ? parseFloat(minValue as string) : undefined,
        sinceMinutes: sinceMinutes ? parseInt(sinceMinutes as string) : undefined,
        limit: limit ? parseInt(limit as string) : 50,
      });
      res.json(events);
    } catch (error) {
      console.error("Error getting events:", error);
      res.status(500).json({ error: "Failed to get events" });
    }
  });

  // Get user event preferences
  app.get("/api/ai/preferences", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const prefs = await getUserPreferences(req.userId!);
      res.json(prefs || {
        minValueThreshold: 0,
        mutedTokens: [],
        focusWallets: [],
        summaryFocus: null,
        pinchEmailsEnabled: true,
      });
    } catch (error) {
      console.error("Error getting preferences:", error);
      res.status(500).json({ error: "Failed to get preferences" });
    }
  });

  // Update user event preferences
  app.patch("/api/ai/preferences", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const result = await updateUserPreferences(req.userId!, req.body);
      res.json(result);
    } catch (error) {
      console.error("Error updating preferences:", error);
      res.status(500).json({ error: "Failed to update preferences" });
    }
  });

  // Get token heat scores
  app.get("/api/ai/heat-scores", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getHotTokens } = await import("./heat-score");
      const heatScores = await getHotTokens();
      res.json(heatScores);
    } catch (error) {
      console.error("Error getting heat scores:", error);
      res.status(500).json({ error: "Failed to get heat scores" });
    }
  });

  // Get heat score for a specific token
  app.get("/api/ai/heat-scores/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { calculateTokenHeat } = await import("./heat-score");
      const heat = await calculateTokenHeat(req.params.tokenMint);
      res.json(heat);
    } catch (error) {
      console.error("Error getting token heat:", error);
      res.status(500).json({ error: "Failed to get token heat" });
    }
  });

  // Familiar Whales - get top performing whales
  app.get("/api/whales/top", requireAuth, async (_req: AuthenticatedRequest, res) => {
    try {
      const { getTopPerformingWhales } = await import("./familiar-whales");
      const whales = await getTopPerformingWhales(20);
      res.json(whales);
    } catch (error) {
      console.error("Error getting top whales:", error);
      res.status(500).json({ error: "Failed to get top whales" });
    }
  });

  // Familiar Whales - check if familiar whales are in a token
  app.get("/api/whales/token/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { checkTokenForFamiliarWhales } = await import("./familiar-whales");
      const whalesInToken = await checkTokenForFamiliarWhales(req.params.tokenMint);
      res.json(whalesInToken);
    } catch (error) {
      console.error("Error checking token for whales:", error);
      res.status(500).json({ error: "Failed to check token for familiar whales" });
    }
  });

  // Familiar Whales - get whale history by wallet
  app.get("/api/whales/history/:walletAddress", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getWhaleHistory } = await import("./familiar-whales");
      const history = await getWhaleHistory(req.params.walletAddress);
      res.json(history);
    } catch (error) {
      console.error("Error getting whale history:", error);
      res.status(500).json({ error: "Failed to get whale history" });
    }
  });

  // Autonomous Mode - get available risk profiles
  app.get("/api/autonomous/profiles", requireAuth, async (_req: AuthenticatedRequest, res) => {
    try {
      const { getRiskProfiles } = await import("./autonomous-mode");
      const profiles = getRiskProfiles();
      res.json(profiles);
    } catch (error) {
      console.error("Error getting risk profiles:", error);
      res.status(500).json({ error: "Failed to get risk profiles" });
    }
  });

  // Autonomous Mode - get user settings
  app.get("/api/autonomous/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getAutonomousSettings } = await import("./autonomous-mode");
      const settings = await getAutonomousSettings(req.userId!);
      res.json(settings || { enabled: false, needsSetup: true });
    } catch (error) {
      console.error("Error getting autonomous settings:", error);
      res.status(500).json({ error: "Failed to get autonomous settings" });
    }
  });

  // Autonomous Mode - create or update settings
  app.post("/api/autonomous/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getAutonomousSettings, createAutonomousSettings, updateAutonomousSettings } = await import("./autonomous-mode");
      const existing = await getAutonomousSettings(req.userId!);
      
      if (!existing) {
        const riskProfile = req.body.riskProfile || "balanced";
        const settings = await createAutonomousSettings(req.userId!, riskProfile);
        res.json(settings);
      } else {
        const settings = await updateAutonomousSettings(req.userId!, req.body);
        res.json(settings);
      }
    } catch (error) {
      console.error("Error updating autonomous settings:", error);
      res.status(500).json({ error: "Failed to update autonomous settings" });
    }
  });

  // Autonomous Mode - apply risk profile preset
  app.post("/api/autonomous/apply-profile", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { applyRiskProfile } = await import("./autonomous-mode");
      const { profile } = req.body;
      
      if (!profile) {
        return res.status(400).json({ error: "Profile name is required" });
      }
      
      const settings = await applyRiskProfile(req.userId!, profile);
      res.json(settings);
    } catch (error: any) {
      console.error("Error applying risk profile:", error);
      res.status(400).json({ error: error.message || "Failed to apply risk profile" });
    }
  });

  // Autonomous Mode - enable
  app.post("/api/autonomous/enable", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { enableAutonomousMode } = await import("./autonomous-mode");
      const { acknowledged } = req.body;
      const settings = await enableAutonomousMode(req.userId!, acknowledged === true);
      res.json(settings);
    } catch (error: any) {
      console.error("Error enabling autonomous mode:", error);
      res.status(400).json({ error: error.message || "Failed to enable autonomous mode" });
    }
  });

  // Autonomous Mode - disable (kill switch)
  app.post("/api/autonomous/disable", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { disableAutonomousMode } = await import("./autonomous-mode");
      const { reason } = req.body;
      const settings = await disableAutonomousMode(req.userId!, reason || "manual_disable");
      res.json(settings);
    } catch (error) {
      console.error("Error disabling autonomous mode:", error);
      res.status(500).json({ error: "Failed to disable autonomous mode" });
    }
  });

  // Autonomous Mode - check stop conditions
  app.get("/api/autonomous/status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getAutonomousSettings, checkStopConditions, canExecuteTrade } = await import("./autonomous-mode");
      const settings = await getAutonomousSettings(req.userId!);
      
      if (!settings) {
        return res.json({ enabled: false, needsSetup: true });
      }
      
      const stopCheck = await checkStopConditions(req.userId!);
      const tradeCheck = await canExecuteTrade(req.userId!);
      
      res.json({
        enabled: settings.enabled,
        riskProfile: settings.riskProfile,
        todayLossUsd: settings.todayLossUsd,
        todayWinUsd: settings.todayWinUsd,
        todayTradeCount: settings.todayTradeCount,
        consecutiveLosses: settings.consecutiveLosses,
        peakBalanceSol: settings.peakBalanceSol,
        stoppedReason: settings.stoppedReason,
        stoppedAt: settings.stoppedAt,
        stopCondition: stopCheck,
        canTrade: tradeCheck,
      });
    } catch (error) {
      console.error("Error getting autonomous status:", error);
      res.status(500).json({ error: "Failed to get autonomous status" });
    }
  });

  // === SWING TRADING ROUTES ===
  
  // Get swing trading settings
  app.get("/api/swing/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getUserSwingSettings } = await import("./swing-trading");
      const settings = await getUserSwingSettings(req.userId!);
      res.json({ settings });
    } catch (error) {
      console.error("Error getting swing settings:", error);
      res.status(500).json({ error: "Failed to get swing settings" });
    }
  });
  
  // Update swing trading settings
  app.post("/api/swing/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { updateSwingSettings } = await import("./swing-trading");
      const settings = await updateSwingSettings(req.userId!, req.body);
      res.json({ settings });
    } catch (error) {
      console.error("Error updating swing settings:", error);
      res.status(500).json({ error: "Failed to update swing settings" });
    }
  });
  
  // Analyze a specific token for swing trading opportunities
  app.get("/api/swing/analyze/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { analyzeTokenForSwing } = await import("./swing-trading");
      const { getTokenPrice } = await import("./jupiter");
      const tokenMint = req.params.tokenMint;
      const currentPrice = await getTokenPrice(tokenMint) || 0;
      const analysis = await analyzeTokenForSwing(tokenMint, currentPrice);
      res.json({ analysis });
    } catch (error) {
      console.error("Error analyzing token:", error);
      res.status(500).json({ error: "Failed to analyze token" });
    }
  });
  
  // Get swing trading opportunities across user's holdings
  app.get("/api/swing/opportunities", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getSwingOpportunities } = await import("./swing-trading");
      const result = await getSwingOpportunities(req.userId!);
      res.json(result);
    } catch (error) {
      console.error("Error getting swing opportunities:", error);
      res.status(500).json({ error: "Failed to get swing opportunities" });
    }
  });

  // === TRADE RULES ROUTES ===
  
  // Get all trade rules for user
  app.get("/api/trade-rules", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const rules = await db.select().from(tradeRules).where(eq(tradeRules.userId, req.userId!));
      res.json({ rules });
    } catch (error) {
      console.error("Error getting trade rules:", error);
      res.status(500).json({ error: "Failed to get trade rules" });
    }
  });
  
  // Get trade rules by scope
  app.get("/api/trade-rules/:scope", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const scope = req.params.scope;
      const scopeId = req.query.scopeId ? parseInt(req.query.scopeId as string) : undefined;
      
      let query = db.select().from(tradeRules).where(
        and(
          eq(tradeRules.userId, req.userId!),
          eq(tradeRules.scope, scope)
        )
      );
      
      if (scopeId !== undefined) {
        query = db.select().from(tradeRules).where(
          and(
            eq(tradeRules.userId, req.userId!),
            eq(tradeRules.scope, scope),
            eq(tradeRules.scopeId, scopeId)
          )
        );
      }
      
      const rules = await query;
      res.json({ rules });
    } catch (error) {
      console.error("Error getting trade rules by scope:", error);
      res.status(500).json({ error: "Failed to get trade rules" });
    }
  });
  
  // Create a new trade rule
  app.post("/api/trade-rules", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [rule] = await db.insert(tradeRules).values({
        userId: req.userId!,
        scope: req.body.scope || "hotWallet",
        scopeId: req.body.scopeId,
        tokenMint: req.body.tokenMint,
        name: req.body.name,
        enabled: req.body.enabled ?? true,
        action: req.body.action,
        direction: req.body.direction,
        percentChange: req.body.percentChange,
        timeframeMinutes: req.body.timeframeMinutes,
        amountType: req.body.amountType || "percent",
        amountValue: req.body.amountValue,
        maxAmountUsd: req.body.maxAmountUsd,
        maxTriggerCount: req.body.maxTriggerCount,
        cooldownMinutes: req.body.cooldownMinutes || 15,
        requireAutonomy: req.body.requireAutonomy ?? true,
        minPositionValueUsd: req.body.minPositionValueUsd,
        maxPositionValueUsd: req.body.maxPositionValueUsd,
        createdAt: now,
        updatedAt: now,
      }).returning();
      res.json({ rule });
    } catch (error) {
      console.error("Error creating trade rule:", error);
      res.status(500).json({ error: "Failed to create trade rule" });
    }
  });
  
  // Update a trade rule
  app.patch("/api/trade-rules/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const ruleId = parseInt(req.params.id);
      const now = Math.floor(Date.now() / 1000);
      
      const [existing] = await db.select().from(tradeRules).where(
        and(eq(tradeRules.id, ruleId), eq(tradeRules.userId, req.userId!))
      );
      
      if (!existing) {
        return res.status(404).json({ error: "Trade rule not found" });
      }
      
      const [rule] = await db.update(tradeRules)
        .set({ ...req.body, updatedAt: now })
        .where(and(eq(tradeRules.id, ruleId), eq(tradeRules.userId, req.userId!)))
        .returning();
      
      res.json({ rule });
    } catch (error) {
      console.error("Error updating trade rule:", error);
      res.status(500).json({ error: "Failed to update trade rule" });
    }
  });
  
  // Delete a trade rule
  app.delete("/api/trade-rules/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const ruleId = parseInt(req.params.id);
      
      const [existing] = await db.select().from(tradeRules).where(
        and(eq(tradeRules.id, ruleId), eq(tradeRules.userId, req.userId!))
      );
      
      if (!existing) {
        return res.status(404).json({ error: "Trade rule not found" });
      }
      
      await db.delete(tradeRules).where(
        and(eq(tradeRules.id, ruleId), eq(tradeRules.userId, req.userId!))
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting trade rule:", error);
      res.status(500).json({ error: "Failed to delete trade rule" });
    }
  });
  
  // === TRADE RULE PRESETS ROUTES ===
  
  // Get all presets for user
  app.get("/api/trade-rule-presets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const presets = await db.select().from(tradeRulePresets).where(eq(tradeRulePresets.userId, req.userId!));
      res.json({ presets });
    } catch (error) {
      console.error("Error getting trade rule presets:", error);
      res.status(500).json({ error: "Failed to get presets" });
    }
  });
  
  // Create a preset
  app.post("/api/trade-rule-presets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [preset] = await db.insert(tradeRulePresets).values({
        userId: req.userId!,
        name: req.body.name,
        description: req.body.description,
        isDefault: req.body.isDefault ?? false,
        rules: req.body.rules,
        createdAt: now,
        updatedAt: now,
      }).returning();
      res.json({ preset });
    } catch (error) {
      console.error("Error creating trade rule preset:", error);
      res.status(500).json({ error: "Failed to create preset" });
    }
  });
  
  // Apply a preset to a scope
  app.post("/api/trade-rule-presets/:id/apply", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const presetId = parseInt(req.params.id);
      const { scope, scopeId, tokenMint } = req.body;
      
      const [preset] = await db.select().from(tradeRulePresets).where(
        and(eq(tradeRulePresets.id, presetId), eq(tradeRulePresets.userId, req.userId!))
      );
      
      if (!preset) {
        return res.status(404).json({ error: "Preset not found" });
      }
      
      const now = Math.floor(Date.now() / 1000);
      const rules = preset.rules as any[];
      
      const createdRules = await Promise.all(rules.map(async (rule) => {
        const [newRule] = await db.insert(tradeRules).values({
          userId: req.userId!,
          scope: scope || "hotWallet",
          scopeId,
          tokenMint,
          name: rule.name,
          enabled: true,
          action: rule.action,
          direction: rule.direction,
          percentChange: rule.percentChange,
          timeframeMinutes: rule.timeframeMinutes,
          amountType: rule.amountType,
          amountValue: rule.amountValue,
          maxAmountUsd: rule.maxAmountUsd,
          cooldownMinutes: rule.cooldownMinutes,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return newRule;
      }));
      
      res.json({ rules: createdRules });
    } catch (error) {
      console.error("Error applying preset:", error);
      res.status(500).json({ error: "Failed to apply preset" });
    }
  });
  
  // Delete a preset
  app.delete("/api/trade-rule-presets/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const presetId = parseInt(req.params.id);
      
      await db.delete(tradeRulePresets).where(
        and(eq(tradeRulePresets.id, presetId), eq(tradeRulePresets.userId, req.userId!))
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting preset:", error);
      res.status(500).json({ error: "Failed to delete preset" });
    }
  });
  
  // Update holding status and autonomy
  app.patch("/api/holdings/:id/status", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const holdingId = parseInt(req.params.id);
      const { positionStatus, autonomyEnabled } = req.body;
      
      const [holding] = await db.select().from(holdings).where(
        and(eq(holdings.id, holdingId), eq(holdings.userId, req.userId!))
      );
      
      if (!holding) {
        return res.status(404).json({ error: "Holding not found" });
      }
      
      const updateData: any = {};
      if (positionStatus !== undefined) updateData.positionStatus = positionStatus;
      if (autonomyEnabled !== undefined) updateData.autonomyEnabled = autonomyEnabled;
      
      const [updated] = await db.update(holdings)
        .set(updateData)
        .where(and(eq(holdings.id, holdingId), eq(holdings.userId, req.userId!)))
        .returning();
      
      res.json({ holding: updated });
    } catch (error) {
      console.error("Error updating holding status:", error);
      res.status(500).json({ error: "Failed to update holding" });
    }
  });

  // Get portfolio snapshots for charts
  app.get("/api/portfolio/snapshots", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tier = (req.query.tier as string) || "hourly";
      const limit = parseInt(req.query.limit as string) || 168;
      
      if (tier !== "hourly" && tier !== "daily") {
        return res.status(400).json({ error: "Invalid tier. Must be 'hourly' or 'daily'" });
      }
      
      const { getPortfolioSnapshots } = await import("./price-aggregator");
      const snapshots = await getPortfolioSnapshots(req.userId!, tier, limit);
      
      res.json({ snapshots });
    } catch (error) {
      console.error("Error fetching portfolio snapshots:", error);
      res.status(500).json({ error: "Failed to fetch portfolio snapshots" });
    }
  });

  // === BUDGET & API MANAGEMENT ROUTES ===
  
  // Get user's budget status
  app.get("/api/budget/status", requireAuth, async (req: Request, res: Response) => {
    try {
      const { calculateBudgetStatus } = await import("./budget-manager");
      const status = await calculateBudgetStatus(req.userId!);
      res.json(status);
    } catch (error) {
      console.error("Error fetching budget status:", error);
      res.status(500).json({ error: "Failed to fetch budget status" });
    }
  });

  // Get surplus pool summary
  app.get("/api/budget/pool", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getPoolSummary } = await import("./budget-manager");
      const pool = await getPoolSummary();
      res.json(pool);
    } catch (error) {
      console.error("Error fetching pool summary:", error);
      res.status(500).json({ error: "Failed to fetch pool summary" });
    }
  });

  // Get API queue stats
  app.get("/api/budget/queue", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getQueueStats } = await import("./budget-manager");
      const stats = await getQueueStats(req.userId!);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching queue stats:", error);
      res.status(500).json({ error: "Failed to fetch queue stats" });
    }
  });

  // === DATA POOL ROUTES ===

  // Get token data from pool - requires auth
  app.get("/api/pool/token/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getTokenData, isPriceStale, isMarketDataStale } = await import("./data-pool");
      const data = await getTokenData(req.params.mint);
      
      if (!data) {
        return res.status(404).json({ error: "Token not found in pool" });
      }

      const priceStale = await isPriceStale(req.params.mint);
      const marketStale = await isMarketDataStale(req.params.mint);

      res.json({
        ...data,
        priceStale,
        marketStale,
      });
    } catch (error) {
      console.error("Error fetching token from pool:", error);
      res.status(500).json({ error: "Failed to fetch token data" });
    }
  });

  // Fetch token with fallback chain (DexScreener -> GeckoTerminal -> stale cache)
  app.get("/api/pool/fetch/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const maxAge = parseInt(req.query.maxAge as string) || 300;
      const { fetchTokenWithFallback } = await import("./data-pool");
      const data = await fetchTokenWithFallback(req.params.mint, maxAge);
      res.json(data);
    } catch (error) {
      console.error("Error fetching token with fallback:", error);
      res.status(500).json({ error: "Failed to fetch token data" });
    }
  });

  // Report token data from frontend (crowdsourced) - requires auth
  app.post("/api/pool/report", requireAuth, async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        tokenMint: z.string().min(32).max(64),
        tokenSymbol: z.string().max(20).optional(),
        tokenName: z.string().max(100).optional(),
        priceUsd: z.number().min(0).optional(),
        marketCap: z.number().min(0).optional(),
        fdv: z.number().min(0).optional(),
        liquidity: z.number().min(0).optional(),
        volume24h: z.number().min(0).optional(),
        priceChange24h: z.number().optional(),
        pairAddress: z.string().optional(),
        dexId: z.string().optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      }

      const { tokenMint, tokenSymbol, tokenName, priceUsd, marketCap, fdv, liquidity, volume24h, priceChange24h, pairAddress, dexId } = parsed.data;

      const { upsertTokenData } = await import("./data-pool");
      const data = await upsertTokenData(
        tokenMint,
        { tokenSymbol, tokenName, priceUsd, marketCap, fdv, liquidity, volume24h, priceChange24h, pairAddress, dexId },
        'frontend',
        req.userId!
      );

      res.json({ success: true, token: data });
    } catch (error) {
      console.error("Error reporting token data:", error);
      res.status(500).json({ error: "Failed to report token data" });
    }
  });

  // Get holder cache for token - requires auth
  app.get("/api/pool/holders/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getHolderCache, isHolderCacheStale } = await import("./data-pool");
      const cache = await getHolderCache(req.params.mint);

      if (!cache) {
        return res.status(404).json({ error: "Holder cache not found" });
      }

      const isStale = await isHolderCacheStale(req.params.mint);

      res.json({
        ...cache,
        isStale,
      });
    } catch (error) {
      console.error("Error fetching holder cache:", error);
      res.status(500).json({ error: "Failed to fetch holder cache" });
    }
  });

  // === CLUSTER DETECTION ROUTES ===

  // Detect coordinated buying for a token
  app.get("/api/clusters/coordinated/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const windowMinutes = parseInt(req.query.window as string) || 15;
      const { detectCoordinatedBuying } = await import("./cluster-detection");
      const result = await detectCoordinatedBuying(req.params.mint, windowMinutes);
      res.json(result);
    } catch (error) {
      console.error("Error detecting coordinated buying:", error);
      res.status(500).json({ error: "Failed to detect coordinated buying" });
    }
  });

  // Get timing clusters for a token
  app.get("/api/clusters/timing/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const lookbackHours = parseInt(req.query.hours as string) || 24;
      const { detectTimingClusters } = await import("./cluster-detection");
      const clusters = await detectTimingClusters(req.params.mint, lookbackHours);
      res.json({ clusters });
    } catch (error) {
      console.error("Error detecting timing clusters:", error);
      res.status(500).json({ error: "Failed to detect timing clusters" });
    }
  });

  // Get cluster for a specific wallet
  app.get("/api/clusters/wallet/:address", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getClusterForWallet } = await import("./cluster-detection");
      const cluster = await getClusterForWallet(req.params.address);
      res.json({ cluster });
    } catch (error) {
      console.error("Error getting wallet cluster:", error);
      res.status(500).json({ error: "Failed to get wallet cluster" });
    }
  });

  // Get cluster stats (admin)
  app.get("/api/clusters/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getClusterStats } = await import("./cluster-detection");
      const stats = await getClusterStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting cluster stats:", error);
      res.status(500).json({ error: "Failed to get cluster stats" });
    }
  });

  // Refresh cluster cache (admin)
  app.post("/api/clusters/refresh", requireAuth, async (req: Request, res: Response) => {
    try {
      const { refreshClusterCache, getClusterStats } = await import("./cluster-detection");
      await refreshClusterCache();
      const stats = await getClusterStats();
      res.json({ success: true, stats });
    } catch (error) {
      console.error("Error refreshing clusters:", error);
      res.status(500).json({ error: "Failed to refresh clusters" });
    }
  });

  // Trigger opportunistic refresh (admin)
  app.post("/api/pool/opportunistic-refresh", requireAuth, async (req: Request, res: Response) => {
    try {
      const { runOpportunisticRefresh } = await import("./data-pool");
      const maxCredits = parseInt(req.query.maxCredits as string) || 1000;
      const result = await runOpportunisticRefresh(maxCredits);
      res.json({ success: true, ...result });
    } catch (error) {
      console.error("Error running opportunistic refresh:", error);
      res.status(500).json({ error: "Failed to run opportunistic refresh" });
    }
  });

  // Get data pool stats (admin)
  app.get("/api/pool/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getDataPoolStats } = await import("./data-pool");
      const stats = await getDataPoolStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching pool stats:", error);
      res.status(500).json({ error: "Failed to fetch pool stats" });
    }
  });

  // Claim fetch work from queue (crowdsourcing)
  app.post("/api/pool/claim-work", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.body.limit) || 5;
      const { claimFetchWork } = await import("./data-pool");
      const work = await claimFetchWork(req.userId!, limit);
      res.json({ work });
    } catch (error) {
      console.error("Error claiming work:", error);
      res.status(500).json({ error: "Failed to claim work" });
    }
  });

  // Complete fetch work
  app.post("/api/pool/complete-work", requireAuth, async (req: Request, res: Response) => {
    try {
      const { itemId, success, error } = req.body;
      if (!itemId) {
        return res.status(400).json({ error: "itemId is required" });
      }

      const { completeFetchWork } = await import("./data-pool");
      await completeFetchWork(itemId, success, error);
      res.json({ success: true });
    } catch (error) {
      console.error("Error completing work:", error);
      res.status(500).json({ error: "Failed to complete work" });
    }
  });

  // === TOKEN SAFETY ROUTES ===

  app.get("/api/tokens/:mint/safety", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getTokenData, bumpTokenPriority } = await import("./data-pool");
      const data = await getTokenData(req.params.mint);
      
      bumpTokenPriority(req.params.mint, 'ui_displayed');
      
      if (!data) {
        return res.status(404).json({ error: "Token not found" });
      }
      
      res.json({
        tokenMint: data.tokenMint,
        rugcheckData: data.rugcheckData,
        rugcheckCheckedAt: data.rugcheckCheckedAt,
        goplusData: data.goplusData,
        goplusCheckedAt: data.goplusCheckedAt,
        safetySource: data.safetySource,
        isPumpfun: data.isPumpfun,
        pumpfunGraduated: data.pumpfunGraduated,
        pumpfunGraduationTime: data.pumpfunGraduationTime,
        pumpfunAgeAtGraduation: data.pumpfunAgeAtGraduation,
        pumpfunBondingCurveProgress: data.pumpfunBondingCurveProgress,
      });
    } catch (error) {
      console.error("Error fetching token safety:", error);
      res.status(500).json({ error: "Failed to fetch token safety" });
    }
  });

  app.post("/api/tokens/:mint/check-safety", requireAuth, async (req: Request, res: Response) => {
    try {
      const { checkTokenSafety } = await import("./safety-checker");
      const { bumpTokenPriority } = await import("./data-pool");
      
      bumpTokenPriority(req.params.mint, 'ui_displayed');
      
      const result = await checkTokenSafety(req.params.mint);
      res.json(result);
    } catch (error) {
      console.error("Error checking token safety:", error);
      res.status(500).json({ error: "Failed to check token safety" });
    }
  });

  const reportSafetySchema = z.object({
    rugcheckData: z.record(z.unknown()).optional(),
    goplusData: z.record(z.unknown()).optional(),
  });

  app.post("/api/tokens/report-safety", requireAuth, async (req: Request, res: Response) => {
    try {
      const tokenMint = req.body.tokenMint;
      if (!tokenMint || typeof tokenMint !== 'string') {
        return res.status(400).json({ error: "tokenMint required" });
      }
      
      const parsed = reportSafetySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
      }
      
      const { reportSafetyFromFrontend } = await import("./safety-checker");
      const success = await reportSafetyFromFrontend(tokenMint, parsed.data, req.userId);
      
      if (success) {
        const wss = (req as any).wss;
        if (wss) {
          const message = JSON.stringify({
            type: 'SAFETY_UPDATE',
            tokenMint,
            source: 'frontend',
          });
          wss.clients.forEach((client: any) => {
            if (client.readyState === 1) {
              client.send(message);
            }
          });
        }
      }
      
      res.json({ success });
    } catch (error) {
      console.error("Error reporting safety data:", error);
      res.status(500).json({ error: "Failed to report safety data" });
    }
  });

  app.get("/api/safety/api-health", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getApiHealthStats } = await import("./safety-checker");
      const stats = await getApiHealthStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching API health:", error);
      res.status(500).json({ error: "Failed to fetch API health" });
    }
  });

  app.post("/api/tokens/bump-priority", requireAuth, async (req: Request, res: Response) => {
    try {
      const { tokenMints, level } = req.body;
      if (!Array.isArray(tokenMints)) {
        return res.status(400).json({ error: "tokenMints must be array" });
      }
      
      const { bumpTokensBatch } = await import("./data-pool");
      bumpTokensBatch(tokenMints, level || 'ui_displayed');
      
      res.json({ success: true, count: tokenMints.length });
    } catch (error) {
      console.error("Error bumping priority:", error);
      res.status(500).json({ error: "Failed to bump priority" });
    }
  });

  // === BEHAVIOR ANALYSIS ROUTES ===

  app.get("/api/wallet/:address/behavior", requireAuth, async (req: Request, res: Response) => {
    try {
      const { classifyWalletBehavior } = await import("./cluster-detection");
      const behavior = await classifyWalletBehavior(req.params.address);
      res.json(behavior);
    } catch (error) {
      console.error("Error classifying wallet behavior:", error);
      res.status(500).json({ error: "Failed to classify wallet behavior" });
    }
  });

  app.get("/api/wallet/:address/fingerprint", requireAuth, async (req: Request, res: Response) => {
    try {
      const { analyzeWalletFingerprint, getStoredFingerprint } = await import("./wallet-fingerprint");
      
      let fingerprint = await getStoredFingerprint(req.params.address);
      if (!fingerprint) {
        fingerprint = await analyzeWalletFingerprint(req.params.address);
      }
      
      res.json(fingerprint);
    } catch (error) {
      console.error("Error getting wallet fingerprint:", error);
      res.status(500).json({ error: "Failed to get wallet fingerprint" });
    }
  });

  app.post("/api/wallet/:address/fingerprint/refresh", requireAuth, async (req: Request, res: Response) => {
    try {
      const { analyzeWalletFingerprint, persistFingerprint, getFingerprintSummary } = await import("./wallet-fingerprint");
      const fingerprint = await analyzeWalletFingerprint(req.params.address);
      await persistFingerprint(fingerprint);
      
      res.json({ 
        fingerprint,
        summary: getFingerprintSummary(fingerprint),
      });
    } catch (error) {
      console.error("Error refreshing fingerprint:", error);
      res.status(500).json({ error: "Failed to refresh fingerprint" });
    }
  });

  app.get("/api/tokens/:mint/copytrade-window", requireAuth, async (req: Request, res: Response) => {
    try {
      const { analyzeCopytradeWindow, getCopytradeWindowSummary } = await import("./cluster-detection");
      const window = await analyzeCopytradeWindow(req.params.mint);
      
      if (!window) {
        return res.status(404).json({ error: "No copytrade window found" });
      }
      
      res.json({
        ...window,
        summary: getCopytradeWindowSummary(window),
      });
    } catch (error) {
      console.error("Error analyzing copytrade window:", error);
      res.status(500).json({ error: "Failed to analyze copytrade window" });
    }
  });

  app.get("/api/tokens/:mint/synchronized-buying", requireAuth, async (req: Request, res: Response) => {
    try {
      const { detectSynchronizedBuying } = await import("./cluster-detection");
      const result = await detectSynchronizedBuying(req.params.mint);
      res.json(result || { isDetected: false });
    } catch (error) {
      console.error("Error detecting synchronized buying:", error);
      res.status(500).json({ error: "Failed to detect synchronized buying" });
    }
  });

  app.get("/api/clusters/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getClusterStats, getCachedClusters, enrichClusterWithWhaleData } = await import("./cluster-detection");
      const stats = await getClusterStats();
      const clusters = getCachedClusters();
      
      const enrichedClusters = await Promise.all(
        clusters.slice(0, 10).map(c => enrichClusterWithWhaleData(c))
      );
      
      res.json({
        ...stats,
        clusters: enrichedClusters,
      });
    } catch (error) {
      console.error("Error getting cluster stats:", error);
      res.status(500).json({ error: "Failed to get cluster stats" });
    }
  });

  app.post("/api/clusters/refresh", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserById(req.userId!);
      if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });

      const { refreshClusterCache, getClusterStats } = await import("./cluster-detection");
      await refreshClusterCache();
      const stats = await getClusterStats();
      
      res.json({ success: true, stats });
    } catch (error) {
      console.error("Error refreshing clusters:", error);
      res.status(500).json({ error: "Failed to refresh clusters" });
    }
  });

  app.get("/api/discovery/source-outcomes", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getDiscoverySourceOutcomes } = await import("./discovery-paper-trading");
      const outcomes = await getDiscoverySourceOutcomes();
      res.json(outcomes);
    } catch (error) {
      console.error("Error getting discovery source outcomes:", error);
      res.status(500).json({ error: "Failed to get discovery source outcomes" });
    }
  });

  // === DISCOVERY ENGINE ROUTES ===

  app.get("/api/discovery/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getDiscoveryStats, getDiverseDiscoveryStats } = await import("./discovery-engine");
      const [triggerStats, diverseStats] = await Promise.all([
        getDiscoveryStats(),
        getDiverseDiscoveryStats(),
      ]);
      
      res.json({ triggers: triggerStats, diverse: diverseStats });
    } catch (error) {
      console.error("Error getting discovery stats:", error);
      res.status(500).json({ error: "Failed to get discovery stats" });
    }
  });

  app.post("/api/discovery/run-diverse", requireAuth, async (req: Request, res: Response) => {
    try {
      const { runDiverseDiscovery } = await import("./discovery-engine");
      const result = await runDiverseDiscovery();
      res.json(result);
    } catch (error) {
      console.error("Error running diverse discovery:", error);
      res.status(500).json({ error: "Failed to run diverse discovery" });
    }
  });

  app.get("/api/discovery/events", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getRecentEvents } = await import("./discovery-engine");
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string | undefined;
      
      const events = await getRecentEvents(limit, status);
      res.json(events);
    } catch (error) {
      console.error("Error getting discovery events:", error);
      res.status(500).json({ error: "Failed to get discovery events" });
    }
  });

  // === PAPER TRADING ROUTES ===

  const openPaperPositionSchema = z.object({
    tokenMint: z.string().min(32),
    tokenSymbol: z.string().optional(),
    tokenName: z.string().optional(),
    entrySol: z.number().positive(),
    signalWallet: z.string().optional(),
    strategyId: z.number().optional(),
    experimentId: z.number().optional(),
    takeProfitMultiplier: z.number().optional(),
    stopLossPercent: z.number().optional(),
    trailingStop: z.boolean().optional(),
  });

  app.post("/api/paper/positions", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = openPaperPositionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
      }
      const { openPaperPosition } = await import("./paper-trading");
      const position = await openPaperPosition({ userId: req.userId!, ...parsed.data });
      res.json(position);
    } catch (error: any) {
      console.error("Error opening paper position:", error);
      res.status(500).json({ error: error.message || "Failed to open paper position" });
    }
  });

  app.get("/api/paper/token-lookup/:mint", requireAuth, async (req: Request, res: Response) => {
    try {
      const { fetchTokenWithFallback } = await import("./data-pool");
      const tokenData = await fetchTokenWithFallback(req.params.mint);
      res.json({
        tokenMint: req.params.mint,
        tokenSymbol: tokenData.tokenSymbol || null,
        tokenName: tokenData.tokenName || null,
        priceUsd: tokenData.priceUsd || null,
        marketCap: tokenData.marketCap || null,
        liquidity: tokenData.liquidity || null,
        volume24h: tokenData.volume24h || null,
      });
    } catch (error) {
      console.error("Error looking up token:", error);
      res.status(404).json({ error: "Token not found" });
    }
  });

  app.get("/api/paper/positions", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getOpenPositions } = await import("./paper-trading");
      const positions = await getOpenPositions(req.userId!);
      res.json(positions);
    } catch (error) {
      console.error("Error fetching paper positions:", error);
      res.status(500).json({ error: "Failed to fetch positions" });
    }
  });

  app.get("/api/paper/positions/history", requireAuth, async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const { getPositionHistory } = await import("./paper-trading");
      const positions = await getPositionHistory(req.userId!, limit);
      res.json(positions);
    } catch (error) {
      console.error("Error fetching position history:", error);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  app.post("/api/paper/positions/:id/close", requireAuth, async (req: Request, res: Response) => {
    try {
      const positionId = parseInt(req.params.id);
      const { reason } = req.body;
      const { closePaperPosition } = await import("./paper-trading");
      const position = await closePaperPosition(positionId, reason || "manual", req.userId!);
      if (!position) {
        return res.status(404).json({ error: "Position not found or already closed" });
      }
      res.json(position);
    } catch (error) {
      console.error("Error closing paper position:", error);
      res.status(500).json({ error: "Failed to close position" });
    }
  });

  app.get("/api/paper/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getPaperTradingStats } = await import("./paper-trading");
      const stats = await getPaperTradingStats(req.userId!);
      res.json(stats);
    } catch (error) {
      console.error("Error fetching paper trading stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/paper/strategies/:wallet", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getWalletStrategy, analyzeWalletStrategy, saveWalletStrategy, generateAiRecommendations } = await import("./paper-trading");
      const walletAddress = req.params.wallet;
      const userId = req.userId!;
      
      // Fetch user notes for this wallet to pass to AI
      const [walletRecord] = await db.select({ userNotes: monitoredWallets.userNotes })
        .from(monitoredWallets)
        .where(and(eq(monitoredWallets.walletAddress, walletAddress), eq(monitoredWallets.userId, userId)))
        .limit(1);
      const userNotes = walletRecord?.userNotes || null;
      
      // Get cached strategy if exists
      const cached = await getWalletStrategy(walletAddress, userId);
      
      // Check if we need to re-analyze
      // Re-analyze if: no cache, cache older than 1 hour, or significant new swaps
      const now = Math.floor(Date.now() / 1000);
      const cacheAge = cached?.lastUpdatedAt ? now - cached.lastUpdatedAt : Infinity;
      const isStale = cacheAge > 3600; // 1 hour cache TTL
      
      // Count current swaps for this wallet to check if new activity
      const [swapCountResult] = await db.select({ count: count() }).from(swaps).where(eq(swaps.source, walletAddress));
      const currentSwapCount = Number(swapCountResult?.count) || 0;
      const hasNewSwaps = cached
        ? (cached.swapCountAtAnalysis != null ? currentSwapCount > cached.swapCountAtAnalysis + 2 : false)
        : true;
      
      // Helper to format cached data for response
      const formatCachedResponse = (c: typeof cached) => {
        if (!c || !c.sampleSize || c.sampleSize <= 0) return null;
        let aiRecs: any = c.aiRecommendations;
        if (typeof aiRecs === 'string') {
          try { aiRecs = JSON.parse(aiRecs); } catch { aiRecs = null; }
        }
        let discInsights: any = c.discoveryInsights;
        if (typeof discInsights === 'string') {
          try { discInsights = JSON.parse(discInsights); } catch { discInsights = null; }
        }
        const insights: string[] = [];
        if (c.winRate && c.winRate > 0.6) insights.push(`Strong performer with ${(c.winRate * 100).toFixed(0)}% win rate`);
        if (c.profitFactor && c.profitFactor > 2) insights.push(`Excellent risk/reward ratio (${c.profitFactor.toFixed(1)}x)`);
        if (c.avgHoldDuration && c.avgHoldDuration < 1800) insights.push(`Quick flipper - holds avg ${Math.round(c.avgHoldDuration / 60)} minutes`);
        else if (c.avgHoldDuration && c.avgHoldDuration > 86400) insights.push(`Patient trader - holds avg ${Math.round(c.avgHoldDuration / 86400)} days`);
        return {
          ...c,
          insights,
          aiRecommendations: aiRecs,
          discoveryContext: c.behaviorType ? {
            behaviorType: c.behaviorType,
            behaviorConfidence: c.behaviorConfidence,
            recentInsights: discInsights || [],
            followsLeaders: [],
            leadsFollowers: [],
          } : undefined,
          fromCache: true,
        };
      };

      // Return cached if valid
      if (cached && cached.sampleSize && cached.sampleSize > 0 && !isStale && !hasNewSwaps) {
        const formatted = formatCachedResponse(cached);
        if (formatted) {
          res.json(formatted);
          if ((!formatted.aiRecommendations || (Array.isArray(formatted.aiRecommendations) && formatted.aiRecommendations.length === 0)) && cached.sampleSize >= 5) {
            console.log(`[StrategyAnalyze] Cache hit but missing AI recs, generating in background...`);
            (async () => {
              try {
                const analysis = await analyzeWalletStrategy(walletAddress, userId);
                const recommendations = await generateAiRecommendations(walletAddress, analysis, userNotes);
                if (recommendations && recommendations.length > 0) {
                  analysis.aiRecommendations = recommendations;
                  await saveWalletStrategy(walletAddress, userId, analysis);
                  console.log(`[StrategyAnalyze] Background AI recs saved for cached strategy (${recommendations.length})`);
                }
              } catch (bgErr: any) {
                console.error(`[StrategyAnalyze] Background AI generation failed:`, bgErr.message);
              }
            })();
          }
          return;
        }
      }
      
      // Trigger fresh analysis with fallback to cached data on failure
      try {
        console.log(`[StrategyAnalyze] Auto-analyzing wallet: ${walletAddress} (stale: ${isStale}, hasNewSwaps: ${hasNewSwaps})`);
        const analysis = await analyzeWalletStrategy(walletAddress, userId);
        
        await saveWalletStrategy(walletAddress, userId, analysis);
        
        const insights: string[] = [];
        if (analysis.winRate && analysis.winRate > 0.6) insights.push(`Strong performer with ${(analysis.winRate * 100).toFixed(0)}% win rate`);
        if (analysis.profitFactor && analysis.profitFactor > 2) insights.push(`Excellent risk/reward ratio (${analysis.profitFactor.toFixed(1)}x)`);
        if (analysis.avgHoldDuration && analysis.avgHoldDuration < 1800) insights.push(`Quick flipper - holds avg ${Math.round(analysis.avgHoldDuration / 60)} minutes`);
        else if (analysis.avgHoldDuration && analysis.avgHoldDuration > 86400) insights.push(`Patient trader - holds avg ${Math.round(analysis.avgHoldDuration / 86400)} days`);
        
        res.json({ ...analysis, insights, fromCache: false });
        
        if (analysis.sampleSize >= 5) {
          generateAiRecommendations(walletAddress, analysis, userNotes).then(async (recommendations) => {
            if (recommendations && recommendations.length > 0) {
              try {
                analysis.aiRecommendations = recommendations;
                await saveWalletStrategy(walletAddress, userId, analysis);
                console.log(`[StrategyAnalyze] GET auto-refresh: AI recs saved (${recommendations.length})`);
              } catch (saveErr: any) {
                console.error(`[StrategyAnalyze] GET auto-refresh AI save failed:`, saveErr.message);
              }
            }
          }).catch((aiErr: any) => {
            console.error("[StrategyAnalyze] GET auto-refresh AI failed:", aiErr.message);
          });
        }
      } catch (analysisError) {
        console.error("[StrategyAnalyze] Re-analysis failed:", analysisError);
        const fallback = formatCachedResponse(cached);
        if (fallback) {
          res.json(fallback);
        } else {
          res.json({ sampleSize: 0, fromCache: false });
        }
      }
    } catch (error) {
      console.error("Error fetching wallet strategy:", error);
      res.status(500).json({ error: "Failed to fetch strategy" });
    }
  });

  app.post("/api/paper/strategies/:wallet/analyze", requireAuth, async (req: Request, res: Response) => {
    const walletAddr = req.params.wallet;
    const userId = req.userId!;
    try {
      console.log(`[StrategyAnalyze] Starting analysis for wallet: ${walletAddr}, userId: ${userId}`);
      const { analyzeWalletStrategy, saveWalletStrategy, generateAiRecommendations } = await import("./paper-trading");
      
      // Fetch user notes for AI context
      const [walletRec] = await db.select({ userNotes: monitoredWallets.userNotes })
        .from(monitoredWallets)
        .where(and(eq(monitoredWallets.walletAddress, walletAddr), eq(monitoredWallets.userId, userId)))
        .limit(1);
      const walletUserNotes = walletRec?.userNotes || null;
      
      const analysis = await analyzeWalletStrategy(walletAddr, userId);
      console.log(`[StrategyAnalyze] Analysis complete, sampleSize: ${analysis.sampleSize}`);
      
      const saved = await saveWalletStrategy(walletAddr, userId, analysis);
      console.log(`[StrategyAnalyze] Strategy saved successfully, id: ${saved?.id}`);
      
      res.json({ analysis, saved });
      
      if (analysis.sampleSize >= 5) {
        generateAiRecommendations(walletAddr, analysis, walletUserNotes).then(async (recommendations) => {
          if (recommendations && recommendations.length > 0) {
            try {
              analysis.aiRecommendations = recommendations;
              await saveWalletStrategy(walletAddr, userId, analysis);
              console.log(`[StrategyAnalyze] AI recommendations saved (${recommendations.length} recs)`);
            } catch (saveErr: any) {
              console.error(`[StrategyAnalyze] Failed to save AI recs:`, saveErr.message);
              try {
                await db.insert(errorLogs).values({ category: 'trade', message: `Strategy AI rec save failed: ${saveErr.message}`, details: JSON.stringify({ walletAddr, userId }), createdAt: Math.floor(Date.now() / 1000) });
              } catch {}
            }
          }
        }).catch((aiErr: any) => {
          console.error(`[StrategyAnalyze] AI recommendations failed:`, aiErr.message);
          try {
            db.insert(errorLogs).values({ category: 'ai', message: `Strategy AI gen failed: ${aiErr.message}`, details: JSON.stringify({ walletAddr, userId }), createdAt: Math.floor(Date.now() / 1000) }).then(() => {});
          } catch {}
        });
      }
    } catch (error: any) {
      console.error("[StrategyAnalyze] Error:", error?.message);
      try {
        await db.insert(errorLogs).values({ category: 'trade', message: `Strategy analysis failed: ${error?.message}`, details: JSON.stringify({ wallet: walletAddr, userId, stack: error?.stack?.slice(0, 500) }), createdAt: Math.floor(Date.now() / 1000) });
      } catch {}
      res.status(500).json({ error: "Failed to analyze strategy", details: error?.message });
    }
  });

  const createExperimentSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    signalWallet: z.string().optional(),
    strategyId: z.number().optional(),
    controlConfig: z.record(z.any()),
    variantConfig: z.record(z.any()),
    paperBudgetSol: z.number().positive(),
    durationDays: z.number().positive().optional(),
  });

  app.post("/api/paper/experiments", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = createExperimentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.errors });
      }
      const { createExperiment } = await import("./paper-trading");
      const experiment = await createExperiment({ userId: req.userId!, ...parsed.data });
      res.json(experiment);
    } catch (error) {
      console.error("Error creating experiment:", error);
      res.status(500).json({ error: "Failed to create experiment" });
    }
  });

  app.get("/api/paper/experiments", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getActiveExperiments } = await import("./paper-trading");
      const experiments = await getActiveExperiments(req.userId!);
      res.json(experiments);
    } catch (error) {
      console.error("Error fetching experiments:", error);
      res.status(500).json({ error: "Failed to fetch experiments" });
    }
  });

  app.post("/api/paper/experiments/:id/complete", requireAuth, async (req: Request, res: Response) => {
    try {
      const { completeExperiment } = await import("./paper-trading");
      const experiment = await completeExperiment(parseInt(req.params.id), req.userId!);
      if (!experiment) {
        return res.status(404).json({ error: "Experiment not found" });
      }
      res.json(experiment);
    } catch (error) {
      console.error("Error completing experiment:", error);
      res.status(500).json({ error: "Failed to complete experiment" });
    }
  });

  app.get("/api/paper/experiment-stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getPaperExperimentStats } = await import("./paper-experiments");
      const stats = await getPaperExperimentStats(req.userId!);
      res.json(stats);
    } catch (error) {
      console.error("Error getting experiment stats:", error);
      res.status(500).json({ error: "Failed to get experiment stats" });
    }
  });

  app.get("/api/paper/theories", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getActiveTheories, getBestTheory } = await import("./paper-experiments");
      const [theories, best] = await Promise.all([
        getActiveTheories(),
        getBestTheory()
      ]);
      res.json({ theories, best });
    } catch (error) {
      console.error("Error getting theories:", error);
      res.status(500).json({ error: "Failed to get theories" });
    }
  });

  app.get("/api/paper/theories/:id/validate", requireAuth, async (req: Request, res: Response) => {
    try {
      const { validateTheory } = await import("./paper-experiments");
      const validation = await validateTheory(req.params.id);
      res.json(validation);
    } catch (error) {
      console.error("Error validating theory:", error);
      res.status(500).json({ error: "Failed to validate theory" });
    }
  });

  app.get("/api/paper/trading-gate", requireAuth, async (req: Request, res: Response) => {
    try {
      const { checkRealTradingGate } = await import("./paper-experiments");
      const signalWallet = req.query.wallet as string | undefined;
      const gate = await checkRealTradingGate(req.userId!, signalWallet);
      res.json(gate);
    } catch (error) {
      console.error("Error checking trading gate:", error);
      res.status(500).json({ error: "Failed to check trading gate" });
    }
  });

  app.post("/api/paper/experiment-trade", requireAuth, async (req: Request, res: Response) => {
    try {
      const { openExperimentTrade } = await import("./paper-experiments");
      const { experimentId, tokenMint, tokenSymbol, entrySol, signalWallet, takeProfitMultiplier, stopLossPercent, isVariant } = req.body;
      
      if (!experimentId || !tokenMint || !entrySol) {
        return res.status(400).json({ error: "Missing required fields: experimentId, tokenMint, entrySol" });
      }
      
      const position = await openExperimentTrade(
        req.userId!,
        experimentId,
        { tokenMint, tokenSymbol, entrySol, signalWallet, takeProfitMultiplier, stopLossPercent },
        isVariant || false
      );
      res.json(position);
    } catch (error: any) {
      console.error("Error opening experiment trade:", error);
      res.status(500).json({ error: error.message || "Failed to open experiment trade" });
    }
  });

  app.post("/api/paper/best-theory-trade", requireAuth, async (req: Request, res: Response) => {
    try {
      const { openBestTheoryTrade, getBestTheory } = await import("./paper-experiments");
      const { tokenMint, tokenSymbol, entrySol, signalWallet, takeProfitMultiplier, stopLossPercent, theoryId } = req.body;
      
      if (!tokenMint || !entrySol) {
        return res.status(400).json({ error: "Missing required fields: tokenMint, entrySol" });
      }
      
      let targetTheoryId = theoryId;
      if (!targetTheoryId) {
        const best = await getBestTheory();
        if (!best) {
          return res.status(400).json({ error: "No active theories available" });
        }
        targetTheoryId = best.id;
      }
      
      const position = await openBestTheoryTrade(
        req.userId!,
        targetTheoryId,
        { tokenMint, tokenSymbol, entrySol, signalWallet, takeProfitMultiplier, stopLossPercent }
      );
      res.json(position);
    } catch (error: any) {
      console.error("Error opening best theory trade:", error);
      res.status(500).json({ error: error.message || "Failed to open best theory trade" });
    }
  });

  app.post("/api/paper/validate-theories", requireAuth, async (req: Request, res: Response) => {
    try {
      const { runBestTheoryValidationCycle } = await import("./paper-experiments");
      const result = await runBestTheoryValidationCycle();
      res.json(result);
    } catch (error) {
      console.error("Error validating theories:", error);
      res.status(500).json({ error: "Failed to validate theories" });
    }
  });

  // =====================
  // DISCOVERY ENGINE API ROUTES
  // =====================
  
  app.get("/api/discovery/stats", requireAuth, async (req, res) => {
    try {
      const { getDiscoveryStats } = await import("./discovery-engine");
      const stats = await getDiscoveryStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting discovery stats:", error);
      res.status(500).json({ error: "Failed to get discovery stats" });
    }
  });
  
  app.get("/api/discovery/events", requireAuth, async (req, res) => {
    try {
      const { getRecentEvents } = await import("./discovery-engine");
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string | undefined;
      const events = await getRecentEvents(limit, status);
      res.json(events);
    } catch (error) {
      console.error("Error getting discovery events:", error);
      res.status(500).json({ error: "Failed to get discovery events" });
    }
  });
  
  app.get("/api/discovery/triggers", requireAuth, async (req, res) => {
    try {
      const triggers = await db.select().from(discoveryTriggers)
        .orderBy(desc(discoveryTriggers.priority));
      res.json(triggers);
    } catch (error) {
      console.error("Error getting triggers:", error);
      res.status(500).json({ error: "Failed to get triggers" });
    }
  });
  
  app.patch("/api/discovery/triggers/:id", requireAuth, async (req, res) => {
    try {
      const triggerId = parseInt(req.params.id);
      const { enabled, threshold, priority, cooldownMinutes } = req.body;
      
      const updates: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
      if (enabled !== undefined) updates.enabled = enabled;
      if (threshold !== undefined) updates.threshold = threshold;
      if (priority !== undefined) updates.priority = priority;
      if (cooldownMinutes !== undefined) updates.cooldownMinutes = cooldownMinutes;
      
      const [updated] = await db.update(discoveryTriggers)
        .set(updates)
        .where(eq(discoveryTriggers.id, triggerId))
        .returning();
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating trigger:", error);
      res.status(500).json({ error: "Failed to update trigger" });
    }
  });
  
  app.post("/api/discovery/scan", requireAuth, async (req, res) => {
    try {
      const { scanForDiscoveries } = await import("./discovery-engine");
      const events = await scanForDiscoveries();
      res.json({ fired: events.length, events });
    } catch (error) {
      console.error("Error running discovery scan:", error);
      res.status(500).json({ error: "Failed to run discovery scan" });
    }
  });
  
  app.post("/api/discovery/hourly-job", requireAuth, async (req, res) => {
    try {
      const { runHourlyMonitor } = await import("./discovery-engine");
      const result = await runHourlyMonitor();
      res.json(result);
    } catch (error) {
      console.error("Error running hourly job:", error);
      res.status(500).json({ error: "Failed to run hourly job" });
    }
  });
  
  app.post("/api/discovery/daily-tune", requireAuth, async (req, res) => {
    try {
      const { runDailyTuning } = await import("./discovery-engine");
      const result = await runDailyTuning();
      res.json(result);
    } catch (error) {
      console.error("Error running daily tune:", error);
      res.status(500).json({ error: "Failed to run daily tune" });
    }
  });
  
  app.get("/api/discovery/job-history", requireAuth, async (req, res) => {
    try {
      const runs = await db.select().from(discoveryJobRuns)
        .orderBy(desc(discoveryJobRuns.startedAt))
        .limit(20);
      res.json(runs);
    } catch (error) {
      console.error("Error getting job history:", error);
      res.status(500).json({ error: "Failed to get job history" });
    }
  });
  
  app.post("/api/discovery/init-triggers", requireAuth, async (req, res) => {
    try {
      const { initializeDefaultTriggers } = await import("./discovery-engine");
      await initializeDefaultTriggers();
      res.json({ success: true });
    } catch (error) {
      console.error("Error initializing triggers:", error);
      res.status(500).json({ error: "Failed to initialize triggers" });
    }
  });

  app.get("/api/discovery/token-history/:tokenMint", requireAuth, async (req, res) => {
    try {
      const { getTokenHistoricalContext } = await import("./discovery-engine");
      const context = await getTokenHistoricalContext(req.params.tokenMint);
      res.json(context);
    } catch (error) {
      console.error("Error getting token history:", error);
      res.status(500).json({ error: "Failed to get token history" });
    }
  });

  app.get("/api/discovery/wallet-patterns/:walletAddress", requireAuth, async (req, res) => {
    try {
      const { getWalletPatternContext } = await import("./discovery-engine");
      const context = await getWalletPatternContext(req.params.walletAddress);
      res.json(context);
    } catch (error) {
      console.error("Error getting wallet patterns:", error);
      res.status(500).json({ error: "Failed to get wallet patterns" });
    }
  });

  app.get("/api/discovery/scan-stats", requireAuth, async (req, res) => {
    try {
      const { getScanContextStats } = await import("./discovery-engine");
      const stats = await getScanContextStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting scan stats:", error);
      res.status(500).json({ error: "Failed to get scan stats" });
    }
  });

  app.post("/api/discovery/self-improve", requireAuth, async (req, res) => {
    try {
      const { runSelfImprovementCycle } = await import("./discovery-engine");
      const result = await runSelfImprovementCycle();
      res.json(result);
    } catch (error) {
      console.error("Error running self-improvement:", error);
      res.status(500).json({ error: "Failed to run self-improvement" });
    }
  });

  app.get("/api/discovery/context-patterns", requireAuth, async (req, res) => {
    try {
      const { analyzeContextPatterns } = await import("./discovery-engine");
      const patterns = await analyzeContextPatterns();
      res.json({ patterns });
    } catch (error) {
      console.error("Error analyzing patterns:", error);
      res.status(500).json({ error: "Failed to analyze patterns" });
    }
  });

  // ============ Discovery Page Routes ============

  const discoveryCache = new Map<string, { data: any; expiresAt: number }>();
  function getCached(key: string): any | null {
    const entry = discoveryCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.data;
    discoveryCache.delete(key);
    return null;
  }
  function setCache(key: string, data: any, ttlMs: number = 30000) {
    discoveryCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  app.get("/api/discovery/ranked-tokens", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const sortBy = (req.query.sort as string) || "heat";
      const timeframe = (req.query.timeframe as string) || "24h";
      const cacheKey = `ranked-tokens:${sortBy}:${timeframe}:${limit}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);
      
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;

      const tokens = await db.select({
        tokenMint: tokenDataPool.tokenMint,
        tokenSymbol: tokenDataPool.tokenSymbol,
        tokenName: tokenDataPool.tokenName,
        priceUsd: tokenDataPool.priceUsd,
        priceUpdatedAt: tokenDataPool.priceUpdatedAt,
        marketCap: tokenDataPool.marketCap,
        liquidity: tokenDataPool.liquidity,
        volume24h: tokenDataPool.volume24h,
        priceChange1h: tokenDataPool.priceChange1h,
        priceChange6h: tokenDataPool.priceChange6h,
        priceChange24h: tokenDataPool.priceChange24h,
        priceChange7d: tokenDataPool.priceChange7d,
        boostRank: tokenDataPool.boostRank,
        trendingRank: tokenDataPool.trendingRank,
        trendingSource: tokenDataPool.trendingSource,
        isPumpfun: tokenDataPool.isPumpfun,
        pumpfunGraduated: tokenDataPool.pumpfunGraduated,
        updatedAt: tokenDataPool.updatedAt,
        createdAt: tokenDataPool.createdAt,
        hasTwitter: tokenDataPool.hasTwitter,
        hasTelegram: tokenDataPool.hasTelegram,
        hasWebsite: tokenDataPool.hasWebsite,
        twitterUrl: tokenDataPool.twitterUrl,
        telegramUrl: tokenDataPool.telegramUrl,
        websiteUrl: tokenDataPool.websiteUrl,
        pincherScoreRaw: tokenDataPool.pincherScoreRaw,
        pincherVerdict: tokenDataPool.pincherVerdict,
        pincherConfidence: tokenDataPool.pincherConfidence,
        pincherScoredAt: tokenDataPool.pincherScoredAt,
      })
        .from(tokenDataPool)
        .where(and(
          eq(tokenDataPool.isActive, true),
          gte(tokenDataPool.updatedAt, oneDayAgo)
        ))
        .orderBy(
          sortBy === "volume" ? desc(tokenDataPool.volume24h) :
          sortBy === "trending" ? asc(tokenDataPool.trendingRank) :
          sortBy === "boost" ? asc(tokenDataPool.boostRank) :
          sortBy === "price_change" ? desc(tokenDataPool.priceChange24h) :
          desc(tokenDataPool.volume24h)
        )
        .limit(sortBy === "heat" || sortBy === "score" || sortBy === "pincher" || sortBy === "combined" ? 200 : limit);

      const eventCounts = await db.select({
        tokenMint: discoveryEvents.tokenMint,
        eventCount: count(discoveryEvents.id),
      })
        .from(discoveryEvents)
        .where(gte(discoveryEvents.firedAt, oneDayAgo))
        .groupBy(discoveryEvents.tokenMint);

      const eventMap = new Map(eventCounts.map(e => [e.tokenMint, Number(e.eventCount)]));

      const insightCounts = await db.select({
        tokenMint: systemInsights.tokenMint,
        insightCount: count(systemInsights.id),
      })
        .from(systemInsights)
        .where(and(
          gte(systemInsights.createdAt, oneDayAgo),
          eq(systemInsights.status, 'active')
        ))
        .groupBy(systemInsights.tokenMint);

      const insightMap = new Map(insightCounts.map(i => [i.tokenMint, Number(i.insightCount)]));

      const { computeHeatScore, applyPincherDecay } = await import("./pincher-scoring");

      const dataQualityFiltered = tokens.filter(t => {
        if (!t.tokenSymbol && !t.priceUsd) return false;
        return true;
      });

      const ranked = dataQualityFiltered.map(t => {
        const events = eventMap.get(t.tokenMint) || 0;
        const insights = insightMap.get(t.tokenMint) || 0;

        let heatScore = computeHeatScore(t as any);
        heatScore += events * 3;
        heatScore += insights * 2;
        heatScore = Math.min(100, heatScore);

        let pincherScore: number | null = null;
        if (t.pincherScoreRaw != null && t.pincherScoredAt != null) {
          pincherScore = applyPincherDecay(t.pincherScoreRaw, t.pincherScoredAt);
        }

        const combinedScore = pincherScore != null
          ? Math.round((heatScore + pincherScore) / 2)
          : heatScore;

        const pc1h = t.priceChange1h ?? null;
        const pc6h = t.priceChange6h ?? null;
        const pc24h = t.priceChange24h ?? null;
        const pc7d = t.priceChange7d ?? null;

        const selectedPriceChange = timeframe === "1h" ? (pc1h ?? pc24h ?? null) :
          timeframe === "6h" ? (pc6h ?? pc24h ?? null) :
          timeframe === "7d" ? (pc7d ?? pc24h ?? null) : (pc24h ?? null);

        return {
          ...t,
          eventCount: events,
          insightCount: insights,
          heatScore,
          pincherScore,
          pincherVerdict: t.pincherVerdict,
          pincherConfidence: t.pincherConfidence,
          combinedScore,
          selectedPriceChange,
        };
      });

      if (sortBy === "pincher") {
        ranked.sort((a, b) => (b.pincherScore ?? -1) - (a.pincherScore ?? -1));
      } else if (sortBy === "heat") {
        ranked.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0));
      } else if (sortBy === "combined") {
        ranked.sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0));
      } else if (sortBy === "score") {
        ranked.sort((a, b) => (b.combinedScore ?? 0) - (a.combinedScore ?? 0));
      } else if (sortBy === "price_change") {
        ranked.sort((a, b) => (b.selectedPriceChange ?? 0) - (a.selectedPriceChange ?? 0));
      }

      const result = ranked.slice(0, limit);
      setCache(cacheKey, result, 30000);
      res.json(result);
    } catch (error) {
      console.error("Error getting ranked tokens:", error);
      res.status(500).json({ error: "Failed to get ranked tokens" });
    }
  });

  app.get("/api/discovery/ranked-wallets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 50);
      const cacheKey = `ranked-wallets:${userId}:${limit}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const wallets = await db.select().from(walletStrategies)
        .where(eq(walletStrategies.userId, userId))
        .orderBy(desc(walletStrategies.winRate))
        .limit(limit);

      if (wallets.length > 0) {
        const enriched = wallets.map(w => {
          const winRate = w.winRate ?? 0;
          const totalTrades = w.totalTrades ?? 0;
          const avgHoldTime = w.avgHoldTimeMinutes ?? 0;
          const profitFactor = w.profitFactor ?? 0;

          let score = 0;
          score += winRate * 40;
          score += Math.min(20, totalTrades * 0.5);
          score += Math.min(20, profitFactor * 5);
          if (avgHoldTime > 5 && avgHoldTime < 1440) score += 10;
          if (w.strategyType) score += 10;

          return { ...w, walletScore: Math.round(score) };
        });
        enriched.sort((a, b) => b.walletScore - a.walletScore);
        setCache(cacheKey, enriched, 30000);
        return res.json(enriched);
      }

      const monitored = await db.select({
        walletAddress: monitoredWallets.walletAddress,
        label: monitoredWallets.label,
        enabled: monitoredWallets.enabled,
        copyTradeEnabled: monitoredWallets.copyTradeEnabled,
        aiScore: monitoredWallets.aiScore,
        createdAt: monitoredWallets.createdAt,
      }).from(monitoredWallets)
        .where(and(eq(monitoredWallets.userId, userId), eq(monitoredWallets.enabled, true)))
        .orderBy(desc(monitoredWallets.createdAt))
        .limit(limit);

      const fallback = monitored.map(w => ({
        walletAddress: w.walletAddress,
        walletLabel: w.label,
        strategyType: w.copyTradeEnabled ? "copy-trade" : "signal",
        winRate: null,
        totalTrades: null,
        avgHoldTimeMinutes: null,
        profitFactor: null,
        avgBuySize: null,
        preferredTokenTypes: null,
        walletScore: w.aiScore ?? 0,
      }));
      setCache(cacheKey, fallback, 30000);
      res.json(fallback);
    } catch (error) {
      console.error("Error getting ranked wallets:", error);
      res.status(500).json({ error: "Failed to get ranked wallets" });
    }
  });

  app.get("/api/discovery/page-stats", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const cacheKey = `page-stats:${userId}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;
      const oneHourAgo = now - 3600;

      const [activeTokens] = await db.select({ count: count() }).from(tokenDataPool)
        .where(and(eq(tokenDataPool.isActive, true), gte(tokenDataPool.updatedAt, oneDayAgo)));

      const [strategyWallets] = await db.select({ count: count() }).from(walletStrategies)
        .where(eq(walletStrategies.userId, userId));
      const [monitoredCount] = await db.select({ count: count() }).from(monitoredWallets)
        .where(and(eq(monitoredWallets.userId, userId), eq(monitoredWallets.enabled, true)));
      const trackedWalletCount = Math.max(Number(strategyWallets?.count ?? 0), Number(monitoredCount?.count ?? 0));

      const [eventsToday] = await db.select({ count: count() }).from(discoveryEvents)
        .where(gte(discoveryEvents.firedAt, oneDayAgo));

      const [eventsHour] = await db.select({ count: count() }).from(discoveryEvents)
        .where(gte(discoveryEvents.firedAt, oneHourAgo));

      const [activeTriggers] = await db.select({ count: count() }).from(discoveryTriggers)
        .where(eq(discoveryTriggers.enabled, true));

      const [activeInsights] = await db.select({ count: count() }).from(systemInsights)
        .where(and(eq(systemInsights.status, 'active'), gte(systemInsights.expiresAt, now)));

      const [trendingTokens] = await db.select({ count: count() }).from(tokenDataPool)
        .where(and(eq(tokenDataPool.isActive, true), isNotNull(tokenDataPool.trendingRank)));

      const [boostedTokens] = await db.select({ count: count() }).from(tokenDataPool)
        .where(and(eq(tokenDataPool.isActive, true), isNotNull(tokenDataPool.boostRank)));

      const { getBusStats } = await import("./discovery-event-bus");

      const result = {
        activeTokens: Number(activeTokens?.count ?? 0),
        trackedWallets: trackedWalletCount,
        eventsToday: Number(eventsToday?.count ?? 0),
        eventsLastHour: Number(eventsHour?.count ?? 0),
        activeTriggers: Number(activeTriggers?.count ?? 0),
        activeInsights: Number(activeInsights?.count ?? 0),
        trendingTokens: Number(trendingTokens?.count ?? 0),
        boostedTokens: Number(boostedTokens?.count ?? 0),
        busStats: getBusStats(),
      };
      setCache(cacheKey, result, 30000);
      res.json(result);
    } catch (error) {
      console.error("Error getting discovery page stats:", error);
      res.status(500).json({ error: "Failed to get page stats" });
    }
  });

  app.get("/api/discovery/recent-insights", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const cacheKey = `recent-insights:${limit}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      const { getInsightsForContext } = await import("./insight-bus");
      const insights = await getInsightsForContext({ limit });
      setCache(cacheKey, insights, 30000);
      res.json(insights);
    } catch (error) {
      console.error("Error getting recent insights:", error);
      res.status(500).json({ error: "Failed to get insights" });
    }
  });

  app.get("/api/discovery/token-indicators/:tokenMint", requireAuth, async (req, res) => {
    try {
      const { getIndicators } = await import("./technical-indicators");
      const timeframe = (req.query.timeframe as string) || "1h";
      const result = await getIndicators(req.params.tokenMint, timeframe);
      if (!result) {
        return res.json({ available: false, message: "Not enough price data for indicators" });
      }
      res.json({ available: true, ...result });
    } catch (error) {
      console.error("Error getting indicators:", error);
      res.status(500).json({ error: "Failed to get indicators" });
    }
  });

  app.get("/api/discovery/social-callers", requireAuth, async (req, res) => {
    try {
      const { getTopCallers } = await import("./social-signals");
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const callers = await getTopCallers(limit);
      res.json(callers);
    } catch (error) {
      console.error("Error getting social callers:", error);
      res.status(500).json({ error: "Failed to get social callers" });
    }
  });

  app.get("/api/discovery/social-callers/:id", requireAuth, async (req, res) => {
    try {
      const { getCallerById, getCallerCalls } = await import("./social-signals");
      const callerId = parseInt(req.params.id);
      const caller = await getCallerById(callerId);
      if (!caller) return res.status(404).json({ error: "Caller not found" });
      const calls = await getCallerCalls(callerId, 50);
      res.json({ caller, calls });
    } catch (error) {
      console.error("Error getting caller detail:", error);
      res.status(500).json({ error: "Failed to get caller detail" });
    }
  });

  app.post("/api/discovery/social-callers", requireAuth, async (req, res) => {
    try {
      const { getOrCreateCaller } = await import("./social-signals");
      const { platform, handle, displayName, platformUrl } = req.body;
      if (!platform || !["twitter", "telegram"].includes(platform)) {
        return res.status(400).json({ error: "platform must be 'twitter' or 'telegram'" });
      }
      if (!handle || typeof handle !== "string" || handle.trim().length === 0) {
        return res.status(400).json({ error: "Valid handle (string) required" });
      }
      const caller = await getOrCreateCaller(platform, handle.trim(), displayName, platformUrl);
      res.json(caller);
    } catch (error) {
      console.error("Error creating social caller:", error);
      res.status(500).json({ error: "Failed to create caller" });
    }
  });

  app.post("/api/discovery/social-calls", requireAuth, async (req, res) => {
    try {
      const { recordCall } = await import("./social-signals");
      const { callerId, tokenMint, tokenSymbol, platform, sourceUrl, messageText } = req.body;
      if (!callerId || typeof callerId !== "number") {
        return res.status(400).json({ error: "Valid callerId (number) required" });
      }
      if (!tokenMint || typeof tokenMint !== "string") {
        return res.status(400).json({ error: "Valid tokenMint (string) required" });
      }
      if (!platform || !["twitter", "telegram"].includes(platform)) {
        return res.status(400).json({ error: "platform must be 'twitter' or 'telegram'" });
      }
      const call = await recordCall({ callerId, tokenMint, tokenSymbol, platform, sourceUrl, messageText });
      res.json(call);
    } catch (error: any) {
      if (error?.message?.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      console.error("Error recording social call:", error);
      res.status(500).json({ error: "Failed to record call" });
    }
  });

  app.post("/api/discovery/social-evaluate", requireAuth, async (req, res) => {
    try {
      const { evaluatePendingCalls } = await import("./social-signals");
      const result = await evaluatePendingCalls();
      res.json(result);
    } catch (error) {
      console.error("Error evaluating social calls:", error);
      res.status(500).json({ error: "Failed to evaluate calls" });
    }
  });

  app.get("/api/compute/worker-config", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      res.json({
        supportedTaskTypes: ["price_slope"],
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get worker config" });
    }
  });

  app.get("/api/compute/task", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { assignTask, getSourceTrustScore } = await import("./compute-manager");
      const sourceId = `browser-${req.userId}`;
      const trustScore = await getSourceTrustScore(sourceId);

      const supportedTypes = req.query.types
        ? (req.query.types as string).split(",")
        : undefined;

      const task = await assignTask(sourceId, trustScore, supportedTypes);
      res.json({ task, trustScore });
    } catch (error) {
      console.error("Error assigning compute task:", error);
      res.status(500).json({ error: "Failed to assign task" });
    }
  });

  app.post("/api/compute/task/:taskId/complete", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { completeComputeTask } = await import("./compute-manager");
      const taskId = parseInt(req.params.taskId);
      const sourceId = `browser-${req.userId}`;
      const { result: taskResult, computeTimeMs } = req.body;
      const { task, spotCheckTriggered } = await completeComputeTask(taskId, sourceId, taskResult || {}, computeTimeMs || 0);
      res.json({ task, spotCheckTriggered });
    } catch (error) {
      console.error("Error completing compute task:", error);
      res.status(500).json({ error: "Failed to complete task" });
    }
  });

  app.post("/api/compute/task/:taskId/fail", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { failComputeTask } = await import("./compute-manager");
      const taskId = parseInt(req.params.taskId);
      const sourceId = `browser-${req.userId}`;
      const task = await failComputeTask(taskId, sourceId, req.body.error || "Unknown error");
      res.json({ task });
    } catch (error) {
      console.error("Error failing compute task:", error);
      res.status(500).json({ error: "Failed to report task failure" });
    }
  });

  app.get("/api/admin/compute/stats", requireAuth, async (req, res) => {
    try {
      const { getComputeStats } = await import("./compute-manager");
      const stats = await getComputeStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting compute stats:", error);
      res.status(500).json({ error: "Failed to get compute stats" });
    }
  });

  app.post("/api/admin/compute/generate-tasks", requireAuth, async (req, res) => {
    try {
      const { generatePriceSlopeTasks, generateHolderOverlapTasks, generateWalletCorrelationTasks } = await import("./compute-manager");
      const { taskType, tokenMints, walletAddresses } = req.body;
      let created = 0;
      if (taskType === "price_slope") {
        created = await generatePriceSlopeTasks(req.body.limit || 20);
      } else if (taskType === "holder_overlap" && tokenMints) {
        created = await generateHolderOverlapTasks(tokenMints);
      } else if (taskType === "wallet_correlation" && walletAddresses) {
        created = await generateWalletCorrelationTasks(walletAddresses);
      }
      res.json({ created });
    } catch (error) {
      console.error("Error generating tasks:", error);
      res.status(500).json({ error: "Failed to generate tasks" });
    }
  });

  app.get("/api/wallet-discovery/discovered", requireAuth, async (req, res) => {
    try {
      const { getTopDiscoveredWallets, getCopyChainStats } = await import("./wallet-discovery");
      const minScore = parseInt(req.query.minScore as string) || 60;
      const limit = parseInt(req.query.limit as string) || 20;
      const wallets = await getTopDiscoveredWallets(limit, minScore);
      const stats = await getCopyChainStats();
      res.json({ wallets, stats });
    } catch (error) {
      console.error("Error fetching discovered wallets:", error);
      res.status(500).json({ error: "Failed to fetch discovered wallets" });
    }
  });

  app.get("/api/wallet-discovery/leaders", requireAuth, async (req, res) => {
    try {
      const { getLeaderWallets } = await import("./wallet-discovery");
      const leaders = await getLeaderWallets();
      res.json({ leaders });
    } catch (error) {
      console.error("Error fetching leader wallets:", error);
      res.status(500).json({ error: "Failed to fetch leader wallets" });
    }
  });

  app.post("/api/wallet-discovery/run-cycle", requireAuth, async (req, res) => {
    try {
      const { runWalletDiscoveryCycle } = await import("./wallet-discovery");
      const result = await runWalletDiscoveryCycle();
      res.json(result);
    } catch (error) {
      console.error("Error running wallet discovery:", error);
      res.status(500).json({ error: "Failed to run wallet discovery" });
    }
  });

  app.get("/api/wallet-discovery/score/:address", requireAuth, async (req, res) => {
    try {
      const { scoreWalletForSignal } = await import("./wallet-discovery");
      const result = await scoreWalletForSignal(req.params.address);
      res.json(result);
    } catch (error) {
      console.error("Error scoring wallet:", error);
      res.status(500).json({ error: "Failed to score wallet" });
    }
  });

  app.post("/api/wallet-discovery/track-chain", requireAuth, async (req, res) => {
    try {
      const { trackCopyChain } = await import("./wallet-discovery");
      const { wallet, maxDepth } = req.body;
      if (!wallet) {
        return res.status(400).json({ error: "Wallet address required" });
      }
      const result = await trackCopyChain(wallet, maxDepth || 3);
      res.json(result);
    } catch (error) {
      console.error("Error tracking copy chain:", error);
      res.status(500).json({ error: "Failed to track copy chain" });
    }
  });

  app.get("/api/wallet-discovery/outcomes/:address", requireAuth, async (req, res) => {
    try {
      const { getWalletOutcomes } = await import("./wallet-discovery");
      const days = parseInt(req.query.days as string) || 30;
      const outcomes = await getWalletOutcomes(req.params.address, days);
      res.json({ outcomes });
    } catch (error) {
      console.error("Error fetching wallet outcomes:", error);
      res.status(500).json({ error: "Failed to fetch wallet outcomes" });
    }
  });

  app.get("/api/whale-reputation/:address", requireAuth, async (req, res) => {
    try {
      const { buildWhaleReputation, getCachedWhaleReputation } = await import("./whale-reputation");
      const days = parseInt(req.query.days as string) || 30;
      let reputation = getCachedWhaleReputation(req.params.address);
      if (!reputation) {
        reputation = await buildWhaleReputation(req.params.address, days);
      }
      res.json(reputation);
    } catch (error) {
      console.error("Error fetching whale reputation:", error);
      res.status(500).json({ error: "Failed to fetch whale reputation" });
    }
  });

  app.get("/api/whale-reputation/top", requireAuth, async (req, res) => {
    try {
      const { getTopWhales } = await import("./whale-reputation");
      const limit = parseInt(req.query.limit as string) || 20;
      const minTrades = parseInt(req.query.minTrades as string) || 5;
      const whales = await getTopWhales(limit, minTrades);
      res.json({ whales });
    } catch (error) {
      console.error("Error fetching top whales:", error);
      res.status(500).json({ error: "Failed to fetch top whales" });
    }
  });

  app.get("/api/whale-reputation/red-flags", requireAuth, async (req, res) => {
    try {
      const { getRedFlagWhales } = await import("./whale-reputation");
      const minTrades = parseInt(req.query.minTrades as string) || 10;
      const whales = await getRedFlagWhales(minTrades);
      res.json({ whales });
    } catch (error) {
      console.error("Error fetching red flag whales:", error);
      res.status(500).json({ error: "Failed to fetch red flag whales" });
    }
  });

  app.get("/api/whale-reputation/blacklist-candidates", requireAuth, async (req, res) => {
    try {
      const { getBlacklistCandidates } = await import("./whale-reputation");
      const candidates = await getBlacklistCandidates();
      res.json({ candidates });
    } catch (error) {
      console.error("Error fetching blacklist candidates:", error);
      res.status(500).json({ error: "Failed to fetch blacklist candidates" });
    }
  });

  app.post("/api/whale-reputation/scan", requireAuth, async (req, res) => {
    try {
      const { runWhaleReputationScan } = await import("./whale-reputation");
      const days = parseInt(req.body.days) || 14;
      const result = await runWhaleReputationScan(days);
      res.json(result);
    } catch (error) {
      console.error("Error running whale reputation scan:", error);
      res.status(500).json({ error: "Failed to run whale reputation scan" });
    }
  });

  app.get("/api/whale-reputation/outcomes/:address", requireAuth, async (req, res) => {
    try {
      const { getWhaleOutcomes } = await import("./whale-reputation");
      const days = parseInt(req.query.days as string) || 30;
      const outcomes = await getWhaleOutcomes(req.params.address, days);
      res.json({ outcomes });
    } catch (error) {
      console.error("Error fetching whale outcomes:", error);
      res.status(500).json({ error: "Failed to fetch whale outcomes" });
    }
  });

  app.get("/api/timeframe/daily", requireAuth, async (req, res) => {
    try {
      const { getDailyWinnerAggregation } = await import("./timeframe-analysis");
      const dateStr = req.query.date as string;
      const date = dateStr ? new Date(dateStr) : new Date();
      const aggregation = await getDailyWinnerAggregation(date);
      res.json(aggregation);
    } catch (error) {
      console.error("Error fetching daily aggregation:", error);
      res.status(500).json({ error: "Failed to fetch daily aggregation" });
    }
  });

  app.get("/api/timeframe/weekly", requireAuth, async (req, res) => {
    try {
      const { getWeeklySourceReview } = await import("./timeframe-analysis");
      const review = await getWeeklySourceReview();
      res.json(review);
    } catch (error) {
      console.error("Error fetching weekly review:", error);
      res.status(500).json({ error: "Failed to fetch weekly review" });
    }
  });

  app.get("/api/timeframe/hot-movers", requireAuth, async (req, res) => {
    try {
      const { getHourlyHotMovers } = await import("./timeframe-analysis");
      const limit = parseInt(req.query.limit as string) || 20;
      const movers = await getHourlyHotMovers(limit);
      res.json({ movers });
    } catch (error) {
      console.error("Error fetching hot movers:", error);
      res.status(500).json({ error: "Failed to fetch hot movers" });
    }
  });

  app.get("/api/social/sources", requireAuth, async (req, res) => {
    try {
      const { getTopSocialSources, getSocialSourceStats } = await import("./social-discovery");
      const limit = parseInt(req.query.limit as string) || 20;
      const sources = await getTopSocialSources(limit);
      const stats = await getSocialSourceStats();
      res.json({ sources, stats });
    } catch (error) {
      console.error("Error fetching social sources:", error);
      res.status(500).json({ error: "Failed to fetch social sources" });
    }
  });

  app.get("/api/social/calls", requireAuth, async (req, res) => {
    try {
      const { getRecentSocialCalls } = await import("./social-discovery");
      const limit = parseInt(req.query.limit as string) || 20;
      const calls = getRecentSocialCalls(limit);
      res.json({ calls });
    } catch (error) {
      console.error("Error fetching social calls:", error);
      res.status(500).json({ error: "Failed to fetch social calls" });
    }
  });

  app.post("/api/social/discover", requireAuth, async (req, res) => {
    try {
      const { discoverSocialSourcesFromWinners } = await import("./social-discovery");
      const result = await discoverSocialSourcesFromWinners(72, 20);
      res.json(result);
    } catch (error) {
      console.error("Error discovering social sources:", error);
      res.status(500).json({ error: "Failed to discover social sources" });
    }
  });

  app.get("/api/social/boost/:symbol", requireAuth, async (req, res) => {
    try {
      const { getSocialBoostForToken } = await import("./social-discovery");
      const boost = getSocialBoostForToken(req.params.symbol);
      res.json({ symbol: req.params.symbol, boost });
    } catch (error) {
      console.error("Error getting social boost:", error);
      res.status(500).json({ error: "Failed to get social boost" });
    }
  });

  app.get("/api/background-jobs/status", requireAuth, async (req, res) => {
    try {
      const { getJobStatuses } = await import("./background-jobs");
      const statuses = getJobStatuses();
      res.json({ jobs: statuses });
    } catch (error) {
      console.error("Error fetching job statuses:", error);
      res.status(500).json({ error: "Failed to fetch job statuses" });
    }
  });

  app.post("/api/background-jobs/run/:jobName", requireAuth, async (req, res) => {
    try {
      const { runJobManually } = await import("./background-jobs");
      const result = await runJobManually(req.params.jobName);
      res.json({ success: true, result });
    } catch (error: any) {
      console.error("Error running job:", error);
      res.status(500).json({ error: error.message || "Failed to run job" });
    }
  });

  // Restore monitoring on startup if it was active
  restoreMonitoring();
  
  // Start the trade processor to handle pending buys
  startTradeProcessor();
  
  // Start the price monitor to check holdings and trigger reclaims
  startPriceMonitor();

  // Start hourly cleanup of system logs (keeps only 100 most recent)
  startSystemLogCleanup();

  return httpServer;
}

let monitoringRetryTimer: ReturnType<typeof setInterval> | null = null;
let pollingFallbackTimer: ReturnType<typeof setInterval> | null = null;
let pollingIdleCount = 0;

function startPollingFallback() {
  if (pollingFallbackTimer) return;
  const BASE_INTERVAL = 60 * 1000;
  const MAX_INTERVAL = 3 * 60 * 1000;
  pollingIdleCount = 0;
  
  console.log("[PollingFallback] Starting swap polling (webhook is down)");
  
  const runPoll = async () => {
    try {
      const status = await storage.getMonitoringStatus();
      if (status.isActive && status.webhookId) {
        console.log("[PollingFallback] Webhook is back, stopping polling");
        stopPollingFallback();
        return;
      }
      
      const allWallets = await storage.getAllMonitoredWallets();
      const enabledWallets = allWallets.filter(w => w.enabled);
      if (enabledWallets.length === 0) return;
      
      let totalNewSwaps = 0;
      
      for (const wallet of enabledWallets) {
        try {
          const recentSwaps = await fetchWalletSwapHistory(wallet.walletAddress, 5);
          
          for (const histSwap of recentSwaps) {
            const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
            if (histSwap.timestamp < fiveMinutesAgo) continue;
            
            const existing = await storage.getSwapBySignature(histSwap.signature, wallet.userId);
            if (existing) continue;
            
            const isBuy = histSwap.type === "BUY";
            const swapData: any = {
              userId: wallet.userId,
              signature: histSwap.signature,
              timestamp: histSwap.timestamp,
              type: "SWAP",
              source: wallet.walletAddress,
              fromToken: isBuy ? SOL_MINT : histSwap.tokenMint,
              fromTokenSymbol: isBuy ? "SOL" : histSwap.tokenSymbol,
              fromAmount: isBuy ? histSwap.solAmount : histSwap.tokenAmount,
              toToken: isBuy ? histSwap.tokenMint : SOL_MINT,
              toTokenSymbol: isBuy ? histSwap.tokenSymbol : "SOL",
              toAmount: isBuy ? histSwap.tokenAmount : histSwap.solAmount,
              fee: null,
              slot: 0,
              notificationSent: false,
              toTokenMetadata: null,
            };
            
            const toTokenMetadata = await fetchTokenMetadata(isBuy ? histSwap.tokenMint : SOL_MINT);
            if (toTokenMetadata) {
              swapData.toTokenMetadata = toTokenMetadata;
              if (toTokenMetadata.symbol && (swapData.toTokenSymbol === "???" || swapData.toTokenSymbol?.includes("..."))) {
                swapData.toTokenSymbol = toTokenMetadata.symbol;
              }
            }
            
            if (!isBuy && (swapData.fromTokenSymbol === "???" || swapData.fromTokenSymbol?.includes("..."))) {
              const fromMeta = await fetchTokenMetadata(histSwap.tokenMint);
              if (fromMeta?.symbol) swapData.fromTokenSymbol = fromMeta.symbol;
            }
            
            const { getSolPriceUsd } = await import("./jupiter");
            swapData.solPriceAtTrade = await getSolPriceUsd();
            
            const savedSwap = await storage.addSwap(swapData);
            totalNewSwaps++;
            console.log(`[PollingFallback] New swap detected: ${isBuy ? 'BUY' : 'SELL'} ${swapData.toTokenSymbol} from wallet ${wallet.label || wallet.walletAddress.slice(0, 8)}`);
            
            broadcastSwap(savedSwap);
            
            if (isBuy) {
              try {
                const { emit } = await import("./discovery-event-bus");
                await emit({
                  type: "signal_buy",
                  tokenMint: histSwap.tokenMint,
                  tokenSymbol: histSwap.tokenSymbol || undefined,
                  source: "polling_fallback",
                  data: {
                    walletAddress: wallet.walletAddress,
                    fromAmount: histSwap.solAmount,
                    toAmount: histSwap.tokenAmount,
                    solPriceAtTrade: swapData.solPriceAtTrade,
                  },
                  timestamp: Date.now(),
                  urgency: 6,
                });
              } catch (_) {}
            }
            
            const tokenMintForAlert = isBuy ? histSwap.tokenMint : swapData.fromToken;
            const userHasPosition = await db.select({ id: holdings.id }).from(holdings)
              .where(and(
                eq(holdings.userId, wallet.userId),
                eq(holdings.tokenMint, tokenMintForAlert),
                eq(holdings.reclaimed, false)
              ))
              .limit(1);
            
            sendTelegramActivityAlert(wallet.userId, {
              walletLabel: wallet.label || "Wallet",
              walletAddress: wallet.walletAddress,
              tokenSymbol: isBuy ? swapData.toTokenSymbol : swapData.fromTokenSymbol,
              tokenMint: tokenMintForAlert,
              type: isBuy ? "buy" : "sell",
              amount: isBuy ? histSwap.tokenAmount : histSwap.tokenAmount,
              solAmount: histSwap.solAmount,
              priceUsd: toTokenMetadata?.priceUsd,
              walletId: wallet.id,
              hasPosition: userHasPosition.length > 0,
            }).catch(err => console.error("[PollingFallback] Telegram alert error:", err));
            
            if (isBuy && wallet.copyTradeEnabled && !isBaseCurrency(histSwap.tokenMint)) {
              const isBlacklisted = await isTokenBlacklisted(wallet.userId, histSwap.tokenMint);
              if (!isBlacklisted) {
                const walletCopyConfig = {
                  copyBuyType: wallet.copyBuyType || undefined,
                  copyBuyAmount: wallet.copyBuyAmount || undefined,
                  copyMinBalance: wallet.copyMinBalance || undefined,
                  copyMinTradeUsd: wallet.copyMinTradeUsd || undefined,
                  copyScoreThreshold: wallet.copyScoreThreshold || undefined,
                  copyTiming: wallet.copyTiming || undefined,
                  copyDelayMinutes: wallet.copyDelayMinutes || undefined,
                  copyAutoMirror: wallet.copyAutoMirror || undefined,
                  dedupSkipIfHolding: wallet.dedupSkipIfHolding ?? true,
                  dedupSkipIfEverHeld: wallet.dedupSkipIfEverHeld ?? false,
                  dedupSkipIfPending: wallet.dedupSkipIfPending ?? true,
                };
                
                console.log(`[PollingFallback] Triggering copy trade for ${swapData.toTokenSymbol}...`);
                const pendingBuy = await addPendingBuy(
                  wallet.userId,
                  histSwap.tokenMint,
                  swapData.toTokenSymbol,
                  toTokenMetadata?.name,
                  toTokenMetadata?.priceUsd,
                  toTokenMetadata?.liquidity,
                  {
                    swapId: savedSwap.id,
                    walletAddress: wallet.walletAddress,
                    walletLabel: wallet.label,
                    signalWalletId: wallet.id,
                    config: walletCopyConfig,
                  }
                );
                if (pendingBuy) {
                  console.log(`[PollingFallback] Copy trade queued: ${swapData.toTokenSymbol} (pending buy #${pendingBuy.id})`);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[PollingFallback] Error polling wallet ${wallet.label || wallet.walletAddress.slice(0, 8)}:`, err);
        }
      }
      
      if (totalNewSwaps > 0) {
        pollingIdleCount = 0;
        console.log(`[PollingFallback] Poll complete: ${totalNewSwaps} new swap(s) detected`);
      } else {
        pollingIdleCount++;
      }
      
      const interval = pollingIdleCount > 5 ? MAX_INTERVAL : BASE_INTERVAL;
      pollingFallbackTimer = setTimeout(runPoll, interval);
    } catch (error) {
      console.error("[PollingFallback] Poll error:", error);
      pollingFallbackTimer = setTimeout(runPoll, BASE_INTERVAL);
    }
  };
  
  pollingFallbackTimer = setTimeout(runPoll, 5000);
}

function stopPollingFallback() {
  if (pollingFallbackTimer) {
    clearTimeout(pollingFallbackTimer);
    pollingFallbackTimer = null;
    pollingIdleCount = 0;
    console.log("[PollingFallback] Stopped");
  }
}

async function attemptWebhookCreation(fullUrl: string, uniqueAddresses: string[]): Promise<string | null> {
  const delays = [0, 5000, 15000, 45000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      console.log(`[Monitoring] Retry ${attempt + 1}/${delays.length - 1} in ${delays[attempt] / 1000}s...`);
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
    const webhookId = await createWebhook(fullUrl, uniqueAddresses);
    if (webhookId) return webhookId;
    console.warn(`[Monitoring] Webhook creation attempt ${attempt + 1}/${delays.length} failed`);
  }
  return null;
}

function startMonitoringRetryLoop() {
  if (monitoringRetryTimer) return;
  const RETRY_INTERVAL = 5 * 60 * 1000;
  console.log("[Monitoring] Starting background retry (every 5min) until webhook is created");
  monitoringRetryTimer = setInterval(async () => {
    try {
      const status = await storage.getMonitoringStatus();
      if (status.isActive && status.webhookId) {
        console.log("[Monitoring] Webhook now active, stopping background retry");
        if (monitoringRetryTimer) { clearInterval(monitoringRetryTimer); monitoringRetryTimer = null; }
        return;
      }
      const allWallets = await storage.getAllMonitoredWallets();
      const uniqueAddresses = [...new Set(allWallets.filter(w => w.enabled).map(w => w.walletAddress))];
      if (uniqueAddresses.length === 0) {
        console.log("[Monitoring] No enabled wallets, stopping background retry");
        if (monitoringRetryTimer) { clearInterval(monitoringRetryTimer); monitoringRetryTimer = null; }
        return;
      }
      const currentUrl = getWebhookUrl();
      const webhookSecret = process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret";
      const fullUrl = `${currentUrl}?secret=${webhookSecret}`;

      console.log(`[Monitoring] Background retry: cleanup stale webhooks first...`);
      const { cleaned, reusable } = await cleanupStaleWebhooks(currentUrl);

      if (reusable) {
        console.log(`[Monitoring] Background retry: reusing webhook ${reusable}, updating wallets...`);
        const updated = await updateWebhookUrl(reusable, fullUrl, uniqueAddresses);
        if (updated) {
          await storage.updateMonitoringStatus({ isActive: true, webhookId: reusable });
          console.log("[Monitoring] Background retry succeeded via reuse, webhook active:", reusable);
          if (monitoringRetryTimer) { clearInterval(monitoringRetryTimer); monitoringRetryTimer = null; }
          stopPollingFallback();
          return;
        }
      }

      console.log(`[Monitoring] Background retry: creating webhook for ${uniqueAddresses.length} wallet(s) -> ${currentUrl}`);
      const webhookId = await createWebhook(fullUrl, uniqueAddresses);
      if (webhookId) {
        await storage.updateMonitoringStatus({ isActive: true, webhookId });
        console.log("[Monitoring] Background retry succeeded, webhook active:", webhookId);
        if (monitoringRetryTimer) { clearInterval(monitoringRetryTimer); monitoringRetryTimer = null; }
        stopPollingFallback();
      } else {
        console.warn("[Monitoring] Background retry failed, will try again in 5min");
        startPollingFallback();
      }
    } catch (error) {
      console.error("[Monitoring] Background retry error:", error);
    }
  }, RETRY_INTERVAL);
}

async function restoreMonitoring() {
  try {
    const status = await storage.getMonitoringStatus();
    console.log("[Monitoring] Startup check:", status.isActive ? "ACTIVE" : "INACTIVE", "webhookId:", status.webhookId || "none");
    
    const allWallets = await storage.getAllMonitoredWallets();
    const walletAddresses = allWallets.filter(w => w.enabled).map(w => w.walletAddress);
    const uniqueAddresses = [...new Set(walletAddresses)];

    if (uniqueAddresses.length === 0) {
      if (status.isActive && status.webhookId) {
        console.log("[Monitoring] No enabled wallets, deactivating");
        await deleteWebhook(status.webhookId);
        await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
      }
      console.log("[Monitoring] Cleaning up any orphaned webhooks...");
      await cleanupStaleWebhooks(getWebhookUrl());
      return;
    }

    const currentUrl = getWebhookUrl();
    const webhookSecret = process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret";
    const fullUrl = `${currentUrl}?secret=${webhookSecret}`;
    console.log(`[Monitoring] Webhook URL: ${currentUrl}, wallets: ${uniqueAddresses.length}`);

    console.log("[Monitoring] Step 1: Cleaning up stale/orphaned webhooks...");
    const { cleaned, reusable } = await cleanupStaleWebhooks(currentUrl, status.webhookId || undefined);
    if (cleaned > 0) {
      console.log(`[Monitoring] Cleaned ${cleaned} stale webhook(s)`);
    }

    if (status.isActive && status.webhookId) {
      console.log("[Monitoring] Step 2: Was active, updating existing webhook...");
      const updated = await updateWebhookUrl(status.webhookId, fullUrl, uniqueAddresses);
      if (updated) {
        console.log("[Monitoring] Webhook updated successfully");
        return;
      }
      console.log("[Monitoring] Update failed (webhook may be invalid), will try reuse or recreate...");
    }

    if (reusable && reusable !== status.webhookId) {
      console.log(`[Monitoring] Step 2b: Trying to reuse webhook ${reusable}...`);
      const updated = await updateWebhookUrl(reusable, fullUrl, uniqueAddresses);
      if (updated) {
        await storage.updateMonitoringStatus({ isActive: true, webhookId: reusable });
        console.log("[Monitoring] Reused existing webhook:", reusable);
        return;
      }
      console.log("[Monitoring] Reuse failed, will create new...");
    }

    console.log(`[Monitoring] Step 3: Creating new webhook for ${uniqueAddresses.length} wallet(s)...`);
    const newWebhookId = await attemptWebhookCreation(fullUrl, uniqueAddresses);
    if (newWebhookId) {
      await storage.updateMonitoringStatus({ isActive: true, webhookId: newWebhookId });
      console.log("[Monitoring] Webhook created and active:", newWebhookId);
    } else {
      console.error("[Monitoring] All webhook creation attempts failed");
      await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
      startMonitoringRetryLoop();
      startPollingFallback();
    }
  } catch (error) {
    console.error("[Monitoring] Error restoring monitoring:", error);
    startMonitoringRetryLoop();
    startPollingFallback();
  }
}
