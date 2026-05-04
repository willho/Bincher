import { db } from "./db";
import { eq, and, gt, gte, desc, isNull, sql } from "drizzle-orm";
import {
  tokenDataPool,
  tokenFingerprints,
  raydiumPoolDiscoveries,
  paperPositions,
  familiarWhales,
  signalWalletProfiles,
  tokenFingerprintSnapshots,
} from "@shared/schema";
import { fetchTokenWithFallback, getTokenData } from "./data-pool";
import { calculateTrajectorySignal, filterSignalsByAction, rankSignalsByConfidence } from "./trajectory-buy-sell";
import { clusterSnapshotToArchetype, getSnapshotSchedule, shouldTakeSnapshotForEvent } from "./fingerprint-cluster-management";
import { generateWhaleSignal, calculateExitSignal, validateWhaleSignal, getWhaleWeightMetrics } from "./whale-watcher-system";
import { systemPicksFund, type FundSession } from "./system-picks-fund";
import { getHolderClusterAssociations } from "./wallet-discovery";
import { calculateAllocation, updateApeBudgetAfterPosition } from "./position-allocator";
import { recordTokenLaunchEvent, recordTokenOutcome, updatePositionBudgetForecast } from "./position-budget-forecaster";
import { onSnapshotCreated } from "./snapshot-event-dispatcher";
import { positionExitManager } from "./position-exit-manager";
import axios from "axios";

// =====================
// CONFIGURATION
// =====================

const SYSTEM_PICKS_CONFIG = {
  // Cluster matching thresholds
  minClusterConfidence: 0.50,  // Minimum confidence in cluster match
  minClusterBlendConfidence: 0.60, // Higher threshold for blended clusters

  // Fund allocation
  tokensExpectedPerDay: 50, // Used to calculate base allocation
  minBuyConviction: 0.3, // Minimum conviction to trigger buy

  // Exit parameters
  defaultTakeProfitMultiplier: 5.0,
  defaultStopLossPercent: 20,
  defaultTrailingStopPercent: 15,

  // Fund constraints
  maxSimultaneousTokens: 50,
  fundEnabled: true, // Start fund on boot

  // Jupiter validation
  jupiterSimulateTimeoutMs: 10000,

  // Rug wariness (conservative baseline)
  minProfitWindowMinutes: 5, // Buffer: skip if <5min remaining
  minRugSampleSize: 10, // Require 10+ rug records before trading
  rugWarinessHigh: 0.40, // >40% rugs = don't trade
  rugWarinessMedium: 0.20, // >20% rugs = 3x conviction penalty
  convictionPenaltyMultiplier: 3.0, // For rug-prone clusters
};

interface SystemPick {
  tokenMint: string;
  tokenSymbol: string;
  clusterConfidence: number;      // Cluster match quality (0-1)
  clusterOutcomeSuccess: number;  // % of cluster that succeeded
  whaleConsensus: number;         // % of whales showing exit signal
  whaleWeight: number;            // Current whale signal weight (0.01-0.50)
  exitScore: number;              // Combined exit decision score
  exitRecommendation: "hard_exit" | "tighten_tsl" | "monitor_closely" | "hold";
  matchedClusterIds: string[];    // Cluster(s) matched
  isBlended: boolean;             // Multi-cluster match
  confidencePenalty: number;      // Reduction if blended
  estimatedEntry: number;         // Cluster confidence (for allocation)
  jupiterValidated: boolean;
  trajectoryScore?: number;       // Risk-adjusted trajectory score
}

// Global state
let currentFundSession: FundSession | null = null;
let tokenToPositionId: Map<string, string> = new Map();

// =====================
// INITIALIZATION
// =====================

/**
 * Initialize system-picks fund on startup
 */
export async function initializeSystemPicksFund(): Promise<void> {
  if (!SYSTEM_PICKS_CONFIG.fundEnabled) {
    console.log("[SystemPicks] Fund disabled via config");
    return;
  }

  // Start fund session with default parameters
  currentFundSession = systemPicksFund.startSession({
    minClusterConfidence: SYSTEM_PICKS_CONFIG.minClusterConfidence,
    whaleWeightUsed: getWhaleWeightMetrics().currentWeight,
    minBuyConviction: SYSTEM_PICKS_CONFIG.minBuyConviction,
    defaultTakeProfitMultiplier: SYSTEM_PICKS_CONFIG.defaultTakeProfitMultiplier,
    defaultStopLossPercent: SYSTEM_PICKS_CONFIG.defaultStopLossPercent,
    defaultTrailingStopPercent: SYSTEM_PICKS_CONFIG.defaultTrailingStopPercent,
    timeOfDayRationing: true,
    highQualityWindow: { start: 15, end: 21 }, // 3pm-9pm
  });

  console.log(`[SystemPicks] Fund session started: ${currentFundSession.sessionId}`);
}

// =====================
// RUG WARINESS ASSESSMENT
// =====================

/**
 * Calculate rug outcome percentage in cluster
 */
function calculateClusterRugRate(outcomeDistribution: Record<string, number>): number {
  const rugOutcomes = ['crash_90', 'crash_95', 'crash_99', 'rug_pull'];
  const totalOutcomes = Object.values(outcomeDistribution).reduce((a, b) => a + b, 0);
  if (totalOutcomes === 0) return 0;

  const rugCount = rugOutcomes.reduce((sum, outcome) => sum + (outcomeDistribution[outcome] || 0), 0);
  return rugCount / totalOutcomes;
}

/**
 * Assess cluster wariness level and determine if tradeable
 * Returns: { level: 'safe'|'medium'|'high', rugRate: number, canTrade: boolean, reason?: string }
 */
function assessClusterWariness(
  metadata: Record<string, any>,
  outcomeDistribution: Record<string, number>
): {
  level: 'safe' | 'medium' | 'high';
  rugRate: number;
  canTrade: boolean;
  reason?: string;
} {
  const rugRate = calculateClusterRugRate(outcomeDistribution);
  const rugSampleSize = (metadata?.rugProfitWindows?.length || 0);

  // Require minimum sample size before trading
  if (rugSampleSize < SYSTEM_PICKS_CONFIG.minRugSampleSize) {
    return {
      level: 'high',
      rugRate,
      canTrade: false,
      reason: `Untested cluster (${rugSampleSize}/${SYSTEM_PICKS_CONFIG.minRugSampleSize} rug samples)`,
    };
  }

  // High rug rate = don't trade
  if (rugRate >= SYSTEM_PICKS_CONFIG.rugWarinessHigh) {
    return {
      level: 'high',
      rugRate,
      canTrade: false,
      reason: `High rug rate (${(rugRate * 100).toFixed(0)}% >= ${(SYSTEM_PICKS_CONFIG.rugWarinessHigh * 100).toFixed(0)}%)`,
    };
  }

  // Medium rug rate = require higher conviction
  if (rugRate >= SYSTEM_PICKS_CONFIG.rugWarinessMedium) {
    return {
      level: 'medium',
      rugRate,
      canTrade: true,
      reason: `Medium rug rate (${(rugRate * 100).toFixed(0)}%) - conviction penalty applied`,
    };
  }

  return {
    level: 'safe',
    rugRate,
    canTrade: true,
  };
}

// =====================
// CLUSTER MATCHING WITH NEW ALGORITHMS
// =====================

/**
 * Calculate system pick signal using new cluster algorithms
 *
 * New features:
 * - Multi-cluster matching and blending (Algorithm 3)
 * - Whale signal integration
 * - Combined exit score
 */
async function calculateSystemPickSignal(tokenMint: string): Promise<SystemPick | null> {
  try {
    // Get latest snapshot (trajectory data includes features and maxMultiplier reached)
    const snapshots = await db
      .select()
      .from(tokenFingerprintSnapshots)
      .where(eq(tokenFingerprintSnapshots.tokenMint, tokenMint))
      .orderBy(desc(tokenFingerprintSnapshots.timestamp))
      .limit(1);

    if (snapshots.length === 0) return null;

    const snapshot = snapshots[0];
    const features = Array.isArray(snapshot.features)
      ? snapshot.features
      : JSON.parse(snapshot.features as any);

    // Extract trajectory data (includes maxMultiplier reached)
    const trajectory = snapshot.trajectoryAnchored as any || {};
    const top20Metrics = snapshot.top20HolderMetrics as any || {};

    // Look up top 20 holder cluster associations from leaderboard (for learning)
    const topHolderWallets = (top20Metrics.walletAddresses || []) as string[];
    const holderMetrics = await getHolderClusterAssociations(topHolderWallets);

    // Calculate average holder quality (for context/logging)
    const avgHolderWinRate = holderMetrics.size > 0
      ? Array.from(holderMetrics.values()).reduce((sum, m) => sum + m.winRate, 0) / holderMetrics.size
      : 0;

    // NEW: Use enhanced cluster matching with multi-cluster blending (Algorithm 3)
    const clusterResult = await clusterSnapshotToArchetype({
      tokenMint,
      fingerprintVector: features,
      tokenAgeMinutes: snapshot.tokenAgeSeconds / 60,
      medianMultiplier: top20Metrics.medianMultiplier || 1,
    });

    if (!clusterResult || !clusterResult.matches || clusterResult.matches.length === 0) {
      return null;
    }

    // Check confidence threshold
    if (clusterResult.primaryClusterId === "none" || clusterResult.matches[0].similarity < SYSTEM_PICKS_CONFIG.minClusterConfidence) {
      return null;
    }

    // ===== RUG WARINESS CHECKS =====
    const primaryCluster = clusterResult.matches[0];
    const clusterMetadata = primaryCluster.metadata || {};
    const clusterOutcomes = clusterResult.blendedOutcomes;

    // 1. ASSESS CLUSTER WARINESS
    const wariness = assessClusterWariness(clusterMetadata, clusterOutcomes);
    if (!wariness.canTrade) {
      console.log(`[SystemPicks] Token ${tokenMint.slice(0, 8)} blocked: ${wariness.reason}`);
      return null;
    }

    // 2. CHECK PROFIT WINDOW (with higher buffer)
    const { getClusterAverageProfitWindow } = await import("./fingerprint-cluster-management");
    const avgProfitWindowMinutes = getClusterAverageProfitWindow(clusterMetadata);

    if (avgProfitWindowMinutes !== null) {
      const tokenAgeMinutes = snapshot.tokenAgeSeconds / 60;
      const remainingWindow = avgProfitWindowMinutes - tokenAgeMinutes;

      // Skip if less than configurable profit window remaining (default 5 min)
      if (remainingWindow < SYSTEM_PICKS_CONFIG.minProfitWindowMinutes) {
        console.log(
          `[SystemPicks] Token ${tokenMint.slice(0, 8)} past profit window ` +
          `(age=${tokenAgeMinutes.toFixed(0)}min, remaining=${remainingWindow.toFixed(0)}min, ` +
          `required=${SYSTEM_PICKS_CONFIG.minProfitWindowMinutes}min)`
        );
        return null;
      }
    }

    const tokenData = await getTokenData(tokenMint);

    // NEW: Generate whale signals
    const trackedWallets = await getTrackedWalletsForToken(tokenMint);
    const whaleSignal = await generateWhaleSignal(tokenMint, trackedWallets);

    // Calculate outcome success rate from blended outcomes
    const blendedOutcomes = clusterResult.blendedOutcomes;
    const successfulOutcomes = ["pump_100x", "pump_10x", "pump_5x", "pump_2x_sustained", "pump_2x_quick", "pump_minor"];
    const outcomesSuccess = successfulOutcomes.reduce((sum, o) => sum + (blendedOutcomes[o] || 0), 0);

    // NEW: Calculate combined exit score
    const clusterConfidence = clusterResult.matches[0].similarity;
    const { exitScore, recommendation } = calculateExitSignal(clusterConfidence, whaleSignal);

    // 3. APPLY RUG CONFIDENCE PENALTY
    let adjustedConfidence = clusterConfidence * (1 - clusterResult.confidencePenalty);
    let adjustedOutcomeSuccess = outcomesSuccess;

    if (wariness.level === 'medium') {
      // Medium rug rate: require 3x higher conviction - penalize both confidence and outcome success
      adjustedConfidence = adjustedConfidence / SYSTEM_PICKS_CONFIG.convictionPenaltyMultiplier;
      adjustedOutcomeSuccess = outcomesSuccess / SYSTEM_PICKS_CONFIG.convictionPenaltyMultiplier;
    }

    // Calculate trajectory score for position allocation
    const trajectoryData = clusterResult.blendedOutcomes || {};
    const trajectoryScore = calculateTrajectoryScoreFromOutcomes(trajectoryData);

    const pick: SystemPick = {
      tokenMint,
      tokenSymbol: tokenData?.tokenSymbol || tokenMint.slice(0, 8),
      clusterConfidence: adjustedConfidence,
      clusterOutcomeSuccess: adjustedOutcomeSuccess,
      whaleConsensus: whaleSignal.exitConsensus,
      whaleWeight: getWhaleWeightMetrics().currentWeight,
      exitScore,
      exitRecommendation: recommendation,
      matchedClusterIds: clusterResult.matches.map((m) => m.clusterId),
      isBlended: clusterResult.matches.length > 1,
      confidencePenalty: clusterResult.confidencePenalty,
      estimatedEntry: adjustedConfidence, // Now uses actual cluster confidence for allocation
      jupiterValidated: false,
      trajectoryScore, // Store for allocation decision
    };

    return pick;
  } catch (error) {
    console.error(`[SystemPicks] Error calculating signal for ${tokenMint.slice(0, 8)}:`, error);
    return null;
  }
}

/**
 * Get tracked wallets for a token (stub - integrate with whale discovery)
 */
async function getTrackedWalletsForToken(tokenMint: string): Promise<string[]> {
  // TODO: Query familiar whales that have traded this token
  // For now: return empty (whale watcher will still work with 0 wallets)
  return [];
}

// =====================
// JUPITER VALIDATION
// =====================

async function validateWithJupiter(mint: string, entryAmountSol: number = 1.0): Promise<boolean> {
  try {
    const tokenData = await getTokenData(mint);

    if (!tokenData.raydiumPoolAddress) {
      return false;
    }

    // Check liquidity: need enough to execute entry
    if ((tokenData.raydiumLiquidityUsd || 0) < 10000) {
      return false;
    }

    console.log(
      `[SystemPicks] Token ${mint.slice(0, 8)} Jupiter validation passed (liquidity=${(tokenData.raydiumLiquidityUsd || 0).toFixed(0)} USD)`
    );
    return true;
  } catch (error) {
    console.error(`[SystemPicks] Jupiter validation error for ${mint.slice(0, 8)}:`, error);
    return false;
  }
}

// =====================
// POSITION OPENING (FUND-BASED)
// =====================

/**
 * Open a position through the simulated fund
 * Integrates with new position management system (Phase A)
 */
async function openSystemPickPosition(pick: SystemPick): Promise<boolean> {
  if (!currentFundSession) {
    console.error("[SystemPicks] No active fund session");
    return false;
  }

  try {
    // Get current token price and data
    const tokenData = await getTokenData(pick.tokenMint);
    const entryPrice = tokenData.priceUsd || 1;
    const userId = 1; // For now, assume user 1 (admin)

    // Calculate allocation using new position allocator
    const trajectoryScore = pick.trajectoryScore || 0;
    const allocation = await calculateAllocation(
      userId,
      currentFundSession.currentBalance,
      pick.clusterConfidence,
      trajectoryScore
    );

    // Record token launch event for budget forecasting
    const now = Math.floor(Date.now() / 1000);
    await recordTokenLaunchEvent(pick.tokenMint, now);

    // Open position through fund (keeps existing behavior)
    const position = systemPicksFund.openPosition(
      pick.tokenMint,
      pick.tokenSymbol,
      pick.clusterConfidence,
      pick.whaleConsensus,
      pick.exitScore,
      entryPrice,
      SYSTEM_PICKS_CONFIG.tokensExpectedPerDay
    );

    if (!position) {
      console.log(
        `[SystemPicks] Fund rejected position for ${pick.tokenSymbol} (insufficient balance)`
      );
      return false;
    }

    // Track position ID for price updates
    tokenToPositionId.set(pick.tokenMint, position.positionId);

    // Phase A: Record token launch event for budget forecasting
    try {
      const { recordTokenLaunchEvent } = await import("./position-budget-forecaster");
      const userId = 1; // TODO: Get from session
      await recordTokenLaunchEvent(userId, pick.tokenMint);
    } catch (err) {
      console.error("[SystemPicks] Failed to record Phase A launch event:", err);
    }

    console.log(
      `[SystemPicks] Opened position: ${pick.tokenSymbol} ` +
      `(entry=${entryPrice.toFixed(4)}, size=${allocation.totalAllocation.toFixed(4)} SOL, ` +
      `cluster=${pick.clusterConfidence.toFixed(2)}, trajectory=${trajectoryScore.toFixed(2)}, ` +
      `exceptional=${allocation.isExceptional ? "yes" : "no"})`
    );

    return true;
  } catch (error) {
    console.error(`[SystemPicks] Error opening position for ${pick.tokenMint.slice(0, 8)}:`, error);
    return false;
  }
}

// =====================
// POSITION UPDATES & EXIT
// =====================

/**
 * Update position P&L as price changes
 */
export async function updatePositionPrices(prices: Record<string, number>): Promise<void> {
  if (!currentFundSession) return;

  for (const [tokenMint, price] of Object.entries(prices)) {
    const positionId = tokenToPositionId.get(tokenMint);
    if (positionId) {
      systemPicksFund.updatePositionPrice(positionId, price);
    }
  }
}

/**
 * Close position based on exit signal
 */
export async function closePositionByExitSignal(
  tokenMint: string,
  exitPrice: number,
  reason: "take_profit" | "stop_loss" | "trailing_stop" | "cascade_risk" | "manual"
): Promise<void> {
  if (!currentFundSession) return;

  const positionId = tokenToPositionId.get(tokenMint);
  if (positionId) {
    systemPicksFund.closePosition(positionId, exitPrice, reason);
    tokenToPositionId.delete(tokenMint);

    // Validate whale signal if it was an exit signal
    if (reason === "cascade_risk") {
      // Note: In production, would fetch expected min price and compare
      validateWhaleSignal({} as any, exitPrice, exitPrice * 0.9);
    }
  }
}

// =====================
// MAIN SCAN LOOP
// =====================

export async function startSystemPicks(): Promise<void> {
  console.log("[SystemPicks] Initializing system-picks with fund allocation");

  // Initialize fund
  await initializeSystemPicksFund();

  // Initial scan
  setTimeout(async () => {
    try {
      await scanForPicks();
    } catch (error) {
      console.error("[SystemPicks] Initial scan failed:", error);
    }
  }, 30_000);

  // Periodic scans
  setInterval(async () => {
    try {
      await scanForPicks();
    } catch (error) {
      console.error("[SystemPicks] Scan error:", error);
    }
  }, 5 * 60 * 1000);
}

async function scanForPicks(): Promise<void> {
  if (!currentFundSession) return;

  try {
    const currentSession = systemPicksFund.getCurrentSession();
    if (!currentSession) return;

    // Check capacity (use fund metrics, not paper trades)
    if (currentSession.tradesOpen >= SYSTEM_PICKS_CONFIG.maxSimultaneousTokens) {
      console.log(
        `[SystemPicks] At capacity (${currentSession.tradesOpen}/${SYSTEM_PICKS_CONFIG.maxSimultaneousTokens} open positions)`
      );
      return;
    }

    // Get candidates with recent snapshots (within last hour)
    const candidates = await db
      .select({ tokenMint: tokenFingerprintSnapshots.tokenMint })
      .from(tokenFingerprintSnapshots)
      .where(gte(tokenFingerprintSnapshots.timestamp, Math.floor(Date.now() / 1000) - 3600))
      .orderBy(desc(tokenFingerprintSnapshots.timestamp))
      .limit(50);

    console.log(`[SystemPicks] Evaluating ${candidates.length} token candidates`);

    const picks: SystemPick[] = [];

    for (const candidate of candidates) {
      const mint = candidate.tokenMint;

      // Skip if already trading
      if (tokenToPositionId.has(mint)) {
        continue;
      }

      // Calculate signal
      const signal = await calculateSystemPickSignal(mint);
      if (!signal) continue;

      // Filter by conviction
      if (signal.clusterOutcomeSuccess < SYSTEM_PICKS_CONFIG.minBuyConviction) {
        continue;
      }

      // Validate with Jupiter
      if (!(await validateWithJupiter(mint))) {
        continue;
      }

      picks.push({
        ...signal,
        jupiterValidated: true,
      });
    }

    // Sort by exit score (lower = better buy)
    picks.sort((a, b) => a.exitScore - b.exitScore);

    console.log(`[SystemPicks] Found ${picks.length} candidate picks, opening positions...`);

    // Open positions
    for (const pick of picks) {
      if (systemPicksFund.getCurrentSession()!.tradesOpen >= SYSTEM_PICKS_CONFIG.maxSimultaneousTokens) {
        break;
      }
      await openSystemPickPosition(pick);
    }
  } catch (error) {
    console.error("[SystemPicks] Scan error:", error);
  }
}

// =====================
// HELPERS
// =====================

/**
 * Calculate trajectory score from outcome distribution
 */
function calculateTrajectoryScoreFromOutcomes(outcomes: Record<string, number>): number {
  if (!outcomes || typeof outcomes !== "object") return 0;

  const score =
    (outcomes.pump_100x || 0) * 1.0 +
    (outcomes.pump_10x || 0) * 0.5 +
    (outcomes.pump_5x || 0) * 0.3 +
    (outcomes.pump_2x_sustained || 0) * 0.2 +
    (outcomes.pump_2x_quick || 0) * 0.1 -
    ((outcomes.crash_fast || 0) + (outcomes.crash_90 || 0)) * 0.5;

  return Math.max(0, score);
}

// =====================
// API ENDPOINTS (for portfolio page)
// =====================

/**
 * Get current fund session state
 */
export function getFundSession(): FundSession | null {
  return systemPicksFund.getCurrentSession();
}

/**
 * Get fund session history
 */
export function getFundHistory(): FundSession[] {
  return systemPicksFund.getSessionHistory();
}

/**
 * Get validation gates for live trading enablement
 */
export function getValidationGates() {
  return systemPicksFund.getValidationGates();
}

/**
 * Reset fund and start new session
 */
export async function resetFund(notes?: string): Promise<FundSession | null> {
  const newSession = systemPicksFund.resetSession(notes);
  if (newSession) {
    currentFundSession = newSession;
    tokenToPositionId.clear();
    console.log(`[SystemPicks] Fund reset. New session: ${newSession.sessionId}`);
  }
  return newSession;
}
