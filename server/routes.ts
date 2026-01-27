import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl, getSwapWalletAddress } from "./helius";
import { sendSwapNotification, sendPasswordResetEmail } from "./email";
import type { HeliusWebhookPayload } from "@shared/schema";
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
import { holdings, monitoredWallets } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { startTradeProcessor, updateBuyCount, checkPriceRiseTrigger } from "./trade-processor";
import { startPriceMonitor } from "./price-monitor";
import { scoreToken, refreshScore, chatWithAI, getChatHistory, clearChatHistory, getAIInsights, getSnapshot, getAllSnapshots, getPincherWelcomeMessage, getFilteredEventsForUser, getUserPreferences, updateUserPreferences } from "./ai";

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

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const result = await createUser(username, password);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ success: true });
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

        // Send email notification to user's recipients
        const settings = await storage.getNotificationSettings(userId);
        if (settings.enabled) {
          const minAmount = settings.minSwapAmount ?? 0;
          if (savedSwap.fromAmount >= minAmount) {
            const allEmails = settings.emails?.length ? settings.emails : [settings.email];
            const sent = await sendSwapNotification(savedSwap, allEmails);
            if (sent) {
              await storage.markSwapNotified(savedSwap.id);
              console.log("Notification sent for swap:", savedSwap.id, "to", allEmails.length, "recipients");
            }
          }
        }

        // Copy trading: Queue pending buy if this is a BUY (SOL -> Token)
        const tradeConf = await getTradeConfig(userId);
        if (tradeConf.enabled && swap.fromTokenSymbol === "SOL") {
          const alreadyBought = await hasTokenBeenBought(userId, swap.toToken);
          if (!alreadyBought) {
            // Get the monitored wallet details for source tracking
            const sourceWallet = await storage.getMonitoredWalletByAddress(swapWalletAddress);
            
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
              }
            );
            if (pendingBuy) {
              console.log("Copy trade: Queued pending buy for", swap.toTokenSymbol, "for user:", userId);
            }
          } else {
            console.log("Copy trade: Token already bought/pending, skipping", swap.toTokenSymbol);
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

  app.post("/api/monitored-wallets", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { walletAddress, label } = req.body;
      if (!walletAddress || typeof walletAddress !== 'string') {
        return res.status(400).json({ error: "Wallet address is required" });
      }
      
      if (walletAddress.length < 32 || walletAddress.length > 44) {
        return res.status(400).json({ error: "Invalid Solana wallet address" });
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

  // Manual buy endpoint - buy any token by mint address
  const manualBuySchema = z.object({
    tokenMint: z.string().min(32).max(44),
    solAmount: z.number().positive().finite().max(100),
  });
  
  app.post("/api/copy-trade/manual-buy", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const parsed = manualBuySchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid token mint and SOL amount are required" });
      }
      
      const { tokenMint, solAmount } = parsed.data;
      
      // Check if we already have a holding for this token
      const existingHolding = await db.select().from(holdings).where(
        and(eq(holdings.tokenMint, tokenMint), eq(holdings.userId, req.userId!))
      ).limit(1);
      if (existingHolding.length > 0) {
        return res.status(400).json({ error: "Already holding this token" });
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
      
      console.log(`Manual buy: ${solAmount} SOL for token ${tokenMint} at price ${tokenPrice}`);
      
      const result = await buyToken(req.userId!, tokenMint, solAmount);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Create holding record
      await db.insert(holdings).values({
        userId: req.userId!,
        tokenMint: tokenMint,
        tokenSymbol: tokenInfo?.symbol || "UNKNOWN",
        tokenName: tokenInfo?.name || "Unknown Token",
        amountBought: result.outputAmount || 0,
        solSpent: result.inputAmount || solAmount,
        buyPrice: tokenPrice || 0,
        buyTimestamp: now,
        buySignature: result.signature || "",
        currentAmount: result.outputAmount || 0,
        reclaimed: false,
        lastPriceCheck: now,
        lastPrice: tokenPrice,
        highestMultiplier: 1,
        alertedMilestones: [],
      });
      
      res.json({ 
        success: true, 
        signature: result.signature,
        tokenSymbol: tokenInfo?.symbol || "UNKNOWN",
        tokensBought: result.outputAmount,
        solSpent: result.inputAmount
      });
    } catch (error) {
      console.error("Error in manual buy:", error);
      res.status(500).json({ error: "Failed to execute manual buy" });
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

  // Chat with AI
  app.post("/api/ai/chat", requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: "Message is required" });
      }
      const response = await chatWithAI(req.userId!, message);
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
