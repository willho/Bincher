import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, getWalletAddress, fetchTokenMetadata, getWebhookUrl, updateWebhookUrl } from "./helius";
import { sendSwapNotification } from "./email";
import type { HeliusWebhookPayload } from "@shared/schema";
import { notificationSettingsSchema, tradeConfigSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
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
import { sellToken } from "./jupiter";
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
