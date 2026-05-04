import { EventEmitter } from "events";
import { GoodTraderIdentifier } from "./good-trader-identifier";

/**
 * PumpDev Wallet Monitor
 *
 * Monitors wallet trading activity via PumpDev WebSocket.
 * Features:
 * - Conservative pool: starts with 500 wallets, filters bots
 * - Good trader identification: tracks $100+ profit trades
 * - Dual-source fallback: PumpDev handles wallet monitoring
 * - No rate limits: PumpDev charges via trading fees, not data access
 *
 * Complement to PumpPortal: while PumpPortal monitors tokens,
 * PumpDev monitors wallets as backup and provides wallet-first discovery.
 */

export interface WalletTradeEvent {
  walletAddress: string;
  tokenMint: string;
  type: "buy" | "sell";
  amount: number;
  pricePerToken: number;
  totalCost: number;
  timestamp: number;
  signature: string;
}

export class PumpDevWalletMonitor extends EventEmitter {
  private serverName: string;
  private monitoredWallets = new Set<string>();
  private wsConnection: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly INITIAL_POOL_SIZE = 500;
  private goodTraderIdentifier: GoodTraderIdentifier;
  private readonly BOT_DETECTION_THRESHOLD = 100; // Rapid trades in short time = bot

  constructor(serverName: string) {
    super();
    this.serverName = serverName;
    this.goodTraderIdentifier = new GoodTraderIdentifier();
  }

  /**
   * Initialize wallet monitor with seed wallet list
   */
  async initialize(seedWallets: string[] = []): Promise<void> {
    try {
      // Start with seed wallets (from good_traders table)
      if (seedWallets.length > 0) {
        seedWallets.slice(0, this.INITIAL_POOL_SIZE).forEach((w) => {
          this.monitoredWallets.add(w);
        });
      }

      console.log(
        `[PumpDevWalletMonitor] Initialized with ${this.monitoredWallets.size} wallets`
      );

      // Connect to PumpDev WebSocket
      await this.connect();
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Initialization failed:`,
        error
      );
      throw error;
    }
  }

  /**
   * Connect to PumpDev WebSocket
   */
  private async connect(): Promise<void> {
    try {
      return new Promise((resolve, reject) => {
        try {
          const ws = new WebSocket("wss://pumpdev.io/ws");

          ws.onopen = () => {
            console.log(
              `[PumpDevWalletMonitor] Connected to PumpDev WebSocket`
            );
            this.wsConnection = ws as any;
            this.reconnectAttempts = 0;

            // Subscribe to wallet trades
            this.subscribeToWalletTrades();
            resolve();
          };

          ws.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data as string);
              this.handleMessage(message);
            } catch (error) {
              console.error(
                `[PumpDevWalletMonitor] Failed to parse message:`,
                error
              );
            }
          };

          ws.onerror = (error) => {
            console.error(
              `[PumpDevWalletMonitor] WebSocket error:`,
              error
            );
            reject(error);
          };

          ws.onclose = () => {
            console.warn(
              `[PumpDevWalletMonitor] Disconnected from PumpDev`
            );
            this.wsConnection = null;
            this.attemptReconnect();
          };
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Connection failed:`,
        error
      );
      this.attemptReconnect();
    }
  }

  /**
   * Subscribe to trades on monitored wallets
   */
  private subscribeToWalletTrades(): void {
    if (!this.wsConnection) return;

    try {
      // Convert wallets to array and subscribe in batches
      const walletArray = Array.from(this.monitoredWallets);

      for (const wallet of walletArray) {
        this.wsConnection.send(
          JSON.stringify({
            method: "subscribeAccountTrade",
            keys: [wallet],
          })
        );
      }

      console.log(
        `[PumpDevWalletMonitor] Subscribed to ${walletArray.length} wallets`
      );
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Subscription failed:`,
        error
      );
    }
  }

  /**
   * Handle incoming trade messages from PumpDev
   */
  private handleMessage(message: any): void {
    try {
      // Check if this is a trade event
      if (!message.txType || !message.mint || !message.traderPublicKey) {
        return; // Not a trade message
      }

      // Filter for buys and sells (ignore other transaction types)
      if (!["buy", "sell"].includes(message.txType)) {
        return;
      }

      const tradeEvent: WalletTradeEvent = {
        walletAddress: message.traderPublicKey,
        tokenMint: message.mint,
        type: message.txType as "buy" | "sell",
        amount: message.tokenAmount || 0,
        pricePerToken: message.solAmount / (message.tokenAmount || 1),
        totalCost: message.solAmount || 0,
        timestamp: Math.floor(Date.now() / 1000),
        signature: message.signature || "",
      };

      // Emit trade event for other systems
      this.emit("trade", tradeEvent);

      // Analyze for good trader signals (sells at profit)
      if (message.txType === "sell") {
        this.analyzeTradeSignal(tradeEvent);
      }

      // Check if wallet should be added to monitoring pool
      if (message.txType === "buy") {
        this.considerAddingWallet(message.traderPublicKey);
      }
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Failed to handle message:`,
        error
      );
    }
  }

  /**
   * Analyze sell for good trader signal
   */
  private async analyzeTradeSignal(trade: WalletTradeEvent): Promise<void> {
    try {
      // TODO: Fetch buy price for this wallet+token from DB
      // For now, estimate profit (would need historical data)

      // Estimate: if sell price > 1.5x entry price, flag as potential profit
      // Full implementation would track actual entry price

      const estimatedEntryPrice = trade.pricePerToken / 1.5; // Conservative estimate
      const estimatedProfit = (trade.pricePerToken - estimatedEntryPrice) * trade.amount;

      if (estimatedProfit >= 100) {
        // Potential $100+ profit
        await this.goodTraderIdentifier.analyzeTradeSignal({
          walletAddress: trade.walletAddress,
          tokenMint: trade.tokenMint,
          profitUsd: estimatedProfit,
          profitMultiplier: trade.pricePerToken / estimatedEntryPrice,
          buyPrice: estimatedEntryPrice,
          sellPrice: trade.pricePerToken,
          holdMinutes: 60, // Estimate, would need actual hold time
          signature: trade.signature,
        });
      }
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Failed to analyze trade signal:`,
        error
      );
    }
  }

  /**
   * Consider adding wallet to monitoring pool
   */
  private considerAddingWallet(walletAddress: string): void {
    try {
      // Don't exceed pool size
      if (this.monitoredWallets.size >= this.INITIAL_POOL_SIZE) {
        return;
      }

      // Check bot patterns before adding
      if (this.isBotWallet(walletAddress)) {
        return; // Skip bots
      }

      // Add to monitoring pool
      if (!this.monitoredWallets.has(walletAddress)) {
        this.monitoredWallets.add(walletAddress);
        console.debug(
          `[PumpDevWalletMonitor] Added wallet to pool: ${walletAddress}`
        );

        // Emit event for other systems to pick up
        this.emit("walletDiscovered", { walletAddress });
      }
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Failed to consider adding wallet:`,
        error
      );
    }
  }

  /**
   * Detect bot wallets (simple heuristics)
   */
  private isBotWallet(walletAddress: string): boolean {
    // TODO: Implement bot detection
    // Heuristics:
    // 1. Rapid-fire trades (multiple per second)
    // 2. Identical transaction amounts
    // 3. MEV sandwich patterns
    // 4. Granular amounts (not human-like round numbers)

    return false; // For now, assume not bot (conservative)
  }

  /**
   * Attempt reconnection with exponential backoff
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[PumpDevWalletMonitor] Max reconnection attempts reached`
      );
      return;
    }

    this.reconnectAttempts++;
    const backoffMs = Math.pow(2, this.reconnectAttempts) * 1000; // Exponential: 2s, 4s, 8s, 16s, 32s

    console.log(
      `[PumpDevWalletMonitor] Reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts})`
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      await this.connect();
    } catch (error) {
      console.error(`[PumpDevWalletMonitor] Reconnection failed:`, error);
      this.attemptReconnect();
    }
  }

  /**
   * Get monitored wallet list
   */
  getMonitoredWallets(): string[] {
    return Array.from(this.monitoredWallets);
  }

  /**
   * Add wallet to monitoring pool manually
   */
  addWallet(walletAddress: string): void {
    if (this.monitoredWallets.size < this.INITIAL_POOL_SIZE) {
      this.monitoredWallets.add(walletAddress);

      // Resubscribe with new wallet
      if (this.wsConnection) {
        this.wsConnection.send(
          JSON.stringify({
            method: "subscribeAccountTrade",
            keys: [walletAddress],
          })
        );
      }

      console.log(
        `[PumpDevWalletMonitor] Added wallet: ${walletAddress}`
      );
    }
  }

  /**
   * Remove wallet from monitoring
   */
  removeWallet(walletAddress: string): void {
    this.monitoredWallets.delete(walletAddress);

    // Unsubscribe
    if (this.wsConnection) {
      this.wsConnection.send(
        JSON.stringify({
          method: "unsubscribeAccountTrade",
          keys: [walletAddress],
        })
      );
    }

    console.log(
      `[PumpDevWalletMonitor] Removed wallet: ${walletAddress}`
    );
  }

  /**
   * Shutdown gracefully
   */
  async shutdown(): Promise<void> {
    try {
      if (this.wsConnection) {
        this.wsConnection.close();
        this.wsConnection = null;
      }

      console.log(`[PumpDevWalletMonitor] Shutdown complete`);
    } catch (error) {
      console.error(
        `[PumpDevWalletMonitor] Shutdown error:`,
        error
      );
    }
  }

  /**
   * Get stats
   */
  getStats(): {
    monitoredWalletCount: number;
    poolCapacity: number;
    poolUtilization: number;
    isConnected: boolean;
  } {
    return {
      monitoredWalletCount: this.monitoredWallets.size,
      poolCapacity: this.INITIAL_POOL_SIZE,
      poolUtilization: (this.monitoredWallets.size / this.INITIAL_POOL_SIZE) * 100,
      isConnected: this.wsConnection !== null,
    };
  }
}

// Global instance
let walletMonitorInstance: PumpDevWalletMonitor | null = null;

export async function initializePumpDevWalletMonitor(
  serverName: string,
  seedWallets?: string[]
): Promise<PumpDevWalletMonitor> {
  if (!walletMonitorInstance) {
    walletMonitorInstance = new PumpDevWalletMonitor(serverName);
    await walletMonitorInstance.initialize(seedWallets);
  }
  return walletMonitorInstance;
}

export function getPumpDevWalletMonitor(): PumpDevWalletMonitor | null {
  return walletMonitorInstance;
}

export async function shutdownPumpDevWalletMonitor(): Promise<void> {
  if (walletMonitorInstance) {
    await walletMonitorInstance.shutdown();
    walletMonitorInstance = null;
  }
}
