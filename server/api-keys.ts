import { db } from "./db";
import { userApiKeys, adminApiKeys, walletLimitsConfig, monitoredWallets } from "@shared/schema";
import type { UserApiKey, AdminApiKey, WalletLimitsConfig } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const SESSION_SECRET = process.env.SESSION_SECRET || "default-session-secret-change-me";

function getEncryptionKey(): Buffer {
  return crypto.createHash("sha256").update(SESSION_SECRET).digest();
}

function encryptApiKey(apiKey: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  let encrypted = cipher.update(apiKey, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  
  return iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted;
}

function decryptApiKey(encryptedData: string): string {
  const key = getEncryptionKey();
  const parts = encryptedData.split(":");
  
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }
  
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  
  return decrypted;
}

export async function getUserApiKeys(userId: number): Promise<UserApiKey[]> {
  return await db.select().from(userApiKeys).where(eq(userApiKeys.userId, userId));
}

export async function addUserApiKey(
  userId: number,
  service: string,
  apiKey: string,
  keyLabel?: string
): Promise<UserApiKey> {
  const encryptedApiKey = encryptApiKey(apiKey);
  const now = Math.floor(Date.now() / 1000);
  
  const [inserted] = await db.insert(userApiKeys).values({
    userId,
    service,
    encryptedApiKey,
    keyLabel: keyLabel || `${service} key`,
    isValid: true,
    lastValidatedAt: now,
    createdAt: now,
  }).returning();
  
  return inserted;
}

export async function removeUserApiKey(userId: number, keyId: number): Promise<boolean> {
  const result = await db.delete(userApiKeys)
    .where(and(eq(userApiKeys.id, keyId), eq(userApiKeys.userId, userId)));
  return true;
}

export async function validateUserApiKey(keyId: number): Promise<boolean> {
  const [key] = await db.select().from(userApiKeys).where(eq(userApiKeys.id, keyId));
  if (!key) return false;
  
  try {
    const decryptedKey = decryptApiKey(key.encryptedApiKey);
    let isValid = false;
    
    if (key.service === "helius") {
      isValid = await validateHeliusKey(decryptedKey);
    } else if (key.service === "dexscreener") {
      isValid = true;
    }
    
    await db.update(userApiKeys).set({
      isValid,
      lastValidatedAt: Math.floor(Date.now() / 1000),
    }).where(eq(userApiKeys.id, keyId));
    
    return isValid;
  } catch (error) {
    console.error("Error validating API key:", error);
    await db.update(userApiKeys).set({ isValid: false }).where(eq(userApiKeys.id, keyId));
    return false;
  }
}

async function validateHeliusKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "test",
        method: "getHealth",
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getWalletLimitsConfig(): Promise<WalletLimitsConfig> {
  const [config] = await db.select().from(walletLimitsConfig);
  
  if (!config) {
    const [newConfig] = await db.insert(walletLimitsConfig).values({
      baseWalletLimit: 2,
      walletsPerApiKey: 2,
      maxWalletLimit: 20,
      updatedAt: Math.floor(Date.now() / 1000),
    }).returning();
    return newConfig;
  }
  
  return config;
}

export async function updateWalletLimitsConfig(
  baseWalletLimit?: number,
  walletsPerApiKey?: number,
  maxWalletLimit?: number
): Promise<WalletLimitsConfig> {
  const config = await getWalletLimitsConfig();
  
  const [updated] = await db.update(walletLimitsConfig).set({
    baseWalletLimit: baseWalletLimit ?? config.baseWalletLimit,
    walletsPerApiKey: walletsPerApiKey ?? config.walletsPerApiKey,
    maxWalletLimit: maxWalletLimit ?? config.maxWalletLimit,
    updatedAt: Math.floor(Date.now() / 1000),
  }).where(eq(walletLimitsConfig.id, config.id)).returning();
  
  return updated;
}

export async function getUserWalletLimit(userId: number): Promise<{
  limit: number;
  current: number;
  remaining: number;
  validApiKeys: number;
  breakdown: { base: number; bonus: number; max: number };
}> {
  const config = await getWalletLimitsConfig();
  const userKeys = await getUserApiKeys(userId);
  const validKeys = userKeys.filter(k => k.isValid);
  
  const [walletCount] = await db.select().from(monitoredWallets).where(eq(monitoredWallets.userId, userId));
  const currentWallets = await db.select().from(monitoredWallets).where(eq(monitoredWallets.userId, userId));
  const current = currentWallets.length;
  
  const bonus = validKeys.length * config.walletsPerApiKey;
  const calculatedLimit = config.baseWalletLimit + bonus;
  const limit = Math.min(calculatedLimit, config.maxWalletLimit);
  
  return {
    limit,
    current,
    remaining: Math.max(0, limit - current),
    validApiKeys: validKeys.length,
    breakdown: {
      base: config.baseWalletLimit,
      bonus,
      max: config.maxWalletLimit,
    },
  };
}

export async function canAddWallet(userId: number): Promise<{ allowed: boolean; reason?: string }> {
  const limits = await getUserWalletLimit(userId);
  
  if (limits.current >= limits.limit) {
    return {
      allowed: false,
      reason: `Wallet limit reached (${limits.current}/${limits.limit}). Add your own API keys to increase your limit.`,
    };
  }
  
  return { allowed: true };
}

export async function getAdminApiKeys(): Promise<AdminApiKey[]> {
  return await db.select().from(adminApiKeys).orderBy(adminApiKeys.priority);
}

export async function addAdminApiKey(
  service: string,
  apiKey: string,
  keyLabel: string,
  priority: number = 0
): Promise<AdminApiKey> {
  const encryptedApiKey = encryptApiKey(apiKey);
  const now = Math.floor(Date.now() / 1000);
  
  const [inserted] = await db.insert(adminApiKeys).values({
    service,
    encryptedApiKey,
    keyLabel,
    isActive: true,
    priority,
    usageCount: 0,
    createdAt: now,
  }).returning();
  
  return inserted;
}

export async function removeAdminApiKey(keyId: number): Promise<boolean> {
  await db.delete(adminApiKeys).where(eq(adminApiKeys.id, keyId));
  return true;
}

export async function toggleAdminApiKey(keyId: number, isActive: boolean): Promise<AdminApiKey | null> {
  const [updated] = await db.update(adminApiKeys)
    .set({ isActive })
    .where(eq(adminApiKeys.id, keyId))
    .returning();
  return updated || null;
}

export async function getNextAdminApiKey(service: string): Promise<string | null> {
  const keys = await db.select()
    .from(adminApiKeys)
    .where(and(eq(adminApiKeys.service, service), eq(adminApiKeys.isActive, true)))
    .orderBy(adminApiKeys.priority);
  
  if (keys.length === 0) return null;
  
  const key = keys[0];
  
  await db.update(adminApiKeys).set({
    usageCount: (key.usageCount || 0) + 1,
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).where(eq(adminApiKeys.id, key.id));
  
  try {
    return decryptApiKey(key.encryptedApiKey);
  } catch (error) {
    console.error("Failed to decrypt admin API key:", error);
    return null;
  }
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return apiKey.substring(0, 4) + "..." + apiKey.substring(apiKey.length - 4);
}
