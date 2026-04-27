/**
 * Phase 1: Infrastructure Initialization
 *
 * Orchestrates startup of all Phase 1 components for 3-server mesh architecture.
 * Initialize order:
 * 1. Server identity detection
 * 2. Subscription manager (DB-driven assignment)
 * 3. Good trader identifier
 * 4. Wallet cluster detector
 * 5. Wallet history analyzer
 * 6. DexPaprika post-grad manager
 * 7. PumpDev wallet monitor
 * 8. Event coordination between managers
 */

import { ServerSubscriptionManager } from "./server-subscription-manager";
import { GoodTraderIdentifier } from "./good-trader-identifier";
import { WalletClusterDetector } from "./wallet-cluster-detector";
import { WalletHistoryAnalyzer } from "./wallet-history-analyzer";
import { DexPaprikaPostGradManager } from "./dexpaprika-post-grad-manager";
import {
  initializePumpDevWalletMonitor,
  getPumpDevWalletMonitor,
} from "./pumpdev-wallet-monitor";

export interface Phase1Infrastructure {
  serverName: string;
  subscriptionManager: ServerSubscriptionManager;
  goodTraderIdentifier: GoodTraderIdentifier;
  clusterDetector: WalletClusterDetector;
  historyAnalyzer: WalletHistoryAnalyzer;
  postGradManager: DexPaprikaPostGradManager;
  isInitialized: boolean;
}

let phase1Instance: Phase1Infrastructure | null = null;

/**
 * Detect server name from environment
 */
function detectServerName(): string {
  const env = process.env.SERVER_NAME;
  if (env && ["pincher2", "proxy-1", "proxy-2"].includes(env)) {
    return env;
  }

  // Default to pincher2 if running main app
  return "pincher2";
}

/**
 * Initialize Phase 1 infrastructure
 */
export async function initializePhase1Infrastructure(
  shyftApiKey: string
): Promise<Phase1Infrastructure> {
  try {
    const serverName = detectServerName();

    console.log(
      `[Phase1] Initializing infrastructure for server: ${serverName}`
    );

    // 1. Initialize subscription manager
    const subscriptionManager = new ServerSubscriptionManager(serverName);
    const mySubscriptions = await subscriptionManager.getMySubscriptions();

    console.log(
      `[Phase1] Loaded ${mySubscriptions.tokenMints.length} token subscriptions, ` +
        `${mySubscriptions.walletAddresses.length} wallet subscriptions`
    );

    // 2. Initialize good trader identifier
    const goodTraderIdentifier = new GoodTraderIdentifier();

    // 3. Initialize wallet cluster detector
    const clusterDetector = new WalletClusterDetector();

    // 4. Initialize wallet history analyzer
    const historyAnalyzer = new WalletHistoryAnalyzer(shyftApiKey);

    // 5. Initialize DexPaprika post-grad manager
    const postGradManager = new DexPaprikaPostGradManager(serverName);

    // 6. Initialize PumpDev wallet monitor
    // Load good traders to seed the wallet pool
    const activeTraders = await goodTraderIdentifier.getActiveTraders();
    const traderAddresses = activeTraders.map((t) => t.walletAddress);

    const walletMonitor = await initializePumpDevWalletMonitor(
      serverName,
      traderAddresses.slice(0, 500)
    );

    console.log(
      `[Phase1] PumpDev wallet monitor initialized with ${walletMonitor.getStats().monitoredWalletCount} wallets`
    );

    // 7. Set up event coordination
    setupEventCoordination(
      serverName,
      goodTraderIdentifier,
      clusterDetector,
      walletMonitor,
      postGradManager,
      historyAnalyzer
    );

    const infrastructure: Phase1Infrastructure = {
      serverName,
      subscriptionManager,
      goodTraderIdentifier,
      clusterDetector,
      historyAnalyzer,
      postGradManager,
      isInitialized: true,
    };

    phase1Instance = infrastructure;

    console.log(`[Phase1] Infrastructure initialization complete`);
    return infrastructure;
  } catch (error) {
    console.error(`[Phase1] Initialization failed:`, error);
    throw error;
  }
}

/**
 * Set up event coordination between managers
 */
function setupEventCoordination(
  serverName: string,
  goodTraderIdentifier: GoodTraderIdentifier,
  clusterDetector: WalletClusterDetector,
  walletMonitor: any,
  postGradManager: DexPaprikaPostGradManager,
  historyAnalyzer: WalletHistoryAnalyzer
): void {
  console.log(`[Phase1] Setting up event coordination`);

  // PumpDev wallet monitor → good trader identifier
  walletMonitor.on("trade", async (trade: any) => {
    // Analyze profitable sells for good trader signals
    if (trade.type === "sell") {
      // TODO: Fetch buy price and calculate actual profit
      // For now, only analyze if sufficient time has passed (not MEV)
    }
  });

  // PumpDev wallet monitor → wallet history analyzer
  walletMonitor.on("walletDiscovered", async (event: any) => {
    const { walletAddress } = event;

    // Queue for history analysis
    setTimeout(async () => {
      await historyAnalyzer.analyzeWalletHistory(walletAddress);
    }, 5000); // 5s delay to avoid immediate duplicate analysis
  });

  // DexPaprika post-grad manager → event logging
  postGradManager.on("subscribed", (event: any) => {
    console.log(
      `[Phase1] Subscribed to post-grad trades on ${event.tokenMint}`
    );
  });

  postGradManager.on("trade", (event: any) => {
    // Handle post-grad trades (feed into position management, etc)
    // TODO: Emit to discovery event bus or paper trading system
  });

  postGradManager.on("disconnected", (event: any) => {
    console.warn(
      `[Phase1] Lost connection to post-grad stream for ${event.tokenMint}`
    );
  });

  postGradManager.on("error", (event: any) => {
    console.error(
      `[Phase1] Post-grad manager error for ${event.tokenMint}:`,
      event.error
    );
  });

  console.log(`[Phase1] Event coordination established`);
}

/**
 * Get initialized Phase 1 infrastructure
 */
export function getPhase1Infrastructure(): Phase1Infrastructure | null {
  return phase1Instance;
}

/**
 * Get subscription manager
 */
export function getSubscriptionManager(): ServerSubscriptionManager | null {
  return phase1Instance?.subscriptionManager || null;
}

/**
 * Get good trader identifier
 */
export function getGoodTraderIdentifier(): GoodTraderIdentifier | null {
  return phase1Instance?.goodTraderIdentifier || null;
}

/**
 * Get wallet cluster detector
 */
export function getWalletClusterDetector(): WalletClusterDetector | null {
  return phase1Instance?.clusterDetector || null;
}

/**
 * Get wallet history analyzer
 */
export function getWalletHistoryAnalyzer(): WalletHistoryAnalyzer | null {
  return phase1Instance?.historyAnalyzer || null;
}

/**
 * Get DexPaprika post-grad manager
 */
export function getDexPaprikaPostGradManager(): DexPaprikaPostGradManager | null {
  return phase1Instance?.postGradManager || null;
}

/**
 * Get PumpDev wallet monitor
 */
export function getPumpDevWalletMonitorInstance() {
  return getPumpDevWalletMonitor();
}

/**
 * Get Phase 1 infrastructure status
 */
export function getPhase1Status(): {
  isInitialized: boolean;
  serverName: string;
  components: Record<string, any>;
} {
  if (!phase1Instance) {
    return {
      isInitialized: false,
      serverName: "unknown",
      components: {},
    };
  }

  return {
    isInitialized: phase1Instance.isInitialized,
    serverName: phase1Instance.serverName,
    components: {
      subscriptionManager: phase1Instance.subscriptionManager.getStats?.(),
      postGradManager: phase1Instance.postGradManager.getStats?.(),
      walletMonitor: getPumpDevWalletMonitor()?.getStats?.(),
    },
  };
}

/**
 * Shutdown Phase 1 infrastructure gracefully
 */
export async function shutdownPhase1Infrastructure(): Promise<void> {
  try {
    console.log(`[Phase1] Shutting down infrastructure`);

    if (phase1Instance?.postGradManager) {
      // Close any open DexPaprika subscriptions
      // (would be handled by manager cleanup)
    }

    const walletMonitor = getPumpDevWalletMonitor();
    if (walletMonitor) {
      await walletMonitor.shutdown();
    }

    phase1Instance = null;
    console.log(`[Phase1] Shutdown complete`);
  } catch (error) {
    console.error(`[Phase1] Shutdown error:`, error);
  }
}

/**
 * Periodic maintenance task
 * Called every 5 minutes to check health and reconnect if needed
 */
export async function phase1MaintenanceTask(): Promise<void> {
  if (!phase1Instance?.isInitialized) return;

  try {
    // Check subscription health
    const stats = await phase1Instance.subscriptionManager.getStats();

    if (stats) {
      console.debug(
        `[Phase1] Maintenance: ${stats.active} active subscriptions, ` +
          `${stats.reconnecting} reconnecting, ${stats.paused} paused`
      );
    }

    // Queue wallets for history analysis
    const walletsToAnalyze = await phase1Instance.historyAnalyzer.getWalletsNeedingAnalysis(10);

    for (const wallet of walletsToAnalyze) {
      await phase1Instance.historyAnalyzer.analyzeWalletHistory(wallet);
    }

    // Check post-grad manager health
    const postGradStats = phase1Instance.postGradManager.getStats();
    console.debug(
      `[Phase1] Post-grad monitoring: ${postGradStats.activeSubscriptions} active tokens`
    );
  } catch (error) {
    console.error(`[Phase1] Maintenance task failed:`, error);
  }
}
