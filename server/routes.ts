import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cookieParser from "cookie-parser";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, getWalletAddress, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl } from "./helius";
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
import { eq } from "drizzle-orm";
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
  }

  // Auth middleware - extracts user from session cookie
  const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = req.cookies?.session;
    if (token) {
      const session = getSession(token);
      if (session) {
        req.userId = session.userId;
        req.username = session.username;
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
      res.json({ authenticated: true, username: req.username, userId: req.userId });
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

      const token = createSession(result.userId, username, rememberMe === true);
      
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
      
      if (status.isActive && status.webhookId) {
        return res.json({ success: true, status });
      }

      const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;
      console.log("Creating webhook with URL:", webhookUrl);
      const webhookId = await createWebhook(webhookUrl);

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

        // Check if we already processed this transaction
        const existing = await storage.getSwapBySignature(payload.signature);
        if (existing) {
          console.log("Swap already processed:", payload.signature);
          continue;
        }

        const swap = parseSwapFromWebhook(payload);
        if (!swap) {
          console.log("Not a swap transaction:", payload.type);
          continue;
        }

        // Fetch token metadata for the token being bought
        const toTokenMetadata = await fetchTokenMetadata(swap.toToken);
        if (toTokenMetadata) {
          swap.toTokenMetadata = toTokenMetadata;
          console.log("Token metadata fetched:", toTokenMetadata.symbol, "MC:", toTokenMetadata.marketCap);
        }

        const savedSwap = await storage.addSwap(swap);
        console.log("Swap detected and saved:", savedSwap.id);

        // Broadcast to WebSocket clients
        broadcastSwap(savedSwap);

        // Send email notification to all recipients
        const settings = await storage.getNotificationSettings();
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
        const tradeConf = await getTradeConfig();
        if (tradeConf.enabled && swap.fromTokenSymbol === "SOL") {
          const alreadyBought = await hasTokenBeenBought(swap.toToken);
          if (!alreadyBought) {
            const pendingBuy = await addPendingBuy(
              swap.toToken,
              swap.toTokenSymbol,
              toTokenMetadata?.name,
              toTokenMetadata?.priceUsd
            );
            if (pendingBuy) {
              console.log("Copy trade: Queued pending buy for", swap.toTokenSymbol);
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
  app.get("/api/swaps", async (req, res) => {
    try {
      const swaps = await storage.getSwaps();
      res.json(swaps);
    } catch (error) {
      res.status(500).json({ error: "Failed to get swaps" });
    }
  });

  // Get notification settings
  app.get("/api/settings", async (req, res) => {
    try {
      const settings = await storage.getNotificationSettings();
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to get settings" });
    }
  });

  // Update notification settings with validation
  app.patch("/api/settings", async (req, res) => {
    try {
      const parseResult = updateSettingsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid settings data", 
          details: parseResult.error.flatten() 
        });
      }

      const settings = await storage.updateNotificationSettings(parseResult.data);
      res.json(settings);
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Get wallet address
  app.get("/api/wallet", (req, res) => {
    res.json({ address: getWalletAddress() });
  });

  // Debug: list webhooks
  app.get("/api/webhooks", async (req, res) => {
    const webhooks = await getWebhooks();
    res.json(webhooks);
  });

  // ==================== Copy Trading Routes ====================

  // Get or create hot wallet
  app.get("/api/copy-trade/wallet", async (req, res) => {
    try {
      const wallet = await getOrCreateHotWallet();
      if (!wallet) {
        return res.json({ exists: false });
      }
      const balance = await getHotWalletBalance();
      res.json({ exists: true, publicKey: wallet.publicKey, balance, createdAt: wallet.createdAt });
    } catch (error) {
      console.error("Error getting hot wallet:", error);
      res.status(500).json({ error: "Failed to get wallet" });
    }
  });

  // Create hot wallet
  app.post("/api/copy-trade/wallet", async (req, res) => {
    try {
      const wallet = await createHotWallet();
      const balance = await getHotWalletBalance();
      res.json({ success: true, publicKey: wallet.publicKey, balance, createdAt: wallet.createdAt });
    } catch (error) {
      console.error("Error creating hot wallet:", error);
      res.status(500).json({ error: "Failed to create wallet" });
    }
  });

  // Get hot wallet balance
  app.get("/api/copy-trade/balance", async (req, res) => {
    try {
      const balance = await getHotWalletBalance();
      res.json({ balance });
    } catch (error) {
      console.error("Error getting balance:", error);
      res.status(500).json({ error: "Failed to get balance" });
    }
  });

  // Get trade config
  app.get("/api/copy-trade/config", async (req, res) => {
    try {
      const config = await getTradeConfig();
      res.json(config);
    } catch (error) {
      console.error("Error getting trade config:", error);
      res.status(500).json({ error: "Failed to get config" });
    }
  });

  // Update trade config
  app.patch("/api/copy-trade/config", async (req, res) => {
    try {
      const config = await updateTradeConfig(req.body);
      res.json(config);
    } catch (error) {
      console.error("Error updating trade config:", error);
      res.status(500).json({ error: "Failed to update config" });
    }
  });

  // Get holdings
  app.get("/api/copy-trade/holdings", async (req, res) => {
    try {
      const holdingsList = await getHoldings();
      res.json(holdingsList);
    } catch (error) {
      console.error("Error getting holdings:", error);
      res.status(500).json({ error: "Failed to get holdings" });
    }
  });

  // Get pending buys
  app.get("/api/copy-trade/pending", async (req, res) => {
    try {
      const pending = await getPendingBuys();
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
  
  app.post("/api/copy-trade/withdraw", async (req, res) => {
    try {
      const parsed = withdrawSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid destination address and amount are required" });
      }
      
      const { destination, amount } = parsed.data;
      
      const result = await withdrawSol(destination, amount);
      
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
  
  app.post("/api/copy-trade/sell/:holdingId", async (req, res) => {
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
      
      const holdingRows = await db.select().from(holdings).where(eq(holdings.id, holdingId));
      
      if (holdingRows.length === 0) {
        return res.status(404).json({ error: "Holding not found" });
      }
      
      const holding = holdingRows[0];
      const tokensToSell = holding.currentAmount * (sellPercentage / 100);
      
      if (tokensToSell <= 0) {
        return res.status(400).json({ error: "No tokens to sell" });
      }
      
      console.log(`Manual sell: ${tokensToSell.toLocaleString()} tokens of ${holding.tokenSymbol} (${sellPercentage}%)`);
      
      const result = await sellToken(holding.tokenMint, tokensToSell);
      
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
  
  app.post("/api/copy-trade/manual-buy", async (req, res) => {
    try {
      const parsed = manualBuySchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Valid token mint and SOL amount are required" });
      }
      
      const { tokenMint, solAmount } = parsed.data;
      
      // Check if we already have a holding for this token
      const existingHolding = await db.select().from(holdings).where(eq(holdings.tokenMint, tokenMint)).limit(1);
      if (existingHolding.length > 0) {
        return res.status(400).json({ error: "Already holding this token" });
      }
      
      // Check hot wallet balance
      const balance = await getHotWalletBalance();
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
      
      const result = await buyToken(tokenMint, solAmount);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Create holding record
      await db.insert(holdings).values({
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
      
      const updated = await updateWebhookUrl(status.webhookId, `${currentUrl}?secret=${process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret"}`);
      
      if (!updated) {
        console.log("Failed to update webhook, recreating...");
        const newWebhookId = await createWebhook(`${currentUrl}?secret=${process.env.WEBHOOK_SECRET || "helius-swap-monitor-secret"}`);
        
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
