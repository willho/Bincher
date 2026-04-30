/**
 * Dual-Provider WebSocket Client
 *
 * Real-time token discovery and trade monitoring using both PumpPortal and PumpDev in parallel.
 *
 * Architecture:
 * - PumpPortal: New token discovery (subscribeNewToken) + Whale monitoring (subscribeAccountTrade)
 * - PumpDev: New token trades (subscribeTokenTrade on discovered tokens) + Whale monitoring
 * - Independent connections maximize throughput and allow load splitting
 * - Automatic failover within each provider if needed
 *
 * Rate limits (per provider):
 * - Max 15 concurrent connections total (we use 2)
 * - Max 200 subscriptions/sec per connection
 * - Max 5000 addresses per message
 * - ~150 subscriptions/sec safe limit per connection
 */

import { EventEmitter } from "events";
import { WebSocket as WSType } from "ws";
import { startLoadBalancing, getLoadBalancer } from "./websocket-capacity-tracker";

interface ProviderStats {
  name: string;
  url: string;
  isConnected: boolean;
  connectedAt?: number;
  reconnectAttempts: number;
  subscriptions: {
    newTokens: boolean;
    tokenTradesCount: number;
    whaleCount: number;
  };
  messages: {
    total: number;
    newTokens: number;
    trades: number;
    whaleActivity: number;
  };
  uptime?: number;
  lastError?: string;
  avgLatencyMs?: number;
  messagesPerSecond?: number;
}

interface DualProviderStats {
  pumpportal: ProviderStats;
  pumpdev: ProviderStats;
  combined: {
    totalConnections: 2;
    totalSubscriptions: number;
    totalMessages: number;
    trades: number;
    whaleActivity: number;
    messagesPerSecond: number;
  };
}

const PROVIDERS = {
  pumpportal: {
    name: "PumpPortal",
    url: "wss://pumpportal.fun/api/data",
    emoji: "🎯",
    role: "discovery_and_whales", // subscribeNewToken + subscribeAccountTrade
  },
  pumpdev: {
    name: "PumpDev",
    url: "wss://pumpdev.io/ws",
    emoji: "🔧",
    role: "trades_and_whales", // subscribeTokenTrade + subscribeAccountTrade
  },
};

const RATE_LIMITS = {
  maxSubscriptionsPerMessage: 5000,
  safeSubscriptionsPerSecond: 150,
  subscriptionBatchSize: 100,
  batchIntervalMs: Math.ceil((1000 / 150) * 100), // ~667ms for 100 tokens
  maxTokensPerConnection: 200, // More aggressive for testing
};

class ProviderConnection extends EventEmitter {
  private provider: any;
  private ws: WSType | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseBackoffMs = 1000;
  private stats: ProviderStats;
  private messageTimestamps: number[] = []; // For measuring msg/sec
  private startTime = 0;

  constructor(provider: any) {
    super();
    this.provider = provider;
    this.stats = {
      name: provider.name,
      url: provider.url,
      isConnected: false,
      reconnectAttempts: 0,
      subscriptions: { newTokens: false, tokenTradesCount: 0, whaleCount: 0 },
      messages: { total: 0, newTokens: 0, trades: 0, whaleActivity: 0 },
    };
  }

  async connect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      const { WebSocket: WS } = await import("ws");
      const ws = new WS(this.provider.url);
      this.ws = ws;

      ws.on("open", () => this.onOpen());
      ws.on("message", (data: Buffer) => this.onMessage(data));
      ws.on("error", (error: Error) => this.onError(error));
      ws.on("close", () => this.onClose());
    } catch (error: any) {
      console.error(`[${this.provider.name}] Connection error:`, error.message);
      this.scheduleReconnect();
    }
  }

  private onOpen(): void {
    const attempt = this.reconnectAttempts > 0 ? ` (attempt ${this.reconnectAttempts})` : "";
    console.log(`${this.provider.emoji} ${this.provider.name} connected${attempt}`);

    this.stats.isConnected = true;
    this.stats.connectedAt = Date.now();
    this.startTime = Date.now();
    this.reconnectAttempts = 0;

    this.emit("connected");
  }

  private onMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      this.stats.messages.total++;

      // Track message rate
      const now = Date.now();
      this.messageTimestamps.push(now);
      if (this.messageTimestamps.length > 60) {
        this.messageTimestamps.shift(); // Keep last 60 seconds
      }

      // Record metric with load balancer
      try {
        const lb = getLoadBalancer();
        if (this.provider.name === "PumpPortal") {
          lb.ppMetrics.recordMessage(now);
        } else if (this.provider.name === "PumpDev") {
          lb.pdMetrics.recordMessage(now);
        }
      } catch (error) {
        // Load balancer not ready yet
      }

      // Calculate messages per second
      if (this.messageTimestamps.length > 1) {
        const timespanMs = this.messageTimestamps[this.messageTimestamps.length - 1] - this.messageTimestamps[0];
        if (timespanMs > 0) {
          this.stats.messagesPerSecond = (this.messageTimestamps.length / timespanMs) * 1000;
        }
      }

      // Route message to appropriate handler
      if (message.mint && (message.txType === "buy" || message.txType === "sell" || message.type === "buy" || message.type === "sell")) {
        this.stats.messages.trades++;
        this.emit("trade", message);
      } else if (message.mint && message.name && !message.txType && !message.type) {
        this.stats.messages.newTokens++;
        this.emit("new_token", message);
      } else if (message.type === "create" || message.type === "createpool") {
        this.stats.messages.newTokens++;
        this.emit("new_token", message);
      } else if (message.type === "connected") {
        // Keep-alive or subscription confirmation
      }
    } catch (error) {
      // Silently skip parse errors
    }
  }

  private onError(error: Error): void {
    console.error(`[${this.provider.name}] Error:`, error.message);
    this.stats.lastError = error.message;
  }

  private onClose(): void {
    if (!this.stats.isConnected) return;
    console.log(`[${this.provider.name}] Disconnected`);
    this.stats.isConnected = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[${this.provider.name}] Max reconnect attempts reached`);
      this.stats.lastError = "Max reconnection attempts reached";
      return;
    }

    this.reconnectAttempts++;
    const delayMs = Math.min(
      this.baseBackoffMs * Math.pow(2, this.reconnectAttempts - 1),
      60000
    );

    console.log(`[${this.provider.name}] Reconnecting in ${(delayMs / 1000).toFixed(1)}s...`);
    setTimeout(() => this.connect(), delayMs);
  }

  send(message: any): boolean {
    if (!this.ws || this.ws.readyState !== 1) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error: any) {
      console.error(`[${this.provider.name}] Send failed:`, error.message);
      return false;
    }
  }

  subscribeNewTokens(): boolean {
    const success = this.send({ method: "subscribeNewToken" });
    if (success) {
      this.stats.subscriptions.newTokens = true;
    }
    return success;
  }

  subscribeTrades(mints: string[]): boolean {
    if (mints.length === 0) return true;

    const success = this.send({
      method: "subscribeTokenTrade",
      keys: mints,
    });

    if (success) {
      this.stats.subscriptions.tokenTradesCount = mints.length;
    }

    return success;
  }

  subscribeWhales(wallets: string[]): boolean {
    if (wallets.length === 0) return true;

    const success = this.send({
      method: "subscribeAccountTrade",
      keys: wallets,
    });

    if (success) {
      this.stats.subscriptions.whaleCount = wallets.length;
    }

    return success;
  }

  getStats(): ProviderStats {
    return {
      ...this.stats,
      uptime: this.startTime ? Date.now() - this.startTime : undefined,
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

class DualProviderWebSocket extends EventEmitter {
  private pumpportal: ProviderConnection;
  private pumpdev: ProviderConnection;
  private tokensByProvider = new Map<string, Set<string>>(); // provider -> token set
  private whalesByProvider = new Map<string, Set<string>>(); // provider -> wallet set
  private allTokens = new Map<string, number>(); // token -> subscription time
  private pendingTokens = new Map<string, "pumpdev" | "both">(); // tokens waiting to be subscribed
  private batchIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor() {
    super();
    this.pumpportal = new ProviderConnection(PROVIDERS.pumpportal);
    this.pumpdev = new ProviderConnection(PROVIDERS.pumpdev);

    // Initialize provider tracking
    this.tokensByProvider.set("pumpportal", new Set());
    this.tokensByProvider.set("pumpdev", new Set());
    this.whalesByProvider.set("pumpportal", new Set());
    this.whalesByProvider.set("pumpdev", new Set());

    this.setupProviderHandlers();
  }

  private setupProviderHandlers(): void {
    // PumpPortal: New tokens and whale monitoring
    this.pumpportal.on("new_token", (msg: any) => {
      this.emit("new_token", { ...msg, provider: "pumpportal" });
      // Queue new token for trade subscription on PumpDev
      this.queueTokenForTradeSubscription(msg.mint);
    });

    this.pumpportal.on("trade", (msg: any) => {
      this.emit("trade", { ...msg, provider: "pumpportal" });
    });

    // PumpDev: Trades and whale monitoring
    this.pumpdev.on("new_token", (msg: any) => {
      // Might receive new tokens from PumpDev too
      this.emit("new_token", { ...msg, provider: "pumpdev" });
      this.queueTokenForTradeSubscription(msg.mint);
    });

    this.pumpdev.on("trade", (msg: any) => {
      this.emit("trade", { ...msg, provider: "pumpdev" });
    });

    // Forward whale activity
    this.pumpportal.on("whale_activity", (msg: any) => {
      this.emit("whale_activity", { ...msg, provider: "pumpportal" });
    });

    this.pumpdev.on("whale_activity", (msg: any) => {
      this.emit("whale_activity", { ...msg, provider: "pumpdev" });
    });
  }

  async start(): Promise<void> {
    console.log("[WebSocket] Starting dual-provider mode");
    console.log("  📡 PumpPortal: New token discovery + Whale monitoring");
    console.log("  📡 PumpDev: Trade monitoring + Whale monitoring");

    // Connect both providers in parallel
    await Promise.all([
      this.pumpportal.connect(),
      this.pumpdev.connect(),
    ]);

    // Wait a moment for connections to establish
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start subscriptions
    const ppReady = this.pumpportal.subscribeNewTokens();
    const pdReady = true; // PumpDev doesn't auto-stream

    console.log(`[WebSocket] PumpPortal ready: ${ppReady ? "✓" : "✗"}`);
    console.log(`[WebSocket] PumpDev ready: ${pdReady ? "✓" : "✗"}`);

    // Start load balancer for dynamic capacity management
    startLoadBalancing();
    const lb = getLoadBalancer();

    // Wire up rebalancing callbacks
    lb.onRebalance = (data) => {
      console.log(`[LoadBalancer] Moving ${data.items.length} subs from ${data.fromProvider} to ${data.toProvider}`);
      this.emit("rebalance", data);
    };

    lb.onRotation = (data) => {
      console.log(`[LoadBalancer] Rotated out ${data.removed.length} subscriptions`);
      this.emit("rotation", data);
    };

    // Start batch processors for each provider
    this.startTokenBatching("pumpdev");
    this.startWhaleBatching("pumpportal");
    this.startWhaleBatching("pumpdev");

    // Monitor token lifecycle
    this.startTokenLifecycleMonitoring();

    console.log("[WebSocket] Dual-provider streaming started with load balancing");
  }

  async stop(): Promise<void> {
    // Clear intervals
    for (const interval of this.batchIntervals.values()) {
      clearInterval(interval);
    }
    this.batchIntervals.clear();

    this.pumpportal.disconnect();
    this.pumpdev.disconnect();

    console.log("[WebSocket] Stopped");
  }

  private queueTokenForTradeSubscription(mint: string): void {
    if (this.allTokens.has(mint)) {
      return; // Already subscribed
    }

    // Check if we have room on PumpDev for trades
    const pumpdevTokens = this.tokensByProvider.get("pumpdev") || new Set();
    if (pumpdevTokens.size >= RATE_LIMITS.maxTokensPerConnection) {
      // At capacity, remove oldest
      const oldest = Array.from(this.allTokens.entries())
        .filter(([m]) => pumpdevTokens.has(m))
        .sort((a, b) => a[1] - b[1])[0];

      if (oldest) {
        this.removeTokenSubscription("pumpdev", oldest[0]);
      }
    }

    this.allTokens.set(mint, Date.now());
    this.pendingTokens.set(mint, "pumpdev");
  }

  private removeTokenSubscription(provider: string, mint: string): void {
    const tokens = this.tokensByProvider.get(provider);
    if (tokens) {
      tokens.delete(mint);
    }
    this.allTokens.delete(mint);
  }

  private startTokenBatching(provider: "pumpdev" | "both"): void {
    const interval = setInterval(() => {
      if (provider === "pumpdev") {
        this.processPumpDevTokenBatch();
      }
    }, RATE_LIMITS.batchIntervalMs);

    this.batchIntervals.set(`tokens_${provider}`, interval);
  }

  private processPumpDevTokenBatch(): void {
    if (!this.pumpdev.getStats().isConnected) return;

    const pending = Array.from(this.pendingTokens.entries())
      .filter(([_, p]) => p === "pumpdev")
      .slice(0, RATE_LIMITS.subscriptionBatchSize);

    if (pending.length === 0) return;

    const mints = pending.map(([m]) => m);
    const success = this.pumpdev.subscribeTrades(mints);

    if (success) {
      const pumpdevTokens = this.tokensByProvider.get("pumpdev") || new Set();
      mints.forEach(m => {
        pumpdevTokens.add(m);
        this.pendingTokens.delete(m);
      });
      this.tokensByProvider.set("pumpdev", pumpdevTokens);

      console.log(
        `[WebSocket] PumpDev: Subscribed to ${mints.length} trades (total: ${pumpdevTokens.size}/${RATE_LIMITS.maxTokensPerConnection})`
      );
    } else {
      console.warn(`[WebSocket] PumpDev: Token subscription batch failed`);
    }
  }

  private startWhaleBatching(provider: "pumpportal" | "pumpdev"): void {
    // For now, whales are static. In production, load from DB periodically
    const interval = setInterval(() => {
      // Placeholder for dynamic whale loading
    }, 30000);

    this.batchIntervals.set(`whales_${provider}`, interval);
  }

  private startTokenLifecycleMonitoring(): void {
    const interval = setInterval(async () => {
      // Check for dead tokens and remove them
      const now = Date.now();
      const deadAge = 24 * 60 * 60 * 1000;

      const toRemove = Array.from(this.allTokens.entries())
        .filter(([_, time]) => now - time > deadAge)
        .map(([mint]) => mint);

      for (const mint of toRemove) {
        this.removeTokenSubscription("pumpdev", mint);
      }

      if (toRemove.length > 0) {
        console.log(`[WebSocket] Removed ${toRemove.length} old tokens`);
      }
    }, 60000); // Check every minute

    this.batchIntervals.set("lifecycle", interval);
  }

  addWhaleWallet(wallet: string, provider: "pumpportal" | "pumpdev" | "both" = "both"): void {
    if (provider === "pumpportal" || provider === "both") {
      const whales = this.whalesByProvider.get("pumpportal") || new Set();
      whales.add(wallet);
      this.whalesByProvider.set("pumpportal", whales);
      if (this.pumpportal.getStats().isConnected) {
        this.pumpportal.subscribeWhales(Array.from(whales));
      }
    }

    if (provider === "pumpdev" || provider === "both") {
      const whales = this.whalesByProvider.get("pumpdev") || new Set();
      whales.add(wallet);
      this.whalesByProvider.set("pumpdev", whales);
      if (this.pumpdev.getStats().isConnected) {
        this.pumpdev.subscribeWhales(Array.from(whales));
      }
    }
  }

  removeWhaleWallet(wallet: string, provider: "pumpportal" | "pumpdev" | "both" = "both"): void {
    if (provider === "pumpportal" || provider === "both") {
      const whales = this.whalesByProvider.get("pumpportal");
      if (whales) {
        whales.delete(wallet);
      }
    }

    if (provider === "pumpdev" || provider === "both") {
      const whales = this.whalesByProvider.get("pumpdev");
      if (whales) {
        whales.delete(wallet);
      }
    }
  }

  getStats(): DualProviderStats {
    const ppStats = this.pumpportal.getStats();
    const pdStats = this.pumpdev.getStats();
    const totalMessages = ppStats.messages.total + pdStats.messages.total;
    const totalTrades = ppStats.messages.trades + pdStats.messages.trades;
    const totalWhaleActivity = ppStats.messages.whaleActivity + pdStats.messages.whaleActivity;
    const ppUptime = ppStats.uptime || 0;
    const pdUptime = pdStats.uptime || 0;
    const totalUptime = Math.max(ppUptime, pdUptime);

    return {
      pumpportal: ppStats,
      pumpdev: pdStats,
      combined: {
        totalConnections: 2,
        totalSubscriptions: (this.tokensByProvider.get("pumpdev")?.size || 0) +
          (this.whalesByProvider.get("pumpportal")?.size || 0) +
          (this.whalesByProvider.get("pumpdev")?.size || 0),
        totalMessages,
        trades: totalTrades,
        whaleActivity: totalWhaleActivity,
        messagesPerSecond: totalUptime > 0 ? (totalMessages / totalUptime) * 1000 : 0,
      },
    };
  }

  /**
   * Get load balancer status (overhead metrics, rebalancing info)
   */
  getLoadBalancerStatus() {
    const lb = getLoadBalancer();
    return lb.getStatus();
  }

  getSubscriptions() {
    return {
      pumpportal: {
        newTokens: this.pumpportal.getStats().subscriptions.newTokens,
        whales: Array.from(this.whalesByProvider.get("pumpportal") || []),
      },
      pumpdev: {
        trades: Array.from(this.tokensByProvider.get("pumpdev") || []).slice(0, 20), // Show first 20
        whales: Array.from(this.whalesByProvider.get("pumpdev") || []),
      },
      summary: {
        totalTokensBeingMonitored: this.allTokens.size,
        pendingTokens: this.pendingTokens.size,
        pumpdevTokenCount: this.tokensByProvider.get("pumpdev")?.size || 0,
      },
    };
  }
}

// Singleton instance
let instance: DualProviderWebSocket | null = null;

export async function startPumpFunWebSocket(): Promise<void> {
  if (instance) {
    return;
  }

  instance = new DualProviderWebSocket();

  // Wire events to discovery bus
  const { emit: emitDiscoveryEvent } = await import("./discovery-event-bus").catch(() => ({
    emit: async () => {},
  }));

  instance.on("new_token", async (event: any) => {
    try {
      if (emitDiscoveryEvent) {
        await emitDiscoveryEvent({
          type: "new_token",
          tokenMint: event.mint,
          tokenSymbol: event.symbol,
          source: `websocket_${event.provider}`,
          data: { ...event },
          timestamp: event.timestamp || Date.now(),
          urgency: 90,
        });
      }
    } catch (error) {
      console.error("[Routes] Error emitting new_token event:", error);
    }
  });

  instance.on("trade", async (event: any) => {
    try {
      if (emitDiscoveryEvent) {
        await emitDiscoveryEvent({
          type: "volume_spike",
          tokenMint: event.mint,
          source: `websocket_trades_${event.provider}`,
          data: { direction: event.direction, solAmount: event.solAmount },
          timestamp: event.timestamp || Date.now(),
          urgency: 60,
        });
      }
    } catch (error) {
      console.error("[Routes] Error emitting trade event:", error);
    }
  });

  await instance.start();
}

export async function stopPumpFunWebSocket(): Promise<void> {
  if (instance) {
    await instance.stop();
    instance = null;
  }
}

export function getPumpFunWebSocket(): DualProviderWebSocket | null {
  return instance;
}

export function getWebSocketStats(): DualProviderStats | null {
  if (!instance) return null;
  return instance.getStats();
}

export function isWebSocketActive(): boolean {
  if (!instance) return false;
  const stats = instance.getStats();
  return stats.pumpportal.isConnected || stats.pumpdev.isConnected;
}

export function getWebSocketSubscriptions() {
  if (!instance) return null;
  return instance.getSubscriptions();
}

export function getLoadBalancerStatus() {
  if (!instance) return null;
  return instance.getLoadBalancerStatus();
}

export function addWhaleWallet(wallet: string, provider: "pumpportal" | "pumpdev" | "both" = "both"): void {
  if (!instance) {
    throw new Error("WebSocket not started");
  }
  instance.addWhaleWallet(wallet, provider);
}

export function removeWhaleWallet(wallet: string, provider: "pumpportal" | "pumpdev" | "both" = "both"): void {
  if (!instance) return;
  instance.removeWhaleWallet(wallet, provider);
}
