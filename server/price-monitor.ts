import { db } from "./db";
import { holdings, pendingBuys, tradeConfig, tokenEvents } from "@shared/schema";
import { eq, and } from "drizzle-orm";
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

const PRICE_CHECK_INTERVAL_MS = 30000;
const MIN_CHECK_INTERVAL_PER_TOKEN_MS = 30000;

const SWING_THRESHOLD_PERCENT = 10;
const SWING_5MIN_THRESHOLD_PERCENT = 5;
const SWING_VALUE_WEIGHTED_THRESHOLD_PERCENT = 3;
const SWING_VALUE_WEIGHTED_MIN_USD = 1000;
const SWING_COOLDOWN_MS = 180000;
const PRICE_HISTORY_WINDOW_MS = 300000;

let isPriceMonitorRunning = false;
let priceMonitorInterval: NodeJS.Timeout | null = null;

const tokenCheckTimestamps: Map<string, number> = new Map();
const swingEventCooldowns: Map<string, number> = new Map();
const priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();

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
    
    const now = Date.now();
    const tokenMintsToCheck = new Set<string>();
    
    const holdingsToProcess: typeof holdingsList = [];
    for (const holding of holdingsList) {
      if (!holding.userId) continue;
      
      const lastCheck = tokenCheckTimestamps.get(`${holding.userId}_${holding.tokenMint}`) || 0;
      if (now - lastCheck < MIN_CHECK_INTERVAL_PER_TOKEN_MS) continue;
      
      holdingsToProcess.push(holding);
      tokenMintsToCheck.add(holding.tokenMint);
    }
    
    const pendingsToProcess: typeof pendingBuysList = [];
    for (const pending of pendingBuysList) {
      if (!pending.initialPrice || !pending.userId) continue;
      
      const lastCheck = tokenCheckTimestamps.get(`pending_${pending.userId}_${pending.tokenMint}`) || 0;
      if (now - lastCheck < MIN_CHECK_INTERVAL_PER_TOKEN_MS) continue;
      
      pendingsToProcess.push(pending);
      tokenMintsToCheck.add(pending.tokenMint);
    }
    
    if (tokenMintsToCheck.size === 0) {
      return;
    }
    
    const batchPrices = await getBatchTokenPrices([...tokenMintsToCheck]);
    
    for (const holding of holdingsToProcess) {
      const priceData = batchPrices.get(holding.tokenMint);
      if (!priceData || priceData.price === null) continue;
      
      const config = await getTradeConfig(holding.userId!);
      if (!config.enabled) continue;
      
      tokenCheckTimestamps.set(`${holding.userId}_${holding.tokenMint}`, now);
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
    }
    
    const progressiveMilestones = [10, 100, 1000, 10000, 100000];
    for (const milestone of progressiveMilestones) {
      if (multiplier >= milestone && !reclaimedMilestones.includes(milestone)) {
        console.log(`Progressive reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${milestone}x`);
        await executeProgressiveReclaim(userId, holding, currentPrice, milestone);
        break;
      }
    }
    
    if (config.dumpAlertEnabled && !holding.dumpAlertSent) {
      const lossPercent = ((holding.buyPrice - currentPrice) / holding.buyPrice) * 100;
      if (lossPercent >= config.dumpAlertThreshold) {
        console.log(`Dump alert for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss`);
        await sendDumpAlert(userId, holding, multiplier, currentPrice, lossPercent);
        await db.update(holdings).set({
          dumpAlertSent: true,
        }).where(eq(holdings.id, holding.id));
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
    }
    
    const progressiveMilestones = [10, 100, 1000, 10000, 100000];
    for (const milestone of progressiveMilestones) {
      if (multiplier >= milestone && !reclaimedMilestones.includes(milestone)) {
        console.log(`Progressive reclaim trigger for ${holding.tokenSymbol}: ${multiplier.toFixed(2)}x >= ${milestone}x`);
        await executeProgressiveReclaim(userId, holding, currentPrice, milestone);
        break;
      }
    }
    
    if (config.dumpAlertEnabled && !holding.dumpAlertSent) {
      const lossPercent = ((holding.buyPrice - currentPrice) / holding.buyPrice) * 100;
      if (lossPercent >= config.dumpAlertThreshold) {
        console.log(`Dump alert for ${holding.tokenSymbol}: ${lossPercent.toFixed(1)}% loss`);
        await sendDumpAlert(userId, holding, multiplier, currentPrice, lossPercent);
        await db.update(holdings).set({
          dumpAlertSent: true,
        }).where(eq(holdings.id, holding.id));
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

    console.log(`Reclaim successful for ${holding.tokenSymbol}:`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()}`);
    console.log(`  SOL received: ~${result.inputAmount} SOL`);
    console.log(`  Remaining: ${newAmount.toLocaleString()} tokens`);

    await sendReclaimNotification(userId, holding, tokensToSell, result.inputAmount || 0, reclaimMultiplier, result.signature, "initial");

  } catch (error) {
    console.error(`Error executing reclaim for ${holding.tokenSymbol}:`, error);
  }
}

async function executeProgressiveReclaim(
  userId: number,
  holding: typeof holdings.$inferSelect,
  currentPrice: number,
  milestone: number
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
    
    const tokensToSell = holding.currentAmount * 0.1;
    
    if (!isFinite(tokensToSell) || tokensToSell <= 0) {
      console.log(`Invalid tokens to sell for ${holding.tokenSymbol}: ${tokensToSell}`);
      return;
    }

    console.log(`Executing progressive reclaim for ${holding.tokenSymbol} at ${milestone}x: selling ${tokensToSell.toLocaleString()} tokens (10%)`);

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

    console.log(`Progressive reclaim successful for ${holding.tokenSymbol}:`);
    console.log(`  Milestone: ${milestone}x`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Tokens sold: ${tokensToSell.toLocaleString()} (10%)`);
    console.log(`  SOL received: ~${result.inputAmount} SOL`);
    console.log(`  Remaining: ${newAmount.toLocaleString()} tokens`);

    await sendReclaimNotification(userId, holding, tokensToSell, result.inputAmount || 0, milestone, result.signature, "progressive");

  } catch (error) {
    console.error(`Error executing progressive reclaim for ${holding.tokenSymbol}:`, error);
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

export function startPriceMonitor(): void {
  if (priceMonitorInterval) {
    return;
  }

  console.log("Starting price monitor...");
  priceMonitorInterval = setInterval(checkPricesAndReclaim, PRICE_CHECK_INTERVAL_MS);
  checkPricesAndReclaim();
}

export function stopPriceMonitor(): void {
  if (priceMonitorInterval) {
    clearInterval(priceMonitorInterval);
    priceMonitorInterval = null;
    console.log("Price monitor stopped");
  }
}
