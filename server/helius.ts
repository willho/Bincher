import type { HeliusWebhookPayload, InsertSwap, TokenMetadata } from "@shared/schema";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WALLET_ADDRESS = "C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak";

export function getWalletAddress(): string {
  return WALLET_ADDRESS;
}

export async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | undefined> {
  // Skip SOL - it's native and doesn't have DexScreener data
  if (mintAddress === "So11111111111111111111111111111111111111112") {
    return undefined;
  }
  
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (!response.ok) return undefined;
    
    const data = await response.json();
    if (!data.pairs || data.pairs.length === 0) return undefined;
    
    // Get the pair with highest liquidity
    const pair = data.pairs.reduce((best: any, current: any) => {
      const bestLiq = best.liquidity?.usd || 0;
      const currLiq = current.liquidity?.usd || 0;
      return currLiq > bestLiq ? current : best;
    });
    
    return {
      name: pair.baseToken?.name,
      symbol: pair.baseToken?.symbol,
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
    console.error("Error fetching token metadata:", error);
    return undefined;
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

export async function createWebhook(webhookUrl: string): Promise<string | null> {
  if (!HELIUS_API_KEY) {
    console.error("HELIUS_API_KEY not found");
    return null;
  }

  try {
    const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ["SWAP"],
        accountAddresses: [WALLET_ADDRESS],
        webhookType: "enhanced",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Failed to create webhook:", error);
      return null;
    }

    const data = await response.json();
    console.log("Webhook created:", data.webhookID);
    return data.webhookID;
  } catch (error) {
    console.error("Error creating webhook:", error);
    return null;
  }
}

export async function deleteWebhook(webhookId: string): Promise<boolean> {
  if (!HELIUS_API_KEY) return false;
  
  try {
    const response = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`, {
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
    const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`);
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.error("Error fetching webhooks:", error);
    return [];
  }
}
