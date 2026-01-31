import { db } from "./db";
import { holdings, pendingBuys, tradeConfig, tokenEvents, walletRuleDefaults } from "@shared/schema";
import { eq, and } from "drizzle-orm";

// Resolved effective rules for a position (after inheritance resolution)
export interface EffectiveRules {
  takeProfitThresholds: number[];
  takeProfitPercentages: number[];
  takeProfitEnabled: boolean[];
  stopLossPercent: number | null;
  stopLossFloorUsd: number | null;
  stopLossMode: "auto" | "alert";
  ruleSource: "inherited" | "override";
  resolvedFrom: "position" | "wallet" | "global";
}

// Resolve effective rules for a position with inheritance
export async function resolveEffectiveRules(
  holding: typeof holdings.$inferSelect,
  config: Awaited<ReturnType<typeof getTradeConfig>>
): Promise<EffectiveRules> {
  const ruleSource = (holding.ruleSource as "inherited" | "override") || "inherited";
  
  // If position has override, use position values (honor override even if only some fields are set)
  if (ruleSource === "override") {
    // Get fallback values from wallet defaults or global config for any missing fields
    let fallbackThresholds = (config.progressiveTakeProfitThresholds as number[]) || [10, 100, 1000, 10000];
    let fallbackPercentages = (config.progressiveTakeProfitPercents as number[]) || [10, 10, 10, 10];
    let fallbackStopLoss = config.stopLossPercent ?? null;
    let fallbackFloorUsd = config.stopLossFloorUsd ?? null;
    
    // Check wallet defaults for fallback if available
    if (holding.signalWalletId) {
      const [walletDefaults] = await db.select()
        .from(walletRuleDefaults)
        .where(eq(walletRuleDefaults.walletId, holding.signalWalletId));
      
      if (walletDefaults) {
        fallbackThresholds = (walletDefaults.takeProfitThresholds as number[]) || fallbackThresholds;
        fallbackPercentages = (walletDefaults.takeProfitPercentages as number[]) || fallbackPercentages;
        fallbackStopLoss = walletDefaults.stopLossPercent ?? fallbackStopLoss;
        fallbackFloorUsd = walletDefaults.stopLossFloorUsd ?? fallbackFloorUsd;
      }
    }
    
    const thresholds = (holding.takeProfitThresholds as number[]) || fallbackThresholds;
    const percentages = (holding.takeProfitPercentages as number[]) || fallbackPercentages;
    const takeProfitEnabled = (holding.takeProfitEnabled as boolean[]) || thresholds.map(() => true);
    
    return {
      takeProfitThresholds: thresholds,
      takeProfitPercentages: percentages,
      takeProfitEnabled,
      stopLossPercent: holding.stopLossPercent ?? fallbackStopLoss,
      stopLossFloorUsd: holding.stopLossFloorUsd ?? fallbackFloorUsd,
      stopLossMode: (holding.stopLossMode as "auto" | "alert") || "auto",
      ruleSource: "override",
      resolvedFrom: "position",
    };
  }
  
  // If inherited, look up wallet defaults via signalWalletId
  if (holding.signalWalletId) {
    const [walletDefaults] = await db.select()
      .from(walletRuleDefaults)
      .where(eq(walletRuleDefaults.walletId, holding.signalWalletId));
    
    if (walletDefaults) {
      const takeProfitEnabled = (walletDefaults.takeProfitEnabled as boolean[]) || 
        (walletDefaults.takeProfitThresholds as number[])?.map(() => true) || [true, true, true, true];
      
      return {
        takeProfitThresholds: (walletDefaults.takeProfitThresholds as number[]) || [4, 10, 25, 100],
        takeProfitPercentages: (walletDefaults.takeProfitPercentages as number[]) || [25, 25, 25, 25],
        takeProfitEnabled,
        stopLossPercent: walletDefaults.stopLossPercent ?? null,
        stopLossFloorUsd: walletDefaults.stopLossFloorUsd ?? null,
        stopLossMode: (walletDefaults.stopLossMode as "auto" | "alert") || "auto",
        ruleSource: "inherited",
        resolvedFrom: "wallet",
      };
    }
  }
  
  // Fallback to global user config
  return {
    takeProfitThresholds: (config.progressiveTakeProfitThresholds as number[]) || [10, 100, 1000, 10000],
    takeProfitPercentages: (config.progressiveTakeProfitPercents as number[]) || [10, 10, 10, 10],
    takeProfitEnabled: ((config.progressiveTakeProfitThresholds as number[]) || [10, 100, 1000, 10000]).map(() => true),
    stopLossPercent: config.stopLossPercent ?? null,
    stopLossFloorUsd: config.stopLossFloorUsd ?? null,
    stopLossMode: "auto",
    ruleSource: "inherited",
    resolvedFrom: "global",
  };
}
import { 
  getTradeConfig, 
  getAllHoldings, 
  getTokenWalletKeypair, 
  getOrCreateHotWallet,
  sendProfitsToMainWallet 
} from "./wallet";
import { sellToken, sellTokenWithWallet, getTokenPrice, getBatchTokenPrices, estimatePriorityFee, priorityFeeToSol } from "./jupiter";
import { sendEmail, formatNumber } from "./email";
import { storage } from "./storage";
import { checkPriceRiseTrigger } from "./trade-processor";
import { calculateTokenHeat, TokenHeatData } from "./heat-score";
import { 
  recordTick, 
  startAggregationJob, 
  stopAggregationJob,
  triggerHolderRefresh 
} from "./price-aggregator";
import { 
  updateScoreOnPriceMove, 
  batchUpdatePositionScores, 
  batchRecordSnapshots,
  resolvePositionScoreSnapshots,
  addEventToBucket,
  updateCurrentSnapshot,
  runBucketRollups
} from "./position-score";
import { resolvePredictionsOnPositionClose } from "./ai-accuracy";
import { discoverNewFactors, saveDiscoveredFactor } from "./adaptive-scoring";

const PRICE_CHECK_INTERVAL_MS = 30000;
const MIN_CHECK_INTERVAL_PER_TOKEN_MS = 30000;
const HOT_POLLING_INTERVAL_MS = 5 * 60 * 1000;
const WARM_POLLING_INTERVAL_MS = 15 * 60 * 1000;

const SWING_THRESHOLD_PERCENT = 10;
const SWING_5MIN_THRESHOLD_PERCENT = 5;
const SWING_VALUE_WEIGHTED_THRESHOLD_PERCENT = 3;
const SWING_VALUE_WEIGHTED_MIN_USD = 1000;
const SWING_COOLDOWN_MS = 180000;
const PRICE_HISTORY_WINDOW_MS = 300000;

let isPriceMonitorRunning = false;
let priceMonitorInterval: NodeJS.Timeout | null = null;

const tokenCheckTimestamps: Map<string, number> = new Map();
const tieredPollTimestamps: Map<string, number> = new Map();
const swingEventCooldowns: Map<string, number> = new Map();
const priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();
const tokenHeatCache: Map<string, { heat: TokenHeatData; cachedAt: number }> = new Map();
const HEAT_CACHE_TTL_MS = 60 * 1000;

function getPollingIntervalForTier(tier: "hot" | "warm" | "cold"): number {
  switch (tier) {
    case "hot": return HOT_POLLING_INTERVAL_MS;
    case "warm": return WARM_POLLING_INTERVAL_MS;
    case "cold": return Infinity;
  }
}

async function getTokenHeatCached(tokenMint: string): Promise<TokenHeatData> {
  const cached = tokenHeatCache.get(tokenMint);
  if (cached && Date.now() - cached.cachedAt < HEAT_CACHE_TTL_MS) {
    return cached.heat;
  }
  const heat = await calculateTokenHeat(tokenMint);
  tokenHeatCache.set(tokenMint, { heat, cachedAt: Date.now() });
  return heat;
}

function shouldPollToken(tokenMint: string, heatTier: "hot" | "warm" | "cold"): boolean {
  if (heatTier === "cold") return false;
  
  const lastPoll = tieredPollTimestamps.get(tokenMint) || 0;
  const interval = getPollingIntervalForTier(heatTier);
  return Date.now() - lastPoll >= interval;
}

export async function checkPricesAndReclaim(): Promise<void> {
  if (isPriceMonitorRunning) {
    return;
  }

  isPriceMonitorRunning = true;
  
  try {
    const holdingsList = await db.select().from(holdings);
    const pendingBuysList = await db.select()
      .from(pendingBuys)
      .where(
        and(
          eq(pendingBuys.buyTriggered, false),
          eq(pendingBuys.status, "active")
        )
      );
    
    // Skip polling entirely if no tokens are held by users
    if (holdingsList.length === 0 && pendingBuysList.length === 0) {
      return;
    }
    
    const now = Date.now();
    const tokenMintsToCheck = new Set<string>();
    
    const allTokenMints = new Set<string>();
    holdingsList.forEach(h => allTokenMints.add(h.tokenMint));
    pendingBuysList.forEach(p => allTokenMints.add(p.tokenMint));
    
    const tokenHeatMap = new Map<string, TokenHeatData>();
    for (const tokenMint of allTokenMints) {
      const heat = await getTokenHeatCached(tokenMint);
      tokenHeatMap.set(tokenMint, heat);
    }
    
    const holdingsToProcess: typeof holdingsList = [];
    for (const holding of holdingsList) {
      if (!holding.userId) continue;
      
      const heat = tokenHeatMap.get(holding.tokenMint);
      if (!heat) continue;
      
      if (!shouldPollToken(holding.tokenMint, heat.heatTier)) continue;
      
      holdingsToProcess.push(holding);
      tokenMintsToCheck.add(holding.tokenMint);
    }
    
    const pendingsToProcess: typeof pendingBuysList = [];
    for (const pending of pendingBuysList) {
      if (!pending.initialPrice || !pending.userId) continue;
      
      pendingsToProcess.push(pending);
      tokenMintsToCheck.add(pending.tokenMint);
    }
    
    if (tokenMintsToCheck.size === 0) {
      return;
    }
    
    const batchPrices = await getBatchTokenPrices([...tokenMintsToCheck]);
    
    // Record ticks for aggregation system
    for (const [tokenMint, priceData] of Array.from(batchPrices.entries())) {
      if (priceData.price !== null) {
        recordTick(tokenMint, priceData);
      }
    }
    
    // Update position scores based on price moves
    const priceMapForScoring = new Map<string, { price: number; volumeChange24h?: number }>();
    for (const [tokenMint, priceData] of Array.from(batchPrices.entries())) {
      if (priceData.price !== null) {
        priceMapForScoring.set(tokenMint, { 
          price: priceData.price,
          volumeChange24h: undefined // Volume change would need to be calculated from historical data
        });
        
        // Check for significant price moves and update scores immediately
        // Use the most recent historical price (last entry) as the previous price
        const history = priceHistory.get(tokenMint);
        const previousPrice = history && history.length > 0 ? history[history.length - 1].price : null;
        if (previousPrice) {
          updateScoreOnPriceMove(tokenMint, priceData.price, previousPrice).catch(e => 
            console.error(`[PositionScore] Error updating scores on price move: ${e}`)
          );
        }
        
        // Update price history after checking for moves
        updatePriceHistory(tokenMint, priceData.price);
      }
    }
    
    // Batch update all position scores periodically (covers time decay and other factors)
    // Only run every 5 minutes to avoid excessive updates
    const BATCH_SCORE_INTERVAL_MS = 5 * 60 * 1000;
    const lastBatchScoreTime = (global as any).__lastBatchScoreTime || 0;
    if (now - lastBatchScoreTime > BATCH_SCORE_INTERVAL_MS && priceMapForScoring.size > 0) {
      (global as any).__lastBatchScoreTime = now;
      batchUpdatePositionScores(priceMapForScoring).then(count => {
        if (count > 0) {
          console.log(`[PositionScore] Batch updated ${count} position scores`);
        }
      }).catch(e => console.error(`[PositionScore] Batch update error: ${e}`));
      
      // Also record snapshots for adaptive learning (hourly throttled internally)
      batchRecordSnapshots(priceMapForScoring).then(count => {
        if (count > 0) {
          console.log(`[PositionScore] Recorded ${count} snapshots for adaptive learning`);
        }
      }).catch(e => console.error(`[PositionScore] Snapshot recording error: ${e}`));
      
      // Update current snapshots for all holdings with latest price data
      for (const holding of holdingsList) {
        const priceData = batchPrices.get(holding.tokenMint);
        if (priceData && priceData.price !== null) {
          updateCurrentSnapshot(holding.id, {
            holderCount: 0, // Will be updated on holder refresh
            price: priceData.price,
            marketCap: priceData.marketCap || 0,
            peakMultiplier: Math.max(1, priceData.price / (holding.buyPrice || priceData.price)),
            significantEvents: 0,
            timestamp: now,
          }).catch(e => console.error(`[EventBuckets] Error updating current snapshot: ${e}`));
        }
      }
      
      // Run bucket rollups (15min → hourly after 24h, hourly → daily after 7d)
      runBucketRollups().catch(e => console.error(`[EventBuckets] Rollup error: ${e}`));
    }
    
    for (const holding of holdingsToProcess) {
      const priceData = batchPrices.get(holding.tokenMint);
      if (!priceData || priceData.price === null) continue;
      
      const config = await getTradeConfig(holding.userId!);
      if (!config.enabled) continue;
      
      tokenCheckTimestamps.set(`${holding.userId}_${holding.tokenMint}`, now);
      tieredPollTimestamps.set(holding.tokenMint, now);
      await checkHoldingPriceWithBatch(holding, holding.userId!, config, priceData.price);
    }
    
    for (const pending of pendingsToProcess) {
      const priceData = batchPrices.get(pending.tokenMint);
      if (!priceData || priceData.price === null) continue;
      
      tokenCheckTimestamps.set(`pending_${pending.userId}_${pending.tokenMint}`, now);
      await checkPriceRiseTrigger(pending.tokenMint, priceData.price);
    }
    
  } catch (error) {
    console.error("Error in price monitoring:", error);
  } finally {
    isPriceMonitorRunning = false;
  }
}

function updatePriceHistory(tokenMint: string, price: number): void {
  const now = Date.now();
  const history = priceHistory.get(tokenMint) || [];
  
  history.push({ price, timestamp: now });
  
  const cutoff = now - PRICE_HISTORY_WINDOW_MS;
  const filtered = history.filter(h => h.timestamp > cutoff);
  
  priceHistory.set(tokenMint, filtered);
}

function getPriceChangeIn5Min(tokenMint: string, currentPrice: number): number | null {
  const history = priceHistory.get(tokenMint);
  if (!history || history.length < 2) return null;
  
  const now = Date.now();
  const targetTime = now - PRICE_HISTORY_WINDOW_MS;
  
  let closestSample = history[0];
  let closestDiff = Math.abs(history[0].timestamp - targetTime);
  
  for (const sample of history) {
    const diff = Math.abs(sample.timestamp - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestSample = sample;
    }
  }
  
  if (now - closestSample.timestamp < 60000) return null;
  
  return ((currentPrice - closestSample.price) / closestSample.price) * 100;
}

interface SwingDetectionResult {
  isSwing: boolean;
  changePercent: number;
  triggerType: "instant" | "5min" | "value_weighted" | null;
  direction: "up" | "down" | null;
}

function detectSwing(
  tokenMint: string,
  currentPrice: number,
  lastPrice: number | null,
  valueUsd: number
): SwingDetectionResult {
  const result: SwingDetectionResult = {
    isSwing: false,
    changePercent: 0,
    triggerType: null,
    direction: null,
  };
  
  const change5Min = getPriceChangeIn5Min(tokenMint, currentPrice);
  if (change5Min !== null && Math.abs(change5Min) >= SWING_5MIN_THRESHOLD_PERCENT) {
    result.isSwing = true;
    result.triggerType = "5min";
    result.changePercent = change5Min;
    result.direction = change5Min >= 0 ? "up" : "down";
    return result;
  }
  
  if (!lastPrice || lastPrice <= 0) return result;
  
  const instantChange = ((currentPrice - lastPrice) / lastPrice) * 100;
  result.changePercent = instantChange;
  result.direction = instantChange >= 0 ? "up" : "down";
  
  if (Math.abs(instantChange) >= SWING_THRESHOLD_PERCENT) {
    result.isSwing = true;
    result.triggerType = "instant";
    return result;
  }
  
  if (valueUsd >= SWING_VALUE_WEIGHTED_MIN_USD && Math.abs(instantChange) >= SWING_VALUE_WEIGHTED_THRESHOLD_PERCENT) {
    result.isSwing = true;
    result.triggerType = "value_weighted";
    return result;
  }
  
  return result;
}

function canTriggerSwingEvent(tokenMint: string): boolean {
  const lastSwing = swingEventCooldowns.get(tokenMint);
  if (!lastSwing) return true;
  return Date.now() - lastSwing >= SWING_COOLDOWN_MS;
}

async function createSwingEvent(
  holding: typeof holdings.$inferSelect,
  currentPrice: number,
  swing: SwingDetectionResult,
  valueUsd: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const direction = swing.direction === "up" ? "+" : "";
  const changeStr = `${direction}${swing.changePercent.toFixed(1)}%`;
  
  let triggerDesc = "";
  switch (swing.triggerType) {
    case "instant":
      triggerDesc = "sudden move";
      break;
    case "5min":
      triggerDesc = "5-min trend";
      break;
    case "value_weighted":
      triggerDesc = "significant bag";
      break;
  }
  
  const priority = Math.abs(swing.changePercent) >= 20 ? "high" : 
                   Math.abs(swing.changePercent) >= 10 ? "normal" : "low";
  
  await db.insert(tokenEvents).values({
    tokenMint: holding.tokenMint,
    tokenSymbol: holding.tokenSymbol,
    eventType: "price_swing",
    priority,
    title: `${holding.tokenSymbol} ${changeStr} (${triggerDesc})`,
    description: `${swing.direction === "up" ? "Pumping" : "Dumping"} - ${changeStr} detected via ${triggerDesc}`,
    metadata: {
      changePercent: swing.changePercent,
      triggerType: swing.triggerType,
      direction: swing.direction,
      valueUsd,
      buyPrice: holding.buyPrice,
      currentPrice,
    },
    createdAt: now,
    priceAtEvent: currentPrice,
    valueUsd,
    relatedWallet: holding.sourceWalletAddress,
  });
  
  swingEventCooldowns.set(holding.tokenMint, Date.now());
  console.log(`Swing event: ${holding.tokenSymbol} ${changeStr} (${triggerDesc})`);
}

async function createMilestoneEvent(
  holding: typeof holdings.$inferSelect,
  milestone: number,
  multiplier: number,
  currentPrice: number,
  eventType: "milestone_reached" | "reclaim_executed" | "progressive_reclaim"
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const valueUsd = holding.currentAmount * currentPrice;
  
  let title: string;
  let description: string;
  let priority: "high" | "normal" | "low";
  
  switch (eventType) {
    case "milestone_reached":
      title = `${holding.tokenSymbol} hit ${milestone}x`;
      description = `Price milestone reached - now at ${multiplier.toFixed(2)}x from buy`;
      priority = milestone >= 10 ? "high" : "normal";
      break;
    case "reclaim_executed":
      title = `${holding.tokenSymbol} reclaim at ${milestone}x`;
      description = `Auto-sold 2x initial investment at ${milestone}x multiplier`;
      priority = "high";
      break;
    case "progressive_reclaim":
      title = `${holding.tokenSymbol} progressive sell at ${milestone}x`;
      description = `Sold 10% of remaining holdings at ${milestone}x milestone`;
      priority = "high";
      break;
  }
  
  await db.insert(tokenEvents).values({
    tokenMint: holding.tokenMint,
    tokenSymbol: holding.tokenSymbol,
    eventType,
    priority,
    title,
    description,
    metadata: {
      milestone,
      multiplier,
      buyPrice: holding.buyPrice,
      currentPrice,
      valueUsd,
      currentAmount: holding.currentAmount,
    },
    createdAt: now,
    priceAtEvent: currentPrice,
    valueUsd,
    relatedWallet: holding.sourceWalletAddress,
  });
  
  console.log(`Milestone event: ${title}`);
  
  if ((eventType === "reclaim_executed" || eventType === "progressive_reclaim") && holding.sourceWalletAddress) {
    try {
      const { updateSignalWalletProfile } = await import("./signal-wallet-profiler");
      const holdTimeMinutes = Math.floor((now - holding.buyTimestamp) / 60);
      await updateSignalWalletProfile(
        holding.sourceWalletAddress,
        multiplier,
        holdTimeMinutes
      );
      console.log(`Updated signal wallet profile for ${holding.sourceWalletAddress}: ${multiplier.toFixed(2)}x in ${holdTimeMinutes}min`);
    } catch (error) {
      console.error("Failed to update signal wallet profile:", error);
    }
  }
}

async function createDumpAlertEvent(
  holding: typeof holdings.$inferSelect,
  lossPercent: number,
  currentPrice: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const valueUsd = holding.currentAmount * currentPrice;
  const multiplier = currentPrice / holding.buyPrice;
  
  await db.insert(tokenEvents).values({
    tokenMint: holding.tokenMint,
    tokenSymbol: holding.tokenSymbol,
    eventType: "dump_alert",
    priority: lossPercent >= 70 ? "high" : "normal",
    title: `${holding.tokenSymbol} down ${lossPercent.toFixed(0)}%`,
    description: `Token has dumped significantly - now at ${multiplier.toFixed(2)}x from buy`,
    metadata: {
      lossPercent,
      multiplier,
      buyPrice: holding.buyPrice,
      currentPrice,
      valueUsd,
    },
    createdAt: now,
    priceAtEvent: currentPrice,
    valueUsd,
    relatedWallet: holding.sourceWalletAddress,
  });
  
  console.log(`Dump event: ${holding.tokenSymbol} down ${lossPercent.toFixed(0)}%`);
}

async function checkHoldingPriceWithBatch(
  holding: typeof holdings.$inferSelect,
  userId: number,
  config: Awaited<ReturnType<typeof getTradeConfig>>,
  currentPrice: number
): Promise<void> {
  try {
    if (!currentPrice || currentPrice <= 0 || !isFinite(currentPrice)) {
      return;
    }
    if (!holding.buyPrice || holding.buyPrice <= 0 || !isFinite(holding.buyPrice)) {
      console.log(`Skipping ${holding.tokenSymbol}: invalid buyPrice ${holding.buyPrice}`);
      return;
    }

    const multiplier = currentPrice / holding.buyPrice;
    const now = Math.floor(Date.now() / 1000);
    const valueUsd = holding.currentAmount * currentPrice;

    updatePriceHistory(holding.tokenMint, currentPrice);

    if (canTriggerSwingEvent(holding.tokenMint)) {
      const swing = detectSwing(
        holding.tokenMint,
        currentPrice,
        holding.lastPrice,
        valueUsd
      );
      if (swing.isSwing) {
        await createSwingEvent(holding, currentPrice, swing, valueUsd);
      }
    }

    await db.update(holdings).set({
      lastPriceCheck: now,
      lastPrice: currentPrice,
      highestMultiplier: Math.max(holding.highestMultiplier ?? 1, multiplier),
    }).where(eq(holdings.id, holding.id));

    const milestones = (config.milestonesToAlert as number[]) || [2, 4, 10];
    const alertedMilestones = (holding.alertedMilestones as number[]) || [];
    
    for (const milestone of milestones) {
      if (multiplier >= milestone && !alertedMilestones.includes(milestone)) {
        console.log(`Milestone reached for ${holding.tokenSymbol}: ${milestone}x`);
        await sendMilestoneAlert(userId, holding, milestone, multiplier, currentPrice);
        await createMilestoneEvent(holding, milestone, multiplier, currentPrice, "milestone_reached");
        
        const newAlerted = [...alertedMilestones, milestone];
        await db.update(holdings).set({
          alertedMilestones: newAlerted,
        }).where(eq(holdings.id, holding.id));
      }
    }

    const reclaimedMilestones = (holding.reclaimedMilestones as number[]) || [];
    const has4xReclaim = holding.reclaimed || reclaimedMilestones.includes(4);
    
    if (!has4xReclaim && multiplier >= config.reclaimMultiplier) {
      console.log(`Reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${config.reclaimMultiplier}x`);
      await executeReclaim(userId, holding, currentPrice, config.reclaimMultiplier, "initial");
      await createMilestoneEvent(holding, config.reclaimMultiplier, multiplier, currentPrice, "reclaim_executed");
    }
    
    // Resolve effective rules with inheritance (position → wallet → global)
    const effectiveRules = await resolveEffectiveRules(holding, config);
    
    // Filter to only enabled tiers
    const enabledIndices = effectiveRules.takeProfitEnabled
      .map((enabled, i) => enabled ? i : -1)
      .filter(i => i >= 0);
    const progressiveMilestones = enabledIndices.map(i => effectiveRules.takeProfitThresholds[i]);
    const progressivePercents = enabledIndices.map(i => effectiveRules.takeProfitPercentages[i]);
    
    for (let i = 0; i < progressiveMilestones.length; i++) {
      const milestone = progressiveMilestones[i];
      const sellPercent = progressivePercents[i] || 10;
      if (multiplier >= milestone && !reclaimedMilestones.includes(milestone)) {
        console.log(`Progressive reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${milestone}x (sell ${sellPercent}%) [${effectiveRules.resolvedFrom}]`);
        await executeProgressiveReclaim(userId, holding, currentPrice, milestone, sellPercent);
        await createMilestoneEvent(holding, milestone, multiplier, currentPrice, "progressive_reclaim");
        break;
      }
    }
    
    if (config.dumpAlertEnabled && !holding.dumpAlertSent) {
      const lossPercent = ((holding.buyPrice - currentPrice) / holding.buyPrice) * 100;
      if (lossPercent >= config.dumpAlertThreshold) {
        console.log(`Dump alert for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss`);
        await sendDumpAlert(userId, holding, multiplier, currentPrice, lossPercent);
        await createDumpAlertEvent(holding, lossPercent, currentPrice);
        await db.update(holdings).set({
          dumpAlertSent: true,
        }).where(eq(holdings.id, holding.id));
      }
    }
    
    // Stop-loss execution using resolved rules
    const stopLossPercent = effectiveRules.stopLossPercent;
    const stopLossFloorUsd = effectiveRules.stopLossFloorUsd;
    const stopLossMode = effectiveRules.stopLossMode;
    const STOP_LOSS_ALERT_DEBOUNCE_SECONDS = 15 * 60; // 15 minutes between alerts
    
    if (stopLossPercent !== null && !holding.stopLossTriggered && holding.currentAmount > 0) {
      // Use avgEntryPrice if available (for positions with top-ups), else fallback to buyPrice
      const entryPrice = holding.avgEntryPrice ?? holding.buyPrice;
      if (!entryPrice || entryPrice <= 0 || !isFinite(entryPrice)) {
        // Skip if we can't calculate loss
      } else {
        const lossPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
        const shouldTriggerStopLoss = lossPercent >= stopLossPercent;
        
        // Floor bypass: don't execute stop-loss if position value is tiny (< floor USD)
        // currentPrice is in USD per token from Jupiter
        const positionValueUsd = holding.currentAmount * currentPrice;
        const floorBypass = stopLossFloorUsd !== null && positionValueUsd < stopLossFloorUsd;
        
        if (shouldTriggerStopLoss && !floorBypass) {
          if (stopLossMode === "auto") {
            // Auto mode: execute stop-loss immediately
            console.log(`Stop-loss AUTO triggered for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss >= ${stopLossPercent}% threshold`);
            await executeStopLoss(userId, holding, currentPrice, lossPercent);
          } else {
            // Alert mode: send notification and wait for user confirmation
            const now = Math.floor(Date.now() / 1000);
            const lastAlerted = holding.stopLossLastAlertedAt ?? 0;
            
            if (now - lastAlerted >= STOP_LOSS_ALERT_DEBOUNCE_SECONDS) {
              console.log(`Stop-loss ALERT for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss >= ${stopLossPercent}% threshold`);
              
              // Update debounce timestamp
              await db.update(holdings).set({
                stopLossLastAlertedAt: now,
              }).where(eq(holdings.id, holding.id));
              
              // Send stop-loss alert notification
              await sendStopLossAlert(userId, holding, lossPercent, currentPrice);
            }
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`Error checking price for ${holding.tokenSymbol}:`, error);
  }
}

async function checkHoldingPrice(
  holding: typeof holdings.$inferSelect,
  userId: number,
  config: Awaited<ReturnType<typeof getTradeConfig>>
): Promise<void> {
  try {
    const currentPrice = await getTokenPrice(holding.tokenMint);
    if (!currentPrice || currentPrice <= 0 || !isFinite(currentPrice)) {
      return;
    }
    if (!holding.buyPrice || holding.buyPrice <= 0 || !isFinite(holding.buyPrice)) {
      console.log(`Skipping ${holding.tokenSymbol}: invalid buyPrice ${holding.buyPrice}`);
      return;
    }

    const multiplier = currentPrice / holding.buyPrice;
    const now = Math.floor(Date.now() / 1000);

    await db.update(holdings).set({
      lastPriceCheck: now,
      lastPrice: currentPrice,
      highestMultiplier: Math.max(holding.highestMultiplier ?? 1, multiplier),
    }).where(eq(holdings.id, holding.id));

    console.log(`Price check for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x (${currentPrice.toExponential(2)})`);

    const milestones = (config.milestonesToAlert as number[]) || [2, 4, 10];
    const alertedMilestones = (holding.alertedMilestones as number[]) || [];
    
    for (const milestone of milestones) {
      if (multiplier >= milestone && !alertedMilestones.includes(milestone)) {
        console.log(`Milestone reached for ${holding.tokenSymbol}: ${milestone}x`);
        await sendMilestoneAlert(userId, holding, milestone, multiplier, currentPrice);
        await createMilestoneEvent(holding, milestone, multiplier, currentPrice, "milestone_reached");
        
        const newAlerted = [...alertedMilestones, milestone];
        await db.update(holdings).set({
          alertedMilestones: newAlerted,
        }).where(eq(holdings.id, holding.id));
      }
    }

    const reclaimedMilestones = (holding.reclaimedMilestones as number[]) || [];
    
    const has4xReclaim = holding.reclaimed || reclaimedMilestones.includes(4);
    
    if (!has4xReclaim && multiplier >= config.reclaimMultiplier) {
      console.log(`Reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${config.reclaimMultiplier}x`);
      await executeReclaim(userId, holding, currentPrice, config.reclaimMultiplier, "initial");
      await createMilestoneEvent(holding, config.reclaimMultiplier, multiplier, currentPrice, "reclaim_executed");
    }
    
    // Resolve effective rules with inheritance (position → wallet → global)
    const effectiveRules = await resolveEffectiveRules(holding, config);
    
    // Filter to only enabled tiers
    const enabledIndices = effectiveRules.takeProfitEnabled
      .map((enabled, i) => enabled ? i : -1)
      .filter(i => i >= 0);
    const progressiveMilestones = enabledIndices.map(i => effectiveRules.takeProfitThresholds[i]);
    const progressivePercents = enabledIndices.map(i => effectiveRules.takeProfitPercentages[i]);
    
    for (let i = 0; i < progressiveMilestones.length; i++) {
      const milestone = progressiveMilestones[i];
      const sellPercent = progressivePercents[i] || 10;
      if (multiplier >= milestone && !reclaimedMilestones.includes(milestone)) {
        console.log(`Progressive reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${milestone}x (sell ${sellPercent}%) [${effectiveRules.resolvedFrom}]`);
        await executeProgressiveReclaim(userId, holding, currentPrice, milestone, sellPercent);
        await createMilestoneEvent(holding, milestone, multiplier, currentPrice, "progressive_reclaim");
        break;
      }
    }
    
    if (config.dumpAlertEnabled && !holding.dumpAlertSent) {
      const lossPercent = ((holding.buyPrice - currentPrice) / holding.buyPrice) * 100;
      if (lossPercent >= config.dumpAlertThreshold) {
        console.log(`Dump alert for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss`);
        await sendDumpAlert(userId, holding, multiplier, currentPrice, lossPercent);
        await createDumpAlertEvent(holding, lossPercent, currentPrice);
        await db.update(holdings).set({
          dumpAlertSent: true,
        }).where(eq(holdings.id, holding.id));
      }
    }
    
    // Stop-loss execution using resolved rules
    const stopLossPercent = effectiveRules.stopLossPercent;
    const stopLossFloorUsd = effectiveRules.stopLossFloorUsd;
    const stopLossMode = effectiveRules.stopLossMode;
    const STOP_LOSS_ALERT_DEBOUNCE_SECONDS = 15 * 60; // 15 minutes between alerts
    
    if (stopLossPercent !== null && !holding.stopLossTriggered && holding.currentAmount > 0) {
      // Use avgEntryPrice if available (for positions with top-ups), else fallback to buyPrice
      const entryPrice = holding.avgEntryPrice ?? holding.buyPrice;
      if (entryPrice && entryPrice > 0 && isFinite(entryPrice)) {
        const lossPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
        const shouldTriggerStopLoss = lossPercent >= stopLossPercent;
        
        // Floor bypass: don't execute stop-loss if position value is tiny (< floor USD)
        const positionValueUsd = holding.currentAmount * currentPrice;
        const floorBypass = stopLossFloorUsd !== null && positionValueUsd < stopLossFloorUsd;
        
        if (shouldTriggerStopLoss && !floorBypass) {
          if (stopLossMode === "auto") {
            // Auto mode: execute stop-loss immediately
            console.log(`Stop-loss AUTO triggered for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss >= ${stopLossPercent}% threshold [${effectiveRules.resolvedFrom}]`);
            await executeStopLoss(userId, holding, currentPrice, lossPercent);
          } else {
            // Alert mode: send notification and wait for user confirmation
            const now = Math.floor(Date.now() / 1000);
            const lastAlerted = holding.stopLossLastAlertedAt ?? 0;
            
            if (now - lastAlerted >= STOP_LOSS_ALERT_DEBOUNCE_SECONDS) {
              console.log(`Stop-loss ALERT for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss >= ${stopLossPercent}% threshold [${effectiveRules.resolvedFrom}]`);
              
              // Update debounce timestamp
              await db.update(holdings).set({
                stopLossLastAlertedAt: now,
              }).where(eq(holdings.id, holding.id));
              
              // Send stop-loss alert notification
              await sendStopLossAlert(userId, holding, lossPercent, currentPrice);
            }
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`Error checking price for ${holding.tokenSymbol}:`, error);
  }
}

async function executeReclaim(
  userId: number,
  holding: typeof holdings.$inferSelect,
  currentPrice: number,
  reclaimMultiplier: number,
  type: "initial" | "progressive"
): Promise<void> {
  try {
    if (!currentPrice || currentPrice <= 0 || !isFinite(currentPrice)) {
      console.log(`Invalid price for ${holding.tokenSymbol}: ${currentPrice}`);
      return;
    }
    
    const tokensToSell = (holding.solSpent * 2 / currentPrice);
    
    if (!isFinite(tokensToSell) || tokensToSell <= 0) {
      console.log(`Invalid tokens to sell for ${holding.tokenSymbol}: ${tokensToSell}`);
      return;
    }
    
    if (tokensToSell > holding.currentAmount) {
      console.log(`Not enough tokens to reclaim for ${holding.tokenSymbol}: need ${tokensToSell}, have ${holding.currentAmount}`);
      return;
    }

    console.log(`Executing initial reclaim for ${holding.tokenSymbol}: selling ${tokensToSell.toLocaleString()} tokens`);

    let result;
    
    // Use token wallet if available, otherwise fall back to main wallet
    if (holding.tokenWalletEncryptedKey) {
      const tokenWalletKeypair = getTokenWalletKeypair(holding.tokenWalletEncryptedKey);
      if (!tokenWalletKeypair) {
        console.error(`Failed to decrypt token wallet for ${holding.tokenSymbol}, falling back to main wallet`);
        // Fallback to main wallet if token wallet decryption fails
        result = await sellToken(userId, holding.tokenMint, tokensToSell);
      } else {
        result = await sellTokenWithWallet(tokenWalletKeypair, holding.tokenMint, tokensToSell);
        
        // Send profits back to main wallet (keep 4x gas reserve)
        if (result.success) {
          const mainWallet = await getOrCreateHotWallet(userId);
          if (mainWallet) {
            const gasReserve = priorityFeeToSol(await estimatePriorityFee());
            const profitResult = await sendProfitsToMainWallet(
              tokenWalletKeypair,
              mainWallet.publicKey,
              gasReserve
            );
            if (profitResult.success && profitResult.amountSent && profitResult.amountSent > 0) {
              console.log(`Sent ${profitResult.amountSent.toFixed(4)} SOL profits to main wallet`);
            }
          }
        }
      }
    } else {
      // Legacy: use main wallet
      result = await sellToken(userId, holding.tokenMint, tokensToSell);
    }
    
    if (!result.success) {
      console.error(`Reclaim failed for ${holding.tokenSymbol}:`, result.error);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAmount = holding.currentAmount - tokensToSell;

    const existingReclaimedMilestones = (holding.reclaimedMilestones as number[]) || [];
    const newReclaimedMilestones = [...existingReclaimedMilestones, 4];
    
    await db.update(holdings).set({
      reclaimed: true,
      reclaimTimestamp: now,
      reclaimSignature: result.signature,
      currentAmount: newAmount,
      reclaimedMilestones: newReclaimedMilestones,
    }).where(eq(holdings.id, holding.id));
    
    // Resolve position score snapshots for learning (profitable partial exit)
    const currentPrice = (holding.buyPrice || 0) * reclaimMultiplier;
    try {
      await resolvePositionScoreSnapshots(holding.id, currentPrice, "profit_exit");
    } catch (e) {
      console.error(`Failed to resolve position snapshots:`, e);
    }

    console.log(`Reclaim successful for ${holding.tokenSymbol}:`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()}`);
    console.log(`  SOL received: ~${result.inputAmount} SOL`);
    console.log(`  Remaining: ${newAmount.toLocaleString()} tokens`);

    await sendReclaimNotification(userId, holding, tokensToSell, result.inputAmount || 0, reclaimMultiplier, result.signature, "initial");
    
    // Record trade result for autonomous mode (proportional cost basis)
    const { getSolPriceUsd } = await import("./jupiter");
    const solPrice = await getSolPriceUsd();
    const percentSold = tokensToSell / (holding.currentAmount || tokensToSell);
    const proportionalCostSol = (holding.solSpent || 0) * percentSold;
    const profitSol = (result.inputAmount || 0) - proportionalCostSol;
    const profitUsd = profitSol * solPrice;
    try {
      const { recordTradeResult } = await import("./autonomous-mode");
      await recordTradeResult(userId, profitUsd);
    } catch (e) {
      console.error(`Failed to record trade result:`, e);
    }

  } catch (error) {
    console.error(`Error executing reclaim for ${holding.tokenSymbol}:`, error);
  }
}

async function executeProgressiveReclaim(
  userId: number,
  holding: typeof holdings.$inferSelect,
  currentPrice: number,
  milestone: number,
  sellPercent: number = 10
): Promise<void> {
  try {
    if (!currentPrice || currentPrice <= 0 || !isFinite(currentPrice)) {
      console.log(`Invalid price for progressive reclaim ${holding.tokenSymbol}: ${currentPrice}`);
      return;
    }
    
    if (!holding.currentAmount || holding.currentAmount <= 0) {
      console.log(`No tokens to reclaim for ${holding.tokenSymbol}`);
      return;
    }
    
    const tokensToSell = holding.currentAmount * (sellPercent / 100);
    
    if (!isFinite(tokensToSell) || tokensToSell <= 0) {
      console.log(`Invalid tokens to sell for ${holding.tokenSymbol}: ${tokensToSell}`);
      return;
    }

    console.log(`Executing progressive reclaim for ${holding.tokenSymbol} at ${milestone}x: selling ${tokensToSell.toLocaleString()} tokens (${sellPercent}%)`);

    let result;
    
    // Use token wallet if available, otherwise fall back to main wallet
    if (holding.tokenWalletEncryptedKey) {
      const tokenWalletKeypair = getTokenWalletKeypair(holding.tokenWalletEncryptedKey);
      if (!tokenWalletKeypair) {
        console.error(`Failed to decrypt token wallet for ${holding.tokenSymbol}, falling back to main wallet`);
        // Fallback to main wallet if token wallet decryption fails
        result = await sellToken(userId, holding.tokenMint, tokensToSell);
      } else {
        result = await sellTokenWithWallet(tokenWalletKeypair, holding.tokenMint, tokensToSell);
        
        // Send profits back to main wallet (keep 4x gas reserve)
        if (result.success) {
          const mainWallet = await getOrCreateHotWallet(userId);
          if (mainWallet) {
            const gasReserve = priorityFeeToSol(await estimatePriorityFee());
            const profitResult = await sendProfitsToMainWallet(
              tokenWalletKeypair,
              mainWallet.publicKey,
              gasReserve
            );
            if (profitResult.success && profitResult.amountSent && profitResult.amountSent > 0) {
              console.log(`Sent ${profitResult.amountSent.toFixed(4)} SOL profits to main wallet`);
            }
          }
        }
      }
    } else {
      // Legacy: use main wallet
      result = await sellToken(userId, holding.tokenMint, tokensToSell);
    }
    
    if (!result.success) {
      console.error(`Progressive reclaim failed for ${holding.tokenSymbol}:`, result.error);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAmount = holding.currentAmount - tokensToSell;
    const reclaimedMilestones = (holding.reclaimedMilestones as number[]) || [];
    const newReclaimedMilestones = [...reclaimedMilestones, milestone];

    await db.update(holdings).set({
      reclaimTimestamp: now,
      reclaimSignature: result.signature,
      currentAmount: newAmount,
      reclaimedMilestones: newReclaimedMilestones,
    }).where(eq(holdings.id, holding.id));
    
    // Resolve position score snapshots for learning (profitable exit)
    try {
      await resolvePositionScoreSnapshots(holding.id, currentPrice, "profit_exit");
    } catch (e) {
      console.error(`Failed to resolve position snapshots:`, e);
    }
    
    // Resolve AI predictions for learning
    const entryTime = holding.buyTimestamp || 0;
    const holdTimeMinutes = entryTime > 0 ? Math.floor((Date.now() / 1000 - entryTime) / 60) : undefined;
    resolvePredictionsOnPositionClose(holding.tokenMint, currentPrice, holdTimeMinutes).catch(e =>
      console.error(`Failed to resolve AI predictions:`, e)
    );

    console.log(`Progressive reclaim successful for ${holding.tokenSymbol}:`);
    console.log(`  Milestone: ${milestone}x`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()} (10%)`);
    console.log(`  SOL received: ~${result.inputAmount} SOL`);
    console.log(`  Remaining: ${newAmount.toLocaleString()} tokens`);

    await sendReclaimNotification(userId, holding, tokensToSell, result.inputAmount || 0, milestone, result.signature, "progressive");
    
    // Record trade result for autonomous mode (proportional cost basis for partial sell)
    const { getSolPriceUsd } = await import("./jupiter");
    const solPrice = await getSolPriceUsd();
    const percentSold = sellPercent / 100;
    const proportionalCostSol = (holding.solSpent || 0) * percentSold;
    const profitSol = (result.inputAmount || 0) - proportionalCostSol;
    const profitUsd = profitSol * solPrice;
    try {
      const { recordTradeResult } = await import("./autonomous-mode");
      await recordTradeResult(userId, profitUsd);
    } catch (e) {
      console.error(`Failed to record progressive reclaim trade result:`, e);
    }

  } catch (error) {
    console.error(`Error executing progressive reclaim for ${holding.tokenSymbol}:`, error);
  }
}

async function executeStopLoss(
  userId: number,
  holding: typeof holdings.$inferSelect,
  currentPrice: number,
  lossPercent: number
): Promise<void> {
  try {
    if (!currentPrice || currentPrice <= 0 || !isFinite(currentPrice)) {
      console.log(`Invalid price for stop-loss ${holding.tokenSymbol}: ${currentPrice}`);
      return;
    }
    
    if (!holding.currentAmount || holding.currentAmount <= 0) {
      console.log(`No tokens for stop-loss in ${holding.tokenSymbol}`);
      return;
    }
    
    // Sell entire position
    const tokensToSell = holding.currentAmount;

    console.log(`Executing stop-loss for ${holding.tokenSymbol}: selling ${tokensToSell.toLocaleString()} tokens (100% - ${lossPercent.toFixed(1)}% loss)`);

    let result;
    
    // Use token wallet if available, otherwise fall back to main wallet
    if (holding.tokenWalletEncryptedKey) {
      const tokenWalletKeypair = getTokenWalletKeypair(holding.tokenWalletEncryptedKey);
      if (!tokenWalletKeypair) {
        console.error(`Failed to decrypt token wallet for ${holding.tokenSymbol}, falling back to main wallet`);
        result = await sellToken(userId, holding.tokenMint, tokensToSell);
      } else {
        result = await sellTokenWithWallet(tokenWalletKeypair, holding.tokenMint, tokensToSell);
        
        // Send any remaining SOL back to main wallet
        if (result.success) {
          const mainWallet = await getOrCreateHotWallet(userId);
          if (mainWallet) {
            const gasReserve = priorityFeeToSol(await estimatePriorityFee());
            const profitResult = await sendProfitsToMainWallet(
              tokenWalletKeypair,
              mainWallet.publicKey,
              gasReserve
            );
            if (profitResult.success && profitResult.amountSent && profitResult.amountSent > 0) {
              console.log(`Sent ${profitResult.amountSent.toFixed(4)} SOL back to main wallet after stop-loss`);
            }
          }
        }
      }
    } else {
      result = await sellToken(userId, holding.tokenMint, tokensToSell);
    }
    
    if (!result.success) {
      console.error(`Stop-loss failed for ${holding.tokenSymbol}:`, result.error);
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Mark position as stop-loss triggered and zero out
    await db.update(holdings).set({
      currentAmount: 0,
      stopLossTriggered: true,
      stopLossTimestamp: now,
      stopLossSignature: result.signature,
    }).where(eq(holdings.id, holding.id));
    
    // Resolve position score snapshots for learning (position closed at loss)
    try {
      await resolvePositionScoreSnapshots(holding.id, currentPrice, "loss_exit");
    } catch (e) {
      console.error(`Failed to resolve position snapshots:`, e);
    }
    
    // Resolve AI predictions for learning (loss outcome)
    const entryTime = holding.buyTimestamp || 0;
    const holdTimeMinutes = entryTime > 0 ? Math.floor((now - entryTime) / 60) : undefined;
    resolvePredictionsOnPositionClose(holding.tokenMint, currentPrice, holdTimeMinutes).catch(e =>
      console.error(`Failed to resolve AI predictions:`, e)
    );

    console.log(`Stop-loss executed for ${holding.tokenSymbol}:`);
    console.log(`  Loss: ${lossPercent.toFixed(1)}%`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()}`);
    console.log(`  SOL recovered: ~${result.inputAmount} SOL`);

    await sendStopLossNotification(userId, holding, tokensToSell, result.inputAmount || 0, lossPercent, result.signature);
    
    // Record trade result for autonomous mode tracking (stop-loss = loss)
    const { getSolPriceUsd } = await import("./jupiter");
    const solPrice = await getSolPriceUsd();
    const lossSol = (result.inputAmount || 0) - (holding.solSpent || 0); // Will be negative
    const lossUsd = lossSol * solPrice;
    try {
      const { recordTradeResult } = await import("./autonomous-mode");
      await recordTradeResult(userId, lossUsd);
    } catch (e) {
      console.error(`Failed to record stop-loss trade result:`, e);
    }

  } catch (error) {
    console.error(`Error executing stop-loss for ${holding.tokenSymbol}:`, error);
  }
}

export async function executeAutoMirrorSell(
  userId: number,
  holding: typeof holdings.$inferSelect,
  sellPercent: number,
  reason: string
): Promise<void> {
  try {
    if (!holding.currentAmount || holding.currentAmount <= 0) {
      console.log(`No tokens to auto-mirror sell for ${holding.tokenSymbol}`);
      return;
    }
    
    const tokensToSell = holding.currentAmount * (sellPercent / 100);
    
    if (!isFinite(tokensToSell) || tokensToSell <= 0) {
      console.log(`Invalid tokens to sell for auto-mirror ${holding.tokenSymbol}: ${tokensToSell}`);
      return;
    }

    console.log(`Executing auto-mirror sell for ${holding.tokenSymbol}: selling ${tokensToSell.toLocaleString()} tokens (${sellPercent}%)`);

    let result;
    
    // Use token wallet if available, otherwise fall back to main wallet
    if (holding.tokenWalletEncryptedKey) {
      const tokenWalletKeypair = getTokenWalletKeypair(holding.tokenWalletEncryptedKey);
      if (!tokenWalletKeypair) {
        console.error(`Failed to decrypt token wallet for ${holding.tokenSymbol}, falling back to main wallet`);
        result = await sellToken(userId, holding.tokenMint, tokensToSell);
      } else {
        result = await sellTokenWithWallet(tokenWalletKeypair, holding.tokenMint, tokensToSell);
        
        // Send SOL back to main wallet
        if (result.success) {
          const mainWallet = await getOrCreateHotWallet(userId);
          if (mainWallet) {
            const gasReserve = priorityFeeToSol(await estimatePriorityFee());
            const profitResult = await sendProfitsToMainWallet(
              tokenWalletKeypair,
              mainWallet.publicKey,
              gasReserve
            );
            if (profitResult.success && profitResult.amountSent && profitResult.amountSent > 0) {
              console.log(`Sent ${profitResult.amountSent.toFixed(4)} SOL back to main wallet after auto-mirror sell`);
            }
          }
        }
      }
    } else {
      result = await sellToken(userId, holding.tokenMint, tokensToSell);
    }
    
    if (!result.success) {
      console.error(`Auto-mirror sell failed for ${holding.tokenSymbol}:`, result.error);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const newAmount = holding.currentAmount - tokensToSell;

    await db.update(holdings).set({
      currentAmount: newAmount,
      lastSellTimestamp: now,
      lastSellSignature: result.signature,
    }).where(eq(holdings.id, holding.id));
    
    // Resolve position score snapshots for learning (signal wallet exited)
    // Calculate actual exit price from trade proceeds
    const exitPrice = (result.inputAmount && tokensToSell > 0) ? (result.inputAmount / tokensToSell) : 0;
    const entryPrice = holding.avgEntryPrice || holding.buyPrice || 0;
    const outcomeType = (entryPrice > 0 && exitPrice >= entryPrice) ? "profit_exit" : "loss_exit";
    try {
      await resolvePositionScoreSnapshots(holding.id, exitPrice, outcomeType as "profit_exit" | "loss_exit");
    } catch (e) {
      console.error(`Failed to resolve position snapshots:`, e);
    }
    
    // Resolve AI predictions for learning
    const entryTime = holding.buyTimestamp || 0;
    const holdTimeMinutes = entryTime > 0 ? Math.floor((now - entryTime) / 60) : undefined;
    resolvePredictionsOnPositionClose(holding.tokenMint, exitPrice, holdTimeMinutes).catch(e =>
      console.error(`Failed to resolve AI predictions:`, e)
    );

    console.log(`Auto-mirror sell successful for ${holding.tokenSymbol}:`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()} (${sellPercent}%)`);
    console.log(`  SOL received: ~${result.inputAmount} SOL`);
    console.log(`  Remaining: ${newAmount.toLocaleString()} tokens`);

    // Send notification
    await sendAutoMirrorSellNotification(userId, holding, tokensToSell, result.inputAmount || 0, sellPercent, result.signature, reason);
    
    // Record trade result for autonomous mode (proportional cost basis)
    const { getSolPriceUsd } = await import("./jupiter");
    const solPrice = await getSolPriceUsd();
    const percentSold = sellPercent / 100;
    const proportionalCostSol = (holding.solSpent || 0) * percentSold;
    const profitSol = (result.inputAmount || 0) - proportionalCostSol;
    const profitUsd = profitSol * solPrice;
    try {
      const { recordTradeResult } = await import("./autonomous-mode");
      await recordTradeResult(userId, profitUsd);
    } catch (e) {
      console.error(`Failed to record auto-mirror sell trade result:`, e);
    }

  } catch (error) {
    console.error(`Error executing auto-mirror sell for ${holding.tokenSymbol}:`, error);
  }
}

async function sendAutoMirrorSellNotification(
  userId: number,
  holding: typeof holdings.$inferSelect,
  tokensSold: number,
  solReceived: number,
  sellPercent: number,
  signature: string,
  reason: string
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const subject = `Auto-mirror sell: ${holding.tokenSymbol}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #ffd700; margin-bottom: 20px;">Auto-Mirror Sell: ${holding.tokenSymbol}</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <p style="color: #888; margin-bottom: 12px;">${reason}</p>
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Sold:</td>
            <td style="text-align: right;">${sellPercent}%</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Tokens Sold:</td>
            <td style="text-align: right;">${formatNumber(tokensSold)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">SOL Received:</td>
            <td style="text-align: right; color: #00ff88;">${solReceived.toFixed(4)} SOL</td>
          </tr>
        </table>
      </div>
      
      <a href="https://solscan.io/tx/${signature}" style="display: block; text-align: center; color: #64b5f6; margin-top: 16px;">View Transaction</a>
    </div>
  `;

  try {
    await sendEmail(settings.emails, subject, html);
    console.log(`Auto-mirror sell notification sent for ${holding.tokenSymbol}`);
  } catch (error) {
    console.error(`Failed to send auto-mirror sell notification:`, error);
  }
}

async function sendStopLossNotification(
  userId: number,
  holding: typeof holdings.$inferSelect,
  tokensSold: number,
  solReceived: number,
  lossPercent: number,
  signature: string
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const subject = `Stop-loss triggered: ${holding.tokenSymbol}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #ff4444; margin-bottom: 20px;">Stop-Loss Executed: ${holding.tokenSymbol}</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Loss:</td>
            <td style="text-align: right; color: #ff4444;">${lossPercent.toFixed(1)}%</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Tokens Sold:</td>
            <td style="text-align: right;">${formatNumber(tokensSold)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">SOL Recovered:</td>
            <td style="text-align: right; color: #00ff88;">${solReceived.toFixed(4)} SOL</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Original Investment:</td>
            <td style="text-align: right;">${holding.solSpent.toFixed(4)} SOL</td>
          </tr>
        </table>
      </div>
      
      <a href="https://solscan.io/tx/${signature}" style="display: block; text-align: center; color: #64b5f6; margin-top: 16px;">View Transaction</a>
    </div>
  `;

  try {
    await sendEmail(settings.emails, subject, html);
    console.log(`Stop-loss notification sent for ${holding.tokenSymbol}`);
  } catch (error) {
    console.error(`Failed to send stop-loss notification:`, error);
  }
}

async function sendMilestoneAlert(
  userId: number,
  holding: typeof holdings.$inferSelect,
  milestone: number,
  currentMultiplier: number,
  currentPrice: number
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const subject = `${holding.tokenSymbol} hit ${milestone}x`;
  
  const currentValue = holding.currentAmount * currentPrice;
  const initialValue = holding.solSpent;
  const profit = ((currentMultiplier - 1) * 100).toFixed(0);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #00ff88; margin-bottom: 20px;">${holding.tokenSymbol} Milestone: ${milestone}x</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Current Multiplier:</td>
            <td style="text-align: right; color: #00ff88; font-weight: bold;">${currentMultiplier.toFixed(2)}x</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Profit:</td>
            <td style="text-align: right; color: #00ff88;">+${profit}%</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Current Price:</td>
            <td style="text-align: right; color: #fff;">$${currentPrice < 0.0001 ? currentPrice.toExponential(2) : currentPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Buy Price:</td>
            <td style="text-align: right; color: #fff;">$${holding.buyPrice < 0.0001 ? holding.buyPrice.toExponential(2) : holding.buyPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Initial Investment:</td>
            <td style="text-align: right; color: #fff;">${holding.solSpent.toFixed(4)} SOL</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Reclaimed:</td>
            <td style="text-align: right; color: ${holding.reclaimed ? '#00ff88' : '#f59e0b'};">${holding.reclaimed ? 'Yes' : 'Not yet'}</td>
          </tr>
        </table>
      </div>
      
      <div style="margin-top: 16px;">
        <a href="https://dexscreener.com/solana/${holding.tokenMint}" style="color: #00ff88; text-decoration: none;">
          View on DexScreener
        </a>
      </div>
      
      <p style="color: #888; font-size: 12px; margin-top: 20px;">
        Milestone alert at ${new Date().toLocaleString()}
      </p>
    </div>
  `;

  for (const email of settings.emails) {
    try {
      await sendEmail(email, subject, html);
      console.log(`Milestone alert sent to ${email}`);
    } catch (error) {
      console.error(`Failed to send milestone alert to ${email}:`, error);
    }
  }
}

async function sendStopLossAlert(
  userId: number,
  holding: typeof holdings.$inferSelect,
  lossPercent: number,
  currentPrice: number
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  
  // Priority: Telegram > Email
  const telegramSettings = await storage.getTelegramSettings(userId);
  if (telegramSettings?.enabled && telegramSettings.chatId) {
    try {
      const { sendTelegramMessage } = await import("./telegram");
      const message = `*STOP-LOSS ALERT*

*${holding.tokenSymbol}* has dropped ${lossPercent.toFixed(1)}%

Current Price: $${currentPrice < 0.0001 ? currentPrice.toExponential(2) : currentPrice.toFixed(6)}
Entry Price: $${holding.buyPrice < 0.0001 ? holding.buyPrice.toExponential(2) : holding.buyPrice.toFixed(6)}
Position Value: ${(holding.currentAmount * currentPrice).toFixed(2)} USD

Mode is set to *alert* - position will NOT auto-sell.

Reply with "sell ${holding.tokenSymbol}" to execute stop-loss manually.`;
      
      await sendTelegramMessage(telegramSettings.chatId, message, { parse_mode: "Markdown" });
      console.log(`Stop-loss Telegram alert sent for ${holding.tokenSymbol}`);
      return;
    } catch (error) {
      console.error(`Failed to send stop-loss Telegram alert:`, error);
    }
  }
  
  // Fallback to email
  if (!settings?.enabled || !settings.emails?.length) {
    console.log(`No notification channels available for stop-loss alert on ${holding.tokenSymbol}`);
    return;
  }

  const subject = `STOP-LOSS ALERT: ${holding.tokenSymbol} -${lossPercent.toFixed(1)}%`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #ff4444; margin-bottom: 20px;">Stop-Loss Alert: ${holding.tokenSymbol}</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Loss:</td>
            <td style="text-align: right; color: #ff4444; font-weight: bold;">-${lossPercent.toFixed(1)}%</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Current Price:</td>
            <td style="text-align: right; color: #fff;">$${currentPrice < 0.0001 ? currentPrice.toExponential(2) : currentPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Entry Price:</td>
            <td style="text-align: right; color: #fff;">$${holding.buyPrice < 0.0001 ? holding.buyPrice.toExponential(2) : holding.buyPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Position Value:</td>
            <td style="text-align: right; color: #fff;">$${(holding.currentAmount * currentPrice).toFixed(2)}</td>
          </tr>
        </table>
      </div>
      
      <p style="color: #f59e0b; font-size: 14px;">
        Stop-loss mode is set to <strong>alert</strong>. This position will NOT auto-sell.
        Log in to Penny Pincher to execute the stop-loss manually.
      </p>
      
      <div style="margin-top: 16px;">
        <a href="https://dexscreener.com/solana/${holding.tokenMint}" style="color: #00ff88; text-decoration: none;">
          View on DexScreener
        </a>
      </div>
      
      <p style="color: #888; font-size: 12px; margin-top: 20px;">
        Stop-loss alert at ${new Date().toLocaleString()}
      </p>
    </div>
  `;

  for (const email of settings.emails) {
    try {
      await sendEmail(email, subject, html);
      console.log(`Stop-loss email alert sent to ${email}`);
    } catch (error) {
      console.error(`Failed to send stop-loss alert to ${email}:`, error);
    }
  }
}

async function sendReclaimNotification(
  userId: number,
  holding: typeof holdings.$inferSelect,
  tokensSold: number,
  solReceived: number,
  multiplier: number,
  signature: string | undefined,
  type: "initial" | "progressive"
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const isInitial = type === "initial";
  const subject = isInitial 
    ? `Reclaimed 2x initial from ${holding.tokenSymbol}`
    : `${holding.tokenSymbol}: Sold 10% at ${multiplier}x`;
  
  const description = isInitial
    ? "The remaining tokens are now pure profit. Initial investment reclaimed."
    : `Progressive take-profit: Sold 10% of holdings at ${multiplier}x milestone.`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #00ff88; margin-bottom: 20px;">${isInitial ? 'Investment Reclaimed' : 'Progressive Take-Profit'}: ${holding.tokenSymbol}</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Trigger Multiplier:</td>
            <td style="text-align: right; color: #00ff88; font-weight: bold;">${multiplier}x</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Tokens Sold:</td>
            <td style="text-align: right; color: #fff;">${formatNumber(tokensSold).replace('$', '')}${!isInitial ? ' (10%)' : ''}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">SOL Received:</td>
            <td style="text-align: right; color: #00ff88;">${solReceived.toFixed(4)} SOL</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Initial Investment:</td>
            <td style="text-align: right; color: #fff;">${holding.solSpent.toFixed(4)} SOL</td>
          </tr>
        </table>
      </div>
      
      <p style="color: #f59e0b; font-size: 14px;">
        ${description}
      </p>
      
      ${signature ? `
      <div style="margin-top: 16px;">
        <a href="https://solscan.io/tx/${signature}" style="color: #00ff88; text-decoration: none;">
          View Transaction on Solscan
        </a>
      </div>
      ` : ''}
      
      <p style="color: #888; font-size: 12px; margin-top: 20px;">
        Reclaim executed at ${new Date().toLocaleString()}
      </p>
    </div>
  `;

  for (const email of settings.emails) {
    try {
      await sendEmail(email, subject, html);
      console.log(`Reclaim notification sent to ${email}`);
    } catch (error) {
      console.error(`Failed to send reclaim notification to ${email}:`, error);
    }
  }
}

async function sendDumpAlert(
  userId: number,
  holding: typeof holdings.$inferSelect,
  currentMultiplier: number,
  currentPrice: number,
  lossPercent: number
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const subject = `${holding.tokenSymbol} DOWN ${lossPercent.toFixed(0)}%`;
  
  const currentValue = holding.currentAmount * currentPrice;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #ff4444; margin-bottom: 20px;">${holding.tokenSymbol} Price Alert</h2>
      
      <div style="background: #2d1f1f; padding: 16px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #ff4444;">
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">Loss:</td>
            <td style="text-align: right; color: #ff4444; font-weight: bold;">-${lossPercent.toFixed(1)}%</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Current Multiplier:</td>
            <td style="text-align: right; color: #ff4444;">${currentMultiplier.toFixed(2)}x</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Current Price:</td>
            <td style="text-align: right; color: #fff;">$${currentPrice < 0.0001 ? currentPrice.toExponential(2) : currentPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Buy Price:</td>
            <td style="text-align: right; color: #fff;">$${holding.buyPrice < 0.0001 ? holding.buyPrice.toExponential(2) : holding.buyPrice.toFixed(6)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Initial Investment:</td>
            <td style="text-align: right; color: #fff;">${holding.solSpent.toFixed(4)} SOL</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Tokens Remaining:</td>
            <td style="text-align: right; color: #fff;">${formatNumber(holding.currentAmount).replace('$', '')}</td>
          </tr>
        </table>
      </div>
      
      <p style="color: #f59e0b; font-size: 14px;">
        Consider selling if you believe the price will continue to drop.
      </p>
      
      <div style="margin-top: 16px;">
        <a href="https://dexscreener.com/solana/${holding.tokenMint}" style="color: #00ff88; text-decoration: none;">
          View on DexScreener
        </a>
      </div>
      
      <p style="color: #888; font-size: 12px; margin-top: 20px;">
        Dump alert at ${new Date().toLocaleString()}
      </p>
    </div>
  `;

  for (const email of settings.emails) {
    try {
      await sendEmail(email, subject, html);
      console.log(`Dump alert sent to ${email}`);
    } catch (error) {
      console.error(`Failed to send dump alert to ${email}:`, error);
    }
  }
}

let factorDiscoveryInterval: ReturnType<typeof setInterval> | null = null;

// Run factor discovery periodically to find new correlations
async function runFactorDiscovery(): Promise<void> {
  try {
    const suggestions = await discoverNewFactors();
    
    // Save any new factors that meet the threshold
    for (const suggestion of suggestions) {
      if (suggestion.correlationStrength > 0.3 && suggestion.sampleSize >= 20) {
        await saveDiscoveredFactor(suggestion);
        console.log(`[FactorDiscovery] Saved new ${suggestion.factorType} factor: ${suggestion.factorName}`);
      }
    }
  } catch (error) {
    console.error("[FactorDiscovery] Error running discovery:", error);
  }
}

export function startPriceMonitor(): void {
  if (priceMonitorInterval) {
    return;
  }

  console.log("Starting price monitor...");
  priceMonitorInterval = setInterval(checkPricesAndReclaim, PRICE_CHECK_INTERVAL_MS);
  checkPricesAndReclaim();
  
  // Start the aggregation job (runs every 60 seconds)
  startAggregationJob(60000);
  
  // Start factor discovery (runs hourly for faster learning)
  const FACTOR_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  factorDiscoveryInterval = setInterval(runFactorDiscovery, FACTOR_DISCOVERY_INTERVAL_MS);
  // Run initial discovery after 5 minutes
  setTimeout(runFactorDiscovery, 5 * 60 * 1000);
}

export function stopPriceMonitor(): void {
  if (priceMonitorInterval) {
    clearInterval(priceMonitorInterval);
    priceMonitorInterval = null;
    console.log("Price monitor stopped");
  }
  
  if (factorDiscoveryInterval) {
    clearInterval(factorDiscoveryInterval);
    factorDiscoveryInterval = null;
  }
  
  // Stop the aggregation job
  stopAggregationJob();
}
