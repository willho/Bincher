import { db } from "./db";
import { pendingBuys, holdings, tradeConfig, positionScoreSnapshots } from "@shared/schema";
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
import { logError, logSuccess, logWarn } from "./system-logger";

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

      // Skip "triggered" timing buys in timer loop - they only execute on explicit triggers
      if (pending.copyTiming === "triggered") {
        console.log(`Skipping triggered-only buy for ${pending.tokenSymbol} (waiting for trigger)`);
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
    // Check autonomous mode stop conditions before executing
    const { canExecuteTrade } = await import("./autonomous-mode");
    const tradeCheck = await canExecuteTrade(userId);
    if (!tradeCheck.allowed) {
      console.log(`[Autonomous] Trade blocked for user ${userId}: ${tradeCheck.reason}`);
      await cancelPendingBuy(pendingId, `autonomous_blocked: ${tradeCheck.reason}`);
      return false;
    }
    
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
    
    // For non-segmented buys only: check for duplicate holdings BY SOURCE
    // Multiple positions for same token are allowed from different signal wallets
    // Segmented buys are expected to add to existing holdings
    if (!isSegmentedBuy) {
      const dupConditions = [
        eq(holdings.tokenMint, buy.tokenMint),
        eq(holdings.userId, userId),
        eq(holdings.reclaimed, false),
        eq(holdings.positionSource, "copy"),
      ];
      
      // Check by signal source identity
      if (buy.signalWalletId) {
        dupConditions.push(eq(holdings.signalWalletId, buy.signalWalletId));
      } else if (buy.sourceWalletAddress) {
        dupConditions.push(eq(holdings.sourceWalletAddress, buy.sourceWalletAddress));
      }
      
      const existingHolding = await db.select().from(holdings).where(and(...dupConditions)).limit(1);
      if (existingHolding.length > 0) {
        // Position already exists for this source - will be topped up later
        console.log(`Found existing position for ${buy.tokenSymbol} from same source, will top up`);
      }
    }

    const balance = await getHotWalletBalance(userId);
    const config = await getTradeConfig(userId);
    
    // Get current SOL price for USD conversions
    const { getSolPriceUsd } = await import("./jupiter");
    const solPriceUsd = await getSolPriceUsd();
    
    // Estimate priority fee early for proper reserve calculation
    const priorityFeeLamports = await estimatePriorityFee();
    const priorityFeeSol = priorityFeeToSol(priorityFeeLamports);
    const estimatedGasReserve = (priorityFeeSol * 4) + 0.002; // 4x priority + base fee buffer
    
    // Trading budget limit enforcement
    // 1. Check min reserve requirement (includes gas reserves)
    const minReserveSol = config.minReserveSol ?? 0;
    const totalReserve = minReserveSol + estimatedGasReserve + 0.005; // Reserve + gas + safety buffer
    const availableBalance = Math.max(0, balance - totalReserve);
    if (availableBalance <= 0) {
      console.log(`Budget: Wallet reserve protection triggered. Balance: ${balance.toFixed(4)}, Total reserve needed: ${totalReserve.toFixed(4)}`);
      await cancelPendingBuy(pendingId, "min_reserve_protection");
      return false;
    }
    
    // Calculate intended trade amount in USD
    const intendedSolAmount = buy.solAmount ?? (balance * (config.buyPercentage || 10) / 100);
    const intendedUsd = intendedSolAmount * solPriceUsd;
    
    // 2. Check max per-trade limit
    let cappedSolAmount = intendedSolAmount;
    if (config.maxTradeUsd && config.maxTradeUsd > 0 && intendedUsd > config.maxTradeUsd) {
      cappedSolAmount = config.maxTradeUsd / solPriceUsd;
      console.log(`Budget: Trade capped from $${intendedUsd.toFixed(2)} to $${config.maxTradeUsd.toFixed(2)} (max per trade)`);
    }
    
    // 3. Check daily spend limit
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const startOfDay = currentTimestamp - (currentTimestamp % 86400);
    let dailySpent = config.dailySpentUsd ?? 0;
    const dailyReset = config.dailySpentResetAt ?? 0;
    
    // Reset daily spend if new day
    if (dailyReset < startOfDay) {
      dailySpent = 0;
    }
    
    if (config.maxDailySpendUsd && config.maxDailySpendUsd > 0) {
      const remainingDaily = Math.max(0, config.maxDailySpendUsd - dailySpent);
      const cappedUsd = cappedSolAmount * solPriceUsd;
      
      if (remainingDaily <= 0) {
        console.log(`Budget: Daily limit exhausted ($${dailySpent.toFixed(2)}/${config.maxDailySpendUsd.toFixed(2)})`);
        await cancelPendingBuy(pendingId, "daily_limit_reached");
        return false;
      }
      
      if (cappedUsd > remainingDaily) {
        cappedSolAmount = remainingDaily / solPriceUsd;
        console.log(`Budget: Trade capped from $${cappedUsd.toFixed(2)} to $${remainingDaily.toFixed(2)} (daily limit)`);
      }
    }
    
    // 4. Cap to available balance (after reserve)
    if (cappedSolAmount > availableBalance) {
      cappedSolAmount = availableBalance;
      console.log(`Budget: Trade capped to available balance: ${cappedSolAmount.toFixed(4)} SOL`);
    }
    
    // Skip tiny trades
    if (cappedSolAmount < 0.001) {
      console.log(`Budget: Trade amount too small after caps: ${cappedSolAmount.toFixed(6)} SOL`);
      await cancelPendingBuy(pendingId, "amount_too_small");
      return false;
    }
    
    // Use budget-capped amount (already accounts for reserves and limits)
    const solAmount = cappedSolAmount;
    const gasReserve = estimatedGasReserve; // Already calculated above
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
      logError("swap", "buy_execute", new Error(result.error || "Unknown swap error"), {
        tokenMint: buy.tokenMint,
        tokenSymbol: buy.tokenSymbol,
        solAmount,
        walletLabel: buy.sourceWalletLabel,
      }, userId).catch(() => {});
      await cancelPendingBuy(pendingId, `buy_failed: ${result.error}`);
      return false;
    }

    const currentPrice = await getTokenPrice(buy.tokenMint);
    const now = Math.floor(Date.now() / 1000);
    const tokensReceived = result.outputAmount || 0;
    const solSpentActual = result.inputAmount || solAmount;
    const entryPrice = currentPrice || buy.initialPrice || 0;

    // Build conditions for finding existing position by source identity
    // For copy trades: match by userId + tokenMint + signalWalletId (position per signal source)
    // For segmented buys: also match by tokenWalletPublicKey (same position)
    const conditions = [
      eq(holdings.tokenMint, buy.tokenMint),
      eq(holdings.userId, userId),
      eq(holdings.reclaimed, false),
      eq(holdings.positionSource, "copy"),
    ];
    
    if (buy.signalWalletId) {
      conditions.push(eq(holdings.signalWalletId, buy.signalWalletId));
    } else if (buy.sourceWalletAddress) {
      conditions.push(eq(holdings.sourceWalletAddress, buy.sourceWalletAddress));
    }
    
    const existingHolding = await db.select().from(holdings).where(and(...conditions)).limit(1);
    
    if (existingHolding.length > 0) {
      // Top up existing position with weighted average entry price
      const holding = existingHolding[0];
      const prevTotalSol = holding.totalSolInvested ?? holding.solSpent;
      const prevTotalTokens = holding.totalTokensBought ?? holding.amountBought;
      const prevBuys = holding.totalBuys ?? 1;
      
      const newTotalSol = prevTotalSol + solSpentActual;
      const newTotalTokens = prevTotalTokens + tokensReceived;
      const newCurrentAmount = holding.currentAmount + tokensReceived;
      const newBuys = prevBuys + 1;
      const newAvgPrice = newTotalSol / newTotalTokens;
      
      await db.update(holdings).set({
        amountBought: holding.amountBought + tokensReceived,
        solSpent: holding.solSpent + solSpentActual,
        currentAmount: newCurrentAmount,
        avgEntryPrice: newAvgPrice,
        totalBuys: newBuys,
        totalTokensBought: newTotalTokens,
        totalSolInvested: newTotalSol,
        lastTopUpTimestamp: now,
        lastPriceCheck: now,
        lastPrice: currentPrice,
      }).where(eq(holdings.id, holding.id));
      
      console.log(`Topped up holding for ${buy.tokenSymbol}${segmentInfo} (${newBuys} buys, avg price: ${newAvgPrice.toFixed(8)})`);
    } else {
      // Create new position for this signal source
      const [newHolding] = await db.insert(holdings).values({
        userId: userId,
        tokenMint: buy.tokenMint,
        tokenSymbol: buy.tokenSymbol,
        tokenName: buy.tokenName,
        amountBought: tokensReceived,
        solSpent: solSpentActual,
        buyPrice: entryPrice,
        buyTimestamp: now,
        buySignature: result.signature || "",
        currentAmount: tokensReceived,
        reclaimed: false,
        lastPriceCheck: now,
        lastPrice: currentPrice,
        highestMultiplier: 1,
        alertedMilestones: [],
        tokenWalletPublicKey: tokenWallet.publicKey,
        tokenWalletEncryptedKey: tokenWallet.encryptedPrivateKey,
        sourceSwapId: buy.sourceSwapId,
        sourceWalletAddress: buy.sourceWalletAddress,
        sourceWalletLabel: buy.sourceWalletLabel,
        positionSource: "copy",
        signalWalletId: buy.signalWalletId ?? null,
        totalBuys: 1,
        avgEntryPrice: entryPrice,
        totalTokensBought: tokensReceived,
        totalSolInvested: solSpentActual,
      }).returning();
      
      // Record entry snapshot for tiered event tracking
      if (newHolding) {
        await db.insert(positionScoreSnapshots).values({
          holdingId: newHolding.id,
          userId: userId,
          tokenMint: buy.tokenMint,
          factorsSnapshot: { priceChange: 0, timeDecay: 0, whaleActivity: 0, signalWalletStatus: 0, volumeTrend: 0 },
          computedScore: 50,
          scoreTier: "neutral",
          priceAtScoring: currentPrice,
          entryPrice: entryPrice,
          holdTimeHours: 0,
          entrySnapshot: {
            holderCount: 0, // Will be populated on first price check
            price: currentPrice,
            marketCap: 0,
            timestamp: now,
          },
          eventBuckets: [],
          currentSnapshot: {
            holderCount: 0,
            price: currentPrice,
            marketCap: 0,
            peakMultiplier: 1,
            significantEvents: 0,
            timestamp: now,
          },
          scoredAt: now,
        });
        console.log(`[EventBuckets] Created entry snapshot for holding ${newHolding.id}`);
      }
      
      console.log(`Created holding for ${buy.tokenSymbol}${segmentInfo} from signal wallet ${buy.sourceWalletLabel || buy.sourceWalletAddress}`);
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
    
    logSuccess("swap", "buy_execute", `Bought ${buy.tokenSymbol}`, {
      tokenMint: buy.tokenMint,
      tokenSymbol: buy.tokenSymbol,
      solSpent: result.inputAmount,
      tokensReceived: result.outputAmount,
      signature: result.signature,
      walletLabel: buy.sourceWalletLabel,
    }, userId).catch(() => {});
    
    // Update daily spend tracking
    const spentUsd = solSpentActual * solPriceUsd;
    const newDailySpent = dailySpent + spentUsd;
    await db.update(tradeConfig).set({
      dailySpentUsd: newDailySpent,
      dailySpentResetAt: startOfDay + 86400, // Reset at start of next day
    }).where(eq(tradeConfig.userId, userId));
    console.log(`Budget: Daily spend now $${newDailySpent.toFixed(2)}`);

    await sendBuyNotification(userId, buy.tokenSymbol, result.inputAmount || solAmount, result.outputAmount || 0, currentPrice, result.signature, buy.segmentIndex, buy.totalSegments);

    return true;
  } catch (error) {
    console.error("Error executing pending buy:", error);
    logError("swap", "pending_buy_error", error instanceof Error ? error : new Error(String(error)), {
      pendingId,
    }, userId).catch(() => {});
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
