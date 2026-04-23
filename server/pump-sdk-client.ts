/**
 * Pump.fun SDK Client
 * Initializes and manages the Pump SDK for graduation detection
 */

import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection } from "@solana/web3.js";

let pumpSdk: OnlinePumpSdk | null = null;

/**
 * Initialize Pump SDK with the Solana RPC connection
 */
export async function initializePumpSdk(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  try {
    const connection = new Connection(rpcUrl);
    pumpSdk = new OnlinePumpSdk(connection);

    console.log("[PumpSDK] Initialized with RPC:", rpcUrl);
  } catch (error) {
    console.error("[PumpSDK] Failed to initialize:", error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Get the Pump SDK instance
 */
export function getPumpSdk(): OnlinePumpSdk {
  if (!pumpSdk) {
    throw new Error("[PumpSDK] SDK not initialized. Call initializePumpSdk() first.");
  }
  return pumpSdk;
}

/**
 * Fetch bonding curve summary for a token
 * Returns: { marketCap, isGraduated, progressBps }
 */
export async function fetchBondingCurveProgress(
  mint: string
): Promise<{ marketCap: any; isGraduated: boolean; progressBps: number } | null> {
  try {
    const sdk = getPumpSdk();
    const summary = await sdk.fetchBondingCurveSummary(mint);
    return summary;
  } catch (error) {
    console.error(`[PumpSDK] Error fetching bonding curve for ${mint}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Check if a token has graduated
 */
export async function isTokenGraduated(mint: string): Promise<boolean> {
  const summary = await fetchBondingCurveProgress(mint);
  return summary?.isGraduated ?? false;
}

/**
 * Get bonding curve progress as percentage (0-100)
 */
export async function getBondingCurvePercentage(mint: string): Promise<number | null> {
  const summary = await fetchBondingCurveProgress(mint);
  if (!summary) return null;
  return summary.progressBps / 100; // Convert basis points to percentage
}
