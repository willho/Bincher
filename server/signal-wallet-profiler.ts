import { db } from "./db";
import { signalWalletProfiles, holdings } from "@shared/schema";
import { eq, and, gte, isNotNull, desc } from "drizzle-orm";

export type TradingStyle = "insider" | "degen" | "quality" | "whale" | "unknown";

export interface SignalWalletProfileData {
  walletAddress: string;
  avgEntryMcap: number | null;
  medianHoldTimeMinutes: number | null;
  avgExitMultiplier: number | null;
  maxExitMultiplier: number | null;
  minExitMultiplier: number | null;
  totalTrades: number;
  winningTrades: number;
  ruggedTrades: number;
  winRate: number | null;
  rugRate: number | null;
  tradingStyle: TradingStyle;
  styleConfidence: number;
  recentWinRate: number | null;
  recentAvgMultiplier: number | null;
}

export async function getSignalWalletProfile(walletAddress: string): Promise<SignalWalletProfileData | null> {
  const [profile] = await db.select().from(signalWalletProfiles)
    .where(eq(signalWalletProfiles.walletAddress, walletAddress))
    .limit(1);
  
  if (!profile) return null;
  
  return {
    walletAddress: profile.walletAddress,
    avgEntryMcap: profile.avgEntryMcap,
    medianHoldTimeMinutes: profile.medianHoldTimeMinutes,
    avgExitMultiplier: profile.avgExitMultiplier,
    maxExitMultiplier: profile.maxExitMultiplier,
    minExitMultiplier: profile.minExitMultiplier,
    totalTrades: profile.totalTrades ?? 0,
    winningTrades: profile.winningTrades ?? 0,
    ruggedTrades: profile.ruggedTrades ?? 0,
    winRate: profile.winRate,
    rugRate: profile.rugRate,
    tradingStyle: (profile.tradingStyle as TradingStyle) ?? "unknown",
    styleConfidence: profile.styleConfidence ?? 0,
    recentWinRate: profile.recentWinRate,
    recentAvgMultiplier: profile.recentAvgMultiplier,
  };
}

export async function updateSignalWalletProfile(
  walletAddress: string,
  finalMultiplier: number,
  holdTimeMinutes: number,
  entryMcap?: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  const [existing] = await db.select().from(signalWalletProfiles)
    .where(eq(signalWalletProfiles.walletAddress, walletAddress))
    .limit(1);
  
  const isWin = finalMultiplier >= 1;
  const isRug = finalMultiplier < 0.1;
  
  if (!existing) {
    await db.insert(signalWalletProfiles).values({
      walletAddress,
      avgEntryMcap: entryMcap ?? null,
      medianHoldTimeMinutes: holdTimeMinutes,
      avgExitMultiplier: finalMultiplier,
      maxExitMultiplier: finalMultiplier,
      minExitMultiplier: finalMultiplier,
      totalTrades: 1,
      winningTrades: isWin ? 1 : 0,
      ruggedTrades: isRug ? 1 : 0,
      winRate: isWin ? 1 : 0,
      rugRate: isRug ? 1 : 0,
      tradingStyle: "unknown",
      styleConfidence: 0,
      firstSeenAt: now,
      lastTradeAt: now,
      updatedAt: now,
    });
    return;
  }
  
  const newTotalTrades = (existing.totalTrades ?? 0) + 1;
  const newWinningTrades = (existing.winningTrades ?? 0) + (isWin ? 1 : 0);
  const newRuggedTrades = (existing.ruggedTrades ?? 0) + (isRug ? 1 : 0);
  
  const oldAvgMultiplier = existing.avgExitMultiplier ?? finalMultiplier;
  const newAvgMultiplier = ((oldAvgMultiplier * (existing.totalTrades ?? 1)) + finalMultiplier) / newTotalTrades;
  
  const oldAvgMcap = existing.avgEntryMcap;
  let newAvgMcap = oldAvgMcap;
  if (entryMcap) {
    if (oldAvgMcap) {
      newAvgMcap = ((oldAvgMcap * (existing.totalTrades ?? 1)) + entryMcap) / newTotalTrades;
    } else {
      newAvgMcap = entryMcap;
    }
  }
  
  const oldMedianHold = existing.medianHoldTimeMinutes ?? holdTimeMinutes;
  const newMedianHold = Math.round((oldMedianHold + holdTimeMinutes) / 2);
  
  const newWinRate = newWinningTrades / newTotalTrades;
  const newRugRate = newRuggedTrades / newTotalTrades;
  
  const { style, confidence } = classifyTradingStyle({
    avgEntryMcap: newAvgMcap,
    avgExitMultiplier: newAvgMultiplier,
    winRate: newWinRate,
    rugRate: newRugRate,
    medianHoldTimeMinutes: newMedianHold,
    totalTrades: newTotalTrades,
  });
  
  await db.update(signalWalletProfiles)
    .set({
      avgEntryMcap: newAvgMcap,
      medianHoldTimeMinutes: newMedianHold,
      avgExitMultiplier: newAvgMultiplier,
      maxExitMultiplier: Math.max(existing.maxExitMultiplier ?? finalMultiplier, finalMultiplier),
      minExitMultiplier: Math.min(existing.minExitMultiplier ?? finalMultiplier, finalMultiplier),
      totalTrades: newTotalTrades,
      winningTrades: newWinningTrades,
      ruggedTrades: newRuggedTrades,
      winRate: newWinRate,
      rugRate: newRugRate,
      tradingStyle: style,
      styleConfidence: confidence,
      lastTradeAt: now,
      updatedAt: now,
    })
    .where(eq(signalWalletProfiles.walletAddress, walletAddress));
  
  await updateRecentPerformance(walletAddress);
}

async function updateRecentPerformance(walletAddress: string): Promise<void> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
  
  const recentHoldings = await db.select({
    highestMultiplier: holdings.highestMultiplier,
    reclaimed: holdings.reclaimed,
    reclaimTimestamp: holdings.reclaimTimestamp,
    buyPrice: holdings.buyPrice,
    lastPrice: holdings.lastPrice,
  })
    .from(holdings)
    .where(
      and(
        eq(holdings.sourceWalletAddress, walletAddress),
        gte(holdings.buyTimestamp, thirtyDaysAgo)
      )
    )
    .limit(50);
  
  if (recentHoldings.length === 0) return;
  
  let wins = 0;
  let totalMultiplier = 0;
  let countedTrades = 0;
  
  for (const holding of recentHoldings) {
    const multiplier = holding.reclaimed 
      ? (holding.highestMultiplier ?? 1)
      : (holding.lastPrice && holding.buyPrice ? holding.lastPrice / holding.buyPrice : null);
    
    if (multiplier !== null) {
      if (multiplier >= 1) wins++;
      totalMultiplier += multiplier;
      countedTrades++;
    }
  }
  
  if (countedTrades === 0) return;
  
  const recentWinRate = wins / countedTrades;
  const recentAvgMultiplier = totalMultiplier / countedTrades;
  
  await db.update(signalWalletProfiles)
    .set({
      recentWinRate,
      recentAvgMultiplier,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(signalWalletProfiles.walletAddress, walletAddress));
}

interface StyleClassificationInput {
  avgEntryMcap: number | null;
  avgExitMultiplier: number;
  winRate: number;
  rugRate: number;
  medianHoldTimeMinutes: number;
  totalTrades: number;
}

function classifyTradingStyle(data: StyleClassificationInput): { style: TradingStyle; confidence: number } {
  if (data.totalTrades < 5) {
    return { style: "unknown", confidence: 0 };
  }
  
  let scores: Record<TradingStyle, number> = {
    insider: 0,
    degen: 0,
    quality: 0,
    whale: 0,
    unknown: 0,
  };
  
  if (data.avgEntryMcap && data.avgEntryMcap < 100000) {
    scores.insider += 2;
    scores.degen += 1;
  } else if (data.avgEntryMcap && data.avgEntryMcap > 1000000) {
    scores.quality += 2;
    scores.whale += 1;
  }
  
  if (data.avgExitMultiplier > 10) {
    scores.insider += 2;
  } else if (data.avgExitMultiplier > 3) {
    scores.quality += 1;
    scores.whale += 1;
  } else if (data.avgExitMultiplier < 1) {
    scores.degen += 2;
  }
  
  if (data.rugRate > 0.3) {
    scores.degen += 3;
    scores.insider -= 1;
  } else if (data.rugRate < 0.1) {
    scores.quality += 2;
  }
  
  if (data.winRate > 0.7) {
    scores.quality += 2;
    scores.insider += 1;
  } else if (data.winRate < 0.4) {
    scores.degen += 2;
  }
  
  if (data.medianHoldTimeMinutes < 60) {
    scores.insider += 1;
    scores.degen += 1;
  } else if (data.medianHoldTimeMinutes > 1440) {
    scores.quality += 1;
    scores.whale += 1;
  }
  
  let maxStyle: TradingStyle = "unknown";
  let maxScore = 0;
  let totalScore = 0;
  
  for (const [style, score] of Object.entries(scores) as [TradingStyle, number][]) {
    if (style !== "unknown") {
      totalScore += Math.max(0, score);
      if (score > maxScore) {
        maxScore = score;
        maxStyle = style;
      }
    }
  }
  
  const confidence = totalScore > 0 ? Math.min(1, maxScore / totalScore) : 0;
  
  if (data.totalTrades < 10) {
    return { style: maxStyle, confidence: confidence * 0.5 };
  }
  
  return { style: maxStyle, confidence };
}

export function getProfileSummary(profile: SignalWalletProfileData): string {
  const parts: string[] = [];
  
  if (profile.tradingStyle !== "unknown") {
    const styleDescriptions: Record<TradingStyle, string> = {
      insider: "early entry, high returns",
      degen: "high risk, frequent rugs",
      quality: "quality picks, steady returns",
      whale: "large positions, stable plays",
      unknown: "insufficient data",
    };
    parts.push(styleDescriptions[profile.tradingStyle]);
  }
  
  if (profile.winRate !== null) {
    parts.push(`${Math.round(profile.winRate * 100)}% win rate`);
  }
  
  if (profile.avgExitMultiplier !== null) {
    parts.push(`avg ${profile.avgExitMultiplier.toFixed(1)}x exit`);
  }
  
  if (profile.rugRate !== null && profile.rugRate > 0.1) {
    parts.push(`${Math.round(profile.rugRate * 100)}% rug rate`);
  }
  
  if (profile.medianHoldTimeMinutes !== null) {
    const hours = profile.medianHoldTimeMinutes / 60;
    if (hours < 1) {
      parts.push(`~${profile.medianHoldTimeMinutes}m holds`);
    } else if (hours < 24) {
      parts.push(`~${hours.toFixed(1)}h holds`);
    } else {
      parts.push(`~${(hours / 24).toFixed(1)}d holds`);
    }
  }
  
  return parts.join(", ") || "no trading history";
}

export type RiskProfile = "conservative" | "balanced" | "aggressive" | "custom";

function normalizeProfitPercentages(percentages: number[], targetLength: number): number[] {
  let result = [...percentages];
  
  while (result.length < targetLength) {
    result.push(result[result.length - 1] || 25);
  }
  while (result.length > targetLength) {
    result.pop();
  }
  
  const total = result.reduce((sum, p) => sum + p, 0);
  if (total !== 100 && total > 0) {
    const ratio = 100 / total;
    result = result.map(p => Math.round(p * ratio));
    const diff = 100 - result.reduce((sum, p) => sum + p, 0);
    if (diff !== 0 && result.length > 0) {
      result[0] += diff;
    }
  }
  
  return result;
}

export interface PositionConfigInput {
  walletAddress: string;
  tokenScore?: number;
  hasWhaleActivity?: boolean;
  riskProfile?: RiskProfile;
  recentVolatility?: number;
  marketTrend?: "bullish" | "bearish" | "neutral";
}

export async function suggestPositionConfig(
  input: PositionConfigInput | string,
  tokenScore?: number,
  hasWhaleActivity?: boolean
): Promise<{
  takeProfitThresholds: number[];
  takeProfitPercentages: number[];
  stopLossPercent: number;
  reasoning: string;
  confidenceLevel: "high" | "medium" | "low";
}> {
  const params: PositionConfigInput = typeof input === "string"
    ? { walletAddress: input, tokenScore, hasWhaleActivity }
    : input;
  
  const profile = await getSignalWalletProfile(params.walletAddress);
  
  let takeProfitThresholds = [4, 10, 25, 100];
  let takeProfitPercentages = [25, 25, 25, 25];
  let stopLossPercent = 50;
  const reasons: string[] = [];
  let confidenceLevel: "high" | "medium" | "low" = "medium";
  
  if (profile && profile.totalTrades >= 5) {
    confidenceLevel = profile.totalTrades >= 20 ? "high" : "medium";
    
    if (profile.tradingStyle === "insider") {
      const typicalExit = profile.avgExitMultiplier ?? 10;
      const safeExit = Math.max(2, Math.floor(typicalExit * 0.8));
      takeProfitThresholds = [safeExit, Math.floor(safeExit * 1.5), Math.floor(safeExit * 2)];
      takeProfitPercentages = [40, 40, 20];
      reasons.push(`Wallet typically exits around ${typicalExit.toFixed(1)}x - taking profits early`);
    } else if (profile.tradingStyle === "quality") {
      takeProfitThresholds = [10, 25, 50, 100];
      takeProfitPercentages = [20, 25, 25, 30];
      reasons.push("Quality picker - holding for bigger moves");
    } else if (profile.tradingStyle === "degen") {
      takeProfitThresholds = [2, 4, 10];
      takeProfitPercentages = [50, 30, 20];
      stopLossPercent = 30;
      reasons.push(`High rug rate (${Math.round((profile.rugRate ?? 0) * 100)}%) - quick exits and tight stop`);
    }
    
    if (profile.recentWinRate !== null && profile.recentWinRate < 0.4) {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.max(2, Math.floor(t * 0.7)));
      stopLossPercent = Math.max(20, stopLossPercent - 15);
      reasons.push("Recent performance weak - being more cautious");
      confidenceLevel = "low";
    }
  } else {
    confidenceLevel = "low";
  }
  
  const riskProfile = params.riskProfile || "balanced";
  if (riskProfile === "conservative") {
    takeProfitThresholds = takeProfitThresholds.map(t => Math.max(2, Math.floor(t * 0.7)));
    takeProfitPercentages = takeProfitPercentages.map((p, i) => i === 0 ? p + 15 : p - 5);
    stopLossPercent = Math.max(15, stopLossPercent - 20);
    reasons.push("Conservative profile - tighter exits and stops");
  } else if (riskProfile === "aggressive") {
    takeProfitThresholds = takeProfitThresholds.map(t => Math.floor(t * 1.4));
    takeProfitPercentages = takeProfitPercentages.map((p, i) => i === takeProfitPercentages.length - 1 ? p + 15 : p - 5);
    stopLossPercent = Math.min(80, stopLossPercent + 20);
    reasons.push("Aggressive profile - wider targets and stops");
  }
  
  if (params.tokenScore !== undefined) {
    if (params.tokenScore >= 85) {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.floor(t * 1.3));
      reasons.push("High token score - room for bigger gains");
    } else if (params.tokenScore < 50) {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.max(2, Math.floor(t * 0.7)));
      stopLossPercent = Math.max(20, stopLossPercent - 10);
      reasons.push("Low token score - quick exit strategy");
    }
  }
  
  if (params.hasWhaleActivity) {
    takeProfitThresholds = takeProfitThresholds.map(t => Math.floor(t * 1.2));
    reasons.push("Whale backing detected - holding longer");
  }
  
  if (params.recentVolatility !== undefined) {
    if (params.recentVolatility > 50) {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.max(2, Math.floor(t * 0.8)));
      takeProfitPercentages = takeProfitPercentages.map((p, i) => i === 0 ? p + 10 : p - 3);
      stopLossPercent = Math.max(20, stopLossPercent - 10);
      reasons.push("High volatility - tighter exits");
    } else if (params.recentVolatility < 15) {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.floor(t * 1.15));
      reasons.push("Low volatility - patience for moves");
    }
  }
  
  if (params.marketTrend) {
    if (params.marketTrend === "bearish") {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.max(2, Math.floor(t * 0.75)));
      stopLossPercent = Math.max(20, stopLossPercent - 15);
      reasons.push("Bearish market - defensive stance");
    } else if (params.marketTrend === "bullish") {
      takeProfitThresholds = takeProfitThresholds.map(t => Math.floor(t * 1.2));
      reasons.push("Bullish market - letting winners run");
    }
  }
  
  takeProfitPercentages = normalizeProfitPercentages(takeProfitPercentages, takeProfitThresholds.length);
  
  return {
    takeProfitThresholds,
    takeProfitPercentages,
    stopLossPercent,
    reasoning: reasons.join(". ") || "Using default config",
    confidenceLevel,
  };
}
