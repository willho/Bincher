import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { db } from "./db";
import { hotWallet, tradeConfig, holdings, pendingBuys } from "@shared/schema";
import type { HotWallet, TradeConfig, Holding, PendingBuy } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import * as crypto from "crypto";
import { fetchTopHolders } from "./helius";
import { createSnapshot, getSnapshotByToken } from "./ai";

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("CRITICAL: SESSION_SECRET must be set and at least 32 characters for secure key encryption");
}

const ENCRYPTION_KEY = process.env.SESSION_SECRET || "";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

function encrypt(text: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    throw new Error("SESSION_SECRET is required for wallet encryption");
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted: string): string {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    throw new Error("SESSION_SECRET is required for wallet decryption");
  }
  const parts = encrypted.split(':');
  if (parts.length === 2) {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const [ivHex, encryptedText] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
  
  const [saltHex, ivHex, authTagHex, encryptedText] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export async function getOrCreateHotWallet(userId: number): Promise<HotWallet | null> {
  const rows = await db.select().from(hotWallet).where(eq(hotWallet.userId, userId)).limit(1);
  
  if (rows.length > 0) {
    return {
      id: rows[0].id,
      publicKey: rows[0].publicKey,
      createdAt: rows[0].createdAt,
      userId: rows[0].userId ?? undefined,
    };
  }
  
  return null;
}

export async function createHotWallet(userId: number): Promise<HotWallet> {
  const existingRows = await db.select().from(hotWallet).where(eq(hotWallet.userId, userId)).limit(1);
  if (existingRows.length > 0) {
    return {
      id: existingRows[0].id,
      publicKey: existingRows[0].publicKey,
      createdAt: existingRows[0].createdAt,
      userId: existingRows[0].userId ?? undefined,
    };
  }
  
  const keypair = Keypair.generate();
  const publicKeyStr = keypair.publicKey.toBase58();
  const privateKeyStr = Buffer.from(keypair.secretKey).toString('hex');
  const encryptedPrivateKey = encrypt(privateKeyStr);
  
  const result = await db.insert(hotWallet).values({
    publicKey: publicKeyStr,
    encryptedPrivateKey: encryptedPrivateKey,
    createdAt: Math.floor(Date.now() / 1000),
    userId: userId,
  }).returning();
  
  console.log("Hot wallet created for user", userId, ":", publicKeyStr);
  
  return {
    id: result[0].id,
    publicKey: result[0].publicKey,
    createdAt: result[0].createdAt,
    userId: result[0].userId ?? undefined,
  };
}

export async function getHotWalletKeypair(userId: number): Promise<Keypair | null> {
  const rows = await db.select().from(hotWallet).where(eq(hotWallet.userId, userId)).limit(1);
  if (rows.length === 0) return null;
  
  try {
    const decrypted = decrypt(rows[0].encryptedPrivateKey);
    const secretKey = Uint8Array.from(Buffer.from(decrypted, 'hex'));
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error("Failed to decrypt hot wallet key:", error);
    return null;
  }
}

export async function exportHotWalletPrivateKey(userId: number): Promise<string | null> {
  const keypair = await getHotWalletKeypair(userId);
  if (!keypair) return null;
  
  // Export as base58 encoded string (compatible with Phantom, Solflare, etc.)
  const bs58chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = keypair.secretKey;
  
  let result = '';
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  while (num > 0n) {
    result = bs58chars[Number(num % 58n)] + result;
    num = num / 58n;
  }
  
  // Handle leading zeros
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result = '1' + result;
  }
  
  return result;
}

export async function exportTokenWalletPrivateKey(holdingId: number, userId: number): Promise<string | null> {
  const rows = await db.select().from(holdings)
    .where(and(eq(holdings.id, holdingId), eq(holdings.userId, userId)))
    .limit(1);
  
  if (rows.length === 0 || !rows[0].tokenWalletEncryptedKey) return null;
  
  try {
    const decrypted = decrypt(rows[0].tokenWalletEncryptedKey);
    const secretKey = Uint8Array.from(Buffer.from(decrypted, 'hex'));
    const keypair = Keypair.fromSecretKey(secretKey);
    
    // Export as base58
    const bs58chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = keypair.secretKey;
    
    let result = '';
    let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    while (num > 0n) {
      result = bs58chars[Number(num % 58n)] + result;
      num = num / 58n;
    }
    
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
      result = '1' + result;
    }
    
    return result;
  } catch (error) {
    console.error("Failed to export token wallet key:", error);
    return null;
  }
}

export async function getHotWalletBalance(userId: number): Promise<number> {
  const wallet = await getOrCreateHotWallet(userId);
  if (!wallet) return 0;
  
  try {
    const connection = new Connection(HELIUS_RPC, "confirmed");
    const pubkey = new PublicKey(wallet.publicKey);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error("Failed to get wallet balance:", error);
    return 0;
  }
}

export async function getTradeConfig(userId: number): Promise<TradeConfig> {
  const rows = await db.select().from(tradeConfig).where(eq(tradeConfig.userId, userId)).limit(1);
  
  if (rows.length === 0) {
    const result = await db.insert(tradeConfig).values({
      userId: userId,
      enabled: false,
      buyPercentage: 10,
      minDelayMinutes: 20,
      maxDelayMinutes: 40,
      highVolumeBuyCount: 10,
      priceRiseTriggerPercent: 15,
      reclaimMultiplier: 4,
      milestonesToAlert: [2, 4, 10],
    }).returning();
    
    return {
      id: result[0].id,
      userId: result[0].userId ?? undefined,
      enabled: result[0].enabled ?? false,
      buyPercentage: result[0].buyPercentage ?? 10,
      minDelayMinutes: result[0].minDelayMinutes ?? 20,
      maxDelayMinutes: result[0].maxDelayMinutes ?? 40,
      highVolumeBuyCount: result[0].highVolumeBuyCount ?? 10,
      priceRiseTriggerPercent: result[0].priceRiseTriggerPercent ?? 15,
      reclaimMultiplier: result[0].reclaimMultiplier ?? 4,
      milestonesToAlert: (result[0].milestonesToAlert as number[]) ?? [2, 4, 10],
    };
  }
  
  return {
    id: rows[0].id,
    userId: rows[0].userId ?? undefined,
    enabled: rows[0].enabled ?? false,
    buyPercentage: rows[0].buyPercentage ?? 10,
    minDelayMinutes: rows[0].minDelayMinutes ?? 20,
    maxDelayMinutes: rows[0].maxDelayMinutes ?? 40,
    highVolumeBuyCount: rows[0].highVolumeBuyCount ?? 10,
    priceRiseTriggerPercent: rows[0].priceRiseTriggerPercent ?? 15,
    reclaimMultiplier: rows[0].reclaimMultiplier ?? 4,
    milestonesToAlert: (rows[0].milestonesToAlert as number[]) ?? [2, 4, 10],
  };
}

export async function updateTradeConfig(userId: number, updates: Partial<TradeConfig>): Promise<TradeConfig> {
  const current = await getTradeConfig(userId);
  
  await db.update(tradeConfig).set({
    enabled: updates.enabled ?? current.enabled,
    buyPercentage: updates.buyPercentage ?? current.buyPercentage,
    minDelayMinutes: updates.minDelayMinutes ?? current.minDelayMinutes,
    maxDelayMinutes: updates.maxDelayMinutes ?? current.maxDelayMinutes,
    highVolumeBuyCount: updates.highVolumeBuyCount ?? current.highVolumeBuyCount,
    priceRiseTriggerPercent: updates.priceRiseTriggerPercent ?? current.priceRiseTriggerPercent,
    reclaimMultiplier: updates.reclaimMultiplier ?? current.reclaimMultiplier,
    milestonesToAlert: updates.milestonesToAlert ?? current.milestonesToAlert,
  }).where(eq(tradeConfig.id, current.id));
  
  return { ...current, ...updates };
}

export async function getHoldings(userId: number): Promise<Holding[]> {
  const rows = await db.select().from(holdings).where(eq(holdings.userId, userId));
  return rows.map(row => ({
    id: row.id,
    userId: row.userId ?? undefined,
    tokenMint: row.tokenMint,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName ?? undefined,
    amountBought: row.amountBought,
    solSpent: row.solSpent,
    buyPrice: row.buyPrice,
    buyTimestamp: row.buyTimestamp,
    buySignature: row.buySignature,
    currentAmount: row.currentAmount,
    reclaimed: row.reclaimed ?? false,
    reclaimTimestamp: row.reclaimTimestamp ?? undefined,
    reclaimSignature: row.reclaimSignature ?? undefined,
    lastPriceCheck: row.lastPriceCheck ?? undefined,
    lastPrice: row.lastPrice ?? undefined,
    highestMultiplier: row.highestMultiplier ?? 1,
    alertedMilestones: (row.alertedMilestones as number[]) ?? [],
    reclaimedMilestones: (row.reclaimedMilestones as number[]) ?? [],
  }));
}

export async function getPendingBuys(userId: number): Promise<PendingBuy[]> {
  // Return active and paused pending buys for the user
  const rows = await db.select().from(pendingBuys).where(
    and(
      eq(pendingBuys.userId, userId), 
      or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused"))
    )
  );
  return rows.map(row => ({
    id: row.id,
    userId: row.userId ?? undefined,
    tokenMint: row.tokenMint,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName ?? undefined,
    detectedAt: row.detectedAt,
    scheduledBuyAt: row.scheduledBuyAt,
    initialPrice: row.initialPrice ?? undefined,
    buyTriggered: row.buyTriggered ?? false,
    triggerReason: row.triggerReason ?? undefined,
    buyCount: row.buyCount ?? 0,
    initialBuyCount: row.initialBuyCount ?? 0,
    status: (row.status ?? "active") as "active" | "paused" | "cancelled" | "completed",
    pauseReason: row.pauseReason ?? undefined,
  }));
}

export async function hasTokenBeenBought(userId: number, tokenMint: string): Promise<boolean> {
  const existingHolding = await db.select().from(holdings).where(
    and(eq(holdings.userId, userId), eq(holdings.tokenMint, tokenMint))
  ).limit(1);
  if (existingHolding.length > 0) return true;
  
  // Check for active or paused pending buys (not cancelled/completed)
  const existingPending = await db.select().from(pendingBuys).where(
    and(
      eq(pendingBuys.userId, userId), 
      eq(pendingBuys.tokenMint, tokenMint),
      or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused"))
    )
  ).limit(1);
  if (existingPending.length > 0) return true;
  
  return false;
}

export async function addPendingBuy(
  userId: number,
  tokenMint: string,
  tokenSymbol: string,
  tokenName: string | undefined,
  initialPrice: number | undefined,
  liquidity: number | undefined,
  sourceWalletData?: { swapId?: number; walletAddress?: string; walletLabel?: string }
): Promise<PendingBuy | null> {
  const alreadyBought = await hasTokenBeenBought(userId, tokenMint);
  if (alreadyBought) {
    console.log(`Token ${tokenSymbol} already bought or pending for user ${userId}, skipping`);
    return null;
  }
  
  // Import the split buy functions
  const { getSolPriceUsd, calculateSplitBuySegments, getRandomBuyPercentage } = await import("./jupiter");
  
  const balance = await getHotWalletBalance(userId);
  if (balance <= 0) {
    console.log(`User ${userId} has no SOL balance, skipping pending buy`);
    return null;
  }
  
  // Get SOL price for USD calculations
  const solPriceUsd = await getSolPriceUsd();
  
  // Tiered buy size logic based on pool liquidity:
  // - Pool < $100: Fixed $10 buy
  // - Pool $100-150: 10% of balance
  // - Pool > $150: 10-15% random buy percentage
  let totalSolAmount: number;
  const poolLiquidity = liquidity ?? 0;
  
  if (poolLiquidity < 100) {
    // Fixed $10 buy for small pools
    totalSolAmount = 10 / solPriceUsd;
    console.log(`Small pool ($${poolLiquidity.toFixed(0)} liquidity): Fixed $10 buy = ${totalSolAmount.toFixed(4)} SOL`);
  } else if (poolLiquidity <= 150) {
    // 10% of balance for medium pools
    totalSolAmount = balance * 0.10;
    console.log(`Medium pool ($${poolLiquidity.toFixed(0)} liquidity): 10% of balance = ${totalSolAmount.toFixed(4)} SOL`);
  } else {
    // 10-15% random for larger pools
    const buyPercentage = getRandomBuyPercentage();
    totalSolAmount = balance * (buyPercentage / 100);
    console.log(`Large pool ($${poolLiquidity.toFixed(0)} liquidity): ${buyPercentage.toFixed(1)}% of balance = ${totalSolAmount.toFixed(4)} SOL`);
  }
  
  // Ensure we don't buy more than balance allows
  const maxBuy = balance * 0.15;
  if (totalSolAmount > maxBuy) {
    totalSolAmount = maxBuy;
  }
  
  // Calculate segments (solPriceUsd already fetched above for tiered sizing)
  const segments = calculateSplitBuySegments(totalSolAmount, solPriceUsd);
  
  const now = Math.floor(Date.now() / 1000);
  
  // Initial delay: 10-20 minutes (random)
  const initialDelayMinutes = 10 + Math.random() * 10;
  let scheduledBuyAt = now + Math.floor(initialDelayMinutes * 60);
  
  const totalUsd = totalSolAmount * solPriceUsd;
  console.log(`Queuing ${segments.length} segment(s) for ${tokenSymbol}: $${totalUsd.toFixed(2)} USD (${totalSolAmount.toFixed(4)} SOL)`);
  
  // Create token wallet upfront - shared across ALL segments
  // This ensures early triggers for any segment can use the same wallet
  const tokenWallet = generateTokenWallet();
  console.log(`Created token wallet for ${tokenSymbol}: ${tokenWallet.publicKey}`);
  
  let parentBuyId: number | undefined = undefined;
  let firstPendingBuy: PendingBuy | null = null;
  
  for (let i = 0; i < segments.length; i++) {
    const segmentSol = segments[i];
    const segmentUsd = segmentSol * solPriceUsd;
    
    const result = await db.insert(pendingBuys).values({
      userId: userId,
      tokenMint,
      tokenSymbol,
      tokenName,
      detectedAt: now,
      scheduledBuyAt,
      initialPrice,
      buyTriggered: false,
      buyCount: 0,
      initialBuyCount: 0,
      status: "active",
      segmentIndex: i + 1,
      totalSegments: segments.length,
      parentBuyId: parentBuyId,
      solAmount: segmentSol,
      tokenWalletPublicKey: tokenWallet.publicKey,
      tokenWalletEncryptedKey: tokenWallet.encryptedPrivateKey,
      sourceSwapId: sourceWalletData?.swapId,
      sourceWalletAddress: sourceWalletData?.walletAddress,
      sourceWalletLabel: sourceWalletData?.walletLabel,
    }).returning();
    
    // First segment becomes the parent for subsequent segments
    if (i === 0) {
      parentBuyId = result[0].id;
      firstPendingBuy = {
        id: result[0].id,
        tokenMint: result[0].tokenMint,
        tokenSymbol: result[0].tokenSymbol,
        tokenName: result[0].tokenName ?? undefined,
        detectedAt: result[0].detectedAt,
        scheduledBuyAt: result[0].scheduledBuyAt,
        initialPrice: result[0].initialPrice ?? undefined,
        buyTriggered: result[0].buyTriggered ?? false,
        triggerReason: result[0].triggerReason ?? undefined,
        buyCount: result[0].buyCount ?? 0,
        initialBuyCount: result[0].initialBuyCount ?? 0,
        status: (result[0].status ?? "active") as "active" | "paused" | "cancelled" | "completed",
        pauseReason: result[0].pauseReason ?? undefined,
        segmentIndex: result[0].segmentIndex ?? 1,
        totalSegments: result[0].totalSegments ?? 1,
        parentBuyId: result[0].parentBuyId ?? undefined,
        solAmount: result[0].solAmount ?? undefined,
        tokenWalletPublicKey: result[0].tokenWalletPublicKey ?? undefined,
      };
    }
    
    console.log(`  Segment ${i + 1}/${segments.length}: $${segmentUsd.toFixed(2)} (${segmentSol.toFixed(4)} SOL) at ${new Date(scheduledBuyAt * 1000).toISOString()}`);
    
    // Subsequent segments: 25-35 minutes after previous (random)
    if (i < segments.length - 1) {
      const segmentDelayMinutes = 25 + Math.random() * 10;
      scheduledBuyAt += Math.floor(segmentDelayMinutes * 60);
    }
  }
  
  // Create token snapshot if not exists (shared across all users)
  const existingSnapshot = await getSnapshotByToken(tokenMint);
  if (!existingSnapshot) {
    try {
      console.log(`Creating snapshot for ${tokenSymbol}...`);
      const topHolders = await fetchTopHolders(tokenMint, 100);
      const topHolderPercent = topHolders.length > 0 ? topHolders[0].percent : undefined;
      
      await createSnapshot({
        tokenMint,
        tokenSymbol,
        tokenName,
        priceUsd: initialPrice,
        liquidity,
        holders: undefined,
        topHolderPercent,
        topHolders: topHolders.length > 0 ? topHolders : undefined,
        sourceWallets: sourceWalletData?.walletAddress ? [sourceWalletData.walletAddress] : undefined,
      });
      console.log(`Snapshot created for ${tokenSymbol} with ${topHolders.length} top holders`);
    } catch (error) {
      console.error(`Failed to create snapshot for ${tokenSymbol}:`, error);
    }
  }
  
  return firstPendingBuy;
}

export interface WithdrawResult {
  success: boolean;
  signature?: string;
  amount?: number;
  error?: string;
}

export async function withdrawSol(
  userId: number,
  destinationAddress: string,
  amountSol: number
): Promise<WithdrawResult> {
  try {
    const keypair = await getHotWalletKeypair(userId);
    if (!keypair) {
      return { success: false, error: "Hot wallet not found or decryption failed" };
    }

    const balance = await getHotWalletBalance(userId);
    const reserveForFees = 0.005;
    
    if (amountSol > balance - reserveForFees) {
      return { 
        success: false, 
        error: `Insufficient balance. Available: ${(balance - reserveForFees).toFixed(4)} SOL (keeping ${reserveForFees} SOL for fees)` 
      };
    }

    let destinationPubkey: PublicKey;
    try {
      destinationPubkey = new PublicKey(destinationAddress);
    } catch {
      return { success: false, error: "Invalid destination address" };
    }

    const connection = new Connection(HELIUS_RPC, "confirmed");
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destinationPubkey,
        lamports,
      })
    );

    console.log(`User ${userId} withdrawing ${amountSol} SOL to ${destinationAddress}`);
    
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
    
    console.log(`Withdrawal successful: ${signature}`);
    
    return {
      success: true,
      signature,
      amount: amountSol,
    };
  } catch (error) {
    console.error("Withdrawal failed:", error);
    return { success: false, error: String(error) };
  }
}

export async function getAllPendingBuys(): Promise<(PendingBuy & { userId: number })[]> {
  // Return active and paused pending buys (not cancelled/completed)
  const rows = await db.select().from(pendingBuys).where(
    or(eq(pendingBuys.status, "active"), eq(pendingBuys.status, "paused"))
  );
  return rows.filter(row => row.userId !== null).map(row => ({
    id: row.id,
    userId: row.userId!,
    tokenMint: row.tokenMint,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName ?? undefined,
    detectedAt: row.detectedAt,
    scheduledBuyAt: row.scheduledBuyAt,
    initialPrice: row.initialPrice ?? undefined,
    buyTriggered: row.buyTriggered ?? false,
    triggerReason: row.triggerReason ?? undefined,
    buyCount: row.buyCount ?? 0,
    initialBuyCount: row.initialBuyCount ?? 0,
    status: (row.status ?? "active") as "active" | "paused" | "cancelled" | "completed",
    pauseReason: row.pauseReason ?? undefined,
  }));
}

export async function getAllHoldings(): Promise<(Holding & { userId: number })[]> {
  const rows = await db.select().from(holdings);
  return rows.filter(row => row.userId !== null).map(row => ({
    id: row.id,
    userId: row.userId!,
    tokenMint: row.tokenMint,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName ?? undefined,
    amountBought: row.amountBought,
    solSpent: row.solSpent,
    buyPrice: row.buyPrice,
    buyTimestamp: row.buyTimestamp,
    buySignature: row.buySignature,
    currentAmount: row.currentAmount,
    reclaimed: row.reclaimed ?? false,
    reclaimTimestamp: row.reclaimTimestamp ?? undefined,
    reclaimSignature: row.reclaimSignature ?? undefined,
    lastPriceCheck: row.lastPriceCheck ?? undefined,
    lastPrice: row.lastPrice ?? undefined,
    highestMultiplier: row.highestMultiplier ?? 1,
    alertedMilestones: (row.alertedMilestones as number[]) ?? [],
    reclaimedMilestones: (row.reclaimedMilestones as number[]) ?? [],
  }));
}

// Per-token wallet functions for privacy
export interface TokenWallet {
  publicKey: string;
  encryptedPrivateKey: string;
}

export function generateTokenWallet(): TokenWallet {
  const keypair = Keypair.generate();
  const publicKeyStr = keypair.publicKey.toBase58();
  const privateKeyStr = Buffer.from(keypair.secretKey).toString('hex');
  const encryptedPrivateKey = encrypt(privateKeyStr);
  
  return {
    publicKey: publicKeyStr,
    encryptedPrivateKey,
  };
}

export function getTokenWalletKeypair(encryptedPrivateKey: string): Keypair | null {
  try {
    const decrypted = decrypt(encryptedPrivateKey);
    const secretKey = Uint8Array.from(Buffer.from(decrypted, 'hex'));
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    console.error("Failed to decrypt token wallet key:", error);
    return null;
  }
}

export async function fundTokenWallet(
  fromKeypair: Keypair,
  toAddress: string,
  amountSol: number
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = new Connection(HELIUS_RPC, "confirmed");
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: toPubkey,
        lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
    console.log(`Funded token wallet ${toAddress} with ${amountSol} SOL: ${signature}`);
    
    return { success: true, signature };
  } catch (error) {
    console.error("Failed to fund token wallet:", error);
    return { success: false, error: String(error) };
  }
}

export async function getTokenWalletBalance(publicKey: string): Promise<number> {
  try {
    const connection = new Connection(HELIUS_RPC, "confirmed");
    const pubkey = new PublicKey(publicKey);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error("Failed to get token wallet balance:", error);
    return 0;
  }
}

export async function sendProfitsToMainWallet(
  tokenWalletKeypair: Keypair,
  mainWalletAddress: string,
  gasReserveSol: number
): Promise<{ success: boolean; signature?: string; amountSent?: number; error?: string }> {
  try {
    const connection = new Connection(HELIUS_RPC, "confirmed");
    const balance = await connection.getBalance(tokenWalletKeypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    
    // Keep 4x gas reserve + base fee buffer in token wallet, send rest to main
    // Base fee buffer of 0.0005 SOL covers ~10 base fees (0.00005 each)
    const reserveToKeep = (gasReserveSol * 4) + 0.0005;
    const amountToSend = balanceSol - reserveToKeep;
    
    if (amountToSend <= 0.0001) {
      return { success: true, amountSent: 0 }; // Nothing to send
    }
    
    const lamportsToSend = Math.floor(amountToSend * LAMPORTS_PER_SOL);
    const mainPubkey = new PublicKey(mainWalletAddress);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: tokenWalletKeypair.publicKey,
        toPubkey: mainPubkey,
        lamports: lamportsToSend,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [tokenWalletKeypair]);
    console.log(`Sent ${amountToSend.toFixed(4)} SOL profits to main wallet: ${signature}`);
    
    return { success: true, signature, amountSent: amountToSend };
  } catch (error) {
    console.error("Failed to send profits to main wallet:", error);
    return { success: false, error: String(error) };
  }
}
