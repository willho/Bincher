import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl, getSwapWalletAddress, isBaseCurrency, isBaseCurrencySymbol } from "./helius";
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
} from "./api-keys";
import { notificationSettingsSchema, tradeConfigSchema } from "@shared/schema";
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
import { holdings, monitoredWallets, swaps } from "@shared/schema";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { startTradeProcessor, updateBuyCount, checkPriceRiseTrigger } from "./trade-processor";
import { startPriceMonitor } from "./price-monitor";
import { scoreToken, refreshScore, chatWithAI, getChatHistory, clearChatHistory, getAIInsights, getSnapshot, getAllSnapshots, getPincherWelcomeMessage, getFilteredEventsForUser, getUserPreferences, updateUserPreferences, setAdminInstructions } from "./ai";
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
    } else {
      res.json({ authenticated: false });
    }
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
      const { username, password, heliusApiKey, cashoutWallet, adminCodeword } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      if (!heliusApiKey) {
        return res.status(400).json({ error: "Helius API key is required" });
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

      const result = await createUser(username, password, cashoutWallet, grantAdmin);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Store the Helius API key for the new user
      if (result.userId) {
        try {
          await addUserApiKey(result.userId, "helius", heliusApiKey, "Helius API Key");
        } catch (keyError) {
          console.error("Failed to store API key:", keyError);
          return res.status(500).json({ error: "Account created but failed to store API key. Please add it in settings." });
        }
      }

      res.json({ success: true, isAdmin: grantAdmin, showWizard: grantAdmin });
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

        // Fetch token metadata for the token being bought
        const toTokenMetadata = await fetchTokenMetadata(swap.toToken);
        if (toTokenMetadata) {
          swap.toTokenMetadata = toTokenMetadata;
          console.log("Token metadata fetched:", toTokenMetadata.symbol, "MC:", toTokenMetadata.marketCap);
        }

        const savedSwap = await storage.addSwap(swap);
        console.log("Swap detected and saved:", savedSwap.id, "for user:", userId);

        // Broadcast to WebSocket clients
        broadcastSwap(savedSwap);

        // Whale detection: Check if the swapper is in top 100 holders of the token
        // For BUYs (SOL/USDC -> Token), check the toToken; for SELLs (Token -> SOL/USDC), check the fromToken
        // Use mint-based detection for robustness (doesn't depend on symbol mapping)
        const isBuy = isBaseCurrency(swap.fromToken);
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
          
          // Send Telegram whale alert
          const whaleTokenSymbol = isBuy ? swap.toTokenSymbol : swap.fromTokenSymbol;
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
        // Check both global copy trading setting AND wallet-specific copy trade setting
        const tradeConf = await getTradeConfig(userId);
        const walletCopyEnabled = sourceWallet?.copyTradeEnabled === true;
        
        // Global copy trading must be enabled, AND this specific wallet must have copy trading enabled
        // Note: per-wallet dedup settings are applied inside addPendingBuy
        if (tradeConf.enabled && walletCopyEnabled && isBuy) {
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
            
            // Calculate source trade USD value for filtering
            const sourceTradeUsd = toTokenMetadata?.priceUsd && swap.toAmount 
              ? parseFloat(swap.toAmount) * toTokenMetadata.priceUsd 
              : undefined;
            
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
              console.log("Copy trade: Queued pending buy for", swap.toTokenSymbol, "for user:", userId, "from wallet:", sourceWallet?.label || swapWalletAddress);
            }
        } else if (tradeConf.enabled && isBuy && !walletCopyEnabled) {
          console.log("Copy trade: Wallet", sourceWallet?.label || swapWalletAddress, "doesn't have copy trading enabled, skipping");
        }
        
        // Auto-mirror logic: Check if signal wallet is trading a token we already hold from them
        if (sourceWallet && tradeConf.enabled) {
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
            
            if (isBuy && sourceWallet.copyAutoMirror) {
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
              const tokenMintForSell = swap.fromTokenMint;
              try {
                const markedCount = await markSignalWalletSold(sourceWallet.id, tokenMintForSell);
                if (markedCount > 0) {
                  console.log(`[PositionScore] Marked ${markedCount} positions as signal wallet sold for ${swap.fromTokenSymbol}`);
                }
              } catch (error) {
                console.error(`[PositionScore] Error marking signal wallet sold:`, error);
              }
              
              if (position.autoMirrorSells) {
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

        // Update status
        const status = await storage.getMonitoringStatus();
        broadcastStatus(status);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error processing webhook:", error);
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
      res.json({
        linked: !!user?.telegramChatId,
        linkedAt: user?.telegramLinkedAt,
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
      res.json(wallet);
    } catch (error) {
      console.error("Error adding monitored wallet:", error);
      res.status(500).json({ error: "Failed to add monitored wallet" });
    }
  });

  app.patch("/api/monitored-wallets/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const walletId = parseInt(req.params.id);
      const { label, enabled } = req.body;
      
      const wallet = await storage.updateMonitoredWallet(req.userId!, walletId, { label, enabled });
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
        dedupSkipIfHolding: updated.dedupSkipIfHolding ?? true,
        dedupSkipIfEverHeld: updated.dedupSkipIfEverHeld ?? false,
        dedupSkipIfPending: updated.dedupSkipIfPending ?? true,
      });
    } catch (error) {
      console.error("Error updating wallet copy config:", error);
      res.status(500).json({ error: "Failed to update wallet copy config" });
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
      
      await setNetworkMode(mode as NetworkMode, req.userId!);
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

  app.get("/api/snapshots/token/:tokenMint", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { getSnapshotByToken } = await import("./ai");
      const snapshot = await getSnapshotByToken(req.params.tokenMint as string);
      if (!snapshot) {
        return res.status(404).json({ error: "No snapshot found for this token" });
      }
      res.json(snapshot);
    } catch (error) {
      console.error("Error getting snapshot by token:", error);
      res.status(500).json({ error: "Failed to get snapshot" });
    }
  });

  app.get("/api/token/:tokenMint/signal-sources", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const tokenMint = req.params.tokenMint as string;
      
      const signalSources = await db.select({
        walletAddress: holdings.sourceWalletAddress,
        walletLabel: monitoredWallets.label,
        signalWalletId: holdings.signalWalletId,
        buyTimestamp: holdings.buyTimestamp,
        buyPrice: holdings.buyPrice,
        solSpent: holdings.solSpent,
        tokenSymbol: holdings.tokenSymbol,
      })
        .from(holdings)
        .leftJoin(monitoredWallets, eq(holdings.signalWalletId, monitoredWallets.id))
        .where(
          and(
            eq(holdings.tokenMint, tokenMint),
            eq(holdings.userId, req.userId!),
            isNotNull(holdings.sourceWalletAddress)
          )
        )
        .orderBy(desc(holdings.buyTimestamp));
      
      const uniqueSources = signalSources.reduce((acc, source) => {
        const key = source.walletAddress || '';
        if (!acc.has(key)) {
          acc.set(key, {
            walletAddress: source.walletAddress,
            walletLabel: source.walletLabel,
            firstSignal: source.buyTimestamp,
            totalBuys: 1,
            totalSolSpent: source.solSpent,
          });
        } else {
          const existing = acc.get(key)!;
          existing.totalBuys++;
          existing.totalSolSpent += source.solSpent;
          if (source.buyTimestamp < existing.firstSignal) {
            existing.firstSignal = source.buyTimestamp;
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

  // Chat with AI
  app.post("/api/ai/chat", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: "Message is required" });
      }
      
      const { handleMessage } = await import("./intent-parser");
      const { isAIAvailable, getFallbackMessage } = await import("./ai-health");
      
      const intentResult = await handleMessage(req.userId!, message);
      
      if (intentResult.handled && intentResult.response) {
        res.json({ response: intentResult.response });
        return;
      }
      
      if (!isAIAvailable()) {
        const fallbackMsg = getFallbackMessage() + " Use the Trading page for full manual control.";
        res.json({ response: fallbackMsg, aiUnavailable: true });
        return;
      }
      
      const response = await chatWithAI(req.userId!, message, 'web');
      res.json({ response });
    } catch (error) {
      console.error("Error in AI chat:", error);
      res.status(500).json({ error: "Failed to get AI response" });
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

  // Restore monitoring on startup if it was active
  await restoreMonitoring();
  
  // Start the trade processor to handle pending buys
  startTradeProcessor();
  
  // Start the price monitor to check holdings and trigger reclaims
  startPriceMonitor();

  return httpServer;
}

async function restoreMonitoring() {
  try {
    const status = await storage.getMonitoringStatus();
    console.log("Checking monitoring status on startup:", status.isActive ? "ACTIVE" : "INACTIVE", "webhookId:", status.webhookId || "none");
    
    if (status.isActive && status.webhookId) {
      const currentUrl = getWebhookUrl();
      console.log("Monitoring was active, updating webhook URL to:", currentUrl);
      
      // Get all enabled monitored wallets
      const allWallets = await storage.getAllMonitoredWallets();
      const walletAddresses = allWallets.map(w => w.walletAddress);
      console.log("Found", walletAddresses.length, "enabled monitored wallet(s)");
      
      // If no wallets to monitor, deactivate monitoring
      if (walletAddresses.length === 0) {
        console.log("No enabled wallets to monitor, deactivating monitoring");
        await deleteWebhook(status.webhookId);
        await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
        return;
      }
      
      const updated = await updateWebhookUrl(
        status.webhookId, 
        `${currentUrl}?secret=${process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret"}`,
        walletAddresses
      );
      
      if (!updated) {
        console.log("Failed to update webhook, recreating...");
        const newWebhookId = await createWebhook(
          `${currentUrl}?secret=${process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret"}`,
          walletAddresses
        );
        
        if (newWebhookId) {
          await storage.updateMonitoringStatus({ webhookId: newWebhookId });
          console.log("New webhook created:", newWebhookId);
        } else {
          console.error("Failed to recreate webhook on startup");
          await storage.updateMonitoringStatus({ isActive: false, webhookId: undefined });
        }
      } else {
        console.log("Webhook URL updated successfully");
      }
    }
  } catch (error) {
    console.error("Error restoring monitoring:", error);
  }
}
