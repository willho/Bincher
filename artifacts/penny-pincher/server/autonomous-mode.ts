import { db } from "./db";
import { autonomousSettings, holdings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getHotWalletBalance } from "./wallet";

export interface RiskProfile {
  name: string;
  description: string;
  maxOpenPositions: number;
  maxPositionSizeUsd: number;
  minTokenScore: number;
  defaultStopLoss: number;
  defaultTakeProfit: number[];
  stopOnDailyLossUsd: number | null;
  stopOnDrawdownPercent: number | null;
  stopOnLossStreak: number | null;
  stopOnTradeCount: number | null;
  stopOnMinBalanceSol: number | null;
}

export const RISK_PROFILES: Record<string, RiskProfile> = {
  conservative: {
    name: "Conservative",
    description: "Lower risk with strict stop conditions. Prioritizes capital preservation.",
    maxOpenPositions: 3,
    maxPositionSizeUsd: 25,
    minTokenScore: 80,
    defaultStopLoss: 30,
    defaultTakeProfit: [2, 4, 10],
    stopOnDailyLossUsd: 50,
    stopOnDrawdownPercent: 15,
    stopOnLossStreak: 2,
    stopOnTradeCount: 5,
    stopOnMinBalanceSol: 0.5,
  },
  balanced: {
    name: "Balanced",
    description: "Moderate risk with reasonable stop conditions. Good for most traders.",
    maxOpenPositions: 5,
    maxPositionSizeUsd: 50,
    minTokenScore: 70,
    defaultStopLoss: 50,
    defaultTakeProfit: [4, 10, 25],
    stopOnDailyLossUsd: 100,
    stopOnDrawdownPercent: 25,
    stopOnLossStreak: 3,
    stopOnTradeCount: 10,
    stopOnMinBalanceSol: 0.2,
  },
  aggressive: {
    name: "Aggressive",
    description: "Higher risk with looser stop conditions. For experienced traders.",
    maxOpenPositions: 10,
    maxPositionSizeUsd: 100,
    minTokenScore: 60,
    defaultStopLoss: 70,
    defaultTakeProfit: [10, 50, 100],
    stopOnDailyLossUsd: 200,
    stopOnDrawdownPercent: 40,
    stopOnLossStreak: 5,
    stopOnTradeCount: 20,
    stopOnMinBalanceSol: 0.1,
  },
};

export async function getAutonomousSettings(userId: number) {
  const [settings] = await db.select().from(autonomousSettings)
    .where(eq(autonomousSettings.userId, userId));
  
  return settings || null;
}

export async function createAutonomousSettings(userId: number, riskProfileName: string = "balanced") {
  const profile = RISK_PROFILES[riskProfileName] || RISK_PROFILES.balanced;
  const now = Math.floor(Date.now() / 1000);
  
  const [settings] = await db.insert(autonomousSettings).values({
    userId,
    riskProfile: riskProfileName,
    maxOpenPositions: profile.maxOpenPositions,
    maxPositionSizeUsd: profile.maxPositionSizeUsd,
    minTokenScore: profile.minTokenScore,
    defaultTakeProfit: profile.defaultTakeProfit,
    defaultStopLoss: profile.defaultStopLoss,
    stopOnDailyLossUsd: profile.stopOnDailyLossUsd,
    stopOnDrawdownPercent: profile.stopOnDrawdownPercent,
    stopOnLossStreak: profile.stopOnLossStreak,
    stopOnTradeCount: profile.stopOnTradeCount,
    stopOnMinBalanceSol: profile.stopOnMinBalanceSol,
    createdAt: now,
    updatedAt: now,
  }).returning();
  
  return settings;
}

export async function updateAutonomousSettings(userId: number, updates: Partial<typeof autonomousSettings.$inferSelect>) {
  const now = Math.floor(Date.now() / 1000);
  
  const [updated] = await db.update(autonomousSettings)
    .set({ ...updates, updatedAt: now })
    .where(eq(autonomousSettings.userId, userId))
    .returning();
  
  return updated;
}

export async function applyRiskProfile(userId: number, profileName: string) {
  const profile = RISK_PROFILES[profileName];
  if (!profile) {
    throw new Error(`Unknown risk profile: ${profileName}`);
  }
  
  const settings = await getAutonomousSettings(userId);
  if (!settings) {
    return createAutonomousSettings(userId, profileName);
  }
  
  return updateAutonomousSettings(userId, {
    riskProfile: profileName,
    maxOpenPositions: profile.maxOpenPositions,
    maxPositionSizeUsd: profile.maxPositionSizeUsd,
    minTokenScore: profile.minTokenScore,
    defaultTakeProfit: profile.defaultTakeProfit,
    defaultStopLoss: profile.defaultStopLoss,
    stopOnDailyLossUsd: profile.stopOnDailyLossUsd,
    stopOnDrawdownPercent: profile.stopOnDrawdownPercent,
    stopOnLossStreak: profile.stopOnLossStreak,
    stopOnTradeCount: profile.stopOnTradeCount,
    stopOnMinBalanceSol: profile.stopOnMinBalanceSol,
  });
}

export async function enableAutonomousMode(userId: number, acknowledged: boolean = false) {
  const settings = await getAutonomousSettings(userId);
  if (!settings) {
    throw new Error("Autonomous settings not found. Create settings first.");
  }
  
  if (!acknowledged && !settings.warningAcknowledged) {
    throw new Error("You must acknowledge the risks before enabling autonomous mode.");
  }
  
  const now = Math.floor(Date.now() / 1000);
  const balance = await getHotWalletBalance(userId);
  
  return updateAutonomousSettings(userId, {
    enabled: true,
    enabledAt: now,
    warningAcknowledged: true,
    acknowledgedAt: now,
    peakBalanceSol: balance,
    stoppedReason: null,
    stoppedAt: null,
    todayLossUsd: 0,
    todayWinUsd: 0,
    todayTradeCount: 0,
    consecutiveLosses: 0,
    stateResetAt: now,
  });
}

export async function disableAutonomousMode(userId: number, reason?: string) {
  const now = Math.floor(Date.now() / 1000);
  
  return updateAutonomousSettings(userId, {
    enabled: false,
    stoppedReason: reason || "manual_disable",
    stoppedAt: now,
  });
}

export interface StopConditionResult {
  shouldStop: boolean;
  reason: string | null;
  condition: string | null;
}

export async function checkStopConditions(userId: number): Promise<StopConditionResult> {
  const settings = await getAutonomousSettings(userId);
  if (!settings || !settings.enabled) {
    return { shouldStop: false, reason: null, condition: null };
  }
  
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400);
  
  if (settings.stateResetAt && settings.stateResetAt < startOfDay) {
    await updateAutonomousSettings(userId, {
      todayLossUsd: 0,
      todayWinUsd: 0,
      todayTradeCount: 0,
      stateResetAt: now,
    });
  }
  
  if (settings.stopOnDailyLossUsd && settings.todayLossUsd && settings.todayLossUsd >= settings.stopOnDailyLossUsd) {
    return {
      shouldStop: true,
      reason: `Daily loss limit reached: $${settings.todayLossUsd.toFixed(2)} >= $${settings.stopOnDailyLossUsd.toFixed(2)}`,
      condition: "daily_loss_limit",
    };
  }
  
  if (settings.stopOnLossStreak && settings.consecutiveLosses && settings.consecutiveLosses >= settings.stopOnLossStreak) {
    return {
      shouldStop: true,
      reason: `Loss streak triggered: ${settings.consecutiveLosses} consecutive losses`,
      condition: "loss_streak",
    };
  }
  
  if (settings.stopOnTradeCount && settings.todayTradeCount && settings.todayTradeCount >= settings.stopOnTradeCount) {
    return {
      shouldStop: true,
      reason: `Trade count limit reached: ${settings.todayTradeCount} trades today`,
      condition: "trade_count_limit",
    };
  }
  
  const balance = await getHotWalletBalance(userId);
  
  if (settings.stopOnMinBalanceSol && balance < settings.stopOnMinBalanceSol) {
    return {
      shouldStop: true,
      reason: `Kill switch: Balance ${balance.toFixed(4)} SOL below minimum ${settings.stopOnMinBalanceSol.toFixed(4)} SOL`,
      condition: "min_balance_kill_switch",
    };
  }
  
  if (settings.stopOnDrawdownPercent && settings.peakBalanceSol && settings.peakBalanceSol > 0) {
    const drawdown = ((settings.peakBalanceSol - balance) / settings.peakBalanceSol) * 100;
    if (drawdown >= settings.stopOnDrawdownPercent) {
      return {
        shouldStop: true,
        reason: `Drawdown limit reached: ${drawdown.toFixed(1)}% from peak`,
        condition: "drawdown_limit",
      };
    }
  }
  
  return { shouldStop: false, reason: null, condition: null };
}

export async function recordTradeResult(userId: number, profitLossUsd: number) {
  const settings = await getAutonomousSettings(userId);
  if (!settings) return;
  
  const isProfit = profitLossUsd > 0;
  const balance = await getHotWalletBalance(userId);
  
  const updates: Partial<typeof autonomousSettings.$inferSelect> = {
    todayTradeCount: (settings.todayTradeCount || 0) + 1,
  };
  
  if (isProfit) {
    updates.todayWinUsd = (settings.todayWinUsd || 0) + profitLossUsd;
    updates.consecutiveLosses = 0;
    if (!settings.peakBalanceSol || balance > settings.peakBalanceSol) {
      updates.peakBalanceSol = balance;
    }
  } else {
    updates.todayLossUsd = (settings.todayLossUsd || 0) + Math.abs(profitLossUsd);
    updates.consecutiveLosses = (settings.consecutiveLosses || 0) + 1;
  }
  
  await updateAutonomousSettings(userId, updates);
  
  const stopCheck = await checkStopConditions(userId);
  if (stopCheck.shouldStop) {
    await disableAutonomousMode(userId, stopCheck.reason || undefined);
    console.log(`[Autonomous] Auto-stopped for user ${userId}: ${stopCheck.reason}`);
    return stopCheck;
  }
  
  return null;
}

export async function canExecuteTrade(userId: number): Promise<{ allowed: boolean; reason?: string }> {
  const settings = await getAutonomousSettings(userId);
  
  if (!settings || !settings.enabled) {
    return { allowed: false, reason: "Autonomous mode is not enabled" };
  }
  
  if (settings.stoppedReason) {
    return { allowed: false, reason: `Auto-stopped: ${settings.stoppedReason}` };
  }
  
  const stopCheck = await checkStopConditions(userId);
  if (stopCheck.shouldStop) {
    await disableAutonomousMode(userId, stopCheck.reason || undefined);
    return { allowed: false, reason: stopCheck.reason || "Stop condition triggered" };
  }
  
  const openPositions = await db.select().from(holdings)
    .where(eq(holdings.userId, userId));
  
  if (settings.maxOpenPositions && openPositions.length >= settings.maxOpenPositions) {
    return { allowed: false, reason: `Maximum open positions (${settings.maxOpenPositions}) reached` };
  }
  
  return { allowed: true };
}

export function getRiskProfiles() {
  return Object.entries(RISK_PROFILES).map(([key, profile]) => ({
    id: key,
    ...profile,
  }));
}
