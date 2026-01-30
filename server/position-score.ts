import { db } from "./db";
import { holdings } from "@shared/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { getHoldersCached } from "./price-aggregator";

export interface PositionScoreFactors {
  priceChange: number;
  timeDecay: number;
  whaleActivity: number;
  signalWalletStatus: number;
  volumeTrend: number;
}

export interface PositionScoreResult {
  score: number;
  tier: "strong" | "neutral" | "weak";
  factors: PositionScoreFactors;
}

const SCORE_WEIGHTS = {
  priceChange: 0.35,
  timeDecay: 0.15,
  whaleActivity: 0.20,
  signalWalletStatus: 0.20,
  volumeTrend: 0.10,
};

export async function calculatePositionScore(
  holdingId: number,
  currentPrice: number | null,
  volumeChange24h?: number
): Promise<PositionScoreResult> {
  const [holding] = await db.select().from(holdings).where(eq(holdings.id, holdingId)).limit(1);
  
  if (!holding) {
    return { score: 50, tier: "neutral", factors: getEmptyFactors() };
  }

  const factors: PositionScoreFactors = {
    priceChange: 0,
    timeDecay: 0,
    whaleActivity: 0,
    signalWalletStatus: 0,
    volumeTrend: 0,
  };

  const now = Math.floor(Date.now() / 1000);

  if (currentPrice && holding.avgEntryPrice && holding.avgEntryPrice > 0) {
    const pctChange = ((currentPrice - holding.avgEntryPrice) / holding.avgEntryPrice) * 100;
    if (pctChange >= 100) {
      factors.priceChange = 100;
    } else if (pctChange >= 50) {
      factors.priceChange = 75 + (pctChange - 50) * 0.5;
    } else if (pctChange >= 0) {
      factors.priceChange = pctChange * 1.5;
    } else if (pctChange >= -30) {
      factors.priceChange = pctChange * 2;
    } else {
      factors.priceChange = Math.max(-100, pctChange * 1.5);
    }
  }

  const holdTimeHours = (now - holding.buyTimestamp) / 3600;
  if (factors.priceChange <= 5) {
    if (holdTimeHours > 72) {
      factors.timeDecay = -50;
    } else if (holdTimeHours > 48) {
      factors.timeDecay = -30;
    } else if (holdTimeHours > 24) {
      factors.timeDecay = -15;
    } else if (holdTimeHours > 12) {
      factors.timeDecay = -5;
    }
  }

  try {
    const holderData = await getHoldersCached(holding.tokenMint);
    if (holderData && holderData.lastEventTriggerAt > 0) {
      const hoursSinceWhaleEvent = (Date.now() - holderData.lastEventTriggerAt) / (1000 * 3600);
      if (hoursSinceWhaleEvent < 1) {
        factors.whaleActivity = 50;
      } else if (hoursSinceWhaleEvent < 6) {
        factors.whaleActivity = 30;
      } else if (hoursSinceWhaleEvent < 24) {
        factors.whaleActivity = 10;
      }
      
      const concentration = holderData.holders.slice(0, 5).reduce(
        (sum: number, h: { percent: number }) => sum + h.percent, 
        0
      );
      if (concentration > 80) {
        factors.whaleActivity = Math.min(factors.whaleActivity, -30);
      } else if (concentration > 60) {
        factors.whaleActivity = factors.whaleActivity * 0.5;
      }
    }
  } catch (e) {
    console.log(`[PositionScore] Could not get whale data for ${holding.tokenMint}`);
  }

  if (holding.signalWalletSold) {
    const hoursSinceSell = holding.signalWalletSoldAt ? (now - holding.signalWalletSoldAt) / 3600 : 0;
    if (hoursSinceSell < 6) {
      factors.signalWalletStatus = -50;
    } else if (hoursSinceSell < 24) {
      factors.signalWalletStatus = -35;
    } else {
      factors.signalWalletStatus = -20;
    }
  } else if (holding.signalWalletId) {
    factors.signalWalletStatus = 30;
  }

  if (volumeChange24h !== undefined) {
    if (volumeChange24h > 100) {
      factors.volumeTrend = 25;
    } else if (volumeChange24h > 50) {
      factors.volumeTrend = 15;
    } else if (volumeChange24h > 0) {
      factors.volumeTrend = 5;
    } else if (volumeChange24h > -30) {
      factors.volumeTrend = -10;
    } else {
      factors.volumeTrend = -25;
    }
  }

  const rawScore =
    (factors.priceChange * SCORE_WEIGHTS.priceChange) +
    (factors.timeDecay * SCORE_WEIGHTS.timeDecay) +
    (factors.whaleActivity * SCORE_WEIGHTS.whaleActivity) +
    (factors.signalWalletStatus * SCORE_WEIGHTS.signalWalletStatus) +
    (factors.volumeTrend * SCORE_WEIGHTS.volumeTrend);

  const normalizedScore = Math.round(Math.max(0, Math.min(100, 50 + rawScore)));

  let tier: "strong" | "neutral" | "weak";
  if (normalizedScore >= 65) {
    tier = "strong";
  } else if (normalizedScore >= 40) {
    tier = "neutral";
  } else {
    tier = "weak";
  }

  return { score: normalizedScore, tier, factors };
}

export async function updatePositionScore(
  holdingId: number,
  currentPrice: number | null,
  volumeChange24h?: number
): Promise<PositionScoreResult> {
  const result = await calculatePositionScore(holdingId, currentPrice, volumeChange24h);
  const now = Math.floor(Date.now() / 1000);

  await db.update(holdings)
    .set({
      positionScore: result.score,
      positionScoreTier: result.tier,
      scoreLastUpdated: now,
      scoreFactors: result.factors,
    })
    .where(eq(holdings.id, holdingId));

  return result;
}

export async function markSignalWalletSold(
  signalWalletId: number,
  tokenMint: string
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db.update(holdings)
    .set({
      signalWalletSold: true,
      signalWalletSoldAt: now,
    })
    .where(and(
      eq(holdings.signalWalletId, signalWalletId),
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.signalWalletSold, false)
    ))
    .returning({ id: holdings.id });

  console.log(`[PositionScore] Marked ${result.length} positions as signal wallet sold`);
  
  // Immediately recalculate scores for affected positions
  for (const { id } of result) {
    await updatePositionScore(id, null);
  }
  
  if (result.length > 0) {
    console.log(`[PositionScore] Recalculated scores for ${result.length} positions after signal wallet sold`);
  }
  
  return result.length;
}

export async function batchUpdatePositionScores(
  priceMap: Map<string, { price: number; volumeChange24h?: number }>
): Promise<number> {
  const allHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  const now = Math.floor(Date.now() / 1000);
  const SCORE_STALENESS_SECONDS = 300;

  for (const holding of allHoldings) {
    const priceData = priceMap.get(holding.tokenMint);
    if (!priceData) continue;

    const lastUpdate = holding.scoreLastUpdated || 0;
    const needsUpdate = 
      !holding.scoreLastUpdated || 
      now - lastUpdate > SCORE_STALENESS_SECONDS;

    if (needsUpdate) {
      await updatePositionScore(holding.id, priceData.price, priceData.volumeChange24h);
      updatedCount++;
    }
  }

  return updatedCount;
}

export async function updateScoreOnPriceMove(
  tokenMint: string,
  currentPrice: number,
  previousPrice: number | null,
  volumeChange24h?: number
): Promise<number> {
  if (!previousPrice || previousPrice <= 0) return 0;

  const pctChange = Math.abs((currentPrice - previousPrice) / previousPrice) * 100;
  if (pctChange < 10) return 0;

  const affectedHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  for (const holding of affectedHoldings) {
    await updatePositionScore(holding.id, currentPrice, volumeChange24h);
    updatedCount++;
  }

  if (updatedCount > 0) {
    console.log(`[PositionScore] Updated ${updatedCount} positions on ${pctChange.toFixed(1)}% price move for ${tokenMint}`);
  }

  return updatedCount;
}

export async function updateScoreOnWhaleActivity(tokenMint: string): Promise<number> {
  const affectedHoldings = await db.select()
    .from(holdings)
    .where(and(
      eq(holdings.tokenMint, tokenMint),
      eq(holdings.isDead, false),
      eq(holdings.isDust, false)
    ));

  let updatedCount = 0;
  for (const holding of affectedHoldings) {
    await updatePositionScore(holding.id, null);
    updatedCount++;
  }

  if (updatedCount > 0) {
    console.log(`[PositionScore] Updated ${updatedCount} positions on whale activity for ${tokenMint}`);
  }

  return updatedCount;
}

function getEmptyFactors(): PositionScoreFactors {
  return {
    priceChange: 0,
    timeDecay: 0,
    whaleActivity: 0,
    signalWalletStatus: 0,
    volumeTrend: 0,
  };
}
