import { db } from "./db";
import { paperPositions, holdings } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { createWebhook, updateWebhookUrl, deleteWebhook, getWebhookUrl } from "./helius";

const WEBHOOK_SECRET = process.env.SESSION_SECRET || "webhook_secret";
const MAX_TIER1_TOKENS = 100;

type AddressType = "signal_wallet" | "real_position_token" | "paper_position_token" | "whale_active" | "whale_watch";

interface TrackedAddress {
  address: string;
  type: AddressType;
  priority: number; // 1=highest (signal wallet), 4=lowest (whale)
  addedAt: number;
  metadata?: Record<string, any>;
}

const addressRegistry = new Map<string, TrackedAddress>();
let unifiedWebhookId: string | null = null;
let webhookDirty = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 5000;

export function getAddressType(address: string): AddressType | null {
  return addressRegistry.get(address)?.type || null;
}

export function isTrackedAddress(address: string): boolean {
  return addressRegistry.has(address);
}

export function getTrackedAddressesByType(type: AddressType): string[] {
  const result: string[] = [];
  addressRegistry.forEach((entry, addr) => {
    if (entry.type === type) result.push(addr);
  });
  return result;
}

export function getTrackedTokenCount(): number {
  let count = 0;
  addressRegistry.forEach(entry => {
    if (entry.type === "paper_position_token" || entry.type === "real_position_token") count++;
  });
  return count;
}

export function hasWebhookCapacity(): boolean {
  return getTrackedTokenCount() < MAX_TIER1_TOKENS;
}

export function addAddress(address: string, type: AddressType, metadata?: Record<string, any>): boolean {
  if (addressRegistry.has(address)) {
    const existing = addressRegistry.get(address)!;
    const newPriority = getPriority(type);
    if (newPriority < existing.priority) {
      existing.type = type;
      existing.priority = newPriority;
      existing.metadata = { ...existing.metadata, ...metadata };
      webhookDirty = true;
    }
    return true;
  }

  if ((type === "paper_position_token" || type === "real_position_token") && !hasWebhookCapacity()) {
    return false;
  }

  addressRegistry.set(address, {
    address,
    type,
    priority: getPriority(type),
    addedAt: Date.now(),
    metadata,
  });

  webhookDirty = true;
  scheduleSyncDebounced();
  return true;
}

export function removeAddress(address: string): boolean {
  if (!addressRegistry.has(address)) return false;
  addressRegistry.delete(address);
  webhookDirty = true;
  scheduleSyncDebounced();
  return true;
}

export async function addTokenForPaperPosition(tokenMint: string): Promise<boolean> {
  if (addressRegistry.has(tokenMint)) return true;
  if (!hasWebhookCapacity()) return false;
  
  const added = addAddress(tokenMint, "paper_position_token");
  if (added) {
    console.log(`[UnifiedWebhook] Added paper token ${tokenMint} (${getTrackedTokenCount()}/${MAX_TIER1_TOKENS} tokens tracked)`);
  }
  return added;
}

export async function addTokenForRealPosition(tokenMint: string): Promise<boolean> {
  const added = addAddress(tokenMint, "real_position_token");
  if (added) {
    console.log(`[UnifiedWebhook] Added real position token ${tokenMint}`);
  }
  return added;
}

export async function removeTokenIfNoPositions(tokenMint: string): Promise<void> {
  const openPaper = await db.select({ id: paperPositions.id })
    .from(paperPositions)
    .where(and(
      eq(paperPositions.tokenMint, tokenMint),
      eq(paperPositions.status, "open"),
      eq(paperPositions.priceTier, "realtime")
    ))
    .limit(1);

  const openReal = await db.select({ id: holdings.id })
    .from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.positionStatus, "active")
    ))
    .limit(1);

  if (openPaper.length === 0 && openReal.length === 0) {
    const entry = addressRegistry.get(tokenMint);
    if (entry && (entry.type === "paper_position_token" || entry.type === "real_position_token")) {
      removeAddress(tokenMint);
      console.log(`[UnifiedWebhook] Removed token ${tokenMint} (no open positions)`);
    }
  }
}

export function addWhaleWallet(walletAddress: string, metadata?: Record<string, any>): boolean {
  return addAddress(walletAddress, "whale_active", metadata);
}

export function removeWhaleWallet(walletAddress: string): boolean {
  const entry = addressRegistry.get(walletAddress);
  if (entry && entry.type === "whale_active") {
    return removeAddress(walletAddress);
  }
  return false;
}

export function addWhaleWatchWallet(walletAddress: string, metadata?: Record<string, any>): boolean {
  return addAddress(walletAddress, "whale_watch", metadata);
}

export function removeWhaleWatchWallet(walletAddress: string): boolean {
  const entry = addressRegistry.get(walletAddress);
  if (entry && entry.type === "whale_watch") {
    return removeAddress(walletAddress);
  }
  return false;
}

export function addSignalWallet(walletAddress: string): boolean {
  return addAddress(walletAddress, "signal_wallet");
}

export function removeSignalWallet(walletAddress: string): boolean {
  const entry = addressRegistry.get(walletAddress);
  if (entry && entry.type === "signal_wallet") {
    return removeAddress(walletAddress);
  }
  return false;
}

function getPriority(type: AddressType): number {
  switch (type) {
    case "signal_wallet": return 1;
    case "real_position_token": return 2;
    case "paper_position_token": return 3;
    case "whale_active": return 4;
    case "whale_watch": return 5;
    default: return 6;
  }
}

function scheduleSyncDebounced(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncWebhookAddresses().catch(err => {
      console.error("[UnifiedWebhook] Sync error:", err);
    });
  }, SYNC_DEBOUNCE_MS);
}

export async function syncWebhookAddresses(): Promise<void> {
  if (!webhookDirty && unifiedWebhookId) return;

  const allAddresses = Array.from(addressRegistry.keys());
  
  if (allAddresses.length === 0) {
    if (unifiedWebhookId) {
      await deleteWebhook(unifiedWebhookId);
      unifiedWebhookId = null;
      console.log("[UnifiedWebhook] Deleted webhook (no addresses to track)");
    }
    webhookDirty = false;
    return;
  }

  const webhookUrl = `${getWebhookUrl()}?secret=${WEBHOOK_SECRET}`;

  if (unifiedWebhookId) {
    const updated = await updateWebhookUrl(unifiedWebhookId, webhookUrl, allAddresses);
    if (updated) {
      webhookDirty = false;
      const counts = getAddressCounts();
      console.log(`[UnifiedWebhook] Updated webhook with ${allAddresses.length} addresses: ${counts}`);
    } else {
      console.warn("[UnifiedWebhook] Failed to update webhook, will retry on next sync");
      unifiedWebhookId = null;
    }
  }

  if (!unifiedWebhookId) {
    const newId = await createWebhook(webhookUrl, allAddresses);
    if (newId) {
      unifiedWebhookId = newId;
      webhookDirty = false;
      const counts = getAddressCounts();
      console.log(`[UnifiedWebhook] Created webhook ${newId} with ${allAddresses.length} addresses: ${counts}`);
    } else {
      console.error("[UnifiedWebhook] Failed to create webhook");
    }
  }
}

function getAddressCounts(): string {
  const counts: Record<string, number> = {};
  addressRegistry.forEach(entry => {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  });
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
}

export async function initializeUnifiedWebhook(
  signalWallets: string[],
  existingWebhookId?: string
): Promise<void> {
  if (existingWebhookId) {
    unifiedWebhookId = existingWebhookId;
  }

  for (const wallet of signalWallets) {
    addAddress(wallet, "signal_wallet");
  }

  const openRealPositions = await db.select({ tokenMint: holdings.tokenMint })
    .from(holdings)
    .where(eq(holdings.positionStatus, "active"));

  const realTokenMintsSet = new Set(openRealPositions.map(p => p.tokenMint));
  const realTokenMints = Array.from(realTokenMintsSet);
  for (const mint of realTokenMints) {
    addAddress(mint, "real_position_token");
  }

  const openPaperPositions = await db.select({ tokenMint: paperPositions.tokenMint })
    .from(paperPositions)
    .where(and(
      eq(paperPositions.status, "open"),
      eq(paperPositions.priceTier, "realtime")
    ));

  const paperTokenMintsSet = new Set(openPaperPositions.map(p => p.tokenMint));
  const paperTokenMints = Array.from(paperTokenMintsSet);
  let addedPaperTokens = 0;
  for (const mint of paperTokenMints) {
    if (!addressRegistry.has(mint) && hasWebhookCapacity()) {
      addAddress(mint, "paper_position_token");
      addedPaperTokens++;
    }
  }

  // Register watch-tier whales on webhook (P5)
  const { getWhalesByTier } = await import("./whale-tracker");
  const watchWhales = await getWhalesByTier("watch");
  for (const whale of watchWhales) {
    addAddress(whale.walletAddress, "whale_watch", { whaleId: whale.id });
  }

  webhookDirty = true;
  await syncWebhookAddresses();

  console.log(`[UnifiedWebhook] Initialized: ${signalWallets.length} signal wallets, ${realTokenMints.length} real tokens, ${addedPaperTokens} paper tokens`);
}

export function getUnifiedWebhookId(): string | null {
  return unifiedWebhookId;
}

export function setUnifiedWebhookId(id: string): void {
  unifiedWebhookId = id;
}

export function getRegistryStats(): {
  total: number;
  signalWallets: number;
  realTokens: number;
  paperTokens: number;
  whaleWallets: number;
  whaleWatchWallets: number;
  webhookId: string | null;
} {
  let signalWallets = 0, realTokens = 0, paperTokens = 0, whaleWallets = 0, whaleWatchWallets = 0;
  addressRegistry.forEach(entry => {
    switch (entry.type) {
      case "signal_wallet": signalWallets++; break;
      case "real_position_token": realTokens++; break;
      case "paper_position_token": paperTokens++; break;
      case "whale_active": whaleWallets++; break;
      case "whale_watch": whaleWatchWallets++; break;
    }
  });
  return {
    total: addressRegistry.size,
    signalWallets,
    realTokens,
    paperTokens,
    whaleWallets,
    whaleWatchWallets,
    webhookId: unifiedWebhookId,
  };
}

export interface WebhookEventRouting {
  priority: number;
  type: AddressType;
  address: string;
  metadata?: Record<string, any>;
}

export function routeWebhookEvent(accountAddress: string): WebhookEventRouting | null {
  const entry = addressRegistry.get(accountAddress);
  if (!entry) return null;
  return {
    priority: entry.priority,
    type: entry.type,
    address: entry.address,
    metadata: entry.metadata,
  };
}
