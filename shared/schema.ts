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

// Copy Trading Tables

// Hot wallet for automated trading (encrypted private key stored securely)
export const hotWallet = pgTable("hot_wallet", {
  id: serial("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Holdings - tokens owned by the hot wallet from copy trades
export const holdings = pgTable("holdings", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull().unique(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name"),
  amountBought: real("amount_bought").notNull(),
  solSpent: real("sol_spent").notNull(),
  buyPrice: real("buy_price").notNull(),
  buyTimestamp: integer("buy_timestamp").notNull(),
  buySignature: text("buy_signature").notNull(),
  currentAmount: real("current_amount").notNull(),
  reclaimed: boolean("reclaimed").default(false),
  reclaimTimestamp: integer("reclaim_timestamp"),
  reclaimSignature: text("reclaim_signature"),
  lastPriceCheck: integer("last_price_check"),
  lastPrice: real("last_price"),
  highestMultiplier: real("highest_multiplier").default(1),
  alertedMilestones: jsonb("alerted_milestones").$type<number[]>().default([]),
});

// Pending buys - tokens queued for purchase with delay
export const pendingBuys = pgTable("pending_buys", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull().unique(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name"),
  detectedAt: integer("detected_at").notNull(),
  scheduledBuyAt: integer("scheduled_buy_at").notNull(),
  initialPrice: real("initial_price"),
  buyTriggered: boolean("buy_triggered").default(false),
  triggerReason: text("trigger_reason"),
  buyCount: integer("buy_count").default(0),
  cancelled: boolean("cancelled").default(false),
});

// Trade config - settings for copy trading
export const tradeConfig = pgTable("trade_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").default(false),
  buyPercentage: real("buy_percentage").default(10),
  minDelayMinutes: integer("min_delay_minutes").default(20),
  maxDelayMinutes: integer("max_delay_minutes").default(40),
  highVolumeBuyCount: integer("high_volume_buy_count").default(10),
  priceRiseTriggerPercent: real("price_rise_trigger_percent").default(15),
  reclaimMultiplier: real("reclaim_multiplier").default(4),
  milestonesToAlert: jsonb("milestones_to_alert").$type<number[]>().default([2, 4, 10]),
});

// Insert schemas
export const insertSwapSchema = createInsertSchema(swaps).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export const insertMonitoringStateSchema = createInsertSchema(monitoringState).omit({ id: true });
export const insertHotWalletSchema = createInsertSchema(hotWallet).omit({ id: true });
export const insertHoldingSchema = createInsertSchema(holdings).omit({ id: true });
export const insertPendingBuySchema = createInsertSchema(pendingBuys).omit({ id: true });
export const insertTradeConfigSchema = createInsertSchema(tradeConfig).omit({ id: true });

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

// Copy Trading Types
export const hotWalletSchema = z.object({
  id: z.number(),
  publicKey: z.string(),
  createdAt: z.number(),
});

export type HotWallet = z.infer<typeof hotWalletSchema>;

export const holdingSchema = z.object({
  id: z.number(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  amountBought: z.number(),
  solSpent: z.number(),
  buyPrice: z.number(),
  buyTimestamp: z.number(),
  buySignature: z.string(),
  currentAmount: z.number(),
  reclaimed: z.boolean().default(false),
  reclaimTimestamp: z.number().optional(),
  reclaimSignature: z.string().optional(),
  lastPriceCheck: z.number().optional(),
  lastPrice: z.number().optional(),
  highestMultiplier: z.number().default(1),
  alertedMilestones: z.array(z.number()).default([]),
});

export type Holding = z.infer<typeof holdingSchema>;

export const pendingBuySchema = z.object({
  id: z.number(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  detectedAt: z.number(),
  scheduledBuyAt: z.number(),
  initialPrice: z.number().optional(),
  buyTriggered: z.boolean().default(false),
  triggerReason: z.string().optional(),
  buyCount: z.number().default(0),
  cancelled: z.boolean().default(false),
});

export type PendingBuy = z.infer<typeof pendingBuySchema>;

export const tradeConfigSchema = z.object({
  id: z.number(),
  enabled: z.boolean().default(false),
  buyPercentage: z.number().default(10),
  minDelayMinutes: z.number().default(20),
  maxDelayMinutes: z.number().default(40),
  highVolumeBuyCount: z.number().default(10),
  priceRiseTriggerPercent: z.number().default(15),
  reclaimMultiplier: z.number().default(4),
  milestonesToAlert: z.array(z.number()).default([2, 4, 10]),
});

export type TradeConfig = z.infer<typeof tradeConfigSchema>;

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
