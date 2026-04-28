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
  inputShape: 26, // 26 refined early-dynamics features (price, volume, whale, holder, creator, timing)
  hiddenUnits: [128, 64],
  outputShape: 1, // Binary: success probability (0.0-1.0)
  learningRate: 0.001,
  epochs: 10,
  batchSize: 32,
};

// =====================
// FEATURE EXTRACTION
// =====================

interface TokenEarlyDynamics {
  // Price dynamics (first 10 min) - 4 dims
  priceHigh: number;
  priceLow: number;
  priceClose: number;
  priceSlope: number; // Linear regression of close prices

  // Volume trajectory - 4 dims
  volumeTotal: number;
  volumeAcceleration: number;
  volumeInFirstMin: number;
  volumeInFirst5Min: number;

  // Whale patterns - 3 dims
  whaleEntryCount: number;
  whaleEntryTiming: number; // Seconds from launch to first whale entry
  whaleClusteringScore: number; // 0-1, how coordinated are whale entries

  // Holder distribution - 2 dims
  holderConcentration: number; // % held by top 10
  buyerDiversityScore: number; // 0-1, normalized entropy of buyer distribution

  // Buyer metrics - 3 dims
  volumePerBuyer: number;
  entriesPerBuyer: number;
  spreadBetweenEntries: number; // Price range across entries

  // Price movement - 1 dim
  priceChangePercent: number;

  // Creator signals - 2 dims
  creatorSuccessRate: number; // 0.0-1.0, win rate on previous tokens
  creatorTokenLockPercent: number; // 0-100, % of supply locked

  // Liquidity - 1 dim
  liquidityDepthMetric: number; // Normalized measure of available liquidity

  // Launch timing - 2 dims
  launchHourOfDay: number; // 0-23
  launchDayOfWeek: number; // 0-6
}

/**
 * Extract 26 core features from token early dynamics (first 10 minutes)
 * Matches refined fingerprint dimensions optimized for archetype clustering
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

  // === PRICE DYNAMICS (4 features) ===
  let priceHigh = 0, priceLow = Infinity, priceClose = 0, priceSlope = 0;

  if (candles.length > 0) {
    priceHigh = Math.max(...candles.map(c => c.high ?? 0));
    priceLow = Math.min(...candles.map(c => c.low ?? 0));
    priceClose = candles[candles.length - 1].close ?? 0;

    // Price slope via linear regression
    const closes = candles.map(c => c.close ?? 0);
    const xValues = closes.map((_, i) => i);
    priceSlope = calculateLinearSlope(xValues, closes);
  } else {
    priceLow = 0;
  }

  features.push(priceHigh, priceLow, priceClose, priceSlope);

  // === VOLUME TRAJECTORY (4 features) ===
  let volumeTotal = 0, volumeAcceleration = 0, volumeFirstMin = 0, volumeFirst5Min = 0;

  if (candles.length > 0) {
    const volumes = candles.map(c => c.volume ?? 0);
    volumeTotal = volumes.reduce((a, b) => a + b, 0);
    volumeFirstMin = volumes[0] ?? 0;
    volumeFirst5Min = volumes.slice(0, 5).reduce((a, b) => a + b, 0);

    if (volumes.length > 1) {
      const firstVol = volumes[0] ?? 0.0001;
      const lastVol = volumes[volumes.length - 1] ?? 0;
      volumeAcceleration = lastVol / firstVol;
    }
  }

  features.push(volumeTotal, volumeAcceleration, volumeFirstMin, volumeFirst5Min);

  // === WHALE PATTERNS (3 features) ===
  const largeTrades = trades.filter(t => (t.fromAmount ?? 0) > 0.1); // 0.1 SOL threshold
  const whaleCount = largeTrades.length;
  let whaleEntryTiming = 0, whaleClusteringScore = 0;

  if (whaleCount > 0) {
    const firstWhaleTime = largeTrades[0].timestamp;
    whaleEntryTiming = firstWhaleTime - launchTimestamp;

    // Clustering: std dev of whale entry timings
    const whaleTimings = largeTrades.map(t => t.timestamp - launchTimestamp);
    const timingStdDev = calculateStdDev(whaleTimings);
    // Normalize: lower stddev = higher clustering (tighter timing)
    whaleClusteringScore = Math.max(0, 1 - (timingStdDev / 60)); // 60s normalization window
  }

  features.push(whaleCount, whaleEntryTiming, whaleClusteringScore);

  // === HOLDER DISTRIBUTION (2 features) ===
  const holderVolumes = new Map<string, number>();
  trades.forEach(t => {
    const holder = t.source;
    holderVolumes.set(holder, (holderVolumes.get(holder) ?? 0) + (t.fromAmount ?? 0));
  });

  let holderConcentration = 0;
  if (holderVolumes.size > 0) {
    const topHolderVols = Array.from(holderVolumes.values())
      .sort((a, b) => b - a)
      .slice(0, 10)
      .reduce((a, b) => a + b, 0);
    const totalHolderVol = Array.from(holderVolumes.values()).reduce((a, b) => a + b, 0);
    holderConcentration = totalHolderVol > 0 ? topHolderVols / totalHolderVol : 0;
  }

  const buyerDiversityScore = calculateEntropy(Array.from(holderVolumes.values()));
  features.push(holderConcentration, buyerDiversityScore);

  // === BUYER METRICS (3 features) ===
  const buyerCount = holderVolumes.size;
  const volumePerBuyer = volumeTotal / (buyerCount + 1);
  const entriesPerBuyer = trades.length / (buyerCount + 1);

  // Spread: price range across all trades as % of min price
  let spreadBetweenEntries = 0;
  const tradePrices = candles.map(c => c.close ?? 0).filter(p => p > 0);
  if (tradePrices.length > 0) {
    const minPrice = Math.min(...tradePrices);
    const maxPrice = Math.max(...tradePrices);
    spreadBetweenEntries = minPrice > 0 ? (maxPrice - minPrice) / minPrice : 0;
  }

  features.push(volumePerBuyer, entriesPerBuyer, spreadBetweenEntries);

  // === PRICE MOVEMENT (1 feature) ===
  let priceChangePercent = 0;
  if (candles.length > 0 && candles[0].open) {
    const firstPrice = candles[0].open;
    const finalPrice = candles[candles.length - 1].close ?? candles[0].open;
    priceChangePercent = (finalPrice - firstPrice) / (firstPrice + 0.00001);
  }

  features.push(priceChangePercent);

  // === CREATOR SIGNALS (2 features) ===
  // TODO: Query creator_stats table for success rate and lock %
  // For now: placeholder values (system will learn zero weight if not informative)
  const creatorSuccessRate = 0.5; // Unknown creator = neutral
  const creatorTokenLockPercent = 50; // Unknown = assume moderate lock

  features.push(creatorSuccessRate, creatorTokenLockPercent);

  // === LIQUIDITY (1 feature) ===
  // TODO: Query for pool depth, orderbook spread, or volume/mcap ratio
  // For now: placeholder based on volume metrics
  const liquidityDepthMetric = Math.min(1.0, volumeTotal / 1_000_000); // Normalize to 1M SOL equiv

  features.push(liquidityDepthMetric);

  // === LAUNCH TIMING (2 features) ===
  const launchDate = new Date(launchTimestamp * 1000);
  const launchHourOfDay = launchDate.getUTCHours(); // 0-23
  const launchDayOfWeek = launchDate.getUTCDay(); // 0-6 (Sun-Sat)

  features.push(launchHourOfDay, launchDayOfWeek);

  // === DELTA DIMENSIONS (4 features - tracked on subsequent snapshots) ===
  // Reserved for: volume momentum, price momentum, holder concentration trend, whale velocity trend
  // On initial 0-10min extraction: all zeros (no history yet)
  // Populated by trajectory tracker on subsequent fingerprints
  features.push(0, 0, 0, 0);

  // Ensure exactly 26 features
  if (features.length !== 26) {
    console.warn(`[ANN] Feature extraction returned ${features.length} features, expected 26`);
  }

  return features.slice(0, 26);
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
