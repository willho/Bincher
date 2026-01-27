import { db } from "./db";
import { pendingBuys, holdings, tradeConfig } from "@shared/schema";
import { eq, and, lte, or } from "drizzle-orm";
import { 
  getTradeConfig, 
  getHotWalletBalance, 
  getAllPendingBuys, 
  getHotWalletKeypair,
  generateTokenWallet,
  getTokenWalletKeypair,
  fundTokenWallet,
  getOrCreateHotWallet
} from "./wallet";
import { buyTokenWithWallet, getTokenPrice, estimatePriorityFee, priorityFeeToSol } from "./jupiter";
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
          eq(pendingBuys.status, "active"),
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
          eq(pendingBuys.status, "active")
        )
      )
      .returning();
    
    if (updateResult.length === 0) {
      console.log("Pending buy already processed, paused, cancelled, or locked:", pendingId);
      return false;
    }

    const buy = updateResult[0];
    const isSegmentedBuy = (buy.totalSegments ?? 1) > 1;
    
    // For non-segmented buys only: prevent duplicate holdings
    // Segmented buys are expected to add to existing holdings
    if (!isSegmentedBuy) {
      const existingHolding = await db.select().from(holdings).where(
        and(eq(holdings.tokenMint, buy.tokenMint), eq(holdings.userId, userId))
      ).limit(1);
      if (existingHolding.length > 0) {
        console.log(`Already have holding for ${buy.tokenSymbol}, skipping buy`);
        await db.update(pendingBuys).set({
          status: "cancelled",
          triggerReason: "already_holding",
        }).where(eq(pendingBuys.id, pendingId));
        return false;
      }
    }

    const balance = await getHotWalletBalance(userId);
    
    // Estimate priority fee for funding calculation
    const priorityFeeLamports = await estimatePriorityFee();
    const priorityFeeSol = priorityFeeToSol(priorityFeeLamports);
    
    // Use pre-calculated segment amount if available, otherwise calculate
    const solAmount = buy.solAmount ?? balance * 0.1;
    const gasReserve = (priorityFeeSol * 4) + 0.002; // 4x priority + base fee buffer
    const totalRequired = solAmount + gasReserve;
    
    if (balance < totalRequired + 0.005) {
      console.error(`Hot wallet balance too low: ${balance.toFixed(4)} SOL < ${totalRequired.toFixed(4)} SOL required`);
      await pausePendingBuy(pendingId, "insufficient_funds");
      return false;
    }

    let tokenWallet: { publicKey: string; encryptedPrivateKey: string };
    let tokenWalletKeypair: ReturnType<typeof getTokenWalletKeypair>;
    
    // Token wallet is created at queue time and stored on ALL segments
    // This ensures any segment can execute first (e.g., early price trigger)
    if (buy.tokenWalletEncryptedKey && buy.tokenWalletPublicKey) {
      // Use pre-created token wallet from pending buy record
      tokenWallet = {
        publicKey: buy.tokenWalletPublicKey,
        encryptedPrivateKey: buy.tokenWalletEncryptedKey,
      };
      tokenWalletKeypair = getTokenWalletKeypair(tokenWallet.encryptedPrivateKey);
      if (!tokenWalletKeypair) {
        console.error("Failed to decrypt token wallet keypair");
        await cancelPendingBuy(pendingId, "token_wallet_decrypt_failed");
        return false;
      }
      
      const segmentInfo = isSegmentedBuy ? `Segment ${buy.segmentIndex}/${buy.totalSegments}: ` : "";
      console.log(`${segmentInfo}Using token wallet ${tokenWallet.publicKey}`);
    } else {
      // Legacy fallback: generate new token wallet (for old pending buys without wallet)
      console.log(`Generating token wallet for ${buy.tokenSymbol} buy (legacy)...`);
      tokenWallet = generateTokenWallet();
      console.log(`Created token wallet: ${tokenWallet.publicKey}`);
      
      tokenWalletKeypair = getTokenWalletKeypair(tokenWallet.encryptedPrivateKey);
      if (!tokenWalletKeypair) {
        console.error("Failed to decrypt token wallet keypair");
        await cancelPendingBuy(pendingId, "token_wallet_decrypt_failed");
        return false;
      }
    }
    
    // Get main wallet keypair to fund token wallet
    const mainWalletKeypair = await getHotWalletKeypair(userId);
    if (!mainWalletKeypair) {
      console.error("Failed to get main wallet keypair");
      await cancelPendingBuy(pendingId, "main_wallet_not_found");
      return false;
    }
    
    // Fund token wallet with buyAmount + gas reserve
    console.log(`Funding token wallet with ${totalRequired.toFixed(4)} SOL...`);
    const fundResult = await fundTokenWallet(mainWalletKeypair, tokenWallet.publicKey, totalRequired);
    if (!fundResult.success) {
      console.error("Failed to fund token wallet:", fundResult.error);
      await cancelPendingBuy(pendingId, `funding_failed: ${fundResult.error}`);
      return false;
    }
    console.log(`Token wallet funded: ${fundResult.signature}`);
    
    const segmentInfo = isSegmentedBuy ? ` (segment ${buy.segmentIndex}/${buy.totalSegments})` : "";
    console.log(`Buying ${buy.tokenSymbol} with ${solAmount.toFixed(4)} SOL${segmentInfo}`);

    const result = await buyTokenWithWallet(tokenWalletKeypair, buy.tokenMint, solAmount);

    if (!result.success) {
      console.error("Buy failed:", result.error);
      await cancelPendingBuy(pendingId, `buy_failed: ${result.error}`);
      return false;
    }

    const currentPrice = await getTokenPrice(buy.tokenMint);
    const now = Math.floor(Date.now() / 1000);

    // Check if holding already exists (for segmented buys, any segment can execute first)
    const existingHolding = await db.select().from(holdings).where(
      and(eq(holdings.tokenMint, buy.tokenMint), eq(holdings.userId, userId))
    ).limit(1);
    
    if (existingHolding.length > 0) {
      // Update existing holding (add to amounts)
      const holding = existingHolding[0];
      const newAmountBought = (holding.amountBought || 0) + (result.outputAmount || 0);
      const newSolSpent = (holding.solSpent || 0) + (result.inputAmount || solAmount);
      const newCurrentAmount = (holding.currentAmount || 0) + (result.outputAmount || 0);
      
      await db.update(holdings).set({
        amountBought: newAmountBought,
        solSpent: newSolSpent,
        currentAmount: newCurrentAmount,
        lastPriceCheck: now,
        lastPrice: currentPrice,
      }).where(eq(holdings.id, holding.id));
      
      console.log(`Updated holding for ${buy.tokenSymbol}${segmentInfo}`);
    } else {
      // Create new holding
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
        tokenWalletPublicKey: tokenWallet.publicKey,
        tokenWalletEncryptedKey: tokenWallet.encryptedPrivateKey,
      });
      
      console.log(`Created holding for ${buy.tokenSymbol}${segmentInfo}`);
    }

    await db.update(pendingBuys).set({
      buyTriggered: true,
      status: "completed",
      triggerReason: `completed:${triggerReason}`,
    }).where(eq(pendingBuys.id, pendingId));

    console.log(`Successfully bought ${buy.tokenSymbol}${segmentInfo}:`);
    console.log(`  Signature: ${result.signature}`);
    console.log(`  Amount: ${result.outputAmount?.toLocaleString()} tokens`);
    console.log(`  Spent: ${result.inputAmount?.toFixed(4)} SOL`);

    await sendBuyNotification(userId, buy.tokenSymbol, result.inputAmount || solAmount, result.outputAmount || 0, currentPrice, result.signature, buy.segmentIndex, buy.totalSegments);

    return true;
  } catch (error) {
    console.error("Error executing pending buy:", error);
    await cancelPendingBuy(pendingId, `error: ${error}`);
    return false;
  }
}

async function pausePendingBuy(pendingId: number, reason: string): Promise<void> {
  await db.update(pendingBuys).set({
    status: "paused",
    pauseReason: reason,
    triggerReason: null,
  }).where(eq(pendingBuys.id, pendingId));
  console.log(`Paused pending buy ${pendingId}: ${reason}`);
}

async function cancelPendingBuy(pendingId: number, reason: string): Promise<void> {
  await db.update(pendingBuys).set({
    status: "cancelled",
    triggerReason: reason,
  }).where(eq(pendingBuys.id, pendingId));
  console.log(`Cancelled pending buy ${pendingId}: ${reason}`);
}

export async function resumePendingBuy(pendingId: number): Promise<boolean> {
  const result = await db.update(pendingBuys).set({
    status: "active",
    pauseReason: null,
  }).where(
    and(
      eq(pendingBuys.id, pendingId),
      eq(pendingBuys.status, "paused")
    )
  ).returning();
  if (result.length > 0) {
    console.log(`Resumed pending buy ${pendingId}`);
    return true;
  }
  return false;
}

export async function userCancelPendingBuy(pendingId: number, userId: number): Promise<boolean> {
  // Only allow cancelling active or paused pending buys (not completed/already cancelled)
  const result = await db.update(pendingBuys).set({
    status: "cancelled",
    triggerReason: "user_cancelled",
  }).where(
    and(
      eq(pendingBuys.id, pendingId),
      eq(pendingBuys.userId, userId),
      or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused"))
    )
  ).returning();
  if (result.length > 0) {
    console.log(`User cancelled pending buy ${pendingId}`);
    return true;
  }
  return false;
}

export async function userPausePendingBuy(pendingId: number, userId: number): Promise<boolean> {
  const result = await db.update(pendingBuys).set({
    status: "paused",
    pauseReason: "user_paused",
  }).where(
    and(
      eq(pendingBuys.id, pendingId),
      eq(pendingBuys.userId, userId),
      eq(pendingBuys.status, "active")
    )
  ).returning();
  if (result.length > 0) {
    console.log(`User paused pending buy ${pendingId}`);
    return true;
  }
  return false;
}

export async function userResumePendingBuy(pendingId: number, userId: number): Promise<boolean> {
  const result = await db.update(pendingBuys).set({
    status: "active",
    pauseReason: null,
  }).where(
    and(
      eq(pendingBuys.id, pendingId),
      eq(pendingBuys.userId, userId),
      eq(pendingBuys.status, "paused")
    )
  ).returning();
  if (result.length > 0) {
    console.log(`User resumed pending buy ${pendingId}`);
    return true;
  }
  return false;
}

async function sendBuyNotification(
  userId: number,
  tokenSymbol: string,
  solSpent: number,
  tokenAmount: number,
  price: number | null,
  signature: string | undefined,
  segmentIndex?: number | null,
  totalSegments?: number | null
): Promise<void> {
  const settings = await storage.getNotificationSettings(userId);
  if (!settings?.enabled || !settings.emails?.length) {
    return;
  }

  const isSegmented = (totalSegments ?? 1) > 1;
  const segmentInfo = isSegmented ? ` (Segment ${segmentIndex}/${totalSegments})` : "";
  const subject = `Copy Trade: Bought ${tokenSymbol}${segmentInfo}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 20px; border-radius: 12px;">
      <h2 style="color: #00ff88; margin-bottom: 20px;">Copy Trade Executed${segmentInfo}</h2>
      
      <div style="background: #16213e; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <h3 style="color: #00ff88; margin: 0 0 12px 0;">${tokenSymbol}</h3>
        <table style="width: 100%; color: #e0e0e0;">
          ${isSegmented ? `
          <tr>
            <td style="padding: 4px 0;">Segment:</td>
            <td style="text-align: right; color: #fff;">${segmentIndex} of ${totalSegments}</td>
          </tr>
          ` : ''}
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
        eq(pendingBuys.status, "active")
      )
    );

  for (const p of pending) {
    if (!p.userId) continue;
    
    const newCount = (p.buyCount || 0) + 1;
    const initialCount = p.initialBuyCount || 0;
    await db.update(pendingBuys)
      .set({ buyCount: newCount })
      .where(eq(pendingBuys.id, p.id));

    const config = await getTradeConfig(p.userId);
    const buysSinceQueued = newCount - initialCount;
    if (buysSinceQueued >= config.highVolumeBuyCount) {
      console.log(`High volume detected for ${p.tokenSymbol}: ${buysSinceQueued} buys since queued`);
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
        eq(pendingBuys.status, "active")
      )
    );

  for (const p of pending) {
    if (!p.userId || !p.initialPrice) continue;

    const priceRise = ((currentPrice - p.initialPrice) / p.initialPrice) * 100;
    
    // Trigger early if price rises 10% from queue time (hard-coded per user request)
    const PRICE_RISE_TRIGGER_PERCENT = 10;
    if (priceRise >= PRICE_RISE_TRIGGER_PERCENT) {
      console.log(`Price rise trigger for ${p.tokenSymbol}: ${priceRise.toFixed(1)}% rise (threshold: ${PRICE_RISE_TRIGGER_PERCENT}%)`);
      await triggerEarlyBuy(p.id, p.userId, "price_rise");
    }
  }
}
