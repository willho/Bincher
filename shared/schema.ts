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

// Users table for authentication
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").default(false),
  createdAt: integer("created_at").notNull(),
  lastLoginAt: integer("last_login_at"),
});

// Monitored wallets - multiple wallet addresses per user
export const monitoredWallets = pgTable("monitored_wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  label: text("label"),
  enabled: boolean("enabled").default(true),
  createdAt: integer("created_at").notNull(),
});

// Database tables
export const swaps = pgTable("swaps", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
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
  userId: integer("user_id"),
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
  userId: integer("user_id"),
  publicKey: text("public_key").notNull(),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Holdings - tokens owned by per-token disposable wallets from copy trades
export const holdings = pgTable("holdings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tokenMint: text("token_mint").notNull(),
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
  reclaimedMilestones: jsonb("reclaimed_milestones").$type<number[]>().default([]),
  dumpAlertSent: boolean("dump_alert_sent").default(false),
  tokenWalletPublicKey: text("token_wallet_public_key"),
  tokenWalletEncryptedKey: text("token_wallet_encrypted_key"),
});

// Pending buys - tokens queued for purchase with delay
// Status: active (waiting), paused (insufficient funds), cancelled (user cancelled), completed (buy executed)
// Split buys: When total > $400 USD, split into $350-400 segments with staggered timing
export const pendingBuys = pgTable("pending_buys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name"),
  detectedAt: integer("detected_at").notNull(),
  scheduledBuyAt: integer("scheduled_buy_at").notNull(),
  initialPrice: real("initial_price"),
  buyTriggered: boolean("buy_triggered").default(false),
  triggerReason: text("trigger_reason"),
  buyCount: integer("buy_count").default(0),
  initialBuyCount: integer("initial_buy_count").default(0),
  status: text("status").default("active"),
  pauseReason: text("pause_reason"),
  segmentIndex: integer("segment_index").default(1),
  totalSegments: integer("total_segments").default(1),
  parentBuyId: integer("parent_buy_id"),
  solAmount: real("sol_amount"),
  tokenWalletPublicKey: text("token_wallet_public_key"),
  tokenWalletEncryptedKey: text("token_wallet_encrypted_key"),
  snapshotId: integer("snapshot_id"),
  aiScore: integer("ai_score"),
});

// Trade config - settings for copy trading
export const tradeConfig = pgTable("trade_config", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  enabled: boolean("enabled").default(false),
  buyPercentage: real("buy_percentage").default(10),
  minDelayMinutes: integer("min_delay_minutes").default(20),
  maxDelayMinutes: integer("max_delay_minutes").default(40),
  highVolumeBuyCount: integer("high_volume_buy_count").default(10),
  priceRiseTriggerPercent: real("price_rise_trigger_percent").default(15),
  reclaimMultiplier: real("reclaim_multiplier").default(4),
  milestonesToAlert: jsonb("milestones_to_alert").$type<number[]>().default([2, 4, 10]),
  dumpAlertEnabled: boolean("dump_alert_enabled").default(true),
  dumpAlertThreshold: real("dump_alert_threshold").default(50),
  minBuyScore: integer("min_buy_score"),
});

// Token snapshots - SHARED across all users for AI learning
// Captures comprehensive data at queue time for AI analysis
export const tokenSnapshots = pgTable("token_snapshots", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  tokenName: text("token_name"),
  capturedAt: integer("captured_at").notNull(),
  
  // Market data
  priceUsd: real("price_usd"),
  marketCap: real("market_cap"),
  fdv: real("fdv"),
  liquidity: real("liquidity"),
  volume24h: real("volume_24h"),
  priceChange24h: real("price_change_24h"),
  
  // Token age and launch info
  pairCreatedAt: integer("pair_created_at"),
  tokenAgeMinutes: integer("token_age_minutes"),
  
  // Buy/sell pressure
  buys24h: integer("buys_24h"),
  sells24h: integer("sells_24h"),
  buyVolume24h: real("buy_volume_24h"),
  sellVolume24h: real("sell_volume_24h"),
  
  // Holder analysis
  holders: integer("holders"),
  topHolderPercent: real("top_holder_percent"),
  devWalletPercent: real("dev_wallet_percent"),
  
  // LP info
  lpBurned: boolean("lp_burned"),
  lpLockedPercent: real("lp_locked_percent"),
  
  // Source wallet analysis (who bought before us)
  sourceWallets: jsonb("source_wallets").$type<string[]>().default([]),
  knownWhalesBuying: integer("known_whales_buying").default(0),
  
  // Social presence
  hasTwitter: boolean("has_twitter").default(false),
  hasTelegram: boolean("has_telegram").default(false),
  hasWebsite: boolean("has_website").default(false),
  twitterHandle: text("twitter_handle"),
  socialSearchResult: text("social_search_result"),
  
  // AI analysis
  aiScore: integer("ai_score"),
  aiAnalysis: text("ai_analysis"),
  aiScoredAt: integer("ai_scored_at"),
  
  // Trade outcome tracking (updated after sells)
  finalMultiplier: real("final_multiplier"),
  holdTimeMinutes: integer("hold_time_minutes"),
  outcomeUpdatedAt: integer("outcome_updated_at"),
});

// AI chat messages - for conversational insights
export const aiChatMessages = pgTable("ai_chat_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Password reset tokens - time-limited, single-use tokens for secure password recovery
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  used: boolean("used").default(false),
  createdAt: integer("created_at").notNull(),
});

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertMonitoredWalletSchema = createInsertSchema(monitoredWallets).omit({ id: true });
export const insertSwapSchema = createInsertSchema(swaps).omit({ id: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export const insertMonitoringStateSchema = createInsertSchema(monitoringState).omit({ id: true });
export const insertHotWalletSchema = createInsertSchema(hotWallet).omit({ id: true });
export const insertHoldingSchema = createInsertSchema(holdings).omit({ id: true });
export const insertPendingBuySchema = createInsertSchema(pendingBuys).omit({ id: true });
export const insertTradeConfigSchema = createInsertSchema(tradeConfig).omit({ id: true });
export const insertTokenSnapshotSchema = createInsertSchema(tokenSnapshots).omit({ id: true });
export const insertAiChatMessageSchema = createInsertSchema(aiChatMessages).omit({ id: true });
export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({ id: true });

// User types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

// Monitored wallet types
export type MonitoredWallet = typeof monitoredWallets.$inferSelect;
export type InsertMonitoredWallet = z.infer<typeof insertMonitoredWalletSchema>;

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
  reclaimedMilestones: z.array(z.number()).default([]),
  dumpAlertSent: z.boolean().default(false),
  tokenWalletPublicKey: z.string().optional(),
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
  initialBuyCount: z.number().default(0),
  status: z.enum(["active", "paused", "cancelled", "completed"]).default("active"),
  pauseReason: z.string().optional(),
  segmentIndex: z.number().default(1),
  totalSegments: z.number().default(1),
  parentBuyId: z.number().optional(),
  solAmount: z.number().optional(),
  tokenWalletPublicKey: z.string().optional(),
  snapshotId: z.number().optional(),
  aiScore: z.number().optional(),
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
  dumpAlertEnabled: z.boolean().default(true),
  dumpAlertThreshold: z.number().default(50),
  minBuyScore: z.number().optional(),
});

export type TradeConfig = z.infer<typeof tradeConfigSchema>;

// Token snapshot schema for AI analysis
export const tokenSnapshotSchema = z.object({
  id: z.number(),
  tokenMint: z.string(),
  tokenSymbol: z.string(),
  tokenName: z.string().optional(),
  capturedAt: z.number(),
  priceUsd: z.number().optional(),
  marketCap: z.number().optional(),
  fdv: z.number().optional(),
  liquidity: z.number().optional(),
  volume24h: z.number().optional(),
  priceChange24h: z.number().optional(),
  pairCreatedAt: z.number().optional(),
  tokenAgeMinutes: z.number().optional(),
  buys24h: z.number().optional(),
  sells24h: z.number().optional(),
  buyVolume24h: z.number().optional(),
  sellVolume24h: z.number().optional(),
  holders: z.number().optional(),
  topHolderPercent: z.number().optional(),
  devWalletPercent: z.number().optional(),
  lpBurned: z.boolean().optional(),
  lpLockedPercent: z.number().optional(),
  sourceWallets: z.array(z.string()).default([]),
  knownWhalesBuying: z.number().default(0),
  hasTwitter: z.boolean().default(false),
  hasTelegram: z.boolean().default(false),
  hasWebsite: z.boolean().default(false),
  twitterHandle: z.string().optional(),
  socialSearchResult: z.string().optional(),
  aiScore: z.number().optional(),
  aiAnalysis: z.string().optional(),
  aiScoredAt: z.number().optional(),
  finalMultiplier: z.number().optional(),
  holdTimeMinutes: z.number().optional(),
  outcomeUpdatedAt: z.number().optional(),
});

export type TokenSnapshot = z.infer<typeof tokenSnapshotSchema>;
export type InsertTokenSnapshot = z.infer<typeof insertTokenSnapshotSchema>;

// AI chat message schema
export const aiChatMessageSchema = z.object({
  id: z.number(),
  userId: z.number(),
  role: z.string(),
  content: z.string(),
  createdAt: z.number(),
});

export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;
export type InsertAiChatMessage = z.infer<typeof insertAiChatMessageSchema>;

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
