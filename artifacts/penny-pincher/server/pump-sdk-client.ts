// @ts-nocheck
/**
 * Pump.fun SDK Client
 * Initializes and manages the Pump SDK for graduation detection
 *
 * NOTE: SDK methods available:
 * - fetchBondingCurve(mint) → BondingCurve with fields: virtualTokenReserves, realTokenReserves, tokenTotalSupply, complete, etc.
 * - complete field indicates graduation (true = graduated to PumpSwap)
 */

import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

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
 * Fetch bonding curve data for a token
 * Returns raw BondingCurve object with: virtualTokenReserves, realTokenReserves, tokenTotalSupply, complete, etc.
 */
export async function fetchBondingCurve(mint: string): Promise<any> {
  try {
    const sdk = getPumpSdk();
    const pubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const bondingCurve = await sdk.fetchBondingCurve(pubkey);
    return bondingCurve;
  } catch (error) {
    console.error(`[PumpSDK] Error fetching bonding curve for ${mint}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Check if a token has graduated (bonding curve complete field is true)
 */
export async function isTokenGraduated(mint: string): Promise<boolean> {
  const bondingCurve = await fetchBondingCurve(mint);
  return bondingCurve?.complete ?? false;
}

/**
 * Calculate bonding curve progress as percentage (0-100)
 * Formula: (realTokenReserves / (realTokenReserves + virtualTokenReserves)) * 100
 *
 * Note: progressBps would be this value * 100 (in basis points)
 */
export async function getBondingCurvePercentage(mint: string): Promise<number | null> {
  const bondingCurve = await fetchBondingCurve(mint);
  if (!bondingCurve) return null;

  try {
    const realTokenReserves = new BN(bondingCurve.realTokenReserves.toString());
    const virtualTokenReserves = new BN(bondingCurve.virtualTokenReserves.toString());
    const total = realTokenReserves.add(virtualTokenReserves);

    if (total.isZero()) return 0;

    // Calculate percentage: (realTokenReserves / total) * 100
    const percentage = realTokenReserves.mul(new BN(100)).div(total).toNumber();
    return percentage;
  } catch (error) {
    console.error(`[PumpSDK] Error calculating percentage for ${mint}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Get bonding curve progress in basis points (0-10000)
 * 10000 = 100%, 9500 = 95%, etc.
 */
export async function getBondingCurveProgressBps(mint: string): Promise<number | null> {
  const percentage = await getBondingCurvePercentage(mint);
  if (percentage === null) return null;
  return Math.round(percentage * 100); // 100% = 10000 basis points
}

/**
 * Fetch bonding curve data with calculated progress metrics
 */
export async function fetchBondingCurveProgress(
  mint: string
): Promise<{
  isGraduated: boolean;
  progressPercentage: number | null;
  progressBps: number | null;
  realTokenReserves: string | null;
  virtualTokenReserves: string | null;
  complete: boolean;
} | null> {
  const bondingCurve = await fetchBondingCurve(mint);
  if (!bondingCurve) return null;

  const percentage = await getBondingCurvePercentage(mint);
  const progressBps = percentage !== null ? Math.round(percentage * 100) : null;

  return {
    isGraduated: bondingCurve.complete,
    progressPercentage: percentage,
    progressBps: progressBps,
    realTokenReserves: bondingCurve.realTokenReserves?.toString() ?? null,
    virtualTokenReserves: bondingCurve.virtualTokenReserves?.toString() ?? null,
    complete: bondingCurve.complete,
  };
}

/**
 * Fetch token price using SDK (if available in future versions)
 * Currently not available - would need external API
 */
export async function fetchTokenPrice(mint: string): Promise<number | null> {
  try {
    const sdk = getPumpSdk();
    if (!('fetchTokenPrice' in sdk)) {
      return null; // Method not available in this SDK version
    }
    const price = await (sdk as any).fetchTokenPrice(mint);
    return price;
  } catch (error) {
    return null;
  }
}

/**
 * Fetch multiple token bonding curves in parallel
 * Use for batch operations
 */
export async function fetchBondingCurveBatch(mints: string[]): Promise<Array<any>> {
  const results = await Promise.all(
    mints.map(mint =>
      fetchBondingCurve(mint)
        .then(result => ({ mint, result, error: null }))
        .catch(error => ({ mint, result: null, error }))
    )
  );
  return results;
}

/**
 * Get SDK method availability
 * Useful for understanding what the SDK can do
 */
export function getSdkMethodsAvailable(): string[] {
  const sdk = getPumpSdk();
  return Object.getOwnPropertyNames(Object.getPrototypeOf(sdk))
    .filter(m => typeof (sdk as any)[m] === 'function' && m !== 'constructor');
}

/**
 * Get SDK instance for direct method calls
 * Use only if you need direct SDK access
 */
export function getSdkInstance(): OnlinePumpSdk {
  return getPumpSdk();
}
