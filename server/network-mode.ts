import { db } from "./db";
import { adminSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export type NetworkMode = "mainnet" | "devnet";

const NETWORK_MODE_KEY = "network_mode";
const DEFAULT_NETWORK_MODE: NetworkMode = "mainnet";
const CACHE_TTL_MS = 30000; // 30 second cache TTL

let cachedNetworkMode: NetworkMode | null = null;
let cacheTimestamp: number = 0;

export async function getNetworkMode(): Promise<NetworkMode> {
  const now = Date.now();
  
  // Use cache if valid and not expired
  if (cachedNetworkMode && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedNetworkMode;
  }
  
  try {
    const [setting] = await db
      .select()
      .from(adminSettings)
      .where(eq(adminSettings.key, NETWORK_MODE_KEY))
      .limit(1);
    
    if (setting?.value === "devnet" || setting?.value === "mainnet") {
      cachedNetworkMode = setting.value;
      cacheTimestamp = now;
      return cachedNetworkMode;
    }
    return DEFAULT_NETWORK_MODE;
  } catch (error) {
    console.error("Error fetching network mode:", error);
    // On error, clear cache to force retry next time
    cachedNetworkMode = null;
    cacheTimestamp = 0;
    return DEFAULT_NETWORK_MODE;
  }
}

export async function setNetworkMode(mode: NetworkMode, adminUserId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  await db.insert(adminSettings)
    .values({
      key: NETWORK_MODE_KEY,
      value: mode,
      updatedAt: now,
      updatedBy: adminUserId,
    })
    .onConflictDoUpdate({
      target: adminSettings.key,
      set: { value: mode, updatedAt: now, updatedBy: adminUserId },
    });
  
  // Update cache with new timestamp
  cachedNetworkMode = mode;
  cacheTimestamp = Date.now();
}

export function clearNetworkModeCache(): void {
  cachedNetworkMode = null;
  cacheTimestamp = 0;
}

export function getHeliusRpcUrl(apiKey: string, mode?: NetworkMode): string {
  const network = mode || cachedNetworkMode || DEFAULT_NETWORK_MODE;
  if (network === "devnet") {
    return `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
  }
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export function getHeliusApiUrl(mode?: NetworkMode): string {
  const network = mode || cachedNetworkMode || DEFAULT_NETWORK_MODE;
  if (network === "devnet") {
    return "https://api-devnet.helius.xyz";
  }
  return "https://api.helius.xyz";
}

export function getSolanaFaucetUrl(): string {
  return "https://faucet.solana.com/";
}

export function isDevnet(): boolean {
  return cachedNetworkMode === "devnet";
}
