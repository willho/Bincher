import { z } from "zod";

// Swap transaction schema
export const swapSchema = z.object({
  id: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  type: z.string(),
  source: z.string(),
  fromToken: z.string(),
  fromTokenSymbol: z.string(),
  fromAmount: z.number(),
  toToken: z.string(),
  toTokenSymbol: z.string(),
  toAmount: z.number(),
  fee: z.number().optional(),
  slot: z.number(),
  notificationSent: z.boolean().default(false),
});

export type Swap = z.infer<typeof swapSchema>;
export type InsertSwap = Omit<Swap, "id" | "notificationSent">;

// Notification settings schema
export const notificationSettingsSchema = z.object({
  email: z.string().email(),
  enabled: z.boolean().default(true),
  minSwapAmount: z.number().optional(),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

// Wallet monitoring status
export const monitoringStatusSchema = z.object({
  walletAddress: z.string(),
  isActive: z.boolean(),
  webhookId: z.string().optional(),
  lastUpdated: z.number(),
  totalSwapsDetected: z.number(),
});

export type MonitoringStatus = z.infer<typeof monitoringStatusSchema>;

// Helius webhook payload types
export interface HeliusWebhookPayload {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  slot: number;
  tokenTransfers?: {
    fromTokenAccount: string;
    toTokenAccount: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }[];
  nativeTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: {
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
    }[];
  }[];
  description?: string;
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: { userAccount: string; tokenAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
      tokenOutputs?: { userAccount: string; tokenAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
      innerSwaps?: any[];
    };
  };
}
