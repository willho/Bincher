import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { parseSwapFromWebhook, createWebhook, deleteWebhook, getWebhooks, getWalletAddress, fetchTokenMetadata } from "./helius";
import { sendSwapNotification } from "./email";
import type { HeliusWebhookPayload } from "@shared/schema";
import { notificationSettingsSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";

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

      // Get the webhook URL - use explicit REPL_SLUG for Replit or fallback to headers
      const replSlug = process.env.REPL_SLUG;
      const replOwner = process.env.REPL_OWNER;
      
      let webhookUrl: string;
      if (replSlug && replOwner) {
        // Replit deployment URL
        webhookUrl = `https://${replSlug}.${replOwner}.repl.co/api/webhook/helius?secret=${WEBHOOK_SECRET}`;
      } else {
        // Fallback to request headers
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        webhookUrl = `${protocol}://${host}/api/webhook/helius?secret=${WEBHOOK_SECRET}`;
      }

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

  return httpServer;
}
