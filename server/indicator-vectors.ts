import { db } from "./db";
import { indicatorSnapshots, indicatorVectors, vectorUpdates, paperPositions, strategyClusters } from "@shared/schema";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { getIndicators, type IndicatorResult } from "./technical-indicators";

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
  timeframe: string = "1h"
): Promise<number | null> {
  try {
    const indicators = await getIndicators(tokenMint, timeframe);
    if (!indicators) return null;

    const flat = flattenIndicators(indicators);
    const now = Math.floor(Date.now() / 1000);
    const bucketId = getCurrentBucketId();

    const [row] = await db.insert(indicatorSnapshots).values({
      tokenMint,
      positionId: positionId ?? null,
      snapshotType,
      timeframe,
      ...flat,
      priceAtSnapshot: indicators.bollinger?.middle ?? indicators.ema?.ema12 ?? null,
      bucketId,
      createdAt: now,
    }).returning({ id: indicatorSnapshots.id });

    return row?.id ?? null;
  } catch (err) {
    console.error("[IndicatorVectors] Snapshot failed:", err);
    return null;
  }
}

export async function recordEntrySnapshot(tokenMint: string, positionId: number): Promise<void> {
  await recordIndicatorSnapshot(tokenMint, "entry", positionId);
}

export async function recordExitSnapshot(
  tokenMint: string,
  positionId: number,
  pnlPercent: number,
  clusterId?: string
): Promise<void> {
  await recordIndicatorSnapshot(tokenMint, "exit", positionId);

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

  const now = Math.floor(Date.now() / 1000);
  const bucketId = getCurrentBucketId();
  const isWin = pnlPercent >= 0;

  await db.insert(vectorUpdates).values({
    vectorType: "indicator",
    targetId: clusterId,
    signalType: isWin ? "indicator_win" : "indicator_loss",
    signalData: {
      positionId,
      tokenMint,
      pnlPercent,
      entry: {
        rsi: entrySnap[0].rsi,
        macdHistogram: entrySnap[0].macdHistogram,
        emaCrossSignal: entrySnap[0].emaCrossSignal,
        bollingerPosition: entrySnap[0].bollingerPosition,
        bollingerBandwidth: entrySnap[0].bollingerBandwidth,
        obvTrend: entrySnap[0].obvTrend,
        stochasticK: entrySnap[0].stochasticK,
        compositeScore: entrySnap[0].compositeScore,
      },
      exit: exitSnap[0] ? {
        rsi: exitSnap[0].rsi,
        macdHistogram: exitSnap[0].macdHistogram,
        emaCrossSignal: exitSnap[0].emaCrossSignal,
        bollingerPosition: exitSnap[0].bollingerPosition,
        bollingerBandwidth: exitSnap[0].bollingerBandwidth,
        obvTrend: exitSnap[0].obvTrend,
        stochasticK: exitSnap[0].stochasticK,
        compositeScore: exitSnap[0].compositeScore,
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

    let winCount = vec.winCount || 0;
    let lossCount = vec.lossCount || 0;

    const emaCounts = new Map<string, number>();
    emaCounts.set(vec.preferredEmaCross || "bullish", winCount);
    const bollingerCounts = new Map<string, number>();
    bollingerCounts.set(vec.preferredBollingerPosition || "below", winCount);
    const obvCounts = new Map<string, number>();
    obvCounts.set(vec.preferredObvTrend || "accumulating", winCount);

    let preferredEma = vec.preferredEmaCross || "bullish";
    let preferredBollinger = vec.preferredBollingerPosition || "below";
    let preferredObv = vec.preferredObvTrend || "accumulating";

    for (const update of clusterUpdates) {
      const signalData = update.signalData as Record<string, any> | null;
      if (!signalData?.entry) continue;

      const entry = signalData.entry;
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
      })
      .where(eq(indicatorVectors.id, vec.id));

    processed += clusterUpdates.length;
  }

  const updateIds = updates.map(u => u.id);
  await db.update(vectorUpdates)
    .set({ processed: true, processedAt: now })
    .where(inArray(vectorUpdates.id, updateIds));

  if (processed > 0) {
    console.log(`[IndicatorVectors] Processed ${processed} indicator updates across ${updatesByCluster.size} clusters`);
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
  topPatterns: { clusterId: string; confidence: number; winRate: number; samples: number }[];
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
    }));

  return {
    totalVectors: vectors.length,
    totalSamples,
    avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    topPatterns,
  };
}
