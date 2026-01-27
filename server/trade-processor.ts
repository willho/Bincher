import { db } from "./db";
import { pendingBuys, holdings, tradeConfig } from "@shared/schema";
import { eq, and, lte } from "drizzle-orm";
import { getTradeConfig, getHotWalletBalance, getAllPendingBuys } from "./wallet";
import { buyToken, getTokenPrice } from "./jupiter";
import { sendEmail, formatNumber } from "./email";
import { storage } from "./storage";

const PROCESSOR_INTERVAL_MS = 30000;

let isProcessorRunning = false;
let processorInterval: NodeJS.Timeout | null = null;

export async function processPendingBuys(): Promise<void> {
  if (isProcessorRunning) {
    return;
  }

  isProcessorRunning = true;
  
  try {
    const now = Math.floor(Date.now() / 1000);
    
    const readyBuys = await db.select()
      .from(pendingBuys)
      .where(
        and(
          eq(pendingBuys.cancelled, false),
          eq(pendingBuys.buyTriggered, false),
          lte(pendingBuys.scheduledBuyAt, now)
        )
      );

    for (const pending of readyBuys) {
      if (!pending.userId) {
        console.log(`Skipping pending buy ${pending.id} with no userId`);
        continue;
      }
      
      const config = await getTradeConfig(pending.userId);
      if (!config.enabled) {
        continue;
      }

      if (pending.triggerReason?.startsWith("processing:")) {
        console.log(`Recovering stuck pending buy for ${pending.tokenSymbol}...`);
        await db.update(pendingBuys).set({
          triggerReason: null,
        }).where(eq(pendingBuys.id, pending.id));
      }
      
      console.log(`Processing pending buy for ${pending.tokenSymbol} (user ${pending.userId})...`);
      await executePendingBuy(pending.id, pending.userId, "timer_expired");
    }
  } catch (error) {
    console.error("Error processing pending buys:", error);
  } finally {
    isProcessorRunning = false;
  }
}

export async function triggerEarlyBuy(
  pendingId: number,
  userId: number,
  reason: "high_volume" | "price_rise"
): Promise<void> {
  console.log(`Triggering early buy for pending ${pendingId} (user ${userId}): ${reason}`);
  await executePendingBuy(pendingId, userId, reason);
}

export async function executePendingBuy(
  pendingId: number,
  userId: number,
  triggerReason: string
): Promise<boolean> {
  try {
    // Atomic lock: only update if not already processing/triggered/cancelled
    const updateResult = await db.update(pendingBuys)
      .set({ triggerReason: `processing:${triggerReason}` })
      .where(
        and(
          eq(pendingBuys.id, pendingId),
          eq(pendingBuys.buyTriggered, false),
          eq(pendingBuys.cancelled, false)
        )
      )
      .returning();
    
    if (updateResult.length === 0) {
      console.log("Pending buy already processed, cancelled, or locked:", pendingId);
      return false;
    }

    const buy = updateResult[0];
    
    // Check if we already have a holding for this token for this user (prevent duplicates)
    const existingHolding = await db.select().from(holdings).where(
      and(eq(holdings.tokenMint, buy.tokenMint), eq(holdings.userId, userId))
    ).limit(1);
    if (existingHolding.length > 0) {
      console.log(`Already have holding for ${buy.tokenSymbol}, skipping buy`);
      await db.update(pendingBuys).set({
        cancelled: true,
        triggerReason: "already_holding",
      }).where(eq(pendingBuys.id, pendingId));
      return false;
    }

    const config = await getTradeConfig(userId);
    const balance = await getHotWalletBalance(userId);
    
    if (balance < 0.01) {
      console.error("Hot wallet balance too low:", balance);
      await cancelPendingBuy(pendingId, "insufficient_balance");
      return false;
    }

    const solAmount = balance * (config.buyPercentage / 100);
    
    console.log(`Buying ${buy.tokenSymbol} with ${solAmount.toFixed(4)} SOL (${config.buyPercentage}% of ${balance.toFixed(4)} SOL)`);

    const result = await buyToken(userId, buy.tokenMint, solAmount);

    if (!result.success) {
      console.error("Buy failed:", result.error);
      await cancelPendingBuy(pendingId, `buy_failed: ${result.error}`);
      return false;
    }

    const currentPrice = await getTokenPrice(buy.tokenMint);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(holdings).values({
      userId: userId,
      tokenMint: buy.tokenMint,
      tokenSymbol: buy.tokenSymbol,
      tokenName: buy.tokenName,
      amountBought: result.outputAmount || 0,
      solSpent: result.inputAmount || solAmount,
      buyPrice: currentPrice || buy.initialPrice || 0,
      buyTimestamp: now,
      buySignature: result.signature || "",
      currentAmount: result.outputAmount || 0,
      reclaimed: false,
      lastPriceCheck: now,
      lastPrice: currentPrice,
      highestMultiplier: 1,
      alertedMilestones: [],
    });

    await db.update(pendingBuys).set({
      buyTriggered: true,
      triggerReason: `completed:${triggerReason}`,
    }).where(eq(pendingBuys.id, pendingId));

    console.log(`Successfully bought ${buy.tokenSymbol}:`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Amount: ${result.outputAmount?.toLocaleString()} tokens`);
    console.log(`  Spent: ${result.inputAmount?.toFixed(4)} SOL`);

    await sendBuyNotification(userId, buy.tokenSymbol, result.inputAmount || solAmount, result.outputAmount || 0, currentPrice, result.signature);

    return true;
  } catch (error) {
    console.error("Error executing pending buy:", error);
    await cancelPendingBuy(pendingId, `error: ${error}`);
    return false;
  }
}

async function cancelPendingBuy(pendingId: number, reason: string): Promise<void> {
  await db.update(pendingBuys).set({
    cancelled: true,
    triggerReason: reason,
  }).where(eq(pendingBuys.id, pendingId));
  console.log(`Cancelled pending buy ${pendingId}: ${reason}`);
}

async function sendBuyNotification(
  userId: number,
  tokenSymbol: string,
  solSpent: number,
  tokenAmount: number,
  price: number | null,
  signature: string | undefined
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const subject = `Copy Trade: Bought ${tokenSymbol}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #00ff88; margin-bottom: 20px;">Copy Trade Executed</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <h3 style="color: #00ff88; margin: 0 0 12px 0;">${tokenSymbol}</h3>
        <table style="width: 100%; color: #e0e0e0;">
          <tr>
            <td style="padding: 4px 0;">SOL Spent:</td>
            <td style="text-align: right; color: #fff;">${solSpent.toFixed(4)} SOL</td>
          </tr>
          <tr>
            <td style="padding: 4px 0;">Tokens Received:</td>
            <td style="text-align: right; color: #fff;">${formatNumber(tokenAmount)}</td>
          </tr>
          ${price ? `
          <tr>
            <td style="padding: 4px 0;">Price:</td>
            <td style="text-align: right; color: #fff;">$${price < 0.0001 ? price.toExponential(2) : price.toFixed(6)}</td>
          </tr>
          ` : ''}
        </table>
      </div>
      
      ${signature ? `
      <div style="margin-top: 16px;">
        <a href="https://solscan.io/tx/${signature}" style="color: #00ff88; text-decoration: none;">
          View Transaction on Solscan
        </a>
      </div>
      ` : ''}
      
      <p style="color: #888; font-size: 12px; margin-top: 20px;">
        Copy trade executed at ${new Date().toLocaleString()}
      </p>
    </div>
  `;

  for (const email of settings.emails) {
    try {
      await sendEmail(email, subject, html);
      console.log(`Buy notification sent to ${email}`);
    } catch (error) {
      console.error(`Failed to send buy notification to ${email}:`, error);
    }
  }
}

export function startTradeProcessor(): void {
  if (processorInterval) {
    return;
  }

  console.log("Starting trade processor...");
  processorInterval = setInterval(processPendingBuys, PROCESSOR_INTERVAL_MS);
  processPendingBuys();
}

export function stopTradeProcessor(): void {
  if (processorInterval) {
    clearInterval(processorInterval);
    processorInterval = null;
    console.log("Trade processor stopped");
  }
}

export async function updateBuyCount(tokenMint: string): Promise<void> {
  const pending = await db.select().from(pendingBuys)
    .where(
      and(
        eq(pendingBuys.tokenMint, tokenMint),
        eq(pendingBuys.buyTriggered, false),
        eq(pendingBuys.cancelled, false)
      )
    );

  for (const p of pending) {
    if (!p.userId) continue;
    
    const newCount = (p.buyCount || 0) + 1;
    await db.update(pendingBuys)
      .set({ buyCount: newCount })
      .where(eq(pendingBuys.id, p.id));

    const config = await getTradeConfig(p.userId);
    if (newCount >= config.highVolumeBuyCount) {
      console.log(`High volume detected for ${p.tokenSymbol}: ${newCount} buys`);
      await triggerEarlyBuy(p.id, p.userId, "high_volume");
    }
  }
}

export async function checkPriceRiseTrigger(tokenMint: string, currentPrice: number): Promise<void> {
  const pending = await db.select().from(pendingBuys)
    .where(
      and(
        eq(pendingBuys.tokenMint, tokenMint),
        eq(pendingBuys.buyTriggered, false),
        eq(pendingBuys.cancelled, false)
      )
    );

  for (const p of pending) {
    if (!p.userId || !p.initialPrice) continue;

    const priceRise = ((currentPrice - p.initialPrice) / p.initialPrice) * 100;
    
    const config = await getTradeConfig(p.userId);
    if (priceRise >= config.priceRiseTriggerPercent) {
      console.log(`Price rise trigger for ${p.tokenSymbol}: ${priceRise.toFixed(1)}% rise`);
      await triggerEarlyBuy(p.id, p.userId, "price_rise");
    }
  }
}
