import type { HeliusWebhookPayload, InsertSwap, TokenMetadata } from "@shared/schema";
import { trackApiCall, shouldAllowApiCall } from "./api-budget";
import { getNetworkMode, getHeliusRpcUrl, getHeliusApiUrl } from "./network-mode";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Get the current Helius RPC URL based on network mode
export async function getHeliusRpcEndpoint(apiKey?: string): Promise<string> {
  const key = apiKey || HELIUS_API_KEY || "";
  const mode = await getNetworkMode();
  return getHeliusRpcUrl(key, mode);
}

// Get the current Helius API base URL based on network mode  
export async function getHeliusApiEndpoint(): Promise<string> {
  const mode = await getNetworkMode();
  return getHeliusApiUrl(mode);
}

// Token mint addresses for base currencies
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_CURRENCY_MINTS = [SOL_MINT, USDC_MINT];
export const BASE_CURRENCY_SYMBOLS = ["SOL", "USDC"];

// Helper to check if a token is a base currency (SOL or USDC)
export function isBaseCurrency(tokenMint: string): boolean {
  return BASE_CURRENCY_MINTS.includes(tokenMint);
}

export function isBaseCurrencySymbol(symbol: string): boolean {
  return BASE_CURRENCY_SYMBOLS.includes(symbol);
}
const WALLET_ADDRESS = "C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak";

export function getWebhookUrl(): string {
  // In production deployment, REPLIT_DEPLOYMENT=1 and REPLIT_DOMAINS contains the .replit.app domain
  if (process.env.REPLIT_DEPLOYMENT === "1" && process.env.REPLIT_DOMAINS) {
    // REPLIT_DOMAINS is comma-separated, first one is the primary domain
    const domains = process.env.REPLIT_DOMAINS.split(",");
    const primaryDomain = domains[0];
    return `https://${primaryDomain}/api/webhook/helius`;
  }
  
  // In development, use REPLIT_DEV_DOMAIN
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api/webhook/helius`;
  }
  
  // Fallback for local development
  return `https://localhost:5000/api/webhook/helius`;
}

export function getWalletAddress(): string {
  return WALLET_ADDRESS;
}

// Token metadata cache to avoid duplicate API calls (5 minute TTL)
const tokenMetadataCache = new Map<string, { data: TokenMetadata | undefined; timestamp: number }>();
const METADATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const METADATA_CACHE_MAX_SIZE = 500; // Maximum entries to prevent unbounded growth

// Periodic cache cleanup (runs every 10 minutes)
function evictExpiredCacheEntries() {
  const now = Date.now();
  const keysToDelete: string[] = [];
  tokenMetadataCache.forEach((entry, key) => {
    if (now - entry.timestamp >= METADATA_CACHE_TTL) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach(key => tokenMetadataCache.delete(key));
}
setInterval(evictExpiredCacheEntries, 10 * 60 * 1000);

// Fetch from DexScreener API
async function fetchFromDexScreener(mintAddress: string): Promise<TokenMetadata | undefined> {
  const budgetCheck = await shouldAllowApiCall("dexscreener");
  if (!budgetCheck.allowed) {
    console.warn(`DexScreener API blocked: ${budgetCheck.reason}`);
    return undefined;
  }
  
  const startTime = Date.now();
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    const latencyMs = Date.now() - startTime;
    
    if (!response.ok) {
      const { logApiCall } = await import("./system-logger");
      logApiCall("dexscreener", "fetchTokenMetadata", false, latencyMs, { mint: mintAddress, status: response.status }).catch(() => {});
      return undefined;
    }
    
    const data = await response.json();
    await trackApiCall("dexscreener", "fetchTokenMetadata");
    
    // Log successful API call
    const { logApiCall } = await import("./system-logger");
    logApiCall("dexscreener", "fetchTokenMetadata", true, latencyMs, { mint: mintAddress }).catch(() => {});
    
    if (!data.pairs || data.pairs.length === 0) return undefined;
    
    // Get the pair with highest liquidity
    const pair = data.pairs.reduce((best: any, current: any) => {
      const bestLiq = best.liquidity?.usd || 0;
      const currLiq = current.liquidity?.usd || 0;
      return currLiq > bestLiq ? current : best;
    });
    
    // Skip if no name/symbol (DexScreener doesn't have metadata for this token)
    if (!pair.baseToken?.name || !pair.baseToken?.symbol) return undefined;
    
    return {
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      priceUsd: parseFloat(pair.priceUsd) || undefined,
      marketCap: pair.marketCap || pair.fdv || undefined,
      fdv: pair.fdv || undefined,
      liquidity: pair.liquidity?.usd || undefined,
      volume24h: pair.volume?.h24 || undefined,
      priceChange24h: pair.priceChange?.h24 || undefined,
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
    };
  } catch (error) {
    console.error("DexScreener fetch error:", error);
    return undefined;
  }
}

// Fetch from GeckoTerminal API (free, no API key required)
async function fetchFromGeckoTerminal(mintAddress: string): Promise<TokenMetadata | undefined> {
  try {
    // GeckoTerminal token endpoint
    const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mintAddress}`, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return undefined;
    
    const data = await response.json();
    const attrs = data.data?.attributes;
    if (!attrs) return undefined;
    
    // Skip if no name/symbol
    if (!attrs.name || !attrs.symbol) return undefined;
    
    return {
      name: attrs.name,
      symbol: attrs.symbol,
      priceUsd: parseFloat(attrs.price_usd) || undefined,
      marketCap: parseFloat(attrs.market_cap_usd) || undefined,
      fdv: parseFloat(attrs.fdv_usd) || undefined,
      liquidity: parseFloat(attrs.total_reserve_in_usd) || undefined,
      volume24h: parseFloat(attrs.volume_usd?.h24) || undefined,
    };
  } catch (error) {
    console.error("GeckoTerminal fetch error:", error);
    return undefined;
  }
}

// Fetch from Jupiter token list (has good coverage of Solana tokens)
async function fetchFromJupiter(mintAddress: string): Promise<TokenMetadata | undefined> {
  try {
    const response = await fetch(`https://tokens.jup.ag/token/${mintAddress}`);
    if (!response.ok) return undefined;
    
    const data = await response.json();
    if (!data.name || !data.symbol) return undefined;
    
    return {
      name: data.name,
      symbol: data.symbol,
      // Jupiter doesn't provide price data, just metadata
    };
  } catch (error) {
    console.error("Jupiter fetch error:", error);
    return undefined;
  }
}

export async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | undefined> {
  // Skip SOL - it's native and doesn't need metadata lookup
  if (mintAddress === "So11111111111111111111111111111111111111112") {
    return { name: "Solana", symbol: "SOL" };
  }
  
  // Skip USDC
  if (mintAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
    return { name: "USD Coin", symbol: "USDC" };
  }
  
  // Check cache first
  const cached = tokenMetadataCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < METADATA_CACHE_TTL) {
    return cached.data;
  }
  
  // Cascading fallback: DexScreener → GeckoTerminal → Jupiter
  let metadata: TokenMetadata | undefined;
  
  // Try DexScreener first (most complete data)
  metadata = await fetchFromDexScreener(mintAddress);
  if (metadata?.name && metadata?.symbol) {
    console.log(`[TokenMetadata] Found via DexScreener: ${metadata.symbol}`);
    cacheMetadata(mintAddress, metadata);
    return metadata;
  }
  
  // Fallback to GeckoTerminal (good for newer tokens)
  metadata = await fetchFromGeckoTerminal(mintAddress);
  if (metadata?.name && metadata?.symbol) {
    console.log(`[TokenMetadata] Found via GeckoTerminal: ${metadata.symbol}`);
    cacheMetadata(mintAddress, metadata);
    return metadata;
  }
  
  // Fallback to Jupiter (basic metadata only)
  metadata = await fetchFromJupiter(mintAddress);
  if (metadata?.name && metadata?.symbol) {
    console.log(`[TokenMetadata] Found via Jupiter: ${metadata.symbol}`);
    cacheMetadata(mintAddress, metadata);
    return metadata;
  }
  
  // All sources failed
  console.warn(`[TokenMetadata] No metadata found for ${mintAddress.slice(0, 8)}...`);
  cacheMetadata(mintAddress, undefined);
  return undefined;
}

// Helper to add to cache with size limit enforcement
function cacheMetadata(mint: string, data: TokenMetadata | undefined) {
  // Evict oldest entries if cache is at capacity
  if (tokenMetadataCache.size >= METADATA_CACHE_MAX_SIZE) {
    // Remove oldest 10% of entries
    const entriesToRemove = Math.floor(METADATA_CACHE_MAX_SIZE * 0.1);
    const entries: Array<[string, { data: TokenMetadata | undefined; timestamp: number }]> = [];
    tokenMetadataCache.forEach((value, key) => entries.push([key, value]));
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < entriesToRemove && i < entries.length; i++) {
      tokenMetadataCache.delete(entries[i][0]);
    }
  }
  tokenMetadataCache.set(mint, { data, timestamp: Date.now() });
}

// Export for testing/debugging - get cache stats
export function getMetadataCacheStats() {
  const now = Date.now();
  let valid = 0;
  let expired = 0;
  tokenMetadataCache.forEach((entry) => {
    if (now - entry.timestamp < METADATA_CACHE_TTL) valid++;
    else expired++;
  });
  return { total: tokenMetadataCache.size, valid, expired, maxSize: METADATA_CACHE_MAX_SIZE };
}

export interface TopHolderInfo {
  address: string;
  percent: number;
  amount: number;      // Raw token amount (with decimals)
  uiAmount: number;    // Human-readable amount (without decimals)
  isLP?: boolean;
}

export async function fetchTopHolders(mintAddress: string, limit: number = 100): Promise<TopHolderInfo[]> {
  try {
    const { getTokenLargestAccounts: rpcGetLargestAccounts, getMultipleAccountsInfo, rpcCall } = await import("./rpc-provider");
    const { PublicKey } = await import("@solana/web3.js");
    
    const largestAccounts = await rpcGetLargestAccounts(mintAddress);
    
    if (!largestAccounts || largestAccounts.length === 0) {
      return [];
    }

    const supplyInfo = await rpcCall("getTokenSupply", async (connection) => {
      return connection.getTokenSupply(new PublicKey(mintAddress));
    });

    let totalSupply = 0;
    let decimals = 9;
    if (supplyInfo.value?.amount) {
      totalSupply = parseFloat(supplyInfo.value.amount);
      decimals = supplyInfo.value.decimals ?? 9;
    }
    
    if (totalSupply === 0) {
      totalSupply = largestAccounts.reduce(
        (sum: number, h: any) => sum + parseFloat(h.amount || "0"),
        0
      );
    }

    if (totalSupply === 0) return [];

    const sliced = largestAccounts.slice(0, limit);
    
    let ownerAddresses: string[] = [];
    try {
      const tokenAccountAddresses = sliced.map(h => h.address.toString());
      const accountInfos = await getMultipleAccountsInfo(tokenAccountAddresses);
      
      ownerAddresses = accountInfos.map((info: any) => {
        if (info && info.data && info.data.length >= 64) {
          const data = info.data as Buffer;
          const ownerPubkey = new PublicKey(data.slice(32, 64));
          return ownerPubkey.toString();
        }
        return "";
      });
    } catch (err) {
      console.error("Failed to resolve holder owner addresses:", err);
      ownerAddresses = sliced.map(h => h.address.toString());
    }

    const divisor = Math.pow(10, decimals);
    const holders: TopHolderInfo[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const holder = sliced[i];
      const amount = parseFloat(holder.amount || "0");
      const percent = (amount / totalSupply) * 100;
      holders.push({
        address: ownerAddresses[i] || holder.address.toString(),
        percent: Math.round(percent * 100) / 100,
        amount: amount,
        uiAmount: amount / divisor,
      });
    }

    return holders;
  } catch (error) {
    console.error("Error fetching top holders:", error);
    return [];
  }
}

// Token mint to symbol mapping for common Solana tokens
const TOKEN_SYMBOLS: Record<string, string> = {
  "So11111111111111111111111111111111111111112": "SOL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
};

export function getTokenSymbol(mint: string): string {
  return TOKEN_SYMBOLS[mint] || mint.slice(0, 6) + "...";
}

export function getSwapWalletAddress(payload: HeliusWebhookPayload): string | null {
  const swapEvent = payload.events?.swap;
  if (!swapEvent) return null;
  
  if (swapEvent.nativeInput?.account) {
    return swapEvent.nativeInput.account;
  }
  if (swapEvent.tokenInputs && swapEvent.tokenInputs.length > 0) {
    return swapEvent.tokenInputs[0].userAccount;
  }
  return null;
}

export function parseSwapFromWebhook(payload: HeliusWebhookPayload): InsertSwap | null {
  // Check if this is a swap transaction
  if (!payload.events?.swap && payload.type !== "SWAP") {
    return null;
  }

  const swapEvent = payload.events?.swap;
  
  let fromToken = "Unknown";
  let fromTokenSymbol = "???";
  let fromAmount = 0;
  let toToken = "Unknown";
  let toTokenSymbol = "???";
  let toAmount = 0;

  if (swapEvent) {
    // Handle native SOL input
    if (swapEvent.nativeInput) {
      fromToken = "So11111111111111111111111111111111111111112";
      fromTokenSymbol = "SOL";
      fromAmount = parseInt(swapEvent.nativeInput.amount) / 1e9;
    }
    // Handle token inputs
    else if (swapEvent.tokenInputs && swapEvent.tokenInputs.length > 0) {
      const input = swapEvent.tokenInputs[0];
      fromToken = input.mint;
      fromTokenSymbol = getTokenSymbol(input.mint);
      fromAmount = parseInt(input.rawTokenAmount.tokenAmount) / Math.pow(10, input.rawTokenAmount.decimals);
    }

    // Handle native SOL output
    if (swapEvent.nativeOutput) {
      toToken = "So11111111111111111111111111111111111111112";
      toTokenSymbol = "SOL";
      toAmount = parseInt(swapEvent.nativeOutput.amount) / 1e9;
    }
    // Handle token outputs
    else if (swapEvent.tokenOutputs && swapEvent.tokenOutputs.length > 0) {
      const output = swapEvent.tokenOutputs[0];
      toToken = output.mint;
      toTokenSymbol = getTokenSymbol(output.mint);
      toAmount = parseInt(output.rawTokenAmount.tokenAmount) / Math.pow(10, output.rawTokenAmount.decimals);
    }
  }

  return {
    signature: payload.signature,
    timestamp: payload.timestamp * 1000 || Date.now(),
    type: payload.type || "SWAP",
    source: payload.source || "Unknown",
    fromToken,
    fromTokenSymbol,
    fromAmount,
    toToken,
    toTokenSymbol,
    toAmount,
    fee: undefined,
    slot: payload.slot,
  };
}

export async function createWebhook(webhookUrl: string, walletAddresses: string[]): Promise<string | null> {
  if (!HELIUS_API_KEY) {
    console.error("HELIUS_API_KEY not found");
    return null;
  }

  if (walletAddresses.length === 0) {
    console.error("No wallet addresses provided for webhook");
    return null;
  }

  const addresses = walletAddresses;

  try {
    const apiBase = await getHeliusApiEndpoint();
    const response = await fetch(`${apiBase}/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ["SWAP"],
        accountAddresses: addresses,
        webhookType: "enhanced",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Failed to create webhook:", error);
      return null;
    }

    const data = await response.json();
    console.log("Webhook created for", addresses.length, "wallet(s):", data.webhookID);
    return data.webhookID;
  } catch (error) {
    console.error("Error creating webhook:", error);
    return null;
  }
}

export async function deleteWebhook(webhookId: string): Promise<boolean> {
  if (!HELIUS_API_KEY) return false;
  
  try {
    const apiBase = await getHeliusApiEndpoint();
    const response = await fetch(`${apiBase}/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch (error) {
    console.error("Error deleting webhook:", error);
    return false;
  }
}

export async function getWebhooks(): Promise<any[]> {
  if (!HELIUS_API_KEY) return [];
  
  try {
    const apiBase = await getHeliusApiEndpoint();
    const response = await fetch(`${apiBase}/v0/webhooks?api-key=${HELIUS_API_KEY}`);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error("Error fetching webhooks:", error);
    return [];
  }
}

export async function getWebhooksOnNetwork(network: "mainnet" | "devnet"): Promise<any[]> {
  if (!HELIUS_API_KEY) return [];
  try {
    const apiBase = network === "devnet" ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";
    const response = await fetch(`${apiBase}/v0/webhooks?api-key=${HELIUS_API_KEY}`);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error(`Error fetching webhooks on ${network}:`, error);
    return [];
  }
}

export async function deleteWebhookOnNetwork(webhookId: string, network: "mainnet" | "devnet"): Promise<boolean> {
  if (!HELIUS_API_KEY) return false;
  try {
    const apiBase = network === "devnet" ? "https://api-devnet.helius.xyz" : "https://api.helius.xyz";
    const response = await fetch(`${apiBase}/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch (error) {
    console.error(`Error deleting webhook ${webhookId} on ${network}:`, error);
    return false;
  }
}

export async function cleanupStaleWebhooks(currentWebhookUrl: string, validWebhookId?: string): Promise<{ cleaned: number; reusable: string | null }> {
  if (!HELIUS_API_KEY) return { cleaned: 0, reusable: null };

  const mode = await getNetworkMode();
  const otherNetwork = mode === "mainnet" ? "devnet" : "mainnet";
  let cleaned = 0;
  let reusable: string | null = null;

  const currentWebhooks = await getWebhooksOnNetwork(mode);
  console.log(`[WebhookCleanup] Found ${currentWebhooks.length} webhook(s) on ${mode}`);

  for (const wh of currentWebhooks) {
    const whUrl = wh.webhookURL || "";
    const whId = wh.webhookID;

    if (validWebhookId && whId === validWebhookId) {
      continue;
    }

    if (whUrl.startsWith(currentWebhookUrl) || whUrl.split("?")[0] === currentWebhookUrl) {
      if (!reusable) {
        reusable = whId;
        console.log(`[WebhookCleanup] Found reusable webhook ${whId} on ${mode}`);
      } else {
        const deleted = await deleteWebhookOnNetwork(whId, mode);
        if (deleted) {
          cleaned++;
          console.log(`[WebhookCleanup] Deleted duplicate webhook ${whId} on ${mode}`);
        }
      }
    } else {
      const deleted = await deleteWebhookOnNetwork(whId, mode);
      if (deleted) {
        cleaned++;
        console.log(`[WebhookCleanup] Deleted stale webhook ${whId} (url: ${whUrl.slice(0, 60)}...) on ${mode}`);
      }
    }
  }

  const otherWebhooks = await getWebhooksOnNetwork(otherNetwork);
  if (otherWebhooks.length > 0) {
    console.log(`[WebhookCleanup] Found ${otherWebhooks.length} orphaned webhook(s) on ${otherNetwork}, cleaning up`);
    for (const wh of otherWebhooks) {
      const deleted = await deleteWebhookOnNetwork(wh.webhookID, otherNetwork);
      if (deleted) {
        cleaned++;
        console.log(`[WebhookCleanup] Deleted orphan webhook ${wh.webhookID} on ${otherNetwork}`);
      }
    }
  }

  console.log(`[WebhookCleanup] Done: cleaned ${cleaned} webhook(s), reusable: ${reusable || "none"}`);
  return { cleaned, reusable };
}

// Fetch historical swap transactions for a wallet address
export interface HistoricalSwap {
  signature: string;
  timestamp: number;
  type: "BUY" | "SELL";
  tokenMint: string;
  tokenSymbol: string;
  tokenAmount: number;
  solAmount: number;
  pricePerToken: number;
}

export interface WalletTradingHistory {
  walletAddress: string;
  swaps: HistoricalSwap[];
  tokenSummaries: Map<string, {
    tokenMint: string;
    tokenSymbol: string;
    totalBuys: number;
    totalSells: number;
    totalBuyAmount: number;
    totalSellAmount: number;
    totalBuySol: number;
    totalSellSol: number;
    avgBuyPrice: number;
    avgSellPrice: number;
    realizedPnl: number;
    currentHoldings: number;
  }>;
}

export async function fetchWalletSwapHistory(walletAddress: string, limit: number = 100): Promise<HistoricalSwap[]> {
  if (!HELIUS_API_KEY) {
    console.error("No Helius API key configured");
    return [];
  }

  try {
    // Use Helius parsed transaction history API
    const apiBase = await getHeliusApiEndpoint();
    const response = await fetch(`${apiBase}/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=${limit}`);
    
    if (!response.ok) {
      console.error("Failed to fetch wallet history:", await response.text());
      return [];
    }

    const transactions = await response.json();
    const swaps: HistoricalSwap[] = [];

    for (const tx of transactions) {
      if (!tx.events?.swap) continue;

      const swapEvent = tx.events.swap;
      const timestamp = tx.timestamp || Math.floor(Date.now() / 1000);
      const signature = tx.signature;

      // Parse the swap direction
      const nativeInput = swapEvent.nativeInput;
      const nativeOutput = swapEvent.nativeOutput;
      const tokenInputs = swapEvent.tokenInputs || [];
      const tokenOutputs = swapEvent.tokenOutputs || [];

      if (nativeInput && tokenOutputs.length > 0) {
        // SOL -> Token (BUY)
        const tokenOut = tokenOutputs[0];
        const solAmount = nativeInput.amount / 1e9;
        const tokenAmount = tokenOut.rawTokenAmount?.tokenAmount 
          ? parseFloat(tokenOut.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOut.rawTokenAmount.decimals || 9)
          : 0;
        
        if (tokenAmount > 0) {
          swaps.push({
            signature,
            timestamp,
            type: "BUY",
            tokenMint: tokenOut.mint,
            tokenSymbol: getTokenSymbol(tokenOut.mint),
            tokenAmount,
            solAmount,
            pricePerToken: solAmount / tokenAmount,
          });
        }
      } else if (tokenInputs.length > 0 && nativeOutput) {
        // Token -> SOL (SELL)
        const tokenIn = tokenInputs[0];
        const solAmount = nativeOutput.amount / 1e9;
        const tokenAmount = tokenIn.rawTokenAmount?.tokenAmount
          ? parseFloat(tokenIn.rawTokenAmount.tokenAmount) / Math.pow(10, tokenIn.rawTokenAmount.decimals || 9)
          : 0;

        if (tokenAmount > 0) {
          swaps.push({
            signature,
            timestamp,
            type: "SELL",
            tokenMint: tokenIn.mint,
            tokenSymbol: getTokenSymbol(tokenIn.mint),
            tokenAmount,
            solAmount,
            pricePerToken: solAmount / tokenAmount,
          });
        }
      } else if (tokenInputs.length > 0 && tokenOutputs.length > 0) {
        // Token -> Token swap - check if either side is USDC
        const tokenIn = tokenInputs[0];
        const tokenOut = tokenOutputs[0];
        const inputMint = tokenIn.mint;
        const outputMint = tokenOut.mint;
        
        // USDC -> Token (BUY)
        if (isBaseCurrency(inputMint) && !isBaseCurrency(outputMint)) {
          const usdcAmount = tokenIn.rawTokenAmount?.tokenAmount
            ? parseFloat(tokenIn.rawTokenAmount.tokenAmount) / Math.pow(10, tokenIn.rawTokenAmount.decimals || 6)
            : 0;
          const tokenAmount = tokenOut.rawTokenAmount?.tokenAmount
            ? parseFloat(tokenOut.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOut.rawTokenAmount.decimals || 9)
            : 0;
          
          if (tokenAmount > 0 && usdcAmount > 0) {
            swaps.push({
              signature,
              timestamp,
              type: "BUY",
              tokenMint: outputMint,
              tokenSymbol: getTokenSymbol(outputMint),
              tokenAmount,
              solAmount: usdcAmount, // Store USDC amount in solAmount field for consistency
              pricePerToken: usdcAmount / tokenAmount,
            });
          }
        }
        // Token -> USDC (SELL)
        else if (!isBaseCurrency(inputMint) && isBaseCurrency(outputMint)) {
          const tokenAmount = tokenIn.rawTokenAmount?.tokenAmount
            ? parseFloat(tokenIn.rawTokenAmount.tokenAmount) / Math.pow(10, tokenIn.rawTokenAmount.decimals || 9)
            : 0;
          const usdcAmount = tokenOut.rawTokenAmount?.tokenAmount
            ? parseFloat(tokenOut.rawTokenAmount.tokenAmount) / Math.pow(10, tokenOut.rawTokenAmount.decimals || 6)
            : 0;
          
          if (tokenAmount > 0 && usdcAmount > 0) {
            swaps.push({
              signature,
              timestamp,
              type: "SELL",
              tokenMint: inputMint,
              tokenSymbol: getTokenSymbol(inputMint),
              tokenAmount,
              solAmount: usdcAmount, // Store USDC amount in solAmount field for consistency
              pricePerToken: usdcAmount / tokenAmount,
            });
          }
        }
      }
    }

    return swaps;
  } catch (error) {
    console.error("Error fetching wallet swap history:", error);
    return [];
  }
}

export async function analyzeWalletTradingHistory(walletAddress: string): Promise<WalletTradingHistory> {
  const swaps = await fetchWalletSwapHistory(walletAddress, 200);
  
  const tokenSummaries = new Map<string, {
    tokenMint: string;
    tokenSymbol: string;
    totalBuys: number;
    totalSells: number;
    totalBuyAmount: number;
    totalSellAmount: number;
    totalBuySol: number;
    totalSellSol: number;
    avgBuyPrice: number;
    avgSellPrice: number;
    realizedPnl: number;
    currentHoldings: number;
  }>();

  for (const swap of swaps) {
    if (!tokenSummaries.has(swap.tokenMint)) {
      tokenSummaries.set(swap.tokenMint, {
        tokenMint: swap.tokenMint,
        tokenSymbol: swap.tokenSymbol,
        totalBuys: 0,
        totalSells: 0,
        totalBuyAmount: 0,
        totalSellAmount: 0,
        totalBuySol: 0,
        totalSellSol: 0,
        avgBuyPrice: 0,
        avgSellPrice: 0,
        realizedPnl: 0,
        currentHoldings: 0,
      });
    }

    const summary = tokenSummaries.get(swap.tokenMint)!;
    
    if (swap.type === "BUY") {
      summary.totalBuys++;
      summary.totalBuyAmount += swap.tokenAmount;
      summary.totalBuySol += swap.solAmount;
    } else {
      summary.totalSells++;
      summary.totalSellAmount += swap.tokenAmount;
      summary.totalSellSol += swap.solAmount;
    }
  }

  // Calculate averages and PnL
  for (const [, summary] of tokenSummaries) {
    if (summary.totalBuyAmount > 0) {
      summary.avgBuyPrice = summary.totalBuySol / summary.totalBuyAmount;
    }
    if (summary.totalSellAmount > 0) {
      summary.avgSellPrice = summary.totalSellSol / summary.totalSellAmount;
    }
    
    // Current holdings = bought - sold
    summary.currentHoldings = summary.totalBuyAmount - summary.totalSellAmount;
    
    // Realized PnL = SOL from sells - (proportional SOL spent on those tokens)
    const soldRatio = summary.totalBuyAmount > 0 ? summary.totalSellAmount / summary.totalBuyAmount : 0;
    const costBasis = summary.totalBuySol * soldRatio;
    summary.realizedPnl = summary.totalSellSol - costBasis;
  }

  return {
    walletAddress,
    swaps,
    tokenSummaries,
  };
}

export async function updateWebhookUrl(webhookId: string, newUrl: string, walletAddresses: string[]): Promise<boolean> {
  if (!HELIUS_API_KEY) return false;
  
  if (walletAddresses.length === 0) {
    console.log("No wallet addresses to monitor");
    return true;
  }
  
  const addresses = walletAddresses;
  
  try {
    const apiBase = await getHeliusApiEndpoint();
    const response = await fetch(`${apiBase}/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: newUrl,
        transactionTypes: ["SWAP"],
        accountAddresses: addresses,
        webhookType: "enhanced",
      }),
    });
    
    if (!response.ok) {
      console.error("Failed to update webhook URL:", await response.text());
      return false;
    }
    
    console.log("Webhook URL updated to:", newUrl, "monitoring", addresses.length, "wallet(s)");
    return true;
  } catch (error) {
    console.error("Error updating webhook:", error);
    return false;
  }
}

// Backfill recent swap history for a wallet address using Helius enhanced transactions API
export interface BackfillResult {
  success: boolean;
  swapsFound: number;
  swapsStored: number;
  error?: string;
}

export async function backfillWalletSwaps(
  walletAddress: string,
  maxTransactions: number = 100
): Promise<{ swaps: InsertSwap[]; error?: string }> {
  if (!HELIUS_API_KEY) {
    return { swaps: [], error: "Helius API key not configured" };
  }
  
  const budgetCheck = await shouldAllowApiCall("helius");
  if (!budgetCheck.allowed) {
    return { swaps: [], error: `API budget exceeded: ${budgetCheck.reason}` };
  }
  
  try {
    const apiBase = await getHeliusApiEndpoint();
    const url = `${apiBase}/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${maxTransactions}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      return { swaps: [], error: `Helius API error: ${errorText}` };
    }
    
    const transactions = await response.json();
    await trackApiCall("helius", "backfillWalletSwaps");
    
    if (!Array.isArray(transactions)) {
      return { swaps: [], error: "Unexpected response format" };
    }
    
    const swaps: InsertSwap[] = [];
    
    for (const tx of transactions) {
      // Only process swap transactions
      if (tx.type !== "SWAP") continue;
      
      // Parse the swap from Helius enhanced transaction format
      const swap = parseSwapFromHeliusTransaction(tx, walletAddress);
      if (swap) {
        swaps.push(swap);
      }
    }
    
    console.log(`Backfill: Found ${swaps.length} swaps for ${walletAddress}`);
    return { swaps };
  } catch (error: any) {
    console.error("Backfill error:", error);
    return { swaps: [], error: error.message };
  }
}

// Parse a swap from Helius enhanced transaction format
function parseSwapFromHeliusTransaction(tx: any, walletAddress: string): InsertSwap | null {
  try {
    // Helius enhanced transactions have tokenTransfers array
    const tokenTransfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];
    
    // Find the token in and token out for this wallet
    let fromToken = "";
    let fromAmount = 0;
    let fromSymbol = "";
    let toToken = "";
    let toAmount = 0;
    let toSymbol = "";
    
    // Check native SOL transfers (in/out for this wallet)
    for (const transfer of nativeTransfers) {
      if (transfer.fromUserAccount === walletAddress) {
        // SOL going out
        fromToken = SOL_MINT;
        fromAmount = transfer.amount / 1e9; // lamports to SOL
        fromSymbol = "SOL";
      }
      if (transfer.toUserAccount === walletAddress) {
        // SOL coming in
        toToken = SOL_MINT;
        toAmount = transfer.amount / 1e9;
        toSymbol = "SOL";
      }
    }
    
    // Check token transfers
    for (const transfer of tokenTransfers) {
      if (transfer.fromUserAccount === walletAddress) {
        // Token going out
        fromToken = transfer.mint;
        fromAmount = transfer.tokenAmount;
        fromSymbol = transfer.tokenStandard === "Fungible" ? (transfer.symbol || "???") : "???";
      }
      if (transfer.toUserAccount === walletAddress) {
        // Token coming in
        toToken = transfer.mint;
        toAmount = transfer.tokenAmount;
        toSymbol = transfer.tokenStandard === "Fungible" ? (transfer.symbol || "???") : "???";
      }
    }
    
    // Need both from and to to be a valid swap
    if (!fromToken || !toToken || fromAmount <= 0 || toAmount <= 0) {
      return null;
    }
    
    // Determine if buy or sell
    const isBuy = isBaseCurrency(fromToken);
    
    return {
      signature: tx.signature,
      timestamp: tx.timestamp,
      type: isBuy ? "buy" : "sell",
      source: walletAddress,
      fromToken,
      fromTokenSymbol: fromSymbol,
      fromAmount,
      toToken,
      toTokenSymbol: toSymbol,
      toAmount,
      fee: tx.fee ? tx.fee / 1e9 : undefined,
      slot: tx.slot || 0,
    };
  } catch (error) {
    console.error("Error parsing swap from Helius tx:", error);
    return null;
  }
}

// Token holding info for a wallet
export interface WalletTokenHolding {
  mint: string;
  symbol?: string;
  name?: string;
  amount: number;  // Human-readable amount
  decimals: number;
  priceUsd?: number;
  valueUsd?: number;
  marketCap?: number;
  priceChange24h?: number;
}

// Fetch all token holdings for a wallet address
export async function fetchWalletTokenHoldings(walletAddress: string): Promise<WalletTokenHolding[]> {
  if (!HELIUS_API_KEY) {
    console.warn("No Helius API key - skipping wallet holdings fetch");
    return [];
  }

  const budgetCheck = await shouldAllowApiCall("helius");
  if (!budgetCheck.allowed) {
    console.warn(`Helius API blocked: ${budgetCheck.reason}`);
    return [];
  }

  try {
    const rpcUrl = await getHeliusRpcEndpoint();
    
    // Use getTokenAccountsByOwner to get all SPL token accounts
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wallet-tokens",
        method: "getTokenAccountsByOwner",
        params: [
          walletAddress,
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { encoding: "jsonParsed" }
        ],
      }),
    });

    if (!response.ok) {
      console.error("Failed to fetch token accounts:", response.status);
      return [];
    }

    const data = await response.json();
    await trackApiCall("helius", "getTokenAccountsByOwner");

    if (!data.result?.value) {
      return [];
    }

    const holdings: WalletTokenHolding[] = [];

    for (const account of data.result.value) {
      const parsed = account.account?.data?.parsed?.info;
      if (!parsed) continue;

      const mint = parsed.mint;
      const amount = parsed.tokenAmount?.uiAmount || 0;
      const decimals = parsed.tokenAmount?.decimals || 0;

      // Skip zero balance and base currencies (SOL/USDC)
      if (amount <= 0 || isBaseCurrency(mint)) continue;

      holdings.push({
        mint,
        amount,
        decimals,
      });
    }

    if (holdings.length === 0) {
      return [];
    }

    // Batch fetch prices (uses getBatchTokenPrices which batches in groups of 30)
    const { getBatchTokenPrices } = await import("./jupiter");
    const { getTokenData, queueEnrichment } = await import("./data-pool");
    const mints = holdings.map(h => h.mint);
    const batchPrices = await getBatchTokenPrices(mints);

    // Check data pool for all token symbols/names (parallel lookups)
    const poolDataMap = new Map<string, { symbol?: string; name?: string; priceUsd?: number; marketCap?: number; priceChange24h?: number }>();
    const poolDataPromises = mints.map(async (mint) => {
      const poolData = await getTokenData(mint);
      if (poolData?.tokenSymbol) {
        poolDataMap.set(mint, {
          symbol: poolData.tokenSymbol,
          name: poolData.tokenName ?? undefined,
          priceUsd: poolData.priceUsd ?? undefined,
          marketCap: poolData.marketCap ?? undefined,
          priceChange24h: poolData.priceChange24h ?? undefined,
        });
      }
    });
    await Promise.all(poolDataPromises);

    // Enrich holdings with batch price data, data pool, and cached metadata
    // Queue high-priority fetches for tokens missing symbol/name
    const enrichedHoldings: WalletTokenHolding[] = holdings.map(holding => {
      const priceData = batchPrices.get(holding.mint);
      const poolData = poolDataMap.get(holding.mint);
      
      // Check metadata cache for symbol/name (5-min TTL, no API call)
      const cached = tokenMetadataCache.get(holding.mint);
      const cachedMeta = cached && (Date.now() - cached.timestamp < METADATA_CACHE_TTL) ? cached.data : undefined;

      // Prefer data pool (most up-to-date) > cached metadata
      const symbol = poolData?.symbol || cachedMeta?.symbol;
      const name = poolData?.name || cachedMeta?.name;
      
      // Queue high-priority fetch for tokens missing symbol/name (for next refresh)
      if (!symbol) {
        queueEnrichment(holding.mint, 'high', ['tokenSymbol', 'tokenName']);
      }

      const priceUsd = priceData?.price || poolData?.priceUsd || cachedMeta?.priceUsd;
      return {
        ...holding,
        symbol,
        name,
        priceUsd: priceUsd || undefined,
        valueUsd: priceUsd ? holding.amount * priceUsd : undefined,
        marketCap: priceData?.marketCap || poolData?.marketCap || cachedMeta?.marketCap,
        priceChange24h: priceData?.priceChange24h || poolData?.priceChange24h || cachedMeta?.priceChange24h,
      };
    });

    return enrichedHoldings;
  } catch (error) {
    console.error("Error fetching wallet token holdings:", error);
    return [];
  }
}
