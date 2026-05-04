import { db } from "./db";
import { eq } from "drizzle-orm";
import { tokenOutcomes, priceHistoryCache, swaps } from "@shared/schema";
import { predictTokenSuccess, extractEarlyDynamicsFeatures } from "./token-success-ann";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// =====================
// LLM INTERPRETATION
// =====================

/**
 * Generate human-readable explanation for token success score
 * Called on-demand when user asks "why was this token scored X?"
 */
export async function explainTokenScore(
  tokenMint: string,
  annScore: number,
  launchTimestamp?: number
): Promise<string> {
  try {
    // Fetch token data
    const tokenData = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, tokenMint),
    });

    // Fetch early trades
    const now = Math.floor(Date.now() / 1000);
    const estimatedLaunchTime = launchTimestamp || now - 3600;
    const tenMinutesLater = estimatedLaunchTime + 600;

    const trades = await db
      .select()
      .from(swaps)
      .where(
        eq(swaps.toToken, tokenMint)
      )
      .limit(50);

    // Fetch price data
    const candles = await db
      .select()
      .from(priceHistoryCache)
      .where(eq(priceHistoryCache.tokenMint, tokenMint))
      .limit(20);

    // Extract features for context
    const features = await extractEarlyDynamicsFeatures(tokenMint, estimatedLaunchTime);

    // Build context for LLM
    const contextData = {
      tokenMint,
      annScore: (annScore * 100).toFixed(1),
      actualOutcome: tokenData ? {
        winRate: tokenData.earlyBuyerWinRate,
        multiplier: tokenData.earlyBuyerMedianMultiplier,
        peaked: tokenData.peakMultiplierAllTime,
      } : null,
      earlyTrades: {
        totalCount: trades.length,
        largeTradeCount: trades.filter(t => (t.fromAmount ?? 0) > 0.1).length,
        uniqueWallets: new Set(trades.map(t => t.source)).size,
      },
      priceData: {
        candleCount: candles.length,
        priceRange: candles.length > 0
          ? `${Math.min(...candles.map(c => c.low ?? 0)).toFixed(8)} - ${Math.max(...candles.map(c => c.high ?? 0)).toFixed(8)}`
          : "N/A",
      },
      features: {
        whaleActivityScore: features[10],
        holderConcentration: features[13],
        volumeAcceleration: features[8],
      },
    };

    // Call Claude to explain
    const prompt = buildInterpretationPrompt(contextData);

    const message = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const explanation = message.content[0].type === "text" ? message.content[0].text : "Unable to generate explanation";

    return explanation;
  } catch (error) {
    console.error(`[Interpreter] Failed to explain token score for ${tokenMint}:`, error);
    return `Unable to explain score for ${tokenMint} (error: ${error instanceof Error ? error.message : "unknown"})`;
  }
}

/**
 * Build prompt for LLM interpretation
 */
function buildInterpretationPrompt(contextData: any): string {
  return `
You are an expert crypto analyst explaining why a token received a specific success prediction score.

Token: ${contextData.tokenMint}
ANN Prediction Score: ${contextData.annScore}% (confidence in success)

Early Activity:
- Total trades: ${contextData.earlyTrades.totalCount}
- Large trades (whale activity): ${contextData.earlyTrades.largeTradeCount}
- Unique wallets: ${contextData.earlyTrades.uniqueWallets}
- Whale activity score: ${contextData.features.whaleActivityScore?.toFixed(3) ?? "N/A"}
- Holder concentration: ${(contextData.features.holderConcentration * 100)?.toFixed(1) ?? "N/A"}%
- Volume acceleration: ${contextData.features.volumeAcceleration?.toFixed(3) ?? "N/A"}

${contextData.actualOutcome ? `
Actual Outcome (what happened):
- Early buyer win rate: ${(contextData.actualOutcome.winRate * 100).toFixed(1)}%
- Median multiplier: ${contextData.actualOutcome.multiplier?.toFixed(2)}x
- Peak multiplier: ${contextData.actualOutcome.peaked?.toFixed(2)}x
` : ""}

Provide a brief 1-2 sentence explanation of why the token received this score. Be specific about which metrics drove the prediction (e.g., "whale clustering", "holder diversity", "volume patterns"). If actual outcome is provided, note if the prediction was accurate or if patterns were surprising.

Keep explanation concise and technical.`;
}

/**
 * Batch interpret multiple tokens
 */
export async function interpretMultipleTokens(
  tokenScores: Array<{ mint: string; score: number; launchTime?: number }>
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  for (const token of tokenScores) {
    const explanation = await explainTokenScore(token.mint, token.score, token.launchTime);
    results[token.mint] = explanation;
  }

  return results;
}
