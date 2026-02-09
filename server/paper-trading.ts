import { db } from "./db";
import { 
  paperPositions, walletStrategies, strategyExperiments, swaps, systemInsights,
  PaperPosition, WalletStrategy, StrategyExperiment,
  InsertPaperPosition, InsertWalletStrategy, InsertStrategyExperiment
} from "@shared/schema";
import { eq, and, desc, sql, gte, lte, count, or, like } from "drizzle-orm";
import { fetchTokenWithFallback } from "./data-pool";
import OpenAI from "openai";
import { classifyWalletBehavior, type WalletBehaviorType } from "./cluster-detection";

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
  
  if (updated) {
    try {
      const { recordPaperTradeOutcome } = await import("./paper-experiments");
      await recordPaperTradeOutcome(updated);
    } catch (err) {
      console.error("[PaperTrading] Failed to record paper trade outcome:", err);
    }
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

export async function getOpenPositions(userId: number): Promise<(PaperPosition & { currentPrice?: number; unrealizedPnl?: number; unrealizedPnlPercent?: number })[]> {
  const positions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.userId, userId),
      eq(paperPositions.status, "open")
    ))
    .orderBy(desc(paperPositions.entryTimestamp));
  
  const enriched = await Promise.all(positions.map(async (pos) => {
    try {
      const tokenData = await fetchTokenWithFallback(pos.tokenMint);
      const currentPrice = tokenData.priceUsd || pos.entryPrice;
      const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const solPrice = await getSolPriceUsd();
      const currentValueUsd = pos.entryTokens * currentPrice;
      const entryValueUsd = pos.entrySol * solPrice;
      const unrealizedPnl = (currentValueUsd - (pos.entrySol * solPrice)) / solPrice;
      return { ...pos, currentPrice, unrealizedPnl, unrealizedPnlPercent: pnlPercent };
    } catch {
      return { ...pos, currentPrice: pos.entryPrice, unrealizedPnl: 0, unrealizedPnlPercent: 0 };
    }
  }));
  
  return enriched;
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
  const checkedMints = new Map<string, { priceUsd: number; liquidity: number | undefined; volume24h: number | undefined }>();
  
  for (const position of openPositions) {
    let tokenInfo = checkedMints.get(position.tokenMint);
    if (!tokenInfo) {
      const tokenData = await fetchTokenWithFallback(position.tokenMint);
      tokenInfo = {
        priceUsd: tokenData.priceUsd || 0,
        liquidity: tokenData.liquidity,
        volume24h: tokenData.volume24h,
      };
      checkedMints.set(position.tokenMint, tokenInfo);
    }

    if (!tokenInfo.priceUsd) continue;
    
    const currentPrice = tokenInfo.priceUsd;
    await updatePositionPriceTracking(position.id, currentPrice);
    
    const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
    const stopLoss = normalizeStopLoss(position.stopLossPercent);

    if (position.paperTradeType === "discovery") {
      const liq = tokenInfo.liquidity;
      if (liq !== undefined && liq !== null && liq <= 0) {
        await closePositionInternal(position.id, "dead_token", position.experimentId);
        closed++;
        continue;
      }
      if (currentPrice < 0.0000000001) {
        await closePositionInternal(position.id, "dead_token", position.experimentId);
        closed++;
        continue;
      }

      const vol = tokenInfo.volume24h;
      if (vol !== undefined && vol !== null && priceChange > 0.5 && vol < 500) {
        await closePositionInternal(position.id, "volume_death", position.experimentId);
        closed++;
        continue;
      }
    }
    
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
    
    if (position.trailingStop && position.highestPrice) {
      const trailingPercent = position.trailingStopPercent || stopLoss || 0.25;
      const dropFromHigh = (position.highestPrice - currentPrice) / position.highestPrice;
      if (dropFromHigh >= trailingPercent && currentPrice > position.entryPrice) {
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

const POSITION_CHECK_INTERVAL_MS = 2 * 60 * 1000;

export function startPositionMonitorJob(): void {
  console.log("[PaperTrading] Starting position monitor job (every 2 minutes)");

  setTimeout(async () => {
    try {
      const result = await checkPositionExits();
      if (result.closed > 0) {
        console.log(`[PaperTrading] Auto-close check: ${result.closed}/${result.checked} positions closed`);
      }
    } catch (err) {
      console.error("[PaperTrading] Initial position check failed:", err);
    }
  }, 30_000);

  setInterval(async () => {
    try {
      const result = await checkPositionExits();
      if (result.closed > 0) {
        console.log(`[PaperTrading] Auto-close check: ${result.closed}/${result.checked} positions closed`);
      }
    } catch (err) {
      console.error("[PaperTrading] Position check failed:", err);
    }
  }, POSITION_CHECK_INTERVAL_MS);
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

// =====================
// WALLET STRATEGY ANALYSIS
// =====================

const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface AiRecommendation {
  category: "strength" | "weakness" | "copy_setting" | "risk_warning" | "optimization" | "summary";
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
}

export interface DiscoveryContext {
  behaviorType: WalletBehaviorType;
  behaviorConfidence: number;
  followsLeaders: string[];
  leadsFollowers: string[];
  recentInsights: Array<{
    title: string;
    type: string;
    source: string;
    confidence: number;
  }>;
}

export interface StrategyAnalysis {
  strategyType: string;
  tradingStyle: string;
  avgHoldDuration: number;
  avgPositionSize: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  preferredEntryTime: string;
  entryTokenAge: string;
  entryMarketCap: string;
  takeProfitMultiplier: number;
  stopLossPercent: number;
  observedWorstDrawdown: number;
  stopLossEverHit: boolean;
  riskLevel: number;
  maxConcurrentPositions: number;
  confidenceScore: number;
  sampleSize: number;
  insights: string[];
  aiRecommendations?: AiRecommendation[];
  discoveryContext?: DiscoveryContext;
  swapCountAtAnalysis?: number;
}

export async function fetchDiscoveryContext(walletAddress: string): Promise<DiscoveryContext | null> {
  try {
    // Get wallet behavior classification
    const behavior = await classifyWalletBehavior(walletAddress, 14);
    
    // Query recent system insights related to this wallet
    const now = Math.floor(Date.now() / 1000);
    const insightCutoff = now - 7 * 86400; // 7 days
    
    const relevantInsights = await db.select().from(systemInsights)
      .where(and(
        gte(systemInsights.createdAt, insightCutoff),
        or(
          like(systemInsights.title, `%${walletAddress.slice(0, 12)}%`),
          sql`${systemInsights.payload}::text LIKE ${'%' + walletAddress.slice(0, 12) + '%'}`
        )
      ))
      .orderBy(desc(systemInsights.confidence))
      .limit(10);
    
    return {
      behaviorType: behavior.behaviorType,
      behaviorConfidence: behavior.confidence,
      followsLeaders: behavior.signals.followsLeaders || [],
      leadsFollowers: behavior.signals.leadsFollowers || [],
      recentInsights: relevantInsights.map(i => ({
        title: i.title,
        type: i.insightType,
        source: i.sourceSystem,
        confidence: i.confidence ?? 0,
      })),
    };
  } catch (error: any) {
    console.error("[Discovery Context] Error fetching:", error.message);
    return null;
  }
}

export async function generateAiRecommendations(
  walletAddress: string,
  analysis: Omit<StrategyAnalysis, 'aiRecommendations'>,
  userNotes?: string | null
): Promise<AiRecommendation[]> {
  try {
    const openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy-key",
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
    });
    
    // Build discovery context section if available
    let discoverySection = "";
    if (analysis.discoveryContext) {
      const dc = analysis.discoveryContext;
      discoverySection = `
DISCOVERY INSIGHTS:
- Behavior Classification: ${dc.behaviorType} (${(dc.behaviorConfidence * 100).toFixed(0)}% confidence)
${dc.followsLeaders.length > 0 ? `- Follows Leaders: ${dc.followsLeaders.slice(0, 3).map(w => w.slice(0, 8) + '...').join(', ')}` : ''}
${dc.leadsFollowers.length > 0 ? `- Has Followers: ${dc.leadsFollowers.slice(0, 3).map(w => w.slice(0, 8) + '...').join(', ')} (${dc.leadsFollowers.length} total)` : ''}
${dc.recentInsights.length > 0 ? `- Recent System Insights:\n${dc.recentInsights.slice(0, 5).map(i => `  * [${i.type}] ${i.title}`).join('\n')}` : ''}
`;
    }
    
    // Build user notes section if available
    let userNotesSection = "";
    if (userNotes && userNotes.trim()) {
      userNotesSection = `
USER-PROVIDED CONTEXT (treat with healthy skepticism - verify against on-chain data):
"${userNotes.trim()}"
Note: The user may have knowledge about this wallet that on-chain data can't reveal (e.g., community reputation, paid groups). Consider this context but always prioritize the actual trading metrics above.
`;
    }
    
    // Build stop-loss context with observed vs configured distinction
    const hasLosses = analysis.observedWorstDrawdown > 0;
    const stopLossContext = hasLosses
      ? `- Median Loss: ${(analysis.stopLossPercent * 100).toFixed(0)}% (observed from losing trades)
- Worst Single Loss: ${(analysis.observedWorstDrawdown * 100).toFixed(0)}%
- Stop-Loss Pattern: ${analysis.stopLossEverHit ? "Has hit significant drawdowns" : "Losses stayed moderate"}`
      : `- Losses: No losing trades observed in sample (${analysis.sampleSize} trades)
- Stop Loss: No loss data available - the displayed value is a default, not observed behavior`;
    
    // Format hold duration in human-readable terms
    const holdDurationText = analysis.avgHoldDuration < 3600
      ? `${Math.round(analysis.avgHoldDuration / 60)} minutes`
      : analysis.avgHoldDuration < 86400
        ? `${(analysis.avgHoldDuration / 3600).toFixed(1)} hours`
        : `${(analysis.avgHoldDuration / 86400).toFixed(1)} days`;
    
    const prompt = `You are Miss Pincher, a savvy and friendly Solana trading AI. Analyze this signal wallet and give actionable, opinionated recommendations for copy trading it.

WALLET: ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}

TRADING METRICS:
- Strategy Type: ${analysis.strategyType}
- Trading Style: ${analysis.tradingStyle}
- Win Rate: ${(analysis.winRate * 100).toFixed(1)}% (${analysis.sampleSize} closed trades)
- Profit Factor: ${analysis.profitFactor >= 999 ? "Infinite (no losses)" : analysis.profitFactor.toFixed(2) + "x"}
- Avg Hold Duration: ${holdDurationText}
- Avg Position Size: ${analysis.avgPositionSize.toFixed(2)} SOL
- Take Profit (median exit): ${((analysis.takeProfitMultiplier - 1) * 100).toFixed(0)}%
${stopLossContext}
- Risk Level: ${analysis.riskLevel}/10
- Confidence Score: ${(analysis.confidenceScore * 100).toFixed(0)}%
${discoverySection}${userNotesSection}
IMPORTANT GUIDELINES:
- If win rate is very high (>80%) with good profits, recognize this as exceptional performance even if sample size is small. Low volume + high quality = selective, disciplined trader.
- Clearly distinguish between OBSERVED metrics (from actual trades) and DEFAULT values (shown when no data exists). For example, if there are no losing trades, do NOT say "their stop loss is 20%" - say they have no observed losses.
- Consider trading frequency: if they trade rarely, mention what that means for copy trading (patience required, but each trade is high quality).
- Be specific about numbers in your recommendations.

Provide 5-7 recommendations in JSON format. Categories:
- "strength": What this wallet excels at
- "weakness": Genuine concerns or gaps
- "copy_setting": Specific copy trade settings (buy amounts, timing, thresholds)
- "risk_warning": Risks to watch for
- "optimization": How to maximize value from this wallet
- "summary": REQUIRED - Your overall opinion as a single paragraph. Should this wallet be copy traded? What type of trader would benefit most? What's the bottom line? Be direct and opinionated.

The LAST recommendation MUST be category "summary" with priority "high". This is your overall verdict.

Priority levels: "high", "medium", "low"

Respond ONLY with a JSON array:
[{"category": "...", "title": "...", "description": "...", "priority": "..."}]`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1200,
      temperature: 0.7,
    });
    
    const content = response.choices[0]?.message?.content?.trim() || "[]";
    
    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log("[AI Recommendations] No valid JSON array in response");
      return [];
    }
    
    const recommendations = JSON.parse(jsonMatch[0]) as AiRecommendation[];
    console.log(`[AI Recommendations] Generated ${recommendations.length} recommendations`);
    return recommendations;
  } catch (error: any) {
    console.error("[AI Recommendations] Error generating:", error.message);
    return [];
  }
}

export async function analyzeWalletStrategy(
  walletAddress: string,
  userId: number
): Promise<StrategyAnalysis> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 90 * 86400; // 90 days of data
  
  const walletSwaps = await db.select().from(swaps)
    .where(and(
      eq(swaps.source, walletAddress),
      gte(swaps.timestamp, cutoff)
    ))
    .orderBy(sql`${swaps.timestamp} ASC`);
  
  const buys = walletSwaps.filter(s => s.fromToken === SOL_MINT);
  const sells = walletSwaps.filter(s => s.toToken === SOL_MINT);
  
  const tokenPositions: Map<string, {
    buyTime: number;
    sellTime?: number;
    solSpent: number;
    solReceived: number;
    tokensBought: number;
    tokensSold: number;
    buyHour: number;
    tokenSymbol: string;
  }> = new Map();
  
  for (const swap of buys) {
    const token = swap.toToken;
    const hour = new Date(swap.timestamp * 1000).getHours();
    if (!tokenPositions.has(token)) {
      tokenPositions.set(token, {
        buyTime: swap.timestamp,
        solSpent: swap.fromAmount,
        solReceived: 0,
        tokensBought: swap.toAmount || 0,
        tokensSold: 0,
        buyHour: hour,
        tokenSymbol: swap.toTokenSymbol || "UNKNOWN",
      });
    } else {
      const pos = tokenPositions.get(token)!;
      pos.solSpent += swap.fromAmount;
      pos.tokensBought += swap.toAmount || 0;
    }
  }
  
  for (const swap of sells) {
    const token = swap.fromToken;
    const pos = tokenPositions.get(token);
    if (pos) {
      pos.sellTime = swap.timestamp;
      pos.solReceived += swap.toAmount;
      pos.tokensSold += swap.fromAmount || 0;
    }
  }
  
  // Only count positions as "closed" if >80% of tokens were sold
  // This filters out partial sells that would skew the analysis
  const closedPositions = Array.from(tokenPositions.values())
    .filter(p => {
      if (!p.sellTime || p.solSpent <= 0) return false;
      // If we have token amounts, require 80%+ sold to count as closed
      if (p.tokensBought > 0 && p.tokensSold > 0) {
        const soldRatio = p.tokensSold / p.tokensBought;
        return soldRatio >= 0.8;
      }
      // Fallback: if token amounts are missing but we have SOL data,
      // consider closed if solReceived >= 50% of solSpent (rough heuristic)
      // This avoids counting tiny partial sells as full closes
      if (p.solReceived > 0 && p.solSpent > 0) {
        // If they received more than they spent, likely a profitable close
        // If they received less but at least 50%, might be a close
        return p.solReceived >= p.solSpent * 0.5;
      }
      // No reliable data, skip this position
      return false;
    });
  
  const holdDurations: number[] = [];
  const positionSizes: number[] = [];
  const profitMultipliers: number[] = [];
  const lossMultipliers: number[] = [];
  const buyHours: number[] = [];
  let wins = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  
  for (const pos of closedPositions) {
    const duration = (pos.sellTime! - pos.buyTime);
    holdDurations.push(duration);
    positionSizes.push(pos.solSpent);
    buyHours.push(pos.buyHour);
    
    const multiplier = pos.solReceived / pos.solSpent;
    if (multiplier > 1) {
      wins++;
      profitMultipliers.push(multiplier);
      totalProfit += pos.solReceived - pos.solSpent;
    } else {
      lossMultipliers.push(multiplier);
      totalLoss += pos.solSpent - pos.solReceived;
    }
  }
  
  const sampleSize = closedPositions.length;
  const avgHoldDuration = sampleSize > 0 
    ? holdDurations.reduce((a, b) => a + b, 0) / sampleSize 
    : 0;
  const avgPositionSize = sampleSize > 0
    ? positionSizes.reduce((a, b) => a + b, 0) / sampleSize
    : 0;
  const winRate = sampleSize > 0 ? wins / sampleSize : 0;
  
  // Helper to get median from sorted array
  const getMedian = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  // Use median instead of mean to reduce outlier impact (e.g., 660x trades skewing average)
  const medianProfitMultiplier = getMedian(profitMultipliers);
  const avgProfit = medianProfitMultiplier > 0 ? medianProfitMultiplier - 1 : 0;
  
  const medianLossMultiplier = getMedian(lossMultipliers);
  const avgLoss = medianLossMultiplier > 0 ? 1 - medianLossMultiplier : 0;
  
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);
  
  const mostCommonHour = buyHours.length > 0
    ? buyHours.sort((a, b) => 
        buyHours.filter(h => h === a).length - buyHours.filter(h => h === b).length
      ).pop()
    : 12;
  const preferredEntryTime = mostCommonHour !== undefined 
    ? `${mostCommonHour}:00-${(mostCommonHour + 2) % 24}:00 UTC`
    : "varied";
  
  let strategyType = "balanced";
  let tradingStyle = "balanced";
  
  if (avgHoldDuration < 3600) {
    strategyType = "scalper";
    tradingStyle = "aggressive";
  } else if (avgHoldDuration < 86400) {
    strategyType = "momentum";
    tradingStyle = winRate > 0.5 ? "balanced" : "aggressive";
  } else if (avgHoldDuration < 7 * 86400) {
    strategyType = "swing";
    tradingStyle = "balanced";
  } else {
    strategyType = "holder";
    tradingStyle = "conservative";
  }
  
  // Use median for take-profit to avoid outlier inflation
  const takeProfitMultiplier = profitMultipliers.length > 0
    ? getMedian(profitMultipliers)
    : 1.5;
  
  // Derive stop-loss from actual losing trades using median, not hardcoded 20%
  const stopLossPercent = lossMultipliers.length >= 3
    ? 1 - getMedian(lossMultipliers)  // Median loss percentage
    : lossMultipliers.length > 0
      ? 1 - (lossMultipliers.reduce((a, b) => a + b, 0) / lossMultipliers.length)  // Mean if few samples
      : 0.2;  // Default only when no loss data
  
  // Observed worst drawdown: the actual worst single-position loss
  const observedWorstDrawdown = lossMultipliers.length > 0
    ? 1 - Math.min(...lossMultipliers)  // Worst loss as a percentage (e.g., 0.85 multiplier = 15% drawdown)
    : 0;
  
  // Whether the stop-loss threshold was ever actually hit (any loss >= stopLossPercent)
  const stopLossEverHit = lossMultipliers.length > 0 && lossMultipliers.some(m => (1 - m) >= stopLossPercent * 0.95);
  
  let riskLevel = 5;
  if (avgPositionSize > 1 && avgHoldDuration < 3600) riskLevel = 8;
  else if (avgPositionSize > 0.5 && avgHoldDuration < 86400) riskLevel = 6;
  else if (avgHoldDuration > 7 * 86400) riskLevel = 3;
  
  const openPositions = Array.from(tokenPositions.values())
    .filter(p => !p.sellTime).length;
  const maxConcurrent = Math.max(openPositions, Math.ceil(buys.length / 10));
  
  let confidenceScore = 0;
  
  // Base confidence from sample size
  let volumeBase = 0;
  if (sampleSize >= 50) volumeBase = 0.7;
  else if (sampleSize >= 20) volumeBase = 0.55;
  else if (sampleSize >= 10) volumeBase = 0.4;
  else if (sampleSize >= 5) volumeBase = 0.25;
  else if (sampleSize >= 3) volumeBase = 0.15;
  
  // Performance quality bonus (up to +0.3)
  // Exceptional win rates and profit factors boost confidence even with low volume
  let performanceBonus = 0;
  if (sampleSize >= 3) {
    // Win rate bonus: 80%+ win rate starts adding, scales up to 100%
    if (winRate >= 0.9) performanceBonus += 0.15;
    else if (winRate >= 0.8) performanceBonus += 0.1;
    else if (winRate >= 0.7) performanceBonus += 0.05;
    
    // Profit factor bonus: consistently profitable trading adds confidence
    if (profitFactor >= 5) performanceBonus += 0.15;
    else if (profitFactor >= 3) performanceBonus += 0.1;
    else if (profitFactor >= 2) performanceBonus += 0.05;
  }
  
  confidenceScore = Math.min(0.95, volumeBase + performanceBonus);
  
  const insights: string[] = [];
  if (winRate > 0.6) {
    insights.push(`Strong performer with ${(winRate * 100).toFixed(0)}% win rate`);
  } else if (winRate < 0.4 && sampleSize > 5) {
    insights.push(`Below average win rate - consider tighter stop losses`);
  }
  
  if (profitFactor > 2) {
    insights.push(`Excellent risk/reward ratio (${profitFactor.toFixed(1)}x)`);
  }
  
  if (avgHoldDuration < 1800 && sampleSize > 10) {
    insights.push(`Quick flipper - holds positions avg ${Math.round(avgHoldDuration / 60)} minutes`);
  } else if (avgHoldDuration > 86400) {
    insights.push(`Patient trader - holds positions avg ${Math.round(avgHoldDuration / 86400)} days`);
  }
  
  if (avgPositionSize > 0.5) {
    insights.push(`Large positions averaging ${avgPositionSize.toFixed(2)} SOL`);
  }
  
  if (openPositions > 5) {
    insights.push(`Currently holding ${openPositions} open positions`);
  }
  
  // Add percentile-based TP recommendations if we have enough profit data
  if (profitMultipliers.length >= 5) {
    const sorted = [...profitMultipliers].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    
    // Format multipliers as "Xx" (e.g., "7x")
    const format = (m: number) => m >= 10 ? `${Math.round(m)}x` : `${m.toFixed(1)}x`;
    
    if (p75 > p50 * 1.5) {
      // High variance - show percentile breakdown
      insights.push(`Take-profit tiers: 50% of wins at ${format(p50)}+, 25% hit ${format(p75)}+${p90 > p75 * 1.5 ? `, 10% reach ${format(p90)}+` : ''}`);
    } else {
      // Consistent exits - show median
      insights.push(`Consistent exit pattern: median ${format(p50)} return`);
    }
  }
  
  const entryTokenAge = avgHoldDuration < 7200 ? "fresh" : avgHoldDuration < 86400 ? "established" : "mature";
  const entryMarketCap = avgPositionSize > 1 ? "small" : avgPositionSize > 0.1 ? "micro" : "micro";
  
  const safeNumber = (val: number, fallback: number = 0): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return val;
  };

  // Fetch discovery context (behavior classification and system insights)
  const discoveryContext = await fetchDiscoveryContext(walletAddress) || undefined;
  
  // Add discovery-based insights
  if (discoveryContext) {
    if (discoveryContext.behaviorType === 'leader' && discoveryContext.behaviorConfidence > 0.6) {
      insights.push(`Market leader - other wallets follow this wallet's trades`);
    } else if (discoveryContext.behaviorType === 'follower' && discoveryContext.behaviorConfidence > 0.6) {
      insights.push(`Likely copies other wallets (follower behavior detected)`);
    } else if (discoveryContext.behaviorType === 'bot' && discoveryContext.behaviorConfidence > 0.6) {
      insights.push(`Bot-like trading patterns detected`);
    }
    
    if (discoveryContext.leadsFollowers.length > 3) {
      insights.push(`Influential: ${discoveryContext.leadsFollowers.length} wallets follow this trader`);
    }
  }

  const result: StrategyAnalysis = {
    strategyType,
    tradingStyle,
    avgHoldDuration: Math.round(safeNumber(avgHoldDuration)),
    avgPositionSize: safeNumber(avgPositionSize),
    winRate: safeNumber(winRate),
    avgProfit: safeNumber(avgProfit),
    avgLoss: safeNumber(avgLoss),
    profitFactor: safeNumber(profitFactor),
    preferredEntryTime,
    entryTokenAge,
    entryMarketCap,
    takeProfitMultiplier: safeNumber(takeProfitMultiplier, 1.5),
    stopLossPercent: safeNumber(stopLossPercent, 0.2),
    observedWorstDrawdown: safeNumber(observedWorstDrawdown, 0),
    stopLossEverHit,
    riskLevel: safeNumber(riskLevel, 5),
    maxConcurrentPositions: safeNumber(maxConcurrent, 1),
    confidenceScore: safeNumber(confidenceScore),
    sampleSize,
    insights,
    discoveryContext,
    swapCountAtAnalysis: walletSwaps.length,
  };
  
  console.log(`[StrategyAnalyze] Result for wallet analysis:`, JSON.stringify(result, null, 2));
  return result;
}

export async function saveWalletStrategy(
  walletAddress: string,
  userId: number,
  analysis: StrategyAnalysis
): Promise<WalletStrategy> {
  console.log(`[SaveStrategy] Starting save for wallet: ${walletAddress}, userId: ${userId}`);
  const now = Math.floor(Date.now() / 1000);
  
  console.log(`[SaveStrategy] Checking for existing strategy...`);
  const existing = await getWalletStrategy(walletAddress, userId);
  console.log(`[SaveStrategy] Existing strategy found: ${existing ? 'yes' : 'no'}`);
  
  if (existing) {
    try {
      console.log(`[SaveStrategy] Updating existing strategy id: ${existing.id}`);
      const [updated] = await db.update(walletStrategies)
        .set({
          strategyType: analysis.strategyType,
          tradingStyle: analysis.tradingStyle,
          avgHoldDuration: analysis.avgHoldDuration,
          avgPositionSize: analysis.avgPositionSize,
          winRate: analysis.winRate,
          avgProfit: analysis.avgProfit,
          avgLoss: analysis.avgLoss,
          profitFactor: analysis.profitFactor,
          preferredEntryTime: analysis.preferredEntryTime,
          entryTokenAge: analysis.entryTokenAge,
          entryMarketCap: analysis.entryMarketCap,
          takeProfitMultiplier: analysis.takeProfitMultiplier,
          stopLossPercent: analysis.stopLossPercent,
          riskLevel: analysis.riskLevel,
          maxConcurrentPositions: analysis.maxConcurrentPositions,
          confidenceScore: analysis.confidenceScore,
          sampleSize: analysis.sampleSize,
          aiRecommendations: analysis.aiRecommendations ? JSON.stringify(analysis.aiRecommendations) : null,
          swapCountAtAnalysis: analysis.swapCountAtAnalysis,
          behaviorType: analysis.discoveryContext?.behaviorType,
          behaviorConfidence: analysis.discoveryContext?.behaviorConfidence,
          discoveryInsights: analysis.discoveryContext ? JSON.stringify(analysis.discoveryContext.recentInsights) : null,
          lastUpdatedAt: now,
          version: sql`${walletStrategies.version} + 1`,
        })
        .where(eq(walletStrategies.id, existing.id))
        .returning();
      console.log(`[SaveStrategy] Update successful`);
      return updated;
    } catch (updateError: any) {
      console.error(`[SaveStrategy] Update failed:`, updateError.message);
      throw updateError;
    }
  }
  
  try {
    console.log(`[SaveStrategy] Creating new strategy...`);
    const [created] = await db.insert(walletStrategies).values({
      walletAddress,
      userId,
      strategyType: analysis.strategyType,
      tradingStyle: analysis.tradingStyle,
      avgHoldDuration: analysis.avgHoldDuration,
      avgPositionSize: analysis.avgPositionSize,
      winRate: analysis.winRate,
      avgProfit: analysis.avgProfit,
      avgLoss: analysis.avgLoss,
      profitFactor: analysis.profitFactor,
      preferredEntryTime: analysis.preferredEntryTime,
      entryTokenAge: analysis.entryTokenAge,
      entryMarketCap: analysis.entryMarketCap,
      takeProfitMultiplier: analysis.takeProfitMultiplier,
      stopLossPercent: analysis.stopLossPercent,
      riskLevel: analysis.riskLevel,
      maxConcurrentPositions: analysis.maxConcurrentPositions,
      confidenceScore: analysis.confidenceScore,
      sampleSize: analysis.sampleSize,
      aiRecommendations: analysis.aiRecommendations ? JSON.stringify(analysis.aiRecommendations) : null,
      swapCountAtAnalysis: analysis.swapCountAtAnalysis,
      behaviorType: analysis.discoveryContext?.behaviorType,
      behaviorConfidence: analysis.discoveryContext?.behaviorConfidence,
      discoveryInsights: analysis.discoveryContext ? JSON.stringify(analysis.discoveryContext.recentInsights) : null,
      lastUpdatedAt: now,
      createdAt: now,
    }).returning();
    console.log(`[SaveStrategy] Insert successful, new id: ${created.id}`);
    return created;
  } catch (insertError: any) {
    console.error(`[SaveStrategy] Insert failed:`, insertError.message);
    throw insertError;
  }
}
