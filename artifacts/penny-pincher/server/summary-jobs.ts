import { db } from "./db";
import {
  swaps,
  monitoredWallets,
  walletSummaries,
  tokenPopularity,
  walletCorrelations,
  systemEvents,
  apiUsage,
  adminChatMessages,
} from "@shared/schema";
import { eq, and, desc, gte, lte, sql, count, avg } from "drizzle-orm";

const PREFIX = "[SummaryJobs]";
const CLEANUP_PREFIX = "[LogCleanup]";

let walletSummaryInterval: ReturnType<typeof setInterval> | null = null;
let tokenPopularityInterval: ReturnType<typeof setInterval> | null = null;
let walletCorrelationInterval: ReturnType<typeof setInterval> | null = null;
let logCleanupInterval: ReturnType<typeof setInterval> | null = null;

const jobStats = {
  walletSummary: { lastRunAt: 0, walletsUpdated: 0 },
  tokenPopularity: { lastRunAt: 0, tokensUpdated: 0 },
  walletCorrelation: { lastRunAt: 0, pairsStored: 0 },
  logCleanup: { lastRunAt: 0, rowsDeleted: 0 },
};

// ─── 1. Wallet Profile Summary ───────────────────────────────────────────────

export async function updateWalletSummary(walletAddress: string): Promise<void> {
  try {
    const allSwaps = await db
      .select()
      .from(swaps)
      .where(eq(swaps.source, walletAddress))
      .orderBy(swaps.timestamp);

    if (allSwaps.length === 0) return;

    const buys = allSwaps.filter((s) => s.type === "buy");
    const sells = allSwaps.filter((s) => s.type === "sell");

    const tokenBuys = new Map<string, typeof allSwaps>();
    for (const b of buys) {
      const existing = tokenBuys.get(b.toToken) || [];
      existing.push(b);
      tokenBuys.set(b.toToken, existing);
    }

    const tokenSells = new Map<string, typeof allSwaps>();
    for (const s of sells) {
      const existing = tokenSells.get(s.fromToken) || [];
      existing.push(s);
      tokenSells.set(s.fromToken, existing);
    }

    let winningTrades = 0;
    let losingTrades = 0;
    let totalHoldTimeMinutes = 0;
    let totalReturnPercent = 0;
    let matchedTrades = 0;

    const hourlyReturns = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    const dailyReturns = new Array(7).fill(0);
    const dailyCounts = new Array(7).fill(0);

    for (const [token, buyList] of Array.from(tokenBuys.entries())) {
      const sellList = tokenSells.get(token) || [];
      if (sellList.length === 0) continue;

      for (const buy of buyList) {
        const matchingSell = sellList.find((s) => s.timestamp > buy.timestamp);
        if (!matchingSell) continue;

        matchedTrades++;
        const buyPrice = buy.fromAmount > 0 ? buy.fromAmount : 1;
        const sellPrice = matchingSell.toAmount > 0 ? matchingSell.toAmount : 0;
        const returnPct = ((sellPrice - buyPrice) / buyPrice) * 100;
        totalReturnPercent += returnPct;

        const holdTimeMin = (matchingSell.timestamp - buy.timestamp) / 60;
        totalHoldTimeMinutes += holdTimeMin;

        if (sellPrice > buyPrice) {
          winningTrades++;
          const buyDate = new Date(buy.timestamp * 1000);
          const hour = buyDate.getUTCHours();
          const day = buyDate.getUTCDay();
          hourlyReturns[hour] += returnPct;
          hourlyCounts[hour]++;
          dailyReturns[day] += returnPct;
          dailyCounts[day]++;
        } else {
          losingTrades++;
        }
      }
    }

    const totalTrades = matchedTrades > 0 ? matchedTrades : allSwaps.length;
    const hitRate = matchedTrades > 0 ? winningTrades / matchedTrades : 0;
    const avgHoldTimeMinutes = matchedTrades > 0 ? Math.round(totalHoldTimeMinutes / matchedTrades) : 0;
    const avgReturnPercent = matchedTrades > 0 ? totalReturnPercent / matchedTrades : 0;

    let bestHourUtc = 0;
    let bestHourAvg = -Infinity;
    for (let h = 0; h < 24; h++) {
      if (hourlyCounts[h] > 0) {
        const avg = hourlyReturns[h] / hourlyCounts[h];
        if (avg > bestHourAvg) {
          bestHourAvg = avg;
          bestHourUtc = h;
        }
      }
    }

    let bestDayOfWeek = 0;
    let bestDayAvg = -Infinity;
    for (let d = 0; d < 7; d++) {
      if (dailyCounts[d] > 0) {
        const avg = dailyReturns[d] / dailyCounts[d];
        if (avg > bestDayAvg) {
          bestDayAvg = avg;
          bestDayOfWeek = d;
        }
      }
    }

    const buySellRatio = sells.length > 0 ? buys.length / sells.length : buys.length;
    const avgBuySize =
      buys.length > 0 ? buys.reduce((sum, b) => sum + b.fromAmount, 0) / buys.length : 0;

    const now = Math.floor(Date.now() / 1000);
    const lastTradeAt = allSwaps[allSwaps.length - 1].timestamp;

    const existing = await db
      .select({ id: walletSummaries.id })
      .from(walletSummaries)
      .where(eq(walletSummaries.walletAddress, walletAddress))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(walletSummaries)
        .set({
          hitRate,
          avgHoldTimeMinutes,
          avgReturnPercent,
          totalTrades,
          winningTrades,
          losingTrades,
          bestHourUtc,
          bestDayOfWeek,
          timingPatterns: {
            hourlyReturns: hourlyReturns.map((v, i) => (hourlyCounts[i] > 0 ? v / hourlyCounts[i] : 0)),
            dailyReturns: dailyReturns.map((v, i) => (dailyCounts[i] > 0 ? v / dailyCounts[i] : 0)),
          },
          buySellRatio,
          avgBuySize,
          lastTradeAt,
          updatedAt: now,
        })
        .where(eq(walletSummaries.walletAddress, walletAddress));
    } else {
      await db.insert(walletSummaries).values({
        walletAddress,
        hitRate,
        avgHoldTimeMinutes,
        avgReturnPercent,
        totalTrades,
        winningTrades,
        losingTrades,
        bestHourUtc,
        bestDayOfWeek,
        timingPatterns: {
          hourlyReturns: hourlyReturns.map((v, i) => (hourlyCounts[i] > 0 ? v / hourlyCounts[i] : 0)),
          dailyReturns: dailyReturns.map((v, i) => (dailyCounts[i] > 0 ? v / dailyCounts[i] : 0)),
        },
        buySellRatio,
        avgBuySize,
        lastTradeAt,
        updatedAt: now,
        createdAt: now,
      });
    }
  } catch (err) {
    console.error(`${PREFIX} Error updating wallet summary for ${walletAddress}:`, err);
  }
}

export async function runWalletSummaryJob(): Promise<void> {
  console.log(`${PREFIX} Starting wallet summary job...`);
  try {
    const wallets = await db
      .selectDistinct({ walletAddress: monitoredWallets.walletAddress })
      .from(monitoredWallets);

    let updated = 0;
    for (const w of wallets) {
      await updateWalletSummary(w.walletAddress);
      updated++;
    }

    jobStats.walletSummary.lastRunAt = Math.floor(Date.now() / 1000);
    jobStats.walletSummary.walletsUpdated = updated;
    console.log(`${PREFIX} Wallet summary job complete: ${updated} wallets updated`);
  } catch (err) {
    console.error(`${PREFIX} Wallet summary job failed:`, err);
  }
}

// ─── 2. Token Popularity ─────────────────────────────────────────────────────

export async function updateTokenPopularity(tokenMint: string): Promise<void> {
  try {
    const tokenSwaps = await db
      .select()
      .from(swaps)
      .where(
        sql`${swaps.toToken} = ${tokenMint} OR ${swaps.fromToken} = ${tokenMint}`
      );

    if (tokenSwaps.length === 0) return;

    const buySwaps = tokenSwaps.filter(
      (s) => s.type === "buy" && s.toToken === tokenMint
    );
    const sellSwaps = tokenSwaps.filter(
      (s) => s.type === "sell" && s.fromToken === tokenMint
    );

    const uniqueWallets = new Set(tokenSwaps.map((s) => s.source));
    const signalWalletCount = uniqueWallets.size;
    const totalBuys = buySwaps.length;
    const totalSells = sellSwaps.length;

    const walletBuyCounts = new Map<string, number>();
    for (const b of buySwaps) {
      walletBuyCounts.set(b.source, (walletBuyCounts.get(b.source) || 0) + 1);
    }
    let repeatInterestCount = 0;
    for (const [, c] of Array.from(walletBuyCounts.entries())) {
      if (c > 1) repeatInterestCount++;
    }

    const returns: number[] = [];
    const walletBuyMap = new Map<string, typeof tokenSwaps>();
    for (const b of buySwaps) {
      const existing = walletBuyMap.get(b.source) || [];
      existing.push(b);
      walletBuyMap.set(b.source, existing);
    }

    for (const [wallet, wBuys] of Array.from(walletBuyMap.entries())) {
      const wSells = sellSwaps.filter((s) => s.source === wallet);
      for (const buy of wBuys) {
        const sell = wSells.find((s) => s.timestamp > buy.timestamp);
        if (sell) {
          const buyAmt = buy.fromAmount > 0 ? buy.fromAmount : 1;
          const sellAmt = sell.toAmount > 0 ? sell.toAmount : 0;
          returns.push(((sellAmt - buyAmt) / buyAmt) * 100);
        }
      }
    }

    const avgReturnPercent =
      returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    const bestReturnPercent = returns.length > 0 ? Math.max(...returns) : null;
    const worstReturnPercent = returns.length > 0 ? Math.min(...returns) : null;

    const now = Math.floor(Date.now() / 1000);
    const firstSeenAt = Math.min(...tokenSwaps.map((s) => s.timestamp));
    const lastActivityAt = Math.max(...tokenSwaps.map((s) => s.timestamp));

    const existing = await db
      .select({ id: tokenPopularity.id })
      .from(tokenPopularity)
      .where(eq(tokenPopularity.tokenMint, tokenMint))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(tokenPopularity)
        .set({
          signalWalletCount,
          totalBuys,
          totalSells,
          avgReturnPercent,
          bestReturnPercent,
          worstReturnPercent,
          repeatInterestCount,
          firstSeenAt,
          lastActivityAt,
          updatedAt: now,
        })
        .where(eq(tokenPopularity.tokenMint, tokenMint));
    } else {
      await db.insert(tokenPopularity).values({
        tokenMint,
        signalWalletCount,
        totalBuys,
        totalSells,
        avgReturnPercent,
        bestReturnPercent,
        worstReturnPercent,
        repeatInterestCount,
        firstSeenAt,
        lastActivityAt,
        updatedAt: now,
        createdAt: now,
      });
    }
  } catch (err) {
    console.error(`${PREFIX} Error updating token popularity for ${tokenMint}:`, err);
  }
}

export async function runTokenPopularityJob(): Promise<void> {
  console.log(`${PREFIX} Starting token popularity job...`);
  try {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

    const recentTokens = await db
      .selectDistinct({ token: swaps.toToken })
      .from(swaps)
      .where(gte(swaps.timestamp, sevenDaysAgo));

    const recentFromTokens = await db
      .selectDistinct({ token: swaps.fromToken })
      .from(swaps)
      .where(gte(swaps.timestamp, sevenDaysAgo));

    const allMints = new Set<string>();
    for (const r of recentTokens) allMints.add(r.token);
    for (const r of recentFromTokens) allMints.add(r.token);

    let updated = 0;
    for (const mint of Array.from(allMints)) {
      await updateTokenPopularity(mint);
      updated++;
    }

    jobStats.tokenPopularity.lastRunAt = Math.floor(Date.now() / 1000);
    jobStats.tokenPopularity.tokensUpdated = updated;
    console.log(`${PREFIX} Token popularity job complete: ${updated} tokens updated`);
  } catch (err) {
    console.error(`${PREFIX} Token popularity job failed:`, err);
  }
}

// ─── 3. Wallet Correlation ───────────────────────────────────────────────────

export async function runWalletCorrelationJob(): Promise<void> {
  console.log(`${PREFIX} Starting wallet correlation job...`);
  try {
    const wallets = await db
      .selectDistinct({ walletAddress: monitoredWallets.walletAddress })
      .from(monitoredWallets);

    const addresses = wallets.map((w) => w.walletAddress).slice(0, 50);

    if (addresses.length < 2) {
      console.log(`${PREFIX} Not enough wallets for correlation (${addresses.length})`);
      return;
    }

    const walletTokens = new Map<string, Map<string, number[]>>();

    for (const addr of addresses) {
      const walletSwaps = await db
        .select({ toToken: swaps.toToken, timestamp: swaps.timestamp, type: swaps.type })
        .from(swaps)
        .where(and(eq(swaps.source, addr), eq(swaps.type, "buy")));

      const tokenTimestamps = new Map<string, number[]>();
      for (const s of walletSwaps) {
        const existing = tokenTimestamps.get(s.toToken) || [];
        existing.push(s.timestamp);
        tokenTimestamps.set(s.toToken, existing);
      }
      walletTokens.set(addr, tokenTimestamps);
    }

    let pairsStored = 0;
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < addresses.length; i++) {
      for (let j = i + 1; j < addresses.length; j++) {
        const walletA = addresses[i];
        const walletB = addresses[j];
        const tokensA = walletTokens.get(walletA)!;
        const tokensB = walletTokens.get(walletB)!;

        const sharedTokens: string[] = [];
        for (const token of Array.from(tokensA.keys())) {
          if (tokensB.has(token)) {
            sharedTokens.push(token);
          }
        }

        if (sharedTokens.length < 3) continue;

        let totalCorrelation = 0;
        let correlationCount = 0;

        for (const token of sharedTokens) {
          const timesA = tokensA.get(token)!;
          const timesB = tokensB.get(token)!;

          let minTimeDiff = Infinity;
          for (const tA of timesA) {
            for (const tB of timesB) {
              const diff = Math.abs(tA - tB);
              if (diff < minTimeDiff) minTimeDiff = diff;
            }
          }

          const fiveMinutes = 5 * 60;
          const oneDay = 24 * 60 * 60;

          let correlation: number;
          if (minTimeDiff <= fiveMinutes) {
            correlation = 1;
          } else if (minTimeDiff >= oneDay) {
            correlation = -1;
          } else {
            correlation = 1 - (2 * (minTimeDiff - fiveMinutes)) / (oneDay - fiveMinutes);
          }

          totalCorrelation += correlation;
          correlationCount++;
        }

        const timingCorrelation =
          correlationCount > 0 ? totalCorrelation / correlationCount : 0;

        const sharedTokenCount = sharedTokens.length;
        const tokenFactor = Math.min(sharedTokenCount / 10, 1);
        const timingFactor = (timingCorrelation + 1) / 2;
        const sameGroupLikelihood = tokenFactor * 0.4 + timingFactor * 0.6;

        const existing = await db
          .select({ id: walletCorrelations.id })
          .from(walletCorrelations)
          .where(
            and(
              eq(walletCorrelations.walletA, walletA),
              eq(walletCorrelations.walletB, walletB)
            )
          )
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(walletCorrelations)
            .set({
              sharedTokenCount,
              timingCorrelation,
              sameGroupLikelihood,
              updatedAt: now,
            })
            .where(
              and(
                eq(walletCorrelations.walletA, walletA),
                eq(walletCorrelations.walletB, walletB)
              )
            );
        } else {
          await db.insert(walletCorrelations).values({
            walletA,
            walletB,
            sharedTokenCount,
            timingCorrelation,
            sameGroupLikelihood,
            updatedAt: now,
            createdAt: now,
          });
        }

        pairsStored++;
      }
    }

    jobStats.walletCorrelation.lastRunAt = now;
    jobStats.walletCorrelation.pairsStored = pairsStored;
    console.log(`${PREFIX} Wallet correlation job complete: ${pairsStored} pairs stored`);
  } catch (err) {
    console.error(`${PREFIX} Wallet correlation job failed:`, err);
  }
}

// ─── 4. Log Cleanup ──────────────────────────────────────────────────────────

export async function runLogCleanup(): Promise<number> {
  console.log(`${CLEANUP_PREFIX} Starting log cleanup...`);
  let totalDeleted = 0;

  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - 7 * 24 * 60 * 60;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

    const sysResult = await db
      .delete(systemEvents)
      .where(lte(systemEvents.timestamp, sevenDaysAgo));
    const sysCount = sysResult.length ?? 0;
    totalDeleted += sysCount;
    console.log(`${CLEANUP_PREFIX} Deleted ${sysCount} system events (>7d)`);

    const apiResult = await db
      .delete(apiUsage)
      .where(lte(apiUsage.timestamp, thirtyDaysAgo));
    const apiCount = apiResult.length ?? 0;
    totalDeleted += apiCount;
    console.log(`${CLEANUP_PREFIX} Deleted ${apiCount} API usage records (>30d)`);

    const chatResult = await db
      .delete(adminChatMessages)
      .where(lte(adminChatMessages.createdAt, thirtyDaysAgo));
    const chatCount = chatResult.length ?? 0;
    totalDeleted += chatCount;
    console.log(`${CLEANUP_PREFIX} Deleted ${chatCount} admin chat messages (>30d)`);

    jobStats.logCleanup.lastRunAt = now;
    jobStats.logCleanup.rowsDeleted = totalDeleted;
    console.log(`${CLEANUP_PREFIX} Log cleanup complete: ${totalDeleted} total rows deleted`);
  } catch (err) {
    console.error(`${CLEANUP_PREFIX} Log cleanup failed:`, err);
  }

  return totalDeleted;
}

// ─── 5. Master Scheduler ─────────────────────────────────────────────────────

const SIX_HOURS = 6 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export function startSummaryJobs(): void {
  console.log(`${PREFIX} Initializing summary job scheduler...`);

  setTimeout(() => {
    runWalletSummaryJob().catch((err) =>
      console.error(`${PREFIX} Startup wallet summary failed:`, err)
    );
  }, 0);

  setTimeout(() => {
    runTokenPopularityJob().catch((err) =>
      console.error(`${PREFIX} Startup token popularity failed:`, err)
    );
  }, 30 * 1000);

  setTimeout(() => {
    runWalletCorrelationJob().catch((err) =>
      console.error(`${PREFIX} Startup wallet correlation failed:`, err)
    );
  }, 60 * 1000);

  setTimeout(() => {
    runLogCleanup().catch((err) =>
      console.error(`${PREFIX} Startup log cleanup failed:`, err)
    );
  }, 90 * 1000);

  walletSummaryInterval = setInterval(() => {
    runWalletSummaryJob().catch((err) =>
      console.error(`${PREFIX} Scheduled wallet summary failed:`, err)
    );
  }, SIX_HOURS);

  tokenPopularityInterval = setInterval(() => {
    runTokenPopularityJob().catch((err) =>
      console.error(`${PREFIX} Scheduled token popularity failed:`, err)
    );
  }, SIX_HOURS);

  walletCorrelationInterval = setInterval(() => {
    runWalletCorrelationJob().catch((err) =>
      console.error(`${PREFIX} Scheduled wallet correlation failed:`, err)
    );
  }, ONE_DAY);

  logCleanupInterval = setInterval(() => {
    runLogCleanup().catch((err) =>
      console.error(`${PREFIX} Scheduled log cleanup failed:`, err)
    );
  }, ONE_DAY);

  console.log(`${PREFIX} Summary jobs scheduled: wallet summaries (6h), token popularity (6h+1h offset), correlations (24h), log cleanup (24h)`);
}

export function stopSummaryJobs(): void {
  if (walletSummaryInterval) {
    clearInterval(walletSummaryInterval);
    walletSummaryInterval = null;
  }
  if (tokenPopularityInterval) {
    clearInterval(tokenPopularityInterval);
    tokenPopularityInterval = null;
  }
  if (walletCorrelationInterval) {
    clearInterval(walletCorrelationInterval);
    walletCorrelationInterval = null;
  }
  if (logCleanupInterval) {
    clearInterval(logCleanupInterval);
    logCleanupInterval = null;
  }
  console.log(`${PREFIX} All summary jobs stopped`);
}

export function getSummaryJobStats() {
  return {
    walletSummary: { ...jobStats.walletSummary },
    tokenPopularity: { ...jobStats.tokenPopularity },
    walletCorrelation: { ...jobStats.walletCorrelation },
    logCleanup: { ...jobStats.logCleanup },
  };
}
