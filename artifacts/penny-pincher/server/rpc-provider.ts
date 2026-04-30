import { Connection, PublicKey, ParsedTransactionWithMeta, GetProgramAccountsFilter } from "@solana/web3.js";
import { getNetworkMode } from "./network-mode";
import { recordRpcCall, isProviderExhausted, isDailyLimitReached } from "./budget-manager";
import { logRpcCall } from "./rpc-usage-logger";

export type RpcProvider = "chainstack" | "quicknode" | "helius";
export type OperationType = "raw_rpc" | "token_metadata";

interface RpcStats {
  calls: number;
  errors: number;
  lastErrorAt: number | null;
  avgLatencyMs: number;
}

const providerStats: Map<RpcProvider, RpcStats> = new Map([
  ["chainstack", { calls: 0, errors: 0, lastErrorAt: null, avgLatencyMs: 0 }],
  ["quicknode", { calls: 0, errors: 0, lastErrorAt: null, avgLatencyMs: 0 }],
  ["helius", { calls: 0, errors: 0, lastErrorAt: null, avgLatencyMs: 0 }],
]);

const ERROR_COOLDOWN_MS = 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 3;

const TOKEN_METADATA_OPERATIONS = new Set([
  "getTokenMetadata",
  "getAsset",
  "getAssetsByOwner",
]);

async function getChainstackRpcUrl(): Promise<string | null> {
  const apiKey = process.env.CHAINSTACK_API_KEY;
  if (!apiKey) return null;
  
  const mode = await getNetworkMode();
  if (mode === "devnet") {
    return `https://solana-devnet.core.chainstack.com/${apiKey}`;
  }
  return `https://solana-mainnet.core.chainstack.com/${apiKey}`;
}

async function getQuicknodeRpcUrl(): Promise<string | null> {
  const endpoint = process.env.QUICKNODE_API_KEY;
  if (!endpoint) return null;
  
  const mode = await getNetworkMode();
  if (mode === "devnet") {
    return null;
  }
  return endpoint;
}

async function getHeliusRpcUrl(): Promise<string> {
  const { getHeliusApiKey } = await import("./network-mode");
  const apiKey = getHeliusApiKey();
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
  
  if (provider === "quicknode" && !(await getQuicknodeRpcUrl())) {
    return false;
  }

  if (isDailyLimitReached(provider)) {
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

function getOperationType(operation: string): OperationType {
  if (TOKEN_METADATA_OPERATIONS.has(operation)) {
    return "token_metadata";
  }
  return "raw_rpc";
}

async function getPreferredProvider(operation?: string): Promise<RpcProvider> {
  if (operation && getOperationType(operation) === "token_metadata") {
    if (await shouldUseProvider("helius")) {
      return "helius";
    }
    if (isDailyLimitReached("helius")) {
      throw new Error(`[RpcProvider] Helius daily limit reached (${operation}) — blocking call`);
    }
    console.warn("[RpcProvider] Helius unavailable for token metadata, will fail gracefully");
    return "helius";
  }
  
  if (await shouldUseProvider("chainstack")) {
    return "chainstack";
  }
  
  if (await shouldUseProvider("quicknode")) {
    return "quicknode";
  }

  if (await shouldUseProvider("helius")) {
    return "helius";
  }

  throw new Error(`[RpcProvider] All providers at daily limit — blocking RPC call (${operation || "unknown"})`);
}

async function getFallbackOrder(operation?: string): Promise<RpcProvider[]> {
  if (operation && getOperationType(operation) === "token_metadata") {
    return ["helius"];
  }
  
  if (isProviderExhausted("chainstack")) {
    return ["helius"];
  }
  
  return ["chainstack", "quicknode", "helius"];
}

function recordSuccess(provider: RpcProvider, latencyMs: number): void {
  const stats = providerStats.get(provider);
  if (stats) {
    stats.calls++;
    stats.errors = 0;
    stats.avgLatencyMs = (stats.avgLatencyMs * 0.9) + (latencyMs * 0.1);
  }
  recordRpcCall(provider, 1);
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
  
  if (selectedProvider === "quicknode") {
    const url = await getQuicknodeRpcUrl();
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
  const operationType = getOperationType(operation);
  const primary = await getPreferredProvider(operation);
  const fallbackOrder = await getFallbackOrder(operation);
  const start = Date.now();
  
  console.log(`[RpcProvider] ${operation} (${operationType}) → ${primary}`);
  
  try {
    const connection = await getConnection(primary);
    const result = await fn(connection);
    const latency = Date.now() - start;
    recordSuccess(primary, latency);
    logRpcCall({ provider: primary, method: operation, success: true, latencyMs: latency, fallbackUsed: false, fallbackProvider: null, errorMessage: null });
    return result;
  } catch (error) {
    const latency = Date.now() - start;
    recordError(primary);
    const errMsg = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    console.error(`[RpcProvider] ${primary} failed for ${operation}:`, error);
    
    if (fallbackOnError) {
      const primaryIndex = fallbackOrder.indexOf(primary);
      
      for (let i = primaryIndex + 1; i < fallbackOrder.length; i++) {
        const fallbackProvider = fallbackOrder[i];
        
        if (!(await shouldUseProvider(fallbackProvider))) {
          continue;
        }
        
        console.log(`[RpcProvider] Falling back to ${fallbackProvider} for ${operation}`);
        try { const { recordFallback } = await import("./api-budget"); recordFallback("helius" as any, primary, fallbackProvider); } catch {}
        const fallbackStart = Date.now();
        
        try {
          const fallbackConnection = await getConnection(fallbackProvider);
          const result = await fn(fallbackConnection);
          const fbLatency = Date.now() - fallbackStart;
          recordSuccess(fallbackProvider, fbLatency);
          logRpcCall({ provider: primary, method: operation, success: false, latencyMs: latency, fallbackUsed: true, fallbackProvider, errorMessage: errMsg });
          logRpcCall({ provider: fallbackProvider, method: operation, success: true, latencyMs: fbLatency, fallbackUsed: false, fallbackProvider: null, errorMessage: null });
          return result;
        } catch (fallbackError) {
          recordError(fallbackProvider);
          const fbErrMsg = fallbackError instanceof Error ? fallbackError.message.slice(0, 200) : String(fallbackError).slice(0, 200);
          logRpcCall({ provider: fallbackProvider, method: operation, success: false, latencyMs: Date.now() - fallbackStart, fallbackUsed: false, fallbackProvider: null, errorMessage: fbErrMsg });
          console.error(`[RpcProvider] ${fallbackProvider} also failed for ${operation}:`, fallbackError);
        }
      }
    }
    
    logRpcCall({ provider: primary, method: operation, success: false, latencyMs: latency, fallbackUsed: false, fallbackProvider: null, errorMessage: errMsg });
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

export interface TokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals?: number;
  image?: string;
}

export async function getTokenMetadataViaHelius(mintAddress: string): Promise<TokenMetadata | null> {
  const { getHeliusApiKey } = await import("./network-mode");
  const apiKey = getHeliusApiKey();
  if (!apiKey) {
    console.error("[RpcProvider] No Helius API key for token metadata");
    return null;
  }
  
  const mode = await getNetworkMode();
  const baseUrl = mode === "devnet" 
    ? "https://devnet.helius-rpc.com"
    : "https://mainnet.helius-rpc.com";
  
  const start = Date.now();
  
  try {
    const response = await fetch(`${baseUrl}/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "token-metadata",
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    recordSuccess("helius", Date.now() - start);
    
    if (data.result) {
      const asset = data.result;
      return {
        mint: mintAddress,
        name: asset.content?.metadata?.name || "Unknown",
        symbol: asset.content?.metadata?.symbol || "???",
        decimals: asset.token_info?.decimals,
        image: asset.content?.links?.image,
      };
    }
    
    return null;
  } catch (error) {
    recordError("helius");
    console.error(`[RpcProvider] getTokenMetadata failed for ${mintAddress}:`, error);
    return null;
  }
}

export { getOperationType };
