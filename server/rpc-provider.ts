import { Connection, PublicKey, ParsedTransactionWithMeta, GetProgramAccountsFilter } from "@solana/web3.js";
import { getNetworkMode } from "./network-mode";

export type RpcProvider = "chainstack" | "helius";

interface RpcStats {
  calls: number;
  errors: number;
  lastErrorAt: number | null;
  avgLatencyMs: number;
}

const providerStats: Map<RpcProvider, RpcStats> = new Map([
  ["chainstack", { calls: 0, errors: 0, lastErrorAt: null, avgLatencyMs: 0 }],
  ["helius", { calls: 0, errors: 0, lastErrorAt: null, avgLatencyMs: 0 }],
]);

const ERROR_COOLDOWN_MS = 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;

async function getChainstackRpcUrl(): Promise<string | null> {
  const apiKey = process.env.CHAINSTACK_API_KEY;
  if (!apiKey) return null;
  
  const mode = await getNetworkMode();
  if (mode === "devnet") {
    return `https://solana-devnet.core.chainstack.com/${apiKey}`;
  }
  return `https://solana-mainnet.core.chainstack.com/${apiKey}`;
}

async function getHeliusRpcUrl(): Promise<string> {
  const apiKey = process.env.HELIUS_API_KEY;
  const mode = await getNetworkMode();
  
  if (mode === "devnet") {
    return `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
  }
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

async function shouldUseProvider(provider: RpcProvider): Promise<boolean> {
  const stats = providerStats.get(provider);
  if (!stats) return false;
  
  if (provider === "chainstack" && !(await getChainstackRpcUrl())) {
    return false;
  }
  
  if (stats.lastErrorAt) {
    const timeSinceError = Date.now() - stats.lastErrorAt;
    if (timeSinceError < ERROR_COOLDOWN_MS && stats.errors >= MAX_CONSECUTIVE_ERRORS) {
      return false;
    }
  }
  
  return true;
}

async function getPreferredProvider(): Promise<RpcProvider> {
  if (await shouldUseProvider("chainstack")) {
    return "chainstack";
  }
  return "helius";
}

function recordSuccess(provider: RpcProvider, latencyMs: number): void {
  const stats = providerStats.get(provider);
  if (stats) {
    stats.calls++;
    stats.errors = 0;
    stats.avgLatencyMs = (stats.avgLatencyMs * 0.9) + (latencyMs * 0.1);
  }
}

function recordError(provider: RpcProvider): void {
  const stats = providerStats.get(provider);
  if (stats) {
    stats.calls++;
    stats.errors++;
    stats.lastErrorAt = Date.now();
  }
}

export async function getConnection(provider?: RpcProvider): Promise<Connection> {
  const selectedProvider = provider || await getPreferredProvider();
  
  if (selectedProvider === "chainstack") {
    const url = await getChainstackRpcUrl();
    if (url) {
      return new Connection(url, "confirmed");
    }
  }
  
  return new Connection(await getHeliusRpcUrl(), "confirmed");
}

export async function rpcCall<T>(
  operation: string,
  fn: (connection: Connection) => Promise<T>,
  fallbackOnError: boolean = true
): Promise<T> {
  const primary = await getPreferredProvider();
  const start = Date.now();
  
  try {
    const connection = await getConnection(primary);
    const result = await fn(connection);
    recordSuccess(primary, Date.now() - start);
    return result;
  } catch (error) {
    recordError(primary);
    console.error(`[RpcProvider] ${primary} failed for ${operation}:`, error);
    
    if (fallbackOnError && primary === "chainstack") {
      console.log(`[RpcProvider] Falling back to helius for ${operation}`);
      const fallbackStart = Date.now();
      try {
        const heliusConnection = await getConnection("helius");
        const result = await fn(heliusConnection);
        recordSuccess("helius", Date.now() - fallbackStart);
        return result;
      } catch (fallbackError) {
        recordError("helius");
        throw fallbackError;
      }
    }
    
    throw error;
  }
}

export async function getSignaturesForAddress(
  address: string,
  options?: { limit?: number; before?: string }
): Promise<any[]> {
  return rpcCall("getSignaturesForAddress", async (connection) => {
    const pubkey = new PublicKey(address);
    return connection.getSignaturesForAddress(pubkey, {
      limit: options?.limit || 100,
      before: options?.before,
    });
  });
}

export async function getParsedTransaction(
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  return rpcCall("getParsedTransaction", async (connection) => {
    return connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  });
}

export async function getTokenLargestAccounts(
  mintAddress: string
): Promise<{ address: PublicKey; amount: string; decimals: number; uiAmount: number | null }[]> {
  return rpcCall("getTokenLargestAccounts", async (connection) => {
    const result = await connection.getTokenLargestAccounts(new PublicKey(mintAddress));
    return result.value.map((account) => ({
      address: account.address,
      amount: account.amount,
      decimals: account.decimals,
      uiAmount: account.uiAmount,
    }));
  });
}

export async function getAccountInfo(address: string): Promise<any> {
  return rpcCall("getAccountInfo", async (connection) => {
    return connection.getAccountInfo(new PublicKey(address));
  });
}

export async function getMultipleAccountsInfo(addresses: string[]): Promise<any[]> {
  return rpcCall("getMultipleAccountsInfo", async (connection) => {
    const pubkeys = addresses.map((addr) => new PublicKey(addr));
    return connection.getMultipleAccountsInfo(pubkeys);
  });
}

export async function getBalance(address: string): Promise<number> {
  return rpcCall("getBalance", async (connection) => {
    return connection.getBalance(new PublicKey(address));
  });
}

export async function getTokenAccountsByOwner(
  ownerAddress: string,
  mintAddress?: string
): Promise<any[]> {
  return rpcCall("getTokenAccountsByOwner", async (connection) => {
    const owner = new PublicKey(ownerAddress);
    
    if (mintAddress) {
      const result = await connection.getTokenAccountsByOwner(owner, {
        mint: new PublicKey(mintAddress),
      });
      return [...result.value];
    }
    
    const result = await connection.getTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });
    return [...result.value];
  });
}

export function getProviderStats(): Record<RpcProvider, RpcStats> {
  const result: Record<string, RpcStats> = {};
  providerStats.forEach((stats, provider) => {
    result[provider] = { ...stats };
  });
  return result as Record<RpcProvider, RpcStats>;
}

export function resetProviderStats(): void {
  providerStats.forEach((stats) => {
    stats.calls = 0;
    stats.errors = 0;
    stats.lastErrorAt = null;
    stats.avgLatencyMs = 0;
  });
}

export async function getCurrentProvider(): Promise<RpcProvider> {
  return getPreferredProvider();
}
