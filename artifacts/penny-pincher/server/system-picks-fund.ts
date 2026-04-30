import { db } from "./db";
import { sql } from "drizzle-orm";

/**
 * System-Picks Simulated Fund: 1 SOL Allocation Validation
 *
 * User validates system-picks profitability before enabling live trading.
 * Fund sessions track P&L, support iteration, and enable parameter tuning.
 *
 * User Flow:
 * 1. Allocate 1 SOL to simulation
 * 2. Watch real-time P&L tracking over hours/days
 * 3. If profitable (>30% gain), enable live trading
 * 4. If unprofitable, adjust parameters, reset fund, re-run
 *
 * Sessions:
 * - Each reset archives previous session
 * - Portfolio page shows current + historical sessions
 * - User can compare parameter tweaks across sessions
 */

export interface FundSession {
  sessionId: string;
  status: "active" | "paused" | "archived";
  startTime: number;
  endTime?: number;

  // Fund metrics
  initialBalance: number; // Always 1.0 SOL
  currentBalance: number;
  totalAllocated: number; // SOL deployed in positions

  // P&L tracking
  realizedPnl: number; // Closed positions
  unrealizedPnl: number; // Open positions
  totalPnl: number; // Realized + unrealized

  // Trade metrics
  tradesClosed: number;
  tradesOpen: number;
  winRate: number; // %
  avgWin: number; // SOL
  avgLoss: number; // SOL
  profitFactor: number; // Total wins / Total losses

  // Parameters used in this session
  parameters: {
    minClusterConfidence: number; // 0-1
    whaleWeightUsed: number; // 0.05 initially
    minBuyConviction: number;
    defaultTakeProfitMultiplier: number;
    defaultStopLossPercent: number;
    defaultTrailingStopPercent: number;
    timeOfDayRationing: boolean;
    highQualityWindow: { start: number; end: number }; // Hours (e.g., 15-21)
  };

  // Metadata
  notes?: string; // User notes on this session
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  positionId: string;
  sessionId: string;
  tokenMint: string;
  tokenSymbol: string;

  // Entry
  entryTime: number;
  entryPrice: number;
  entrySize: number; // SOL allocated

  // Exit (if closed)
  exitTime?: number;
  exitPrice?: number;
  exitReason?: "take_profit" | "stop_loss" | "trailing_stop" | "manual" | "cascade_risk";

  // Signal data
  clusterConfidence: number; // 0-1
  whaleConsensus: number; // 0-1
  exitScore: number; // Final combined score

  // P&L
  realized: number; // SOL gain/loss (if closed)
  unrealized: number; // Current P&L (if open)
  multiplier: number; // Current price / entry price

  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
}

class SystemPicksFund {
  private currentSession: FundSession | null = null;
  private sessionPositions: Map<string, Position[]> = new Map();
  private sessionHistory: FundSession[] = [];

  /**
   * Initialize a new fund session (1 SOL)
   */
  startSession(parameters: FundSession["parameters"]): FundSession {
    const sessionId = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = Math.floor(Date.now() / 1000);

    this.currentSession = {
      sessionId,
      status: "active",
      startTime: now,

      initialBalance: 1.0,
      currentBalance: 1.0,
      totalAllocated: 0,

      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,

      tradesClosed: 0,
      tradesOpen: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 1.0,

      parameters,
      createdAt: now,
      updatedAt: now,
    };

    this.sessionPositions.set(sessionId, []);
    return this.currentSession;
  }

  /**
   * Open a position in current session
   *
   * Dynamic allocation:
   *   allocation = (fund_balance / tokens_expected_today) * confidence_multiplier
   *
   * Confidence-based override:
   *   if (cluster_confidence > 90% AND whale_consensus > 75%): allocation *= 1.5
   *   elif (cluster_confidence < 60% OR low_quality_window): allocation *= 0.3
   */
  openPosition(
    tokenMint: string,
    tokenSymbol: string,
    clusterConfidence: number,
    whaleConsensus: number,
    exitScore: number,
    entryPrice: number,
    tokensExpectedToday: number = 50
  ): Position | null {
    if (!this.currentSession) {
      console.error("[SystemPicksFund] No active session");
      return null;
    }

    const baseAllocation = this.currentSession.currentBalance / tokensExpectedToday;
    let allocation = baseAllocation;

    // Confidence-based sizing (Algorithm in plan)
    if (clusterConfidence > 0.9 && whaleConsensus > 0.75) {
      allocation *= 1.5; // Concentrate on high-conviction
    } else if (clusterConfidence < 0.6 || isLowQualityWindow()) {
      allocation *= 0.3; // Conservative in low-quality window
    }

    // Constrain: max 30% of fund per position
    allocation = Math.min(allocation, this.currentSession.currentBalance * 0.3);

    // Protect minimum reserve (20% of fund)
    if (this.currentSession.currentBalance - allocation < this.currentSession.initialBalance * 0.2) {
      allocation = Math.max(0, this.currentSession.currentBalance - this.currentSession.initialBalance * 0.2);
    }

    if (allocation <= 0) {
      return null;
    }

    const positionId = `${this.currentSession.sessionId}-${tokenMint}-${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);

    const position: Position = {
      positionId,
      sessionId: this.currentSession.sessionId,
      tokenMint,
      tokenSymbol,

      entryTime: now,
      entryPrice,
      entrySize: allocation,

      clusterConfidence,
      whaleConsensus,
      exitScore,

      realized: 0,
      unrealized: 0,
      multiplier: 1.0,

      status: "open",
      createdAt: now,
      updatedAt: now,
    };

    // Update fund state
    this.currentSession.currentBalance -= allocation;
    this.currentSession.totalAllocated += allocation;
    this.currentSession.tradesOpen++;
    this.currentSession.updatedAt = now;

    // Track position
    if (!this.sessionPositions.has(this.currentSession.sessionId)) {
      this.sessionPositions.set(this.currentSession.sessionId, []);
    }
    this.sessionPositions.get(this.currentSession.sessionId)!.push(position);

    return position;
  }

  /**
   * Update position P&L (called periodically as price updates)
   */
  updatePositionPrice(positionId: string, currentPrice: number): void {
    if (!this.currentSession) return;

    const positions = this.sessionPositions.get(this.currentSession.sessionId) || [];
    const position = positions.find((p) => p.positionId === positionId);

    if (!position || position.status === "closed") return;

    const multiplier = currentPrice / position.entryPrice;
    const unrealizedValue = position.entrySize * multiplier;
    position.unrealized = unrealizedValue - position.entrySize;
    position.multiplier = multiplier;
    position.updatedAt = Math.floor(Date.now() / 1000);

    // Recalculate session metrics
    this.updateSessionMetrics();
  }

  /**
   * Close position (take profit, stop loss, manual exit, etc.)
   */
  closePosition(
    positionId: string,
    exitPrice: number,
    exitReason: Position["exitReason"] = "manual"
  ): void {
    if (!this.currentSession) return;

    const positions = this.sessionPositions.get(this.currentSession.sessionId) || [];
    const position = positions.find((p) => p.positionId === positionId);

    if (!position || position.status === "closed") return;

    const now = Math.floor(Date.now() / 1000);
    position.exitTime = now;
    position.exitPrice = exitPrice;
    position.exitReason = exitReason;
    position.status = "closed";

    // Calculate realized P&L
    const multiplier = exitPrice / position.entryPrice;
    const realizedValue = position.entrySize * multiplier;
    position.realized = realizedValue - position.entrySize;

    // Update fund state
    this.currentSession.currentBalance += realizedValue;
    this.currentSession.totalAllocated -= position.entrySize;
    this.currentSession.realizedPnl += position.realized;
    this.currentSession.tradesOpen--;
    this.currentSession.tradesClosed++;

    // Track win/loss for metrics
    if (position.realized > 0) {
      const totalWins = position.realized; // Simplified
      const existingAvgWin = this.currentSession.avgWin || 0;
      this.currentSession.avgWin =
        (existingAvgWin * (this.currentSession.tradesClosed - 1) + position.realized) /
        this.currentSession.tradesClosed;
    } else {
      const totalLosses = Math.abs(position.realized);
      const existingAvgLoss = this.currentSession.avgLoss || 0;
      this.currentSession.avgLoss =
        (existingAvgLoss * (this.currentSession.tradesClosed - 1) + totalLosses) /
        this.currentSession.tradesClosed;
    }

    this.currentSession.updatedAt = now;
    this.updateSessionMetrics();
  }

  /**
   * Recalculate session metrics (win rate, profit factor, etc.)
   */
  private updateSessionMetrics(): void {
    if (!this.currentSession) return;

    const positions = this.sessionPositions.get(this.currentSession.sessionId) || [];

    let unrealizedSum = 0;
    let closedWins = 0;
    let closedLosses = 0;

    for (const pos of positions) {
      if (pos.status === "open") {
        unrealizedSum += pos.unrealized;
      } else {
        if (pos.realized > 0) {
          closedWins += pos.realized;
        } else {
          closedLosses += Math.abs(pos.realized);
        }
      }
    }

    this.currentSession.unrealizedPnl = unrealizedSum;
    this.currentSession.totalPnl = this.currentSession.realizedPnl + unrealizedSum;

    if (this.currentSession.tradesClosed > 0) {
      const closed = positions.filter((p) => p.status === "closed");
      const wins = closed.filter((p) => p.realized > 0).length;
      this.currentSession.winRate = (wins / this.currentSession.tradesClosed) * 100;
    }

    if (closedLosses > 0) {
      this.currentSession.profitFactor = closedWins / closedLosses;
    }
  }

  /**
   * Pause fund (no new positions, existing stay open)
   */
  pauseSession(): void {
    if (this.currentSession) {
      this.currentSession.status = "paused";
      this.currentSession.updatedAt = Math.floor(Date.now() / 1000);
    }
  }

  /**
   * Reset fund: archive current session, start fresh
   */
  resetSession(notes?: string): FundSession | null {
    if (!this.currentSession) {
      console.error("[SystemPicksFund] No active session to reset");
      return null;
    }

    // Archive current session
    const endTime = Math.floor(Date.now() / 1000);
    this.currentSession.endTime = endTime;
    this.currentSession.status = "archived";
    if (notes) {
      this.currentSession.notes = notes;
    }

    this.sessionHistory.push(this.currentSession);

    // Start fresh session
    const newSession = this.startSession(this.currentSession.parameters);
    return newSession;
  }

  /**
   * Get current session state
   */
  getCurrentSession(): FundSession | null {
    return this.currentSession ? { ...this.currentSession } : null;
  }

  /**
   * Get session history (archived sessions)
   */
  getSessionHistory(): FundSession[] {
    return [...this.sessionHistory];
  }

  /**
   * Get all positions for current session
   */
  getPositions(): Position[] {
    if (!this.currentSession) return [];
    return [...(this.sessionPositions.get(this.currentSession.sessionId) || [])];
  }

  /**
   * Get validation gates (can user enable live trading?)
   */
  getValidationGates(): {
    minimumsMet: boolean;
    conservativeThresholdMet: boolean;
    reasons: string[];
  } {
    if (!this.currentSession) {
      return {
        minimumsMet: false,
        conservativeThresholdMet: false,
        reasons: ["No active session"],
      };
    }

    const reasons: string[] = [];
    const runningTimeMinutes = (Date.now() / 1000 - this.currentSession.startTime) / 60;

    // Minimum requirements
    const minimumsMet =
      runningTimeMinutes >= 720 && // 12 hours
      this.currentSession.tradesClosed >= 10 &&
      this.currentSession.winRate >= 50 &&
      this.currentSession.profitFactor >= 1.2 &&
      this.currentSession.currentBalance >= 0.8; // At least break-even

    if (runningTimeMinutes < 720) {
      reasons.push(`Running time: ${Math.round(runningTimeMinutes)}min < 720min (12h)`);
    }
    if (this.currentSession.tradesClosed < 10) {
      reasons.push(`Trades closed: ${this.currentSession.tradesClosed} < 10`);
    }
    if (this.currentSession.winRate < 50) {
      reasons.push(`Win rate: ${this.currentSession.winRate.toFixed(1)}% < 50%`);
    }
    if (this.currentSession.profitFactor < 1.2) {
      reasons.push(`Profit factor: ${this.currentSession.profitFactor.toFixed(2)} < 1.2`);
    }
    if (this.currentSession.currentBalance < 0.8) {
      reasons.push(`Fund balance: ${this.currentSession.currentBalance.toFixed(2)} SOL < 0.8 SOL`);
    }

    // Conservative thresholds (stricter, recommended)
    const conservativeThresholdMet =
      runningTimeMinutes >= 2880 && // 48 hours
      this.currentSession.tradesClosed >= 50 &&
      this.currentSession.winRate >= 65 &&
      this.currentSession.profitFactor >= 1.5 &&
      this.currentSession.currentBalance >= 1.3; // 30%+ gain

    return {
      minimumsMet,
      conservativeThresholdMet,
      reasons: reasons.length > 0 ? reasons : ["All requirements met"],
    };
  }
}

/**
 * Helper: Check if current hour is in low-quality window
 * Default: 9pm-3am (21:00-03:00) is low quality
 */
function isLowQualityWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 21 || hour < 3;
}

// Singleton instance
export const systemPicksFund = new SystemPicksFund();

// FundSession and Position are already exported as export interface above
