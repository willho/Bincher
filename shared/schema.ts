import { z } from "zod";
import { pgTable, text, boolean, integer, real, jsonb, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Token metadata schema (from DexScreener)
export const tokenMetadataSchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  priceUsd: z.number().optional(),
  marketCap: z.number().optional(),
  fdv: z.number().optional(),
  liquidity: z.number().optional(),
  volume24h: z.number().optional(),
  priceChange24h: z.number().optional(),
  dexId: z.string().optional(),
  pairAddress: z.string().optional(),
});

export type TokenMetadata = z.infer<typeof tokenMetadataSchema>;

// Database tables
export const swaps = pgTable("swaps", {
  id: serial("id").primaryKey(),
  signature: text("signature").notNull().unique(),
  timestamp: integer("timestamp").notNull(),
  type: text("type").notNull(),
  source: text("source").notNull(),
  fromToken: text("from_token").notNull(),
  fromTokenSymbol: text("from_token_symbol").notNull(),
  fromAmount: real("from_amount").notNull(),
  toToken: text("to_token").notNull(),
  toTokenSymbol: text("to_token_symbol").notNull(),
  toAmount: real("to_amount").notNull(),
  fee: real("fee"),
  slot: integer("slot").notNull(),
  notificationSent: boolean("notification_sent").default(false),
  toTokenMetadata: jsonb("to_token_metadata"),
});

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  emails: jsonb("emails").$type<string[]>().default([]),
  enabled: boolean("enabled").default(true),
  minSwapAmount: real("min_swap_amount"),
});

export const monitoringState = pgTable("monitoring_state", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  isActive: boolean("is_active").default(false),
  webhookId: text("webhook_id"),
  lastUpdated: integer("last_updated").notNull(),
  totalSwapsDetected: integer("total_swaps_detected").default(0),
});

// Insert schemas
export const insertSwapSchema = createInsertSchema(swaps).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export const insertMonitoringStateSchema = createInsertSchema(monitoringState).omit({ id: true });

// Types for API use
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
  toTokenMetadata: tokenMetadataSchema.optional(),
});

export type Swap = z.infer<typeof swapSchema>;
export type InsertSwap = Omit<Swap, "id" | "notificationSent">;

// Notification settings schema
export const notificationSettingsSchema = z.object({
  email: z.string().email(),
  emails: z.array(z.string().email()).default([]),
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
