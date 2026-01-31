import { db } from "./db";
import { users } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { scryptSync, timingSafeEqual } from "crypto";

export interface SecurityCheck {
  allowed: boolean;
  reason?: string;
  pinRequired?: boolean;
  telegramConfirmRequired?: boolean;
}

export interface SecuritySettings {
  hasPinSet: boolean;
  pinMode: string;
  pinThresholdUsd: number;
  dailySpendLimitUsd: number | null;
  withdrawalWhitelist: string[];
  telegramConfirmLargeTransfers: boolean;
  largeTransferThresholdUsd: number;
}

export async function getSecuritySettings(userId: number): Promise<SecuritySettings> {
  const [user] = await db.select({
    withdrawalPinHash: users.withdrawalPinHash,
    pinMode: users.pinMode,
    pinThresholdUsd: users.pinThresholdUsd,
    dailySpendLimitUsd: users.dailySpendLimitUsd,
    withdrawalWhitelist: users.withdrawalWhitelist,
    telegramConfirmLargeTransfers: users.telegramConfirmLargeTransfers,
    largeTransferThresholdUsd: users.largeTransferThresholdUsd,
  }).from(users).where(eq(users.id, userId));

  return {
    hasPinSet: !!user?.withdrawalPinHash,
    pinMode: user?.pinMode || "withdrawals_only",
    pinThresholdUsd: user?.pinThresholdUsd || 100,
    dailySpendLimitUsd: user?.dailySpendLimitUsd ?? null,
    withdrawalWhitelist: (user?.withdrawalWhitelist as string[]) || [],
    telegramConfirmLargeTransfers: user?.telegramConfirmLargeTransfers || false,
    largeTransferThresholdUsd: user?.largeTransferThresholdUsd || 500,
  };
}

export async function verifyPin(userId: number, pin: string): Promise<boolean> {
  const [user] = await db.select({ withdrawalPinHash: users.withdrawalPinHash })
    .from(users).where(eq(users.id, userId));

  if (!user?.withdrawalPinHash) {
    return true; // No PIN set, allow
  }

  if (!pin) {
    return false;
  }

  try {
    const [salt, storedHash] = user.withdrawalPinHash.split(":");
    const hash = scryptSync(pin, salt, 64);
    const storedHashBuffer = Buffer.from(storedHash, "hex");
    return timingSafeEqual(hash, storedHashBuffer);
  } catch {
    return false;
  }
}

export async function checkTradeAllowed(
  userId: number,
  amountUsd: number,
  pin?: string
): Promise<SecurityCheck> {
  const settings = await getSecuritySettings(userId);

  // Check daily spend limit
  if (settings.dailySpendLimitUsd !== null) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    // TODO: Sum today's trades from swapHistory where direction='buy' and createdAt >= todayStart
    // For now, we'll skip this check since we need to implement the sum query
  }

  // Check if PIN is required
  if (settings.hasPinSet) {
    let pinRequired = false;

    switch (settings.pinMode) {
      case "all_trades":
        pinRequired = true;
        break;
      case "threshold":
        pinRequired = amountUsd >= settings.pinThresholdUsd;
        break;
      case "withdrawals_only":
      default:
        pinRequired = false; // PIN only for withdrawals
    }

    if (pinRequired) {
      if (!pin) {
        return { allowed: false, reason: "PIN required for this trade", pinRequired: true };
      }
      const valid = await verifyPin(userId, pin);
      if (!valid) {
        return { allowed: false, reason: "Invalid PIN" };
      }
    }
  }

  return { allowed: true };
}

export async function checkWithdrawalAllowed(
  userId: number,
  destinationAddress: string,
  amountUsd: number,
  pin?: string
): Promise<SecurityCheck> {
  const settings = await getSecuritySettings(userId);

  // Check whitelist if not empty
  if (settings.withdrawalWhitelist.length > 0) {
    if (!settings.withdrawalWhitelist.includes(destinationAddress)) {
      return {
        allowed: false,
        reason: `Address ${destinationAddress.slice(0, 8)}... is not in your withdrawal whitelist`,
      };
    }
  }

  // PIN is always required for withdrawals if set
  if (settings.hasPinSet) {
    if (!pin) {
      return { allowed: false, reason: "PIN required for withdrawals", pinRequired: true };
    }
    const valid = await verifyPin(userId, pin);
    if (!valid) {
      return { allowed: false, reason: "Invalid PIN" };
    }
  }

  // Check if Telegram confirmation needed for large transfers
  if (settings.telegramConfirmLargeTransfers && amountUsd >= settings.largeTransferThresholdUsd) {
    return {
      allowed: false,
      reason: `Large transfer ($${amountUsd.toFixed(2)}) requires Telegram confirmation`,
      telegramConfirmRequired: true,
    };
  }

  return { allowed: true };
}

export async function checkDailySpendRemaining(userId: number): Promise<{
  limit: number | null;
  spent: number;
  remaining: number | null;
}> {
  const settings = await getSecuritySettings(userId);
  
  if (settings.dailySpendLimitUsd === null) {
    return { limit: null, spent: 0, remaining: null };
  }

  // TODO: Calculate actual spent amount from today's trades
  // For now, return full limit as remaining
  return {
    limit: settings.dailySpendLimitUsd,
    spent: 0,
    remaining: settings.dailySpendLimitUsd,
  };
}
