/**
 * Pump.fun WebSocket Client
 *
 * Real-time token discovery and trade monitoring via WebSocket providers
 * (PumpPortal primary, PumpDev fallback).
 *
 * Architecture:
 * - Single connection per provider (respects PumpPortal's 15 connection limit)
 * - Batch subscriptions: up to 5000 addresses per message, ~200/sec to be safe
 * - Dynamic token rotation: add new tokens, remove dead tokens
 * - Integration: Emits events to discovery event bus
 */

import { EventEmitter } from "events";
import { WebSocket as WSType } from "ws";
import { db } from "./db";
import { eq, desc, lt } from "drizzle-orm";
import { tokenDataPool } from "@shared/schema";
import { isValidSolanaAddress } from "@shared/solana-validation";

interface WebSocketProvider {
  name: string;
  url: string;
  emoji: string;
}

interface TokenSubscription {
  mint: string;
  subscribedAt: number;
  tier: "webhook" | "hot" | "warm" | "cold";
  source?: string; // discovery source
}

interface WebSocketStats {
  provider: string;
  isConnected: boolean;
  connectedAt?: number;
  reconnectAttempts: number;
  subscriptions: {
    newTokens: boolean;
    tokenCount: number;
    whaleCount: number;
  };
  messages: {
    total: number;
    newTokens: number;
    trades: number;
    whaleActivity: number;
  };
  lastError?: string;
}

const PROVIDERS: WebSocketProvider[] = [
  {
    name: "PumpPortal",
    url: "wss://pumpportal.fun/api/data",
    emoji: "🎯",
  },
  {
    name: "PumpDev",
    url: "wss://pumpdev.io/ws",
    emoji: "🔧",
  },
];

// Rate limit constants (from PumpPortal docs)
const MAX_SUBSCRIPTIONS_PER_MESSAGE = 5000;
const SAFE_SUBSCRIPTIONS_PER_SECOND = 150; // Conservative limit
const MAX_CONCURRENT_CONNECTIONS = 15;
const SUBSCRIPTION_BATCH_SIZE = 100; // Add 100 tokens per batch
const SUBSCRIPTION_BATCH_INTERVAL_MS = 1000 / SAFE_SUBSCRIPTIONS_PER_SECOND * SUBSCRIPTION_BATCH_SIZE; // ~667ms

// Monitoring constants
const MAX_SUBSCRIBED_TOKENS = 150; // Reasonable limit for single connection
const DEAD_TOKEN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOW_VOLUME_THRESHOLD = 100; // Last 30 min volume < $100
const PRICE_DECAY_THRESHOLD = 0.00000001; // Token effectively dead

class PumpFunWebSocket extends EventEmitter {
  private activeProvider: WebSocketProvider | null = null;
  private fallbackProvider: WebSocketProvider | null = null;
  private ws: WSType | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectBackoffMs = 1000;
  private subscriptions = new Map<string, TokenSubscription>();
  private whaleWallets = new Set<string>();
  private pendingSubscriptions: string[] = [];
  private subscriptionInterval: ReturnType<typeof setInterval> | null = null;
  private stats: WebSocketStats = {
    provider: "disconnected",
    isConnected: false,
    reconnectAttempts: 0,
    subscriptions: { newTokens: false, tokenCount: 0, whaleCount: 0 },
    messages: { total: 0, newTokens: 0, trades: 0, whaleActivity: 0 },
  };

  async start(): Promise<void> {
    this.activeProvider = PROVIDERS[0]; // PumpPortal primary
    this.fallbackProvider = PROVIDERS[1]; // PumpDev fallback

    console.log(`[WebSocket] Starting Pump.fun real-time monitoring`);
    console.log(`  Primary: ${this.activeProvider.name}`);
    console.log(`  Fallback: ${this.fallbackProvider.name}`);

    // Connect to primary provider
    await this.connect(this.activeProvider);

    // Start subscription batch processor
    this.startSubscriptionBatcher();

    // Start monitoring token lifecycle (rotate dead tokens)
    this.startTokenRotation();
  }

  async stop(): Promise<void> {
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
      this.subscriptionInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.stats.isConnected = false;
    console.log(`[WebSocket] Stopped`);
  }

  /**
   * Connect to a provider with exponential backoff on retry
   */
  private async connect(provider: WebSocketProvider): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      const { WebSocket: WS } = await import("ws");

      console.log(`[WebSocket] Connecting to ${provider.name}...`);

      const ws = new WS(provider.url);
      this.ws = ws;

      ws.on("open", () => {
        this.onOpen(provider);
      });

      ws.on("message", (data: Buffer) => {
        this.onMessage(data);
      });

      ws.on("error", (error: Error) => {
        this.onError(provider, error);
      });

      ws.on("close", () => {
        this.onClose(provider);
      });
    } catch (error: any) {
      console.error(`[WebSocket] Connection error:`, error.message);
      this.scheduleReconnect();
    }
  }

  private onOpen(provider: WebSocketProvider): void {
    console.log(
      `${provider.emoji} Connected to ${provider.name}${
        this.reconnectAttempts > 0 ? ` (after ${this.reconnectAttempts} attempts)` : ""
      }`
    );

    this.activeProvider = provider;
    this.reconnectAttempts = 0;
    this.reconnectBackoffMs = 1000;

    this.stats.isConnected = true;
    this.stats.provider = provider.name;
    this.stats.connectedAt = Date.now();
    this.stats.reconnectAttempts = 0;

    // Subscribe to new tokens immediately
    this.subscribeToNewTokens();

    // Subscribe to existing tracked tokens
    this.resubscribeToTrackedTokens();

    // Subscribe to whale wallets
    if (this.whaleWallets.size > 0) {
      this.subscribeToWhales();
    }

    this.emit("connected", { provider: provider.name });
  }

  private onMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      this.stats.messages.total++;

      // Detect message type
      if (message.mint && (message.txType === "buy" || message.txType === "sell" || message.type === "buy" || message.type === "sell")) {
        this.handleTradeMessage(message);
      } else if (message.mint && message.name && !message.txType && !message.type) {
        // New token announcement (async, don't await in sync handler)
        this.handleNewTokenMessage(message).catch(error => {
          console.error(`[WebSocket] Error handling new token:`, error);
        });
      } else if (message.type === "create" || message.type === "createpool") {
        // PumpDev new token or graduation event
        this.handleNewTokenMessage(message).catch(error => {
          console.error(`[WebSocket] Error handling new token:`, error);
        });
      } else if (
        message.method &&
        (message.method === "subscribeAccountTrade" || this.whaleWallets.has(message.wallet))
      ) {
        // Whale wallet activity
        this.handleWhaleActivityMessage(message);
      }
    } catch (error) {
      // Silently skip parse errors (keep-alive messages, etc.)
    }
  }

  private handleTradeMessage(message: any): void {
    this.stats.messages.trades++;

    const { mint, txType, type, solAmount } = message;
    const direction = txType || type;

    if (!mint || !direction || solAmount === undefined) return;

    // Emit to discovery event bus
    this.emit("trade", {
      mint,
      direction,
      solAmount,
      timestamp: Date.now(),
      source: "websocket",
    });
  }

  private handleNewTokenMessage(message: any): Promise<void> {
    return (async () => {
      this.stats.messages.newTokens++;

      const { mint, symbol, name, type, creator } = message;

      if (!mint) return;

      // Emit new token event
      this.emit("new_token", {
        mint,
        symbol: symbol || name,
        timestamp: Date.now(),
        source: "websocket",
        type: type || "create",
      });

      // Auto-subscribe to trades if not already subscribed
      if (!this.subscriptions.has(mint) && this.subscriptions.size < MAX_SUBSCRIBED_TOKENS) {
        // Use tiered monitoring to determine subscription tier
        try {
          const { assessNewTokenForWebSocketSubscription } = await import("./tiered-token-monitoring");
          const tier = await assessNewTokenForWebSocketSubscription(mint, creator);

          if (tier) {
            this.addTokenSubscription(mint, tier);
          }
        } catch (error) {
          console.error(`[WebSocket] Error assessing token tier:`, error);
          // Default to hot tier on error
          this.addTokenSubscription(mint, "hot");
        }
      }
    })();
  }

  private handleWhaleActivityMessage(message: any): void {
    this.stats.messages.whaleActivity++;

    // Extract whale activity details and emit
    this.emit("whale_activity", {
      wallet: message.wallet,
      mint: message.mint,
      direction: message.txType || message.type,
      amount: message.solAmount,
      timestamp: Date.now(),
    });
  }

  private onError(provider: WebSocketProvider, error: Error): void {
    console.error(`[WebSocket] ${provider.name} error:`, error.message);
    this.stats.lastError = error.message;

    // Try fallback if this is primary
    if (provider === this.activeProvider && this.fallbackProvider) {
      console.log(`[WebSocket] Attempting fallback to ${this.fallbackProvider.name}`);
      this.connect(this.fallbackProvider);
    } else {
      this.scheduleReconnect();
    }
  }

  private onClose(provider: WebSocketProvider): void {
    if (!this.stats.isConnected) return; // Already handled

    console.log(`[WebSocket] ${provider.name} closed`);
    this.stats.isConnected = false;

    // Try fallback if this is primary
    if (provider === this.activeProvider && this.fallbackProvider) {
      console.log(`[WebSocket] Switching to fallback: ${this.fallbackProvider.name}`);
      this.connect(this.fallbackProvider);
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[WebSocket] Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.stats.lastError = "Max reconnection attempts reached";
      return;
    }

    this.reconnectAttempts++;
    const delayMs = Math.min(
      this.reconnectBackoffMs * Math.pow(2, this.reconnectAttempts - 1),
      60000
    );

    console.log(
      `[WebSocket] Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(() => {
      if (this.stats.isConnected) return; // Already reconnected

      const provider = this.activeProvider || PROVIDERS[0];
      this.connect(provider);
    }, delayMs);
  }

  private subscribeToNewTokens(): void {
    if (!this.ws || this.ws.readyState !== 1) return;

    try {
      const message = JSON.stringify({ method: "subscribeNewToken" });
      this.ws.send(message);
      this.stats.subscriptions.newTokens = true;
      console.log(`[WebSocket] Subscribed to new tokens`);
    } catch (error: any) {
      console.error(`[WebSocket] Failed to subscribe to new tokens:`, error.message);
    }
  }

  /**
   * Add a token to the subscription queue
   */
  addTokenSubscription(mint: string, tier: "webhook" | "hot" | "warm" | "cold"): void {
    if (this.subscriptions.has(mint)) {
      return; // Already subscribed
    }

    if (this.subscriptions.size >= MAX_SUBSCRIBED_TOKENS) {
      // Remove coldest/oldest token first
      this.evictTokenSubscription();
    }

    this.subscriptions.set(mint, {
      mint,
      subscribedAt: Date.now(),
      tier,
    });

    this.pendingSubscriptions.push(mint);
  }

  /**
   * Remove a token from subscriptions
   */
  removeTokenSubscription(mint: string): void {
    this.subscriptions.delete(mint);
    this.pendingSubscriptions = this.pendingSubscriptions.filter(m => m !== mint);
  }

  /**
   * Evict the least valuable token subscription to make room
   */
  private evictTokenSubscription(): void {
    // Prefer to evict old, cold tier tokens
    let target: TokenSubscription | null = null;
    let targetMint = "";

    for (const [mint, sub] of this.subscriptions) {
      // Skip hot/webhook tokens
      if (sub.tier === "hot" || sub.tier === "webhook") continue;

      // Prefer oldest
      if (!target || sub.subscribedAt < target.subscribedAt) {
        target = sub;
        targetMint = mint;
      }
    }

    // If all are hot/webhook, evict oldest regardless
    if (!target) {
      let oldest: TokenSubscription | null = null;
      for (const [mint, sub] of this.subscriptions) {
        if (!oldest || sub.subscribedAt < oldest.subscribedAt) {
          oldest = sub;
          targetMint = mint;
        }
      }
    }

    if (targetMint) {
      this.removeTokenSubscription(targetMint);
      console.log(`[WebSocket] Evicted old token: ${targetMint.slice(0, 12)}...`);
    }
  }

  /**
   * Batch process pending subscriptions
   */
  private startSubscriptionBatcher(): void {
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
    }

    this.subscriptionInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (this.pendingSubscriptions.length === 0) return;

      // Take up to SUBSCRIPTION_BATCH_SIZE tokens
      const batch = this.pendingSubscriptions.splice(0, SUBSCRIPTION_BATCH_SIZE);

      try {
        const message = JSON.stringify({
          method: "subscribeTokenTrade",
          keys: batch,
        });

        this.ws.send(message);

        this.stats.subscriptions.tokenCount = this.subscriptions.size;
        console.log(
          `[WebSocket] Subscribed to ${batch.length} tokens (total: ${this.subscriptions.size}/${MAX_SUBSCRIBED_TOKENS})`
        );
      } catch (error: any) {
        console.error(`[WebSocket] Subscription batch failed:`, error.message);
        // Re-queue failed tokens
        this.pendingSubscriptions.unshift(...batch);
      }
    }, SUBSCRIPTION_BATCH_INTERVAL_MS);
  }

  /**
   * Re-subscribe to tracked tokens on reconnect
   */
  private resubscribeToTrackedTokens(): void {
    this.pendingSubscriptions = Array.from(this.subscriptions.keys());
  }

  /**
   * Subscribe to whale wallet activity
   */
  subscribeToWhaleWallet(wallet: string): void {
    this.whaleWallets.add(wallet);

    if (this.ws && this.ws.readyState === 1) {
      this.subscribeToWhales();
    }
  }

  /**
   * Unsubscribe from whale wallet
   */
  unsubscribeFromWhaleWallet(wallet: string): void {
    this.whaleWallets.delete(wallet);
  }

  private subscribeToWhales(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (this.whaleWallets.size === 0) return;

    try {
      const message = JSON.stringify({
        method: "subscribeAccountTrade",
        keys: Array.from(this.whaleWallets),
      });

      this.ws.send(message);
      this.stats.subscriptions.whaleCount = this.whaleWallets.size;
      console.log(`[WebSocket] Subscribed to ${this.whaleWallets.size} whale wallets`);
    } catch (error: any) {
      console.error(`[WebSocket] Failed to subscribe to whales:`, error.message);
    }
  }

  /**
   * Periodic check: remove dead tokens from subscriptions
   */
  private startTokenRotation(): void {
    setInterval(async () => {
      if (this.subscriptions.size === 0) return;

      try {
        await this.rotateDeadTokens();
      } catch (error) {
        console.error(`[WebSocket] Token rotation error:`, error);
      }
    }, 60000); // Check every minute
  }

  private async rotateDeadTokens(): Promise<void> {
    const now = Date.now();
    const mints = Array.from(this.subscriptions.keys());
    const toRemove: string[] = [];

    // Fetch token data for subscribed tokens
    const tokens = await db.select().from(tokenDataPool).where(
      // Dynamic query - check if any tokens need removal
    );

    for (const mint of mints) {
      const token = tokens.find(t => t.tokenMint === mint);

      if (!token) {
        // Token not in database - might be too new, keep it
        continue;
      }

      // Check if token is dead
      const isDead =
        token.priceUsd === null ||
        token.priceUsd === undefined ||
        token.priceUsd < PRICE_DECAY_THRESHOLD ||
        (token.volume24h !== null && token.volume24h < LOW_VOLUME_THRESHOLD);

      const age = now - (token.createdAt || now) * 1000;
      const isTooOld = age > DEAD_TOKEN_AGE_MS;

      if (isDead || isTooOld) {
        toRemove.push(mint);
      }
    }

    if (toRemove.length > 0) {
      for (const mint of toRemove) {
        this.removeTokenSubscription(mint);
      }

      console.log(`[WebSocket] Rotated ${toRemove.length} dead tokens`);
    }
  }

  /**
   * Get current WebSocket statistics
   */
  getStats(): WebSocketStats {
    return { ...this.stats };
  }

  /**
   * Get active subscriptions for monitoring/debugging
   */
  getSubscriptions(): {
    tokens: { mint: string; tier: string; age: number }[];
    whales: string[];
  } {
    const now = Date.now();
    return {
      tokens: Array.from(this.subscriptions.values()).map(s => ({
        mint: s.mint,
        tier: s.tier,
        age: now - s.subscribedAt,
      })),
      whales: Array.from(this.whaleWallets),
    };
  }
}

// Singleton instance
let instance: PumpFunWebSocket | null = null;

export async function startPumpFunWebSocket(): Promise<void> {
  if (instance) {
    return; // Already running
  }

  instance = new PumpFunWebSocket();
  await instance.start();
}

export async function stopPumpFunWebSocket(): Promise<void> {
  if (instance) {
    await instance.stop();
    instance = null;
  }
}

export function getPumpFunWebSocket(): PumpFunWebSocket | null {
  return instance;
}

export function subscribeTrades(mint: string, tier: "webhook" | "hot" | "warm" | "cold" = "warm"): void {
  if (!isValidSolanaAddress(mint)) {
    console.warn(`[PumpFun WebSocket] Rejecting invalid mint: "${mint}"`);
    return;
  }
  if (!instance) {
    throw new Error("WebSocket not started");
  }
  instance.addTokenSubscription(mint, tier);
}

export function unsubscribeTrades(mint: string): void {
  if (!instance) {
    return;
  }
  instance.removeTokenSubscription(mint);
}

export function subscribeWhaleWallet(wallet: string): void {
  if (!instance) {
    throw new Error("WebSocket not started");
  }
  instance.subscribeToWhaleWallet(wallet);
}

export function unsubscribeWhaleWallet(wallet: string): void {
  if (!instance) {
    return;
  }
  instance.unsubscribeFromWhaleWallet(wallet);
}

export function getWebSocketStats(): WebSocketStats | null {
  if (!instance) {
    return null;
  }
  return instance.getStats();
}

export function isWebSocketActive(): boolean {
  if (!instance) {
    return false;
  }
  return instance.getStats().isConnected;
}

export function getWebSocketSubscriptions() {
  if (!instance) {
    return null;
  }
  return instance.getSubscriptions();
}

export { PumpFunWebSocket };
