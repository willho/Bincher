import { db } from "./db";
import { paperPositions, priceHistoryCache, PaperPosition } from "@shared/schema";
import { eq, and, desc, gte, or, isNull } from "drizzle-orm";
import { fetchTokenWithFallback } from "./data-pool";

const BATCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const CANDLE_LOOKBACK_SECONDS = 35 * 60; // 35 min lookback for 30min candles
const POSITION_EXPIRY_HOURS = 72; // Close stale positions after 72h
let autoCloseTimer: ReturnType<typeof setInterval> | null = null;

async function getSolPriceUsd(): Promise<number> {
  const solMint = "So11111111111111111111111111111111111111112";
  const solData = await fetchTokenWithFallback(solMint);
  return solData.priceUsd || 150;
}

interface CandleData {
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

async function getRecentCandles(tokenMint: string): Promise<CandleData[]> {
  const cutoff = Math.floor(Date.now() / 1000) - CANDLE_LOOKBACK_SECONDS;
  
  const candles = await db.select({
    high: priceHistoryCache.high,
    low: priceHistoryCache.low,
    close: priceHistoryCache.close,
    timestamp: priceHistoryCache.timestamp,
  })
    .from(priceHistoryCache)
    .where(and(
      eq(priceHistoryCache.tokenMint, tokenMint),
      gte(priceHistoryCache.timestamp, cutoff)
    ))
    .orderBy(desc(priceHistoryCache.timestamp))
    .limit(10);

  return candles;
}

function evaluatePositionConservatively(
  position: PaperPosition,
  candles: CandleData[],
  currentPrice: number
): { shouldClose: boolean; exitReason: string; exitPrice: number } {
  const entry = position.entryPrice;
  const slPercent = position.stopLossPercent || 0.25;
  const tpMultiplier = position.takeProfitMultiplier || 2.0;
  const trailingStopPercent = position.trailingStopPercent || 0.20;
  const isTrailingStop = position.trailingStop ?? true;

  const stopLossPrice = entry * (1 - slPercent);
  const takeProfitPrice = entry * tpMultiplier;

  // Conservative approach: use candle LOW for stop-loss checks (worst case)
  // Use candle HIGH for take-profit checks (best case for closing at profit)
  for (const candle of candles) {
    // Check stop-loss against candle low (assume worst case - it hit the low)
    if (candle.low <= stopLossPrice) {
      return {
        shouldClose: true,
        exitReason: `batch_stop_loss (candle low ${candle.low.toFixed(10)} <= SL ${stopLossPrice.toFixed(10)})`,
        exitPrice: stopLossPrice, // Conservative: assume exit at exact SL
      };
    }

    // Check trailing stop: if price peaked then dropped
    if (isTrailingStop && position.highestPrice) {
      const trailPrice = position.highestPrice * (1 - trailingStopPercent);
      if (candle.low <= trailPrice && position.highestPrice > entry * 1.05) {
        return {
          shouldClose: true,
          exitReason: `batch_trailing_stop (peak ${position.highestPrice.toFixed(10)}, trail ${trailPrice.toFixed(10)}, candle low ${candle.low.toFixed(10)})`,
          exitPrice: trailPrice, // Conservative: assume exit at trail price
        };
      }
    }

    // Check take-profit against candle high
    if (candle.high >= takeProfitPrice) {
      return {
        shouldClose: true,
        exitReason: `batch_take_profit (candle high ${candle.high.toFixed(10)} >= TP ${takeProfitPrice.toFixed(10)})`,
        exitPrice: takeProfitPrice, // Conservative: assume exit at exact TP level
      };
    }
  }

  // If no candle data, fall back to current price
  if (candles.length === 0 && currentPrice > 0) {
    if (currentPrice <= stopLossPrice) {
      return {
        shouldClose: true,
        exitReason: `batch_stop_loss_no_candles (price ${currentPrice.toFixed(10)} <= SL ${stopLossPrice.toFixed(10)})`,
        exitPrice: currentPrice,
      };
    }
    if (currentPrice >= takeProfitPrice) {
      return {
        shouldClose: true,
        exitReason: `batch_take_profit_no_candles (price ${currentPrice.toFixed(10)} >= TP ${takeProfitPrice.toFixed(10)})`,
        exitPrice: currentPrice,
      };
    }
    if (isTrailingStop && position.highestPrice) {
      const trailPrice = position.highestPrice * (1 - trailingStopPercent);
      if (currentPrice <= trailPrice && position.highestPrice > entry * 1.05) {
        return {
          shouldClose: true,
          exitReason: `batch_trailing_stop_no_candles`,
          exitPrice: currentPrice,
        };
      }
    }
  }

  return { shouldClose: false, exitReason: "", exitPrice: 0 };
}

async function closePositionAtPrice(
  position: PaperPosition,
  exitPrice: number,
  exitReason: string
): Promise<PaperPosition | null> {
  const now = Math.floor(Date.now() / 1000);
  const solPriceUsd = await getSolPriceUsd();
  
  const exitUsd = position.entryTokens * exitPrice;
  const exitSol = exitUsd / solPriceUsd;
  const realizedPnl = exitSol - position.entrySol;
  const realizedPnlPercent = (realizedPnl / position.entrySol) * 100;
  
  const [updated] = await db.update(paperPositions)
    .set({
      exitPrice,
      exitSol,
      exitTimestamp: now,
      exitReason,
      realizedPnl,
      realizedPnlPercent,
      status: "closed",
      updatedAt: now,
    })
    .where(and(
      eq(paperPositions.id, position.id),
      eq(paperPositions.status, "open")
    ))
    .returning();

  if (updated) {
    console.log(`[PaperAutoClose] Closed #${position.id} ${position.tokenSymbol}: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)} SOL (${realizedPnlPercent.toFixed(1)}%) [${exitReason.split(' ')[0]}]`);
    
    try {
      const { recordPaperTradeOutcome } = await import("./paper-experiments");
      await recordPaperTradeOutcome(updated);
    } catch (err) {
      console.error("[PaperAutoClose] Failed to record outcome:", err);
    }
  }

  return updated || null;
}

async function updateHighLow(position: PaperPosition, candles: CandleData[], currentPrice: number): Promise<void> {
  let newHigh = position.highestPrice || position.entryPrice;
  let newLow = position.lowestPrice || position.entryPrice;

  for (const candle of candles) {
    if (candle.high > newHigh) newHigh = candle.high;
    if (candle.low < newLow) newLow = candle.low;
  }
  if (currentPrice > newHigh) newHigh = currentPrice;
  if (currentPrice > 0 && currentPrice < newLow) newLow = currentPrice;

  if (newHigh !== position.highestPrice || newLow !== position.lowestPrice) {
    await db.update(paperPositions)
      .set({
        highestPrice: newHigh,
        lowestPrice: newLow,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(paperPositions.id, position.id));
  }
}

export async function runBatchAutoClose(): Promise<{ checked: number; closed: number; expired: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiryThreshold = now - (POSITION_EXPIRY_HOURS * 3600);

  // Get all open batch_30m positions
  const openPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "open"),
      or(
        eq(paperPositions.priceTier, "batch_30m"),
        isNull(paperPositions.priceTier) // Legacy positions without tier
      )
    ));

  if (openPositions.length === 0) return { checked: 0, closed: 0, expired: 0 };

  let closed = 0;
  let expired = 0;

  for (const position of openPositions) {
    // Check expiry first
    if (position.entryTimestamp < expiryThreshold) {
      const tokenData = await fetchTokenWithFallback(position.tokenMint);
      const exitPrice = tokenData.priceUsd || position.entryPrice;
      await closePositionAtPrice(position, exitPrice, "batch_expired_72h");
      expired++;
      continue;
    }

    // Get OHLCV candles and current price
    const candles = await getRecentCandles(position.tokenMint);
    const tokenData = await fetchTokenWithFallback(position.tokenMint);
    const currentPrice = tokenData.priceUsd || 0;

    // Update high/low tracking from candle data
    await updateHighLow(position, candles, currentPrice);

    // Evaluate using conservative candle-based logic
    const evaluation = evaluatePositionConservatively(position, candles, currentPrice);

    if (evaluation.shouldClose) {
      await closePositionAtPrice(position, evaluation.exitPrice, evaluation.exitReason);
      closed++;
    }
  }

  if (closed > 0 || expired > 0) {
    console.log(`[PaperAutoClose] Batch: checked=${openPositions.length}, closed=${closed}, expired=${expired}`);
  }

  return { checked: openPositions.length, closed, expired };
}

export async function runRealtimeAutoClose(): Promise<{ checked: number; closed: number }> {
  const openPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "open"),
      eq(paperPositions.priceTier, "realtime")
    ));

  if (openPositions.length === 0) return { checked: 0, closed: 0 };

  let closed = 0;

  for (const position of openPositions) {
    const tokenData = await fetchTokenWithFallback(position.tokenMint);
    const currentPrice = tokenData.priceUsd || 0;
    if (currentPrice <= 0) continue;

    const entry = position.entryPrice;
    const slPercent = position.stopLossPercent || 0.25;
    const tpMultiplier = position.takeProfitMultiplier || 2.0;
    const trailingStopPercent = position.trailingStopPercent || 0.20;
    const isTrailingStop = position.trailingStop ?? true;

    // Update high/low
    const updates: Record<string, any> = { updatedAt: Math.floor(Date.now() / 1000) };
    if (currentPrice > (position.highestPrice || 0)) updates.highestPrice = currentPrice;
    if (currentPrice < (position.lowestPrice || Infinity)) updates.lowestPrice = currentPrice;
    if (Object.keys(updates).length > 1) {
      await db.update(paperPositions).set(updates).where(eq(paperPositions.id, position.id));
    }

    // Check stop-loss
    const stopLossPrice = entry * (1 - slPercent);
    if (currentPrice <= stopLossPrice) {
      await closePositionAtPrice(position, currentPrice, "realtime_stop_loss");
      closed++;
      continue;
    }

    // Check take-profit
    const takeProfitPrice = entry * tpMultiplier;
    if (currentPrice >= takeProfitPrice) {
      await closePositionAtPrice(position, currentPrice, "realtime_take_profit");
      closed++;
      continue;
    }

    // Check trailing stop
    if (isTrailingStop && position.highestPrice) {
      const trailPrice = position.highestPrice * (1 - trailingStopPercent);
      if (currentPrice <= trailPrice && position.highestPrice > entry * 1.05) {
        await closePositionAtPrice(position, currentPrice, "realtime_trailing_stop");
        closed++;
      }
    }
  }

  return { checked: openPositions.length, closed };
}

export function startPaperAutoClose(): void {
  if (autoCloseTimer) return;

  // Run batch auto-close every 30 minutes for Tier 2 positions
  autoCloseTimer = setInterval(async () => {
    try {
      await runBatchAutoClose();
    } catch (err) {
      console.error("[PaperAutoClose] Batch error:", err);
    }
  }, BATCH_INTERVAL_MS);

  // Also run realtime auto-close every 2 minutes for Tier 1 positions
  setInterval(async () => {
    try {
      await runRealtimeAutoClose();
    } catch (err) {
      console.error("[PaperAutoClose] Realtime error:", err);
    }
  }, 2 * 60 * 1000);

  console.log("[PaperAutoClose] Started: batch every 30m, realtime every 2m");
  
  // Run initial batch check after 60 seconds
  setTimeout(() => {
    runBatchAutoClose().catch(err => console.error("[PaperAutoClose] Initial batch error:", err));
  }, 60_000);
}

export function stopPaperAutoClose(): void {
  if (autoCloseTimer) {
    clearInterval(autoCloseTimer);
    autoCloseTimer = null;
    console.log("[PaperAutoClose] Stopped");
  }
}
