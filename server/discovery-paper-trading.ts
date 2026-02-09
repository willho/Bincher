import { db } from "./db";
import { tokenDataPool, paperPositions } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { openPaperPosition } from "./paper-trading";
import { onEvent, registerCombo, type DiscoveryEventType } from "./discovery-event-bus";
import { fetchTokenWithFallback } from "./data-pool";

const DISCOVERY_USER_ID = 1;

const MIN_PINCHER_SCORE_BATCH = 70;
const MIN_PINCHER_SCORE_EVENT = 60;
const MIN_LIQUIDITY = 10000;
const MIN_AGE_HOURS = 2;
const MAX_OPEN_DISCOVERY_POSITIONS = 20;
const MAX_DAILY_DISCOVERY_TRADES = 10;
const DEFAULT_ENTRY_SOL = 0.05;

const BATCH_TP_MULTIPLIER = 2.0;
const BATCH_SL_PERCENT = 0.35;
const EVENT_TP_MULTIPLIER = 1.8;
const EVENT_SL_PERCENT = 0.30;

const dailyTradeCount = { date: "", count: 0 };
const recentDiscoveryMints = new Set<string>();

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function canOpenMoreTrades(): boolean {
  const today = getTodayKey();
  if (dailyTradeCount.date !== today) {
    dailyTradeCount.date = today;
    dailyTradeCount.count = 0;
  }
  return dailyTradeCount.count < MAX_DAILY_DISCOVERY_TRADES;
}

function recordTradeOpened(): void {
  const today = getTodayKey();
  if (dailyTradeCount.date !== today) {
    dailyTradeCount.date = today;
    dailyTradeCount.count = 0;
  }
  dailyTradeCount.count++;
}

interface TokenQualification {
  qualified: boolean;
  reason?: string;
}

function qualifyTokenForDiscoveryTrade(token: {
  tokenMint: string;
  liquidity?: number | null;
  priceUsd?: number | null;
  pairCreatedAt?: number | null;
  createdAt?: number | null;
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  volume24h?: number | null;
  marketCap?: number | null;
}): TokenQualification {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!token.priceUsd || token.priceUsd <= 0) {
    return { qualified: false, reason: "no_price" };
  }

  const liquidity = token.liquidity || 0;
  if (liquidity < MIN_LIQUIDITY) {
    return { qualified: false, reason: `liquidity_too_low:${liquidity}` };
  }

  const ageTimestamp = token.pairCreatedAt || token.createdAt || 0;
  if (ageTimestamp > 0) {
    const ageHours = (nowSeconds - ageTimestamp) / 3600;
    if (ageHours < MIN_AGE_HOURS) {
      return { qualified: false, reason: `too_new:${ageHours.toFixed(1)}h` };
    }
  }

  const pc1h = token.priceChange1h || 0;
  if (pc1h < -30) {
    return { qualified: false, reason: `crashing_1h:${pc1h.toFixed(0)}%` };
  }

  const pc24h = token.priceChange24h || 0;
  if (pc24h < -50) {
    return { qualified: false, reason: `crashing_24h:${pc24h.toFixed(0)}%` };
  }

  const volume = token.volume24h || 0;
  if (volume < 1000) {
    return { qualified: false, reason: `low_volume:${volume}` };
  }

  return { qualified: true };
}

async function getOpenDiscoveryCount(): Promise<number> {
  const positions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "open"),
      eq(paperPositions.paperTradeType, "discovery")
    ));
  return positions.length;
}

export async function openDiscoveryPaperTrade(params: {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  triggerType: "batch_scoring" | "event_bus";
  triggerEventId?: string;
  triggerTimestamp: number;
  pincherScore?: number;
  entrySol?: number;
  takeProfitMultiplier?: number;
  stopLossPercent?: number;
}): Promise<boolean> {
  const startTime = Date.now();

  if (!canOpenMoreTrades()) {
    console.log(`[DiscoveryPaper] Daily trade limit reached, skipping ${params.tokenMint}`);
    return false;
  }

  const openCount = await getOpenDiscoveryCount();
  if (openCount >= MAX_OPEN_DISCOVERY_POSITIONS) {
    console.log(`[DiscoveryPaper] Max open positions (${MAX_OPEN_DISCOVERY_POSITIONS}) reached, skipping`);
    return false;
  }

  if (recentDiscoveryMints.has(params.tokenMint)) {
    console.log(`[DiscoveryPaper] Already traded ${params.tokenMint} recently, skipping`);
    return false;
  }

  let tokenData;
  try {
    tokenData = await fetchTokenWithFallback(params.tokenMint);
  } catch (err: any) {
    console.error(`[DiscoveryPaper] Failed to fetch token data for ${params.tokenMint}:`, err.message);
    return false;
  }

  const qualification = qualifyTokenForDiscoveryTrade({
    tokenMint: params.tokenMint,
    liquidity: tokenData.liquidity,
    priceUsd: tokenData.priceUsd,
    pairCreatedAt: tokenData.pairCreatedAt,
    createdAt: tokenData.createdAt,
    priceChange1h: tokenData.priceChange1h,
    priceChange24h: tokenData.priceChange24h,
    volume24h: tokenData.volume24h,
    marketCap: tokenData.marketCap,
  });

  if (!qualification.qualified) {
    console.log(`[DiscoveryPaper] Token ${params.tokenSymbol || params.tokenMint.slice(0, 8)} disqualified: ${qualification.reason}`);
    return false;
  }

  const isBatch = params.triggerType === "batch_scoring";
  const tp = params.takeProfitMultiplier || (isBatch ? BATCH_TP_MULTIPLIER : EVENT_TP_MULTIPLIER);
  const sl = params.stopLossPercent || (isBatch ? BATCH_SL_PERCENT : EVENT_SL_PERCENT);
  const entrySol = params.entrySol || DEFAULT_ENTRY_SOL;

  try {
    const position = await openPaperPosition({
      userId: DISCOVERY_USER_ID,
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol || tokenData.tokenSymbol,
      tokenName: params.tokenName || tokenData.tokenName,
      entrySol,
      takeProfitMultiplier: tp,
      stopLossPercent: sl,
    });

    const reactionSpeedMs = Date.now() - params.triggerTimestamp;

    await db.update(paperPositions)
      .set({
        paperTradeType: "discovery",
        triggerType: params.triggerType,
        reactionSpeedMs,
        triggerEventId: params.triggerEventId,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(paperPositions.id, position.id));

    recordTradeOpened();
    recentDiscoveryMints.add(params.tokenMint);
    setTimeout(() => recentDiscoveryMints.delete(params.tokenMint), 4 * 3600 * 1000);

    console.log(`[DiscoveryPaper] Opened ${params.triggerType} trade #${position.id}: ${params.tokenSymbol || params.tokenMint.slice(0, 8)} | ${entrySol} SOL | TP:${((tp - 1) * 100).toFixed(0)}% SL:${(sl * 100).toFixed(0)}% | reaction:${reactionSpeedMs}ms`);
    return true;
  } catch (error: any) {
    console.error(`[DiscoveryPaper] Failed to open trade for ${params.tokenMint}:`, error.message);
    return false;
  }
}

export async function processHighScoringTokens(scoredTokens: Array<{ mint: string; score: number; confidence: string }>): Promise<number> {
  let tradesOpened = 0;

  const qualified = scoredTokens
    .filter(t => t.score >= MIN_PINCHER_SCORE_BATCH && t.confidence !== "low")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const triggerTimestamp = Date.now();

  for (const token of qualified) {
    const tokenData = await fetchTokenWithFallback(token.mint);

    const success = await openDiscoveryPaperTrade({
      tokenMint: token.mint,
      tokenSymbol: tokenData.tokenSymbol || undefined,
      tokenName: tokenData.tokenName || undefined,
      triggerType: "batch_scoring",
      triggerTimestamp,
      pincherScore: token.score,
      entrySol: DEFAULT_ENTRY_SOL,
      takeProfitMultiplier: BATCH_TP_MULTIPLIER,
      stopLossPercent: BATCH_SL_PERCENT,
    });

    if (success) tradesOpened++;
  }

  if (tradesOpened > 0) {
    console.log(`[DiscoveryPaper] Batch scoring opened ${tradesOpened} discovery trades`);
  }

  return tradesOpened;
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
  if (event.urgency < 60) return;

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
  if (pincherScore < MIN_PINCHER_SCORE_EVENT) return;

  await openDiscoveryPaperTrade({
    tokenMint: event.tokenMint,
    tokenSymbol: event.tokenSymbol || tokenRow.tokenSymbol || undefined,
    tokenName: tokenRow.tokenName || undefined,
    triggerType: "event_bus",
    triggerEventId: `${event.type}_${event.timestamp}`,
    triggerTimestamp: event.timestamp,
    pincherScore,
    entrySol: DEFAULT_ENTRY_SOL,
    takeProfitMultiplier: EVENT_TP_MULTIPLIER,
    stopLossPercent: EVENT_SL_PERCENT,
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

  console.log("[DiscoveryPaper] Registered event handlers for discovery paper trading");
}
