import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl, getSwapWalletAddress } from "./helius";
import { sendSwapNotification } from "./email";
import type { HeliusWebhookPayload } from "@shared/schema";
import { notificationSettingsSchema, tradeConfigSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
import { createUser, authenticateUser, createSession, getSession, destroySession, getUserCount } from "./auth";
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
  withdrawSol
} from "./wallet";
import { sellToken, buyToken, getTokenPrice, getTokenInfo } from "./jupiter";
import { db } from "./db";
import { holdings } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { startTradeProcessor, updateBuyCount, checkPriceRiseTrigger } from "./trade-processor";
import { startPriceMonitor } from "./price-monitor";

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
            const pendingBuy = await addPendingBuy(
              userId,
              swap.toToken,
              swap.toTokenSymbol,
              toTokenMetadata?.name,
              toTokenMetadata?.priceUsd
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
      
      const result = await sellToken(req.userId!, holding.tokenMint, tokensToSell);
      
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
