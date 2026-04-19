import { db } from "./db";
import { eq, gte, lte, and } from "drizzle-orm";
import { priceHistoryCache, tokenOutcomes, swaps, tokenDataPool } from "@shared/schema";
import * as tf from "@tensorflow/tfjs";

// =====================
// ANN MODEL ARCHITECTURE
// =====================

interface ANNConfig {
  inputShape: number;
  hiddenUnits: number[];
  outputShape: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
}

const ANN_CONFIG: ANNConfig = {
  inputShape: 50, // 50 early-dynamics features
  hiddenUnits: [128, 128],
  outputShape: 1, // Binary: success probability
  learningRate: 0.001,
  epochs: 10,
  batchSize: 32,
};

// =====================
// FEATURE EXTRACTION
// =====================

interface TokenEarlyDynamics {
  // Price dynamics (first 10 min)
  priceOpen: number;
  priceHigh: number;
  priceLow: number;
  priceClose: number;
  volumeTotal: number;
  volatility: number;
  priceSlope: number;

  // Volume trajectory
  volumeAcceleration: number;
  volumeInFirstMin: number;
  volumeInFirst5Min: number;

  // Whale patterns
  whaleEntryCount: number;
  whaleEntryTiming: number; // Seconds from launch to first whale entry
  whaleClusteringScore: number; // 0-1, how coordinated are whale entries

  // Holder distribution
  holderCount: number;
  holderConcentration: number; // % held by top 10
  uniqueBuyerCount: number;
  buyerDiversityScore: number; // 0-1, how spread out are buyers

  // Cluster activity
  clusterActivityCount: number;
  clusterActivityTiming: number;
  clusterCoordinationScore: number; // 0-1, synchronization level

  // Discovery source
  isPumpFun: number; // 1 or 0
  isDirectRaydium: number; // 1 or 0
  isTrendingSource: number; // 1 or 0

  // Bonding curve specifics (if pre-grad)
  bondingCurveProgress: number; // 0-1
  bondingBuyerGrowthRate: number;
  bondingVelocity: number;

  // Additional technical metrics
  priceChangePercent: number;
  volumePerBuyer: number;
  entriesPerBuyer: number;
  spreadBetweenEntries: number; // Price range across entries
}

/**
 * Extract 50 features from token early dynamics (first 10 minutes)
 * Sources: priceHistoryCache, swaps, tokenDataPool
 */
export async function extractEarlyDynamicsFeatures(
  tokenMint: string,
  launchTimestamp: number
): Promise<number[]> {
  const tenMinutesLater = launchTimestamp + 600; // 10 minutes = 600 seconds

  // Fetch 1-minute candles for first 10 minutes
  const candles = await db
    .select()
    .from(priceHistoryCache)
    .where(
      and(
        eq(priceHistoryCache.tokenMint, tokenMint),
        eq(priceHistoryCache.timeframe, "1m"),
        gte(priceHistoryCache.timestamp, launchTimestamp),
        lte(priceHistoryCache.timestamp, tenMinutesLater)
      )
    );

  // Fetch all swaps for token in first 10 minutes
  const trades = await db
    .select()
    .from(swaps)
    .where(
      and(
        eq(swaps.toToken, tokenMint),
        gte(swaps.timestamp, launchTimestamp),
        lte(swaps.timestamp, tenMinutesLater)
      )
    );

  const features: number[] = [];

  // === PRICE DYNAMICS ===
  if (candles.length > 0) {
    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];

    features.push(firstCandle.open ?? 0); // priceOpen
    features.push(Math.max(...candles.map(c => c.high ?? 0))); // priceHigh
    features.push(Math.min(...candles.map(c => c.low ?? 0))); // priceLow
    features.push(lastCandle.close ?? 0); // priceClose

    const totalVolume = candles.reduce((sum, c) => sum + (c.volume ?? 0), 0);
    features.push(totalVolume); // volumeTotal

    // Volatility = std dev of close prices
    const closes = candles.map(c => c.close ?? 0);
    const meanClose = closes.reduce((a, b) => a + b) / closes.length;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - meanClose, 2), 0) / closes.length;
    features.push(Math.sqrt(variance)); // volatility

    // Price slope (linear regression)
    const xValues = closes.map((_, i) => i);
    const slope = calculateLinearSlope(xValues, closes);
    features.push(slope); // priceSlope
  } else {
    // Pad with zeros if no candles
    for (let i = 0; i < 7; i++) features.push(0);
  }

  // === VOLUME TRAJECTORY ===
  if (candles.length > 1) {
    const firstVolume = candles[0].volume ?? 0;
    const volumes = candles.map(c => c.volume ?? 0);
    const lastVolume = volumes[volumes.length - 1];
    const acceleration = lastVolume / (firstVolume + 0.0001); // Avoid division by zero
    features.push(acceleration); // volumeAcceleration

    // Volume in specific time windows
    const firstMinuteVolume = candles[0].volume ?? 0;
    const first5MinVolume = volumes.slice(0, 5).reduce((a, b) => a + b, 0);
    features.push(firstMinuteVolume); // volumeInFirstMin
    features.push(first5MinVolume); // volumeInFirst5Min
  } else {
    features.push(0, 0, 0);
  }

  // === WHALE PATTERNS ===
  const largeTrades = trades.filter(t => (t.fromAmount ?? 0) > 0.1); // Arbitrary whale threshold
  features.push(largeTrades.length); // whaleEntryCount

  if (largeTrades.length > 0) {
    const firstWhaleTime = largeTrades[0].timestamp;
    features.push(firstWhaleTime - launchTimestamp); // whaleEntryTiming

    // Clustering: are whales entering at same time?
    const whaleTimings = largeTrades.map(t => t.timestamp - launchTimestamp);
    const timingStdDev = calculateStdDev(whaleTimings);
    const clusteringScore = 1 - Math.min(1, timingStdDev / 60); // Lower stddev = higher clustering
    features.push(clusteringScore); // whaleClusteringScore
  } else {
    features.push(0, 0);
  }

  // === HOLDER DISTRIBUTION ===
  const uniqueHolders = new Set(trades.map(t => t.source));
  features.push(uniqueHolders.size); // holderCount

  // Holder concentration: top 10 holders / total volume
  const holderVolumes = new Map<string, number>();
  trades.forEach(t => {
    const holder = t.source;
    holderVolumes.set(holder, (holderVolumes.get(holder) ?? 0) + (t.fromAmount ?? 0));
  });

  const topHolderVolumes = Array.from(holderVolumes.values())
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((a, b) => a + b, 0);
  const totalVolume = Array.from(holderVolumes.values()).reduce((a, b) => a + b, 0);
  const concentration = totalVolume > 0 ? topHolderVolumes / totalVolume : 0;
  features.push(concentration); // holderConcentration

  // Unique buyers (different from total swaps)
  features.push(uniqueHolders.size); // uniqueBuyerCount

  // Buyer diversity: entropy of distribution
  const buyerDiversity = calculateEntropy(Array.from(holderVolumes.values()));
  features.push(buyerDiversity); // buyerDiversityScore (0-1 normalized)

  // === CLUSTER ACTIVITY ===
  // (This would require cluster detection data - placeholder for now)
  features.push(0); // clusterActivityCount (TODO: integrate with cluster detection)
  features.push(0); // clusterActivityTiming
  features.push(0); // clusterCoordinationScore

  // === DISCOVERY SOURCE ===
  // (Would need metadata - placeholder)
  features.push(0); // isPumpFun
  features.push(0); // isDirectRaydium
  features.push(0); // isTrendingSource

  // === BONDING CURVE SPECIFICS ===
  // (Would need bonding curve data)
  features.push(0); // bondingCurveProgress
  features.push(0); // bondingBuyerGrowthRate
  features.push(0); // bondingVelocity

  // === ADDITIONAL METRICS ===
  if (candles.length > 0 && candles[0].open) {
    const priceChange = ((candles[candles.length - 1].close ?? 0) - candles[0].open) / candles[0].open;
    features.push(priceChange); // priceChangePercent
  } else {
    features.push(0);
  }

  const avgVolumePerBuyer = totalVolume / (uniqueHolders.size + 1);
  features.push(avgVolumePerBuyer);

  const avgEntriesPerBuyer = trades.length / (uniqueHolders.size + 1);
  features.push(avgEntriesPerBuyer);

  // Spread between entries
  const tradePrices = candles.map(c => c.close ?? 0).filter(p => p > 0);
  const spread = tradePrices.length > 0 ? (Math.max(...tradePrices) - Math.min(...tradePrices)) / Math.min(...tradePrices) : 0;
  features.push(spread);

  // Pad to exactly 50 features
  while (features.length < 50) {
    features.push(0);
  }

  // Trim if necessary
  return features.slice(0, 50);
}

// =====================
// ANN MODEL
// =====================

let model: tf.Sequential | null = null;

/**
 * Create or get the ANN model
 */
export function getOrCreateModel(): tf.Sequential {
  if (model) return model;

  model = tf.sequential({
    layers: [
      tf.layers.dense({
        inputShape: [ANN_CONFIG.inputShape],
        units: ANN_CONFIG.hiddenUnits[0],
        activation: "relu",
      }),
      tf.layers.dropout({ rate: 0.2 }),
      tf.layers.dense({
        units: ANN_CONFIG.hiddenUnits[1],
        activation: "relu",
      }),
      tf.layers.dropout({ rate: 0.2 }),
      tf.layers.dense({
        units: ANN_CONFIG.outputShape,
        activation: "sigmoid",
      }),
    ],
  });

  model.compile({
    optimizer: tf.train.adam(ANN_CONFIG.learningRate),
    loss: "binaryCrossentropy",
    metrics: ["accuracy"],
  });

  return model;
}

/**
 * Train ANN on historical tokens with known outcomes
 * Returns accuracy and loss metrics
 */
export async function trainANNModel(
  minOutcomesRequired: number = 100
): Promise<{ accuracy: number; loss: number; samplesUsed: number }> {
  console.log("[ANN] Starting training...");

  // Fetch tokens with outcomes (winners)
  const winningTokens = await db
    .select()
    .from(tokenOutcomes)
    .where(
      and(
        gte(tokenOutcomes.earlyBuyerMedianMultiplier, 2), // "Won" = 2x+
        gte(tokenOutcomes.timeToPeakMinutes, 1) // Has timing data
      )
    )
    .limit(1000);

  // Fetch tokens with poor outcomes (losers)
  const losingTokens = await db
    .select()
    .from(tokenOutcomes)
    .where(lte(tokenOutcomes.earlyBuyerMedianMultiplier, 1))
    .limit(1000);

  if (winningTokens.length + losingTokens.length < minOutcomesRequired) {
    console.warn(`[ANN] Insufficient outcome data (${winningTokens.length + losingTokens.length} vs ${minOutcomesRequired} required)`);
    return { accuracy: 0, loss: 0, samplesUsed: 0 };
  }

  // Extract features and labels
  const features: number[][] = [];
  const labels: number[] = [];

  // Process winning tokens (label = 1)
  for (const token of winningTokens) {
    if (!token.tokenMint) continue;

    // Need to find launch timestamp - placeholder
    const launchTimestamp = token.createdAt || Math.floor(Date.now() / 1000) - 3600;

    try {
      const feat = await extractEarlyDynamicsFeatures(token.tokenMint, launchTimestamp);
      features.push(feat);
      labels.push(1);
    } catch (error) {
      console.warn(`[ANN] Failed to extract features for ${token.tokenMint}`);
    }
  }

  // Process losing tokens (label = 0)
  for (const token of losingTokens) {
    if (!token.tokenMint) continue;

    const launchTimestamp = token.createdAt || Math.floor(Date.now() / 1000) - 3600;

    try {
      const feat = await extractEarlyDynamicsFeatures(token.tokenMint, launchTimestamp);
      features.push(feat);
      labels.push(0);
    } catch (error) {
      console.warn(`[ANN] Failed to extract features for ${token.tokenMint}`);
    }
  }

  if (features.length < minOutcomesRequired) {
    console.warn(`[ANN] Failed to extract features for minimum required tokens`);
    return { accuracy: 0, loss: 0, samplesUsed: 0 };
  }

  // Convert to tensors
  const xs = tf.tensor2d(features);
  const ys = tf.tensor2d(labels, [labels.length, 1]);

  // Train model
  const m = getOrCreateModel();
  const history = await m.fit(xs, ys, {
    epochs: ANN_CONFIG.epochs,
    batchSize: ANN_CONFIG.batchSize,
    verbose: 0,
  });

  const finalAccuracy = (history.history.acc as number[])[history.history.acc.length - 1];
  const finalLoss = (history.history.loss as number[])[history.history.loss.length - 1];

  console.log(`[ANN] Training complete: accuracy=${finalAccuracy.toFixed(3)}, loss=${finalLoss.toFixed(3)}, samples=${features.length}`);

  // Cleanup tensors
  xs.dispose();
  ys.dispose();

  return { accuracy: finalAccuracy, loss: finalLoss, samplesUsed: features.length };
}

/**
 * Predict success probability for a new token
 */
export async function predictTokenSuccess(
  tokenMint: string,
  launchTimestamp: number
): Promise<number> {
  try {
    const features = await extractEarlyDynamicsFeatures(tokenMint, launchTimestamp);
    const m = getOrCreateModel();

    const input = tf.tensor2d([features]);
    const prediction = m.predict(input) as tf.Tensor;
    const score = (await prediction.data())[0];

    input.dispose();
    prediction.dispose();

    return Math.max(0, Math.min(1, score)); // Clamp to [0, 1]
  } catch (error) {
    console.error(`[ANN] Prediction failed for ${tokenMint}:`, error);
    return 0.5; // Default to neutral confidence
  }
}

// =====================
// HELPER FUNCTIONS
// =====================

function calculateLinearSlope(x: number[], y: number[]): number {
  if (x.length < 2) return 0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return isFinite(slope) ? slope : 0;
}

function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function calculateEntropy(values: number[]): number {
  if (values.length === 0) return 0;

  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  let entropy = 0;
  for (const v of values) {
    if (v > 0) {
      const p = v / total;
      entropy -= p * Math.log2(p);
    }
  }

  // Normalize to 0-1
  const maxEntropy = Math.log2(values.length);
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}
