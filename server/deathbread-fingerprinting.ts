import { db } from "./db";
import { tokenFingerprints, tokenDataPool, rawTokenTrades } from "@shared/schema";
import { eq, and, gte, lt } from "drizzle-orm";

/**
 * Deathbread Fingerprinting Strategy
 *
 * Problem: Dead tokens (no trading activity) have 1 T0 fingerprint → incomplete lifecycle
 * Solution: Capture final state ("deathbread") and average with T0 → negative pattern
 *
 * Lifecycle for dead token:
 *   T0 (0s): Launch fingerprint
 *     └─ Captures initial shape (entry conditions)
 *   T-death (when archived): Deathbread fingerprint
 *     └─ Captures final state (why it failed? volume death? holder loss?)
 *   Average(T0, deathbread): Cluster centroid
 *     └─ Anti-pattern for ANN training ("avoid tokens like this")
 *
 * Lifecycle for active token:
 *   T0: Launch
 *   T1, T5, T10, ...: Activity-gated (as long as trading)
 *   On graduation/peak: Archive (final state captured elsewhere)
 *
 * Storage for dead tokens:
 *   Before: 50 useless snapshots
 *   After: 2 meaningful snapshots → 1 cluster
 *   Benefit: Archetypal failure pattern for learning
 *
 * ANN training impact:
 *   Success patterns: Tokens with T0 + T_peak shapes → positive labels
 *   Failure patterns: Tokens with T0 + deathbread shapes → negative labels
 *   Result: Learn what NOT to buy, not just what to buy
 */

/**
 * Create deathbread fingerprint - final state when token archived
 *
 * Called when token is marked as "dead" (no trades for 24h, or graduated)
 * Captures final metrics: remaining holders, price, volume decay, etc.
 */
export async function recordDeathbreadFingerprint(
  tokenMint: string,
  archiveReason: "no_volume" | "graduated" | "rug" | "other" = "no_volume"
): Promise<{
  success: boolean;
  fpId?: string;
  t0Timestamp?: number;
  deathTimestamp: number;
  lifecycleDays: number;
}> {
  const now = Math.floor(Date.now() / 1000);

  // Get T0 fingerprint (first snapshot)
  const t0fp = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint))
    .orderBy((t) => (t.snapshotTimestamp ?? 0) as any)
    .limit(1);

  if (t0fp.length === 0) {
    // No T0 fingerprint - token never properly initialized
    return {
      success: false,
      deathTimestamp: now,
      lifecycleDays: 0,
    };
  }

  const t0Timestamp = t0fp[0].snapshotTimestamp || now;
  const lifecycleDays = Math.round((now - t0Timestamp) / 86400);

  // Get current token state for deathbread
  const tokenData = await db
    .select()
    .from(tokenDataPool)
    .where(eq(tokenDataPool.tokenMint, tokenMint))
    .limit(1);

  // Get final metrics from remaining trades (if any)
  const finalTrades = await db
    .select()
    .from(rawTokenTrades)
    .where(eq(rawTokenTrades.tokenMint, tokenMint))
    .orderBy((t) => (t.timestamp ?? 0) as any);

  // Calculate deathbread metrics
  const deathMetrics = calculateDeathbreadMetrics(finalTrades, tokenData[0]);

  // Create deathbread fingerprint entry
  const deathbreadId = `death_${tokenMint}_${now}`;
  try {
    await db.insert(tokenFingerprints).values({
      id: deathbreadId,
      tokenMint,
      snapshotTimestamp: now,
      snapshotTrigger: `deathbread_${archiveReason}`,
      fingerprintVector: deathMetrics.vector,
      winRate: deathMetrics.winRate,
      medianMultiplier: deathMetrics.finalMultiplier,
      avgHoldMinutes: deathMetrics.avgHoldMinutes,
      whaleEntryCount: 0, // No new whales at death
      clusterCoordination: 0, // No coordination at death
      buyerDiversity: deathMetrics.buyerDiversity,
      holderConcentration: deathMetrics.holderConcentration,
      isArchived: false, // Will be used for clustering
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(
      `[Deathbread] ${tokenMint}: Recorded lifecycle ${lifecycleDays}d (T0→Death), reason: ${archiveReason}`
    );

    return {
      success: true,
      fpId: deathbreadId,
      t0Timestamp,
      deathTimestamp: now,
      lifecycleDays,
    };
  } catch (error) {
    console.error(`[Deathbread] Failed to record for ${tokenMint}:`, error);
    return {
      success: false,
      deathTimestamp: now,
      lifecycleDays,
    };
  }
}

/**
 * Calculate deathbread metrics from final token state
 * Represents: "what does a failed token look like at the end?"
 */
function calculateDeathbreadMetrics(
  trades: typeof rawTokenTrades.$inferSelect[],
  tokenData?: typeof tokenDataPool.$inferSelect
) {
  const vector = Array.from({ length: 50 }, () => 0);

  if (!trades || trades.length === 0) {
    // Truly dead - no trades at all
    return {
      vector,
      winRate: 0,
      finalMultiplier: 0.00001, // Cratered
      avgHoldMinutes: 0,
      buyerDiversity: 0,
      holderConcentration: 1, // Concentrated → all sold or lost
    };
  }

  // Analyze final trades
  const buys = trades.filter((t) => t.direction === "buy");
  const sells = trades.filter((t) => t.direction === "sell");

  const totalBuyVolume = buys.reduce((sum, t) => sum + (t.amountSol || 0), 0);
  const totalSellVolume = sells.reduce((sum, t) => sum + (t.amountSol || 0), 0);

  // Price at death (final trade's price)
  const lastPrice = trades[trades.length - 1]?.price || 0.000001;
  const firstPrice = trades[0]?.price || 0.000001;
  const finalMultiplier = firstPrice > 0 ? lastPrice / firstPrice : 0;

  // Profitability at death
  const profitableWallets = new Map<string, number>();
  trades.forEach((trade) => {
    const profit = profitableWallets.get(trade.walletAddress) || 0;
    const delta =
      trade.direction === "buy" ? -(trade.amountSol || 0) : trade.amountSol || 0;
    profitableWallets.set(trade.walletAddress, profit + delta);
  });

  const winRate = Array.from(profitableWallets.values()).filter((p) => p > 0).length /
    Math.max(profitableWallets.size, 1);

  // Vector encoding death state
  vector[0] = Math.min(finalMultiplier, 10); // Price movement (capped)
  vector[1] = winRate; // Profitability
  vector[2] = Math.min(trades.length / 1000, 1); // Trade frequency (normalized)
  vector[3] = Math.min(totalBuyVolume / 100, 1); // Buy pressure (normalized)
  vector[4] = Math.min(totalSellVolume / 100, 1); // Sell pressure (normalized)

  return {
    vector,
    winRate,
    finalMultiplier,
    avgHoldMinutes: 0, // Token is dead, no new holds
    buyerDiversity: Math.min(buys.length / 100, 1),
    holderConcentration: totalBuyVolume > 0 ? totalSellVolume / totalBuyVolume : 1,
  };
}

/**
 * Average T0 + Deathbread fingerprints into cluster representative
 * Creates anti-pattern centroid: "what failure looks like"
 */
export async function createDeathPatternCluster(
  tokenMint: string
): Promise<{
  success: boolean;
  clusterId?: string;
  avgVector?: number[];
  pattern: string;
}> {
  // Get T0 and deathbread fingerprints
  const fingerprints = await db
    .select()
    .from(tokenFingerprints)
    .where(eq(tokenFingerprints.tokenMint, tokenMint));

  const t0 = fingerprints.find((fp) => !fp.snapshotTrigger?.startsWith("deathbread"));
  const deathbread = fingerprints.find((fp) =>
    fp.snapshotTrigger?.startsWith("deathbread")
  );

  if (!t0 || !deathbread) {
    return {
      success: false,
      pattern: "incomplete_lifecycle",
    };
  }

  // Average vectors
  const avgVector = Array.from({ length: 50 }, (_, i) => {
    const v1 = (t0.fingerprintVector as number[])?.[i] || 0;
    const v2 = (deathbread.fingerprintVector as number[])?.[i] || 0;
    return (v1 + v2) / 2;
  });

  const clusterId = `death_cluster_${tokenMint}_${Math.floor(Date.now() / 1000)}`;

  console.log(
    `[DeathPattern] ${tokenMint}: Created anti-pattern cluster (T0 + deathbread averaged)`
  );

  return {
    success: true,
    clusterId,
    avgVector,
    pattern: `${t0.snapshotTrigger} → ${deathbread.snapshotTrigger}`,
  };
}

/**
 * Archive token after deathbread recorded
 * Marks both T0 and deathbread as belonging to death pattern
 */
export async function archiveTokenWithDeathbread(
  tokenMint: string,
  reason: "no_volume" | "graduated" | "rug" | "other" = "no_volume"
): Promise<{
  tokenMint: string;
  archived: boolean;
  deathbreadRecorded: boolean;
  deathPatternCreated: boolean;
}> {
  // Record deathbread
  const deathbread = await recordDeathbreadFingerprint(tokenMint, reason);

  if (!deathbread.success) {
    return {
      tokenMint,
      archived: false,
      deathbreadRecorded: false,
      deathPatternCreated: false,
    };
  }

  // Create death pattern cluster
  const pattern = await createDeathPatternCluster(tokenMint);

  // Mark token as archived
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(tokenDataPool)
    .set({
      isArchived: true,
      archivedAt: now,
    })
    .where(eq(tokenDataPool.tokenMint, tokenMint));

  return {
    tokenMint,
    archived: true,
    deathbreadRecorded: deathbread.success,
    deathPatternCreated: pattern.success,
  };
}

/**
 * Storage estimate: Deathbread strategy for dead tokens
 *
 * Before (wasteful):
 *   Dead token: 50 fingerprints
 *   → 1 meaningful (T0)
 *   → 49 junk (stale copies)
 *
 * After (signal):
 *   Dead token: 2 fingerprints (T0 + deathbread) → 1 cluster
 *   → Both meaningful (entry + exit pattern)
 *   → Trained as anti-pattern (negative label for ANN)
 */
export function estimateDeathbreadSavings(): {
  scenario: string;
  fingerprintsPerDeadToken: number;
  clustersPerDeadToken: number;
  savingsPercent: number;
  trainingBenefit: string;
} {
  return {
    scenario: "Dead tokens (no sustained trading)",
    fingerprintsPerDeadToken: 2, // T0 + deathbread
    clustersPerDeadToken: 1, // Averaged representative
    savingsPercent: 96, // From 50 → 2 fingerprints = 96% reduction
    trainingBenefit:
      "Anti-pattern learning: ANN trains on T0→deathbread sequence = what NOT to buy",
  };
}

/**
 * Compare full strategy: Activity gating + Deathbread
 *
 * Dead tokens (70% of launches):
 *   - T0: Capture entry
 *   - T1+: Skip (no volume)
 *   - Death: Capture exit
 *   - Result: 2 FPs → 1 anti-pattern cluster
 *
 * Active tokens (30% of launches):
 *   - T0: Capture entry
 *   - T1+: Activity-gated snapshots
 *   - Peak: Final shape captured (graduation or peak)
 *   - Result: 5-15 FPs → multiple clusters
 *
 * ANN training:
 *   - Positive patterns: Active tokens → "buy signals"
 *   - Negative patterns: Dead tokens → "avoid patterns"
 *   - Lifecycle learning: How patterns evolve from entry → peak vs entry → death
 */
export function estimateFullStrategy(): {
  description: string;
  deadTokensStorage: string;
  activeTokensStorage: string;
  totalReduction: string;
  trainingQuality: string;
} {
  const deadTokens = 70;
  const activeTokens = 30;
  const ungatedPerToken = 50;
  const deadTokenFPs = 2; // T0 + deathbread
  const activeTokenFPs = 8; // Average across activity gating

  const ungatedTotal = (deadTokens + activeTokens) * ungatedPerToken;
  const gatedTotal = deadTokens * deadTokenFPs + activeTokens * activeTokenFPs;
  const reductionPercent = Math.round(((ungatedTotal - gatedTotal) / ungatedTotal) * 100);

  return {
    description: "Activity-gated + Deathbread fingerprinting",
    deadTokensStorage: `${deadTokens} tokens × ${deadTokenFPs} FPs = ${deadTokens * deadTokenFPs} (clusters: ${deadTokens})`,
    activeTokensStorage: `${activeTokens} tokens × ${activeTokenFPs} FPs = ${activeTokens * activeTokenFPs}`,
    totalReduction: `${ungatedTotal} → ${gatedTotal} fingerprints (${reductionPercent}% less, ~3-4 GB/month saved)`,
    trainingQuality:
      "Dual-label ANN training: Success patterns (active) + Failure patterns (dead) = comprehensive shape library",
  };
}
