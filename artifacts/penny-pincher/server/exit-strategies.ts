/**
 * Exit Strategy Management
 *
 * Supports two exit approaches:
 * 1. Take-Profit: Single exit at fixed multiplier (backward compat)
 * 2. Take-Initial: Scale out at multiple tiers, keep runner for larger moves
 */

export interface ExitTier {
  multiplier: number;    // Exit at this price multiplier (e.g., 2.0 = 2x entry)
  percentage: number;    // % of position to sell at this tier (0-100)
  hitRate?: number;      // Observed % of trades reaching this tier (from retrolearner)
}

export interface ExitStrategy {
  // Backward compatibility: single exit
  takeProfitMultiplier?: number;

  // New: scaled exits (take-initial)
  exitTiers?: ExitTier[];

  // Common exit parameters
  stopLossPercent: number;     // Hard SL as % of entry (e.g., 30)
  trailingStopPercent?: number; // TSL as % of highest price
  maxHoldMinutes: number;       // Force exit after N minutes

  // Metadata
  description?: string;
}

// =====================
// CLUSTER-SPECIFIC STRATEGIES
// =====================

export const CLUSTER_EXIT_STRATEGIES: Record<string, ExitStrategy> = {
  spike_and_bleed: {
    // Fast, volatile moves: capture quick gains and hold for moonshot
    exitTiers: [
      { multiplier: 2.0, percentage: 25 },   // Early take-profit
      { multiplier: 4.0, percentage: 25 },   // Second tier
      { multiplier: 5.0, percentage: 25 },   // Main target
      { multiplier: 10.0, percentage: 25 },  // Runner (keep for bigger move)
    ],
    stopLossPercent: 30,
    trailingStopPercent: 15,
    maxHoldMinutes: 60,
    description: "Scale out 25% at 2x/4x/5x, hold 25% runner with TSL for 60min",
  },

  slow_moon: {
    // Steady climbs: patient entries, longer holds
    exitTiers: [
      { multiplier: 1.5, percentage: 25 },   // Small gain
      { multiplier: 2.5, percentage: 25 },
      { multiplier: 3.0, percentage: 25 },   // Target hit
      { multiplier: 8.0, percentage: 25 },   // Runner
    ],
    stopLossPercent: 50,
    trailingStopPercent: 20,
    maxHoldMinutes: 240,
    description: "Patient scale-out 25% at 1.5x/2.5x/3x, hold 25% runner for 4hr",
  },

  late_bloomer: {
    // Very long moves: initially quiet then explosive
    exitTiers: [
      { multiplier: 3.0, percentage: 20 },   // Initial profit
      { multiplier: 5.0, percentage: 20 },
      { multiplier: 8.0, percentage: 20 },
      { multiplier: 15.0, percentage: 40 },  // Large runner
    ],
    stopLossPercent: 60,
    trailingStopPercent: 25,
    maxHoldMinutes: 360,
    description: "Conservative scale (20%/20%/20% at 3x/5x/8x), hold 40% runner for big move",
  },

  pump_dump: {
    // Quick flips: exit fast before dump
    takeProfitMultiplier: 2.0,  // Quick 2x and out
    stopLossPercent: 20,
    trailingStopPercent: 10,
    maxHoldMinutes: 15,
    description: "Quick flip: 2x exit, tight SL 20%, exit by 15min",
  },

  dead_launch: {
    // Avoid these entirely
    takeProfitMultiplier: 1.5,  // Just break even if lucky
    stopLossPercent: 15,
    trailingStopPercent: 10,
    maxHoldMinutes: 30,
    description: "Avoid - low conviction, quick SL 15%",
  },
};

// =====================
// STRATEGY UTILITIES
// =====================

/**
 * Get exit strategy for a cluster
 */
export function getExitStrategy(clusterName: string): ExitStrategy {
  return CLUSTER_EXIT_STRATEGIES[clusterName] || CLUSTER_EXIT_STRATEGIES.slow_moon;
}

/**
 * Calculate if a position should scale out at current price
 */
export function checkScaleOutTier(
  entryPrice: number,
  currentPrice: number,
  strategy: ExitStrategy,
  triggeredTiers: Set<number> = new Set()
): { tier: ExitTier; tierIndex: number } | null {
  // If using single take-profit, don't check tiers
  if (!strategy.exitTiers && strategy.takeProfitMultiplier) {
    return null;
  }

  if (!strategy.exitTiers) {
    return null;
  }

  // Find first triggered but unpaired tier
  for (let i = 0; i < strategy.exitTiers.length; i++) {
    const tier = strategy.exitTiers[i];
    if (!triggeredTiers.has(i)) {
      const targetPrice = entryPrice * tier.multiplier;
      if (currentPrice >= targetPrice) {
        return { tier, tierIndex: i };
      }
    }
  }

  return null;
}

/**
 * Calculate realized vs unrealized PnL for a position with partial exits
 */
export interface PositionPnL {
  entryPrice: number;
  entryTokens: number;
  entrySol: number;

  // Partial exits
  partialExits: Array<{
    exitPrice: number;
    tokensExited: number;
    solExited: number;
    realizedPnl: number;
  }>;

  // Remainder
  remainingTokens: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;

  // Totals
  totalTokensExited: number;
  totalRealizedPnl: number;
  totalRealizedPercent: number;
  totalUnrealizedPnl: number;
  netPnL: number;
  netPnLPercent: number;
}

export function calculatePositionPnL(
  position: {
    entryPrice: number;
    entryTokens: number;
    entrySol: number;
  },
  partialExits: Array<{
    exitPrice: number;
    tokensExited: number;
    solExited: number;
  }>,
  currentPrice: number,
  currentSolPrice: number
): PositionPnL {
  // Calculate total tokens exited
  const totalTokensExited = partialExits.reduce((sum, exit) => sum + exit.tokensExited, 0);
  const remainingTokens = position.entryTokens - totalTokensExited;

  // Calculate realized PnL from partial exits
  let totalRealizedPnl = 0;
  const realizedExits = partialExits.map((exit) => {
    const exitUsd = exit.tokensExited * exit.exitPrice;
    const entryUsd = exit.tokensExited * position.entryPrice;
    const realizedPnl = (exitUsd - entryUsd) / currentSolPrice;
    totalRealizedPnl += realizedPnl;
    return {
      ...exit,
      realizedPnl,
    };
  });

  const totalRealizedPercent = position.entrySol > 0 ? (totalRealizedPnl / position.entrySol) * 100 : 0;

  // Calculate unrealized PnL from remaining position
  const remainingUsd = remainingTokens * currentPrice;
  const entryUsd = position.entrySol * (position.entryPrice / currentSolPrice);
  const unrealizedPnl = (remainingUsd - entryUsd) / currentSolPrice;
  const unrealizedPnlPercent = entryUsd > 0 ? (unrealizedPnl / position.entrySol) * 100 : 0;

  // Total PnL
  const netPnL = totalRealizedPnl + unrealizedPnl;
  const netPnLPercent = position.entrySol > 0 ? (netPnL / position.entrySol) * 100 : 0;

  return {
    entryPrice: position.entryPrice,
    entryTokens: position.entryTokens,
    entrySol: position.entrySol,
    partialExits: realizedExits,
    remainingTokens,
    currentPrice,
    unrealizedPnl,
    unrealizedPnlPercent,
    totalTokensExited,
    totalRealizedPnl,
    totalRealizedPercent,
    totalUnrealizedPnl: unrealizedPnl,
    netPnL,
    netPnLPercent,
  };
}

/**
 * Determine exit reason based on trigger
 */
export function getExitReason(
  entryPrice: number,
  currentPrice: number,
  strategy: ExitStrategy,
  isScaleOut: boolean = false
): string {
  if (isScaleOut) {
    const multiplier = currentPrice / entryPrice;
    return `scale_out_${multiplier.toFixed(1)}x`;
  }

  if (strategy.takeProfitMultiplier && currentPrice >= entryPrice * strategy.takeProfitMultiplier) {
    return `take_profit_${strategy.takeProfitMultiplier}x`;
  }

  const priceChange = (currentPrice - entryPrice) / entryPrice;
  if (strategy.stopLossPercent && priceChange <= -strategy.stopLossPercent) {
    return `stop_loss_${(strategy.stopLossPercent * 100).toFixed(0)}%`;
  }

  return "exit_unknown";
}
