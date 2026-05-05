import { db } from "./db";
import { tokenDataPool, paperPositions, walletStrategies } from "@shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { openPaperPosition } from "./paper-trading";
import { onEvent, registerCombo, type DiscoveryEventType } from "./discovery-event-bus";
import { fetchTokenWithFallback } from "./data-pool";
import { getBestTheory, getActiveTheories, type BestTheory } from "./paper-experiments";

const DISCOVERY_USER_ID = 1;

const MAX_TOKEN_SLOTS = 450;
const RESERVE_TOKEN_SLOTS = 50;
const TOTAL_TOKEN_CAP = MAX_TOKEN_SLOTS + RESERVE_TOKEN_SLOTS;
const POSITIONS_PER_TOKEN_DISCOVERY = 4;
const POSITIONS_PER_TOKEN_WALLET = 5;
const ENTRY_SOL = 1;
const MIN_SCORE_FLOOR = 30;
const RESERVE_SCORE_THRESHOLD = 80;

const MIN_LIQUIDITY = 10000;
const MIN_LIQUIDITY_EXPLORATORY = 5000;
const MIN_AGE_HOURS = 2;
const MIN_VOLUME = 1000;

const CRASH_1H_NORMAL = -30;
const CRASH_24H_NORMAL = -50;
const CRASH_1H_EXPLORATORY = -40;
const CRASH_24H_EXPLORATORY = -60;

const DEFAULT_SL_PERCENT = 0.35;
const DEFAULT_TRAILING_PERCENT = 0.25;

const dailyTokenCount = { date: "", count: 0 };
const activeTokenMints = new Set<string>();

const mintLocks = new Map<string, number>();
const MINT_LOCK_TTL_MS = 30000;

function acquireMintLock(tokenMint: string): boolean {
  const now = Date.now();
  const lockTime = mintLocks.get(tokenMint);
  if (lockTime && now - lockTime < MINT_LOCK_TTL_MS) {
    return false;
  }
  mintLocks.set(tokenMint, now);
  return true;
}

function releaseMintLock(tokenMint: string): void {
  mintLocks.delete(tokenMint);
}

function cleanupStaleLocks(): void {
  const now = Date.now();
  const entries = Array.from(mintLocks.entries());
  for (const [mint, lockTime] of entries) {
    if (now - lockTime >= MINT_LOCK_TTL_MS) {
      mintLocks.delete(mint);
    }
  }
}

type StrategySlot = "specific" | "general" | "experimental_1" | "experimental_2" | "wallet_specific";
type SourceType = "token_discovery" | "wallet_copy";

interface SlotConfig {
  strategySlot: StrategySlot;
  stopLossPercent: number;
  trailingStopPercent: number;
  trailingStop: boolean;
  takeProfitMultiplier?: number;
  theoryId?: string;
}

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordTokenOpened(): void {
  const today = getTodayKey();
  if (dailyTokenCount.date !== today) {
    dailyTokenCount.date = today;
    dailyTokenCount.count = 0;
  }
  dailyTokenCount.count++;
}

interface TokenQualification {
  qualified: boolean;
  reason?: string;
}

function qualifyToken(token: {
  tokenMint: string;
  liquidity?: number | null;
  priceUsd?: number | null;
  pairCreatedAt?: number | null;
  createdAt?: number | null;
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  volume24h?: number | null;
}, isExploratory: boolean = false): TokenQualification {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!token.priceUsd || token.priceUsd <= 0) {
    return { qualified: false, reason: "no_price" };
  }

  const minLiq = isExploratory ? MIN_LIQUIDITY_EXPLORATORY : MIN_LIQUIDITY;
  const liquidity = token.liquidity || 0;
  if (liquidity < minLiq) {
    return { qualified: false, reason: `liquidity_too_low:${liquidity}` };
  }

  const ageTimestamp = token.pairCreatedAt || token.createdAt || 0;
  if (ageTimestamp > 0) {
    const ageHours = (nowSeconds - ageTimestamp) / 3600;
    if (ageHours < MIN_AGE_HOURS) {
      return { qualified: false, reason: `too_new:${ageHours.toFixed(1)}h` };
    }
  }

  const crash1h = isExploratory ? CRASH_1H_EXPLORATORY : CRASH_1H_NORMAL;
  const crash24h = isExploratory ? CRASH_24H_EXPLORATORY : CRASH_24H_NORMAL;

  const pc1h = token.priceChange1h || 0;
  if (pc1h < crash1h) {
    return { qualified: false, reason: `crashing_1h:${pc1h.toFixed(0)}%` };
  }

  const pc24h = token.priceChange24h || 0;
  if (pc24h < crash24h) {
    return { qualified: false, reason: `crashing_24h:${pc24h.toFixed(0)}%` };
  }

  const volume = token.volume24h || 0;
  if (volume < MIN_VOLUME) {
    return { qualified: false, reason: `low_volume:${volume}` };
  }

  return { qualified: true };
}

async function getOpenDiscoveryTokenCount(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${paperPositions.tokenMint})` })
    .from(paperPositions)
    .where(and(
      eq(paperPositions.status, "open"),
      eq(paperPositions.paperTradeType, "discovery")
    ));
  return Number(result[0]?.count || 0);
}

async function isTokenAlreadyOpen(tokenMint: string): Promise<boolean> {
  const [existing] = await db.select({ id: paperPositions.id }).from(paperPositions)
    .where(and(
      eq(paperPositions.tokenMint, tokenMint),
      eq(paperPositions.paperTradeType, "discovery"),
      eq(paperPositions.status, "open")
    ))
    .limit(1);
  return !!existing;
}

async function getSlotConfigs(
  sourceType: SourceType,
  tokenMint: string,
  signalWallet?: string
): Promise<SlotConfig[]> {
  const slots: SlotConfig[] = [];

  let walletStrat: typeof walletStrategies.$inferSelect | null = null;
  if (sourceType === "wallet_copy" && signalWallet) {
    const [ws] = await db.select().from(walletStrategies)
      .where(and(
        eq(walletStrategies.walletAddress, signalWallet),
        eq(walletStrategies.userId, DISCOVERY_USER_ID)
      ))
      .limit(1);
    walletStrat = ws || null;
  }

  let specificConfig: Partial<SlotConfig> = {};
  if (sourceType === "wallet_copy" && walletStrat && walletStrat.sampleSize && walletStrat.sampleSize >= 5) {
    specificConfig = {
      stopLossPercent: walletStrat.stopLossPercent || DEFAULT_SL_PERCENT,
      trailingStopPercent: walletStrat.trailingSellEnabled ? 0.20 : DEFAULT_TRAILING_PERCENT,
      trailingStop: true,
    };
  } else if (sourceType === "token_discovery") {
    const [tokenRow] = await db.select().from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, tokenMint))
      .limit(1);

    if (tokenRow) {
      const vol = tokenRow.volume24h || 0;
      const mcap = tokenRow.marketCap || 0;
      if (vol > 100000 && mcap > 500000) {
        specificConfig = {
          stopLossPercent: 0.25,
          trailingStopPercent: 0.20,
          trailingStop: true,
        };
      } else if (vol > 10000) {
        specificConfig = {
          stopLossPercent: 0.35,
          trailingStopPercent: 0.30,
          trailingStop: true,
        };
      }
    }
  }

  slots.push({
    strategySlot: "specific",
    stopLossPercent: specificConfig.stopLossPercent || DEFAULT_SL_PERCENT,
    trailingStopPercent: specificConfig.trailingStopPercent || DEFAULT_TRAILING_PERCENT,
    trailingStop: specificConfig.trailingStop ?? true,
  });

  const bestTheory = await getBestTheory();
  if (bestTheory && bestTheory.config) {
    const slPercent = bestTheory.config.stopLossPercent
      ? (bestTheory.config.stopLossPercent > 1 ? bestTheory.config.stopLossPercent / 100 : bestTheory.config.stopLossPercent)
      : DEFAULT_SL_PERCENT;
    slots.push({
      strategySlot: "general",
      stopLossPercent: slPercent,
      trailingStopPercent: bestTheory.config.trailingStopPercent || DEFAULT_TRAILING_PERCENT,
      trailingStop: true,
      theoryId: bestTheory.id,
    });
  } else {
    slots.push({
      strategySlot: "general",
      stopLossPercent: DEFAULT_SL_PERCENT,
      trailingStopPercent: DEFAULT_TRAILING_PERCENT,
      trailingStop: true,
    });
  }

  slots.push({
    strategySlot: "experimental_1",
    stopLossPercent: 0.45,
    trailingStopPercent: 0.15,
    trailingStop: true,
  });

  slots.push({
    strategySlot: "experimental_2",
    stopLossPercent: 0.30,
    trailingStopPercent: 0.45,
    trailingStop: true,
  });

  if (sourceType === "wallet_copy") {
    if (walletStrat && walletStrat.sampleSize && walletStrat.sampleSize >= 5) {
      slots.push({
        strategySlot: "wallet_specific",
        stopLossPercent: walletStrat.stopLossPercent || DEFAULT_SL_PERCENT,
        trailingStopPercent: walletStrat.trailingSellEnabled ? 0.18 : DEFAULT_TRAILING_PERCENT,
        trailingStop: true,
      });
    } else {
      slots.push({
        strategySlot: "wallet_specific",
        stopLossPercent: DEFAULT_SL_PERCENT,
        trailingStopPercent: 0.22,
        trailingStop: true,
      });
    }
  }

  return slots;
}

export async function openDiscoveryTokenTrade(params: {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  triggerType: "batch_scoring" | "event_bus";
  triggerEventId?: string;
  triggerTimestamp: number;
  pincherScore?: number;
  sourceType: SourceType;
  signalWallet?: string;
  isExploratory?: boolean;
}): Promise<number> {
  const startTime = Date.now();

  if (!acquireMintLock(params.tokenMint)) {
    console.log(`[DiscoveryPaper] Skipping ${params.tokenMint.slice(0, 8)} - concurrent trade in progress`);
    return 0;
  }

  try {
    return await _openDiscoveryTokenTradeInner(params);
  } finally {
    releaseMintLock(params.tokenMint);
  }
}

async function _openDiscoveryTokenTradeInner(params: {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  triggerType: "batch_scoring" | "event_bus";
  triggerEventId?: string;
  triggerTimestamp: number;
  pincherScore?: number;
  sourceType: SourceType;
  signalWallet?: string;
  isExploratory?: boolean;
}): Promise<number> {
  if (await isTokenAlreadyOpen(params.tokenMint)) {
    return 0;
  }

  const openTokens = await getOpenDiscoveryTokenCount();
  const isReserveEligible = (params.pincherScore || 0) >= RESERVE_SCORE_THRESHOLD;

  if (openTokens >= TOTAL_TOKEN_CAP) {
    console.log(`[DiscoveryPaper] Total token cap (${TOTAL_TOKEN_CAP}) reached, skipping ${params.tokenMint}`);
    return 0;
  }

  if (openTokens >= MAX_TOKEN_SLOTS && !isReserveEligible) {
    console.log(`[DiscoveryPaper] Main slots full (${MAX_TOKEN_SLOTS}), score ${params.pincherScore} below reserve threshold ${RESERVE_SCORE_THRESHOLD}`);
    return 0;
  }

  let tokenData;
  try {
    tokenData = await fetchTokenWithFallback(params.tokenMint);
  } catch (err: any) {
    console.error(`[DiscoveryPaper] Failed to fetch token data for ${params.tokenMint}:`, err.message);
    return 0;
  }

  const [poolRow] = await db.select().from(tokenDataPool)
    .where(eq(tokenDataPool.tokenMint, params.tokenMint))
    .limit(1);

  const qualification = qualifyToken({
    tokenMint: params.tokenMint,
    liquidity: tokenData.liquidity,
    priceUsd: tokenData.priceUsd,
    pairCreatedAt: poolRow?.pairCreatedAt,
    createdAt: poolRow?.createdAt,
    priceChange1h: poolRow?.priceChange1h,
    priceChange24h: tokenData.priceChange24h,
    volume24h: tokenData.volume24h,
  }, params.isExploratory);

  if (!qualification.qualified) {
    console.log(`[DiscoveryPaper] Token ${params.tokenSymbol || params.tokenMint.slice(0, 8)} disqualified: ${qualification.reason}`);
    return 0;
  }

  const slotConfigs = await getSlotConfigs(params.sourceType, params.tokenMint, params.signalWallet);
  let positionsOpened = 0;
  const reactionSpeedMs = Date.now() - params.triggerTimestamp;

  for (const slot of slotConfigs) {
    try {
      const position = await openPaperPosition({
        userId: DISCOVERY_USER_ID,
        tokenMint: params.tokenMint,
        tokenSymbol: params.tokenSymbol || tokenData.tokenSymbol,
        tokenName: params.tokenName || tokenData.tokenName,
        entrySol: ENTRY_SOL,
        signalWallet: params.signalWallet,
        stopLossPercent: slot.stopLossPercent,
        trailingStop: slot.trailingStop,
        takeProfitMultiplier: slot.takeProfitMultiplier,
      });

      // Price tier: always batch mode (Helius webhook removed)
      const priceTier: "realtime" | "batch_30m" = "batch_30m";
      const learningWeight = 0.5;

      await db.update(paperPositions)
        .set({
          paperTradeType: "discovery",
          triggerType: params.triggerType,
          reactionSpeedMs,
          triggerEventId: params.triggerEventId,
          strategySlot: slot.strategySlot,
          sourceType: params.sourceType,
          trailingStopPercent: slot.trailingStopPercent,
          theoryId: slot.theoryId,
          priceTier,
          learningWeight,
          discoverySource: params.sourceType === "wallet_copy" ? "signal_wallet" : "event_bus",
          discoverySourceWallet: params.signalWallet || null,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(paperPositions.id, position.id));

      positionsOpened++;
    } catch (error: any) {
      console.error(`[DiscoveryPaper] Failed to open ${slot.strategySlot} position for ${params.tokenMint}:`, error.message);
    }
  }

  if (positionsOpened > 0) {
    recordTokenOpened();
    activeTokenMints.add(params.tokenMint);
    const symbol = params.tokenSymbol || params.tokenMint.slice(0, 8);
    const slotUsed = isReserveEligible && openTokens >= MAX_TOKEN_SLOTS ? "RESERVE" : "regular";
    console.log(`[DiscoveryPaper] Opened ${positionsOpened} positions on ${symbol} | source:${params.sourceType} | trigger:${params.triggerType} | score:${params.pincherScore || '?'} | slot:${slotUsed} | reaction:${reactionSpeedMs}ms`);
  }

  return positionsOpened;
}

export async function processHighScoringTokens(
  scoredTokens: Array<{ mint: string; score: number; confidence: string }>
): Promise<number> {
  let tokensTraded = 0;

  const sorted = scoredTokens
    .filter(t => t.score >= MIN_SCORE_FLOOR && t.confidence !== "low")
    .sort((a, b) => b.score - a.score);

  if (sorted.length === 0) {
    console.log(`[DiscoveryPaper] No tokens above floor score ${MIN_SCORE_FLOOR}`);
    return 0;
  }

  const topTokens = sorted.slice(0, 8);

  const exploratoryPool = sorted.filter(t => t.score >= 40 && t.score < 60);
  const exploratoryPicks = exploratoryPool
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  const allPicks = [...topTokens];
  for (const pick of exploratoryPicks) {
    if (!allPicks.find(t => t.mint === pick.mint)) {
      allPicks.push(pick);
    }
  }

  const triggerTimestamp = Date.now();

  for (const token of allPicks) {
    const tokenData = await fetchTokenWithFallback(token.mint);
    const isExploratory = token.score < 60;

    const opened = await openDiscoveryTokenTrade({
      tokenMint: token.mint,
      tokenSymbol: tokenData.tokenSymbol || undefined,
      tokenName: tokenData.tokenName || undefined,
      triggerType: "batch_scoring",
      triggerTimestamp,
      pincherScore: token.score,
      sourceType: "token_discovery",
      isExploratory,
    });

    if (opened > 0) tokensTraded++;
  }

  if (tokensTraded > 0) {
    console.log(`[DiscoveryPaper] Batch scoring opened trades on ${tokensTraded} tokens (${allPicks.length} candidates, ${exploratoryPicks.length} exploratory)`);
  }

  return tokensTraded;
}

async function handleEventTriggeredTrade(event: {
  type: DiscoveryEventType;
  tokenMint: string;
  tokenSymbol?: string;
  source: string;
  data: Record<string, any>;
  timestamp: number;
  urgency: number;
}): Promise<void> {
  if (event.urgency < 50) return;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSeconds - 86400;

  const [tokenRow] = await db.select().from(tokenDataPool)
    .where(and(
      eq(tokenDataPool.tokenMint, event.tokenMint),
      gte(tokenDataPool.updatedAt, oneDayAgo)
    ))
    .limit(1);

  if (!tokenRow) return;

  const pincherScore = tokenRow.pincherScore || 0;

  if (pincherScore < MIN_SCORE_FLOOR) return;

  const isWalletSignal = event.type === "signal_buy" && event.data?.walletAddress;
  const sourceType: SourceType = isWalletSignal ? "wallet_copy" : "token_discovery";
  const signalWallet = isWalletSignal ? event.data.walletAddress : undefined;

  const isExploratory = pincherScore < 60 && Math.random() < 0.2;
  if (pincherScore < 60 && !isExploratory) return;

  await openDiscoveryTokenTrade({
    tokenMint: event.tokenMint,
    tokenSymbol: event.tokenSymbol || tokenRow.tokenSymbol || undefined,
    tokenName: tokenRow.tokenName || undefined,
    triggerType: "event_bus",
    triggerEventId: `${event.type}_${event.timestamp}`,
    triggerTimestamp: event.timestamp,
    pincherScore,
    sourceType,
    signalWallet,
    isExploratory,
  });
}

export function registerDiscoveryPaperTradingHandlers(): void {
  const eventTypes: DiscoveryEventType[] = [
    "signal_buy",
    "whale_activity",
    "multi_signal_convergence",
    "price_surge",
  ];

  for (const eventType of eventTypes) {
    onEvent(eventType, async (event) => {
      try {
        await handleEventTriggeredTrade(event);
      } catch (error) {
        console.error(`[DiscoveryPaper] Event handler error for ${eventType}:`, error);
      }
    });
  }

  registerCombo({
    name: "social_trending_paper_trade",
    required: ["social_call", "trending_spotted"],
    windowMs: 10 * 60 * 1000,
    minUrgency: 50,
    action: async (events) => {
      const tokenEvent = events[0];
      try {
        await handleEventTriggeredTrade({
          ...tokenEvent,
          urgency: Math.max(...events.map(e => e.urgency)),
        });
      } catch (error) {
        console.error("[DiscoveryPaper] Combo handler error:", error);
      }
    },
  });

  setInterval(cleanupStaleLocks, 60000);

  console.log("[DiscoveryPaper] Registered event handlers: 4-5 positions per token (specific/general/exp1/exp2 + wallet_specific for copies), 450+50 token pool, adaptive thresholds, 1 SOL entry, dedup locks, two-tier pricing");
}

// Discovery source outcome tracking — aggregates paper trade results per source
export async function getDiscoverySourceOutcomes(): Promise<Record<string, {
  totalTrades: number;
  wins: number;
  losses: number;
  avgPnlPercent: number;
  totalPnlSol: number;
  winRate: number;
}>> {
  const closedPositions = await db.select({
    discoverySource: paperPositions.discoverySource,
    realizedPnl: paperPositions.realizedPnl,
    realizedPnlPercent: paperPositions.realizedPnlPercent,
  })
    .from(paperPositions)
    .where(and(
      eq(paperPositions.status, "closed"),
      eq(paperPositions.userId, DISCOVERY_USER_ID)
    ));

  const outcomes: Record<string, {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnlPercent: number;
    totalPnlSol: number;
  }> = {};

  for (const pos of closedPositions) {
    const source = pos.discoverySource || "unknown";
    if (!outcomes[source]) {
      outcomes[source] = { totalTrades: 0, wins: 0, losses: 0, totalPnlPercent: 0, totalPnlSol: 0 };
    }
    const o = outcomes[source];
    o.totalTrades++;
    if ((pos.realizedPnl || 0) > 0) o.wins++;
    else o.losses++;
    o.totalPnlPercent += pos.realizedPnlPercent || 0;
    o.totalPnlSol += pos.realizedPnl || 0;
  }

  const result: Record<string, any> = {};
  for (const [source, o] of Object.entries(outcomes)) {
    result[source] = {
      totalTrades: o.totalTrades,
      wins: o.wins,
      losses: o.losses,
      avgPnlPercent: o.totalTrades > 0 ? o.totalPnlPercent / o.totalTrades : 0,
      totalPnlSol: o.totalPnlSol,
      winRate: o.totalTrades > 0 ? o.wins / o.totalTrades : 0,
    };
  }

  return result;
}
