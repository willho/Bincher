import { db } from "./db";
import { indicatorSnapshots, indicatorVectors, vectorUpdates, paperPositions, strategyClusters } from "@shared/schema";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { getIndicators, type IndicatorResult } from "./technical-indicators";
import { enrichSnapshot } from "./snapshot-enrichment";

function getCurrentBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

function flattenIndicators(result: IndicatorResult): {
  rsi: number | null;
  macdHistogram: number | null;
  emaCrossSignal: string | null;
  bollingerPosition: string | null;
  bollingerBandwidth: number | null;
  obvTrend: string | null;
  stochasticK: number | null;
  compositeScore: number;
  compositeBias: string;
} {
  return {
    rsi: result.rsi?.value ?? null,
    macdHistogram: result.macd?.histogram ?? null,
    emaCrossSignal: result.ema?.signal ?? null,
    bollingerPosition: result.bollinger?.position ?? null,
    bollingerBandwidth: result.bollinger?.bandwidth ?? null,
    obvTrend: result.obv?.trend ?? null,
    stochasticK: result.stochastic?.k ?? null,
    compositeScore: result.composite.score,
    compositeBias: result.composite.bias,
  };
}

export async function recordIndicatorSnapshot(
  tokenMint: string,
  snapshotType: "entry" | "exit" | "periodic" | "checkpoint",
  positionId?: number,
  timeframe: string = "1h",
  enrichmentOverrides?: Record<string, any>
): Promise<number | null> {
  try {
    const indicators = await getIndicators(tokenMint, timeframe);
    if (!indicators) return null;

    const flat = flattenIndicators(indicators);
    const now = Math.floor(Date.now() / 1000);
    const bucketId = getCurrentBucketId();

    const values: Record<string, any> = {
      tokenMint,
      positionId: positionId ?? null,
      snapshotType,
      timeframe,
      ...flat,
      priceAtSnapshot: indicators.bollinger?.middle ?? indicators.ema?.ema12 ?? null,
      bucketId,
      createdAt: now,
    };

    if (enrichmentOverrides) {
      Object.assign(values, enrichmentOverrides);
    }

    const [row] = await db.insert(indicatorSnapshots).values(values as any).returning({ id: indicatorSnapshots.id });

    return row?.id ?? null;
  } catch (err) {
    console.error("[IndicatorVectors] Snapshot failed:", err);
    return null;
  }
}

export async function recordEntrySnapshot(
  tokenMint: string,
  positionId: number,
  signalWallet?: string | null,
  discoverySource?: string | null
): Promise<void> {
  try {
    const enrichment = await enrichSnapshot(
      tokenMint, "entry", positionId,
      signalWallet, null, discoverySource
    );
    await recordIndicatorSnapshot(tokenMint, "entry", positionId, "1h", enrichment);
  } catch (err) {
    console.error("[IndicatorVectors] Enriched entry snapshot failed:", err);
    await recordIndicatorSnapshot(tokenMint, "entry", positionId);
  }
}

export async function recordExitSnapshot(
  tokenMint: string,
  positionId: number,
  pnlPercent: number,
  clusterId?: string,
  signalWallet?: string | null,
  discoverySource?: string | null,
  entryTimestamp?: number,
  entryPrice?: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  try {
    const enrichment = await enrichSnapshot(
      tokenMint, "exit", positionId,
      signalWallet, clusterId, discoverySource,
      entryTimestamp, now, entryPrice
    );
    await recordIndicatorSnapshot(tokenMint, "exit", positionId, "1h", enrichment);
  } catch (err) {
    console.error("[IndicatorVectors] Enriched exit snapshot failed:", err);
    await recordIndicatorSnapshot(tokenMint, "exit", positionId);
  }

  if (!clusterId) return;

  const entrySnap = await db.select()
    .from(indicatorSnapshots)
    .where(and(
      eq(indicatorSnapshots.positionId, positionId),
      eq(indicatorSnapshots.snapshotType, "entry")
    ))
    .limit(1);

  const exitSnap = await db.select()
    .from(indicatorSnapshots)
    .where(and(
      eq(indicatorSnapshots.positionId, positionId),
      eq(indicatorSnapshots.snapshotType, "exit")
    ))
    .orderBy(desc(indicatorSnapshots.createdAt))
    .limit(1);

  if (!entrySnap[0]) return;

  const bucketId = getCurrentBucketId();
  const isWin = pnlPercent >= 0;

  const es = entrySnap[0];
  const xs = exitSnap[0];

  await db.insert(vectorUpdates).values({
    vectorType: "indicator",
    targetId: clusterId,
    signalType: isWin ? "indicator_win" : "indicator_loss",
    signalData: {
      positionId,
      tokenMint,
      pnlPercent,
      entry: {
        rsi: es.rsi,
        macdHistogram: es.macdHistogram,
        emaCrossSignal: es.emaCrossSignal,
        bollingerPosition: es.bollingerPosition,
        bollingerBandwidth: es.bollingerBandwidth,
        obvTrend: es.obvTrend,
        stochasticK: es.stochasticK,
        compositeScore: es.compositeScore,
      },
      exit: xs ? {
        rsi: xs.rsi,
        macdHistogram: xs.macdHistogram,
        emaCrossSignal: xs.emaCrossSignal,
        bollingerPosition: xs.bollingerPosition,
        bollingerBandwidth: xs.bollingerBandwidth,
        obvTrend: xs.obvTrend,
        stochasticK: xs.stochasticK,
        compositeScore: xs.compositeScore,
      } : null,
      context: {
        liquidityAtEntry: es.liquidityAtSnapshot,
        marketCapAtEntry: es.marketCapAtSnapshot,
        tokenAgeHours: es.tokenAgeHours,
        whaleCount: es.whaleCount,
        whaleAvgReputation: es.whaleAvgReputation,
        whaleNetSentiment: es.whaleNetSentiment,
        discoverySource: es.discoverySource,
        signalWalletWinRate: es.signalWalletWinRate,
        hourOfDay: es.hourOfDay,
        dayOfWeek: es.dayOfWeek,
        priceVelocity: es.priceVelocity,
        relativeVolume: es.relativeVolume,
        lifecycleStage: es.lifecycleStage,
        solCorrelation: es.solCorrelation,
        clusterCrowding: es.clusterCrowding,
      },
      journey: xs ? {
        priceHigh: xs.priceHigh,
        priceLow: xs.priceLow,
        maxDrawdownPercent: xs.maxDrawdownPercent,
        maxUnrealizedGainPercent: xs.maxUnrealizedGainPercent,
        holdDurationMinutes: xs.holdDurationMinutes,
        avgVolume: xs.avgVolume,
        totalVolume: xs.totalVolume,
      } : null,
    },
    weight: Math.abs(pnlPercent) > 50 ? 2.0 : 1.0,
    bucketId,
    processed: false,
    createdAt: now,
  });
}

export async function snapshotActivePositions(): Promise<number> {
  try {
    const openPositions = await db.select({
      id: paperPositions.id,
      tokenMint: paperPositions.tokenMint,
    })
      .from(paperPositions)
      .where(eq(paperPositions.status, "open"))
      .limit(100);

    let count = 0;
    for (const pos of openPositions) {
      const snapId = await recordIndicatorSnapshot(pos.tokenMint, "periodic", pos.id);
      if (snapId) count++;
    }

    if (count > 0) {
      console.log(`[IndicatorVectors] Periodic snapshots: ${count}/${openPositions.length} positions`);
    }
    return count;
  } catch (err) {
    console.error("[IndicatorVectors] Periodic snapshot failed:", err);
    return 0;
  }
}

function calculateDampening(sampleCount: number): number {
  return 1 / (1 + Math.log10(Math.max(1, sampleCount)));
}

function nudgeRange(
  currentLow: number,
  currentHigh: number,
  observedValue: number,
  isWin: boolean,
  dampening: number,
  learningRate: number = 0.15
): { low: number; high: number } {
  const effectiveRate = learningRate * dampening;

  if (isWin) {
    const mid = (currentLow + currentHigh) / 2;
    const newMid = mid + (observedValue - mid) * effectiveRate;
    const halfRange = (currentHigh - currentLow) / 2;
    return {
      low: newMid - halfRange,
      high: newMid + halfRange,
    };
  } else {
    if (observedValue >= currentLow && observedValue <= currentHigh) {
      const contractRate = effectiveRate * 0.3;
      const mid = (currentLow + currentHigh) / 2;
      if (observedValue < mid) {
        return { low: currentLow + (observedValue - currentLow) * contractRate, high: currentHigh };
      } else {
        return { low: currentLow, high: currentHigh - (currentHigh - observedValue) * contractRate };
      }
    }
    return { low: currentLow, high: currentHigh };
  }
}

function nudgePreference(
  current: string,
  observed: string,
  isWin: boolean,
  winCounts: Map<string, number>
): string {
  const key = observed;
  const currentCount = winCounts.get(key) || 0;
  if (isWin) {
    winCounts.set(key, currentCount + 1);
  }
  let bestOption = current;
  let bestCount = winCounts.get(current) || 0;
  for (const [option, count] of Array.from(winCounts.entries())) {
    if (count > bestCount) {
      bestOption = option;
      bestCount = count;
    }
  }
  return bestOption;
}

function nudgeAverage(current: number | null, observed: number, count: number, dampening: number): number {
  if (current === null) return observed;
  const rate = 0.15 * dampening;
  return current + (observed - current) * rate;
}

export async function processIndicatorVectorUpdates(bucketId: string): Promise<number> {
  const updates = await db.select()
    .from(vectorUpdates)
    .where(and(
      eq(vectorUpdates.vectorType, "indicator"),
      eq(vectorUpdates.bucketId, bucketId),
      eq(vectorUpdates.processed, false)
    ));

  if (updates.length === 0) return 0;

  const updatesByCluster = new Map<string, typeof updates>();
  for (const update of updates) {
    const current = updatesByCluster.get(update.targetId) || [];
    current.push(update);
    updatesByCluster.set(update.targetId, current);
  }

  let processed = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const [clusterId, clusterUpdates] of Array.from(updatesByCluster.entries())) {
    let ivec = await db.select()
      .from(indicatorVectors)
      .where(and(
        eq(indicatorVectors.clusterId, clusterId),
        eq(indicatorVectors.vectorType, "entry")
      ))
      .limit(1);

    if (!ivec[0]) {
      await db.insert(indicatorVectors).values({
        clusterId,
        vectorType: "entry",
        createdAt: now,
        updatedAt: now,
      });
      ivec = await db.select()
        .from(indicatorVectors)
        .where(and(
          eq(indicatorVectors.clusterId, clusterId),
          eq(indicatorVectors.vectorType, "entry")
        ))
        .limit(1);
    }

    if (!ivec[0]) continue;

    const vec = ivec[0];
    const sampleCount = vec.sampleCount || 0;
    const dampening = calculateDampening(sampleCount);

    let rsiLow = vec.optimalRsiLow ?? 25;
    let rsiHigh = vec.optimalRsiHigh ?? 45;
    let stochKLow = vec.optimalStochKLow ?? 15;
    let stochKHigh = vec.optimalStochKHigh ?? 40;
    let bwMin = vec.optimalBandwidthMin ?? 0.02;
    let bwMax = vec.optimalBandwidthMax ?? 0.15;
    let compositeMin = vec.optimalCompositeMin ?? 55;
    let macdMin = vec.optimalMacdHistogramMin ?? -0.001;

    let liqLow = vec.optimalLiquidityLow ?? 10000;
    let liqHigh = vec.optimalLiquidityHigh ?? 5000000;
    let mcapLow = vec.optimalMcapLow ?? 50000;
    let mcapHigh = vec.optimalMcapHigh ?? 50000000;
    let ageLow = vec.optimalTokenAgeLow ?? 1;
    let ageHigh = vec.optimalTokenAgeHigh ?? 720;
    let whaleSentLow = vec.optimalWhaleSentimentLow ?? -50;
    let whaleSentHigh = vec.optimalWhaleSentimentHigh ?? 100;
    let whaleCountLow = vec.optimalWhaleCountLow ?? 0;
    let whaleCountHigh = vec.optimalWhaleCountHigh ?? 20;
    let velLow = vec.optimalPriceVelocityLow ?? -0.05;
    let velHigh = vec.optimalPriceVelocityHigh ?? 0.05;
    let relVolLow = vec.optimalRelativeVolumeLow ?? 0.5;
    let relVolHigh = vec.optimalRelativeVolumeHigh ?? 5.0;

    let avgWinDD = vec.avgWinDrawdown ?? null;
    let avgLossDD = vec.avgLossDrawdown ?? null;
    let avgWinGain = vec.avgWinMaxGain ?? null;
    let avgWinHold = vec.avgWinHoldMinutes ?? null;
    let avgLossHold = vec.avgLossHoldMinutes ?? null;

    let winCount = vec.winCount || 0;
    let lossCount = vec.lossCount || 0;

    const emaCounts = new Map<string, number>();
    emaCounts.set(vec.preferredEmaCross || "bullish", winCount);
    const bollingerCounts = new Map<string, number>();
    bollingerCounts.set(vec.preferredBollingerPosition || "below", winCount);
    const obvCounts = new Map<string, number>();
    obvCounts.set(vec.preferredObvTrend || "accumulating", winCount);
    const discoveryCounts = new Map<string, number>();
    if (vec.preferredDiscoverySource) discoveryCounts.set(vec.preferredDiscoverySource, winCount);
    const lifecycleCounts = new Map<string, number>();
    if (vec.preferredLifecycleStage) lifecycleCounts.set(vec.preferredLifecycleStage, winCount);

    let preferredEma = vec.preferredEmaCross || "bullish";
    let preferredBollinger = vec.preferredBollingerPosition || "below";
    let preferredObv = vec.preferredObvTrend || "accumulating";
    let preferredDiscovery = vec.preferredDiscoverySource || "";
    let preferredLifecycle = vec.preferredLifecycleStage || "";

    const hourBuckets = new Map<number, { wins: number; total: number }>();

    for (const update of clusterUpdates) {
      const signalData = update.signalData as Record<string, any> | null;
      if (!signalData?.entry) continue;

      const entry = signalData.entry;
      const context = signalData.context || {};
      const journey = signalData.journey || {};
      const isWin = update.signalType === "indicator_win";

      if (isWin) winCount++;
      else lossCount++;

      if (entry.rsi != null) {
        const r = nudgeRange(rsiLow, rsiHigh, entry.rsi, isWin, dampening);
        rsiLow = r.low;
        rsiHigh = r.high;
      }

      if (entry.stochasticK != null) {
        const r = nudgeRange(stochKLow, stochKHigh, entry.stochasticK, isWin, dampening);
        stochKLow = r.low;
        stochKHigh = r.high;
      }

      if (entry.bollingerBandwidth != null) {
        const r = nudgeRange(bwMin, bwMax, entry.bollingerBandwidth, isWin, dampening);
        bwMin = r.low;
        bwMax = r.high;
      }

      if (entry.compositeScore != null) {
        if (isWin && entry.compositeScore < compositeMin) {
          compositeMin += (entry.compositeScore - compositeMin) * 0.1 * dampening;
        } else if (!isWin && entry.compositeScore >= compositeMin) {
          compositeMin += 1 * dampening;
        }
      }

      if (entry.macdHistogram != null) {
        if (isWin && entry.macdHistogram < macdMin) {
          macdMin += (entry.macdHistogram - macdMin) * 0.1 * dampening;
        }
      }

      if (entry.emaCrossSignal) {
        preferredEma = nudgePreference(preferredEma, entry.emaCrossSignal, isWin, emaCounts);
      }
      if (entry.bollingerPosition) {
        preferredBollinger = nudgePreference(preferredBollinger, entry.bollingerPosition, isWin, bollingerCounts);
      }
      if (entry.obvTrend) {
        preferredObv = nudgePreference(preferredObv, entry.obvTrend, isWin, obvCounts);
      }

      if (context.liquidityAtEntry != null) {
        const r = nudgeRange(liqLow, liqHigh, context.liquidityAtEntry, isWin, dampening, 0.1);
        liqLow = r.low;
        liqHigh = r.high;
      }

      if (context.marketCapAtEntry != null) {
        const r = nudgeRange(mcapLow, mcapHigh, context.marketCapAtEntry, isWin, dampening, 0.1);
        mcapLow = r.low;
        mcapHigh = r.high;
      }

      if (context.tokenAgeHours != null) {
        const r = nudgeRange(ageLow, ageHigh, context.tokenAgeHours, isWin, dampening, 0.1);
        ageLow = r.low;
        ageHigh = r.high;
      }

      if (context.whaleNetSentiment != null) {
        const r = nudgeRange(whaleSentLow, whaleSentHigh, context.whaleNetSentiment, isWin, dampening, 0.1);
        whaleSentLow = r.low;
        whaleSentHigh = r.high;
      }

      if (context.whaleCount != null) {
        const r = nudgeRange(whaleCountLow, whaleCountHigh, context.whaleCount, isWin, dampening, 0.1);
        whaleCountLow = r.low;
        whaleCountHigh = r.high;
      }

      if (context.priceVelocity != null) {
        const r = nudgeRange(velLow, velHigh, context.priceVelocity, isWin, dampening, 0.1);
        velLow = r.low;
        velHigh = r.high;
      }

      if (context.relativeVolume != null) {
        const r = nudgeRange(relVolLow, relVolHigh, context.relativeVolume, isWin, dampening, 0.1);
        relVolLow = r.low;
        relVolHigh = r.high;
      }

      if (context.discoverySource) {
        preferredDiscovery = nudgePreference(preferredDiscovery, context.discoverySource, isWin, discoveryCounts);
      }

      if (context.lifecycleStage) {
        preferredLifecycle = nudgePreference(preferredLifecycle, context.lifecycleStage, isWin, lifecycleCounts);
      }

      if (context.hourOfDay != null) {
        const bucket = hourBuckets.get(context.hourOfDay) || { wins: 0, total: 0 };
        bucket.total++;
        if (isWin) bucket.wins++;
        hourBuckets.set(context.hourOfDay, bucket);
      }

      if (journey.maxDrawdownPercent != null) {
        if (isWin) {
          avgWinDD = nudgeAverage(avgWinDD, journey.maxDrawdownPercent, winCount, dampening);
        } else {
          avgLossDD = nudgeAverage(avgLossDD, journey.maxDrawdownPercent, lossCount, dampening);
        }
      }

      if (journey.maxUnrealizedGainPercent != null && isWin) {
        avgWinGain = nudgeAverage(avgWinGain, journey.maxUnrealizedGainPercent, winCount, dampening);
      }

      if (journey.holdDurationMinutes != null) {
        if (isWin) {
          avgWinHold = nudgeAverage(avgWinHold, journey.holdDurationMinutes, winCount, dampening);
        } else {
          avgLossHold = nudgeAverage(avgLossHold, journey.holdDurationMinutes, lossCount, dampening);
        }
      }
    }

    let preferredHour: number | null = vec.preferredHourOfDay ?? null;
    if (hourBuckets.size > 0) {
      let bestRate = 0;
      for (const [hour, data] of Array.from(hourBuckets.entries())) {
        if (data.total >= 2) {
          const rate = data.wins / data.total;
          if (rate > bestRate) {
            bestRate = rate;
            preferredHour = hour;
          }
        }
      }
    }

    const totalSamples = winCount + lossCount;
    const confidence = totalSamples >= 20 ? Math.min(0.95, 0.5 + (winCount / totalSamples - 0.5) * 0.9) :
                       totalSamples >= 5 ? 0.3 + (totalSamples / 20) * 0.2 : 0.1 + totalSamples * 0.04;

    await db.update(indicatorVectors)
      .set({
        optimalRsiLow: Math.round(rsiLow * 100) / 100,
        optimalRsiHigh: Math.round(rsiHigh * 100) / 100,
        optimalStochKLow: Math.round(stochKLow * 100) / 100,
        optimalStochKHigh: Math.round(stochKHigh * 100) / 100,
        optimalBandwidthMin: Math.round(bwMin * 10000) / 10000,
        optimalBandwidthMax: Math.round(bwMax * 10000) / 10000,
        optimalCompositeMin: Math.round(compositeMin * 100) / 100,
        optimalMacdHistogramMin: macdMin,
        preferredEmaCross: preferredEma,
        preferredBollingerPosition: preferredBollinger,
        preferredObvTrend: preferredObv,
        winCount,
        lossCount,
        sampleCount: totalSamples,
        confidence: Math.round(confidence * 1000) / 1000,
        updatedAt: now,
        optimalLiquidityLow: Math.round(liqLow),
        optimalLiquidityHigh: Math.round(liqHigh),
        optimalMcapLow: Math.round(mcapLow),
        optimalMcapHigh: Math.round(mcapHigh),
        optimalTokenAgeLow: Math.round(ageLow * 10) / 10,
        optimalTokenAgeHigh: Math.round(ageHigh * 10) / 10,
        optimalWhaleSentimentLow: Math.round(whaleSentLow * 10) / 10,
        optimalWhaleSentimentHigh: Math.round(whaleSentHigh * 10) / 10,
        optimalWhaleCountLow: Math.round(Math.max(0, whaleCountLow)),
        optimalWhaleCountHigh: Math.round(whaleCountHigh),
        preferredDiscoverySource: preferredDiscovery || null,
        preferredHourOfDay: preferredHour,
        preferredLifecycleStage: preferredLifecycle || null,
        optimalPriceVelocityLow: Math.round(velLow * 10000) / 10000,
        optimalPriceVelocityHigh: Math.round(velHigh * 10000) / 10000,
        optimalRelativeVolumeLow: Math.round(relVolLow * 100) / 100,
        optimalRelativeVolumeHigh: Math.round(relVolHigh * 100) / 100,
        avgWinDrawdown: avgWinDD != null ? Math.round(avgWinDD * 100) / 100 : null,
        avgLossDrawdown: avgLossDD != null ? Math.round(avgLossDD * 100) / 100 : null,
        avgWinMaxGain: avgWinGain != null ? Math.round(avgWinGain * 100) / 100 : null,
        avgWinHoldMinutes: avgWinHold != null ? Math.round(avgWinHold) : null,
        avgLossHoldMinutes: avgLossHold != null ? Math.round(avgLossHold) : null,
      })
      .where(eq(indicatorVectors.id, vec.id));

    processed += clusterUpdates.length;
  }

  const updateIds = updates.map(u => u.id);
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(inArray(vectorUpdates.id, updateIds));

  if (processed > 0) {
    console.log(`[IndicatorVectors] Processed ${processed} enriched indicator updates across ${updatesByCluster.size} clusters`);
  }

  return processed;
}

export async function scoreTokenAgainstCluster(
  tokenMint: string,
  clusterId: string
): Promise<{ match: number; details: string } | null> {
  try {
    const indicators = await getIndicators(tokenMint);
    if (!indicators) return null;

    const vec = await db.select()
      .from(indicatorVectors)
      .where(and(
        eq(indicatorVectors.clusterId, clusterId),
        eq(indicatorVectors.vectorType, "entry")
      ))
      .limit(1);

    if (!vec[0] || (vec[0].sampleCount || 0) < 3) return null;

    const v = vec[0];
    let matchScore = 0;
    let totalWeight = 0;
    const details: string[] = [];

    if (indicators.rsi && v.optimalRsiLow != null && v.optimalRsiHigh != null) {
      totalWeight += 2;
      if (indicators.rsi.value >= v.optimalRsiLow && indicators.rsi.value <= v.optimalRsiHigh) {
        matchScore += 2;
        details.push(`RSI ${indicators.rsi.value.toFixed(0)} in range`);
      } else {
        const dist = indicators.rsi.value < v.optimalRsiLow
          ? v.optimalRsiLow - indicators.rsi.value
          : indicators.rsi.value - v.optimalRsiHigh;
        const partial = Math.max(0, 1 - dist / 30);
        matchScore += partial * 2;
        details.push(`RSI ${indicators.rsi.value.toFixed(0)} outside (${partial > 0.5 ? "close" : "far"})`);
      }
    }

    if (indicators.composite) {
      totalWeight += 2;
      if (indicators.composite.score >= (v.optimalCompositeMin ?? 55)) {
        matchScore += 2;
        details.push(`Composite ${indicators.composite.score} above min`);
      } else {
        const diff = (v.optimalCompositeMin ?? 55) - indicators.composite.score;
        const partial = Math.max(0, 1 - diff / 25);
        matchScore += partial * 2;
        details.push(`Composite ${indicators.composite.score} below min`);
      }
    }

    if (indicators.ema && v.preferredEmaCross) {
      totalWeight += 1.5;
      if (indicators.ema.signal === v.preferredEmaCross) {
        matchScore += 1.5;
        details.push(`EMA ${indicators.ema.signal} matches`);
      }
    }

    if (indicators.bollinger && v.preferredBollingerPosition) {
      totalWeight += 1;
      if (indicators.bollinger.position === v.preferredBollingerPosition) {
        matchScore += 1;
        details.push(`Bollinger ${indicators.bollinger.position} matches`);
      }
    }

    if (indicators.obv && v.preferredObvTrend) {
      totalWeight += 1;
      if (indicators.obv.trend === v.preferredObvTrend) {
        matchScore += 1;
        details.push(`OBV ${indicators.obv.trend} matches`);
      }
    }

    if (indicators.stochastic && v.optimalStochKLow != null && v.optimalStochKHigh != null) {
      totalWeight += 1.5;
      if (indicators.stochastic.k >= v.optimalStochKLow && indicators.stochastic.k <= v.optimalStochKHigh) {
        matchScore += 1.5;
        details.push(`Stoch K ${indicators.stochastic.k.toFixed(0)} in range`);
      } else {
        const dist = indicators.stochastic.k < v.optimalStochKLow
          ? v.optimalStochKLow - indicators.stochastic.k
          : indicators.stochastic.k - v.optimalStochKHigh;
        const partial = Math.max(0, 1 - dist / 25);
        matchScore += partial * 1.5;
      }
    }

    const normalizedMatch = totalWeight > 0 ? (matchScore / totalWeight) * 100 : 0;
    const confidenceAdjusted = normalizedMatch * (v.confidence ?? 0.5);

    return {
      match: Math.round(confidenceAdjusted * 100) / 100,
      details: `${details.join(", ")} [conf=${((v.confidence ?? 0.5) * 100).toFixed(0)}%, samples=${v.sampleCount}]`,
    };
  } catch (err) {
    console.error("[IndicatorVectors] Score failed:", err);
    return null;
  }
}

export async function getIndicatorVectorStats(): Promise<{
  totalVectors: number;
  totalSamples: number;
  avgConfidence: number;
  topPatterns: { clusterId: string; confidence: number; winRate: number; samples: number; learnedContext: Record<string, any> }[];
}> {
  const vectors = await db.select().from(indicatorVectors);

  const totalSamples = vectors.reduce((s, v) => s + (v.sampleCount || 0), 0);
  const avgConfidence = vectors.length > 0
    ? vectors.reduce((s, v) => s + (v.confidence || 0), 0) / vectors.length
    : 0;

  const topPatterns = vectors
    .filter(v => (v.sampleCount || 0) >= 3)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 10)
    .map(v => ({
      clusterId: v.clusterId,
      confidence: v.confidence || 0,
      winRate: (v.winCount || 0) > 0 && (v.sampleCount || 0) > 0
        ? (v.winCount || 0) / (v.sampleCount || 0)
        : 0,
      samples: v.sampleCount || 0,
      learnedContext: {
        optimalLiquidity: v.optimalLiquidityLow != null ? `$${v.optimalLiquidityLow}-$${v.optimalLiquidityHigh}` : null,
        optimalMcap: v.optimalMcapLow != null ? `$${v.optimalMcapLow}-$${v.optimalMcapHigh}` : null,
        optimalTokenAge: v.optimalTokenAgeLow != null ? `${v.optimalTokenAgeLow}-${v.optimalTokenAgeHigh}h` : null,
        whaleSentiment: v.optimalWhaleSentimentLow != null ? `${v.optimalWhaleSentimentLow} to ${v.optimalWhaleSentimentHigh}` : null,
        preferredSource: v.preferredDiscoverySource,
        preferredHour: v.preferredHourOfDay,
        preferredLifecycle: v.preferredLifecycleStage,
        avgWinDrawdown: v.avgWinDrawdown != null ? `${v.avgWinDrawdown}%` : null,
        avgWinMaxGain: v.avgWinMaxGain != null ? `${v.avgWinMaxGain}%` : null,
        avgWinHoldTime: v.avgWinHoldMinutes != null ? `${v.avgWinHoldMinutes}min` : null,
      },
    }));

  return {
    totalVectors: vectors.length,
    totalSamples,
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    topPatterns,
  };
}
