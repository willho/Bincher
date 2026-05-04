import { Connection, PublicKey, Transaction, VersionedTransaction, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getHotWalletKeypair, getHotWalletBalance, getTokenWalletBalance, getTradeConfig } from "./wallet";
import { trackApiCall, shouldAllowApiCall } from "./api-budget";
import { getConnection } from "./rpc-provider";

const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULT_SLIPPAGE_BPS = 500;
const DEFAULT_PRIORITY_FEE_LAMPORTS = 100000; // 0.0001 SOL

// SOL price cache (update every 5 minutes)
interface SolPriceCache {
  price: number | null;
  cachedAt: number;
  ttlMs: number;
}

const solPriceCache: SolPriceCache = {
  price: null,
  cachedAt: 0,
  ttlMs: 5 * 60 * 1000, // 5 minute TTL
};

function isSolPriceCacheValid(): boolean {
  return Date.now() - solPriceCache.cachedAt < solPriceCache.ttlMs;
}

function getCachedSolPrice(): number | null {
  if (isSolPriceCacheValid()) {
    return solPriceCache.price;
  }
  return null;
}

function setSolPriceCache(price: number | null): void {
  solPriceCache.price = price;
  solPriceCache.cachedAt = Date.now();
  if (price) {
    console.log(`[SolPrice] Updated cache: $${price.toFixed(2)}`);
  }
}

// Slippage configuration for trades
export interface SlippageConfig {
  mode: "auto" | "fixed";
  maxBps: number; // Maximum slippage in basis points
  minBps: number; // Minimum slippage for auto mode
}

const MIN_REQUEST_INTERVAL_MS = 500;
const MAX_REQUESTS_PER_MINUTE = 30;
let lastRequestTime = 0;
let requestsInLastMinute = 0;
let minuteStartTime = Date.now();

async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  const now = Date.now();
  
  if (now - minuteStartTime > 60000) {
    minuteStartTime = now;
    requestsInLastMinute = 0;
  }
  
  if (requestsInLastMinute >= MAX_REQUESTS_PER_MINUTE) {
    const waitTime = 60000 - (now - minuteStartTime);
    console.log(`Rate limit reached, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    minuteStartTime = Date.now();
    requestsInLastMinute = 0;
  }
  
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest));
  }
  
  lastRequestTime = Date.now();
  requestsInLastMinute++;
  
  return fetch(url, options);
}

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null;
  priceImpactPct: string;
  routePlan: any[];
  contextSlot?: number;
  timeTaken?: number;
}

interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount?: number;
  outputAmount?: number;
  tokenMint?: string;
  error?: string;
}

// Estimate priority fee using Helius RPC
export async function estimatePriorityFee(): Promise<number> {
  try {
    const connection = await getConnection();
    const recentFees = await connection.getRecentPrioritizationFees();
    
    if (recentFees.length === 0) {
      return DEFAULT_PRIORITY_FEE_LAMPORTS;
    }
    
    // Get median priority fee from recent transactions
    const fees = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
    const medianFee = fees[Math.floor(fees.length / 2)];
    
    // Add 20% buffer and clamp between min/max
    const bufferedFee = Math.floor(medianFee * 1.2);
    const minFee = 50000; // 0.00005 SOL
    const maxFee = 500000; // 0.0005 SOL
    
    return Math.max(minFee, Math.min(maxFee, bufferedFee));
  } catch (error) {
    console.error("Failed to estimate priority fee:", error);
    return DEFAULT_PRIORITY_FEE_LAMPORTS;
  }
}

// Convert priority fee to SOL for funding calculations
export function priorityFeeToSol(priorityFeeLamports: number): number {
  return priorityFeeLamports / LAMPORTS_PER_SOL;
}

// Cache SOL price for 60 seconds to reduce API calls
let cachedSolPrice: { price: number; timestamp: number } | null = null;
const SOL_PRICE_CACHE_MS = 60000;

// Get SOL price in USD from Binance (more reliable than DexScreener for SOL)
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedSolPrice && (now - cachedSolPrice.timestamp) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice.price;
  }
  
  try {
    // Use Binance ticker API for reliable SOL/USDT price
    const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    if (!response.ok) {
      console.error("Binance SOL price error:", response.status);
      return cachedSolPrice?.price || 200; // Fallback to cached or reasonable default
    }
    
    const data = await response.json();
    const priceUsd = parseFloat(data.price);
    
    if (priceUsd > 0) {
      cachedSolPrice = { price: priceUsd, timestamp: now };
      return priceUsd;
    }
    
    return cachedSolPrice?.price || 200;
  } catch (error) {
    console.error("Failed to fetch SOL price:", error);
    return cachedSolPrice?.price || 200;
  }
}

// Historical SOL price cache (timestamp in seconds -> price)
const historicalSolPriceCache = new Map<number, number>();
const HISTORICAL_CACHE_MAX_SIZE = 1000;

/**
 * Get historical SOL price at a specific timestamp using Binance API
 * Uses kline (candlestick) data for historical prices
 * @param timestampSeconds Unix timestamp in seconds
 * @returns SOL price in USD at that time, or null if unavailable
 */
export async function getHistoricalSolPrice(timestampSeconds: number): Promise<number | null> {
  // Round to nearest hour for caching efficiency
  const hourTimestamp = Math.floor(timestampSeconds / 3600) * 3600;
  
  // Check cache first
  if (historicalSolPriceCache.has(hourTimestamp)) {
    return historicalSolPriceCache.get(hourTimestamp) || null;
  }
  
  // If timestamp is very recent (within last hour), use current price
  const now = Math.floor(Date.now() / 1000);
  if (now - timestampSeconds < 3600) {
    const currentPrice = await getSolPriceUsd();
    return currentPrice;
  }
  
  try {
    // Binance API: Get 1-hour kline data
    // startTime and endTime are in milliseconds
    const startTimeMs = hourTimestamp * 1000;
    const endTimeMs = startTimeMs + 3600000; // 1 hour later
    
    const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1`;
    
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[Historical SOL] Binance API error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (Array.isArray(data) && data.length > 0) {
      // Kline format: [openTime, open, high, low, close, volume, closeTime, ...]
      // Use close price as the representative price for that hour
      const closePrice = parseFloat(data[0][4]);
      
      if (closePrice > 0) {
        // Add to cache
        if (historicalSolPriceCache.size >= HISTORICAL_CACHE_MAX_SIZE) {
          // Remove oldest entry (first key)
          const firstKey = historicalSolPriceCache.keys().next().value;
          if (firstKey) historicalSolPriceCache.delete(firstKey);
        }
        historicalSolPriceCache.set(hourTimestamp, closePrice);
        
        return closePrice;
      }
    }
    
    return null;
  } catch (error) {
    console.error('[Historical SOL] Error fetching from Binance:', error);
    return null;
  }
}

// Calculate split buy segments
// Returns array of SOL amounts for each segment
export function calculateSplitBuySegments(totalSolAmount: number, solPriceUsd: number): number[] {
  const totalUsd = totalSolAmount * solPriceUsd;
  
  // If under $400, no split needed
  if (totalUsd <= 400) {
    return [totalSolAmount];
  }
  
  const segments: number[] = [];
  let remainingUsd = totalUsd;
  
  while (remainingUsd > 0) {
    // Random segment cap between $350-400
    const segmentCapUsd = 350 + Math.random() * 50;
    
    if (remainingUsd <= segmentCapUsd) {
      // Last segment gets whatever is left
      segments.push(remainingUsd / solPriceUsd);
      remainingUsd = 0;
    } else {
      segments.push(segmentCapUsd / solPriceUsd);
      remainingUsd -= segmentCapUsd;
    }
  }
  
  return segments;
}

// Get random buy percentage between 10-15%
export function getRandomBuyPercentage(): number {
  return 10 + Math.random() * 5;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountInLamports: number,
  slippageConfig?: SlippageConfig
): Promise<JupiterQuote | null> {
  const startTime = Date.now();
  try {
    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.append("inputMint", inputMint);
    url.searchParams.append("outputMint", outputMint);
    url.searchParams.append("amount", amountInLamports.toString());
    url.searchParams.append("swapMode", "ExactIn");
    
    // Use dynamic slippage (autoSlippage) for auto mode, fixed slippage otherwise
    if (slippageConfig?.mode === "auto") {
      url.searchParams.append("autoSlippage", "true");
      // Use maxBps as the slippage cap for auto mode
      url.searchParams.append("slippageBps", slippageConfig.maxBps.toString());
    } else {
      // Fixed mode: use exact slippage value
      const slippageBps = slippageConfig?.maxBps ?? DEFAULT_SLIPPAGE_BPS;
      url.searchParams.append("slippageBps", slippageBps.toString());
    }
    
    // Restrict intermediate tokens to avoid low-liquidity routes
    url.searchParams.append("restrictIntermediateTokens", "true");

    const response = await rateLimitedFetch(url.toString());
    const latencyMs = Date.now() - startTime;
    
    if (!response.ok) {
      console.error("Jupiter quote error:", await response.text());
      const { logApiCall } = await import("./system-logger");
      logApiCall("jupiter", "getQuote", false, latencyMs, { inputMint, outputMint, status: response.status }).catch(() => {});
      return null;
    }

    const quote = await response.json();
    const { logApiCall } = await import("./system-logger");
    logApiCall("jupiter", "getQuote", true, latencyMs, { inputMint, outputMint }).catch(() => {});
    return quote;
  } catch (error) {
    console.error("Failed to get Jupiter quote:", error);
    return null;
  }
}

export async function executeSwap(
  quote: JupiterQuote,
  keypair: Keypair,
  priorityFeeLamports?: number,
  slippageConfig?: SlippageConfig
): Promise<SwapResult> {
  try {
    const fee = priorityFeeLamports ?? await estimatePriorityFee();
    
    // Build swap body with dynamic slippage for auto mode
    const swapBody: any = {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: fee,
    };
    
    // Add dynamic slippage configuration for auto mode
    if (slippageConfig?.mode === "auto") {
      swapBody.dynamicSlippage = {
        minBps: slippageConfig.minBps,
        maxBps: slippageConfig.maxBps,
      };
    }

    const swapResponse = await rateLimitedFetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(swapBody),
    });

    if (!swapResponse.ok) {
      const errorText = await swapResponse.text();
      console.error("Jupiter swap request failed:", errorText);
      return { success: false, error: `Jupiter API error: ${errorText}` };
    }

    const swapData = await swapResponse.json();
    const swapTransaction = swapData.swapTransaction;

    if (!swapTransaction) {
      return { success: false, error: "No transaction returned from Jupiter" };
    }

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([keypair]);

    const connection = await getConnection();
    
    const signature = await connection.sendTransaction(transaction, {
      maxRetries: 3,
      skipPreflight: true,
    });

    console.log("Swap transaction sent:", signature);

    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    
    if (confirmation.value.err) {
      console.error("Transaction failed:", confirmation.value.err);
      return { success: false, signature, error: "Transaction failed on-chain" };
    }

    console.log("Swap confirmed:", signature);

    return {
      success: true,
      signature,
      inputAmount: parseInt(quote.inAmount) / LAMPORTS_PER_SOL,
      outputAmount: parseInt(quote.outAmount),
      tokenMint: quote.outputMint,
    };
  } catch (error) {
    console.error("Swap execution failed:", error);
    return { success: false, error: String(error) };
  }
}

export async function buyToken(
  userId: number,
  tokenMint: string,
  solAmount: number
): Promise<SwapResult> {
  console.log(`User ${userId}: Attempting to buy ${tokenMint} with ${solAmount} SOL`);

  const keypair = await getHotWalletKeypair(userId);
  if (!keypair) {
    return { success: false, error: "Hot wallet not found or decryption failed" };
  }

  const balance = await getHotWalletBalance(userId);
  if (balance < solAmount) {
    return { 
      success: false, 
      error: `Insufficient balance: ${balance.toFixed(4)} SOL < ${solAmount.toFixed(4)} SOL` 
    };
  }

  // Get user's slippage settings
  const tradeSettings = await getTradeConfig(userId);
  const slippageConfig: SlippageConfig = {
    mode: (tradeSettings.slippageMode as "auto" | "fixed") || "auto",
    maxBps: tradeSettings.slippageMaxBps || 500,
    minBps: tradeSettings.slippageMinBps || 50,
  };
  
  console.log(`Using slippage: mode=${slippageConfig.mode}, max=${slippageConfig.maxBps}bps`);

  const amountInLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quote = await getQuote(SOL_MINT, tokenMint, amountInLamports, slippageConfig);
  
  if (!quote) {
    return { success: false, error: "Failed to get quote from Jupiter" };
  }

  console.log(`Got quote: ${solAmount} SOL -> ${parseInt(quote.outAmount).toLocaleString()} tokens`);
  console.log(`Price impact: ${quote.priceImpactPct}%`);

  const priceImpact = parseFloat(quote.priceImpactPct);
  if (priceImpact > 10) {
    return { 
      success: false, 
      error: `Price impact too high: ${priceImpact.toFixed(2)}%` 
    };
  }

  return executeSwap(quote, keypair, undefined, slippageConfig);
}

export async function sellToken(
  userId: number,
  tokenMint: string,
  tokenAmount: number
): Promise<SwapResult> {
  console.log(`User ${userId}: Attempting to sell ${tokenAmount} tokens of ${tokenMint}`);

  const keypair = await getHotWalletKeypair(userId);
  if (!keypair) {
    return { success: false, error: "Hot wallet not found or decryption failed" };
  }

  // Get user's slippage settings
  const tradeSettings = await getTradeConfig(userId);
  const slippageConfig: SlippageConfig = {
    mode: (tradeSettings.slippageMode as "auto" | "fixed") || "auto",
    maxBps: tradeSettings.slippageMaxBps || 500,
    minBps: tradeSettings.slippageMinBps || 50,
  };
  
  console.log(`Using slippage: mode=${slippageConfig.mode}, max=${slippageConfig.maxBps}bps`);

  const quote = await getQuote(tokenMint, SOL_MINT, Math.floor(tokenAmount), slippageConfig);
  
  if (!quote) {
    return { success: false, error: "Failed to get quote from Jupiter" };
  }

  console.log(`Got quote: ${tokenAmount.toLocaleString()} tokens -> ${parseInt(quote.outAmount) / LAMPORTS_PER_SOL} SOL`);

  return executeSwap(quote, keypair, undefined, slippageConfig);
}

export async function getTokenPrice(tokenMint: string): Promise<number | null> {
  const budgetCheck = await shouldAllowApiCall("dexscreener");
  if (!budgetCheck.allowed) {
    console.warn(`DexScreener API blocked: ${budgetCheck.reason}`);
    return null;
  }

  try {
    const response = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;

    const data = await response.json();
    await trackApiCall("dexscreener", "getTokenPrice");

    if (data.pairs && data.pairs.length > 0) {
      const sortedPairs = data.pairs.sort((a: any, b: any) =>
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );
      const tokenPrice = parseFloat(sortedPairs[0].priceUsd);

      // Piggyback: extract SOL price from quote pair if available
      const bestPair = sortedPairs[0];
      if (bestPair.quoteToken?.address === SOL_MINT && bestPair.priceNative) {
        // Token is priced in SOL, so we can derive SOL/USD price
        const tokenPriceInSol = parseFloat(bestPair.priceNative);
        if (tokenPriceInSol > 0 && tokenPrice > 0) {
          const derivedSolPrice = tokenPrice / tokenPriceInSol;
          setSolPriceCache(derivedSolPrice);
        }
      }

      return tokenPrice;
    }
    return null;
  } catch (error) {
    console.error("Failed to get token price:", error);
    return null;
  }
}

export async function getSolPrice(): Promise<number | null> {
  // Check cache first (5 minute TTL)
  const cached = getCachedSolPrice();
  if (cached !== null) {
    return cached;
  }

  // Fallback: fetch SOL price directly (only if cache expired)
  const solPrice = await getTokenPrice(SOL_MINT);
  if (solPrice !== null) {
    setSolPriceCache(solPrice);
  }
  return solPrice;
}

export interface BatchPriceResult {
  tokenMint: string;
  price: number | null;
  liquidity: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  marketCap: number | null;
  fdv: number | null;
}

export async function getBatchTokenPrices(tokenMints: string[]): Promise<Map<string, BatchPriceResult>> {
  const results = new Map<string, BatchPriceResult>();
  
  if (tokenMints.length === 0) {
    return results;
  }
  
  const emptyResult = (mint: string): BatchPriceResult => ({
    tokenMint: mint,
    price: null,
    liquidity: null,
    priceChange24h: null,
    volume24h: null,
    buys24h: null,
    sells24h: null,
    marketCap: null,
    fdv: null,
  });

  const budgetCheck = await shouldAllowApiCall("dexscreener");
  if (!budgetCheck.allowed) {
    console.warn(`DexScreener API blocked: ${budgetCheck.reason}`);
    tokenMints.forEach(mint => results.set(mint, emptyResult(mint)));
    return results;
  }

  const BATCH_SIZE = 30;
  const batches: string[][] = [];
  
  for (let i = 0; i < tokenMints.length; i += BATCH_SIZE) {
    batches.push(tokenMints.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    // Per-batch budget check
    const batchBudgetCheck = await shouldAllowApiCall("dexscreener");
    if (!batchBudgetCheck.allowed) {
      console.warn(`DexScreener API blocked mid-batch: ${batchBudgetCheck.reason}`);
      batch.forEach(mint => results.set(mint, emptyResult(mint)));
      break; // Stop processing remaining batches
    }
    
    try {
      const addresses = batch.join(",");
      const response = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`);
      
      if (!response.ok) {
        batch.forEach(mint => results.set(mint, emptyResult(mint)));
        continue;
      }
      
      const data = await response.json();
      await trackApiCall("dexscreener", "getBatchTokenPrices"); // Track after successful response
      
      batch.forEach(mint => {
        results.set(mint, emptyResult(mint));
      });
      
      if (data.pairs && data.pairs.length > 0) {
        const pairsByToken = new Map<string, any[]>();
        
        for (const pair of data.pairs) {
          const baseMint = pair.baseToken?.address;
          if (baseMint) {
            if (!pairsByToken.has(baseMint)) {
              pairsByToken.set(baseMint, []);
            }
            pairsByToken.get(baseMint)!.push(pair);
          }
        }
        
        for (const [mint, pairs] of pairsByToken) {
          const sortedPairs = pairs.sort((a: any, b: any) => 
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
          );
          const bestPair = sortedPairs[0];
          
          results.set(mint, {
            tokenMint: mint,
            price: parseFloat(bestPair.priceUsd) || null,
            liquidity: bestPair.liquidity?.usd || null,
            priceChange24h: bestPair.priceChange?.h24 || null,
            volume24h: bestPair.volume?.h24 || null,
            buys24h: bestPair.txns?.h24?.buys || null,
            sells24h: bestPair.txns?.h24?.sells || null,
            marketCap: bestPair.marketCap || null,
            fdv: bestPair.fdv || null,
          });
        }
      }
      
      if (batches.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (error) {
      console.error("Failed to get batch token prices:", error);
      batch.forEach(mint => results.set(mint, emptyResult(mint)));
    }
  }

  return results;
}

export async function getTokenInfo(tokenMint: string): Promise<{ name: string; symbol: string } | null> {
  const budgetCheck = await shouldAllowApiCall("dexscreener");
  if (!budgetCheck.allowed) {
    console.warn(`DexScreener API blocked: ${budgetCheck.reason}`);
    return null;
  }
  
  try {
    const response = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    await trackApiCall("dexscreener", "getTokenInfo"); // Track after successful response
    if (data.pairs && data.pairs.length > 0) {
      const sortedPairs = data.pairs.sort((a: any, b: any) => 
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );
      const topPair = sortedPairs[0];
      return {
        name: topPair.baseToken?.name || "Unknown",
        symbol: topPair.baseToken?.symbol || "UNKNOWN",
      };
    }
    return null;
  } catch (error) {
    console.error("Failed to get token info:", error);
    return null;
  }
}

// Buy token using a specific token wallet keypair (for per-token wallet system)
export async function buyTokenWithWallet(
  tokenWalletKeypair: Keypair,
  tokenMint: string,
  solAmount: number
): Promise<SwapResult> {
  const walletAddress = tokenWalletKeypair.publicKey.toBase58();
  console.log(`Token wallet ${walletAddress}: Attempting to buy ${tokenMint} with ${solAmount} SOL`);

  const balance = await getTokenWalletBalance(walletAddress);
  if (balance < solAmount) {
    return { 
      success: false, 
      error: `Insufficient token wallet balance: ${balance.toFixed(4)} SOL < ${solAmount.toFixed(4)} SOL` 
    };
  }

  const amountInLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quote = await getQuote(SOL_MINT, tokenMint, amountInLamports);
  
  if (!quote) {
    return { success: false, error: "Failed to get quote from Jupiter" };
  }

  console.log(`Got quote: ${solAmount} SOL -> ${parseInt(quote.outAmount).toLocaleString()} tokens`);
  console.log(`Price impact: ${quote.priceImpactPct}%`);

  const priceImpact = parseFloat(quote.priceImpactPct);
  if (priceImpact > 10) {
    return { 
      success: false, 
      error: `Price impact too high: ${priceImpact.toFixed(2)}%` 
    };
  }

  return executeSwap(quote, tokenWalletKeypair);
}

// Sell token using a specific token wallet keypair and return profits to main wallet
export async function sellTokenWithWallet(
  tokenWalletKeypair: Keypair,
  tokenMint: string,
  tokenAmount: number
): Promise<SwapResult> {
  const walletAddress = tokenWalletKeypair.publicKey.toBase58();
  console.log(`Token wallet ${walletAddress}: Attempting to sell ${tokenAmount} tokens of ${tokenMint}`);

  const quote = await getQuote(tokenMint, SOL_MINT, Math.floor(tokenAmount));
  
  if (!quote) {
    return { success: false, error: "Failed to get quote from Jupiter" };
  }

  console.log(`Got quote: ${tokenAmount.toLocaleString()} tokens -> ${parseInt(quote.outAmount) / LAMPORTS_PER_SOL} SOL`);

  return executeSwap(quote, tokenWalletKeypair);
}
