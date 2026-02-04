import { db } from "./db";
import { 
  paperPositions, walletStrategies, strategyExperiments,
  PaperPosition, WalletStrategy, StrategyExperiment,
  InsertPaperPosition, InsertWalletStrategy, InsertStrategyExperiment
} from "@shared/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";
import { fetchTokenWithFallback } from "./data-pool";

// =====================
// PAPER POSITION MANAGEMENT
// =====================

async function getSolPriceUsd(): Promise<number> {
  const solMint = "So11111111111111111111111111111111111111112";
  const solData = await fetchTokenWithFallback(solMint);
  return solData.priceUsd || 150; // fallback to ~$150
}

export async function openPaperPosition(params: {
  userId: number;
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  entrySol: number;
  signalWallet?: string;
  strategyId?: number;
  experimentId?: number;
  takeProfitMultiplier?: number;
  stopLossPercent?: number; // as fraction 0.0-1.0 (0.2 = 20%)
  trailingStop?: boolean;
  entryTxSignature?: string;
}): Promise<PaperPosition> {
  const now = Math.floor(Date.now() / 1000);
  
  const tokenData = await fetchTokenWithFallback(params.tokenMint);
  const tokenPriceUsd = tokenData.priceUsd || 0;
  
  if (tokenPriceUsd <= 0) {
    throw new Error(`Cannot open paper position: no price data for ${params.tokenMint}`);
  }
  
  const solPriceUsd = await getSolPriceUsd();
  const entryUsd = params.entrySol * solPriceUsd;
  const entryTokens = entryUsd / tokenPriceUsd;
  
  // Normalize stopLossPercent: if > 1, assume it was passed as percent (e.g., 20) and convert to fraction (0.2)
  let normalizedStopLoss = params.stopLossPercent;
  if (normalizedStopLoss && normalizedStopLoss > 1) {
    normalizedStopLoss = normalizedStopLoss / 100;
  }
  
  const [position] = await db.insert(paperPositions).values({
    userId: params.userId,
    tokenMint: params.tokenMint,
    tokenSymbol: params.tokenSymbol || tokenData.tokenSymbol,
    tokenName: params.tokenName || tokenData.tokenName,
    entryPrice: tokenPriceUsd,
    entrySol: params.entrySol,
    entryTokens,
    entryTimestamp: now,
    entryTxSignature: params.entryTxSignature,
    signalWallet: params.signalWallet,
    strategyId: params.strategyId,
    experimentId: params.experimentId,
    takeProfitMultiplier: params.takeProfitMultiplier,
    stopLossPercent: normalizedStopLoss,
    trailingStop: params.trailingStop,
    highestPrice: tokenPriceUsd,
    lowestPrice: tokenPriceUsd,
    status: "open",
    createdAt: now,
  }).returning();
  
  console.log(`[PaperTrading] Opened position ${position.id}: ${params.entrySol} SOL ($${entryUsd.toFixed(2)}) -> ${entryTokens.toFixed(4)} ${params.tokenSymbol || params.tokenMint.slice(0, 8)}`);
  
  return position;
}

async function closePositionInternal(
  positionId: number,
  exitReason: string,
  experimentId?: number | null,
  exitTxSignature?: string
): Promise<PaperPosition | null> {
  const now = Math.floor(Date.now() / 1000);
  
  const [position] = await db.select().from(paperPositions).where(eq(paperPositions.id, positionId));
  if (!position || position.status !== "open") {
    return null;
  }
  
  const tokenData = await fetchTokenWithFallback(position.tokenMint);
  const exitPriceUsd = tokenData.priceUsd || position.entryPrice;
  const solPriceUsd = await getSolPriceUsd();
  
  const exitUsd = position.entryTokens * exitPriceUsd;
  const exitSol = exitUsd / solPriceUsd;
  const realizedPnl = exitSol - position.entrySol;
  const realizedPnlPercent = (realizedPnl / position.entrySol) * 100;
  
  const [updated] = await db.update(paperPositions)
    .set({
      exitPrice: exitPriceUsd,
      exitSol,
      exitTimestamp: now,
      exitTxSignature,
      exitReason,
      realizedPnl,
      realizedPnlPercent,
      status: "closed",
      updatedAt: now,
    })
    .where(eq(paperPositions.id, positionId))
    .returning();
  
  console.log(`[PaperTrading] Closed position ${positionId}: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)} SOL (${realizedPnlPercent.toFixed(2)}%)`);
  
  if (experimentId) {
    await updateExperimentResults(experimentId, realizedPnl, realizedPnl >= 0);
  }
  
  return updated;
}

export async function closePaperPosition(
  positionId: number,
  exitReason: string,
  userId: number, // always require ownership for API calls
  exitTxSignature?: string
): Promise<PaperPosition | null> {
  const [position] = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.id, positionId),
      eq(paperPositions.userId, userId)
    ));
  
  if (!position || position.status !== "open") {
    return null;
  }
  
  return closePositionInternal(positionId, exitReason, position.experimentId, exitTxSignature);
}

export async function getOpenPositions(userId: number): Promise<PaperPosition[]> {
  return db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.userId, userId),
      eq(paperPositions.status, "open")
    ))
    .orderBy(desc(paperPositions.entryTimestamp));
}

export async function getPositionHistory(userId: number, limit: number = 50): Promise<PaperPosition[]> {
  return db.select().from(paperPositions)
    .where(eq(paperPositions.userId, userId))
    .orderBy(desc(paperPositions.createdAt))
    .limit(limit);
}

export async function updatePositionPriceTracking(positionId: number, currentPrice: number): Promise<void> {
  const [position] = await db.select().from(paperPositions).where(eq(paperPositions.id, positionId));
  if (!position || position.status !== "open") return;
  
  const updates: Partial<PaperPosition> = { updatedAt: Math.floor(Date.now() / 1000) };
  
  if (currentPrice > (position.highestPrice || 0)) {
    updates.highestPrice = currentPrice;
  }
  if (currentPrice < (position.lowestPrice || Infinity)) {
    updates.lowestPrice = currentPrice;
  }
  
  await db.update(paperPositions).set(updates).where(eq(paperPositions.id, positionId));
}

// =====================
// POSITION MONITORING (for webhooks)
// =====================

function normalizeStopLoss(value: number | null | undefined): number {
  if (!value) return 0;
  return value > 1 ? value / 100 : value;
}

export async function checkPositionExits(): Promise<{ closed: number; checked: number }> {
  const openPositions = await db.select().from(paperPositions)
    .where(eq(paperPositions.status, "open"));
  
  let closed = 0;
  
  for (const position of openPositions) {
    const tokenData = await fetchTokenWithFallback(position.tokenMint);
    if (!tokenData.priceUsd) continue;
    
    const currentPrice = tokenData.priceUsd;
    await updatePositionPriceTracking(position.id, currentPrice);
    
    const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
    const stopLoss = normalizeStopLoss(position.stopLossPercent);
    
    if (position.takeProfitMultiplier && currentPrice >= position.entryPrice * position.takeProfitMultiplier) {
      await closePositionInternal(position.id, "take_profit", position.experimentId);
      closed++;
      continue;
    }
    
    if (stopLoss > 0 && priceChange <= -stopLoss) {
      await closePositionInternal(position.id, "stop_loss", position.experimentId);
      closed++;
      continue;
    }
    
    if (position.trailingStop && position.highestPrice && currentPrice > position.entryPrice) {
      const trailingThreshold = stopLoss || 0.2;
      const dropFromHigh = (position.highestPrice - currentPrice) / position.highestPrice;
      if (dropFromHigh >= trailingThreshold) {
        await closePositionInternal(position.id, "trailing_stop", position.experimentId);
        closed++;
      }
    }
  }
  
  return { closed, checked: openPositions.length };
}

export async function handleMirrorSell(
  signalWallet: string,
  tokenMint: string,
  userId: number, // enforce user scope
  txSignature: string
): Promise<number> {
  const openPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.userId, userId),
      eq(paperPositions.signalWallet, signalWallet),
      eq(paperPositions.tokenMint, tokenMint),
      eq(paperPositions.status, "open")
    ));
  
  let closedCount = 0;
  for (const position of openPositions) {
    await closePaperPosition(position.id, "mirror_sell", userId, txSignature);
    closedCount++;
  }
  
  return closedCount;
}

// =====================
// WALLET STRATEGY LEARNING
// =====================

export async function getOrCreateWalletStrategy(
  walletAddress: string,
  userId: number
): Promise<WalletStrategy> {
  const [existing] = await db.select().from(walletStrategies)
    .where(and(
      eq(walletStrategies.walletAddress, walletAddress),
      eq(walletStrategies.userId, userId)
    ));
  
  if (existing) return existing;
  
  const now = Math.floor(Date.now() / 1000);
  const [created] = await db.insert(walletStrategies).values({
    walletAddress,
    userId,
    createdAt: now,
  }).returning();
  
  return created;
}

export async function updateWalletStrategy(
  strategyId: number,
  updates: Partial<WalletStrategy>
): Promise<WalletStrategy | null> {
  const [updated] = await db.update(walletStrategies)
    .set({
      ...updates,
      lastUpdatedAt: Math.floor(Date.now() / 1000),
      version: sql`${walletStrategies.version} + 1`,
    })
    .where(eq(walletStrategies.id, strategyId))
    .returning();
  
  return updated || null;
}

export async function getWalletStrategy(
  walletAddress: string,
  userId: number
): Promise<WalletStrategy | null> {
  const [strategy] = await db.select().from(walletStrategies)
    .where(and(
      eq(walletStrategies.walletAddress, walletAddress),
      eq(walletStrategies.userId, userId)
    ));
  return strategy || null;
}

// =====================
// STRATEGY EXPERIMENTS
// =====================

export async function createExperiment(params: {
  userId: number;
  name: string;
  description?: string;
  signalWallet?: string;
  strategyId?: number;
  controlConfig: object;
  variantConfig: object;
  paperBudgetSol: number;
  durationDays?: number;
}): Promise<StrategyExperiment> {
  const now = Math.floor(Date.now() / 1000);
  const endsAt = params.durationDays ? now + (params.durationDays * 86400) : undefined;
  
  const [experiment] = await db.insert(strategyExperiments).values({
    userId: params.userId,
    name: params.name,
    description: params.description,
    signalWallet: params.signalWallet,
    strategyId: params.strategyId,
    controlConfig: JSON.stringify(params.controlConfig),
    variantConfig: JSON.stringify(params.variantConfig),
    paperBudgetSol: params.paperBudgetSol,
    startedAt: now,
    endsAt,
    status: "active",
    createdAt: now,
  }).returning();
  
  console.log(`[PaperTrading] Created experiment ${experiment.id}: ${params.name}`);
  return experiment;
}

export async function getActiveExperiments(userId: number): Promise<StrategyExperiment[]> {
  return db.select().from(strategyExperiments)
    .where(and(
      eq(strategyExperiments.userId, userId),
      eq(strategyExperiments.status, "active")
    ));
}

export async function updateExperimentResults(
  experimentId: number,
  pnl: number,
  isWin: boolean,
  isVariant: boolean = false
): Promise<void> {
  const [experiment] = await db.select().from(strategyExperiments)
    .where(eq(strategyExperiments.id, experimentId));
  
  if (!experiment) return;
  
  const trades = isVariant 
    ? (experiment.tradesVariant || 0) + 1
    : (experiment.tradesControl || 0) + 1;
  const totalPnl = isVariant
    ? (experiment.pnlVariant || 0) + pnl
    : (experiment.pnlControl || 0) + pnl;
  
  // Track wins to compute win rate
  // We estimate wins from positive pnl trades
  const prevWins = isVariant
    ? Math.round((experiment.winRateVariant || 0) * (experiment.tradesVariant || 0))
    : Math.round((experiment.winRateControl || 0) * (experiment.tradesControl || 0));
  const newWins = prevWins + (isWin ? 1 : 0);
  const winRate = trades > 0 ? newWins / trades : 0;
  
  if (isVariant) {
    await db.update(strategyExperiments)
      .set({
        tradesVariant: trades,
        pnlVariant: totalPnl,
        winRateVariant: winRate,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(strategyExperiments.id, experimentId));
  } else {
    await db.update(strategyExperiments)
      .set({
        tradesControl: trades,
        pnlControl: totalPnl,
        winRateControl: winRate,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(strategyExperiments.id, experimentId));
  }
}

export async function completeExperiment(experimentId: number, userId: number): Promise<StrategyExperiment | null> {
  const [experiment] = await db.select().from(strategyExperiments)
    .where(and(
      eq(strategyExperiments.id, experimentId),
      eq(strategyExperiments.userId, userId)
    ));
  
  if (!experiment) return null;
  
  // Determine winner with 10% significance threshold
  let winner: string = "inconclusive";
  if ((experiment.pnlControl || 0) > (experiment.pnlVariant || 0) * 1.1) {
    winner = "control";
  } else if ((experiment.pnlVariant || 0) > (experiment.pnlControl || 0) * 1.1) {
    winner = "variant";
  }
  
  const [updated] = await db.update(strategyExperiments)
    .set({
      status: "completed",
      winner,
      endedAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(strategyExperiments.id, experimentId))
    .returning();
  
  return updated || null;
}

// =====================
// SUMMARY STATS
// =====================

export async function getPaperTradingStats(userId: number): Promise<{
  openPositions: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnlPercent: number;
}> {
  const positions = await db.select().from(paperPositions)
    .where(eq(paperPositions.userId, userId));
  
  const open = positions.filter(p => p.status === "open");
  const closed = positions.filter(p => p.status === "closed");
  
  const wins = closed.filter(p => (p.realizedPnl || 0) > 0);
  const losses = closed.filter(p => (p.realizedPnl || 0) <= 0);
  
  const totalPnl = closed.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const avgPnlPercent = closed.length > 0
    ? closed.reduce((sum, p) => sum + (p.realizedPnlPercent || 0), 0) / closed.length
    : 0;
  
  return {
    openPositions: open.length,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnl,
    avgPnlPercent,
  };
}
