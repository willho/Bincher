import { db } from "./db";
import { tokenDataPool } from "@shared/schema";
import { eq, and, gte, isNull, desc, sql } from "drizzle-orm";
import { publishInsight } from "./insight-bus";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

type TokenRow = typeof tokenDataPool.$inferSelect;

export function computeHeatScore(token: TokenRow): number {
  let score = 0;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const volume24h = token.volume24h || 0;
  score += Math.min(25, Math.log10(Math.max(1, volume24h)) * 3);

  if (token.boostRank != null && token.boostRank <= 30) {
    score += Math.min(30, (31 - token.boostRank) * 1);
  }

  if (token.trendingRank != null && token.trendingRank <= 20) {
    score += Math.min(25, (21 - token.trendingRank) * 1.25);
  }

  if (token.priceChange24h != null && token.priceChange24h > 0) {
    score += Math.min(15, token.priceChange24h * 0.5);
  }

  if (token.hasTwitter) score += 3;
  if (token.hasTelegram) score += 3;
  if (token.hasWebsite) score += 2;

  if (!token.tokenSymbol && !token.tokenName) {
    score -= 30;
  }

  const liquidity = token.liquidity || 0;
  if (liquidity < 5000) {
    score *= 0.5;
  } else if (liquidity < 25000) {
    score *= 0.75;
  }

  const marketCap = token.marketCap || 0;
  if (marketCap < 10000) {
    score *= 0.8;
  }

  if (!token.hasTwitter && !token.hasTelegram && !token.hasWebsite) {
    score *= 0.9;
  }

  const priceChanges = [
    token.priceChange1h,
    token.priceChange6h,
    token.priceChange24h,
    token.priceChange7d,
  ];

  let worstMultiplier = 1;
  for (const pc of priceChanges) {
    if (pc == null) continue;
    let mult = 1;
    if (pc <= -90) mult = 0.05;
    else if (pc <= -80) mult = 0.1;
    else if (pc <= -60) mult = 0.2;
    else if (pc <= -40) mult = 0.35;
    else if (pc <= -20) mult = 0.6;
    else if (pc <= -10) mult = 0.8;
    if (mult < worstMultiplier) worstMultiplier = mult;
  }
  score *= worstMultiplier;

  const lastTimestamp = token.updatedAt || token.createdAt || nowSeconds;
  const hoursSinceUpdate = Math.max(0, (nowSeconds - lastTimestamp) / 3600);
  const decayMultiplier = Math.max(0.3, 1 - hoursSinceUpdate * 0.06);
  score *= decayMultiplier;

  score = Math.max(0, Math.min(100, score));
  return Math.round(score);
}

export function applyPincherDecay(rawScore: number, scoredAtTimestamp: number): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const hoursSinceScored = (nowSeconds - scoredAtTimestamp) / 3600;
  const decayMultiplier = Math.max(0.3, 1 - hoursSinceScored * 0.04);
  return Math.round(rawScore * decayMultiplier);
}

interface AIScoreResult {
  mint: string;
  score: number;
  verdict: string;
  confidence: "low" | "medium" | "high";
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

async function scoreBatchWithAI(tokens: TokenRow[]): Promise<AIScoreResult[]> {
  if (tokens.length === 0) return [];

  const nowSeconds = Math.floor(Date.now() / 1000);

  const rows = tokens.map((t) => {
    const socials: string[] = [];
    if (t.hasTwitter) socials.push("TW");
    if (t.hasTelegram) socials.push("TG");
    if (t.hasWebsite) socials.push("WEB");
    const socialStr = socials.length > 0 ? socials.join(",") : "NONE";
    const ageHrs = t.pairCreatedAt
      ? Math.round((nowSeconds - t.pairCreatedAt) / 3600)
      : t.createdAt
        ? Math.round((nowSeconds - t.createdAt) / 3600)
        : "?";

    return `${t.tokenSymbol || "?"} | ${t.tokenMint} | ${formatNumber(t.priceUsd)} | ${formatNumber(t.marketCap)} | ${formatNumber(t.liquidity)} | ${formatNumber(t.volume24h)} | ${formatPct(t.priceChange1h)} | ${formatPct(t.priceChange6h)} | ${formatPct(t.priceChange24h)} | ${socialStr} | ${ageHrs}`;
  });

  const prompt = `You are a Solana token quality analyst. Score each token 0-100 based on fundamentals quality (NOT hype). Consider: liquidity depth, volume-to-liquidity ratio, price trend health, social presence, token age, and crash risk.

For each token, respond with ONLY a JSON array of objects:
[{"mint": "...", "score": 0-100, "verdict": "one-line assessment max 60 chars", "confidence": "low|medium|high"}]

Tokens to analyze:
SYMBOL | MINT | PRICE | MCAP | LIQ | VOL24H | PC1H | PC6H | PC24H | SOCIALS | AGE_HRS
${rows.join("\n")}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message?.content || "";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[PincherScoring] Failed to extract JSON from AI response");
      return [];
    }

    const results: AIScoreResult[] = JSON.parse(jsonMatch[0]);

    for (const result of results) {
      const token = tokens.find((t) => t.tokenMint === result.mint);
      if (token) {
        const hasNoLiquidity = token.liquidity == null || token.liquidity === 0;
        const hasNoPrice = token.priceUsd == null || token.priceUsd === 0;
        const ageHrs = token.pairCreatedAt
          ? (nowSeconds - token.pairCreatedAt) / 3600
          : token.createdAt
            ? (nowSeconds - token.createdAt) / 3600
            : 0;
        if (hasNoLiquidity || hasNoPrice || ageHrs < 1) {
          result.confidence = "low";
        }
      }
      result.score = Math.max(0, Math.min(100, Math.round(result.score)));
      if (result.verdict && result.verdict.length > 60) {
        result.verdict = result.verdict.slice(0, 57) + "...";
      }
    }

    return results;
  } catch (error) {
    console.error("[PincherScoring] AI scoring failed:", error);
    return [];
  }
}

export async function runPincherBatchScoring(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSeconds - 86400;

  console.log("[PincherScoring] Starting batch scoring run...");

  try {
    const allTokens = await db
      .select()
      .from(tokenDataPool)
      .where(
        and(
          eq(tokenDataPool.isActive, true),
          gte(tokenDataPool.updatedAt, oneDayAgo)
        )
      );

    if (allTokens.length === 0) {
      console.log("[PincherScoring] No active tokens found, skipping");
      return;
    }

    const tokensWithHeat = allTokens.map((t) => ({
      token: t,
      heatScore: computeHeatScore(t),
    }));

    tokensWithHeat.sort((a, b) => b.heatScore - a.heatScore);

    const changedTokens: TokenRow[] = [];
    const neverScored: TokenRow[] = [];

    for (const { token } of tokensWithHeat) {
      if (token.pincherScoredAt == null) {
        neverScored.push(token);
      } else if (
        token.updatedAt != null &&
        token.updatedAt > token.pincherScoredAt
      ) {
        const priceMovedSignificantly =
          token.priceChange1h != null && Math.abs(token.priceChange1h) > 5;
        const volumeChanged =
          token.marketDataUpdatedAt != null &&
          token.marketDataUpdatedAt > token.pincherScoredAt;
        const socialChanged =
          token.socialCheckedAt != null &&
          token.socialCheckedAt > token.pincherScoredAt;

        if (priceMovedSignificantly || volumeChanged || socialChanged) {
          changedTokens.push(token);
        }
      }
    }

    const BATCH_SIZE = 50;
    const selected: TokenRow[] = [];
    for (const t of changedTokens) {
      if (selected.length >= BATCH_SIZE) break;
      selected.push(t);
    }
    for (const t of neverScored) {
      if (selected.length >= BATCH_SIZE) break;
      selected.push(t);
    }

    if (selected.length === 0) {
      console.log("[PincherScoring] No tokens need scoring, skipping");
      return;
    }

    console.log(
      `[PincherScoring] Scoring ${selected.length} tokens (${changedTokens.length} changed, ${neverScored.length} never-scored)`
    );

    const results = await scoreBatchWithAI(selected);

    if (results.length === 0) {
      console.log("[PincherScoring] AI returned no results");
      return;
    }

    let updatedCount = 0;
    for (const result of results) {
      try {
        const decayedScore = applyPincherDecay(result.score, nowSeconds);
        await db
          .update(tokenDataPool)
          .set({
            pincherScore: decayedScore,
            pincherScoreRaw: result.score,
            pincherVerdict: result.verdict,
            pincherConfidence: result.confidence,
            pincherScoredAt: nowSeconds,
          })
          .where(eq(tokenDataPool.tokenMint, result.mint));
        updatedCount++;
      } catch (err) {
        console.error(
          `[PincherScoring] Failed to update token ${result.mint}:`,
          err
        );
      }
    }

    console.log(
      `[PincherScoring] Batch complete: ${updatedCount}/${results.length} tokens updated`
    );

    try {
      const avgScore =
        results.reduce((sum, r) => sum + r.score, 0) / results.length;
      const highConf = results.filter((r) => r.confidence === "high").length;
      const medConf = results.filter((r) => r.confidence === "medium").length;
      const lowConf = results.filter((r) => r.confidence === "low").length;

      await publishInsight({
        source: "discovery",
        type: "performance",
        title: `Pincher scored ${updatedCount} tokens (avg: ${avgScore.toFixed(1)})`,
        payload: {
          batchSize: selected.length,
          resultsReturned: results.length,
          tokensUpdated: updatedCount,
          averageScore: Math.round(avgScore * 10) / 10,
          confidenceBreakdown: { high: highConf, medium: medConf, low: lowConf },
          changedTokensScored: Math.min(changedTokens.length, BATCH_SIZE),
          neverScoredTokensScored: Math.max(
            0,
            selected.length - Math.min(changedTokens.length, BATCH_SIZE)
          ),
        },
        confidence: 0.8,
        expiresInHours: 2,
      });
    } catch (err) {
      console.error("[PincherScoring] Failed to publish insight:", err);
    }
  } catch (error) {
    console.error("[PincherScoring] Batch scoring failed:", error);
  }
}

export function startPincherScoringJob(): void {
  console.log("[PincherScoring] Scheduling batch scoring every 30 minutes");

  setTimeout(() => {
    runPincherBatchScoring().catch((err) =>
      console.error("[PincherScoring] Initial run failed:", err)
    );
  }, 60_000);

  setInterval(() => {
    runPincherBatchScoring().catch((err) =>
      console.error("[PincherScoring] Scheduled run failed:", err)
    );
  }, 30 * 60_000);
}
