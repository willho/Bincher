import { Connection, PublicKey, Transaction, VersionedTransaction, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getHotWalletKeypair, getHotWalletBalance, getTokenWalletBalance } from "./wallet";

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const JUPITER_API = "https://quote-api.jup.ag/v6";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const SLIPPAGE_BPS = 500;
const DEFAULT_PRIORITY_FEE_LAMPORTS = 100000; // 0.0001 SOL

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
    const connection = new Connection(HELIUS_RPC, "confirmed");
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

// Get SOL price in USD from DexScreener
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedSolPrice && (now - cachedSolPrice.timestamp) < SOL_PRICE_CACHE_MS) {
    return cachedSolPrice.price;
  }
  
  try {
    // Use wrapped SOL address for DexScreener lookup
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
    if (!response.ok) {
      console.error("DexScreener SOL price error:", await response.text());
      return cachedSolPrice?.price || 150; // Fallback to cached or default
    }
    
    const data = await response.json();
    if (data.pairs && data.pairs.length > 0) {
      // Get price from the highest liquidity pair
      const sortedPairs = data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const priceUsd = parseFloat(sortedPairs[0].priceNative) > 0 
        ? 1 / parseFloat(sortedPairs[0].priceNative) * parseFloat(sortedPairs[0].priceUsd)
        : parseFloat(sortedPairs[0].priceUsd) || 150;
      
      cachedSolPrice = { price: priceUsd, timestamp: now };
      return priceUsd;
    }
    
    return cachedSolPrice?.price || 150;
  } catch (error) {
    console.error("Failed to fetch SOL price:", error);
    return cachedSolPrice?.price || 150;
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
  amountInLamports: number
): Promise<JupiterQuote | null> {
  try {
    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.append("inputMint", inputMint);
    url.searchParams.append("outputMint", outputMint);
    url.searchParams.append("amount", amountInLamports.toString());
    url.searchParams.append("slippageBps", SLIPPAGE_BPS.toString());
    url.searchParams.append("swapMode", "ExactIn");

    const response = await rateLimitedFetch(url.toString());
    if (!response.ok) {
      console.error("Jupiter quote error:", await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Failed to get Jupiter quote:", error);
    return null;
  }
}

export async function executeSwap(
  quote: JupiterQuote,
  keypair: Keypair,
  priorityFeeLamports?: number
): Promise<SwapResult> {
  try {
    const fee = priorityFeeLamports ?? await estimatePriorityFee();
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: fee,
    };

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

    const connection = new Connection(HELIUS_RPC, "confirmed");
    
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

  return executeSwap(quote, keypair);
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

  const quote = await getQuote(tokenMint, SOL_MINT, Math.floor(tokenAmount));
  
  if (!quote) {
    return { success: false, error: "Failed to get quote from Jupiter" };
  }

  console.log(`Got quote: ${tokenAmount.toLocaleString()} tokens -> ${parseInt(quote.outAmount) / LAMPORTS_PER_SOL} SOL`);

  return executeSwap(quote, keypair);
}

export async function getTokenPrice(tokenMint: string): Promise<number | null> {
  try {
    const response = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data.pairs && data.pairs.length > 0) {
      const sortedPairs = data.pairs.sort((a: any, b: any) => 
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );
      return parseFloat(sortedPairs[0].priceUsd);
    }
    return null;
  } catch (error) {
    console.error("Failed to get token price:", error);
    return null;
  }
}

export async function getTokenInfo(tokenMint: string): Promise<{ name: string; symbol: string } | null> {
  try {
    const response = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!response.ok) return null;
    
    const data = await response.json();
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
