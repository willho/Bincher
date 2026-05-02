import express, { Request, Response } from "express";
import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import { hashApiKey, validateKeyFormat, testShyftKey, testChainstackUrl } from "./key-validator";

dotenv.config();

/**
 * Standalone Proxy Server
 *
 * Runs independently as Proxy-1 or Proxy-2
 * - Exposes health check endpoint
 * - Registers with Pincher2 on startup (with auth + key hashes)
 * - Routes API calls through configured credentials
 * - Manages 2/3 mesh subscriptions
 * - Validates API keys on startup
 *
 * Deploy as:
 * - Docker container on separate machine
 * - Or separate Node.js process with .env config
 */

interface ProxyConfig {
  proxyName: string;
  proxyPort: number;
  outboundIp: string;
  pincher2Url?: string;
  proxyAuthPassword: string;
  shyftApiKey: string;
  shyftKeyHash: string;
  chainstackRpcUrl: string;
  chainstackUrlHash: string;
  heliusApiKey?: string;
}

interface HealthStatus {
  proxyName: string;
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  uptime: number;
  requestsHandled: number;
  lastShyftCheck: number | null;
  lastChainstackCheck: number | null;
}

interface SubscriptionRequest {
  tokenMint: string;
  walletAddresses: string[];
  priority: "high" | "normal" | "low";
}

// =====================
// CONFIGURATION
// =====================

const validateProxyConfig = (): ProxyConfig => {
  const proxyName = process.env.PROXY_NAME || "proxy-1";
  const proxyAuthPassword = process.env.PROXY_AUTH_PASSWORD;
  const shyftApiKey = process.env.SHYFT_API_KEY || "";
  const chainstackRpcUrl = process.env.CHAINSTACK_RPC_URL || "";

  if (!proxyAuthPassword) {
    throw new Error(
      "❌ PROXY_AUTH_PASSWORD not set. This is required for authentication with Pincher2."
    );
  }

  if (!shyftApiKey) {
    throw new Error("❌ SHYFT_API_KEY not set. This is required for token metadata.");
  }

  if (!chainstackRpcUrl) {
    throw new Error(
      "❌ CHAINSTACK_RPC_URL not set. This is required for RPC calls."
    );
  }

  return {
    proxyName,
    proxyPort: parseInt(process.env.PROXY_PORT || "3001"),
    outboundIp: process.env.OUTBOUND_IP || "127.0.0.1",
    pincher2Url: process.env.PINCHER2_URL,
    proxyAuthPassword,
    shyftApiKey,
    shyftKeyHash: hashApiKey(shyftApiKey),
    chainstackRpcUrl,
    chainstackUrlHash: hashApiKey(chainstackRpcUrl),
  };
};

let config: ProxyConfig;
try {
  config = validateProxyConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// =====================
// STATE
// =====================

const app = express();
let startTime = Date.now();
let requestCount = 0;
let lastShyftCheck: number | null = null;
let lastChainstackCheck: number | null = null;
const subscriptions = new Map<string, SubscriptionRequest>();

// =====================
// MIDDLEWARE
// =====================

app.use(express.json());

// =====================
// HEALTH CHECK
// =====================

app.get("/health", (req: Request, res: Response) => {
  const uptime = Date.now() - startTime;
  const status: HealthStatus = {
    proxyName: config.proxyName,
    status: "healthy",
    timestamp: Math.floor(Date.now() / 1000),
    uptime,
    requestsHandled: requestCount,
    lastShyftCheck,
    lastChainstackCheck,
  };

  res.json(status);
});

// =====================
// REGISTRATION
// =====================

/**
 * Validate API keys before starting
 */
async function validateApiKeys(): Promise<boolean> {
  console.log("[Proxy] Validating API keys...");

  // Test Shyft key
  const shyftTest = await testShyftKey(config.shyftApiKey);
  if (!shyftTest.works) {
    console.error(
      `[Proxy] ❌ Shyft key validation failed: ${shyftTest.error}`
    );
    return false;
  }
  console.log(`[Proxy] ✓ Shyft key valid (${shyftTest.latency}ms)`);

  // Test Chainstack URL
  const chainstackTest = await testChainstackUrl(config.chainstackRpcUrl);
  if (!chainstackTest.works) {
    console.error(
      `[Proxy] ❌ Chainstack endpoint validation failed: ${chainstackTest.error}`
    );
    return false;
  }
  console.log(`[Proxy] ✓ Chainstack endpoint valid (${chainstackTest.latency}ms)`);

  return true;
}

/**
 * Register this proxy with Pincher2 (called on Pincher2 startup)
 */
async function registerWithPincher2(): Promise<void> {
  if (!config.pincher2Url) {
    console.log(
      `[Proxy] No Pincher2 URL configured - running in idle mode, waiting for connection`
    );
    return;
  }

  try {
    const response = await axios.post(
      `${config.pincher2Url}/api/proxy/register`,
      {
        proxyName: config.proxyName,
        outboundIP: config.outboundIp,
        port: config.proxyPort,
        healthUrl: `http://${config.outboundIp}:${config.proxyPort}/health`,
        shyftKeyHash: config.shyftKeyHash,
        chainstackUrlHash: config.chainstackUrlHash,
      },
      {
        timeout: 5000,
        headers: {
          Authorization: `Bearer ${config.proxyAuthPassword}`,
        },
      }
    );

    console.log(
      `[Proxy] ✓ Registered with Pincher2: ${JSON.stringify(response.data)}`
    );
  } catch (error) {
    console.warn(
      `[Proxy] ⚠️  Failed to register with Pincher2 - will retry on reconnect`,
      error instanceof AxiosError ? error.message : error
    );
  }
}

// =====================
// SUBSCRIPTION MANAGEMENT
// =====================

/**
 * Subscribe to token for monitoring/trading
 * Pincher2 uses this to coordinate 2/3 mesh coverage
 */
app.post("/api/subscribe", (req: Request, res: Response) => {
  const { tokenMint, walletAddresses, priority } = req.body;

  if (!tokenMint) {
    return res.status(400).json({ error: "Missing tokenMint" });
  }

  subscriptions.set(tokenMint, {
    tokenMint,
    walletAddresses: walletAddresses || [],
    priority: priority || "normal",
  });

  console.log(
    `[Proxy] Subscribed to ${tokenMint} (${walletAddresses?.length || 0} wallets, priority=${priority})`
  );

  res.json({
    success: true,
    subscriptionCount: subscriptions.size,
  });
});

/**
 * Unsubscribe from token
 */
app.post("/api/unsubscribe", (req: Request, res: Response) => {
  const { tokenMint } = req.body;

  if (!tokenMint) {
    return res.status(400).json({ error: "Missing tokenMint" });
  }

  subscriptions.delete(tokenMint);
  console.log(`[Proxy] Unsubscribed from ${tokenMint}`);

  res.json({
    success: true,
    subscriptionCount: subscriptions.size,
  });
});

/**
 * Get current subscriptions (for mesh coordination)
 */
app.get("/api/subscriptions", (req: Request, res: Response) => {
  const subs = Array.from(subscriptions.values());
  res.json({
    proxyName: config.proxyName,
    subscriptionCount: subs.length,
    subscriptions: subs,
  });
});

// =====================
// API ROUTING
// =====================

/**
 * Route Shyft API calls through this proxy's credentials
 */
app.post("/api/shyft/*", async (req: Request, res: Response) => {
  if (!config.shyftApiKey) {
    return res.status(503).json({ error: "Shyft not configured on this proxy" });
  }

  const path = req.params[0];
  const url = `https://api.shyft.to/${path}`;

  try {
    const response = await axios({
      method: req.method as any,
      url,
      data: req.body,
      headers: {
        "x-api-key": config.shyftApiKey,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    lastShyftCheck = Math.floor(Date.now() / 1000);
    requestCount++;

    res.json(response.data);
  } catch (error) {
    console.error(
      `[Proxy] Shyft error:`,
      error instanceof AxiosError ? error.message : error
    );
    res.status(500).json({
      error: "Shyft API call failed",
      details: error instanceof AxiosError ? error.message : String(error),
    });
  }
});

/**
 * Route Chainstack RPC calls through this proxy's endpoint
 */
app.post("/api/rpc", async (req: Request, res: Response) => {
  if (!config.chainstackRpcUrl) {
    return res
      .status(503)
      .json({ error: "Chainstack RPC not configured on this proxy" });
  }

  try {
    const response = await axios({
      method: "POST",
      url: config.chainstackRpcUrl,
      data: req.body,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    lastChainstackCheck = Math.floor(Date.now() / 1000);
    requestCount++;

    res.json(response.data);
  } catch (error) {
    console.error(
      `[Proxy] RPC error:`,
      error instanceof AxiosError ? error.message : error
    );
    res.status(500).json({
      error: "RPC call failed",
      details: error instanceof AxiosError ? error.message : String(error),
    });
  }
});

/**
 * Route Helius API calls through this proxy's credentials
 */
app.post("/api/helius/*", async (req: Request, res: Response) => {
  if (!config.heliusApiKey) {
    return res.status(503).json({ error: "Helius not configured on this proxy" });
  }

  const path = req.params[0];
  const url = `https://api.helius.xyz/${path}?api-key=${config.heliusApiKey}`;

  try {
    const response = await axios({
      method: req.method as any,
      url,
      data: req.body,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    requestCount++;
    res.json(response.data);
  } catch (error) {
    console.error(
      `[Proxy] Helius error:`,
      error instanceof AxiosError ? error.message : error
    );
    res.status(500).json({
      error: "Helius API call failed",
      details: error instanceof AxiosError ? error.message : String(error),
    });
  }
});

// =====================
// INFO ENDPOINT
// =====================

app.get("/", (req: Request, res: Response) => {
  res.json({
    service: "Pincher Proxy Server",
    proxyName: config.proxyName,
    outboundIp: config.outboundIp,
    version: "1.0.0",
    uptime: Date.now() - startTime,
    requestsHandled: requestCount,
    subscriptions: subscriptions.size,
    endpoints: {
      "GET /health": "Health check (used by Pincher2 verification)",
      "POST /api/subscribe": "Subscribe to token",
      "POST /api/unsubscribe": "Unsubscribe from token",
      "GET /api/subscriptions": "List current subscriptions",
      "POST /api/shyft/*": "Route Shyft API calls",
      "POST /api/rpc": "Route Chainstack RPC calls",
      "POST /api/helius/*": "Route Helius API calls",
    },
  });
});

// =====================
// STARTUP
// =====================

async function start() {
  console.log(`\n[Proxy] Starting ${config.proxyName}...`);
  console.log(`[Proxy] Port: ${config.proxyPort}`);
  console.log(`[Proxy] Outbound IP: ${config.outboundIp}`);

  // Validate API keys before starting
  const keysValid = await validateApiKeys();
  if (!keysValid) {
    console.error("[Proxy] ❌ API key validation failed. Exiting.");
    process.exit(1);
  }

  console.log(`[Proxy] ✓ All API keys validated`);
  console.log(`[Proxy] Shyft key hash: ${config.shyftKeyHash.substring(0, 8)}...`);
  console.log(
    `[Proxy] Chainstack URL hash: ${config.chainstackUrlHash.substring(0, 8)}...`
  );

  app.listen(config.proxyPort, () => {
    console.log(`[Proxy] ✓ ${config.proxyName} listening on port ${config.proxyPort}`);
    console.log(
      `[Proxy] Health check: http://${config.outboundIp}:${config.proxyPort}/health`
    );
  });

  // Try to register with Pincher2 if URL provided
  setTimeout(registerWithPincher2, 2000);

  // Retry registration every 30 seconds if Pincher2 not found
  setInterval(registerWithPincher2, 30000);
}

start().catch((error) => {
  console.error("[Proxy] Startup failed:", error);
  process.exit(1);
});
