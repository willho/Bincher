import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { db } from "./db";
import { hotWallet, tradeConfig, holdings, pendingBuys } from "@shared/schema";
import type { HotWallet, TradeConfig, Holding, PendingBuy } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as crypto from "crypto";

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

export async function getOrCreateHotWallet(): Promise<HotWallet | null> {
  const rows = await db.select().from(hotWallet).limit(1);
  
  if (rows.length > 0) {
    return {
      id: rows[0].id,
      publicKey: rows[0].publicKey,
      createdAt: rows[0].createdAt,
    };
  }
  
  return null;
}

export async function createHotWallet(): Promise<HotWallet> {
  const existingRows = await db.select().from(hotWallet).limit(1);
  if (existingRows.length > 0) {
    return {
      id: existingRows[0].id,
      publicKey: existingRows[0].publicKey,
      createdAt: existingRows[0].createdAt,
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
  }).returning();
  
  console.log("Hot wallet created:", publicKeyStr);
  
  return {
    id: result[0].id,
    publicKey: result[0].publicKey,
    createdAt: result[0].createdAt,
  };
}

export async function getHotWalletKeypair(): Promise<Keypair | null> {
  const rows = await db.select().from(hotWallet).limit(1);
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

export async function getHotWalletBalance(): Promise<number> {
  const wallet = await getOrCreateHotWallet();
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

export async function getTradeConfig(): Promise<TradeConfig> {
  const rows = await db.select().from(tradeConfig).limit(1);
  
  if (rows.length === 0) {
    const result = await db.insert(tradeConfig).values({
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

export async function updateTradeConfig(updates: Partial<TradeConfig>): Promise<TradeConfig> {
  const current = await getTradeConfig();
  
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

export async function getHoldings(): Promise<Holding[]> {
  const rows = await db.select().from(holdings);
  return rows.map(row => ({
    id: row.id,
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
  }));
}

export async function getPendingBuys(): Promise<PendingBuy[]> {
  const rows = await db.select().from(pendingBuys).where(eq(pendingBuys.cancelled, false));
  return rows.map(row => ({
    id: row.id,
    tokenMint: row.tokenMint,
    tokenSymbol: row.tokenSymbol,
    tokenName: row.tokenName ?? undefined,
    detectedAt: row.detectedAt,
    scheduledBuyAt: row.scheduledBuyAt,
    initialPrice: row.initialPrice ?? undefined,
    buyTriggered: row.buyTriggered ?? false,
    triggerReason: row.triggerReason ?? undefined,
    buyCount: row.buyCount ?? 0,
    cancelled: row.cancelled ?? false,
  }));
}

export async function hasTokenBeenBought(tokenMint: string): Promise<boolean> {
  const existingHolding = await db.select().from(holdings).where(eq(holdings.tokenMint, tokenMint)).limit(1);
  if (existingHolding.length > 0) return true;
  
  const existingPending = await db.select().from(pendingBuys)
    .where(eq(pendingBuys.tokenMint, tokenMint))
    .limit(1);
  if (existingPending.length > 0) return true;
  
  return false;
}

export async function addPendingBuy(
  tokenMint: string,
  tokenSymbol: string,
  tokenName: string | undefined,
  initialPrice: number | undefined
): Promise<PendingBuy | null> {
  const alreadyBought = await hasTokenBeenBought(tokenMint);
  if (alreadyBought) {
    console.log(`Token ${tokenSymbol} already bought or pending, skipping`);
    return null;
  }
  
  const config = await getTradeConfig();
  const now = Math.floor(Date.now() / 1000);
  const delayMinutes = config.minDelayMinutes + 
    Math.random() * (config.maxDelayMinutes - config.minDelayMinutes);
  const scheduledBuyAt = now + Math.floor(delayMinutes * 60);
  
  const result = await db.insert(pendingBuys).values({
    tokenMint,
    tokenSymbol,
    tokenName,
    detectedAt: now,
    scheduledBuyAt,
    initialPrice,
    buyTriggered: false,
    buyCount: 0,
    cancelled: false,
  }).returning();
  
  console.log(`Added pending buy for ${tokenSymbol}, scheduled for ${new Date(scheduledBuyAt * 1000).toISOString()}`);
  
  return {
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
    cancelled: result[0].cancelled ?? false,
  };
}
