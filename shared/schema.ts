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
  // Default cashout wallet for withdrawals
  defaultCashoutWallet: text("default_cashout_wallet"),
  // Telegram integration
  telegramChatId: text("telegram_chat_id"),
  telegramLinkToken: text("telegram_link_token"),
  telegramLinkedAt: integer("telegram_linked_at"),
});

// Monitored wallets - multiple wallet addresses per user
export const monitoredWallets = pgTable("monitored_wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  walletAddress: text("wallet_address").notNull(),
  label: text("label"),
  enabled: boolean("enabled").default(true),
  createdAt: integer("created_at").notNull(),
  // Copy trading - whether to auto-copy this wallet's trades
  copyTradeEnabled: boolean("copy_trade_enabled").default(false),
  // Community sharing fields
  isShared: boolean("is_shared").default(false),
  shareStatus: text("share_status").default("none"), // none, pending, approved, rejected
  aiScore: integer("ai_score"), // 0-100 score from AI analysis
  aiScoreDetails: text("ai_score_details"), // JSON with hit rate, avg multiplier, risk, etc.
  aiScoreUpdatedAt: integer("ai_score_updated_at"),
  
  // Per-wallet copy config (Phase 8)
  copyBuyType: text("copy_buy_type").default("percentage"), // "fixed_sol" | "fixed_usd" | "percentage"
  copyBuyAmount: real("copy_buy_amount").default(10), // Amount based on type
  copyMinBalance: real("copy_min_balance"), // Skip if hot wallet below this SOL
  copyMinTradeUsd: real("copy_min_trade_usd"), // Only copy trades over this USD value
  copyScoreThreshold: integer("copy_score_threshold"), // Only copy tokens above this AI score
  copyTiming: text("copy_timing").default("immediate"), // "immediate" | "delayed" | "triggered"
  copyDelayMinutes: integer("copy_delay_minutes"), // Delay before copying (if delayed)
  copyAutoMirror: boolean("copy_auto_mirror").default(false), // Mirror additional buys/sells
  
  // Deduplication options
  dedupSkipIfHolding: boolean("dedup_skip_if_holding").default(true), // Skip if already holding
  dedupSkipIfEverHeld: boolean("dedup_skip_if_ever_held").default(false), // Skip if ever held
  dedupSkipIfPending: boolean("dedup_skip_if_pending").default(true), // Skip if already pending
});

// Signal wallet profiles - track trading patterns for each wallet
export const signalWalletProfiles = pgTable("signal_wallet_profiles", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  
  // Aggregated trading style metrics
  avgEntryMcap: real("avg_entry_mcap"), // Average market cap at entry
  medianHoldTimeMinutes: integer("median_hold_time_minutes"),
  avgExitMultiplier: real("avg_exit_multiplier"), // Average exit multiplier
  maxExitMultiplier: real("max_exit_multiplier"), // Best exit
  minExitMultiplier: real("min_exit_multiplier"), // Worst exit
  
  // Win/loss tracking
  totalTrades: integer("total_trades").default(0),
  winningTrades: integer("winning_trades").default(0), // Exits > 1x
  ruggedTrades: integer("rugged_trades").default(0), // Exits < 0.1x
  winRate: real("win_rate"), // Calculated: winning/total
  rugRate: real("rug_rate"), // Calculated: rugged/total
  
  // Style classification
  tradingStyle: text("trading_style"), // "insider" | "degen" | "quality" | "whale" | "unknown"
  styleConfidence: real("style_confidence"), // 0-1 confidence in classification
  
  // Recent performance (rolling 30 days)
  recentWinRate: real("recent_win_rate"),
  recentAvgMultiplier: real("recent_avg_multiplier"),
  
  // Timestamps
  firstSeenAt: integer("first_seen_at"),
  lastTradeAt: integer("last_trade_at"),
  updatedAt: integer("updated_at").notNull(),
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
  sourceSwapId: integer("source_swap_id"),
  sourceWalletAddress: text("source_wallet_address"),
  sourceWalletLabel: text("source_wallet_label"),
  sourceWalletBuyCount: integer("source_wallet_buy_count"),
  sourceWalletSellCount: integer("source_wallet_sell_count"),
  sourceWalletMaxHeldPct: real("source_wallet_max_held_pct"),
  sourceWalletCurrentPct: real("source_wallet_current_pct"),
  isDead: boolean("is_dead").default(false),
  isDust: boolean("is_dust").default(false),
  
  // Position tracking - supports top-ups and aggregation
  totalBuys: integer("total_buys").default(1), // Number of buys in this position
  avgEntryPrice: real("avg_entry_price"), // Weighted average entry price (updated on top-ups)
  totalTokensBought: real("total_tokens_bought"), // Cumulative tokens bought (including partial sells)
  totalSolInvested: real("total_sol_invested"), // Cumulative SOL invested (including top-ups)
  lastTopUpTimestamp: integer("last_top_up_timestamp"), // When position was last topped up
  
  // Position config (Phase 8) - per-position risk management
  takeProfitThresholds: jsonb("take_profit_thresholds").$type<number[]>(), // Custom milestones [4, 10, 25, 100]
  takeProfitPercentages: jsonb("take_profit_percentages").$type<number[]>(), // Percent to sell at each threshold [25, 25, 25, 25]
  stopLossPercent: real("stop_loss_percent"), // Sell if price drops by this %
  stopLossFloorUsd: real("stop_loss_floor_usd"), // Sell if value drops below this $
  stopLossTriggered: boolean("stop_loss_triggered").default(false), // True if stop-loss was executed
  stopLossTimestamp: integer("stop_loss_timestamp"), // Unix timestamp when stop-loss was triggered
  stopLossSignature: text("stop_loss_signature"), // Transaction signature of stop-loss sell
  autoMirrorSells: boolean("auto_mirror_sells").default(false), // Mirror signal wallet sells
  positionSource: text("position_source").default("copy"), // "copy" | "manual" | "autonomous" | "swing"
  signalWalletId: integer("signal_wallet_id"), // Reference to monitored wallet that signaled
  signalBuyAmountTokens: real("signal_buy_amount_tokens"), // Original tokens signal wallet bought (for proportional mirroring)
  entryReason: text("entry_reason"), // AI-generated or user note about why position was taken
  
  // Position scoring - dynamic score based on multiple factors
  positionScore: integer("position_score"), // Current score 0-100
  positionScoreTier: text("position_score_tier"), // "strong" | "neutral" | "weak"
  scoreLastUpdated: integer("score_last_updated"), // Unix timestamp of last score update
  scoreFactors: jsonb("score_factors").$type<{
    priceChange: number; // -100 to 100 based on % from entry
    timeDecay: number; // 0 to -50 based on hold time without movement
    whaleActivity: number; // -50 to +50 based on recent whale moves
    signalWalletStatus: number; // -50 to +50 based on signal wallet still holding or sold
    volumeTrend: number; // -25 to +25 based on volume changes
  }>(), // Breakdown of score factors
  signalWalletSold: boolean("signal_wallet_sold").default(false), // True if signal wallet has exited
  signalWalletSoldAt: integer("signal_wallet_sold_at"), // Unix timestamp when signal wallet sold
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
  sourceSwapId: integer("source_swap_id"),
  sourceWalletAddress: text("source_wallet_address"),
  sourceWalletLabel: text("source_wallet_label"),
  signalWalletId: integer("signal_wallet_id"), // Reference to monitored wallet for copy trades
  signalBuyAmountTokens: real("signal_buy_amount_tokens"), // Original tokens signal wallet bought (for proportional mirroring)
  copyTiming: text("copy_timing").default("delayed"), // "immediate" | "delayed" | "triggered" - controls execution behavior
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
  progressiveTakeProfitThresholds: jsonb("progressive_tp_thresholds").$type<number[]>().default([10, 100, 1000, 10000]), // Multipliers to trigger progressive sells
  progressiveTakeProfitPercents: jsonb("progressive_tp_percents").$type<number[]>().default([10, 10, 10, 10]), // Percent to sell at each threshold
  milestonesToAlert: jsonb("milestones_to_alert").$type<number[]>().default([2, 4, 10]),
  dumpAlertEnabled: boolean("dump_alert_enabled").default(true),
  dumpAlertThreshold: real("dump_alert_threshold").default(50),
  minBuyScore: integer("min_buy_score"),
  
  // Stop-loss defaults (Phase 8)
  stopLossPercent: real("stop_loss_percent"), // Default stop-loss % for new positions
  stopLossFloorUsd: real("stop_loss_floor_usd"), // Default floor value to bypass stop-loss
  
  // Trading budget limits (Phase 8)
  maxTradeUsd: real("max_trade_usd"), // Max per trade in USD
  maxDailySpendUsd: real("max_daily_spend_usd"), // Max daily spend in USD
  minReserveSol: real("min_reserve_sol"), // Keep at least this SOL in hot wallet
  dailySpentUsd: real("daily_spent_usd").default(0), // Track daily spend
  dailySpentResetAt: integer("daily_spent_reset_at"), // When to reset daily spend
});

// Autonomous mode settings - per-user AI trading configuration
export const autonomousSettings = pgTable("autonomous_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  
  // Mode toggle
  enabled: boolean("enabled").default(false),
  enabledAt: integer("enabled_at"),
  
  // Risk profile
  riskProfile: text("risk_profile").default("balanced"), // "conservative" | "balanced" | "aggressive" | "custom"
  
  // Position limits
  maxOpenPositions: integer("max_open_positions").default(5),
  maxPositionSizeUsd: real("max_position_size_usd").default(50),
  minTokenScore: integer("min_token_score").default(70), // Minimum AI score to enter
  
  // Entry filters
  allowedSources: jsonb("allowed_sources").$type<string[]>().default(["copy"]), // "copy" | "discovery" | "swing"
  preferredWallets: jsonb("preferred_wallets").$type<number[]>(), // Only use these signal wallet IDs
  minMcap: real("min_mcap"), // Minimum market cap
  maxMcap: real("max_mcap"), // Maximum market cap
  minLiquidity: real("min_liquidity"), // Minimum liquidity
  
  // Exit rules
  defaultTakeProfit: jsonb("default_take_profit").$type<number[]>().default([4, 10, 25]),
  defaultStopLoss: real("default_stop_loss").default(50), // Sell if down 50%
  
  // Auto-stop conditions
  stopOnDailyLossUsd: real("stop_on_daily_loss_usd"), // Stop if daily loss exceeds
  stopOnDrawdownPercent: real("stop_on_drawdown_percent"), // Stop if portfolio drops by %
  stopOnWinTargetUsd: real("stop_on_win_target_usd"), // Stop after hitting profit target
  stopOnLossStreak: integer("stop_on_loss_streak"), // Stop after N consecutive losses
  stopOnTradeCount: integer("stop_on_trade_count"), // Max trades per day
  stopOnMinBalanceSol: real("stop_on_min_balance_sol"), // Kill switch: stop if balance below
  
  // Current state
  todayLossUsd: real("today_loss_usd").default(0),
  todayWinUsd: real("today_win_usd").default(0),
  todayTradeCount: integer("today_trade_count").default(0),
  consecutiveLosses: integer("consecutive_losses").default(0),
  peakBalanceSol: real("peak_balance_sol"),
  stateResetAt: integer("state_reset_at"),
  
  // Auto-stop triggered
  stoppedReason: text("stopped_reason"), // Why auto-stop triggered
  stoppedAt: integer("stopped_at"),
  
  // User acknowledgment
  warningAcknowledged: boolean("warning_acknowledged").default(false),
  acknowledgedAt: integer("acknowledged_at"),
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Swing trade settings - per-user swing trading configuration
export const swingTradeSettings = pgTable("swing_trade_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  
  // Enable/disable swing trading
  enabled: boolean("enabled").default(false),
  
  // Pattern detection preferences
  detectSupportResistance: boolean("detect_support_resistance").default(true),
  detectVolumeSpikes: boolean("detect_volume_spikes").default(true),
  detectOhlcPatterns: boolean("detect_ohlc_patterns").default(true),
  detectConsolidation: boolean("detect_consolidation").default(true),
  detectBreakouts: boolean("detect_breakout").default(true),
  
  // Entry triggers
  minSupportBounces: integer("min_support_bounces").default(3), // How many times price touched support
  breakoutVolumeFactor: real("breakout_volume_factor").default(2), // Volume multiplier for breakout
  consolidationMinHours: integer("consolidation_min_hours").default(4), // Min time in range
  
  // Position sizing
  swingPositionSizeUsd: real("swing_position_size_usd").default(25),
  maxSwingPositions: integer("max_swing_positions").default(3),
  
  // Exit strategy
  resistanceTakeProfit: boolean("resistance_take_profit").default(true), // Sell at resistance
  trailingStopPercent: real("trailing_stop_percent"), // Trailing stop loss
  timeLimitHours: integer("time_limit_hours"), // Max hold time
  
  // Filters
  minTokenScore: integer("min_token_score").default(60), // Only swing tokens above this score
  minLiquidity: real("min_liquidity").default(50000), // Min liquidity in USD
  minMcap: real("min_mcap").default(100000), // Min market cap
  maxMcap: real("max_mcap").default(10000000), // Max market cap
  
  // Automation level
  autoEntry: boolean("auto_entry").default(false), // Auto-enter swing positions
  autoExit: boolean("auto_exit").default(true), // Auto-exit at targets
  alertOnly: boolean("alert_only").default(true), // Just alert, don't trade
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
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
  topHolders: jsonb("top_holders").$type<{ address: string; percent: number; isLP?: boolean }[]>(),
  
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

// Price aggregates - OHLC+ data with tiered retention for pattern analysis
// Tiers: 15min, hourly, daily, weekly - older data gets rolled up
export const priceAggregates = pgTable("price_aggregates", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  tier: text("tier").notNull(), // "15min" | "hourly" | "daily" | "weekly"
  bucketStart: integer("bucket_start").notNull(), // Unix timestamp for bucket start
  
  // Price OHLC
  priceOpen: real("price_open"),
  priceHigh: real("price_high"),
  priceLow: real("price_low"),
  priceClose: real("price_close"),
  
  // Liquidity at start/end of bucket
  lpOpen: real("lp_open"),
  lpClose: real("lp_close"),
  
  // Volume and transactions (summed over bucket)
  volume: real("volume"),
  buys: integer("buys"),
  sells: integer("sells"),
  
  // Market metrics (snapshot at bucket close)
  marketCap: real("market_cap"),
  fdv: real("fdv"),
  
  // Holder count (last known value in bucket)
  holderCount: integer("holder_count"),
  
  // Metadata
  createdAt: integer("created_at").notNull(),
});

// AI chat messages - for conversational insights
export const aiChatMessages = pgTable("ai_chat_messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  channel: text("channel").default("web"),
  createdAt: integer("created_at").notNull(),
});

export const cachedAlerts = pgTable("cached_alerts", {
  id: serial("id").primaryKey(),
  alertType: text("alert_type").notNull(),
  eventKey: text("event_key").notNull(),
  webMessage: text("web_message").notNull(),
  telegramMessage: text("telegram_message").notNull(),
  tokenMint: text("token_mint"),
  tokenSymbol: text("token_symbol"),
  metadata: text("metadata"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const adminSettings = pgTable("admin_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: integer("updated_by"),
});

// Community insights - anonymous token opinions shared across users with consent
export const communityInsights = pgTable("community_insights", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  // Vague sentiment summary - no identifying details
  sentiment: text("sentiment").notNull(), // e.g., "bullish", "bearish", "cautious"
  summary: text("summary").notNull(), // Anonymized insight text
  // Consent and source tracking (user ID never exposed in retrieval)
  sourceUserId: integer("source_user_id").notNull(),
  consentedAt: integer("consented_at").notNull(),
  // Quality/credibility indicators (no user-identifying details)
  sourceCredibility: text("source_credibility"), // "new_trader", "experienced", "successful_track_record"
  // Price tracking - to compare insight against token performance
  priceAtShare: real("price_at_share"), // USD price when insight was shared
  // Lifecycle
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"), // Insights can expire to stay fresh
  isActive: boolean("is_active").default(true),
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
export const insertPriceAggregateSchema = createInsertSchema(priceAggregates).omit({ id: true });
export const insertAiChatMessageSchema = createInsertSchema(aiChatMessages).omit({ id: true });
export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({ id: true });
export const insertCommunityInsightSchema = createInsertSchema(communityInsights).omit({ id: true });
export const insertSignalWalletProfileSchema = createInsertSchema(signalWalletProfiles).omit({ id: true });
export const insertAutonomousSettingsSchema = createInsertSchema(autonomousSettings).omit({ id: true });
export const insertSwingTradeSettingsSchema = createInsertSchema(swingTradeSettings).omit({ id: true });

// Price aggregate types
export type PriceAggregate = typeof priceAggregates.$inferSelect;
export type InsertPriceAggregate = z.infer<typeof insertPriceAggregateSchema>;
export type AggregateTier = "15min" | "hourly" | "daily" | "weekly";

// User types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

// Monitored wallet types
export type MonitoredWallet = typeof monitoredWallets.$inferSelect;
export type InsertMonitoredWallet = z.infer<typeof insertMonitoredWalletSchema>;

// Signal wallet profile types
export type SignalWalletProfile = typeof signalWalletProfiles.$inferSelect;
export type InsertSignalWalletProfile = z.infer<typeof insertSignalWalletProfileSchema>;

// Autonomous settings types
export type AutonomousSettings = typeof autonomousSettings.$inferSelect;
export type InsertAutonomousSettings = z.infer<typeof insertAutonomousSettingsSchema>;

// Swing trade settings types
export type SwingTradeSettings = typeof swingTradeSettings.$inferSelect;
export type InsertSwingTradeSettings = z.infer<typeof insertSwingTradeSettingsSchema>;

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
  sourceSwapId: z.number().optional(),
  sourceWalletAddress: z.string().optional(),
  sourceWalletLabel: z.string().optional(),
  sourceWalletBuyCount: z.number().optional(),
  sourceWalletSellCount: z.number().optional(),
  sourceWalletMaxHeldPct: z.number().optional(),
  sourceWalletCurrentPct: z.number().optional(),
  isDead: z.boolean().default(false),
  isDust: z.boolean().default(false),
  // Position config (Phase 8)
  takeProfitThresholds: z.array(z.number()).optional(),
  takeProfitPercentages: z.array(z.number()).optional(),
  stopLossPercent: z.number().optional(),
  stopLossFloorUsd: z.number().optional(),
  autoMirrorSells: z.boolean().default(false),
  positionSource: z.string().default("copy"),
  signalWalletId: z.number().optional(),
  entryReason: z.string().optional(),
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
  sourceSwapId: z.number().optional(),
  sourceWalletAddress: z.string().optional(),
  sourceWalletLabel: z.string().optional(),
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
  progressiveTakeProfitThresholds: z.array(z.number()).default([10, 100, 1000, 10000]),
  progressiveTakeProfitPercents: z.array(z.number()).default([10, 10, 10, 10]),
  milestonesToAlert: z.array(z.number()).default([2, 4, 10]),
  dumpAlertEnabled: z.boolean().default(true),
  dumpAlertThreshold: z.number().default(50),
  minBuyScore: z.number().optional(),
  // Trading budget limits (Phase 8)
  maxTradeUsd: z.number().optional(),
  maxDailySpendUsd: z.number().optional(),
  minReserveSol: z.number().optional(),
  dailySpentUsd: z.number().default(0),
  dailySpentResetAt: z.number().optional(),
});

export type TradeConfig = z.infer<typeof tradeConfigSchema>;

// Signal wallet profile schema for API use
export const signalWalletProfileSchema = z.object({
  id: z.number(),
  walletAddress: z.string(),
  avgEntryMcap: z.number().optional(),
  medianHoldTimeMinutes: z.number().optional(),
  avgExitMultiplier: z.number().optional(),
  maxExitMultiplier: z.number().optional(),
  minExitMultiplier: z.number().optional(),
  totalTrades: z.number().default(0),
  winningTrades: z.number().default(0),
  ruggedTrades: z.number().default(0),
  winRate: z.number().optional(),
  rugRate: z.number().optional(),
  tradingStyle: z.string().optional(),
  styleConfidence: z.number().optional(),
  recentWinRate: z.number().optional(),
  recentAvgMultiplier: z.number().optional(),
  firstSeenAt: z.number().optional(),
  lastTradeAt: z.number().optional(),
  updatedAt: z.number(),
});

// Autonomous settings schema for API use
export const autonomousSettingsSchema = z.object({
  id: z.number(),
  userId: z.number(),
  enabled: z.boolean().default(false),
  enabledAt: z.number().optional(),
  riskProfile: z.string().default("balanced"),
  maxOpenPositions: z.number().default(5),
  maxPositionSizeUsd: z.number().default(50),
  minTokenScore: z.number().default(70),
  allowedSources: z.array(z.string()).default(["copy"]),
  preferredWallets: z.array(z.number()).optional(),
  minMcap: z.number().optional(),
  maxMcap: z.number().optional(),
  minLiquidity: z.number().optional(),
  defaultTakeProfit: z.array(z.number()).default([4, 10, 25]),
  defaultStopLoss: z.number().default(50),
  stopOnDailyLossUsd: z.number().optional(),
  stopOnDrawdownPercent: z.number().optional(),
  stopOnWinTargetUsd: z.number().optional(),
  stopOnLossStreak: z.number().optional(),
  stopOnTradeCount: z.number().optional(),
  stopOnMinBalanceSol: z.number().optional(),
  todayLossUsd: z.number().default(0),
  todayWinUsd: z.number().default(0),
  todayTradeCount: z.number().default(0),
  consecutiveLosses: z.number().default(0),
  peakBalanceSol: z.number().optional(),
  stateResetAt: z.number().optional(),
  stoppedReason: z.string().optional(),
  stoppedAt: z.number().optional(),
  warningAcknowledged: z.boolean().default(false),
  acknowledgedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// Swing trade settings schema for API use
export const swingTradeSettingsSchema = z.object({
  id: z.number(),
  userId: z.number(),
  enabled: z.boolean().default(false),
  detectSupportResistance: z.boolean().default(true),
  detectVolumeSpikes: z.boolean().default(true),
  detectOhlcPatterns: z.boolean().default(true),
  detectConsolidation: z.boolean().default(true),
  detectBreakouts: z.boolean().default(true),
  minSupportBounces: z.number().default(3),
  breakoutVolumeFactor: z.number().default(2),
  consolidationMinHours: z.number().default(4),
  swingPositionSizeUsd: z.number().default(25),
  maxSwingPositions: z.number().default(3),
  resistanceTakeProfit: z.boolean().default(true),
  trailingStopPercent: z.number().optional(),
  timeLimitHours: z.number().optional(),
  minTokenScore: z.number().default(60),
  minLiquidity: z.number().default(50000),
  minMcap: z.number().default(100000),
  maxMcap: z.number().default(10000000),
  autoEntry: z.boolean().default(false),
  autoExit: z.boolean().default(true),
  alertOnly: z.boolean().default(true),
  createdAt: z.number(),
  updatedAt: z.number(),
});

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

// Community insights types
export type CommunityInsight = typeof communityInsights.$inferSelect;
export type InsertCommunityInsight = z.infer<typeof insertCommunityInsightSchema>;

// Admin messages table for announcements/alerts to users
export const adminMessages = pgTable("admin_messages", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  priority: text("priority").default("normal"),
  targetUserId: integer("target_user_id"),
  createdBy: integer("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
});

export const insertAdminMessageSchema = createInsertSchema(adminMessages).omit({
  id: true,
});

export const adminMessageSchema = z.object({
  id: z.number(),
  title: z.string(),
  content: z.string(),
  priority: z.string().default("normal"),
  targetUserId: z.number().optional().nullable(),
  createdBy: z.number(),
  createdAt: z.number(),
  expiresAt: z.number().optional().nullable(),
});

export type AdminMessage = z.infer<typeof adminMessageSchema>;
export type InsertAdminMessage = z.infer<typeof insertAdminMessageSchema>;

// Message read status tracking
export const messageReadStatus = pgTable("message_read_status", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  userId: integer("user_id").notNull(),
  readAt: integer("read_at").notNull(),
});

export const insertMessageReadStatusSchema = createInsertSchema(messageReadStatus).omit({
  id: true,
});

export type MessageReadStatus = typeof messageReadStatus.$inferSelect;
export type InsertMessageReadStatus = z.infer<typeof insertMessageReadStatusSchema>;

// Token events table - shared across all users for activity tracking
export const tokenEvents = pgTable("token_events", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  eventType: text("event_type").notNull(), // price_swing, milestone, lp_change, whale_move, holder_change
  priority: text("priority").default("normal"), // low, normal, high, critical
  title: text("title").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull(),
  priceAtEvent: real("price_at_event"),
  valueUsd: real("value_usd"),
  relatedWallet: text("related_wallet"),
});

export const insertTokenEventSchema = createInsertSchema(tokenEvents).omit({ id: true });
export type TokenEvent = typeof tokenEvents.$inferSelect;
export type InsertTokenEvent = z.infer<typeof insertTokenEventSchema>;

// User event preferences - per-user filtering and summary settings
export const userEventPreferences = pgTable("user_event_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  minValueThreshold: real("min_value_threshold").default(0),
  mutedTokens: jsonb("muted_tokens").$type<string[]>().default([]),
  focusWallets: jsonb("focus_wallets").$type<string[]>().default([]),
  summaryFocus: text("summary_focus"), // free-text for Pincher summary customization
  pinchEmailsEnabled: boolean("pinch_emails_enabled").default(true),
  lastSummaryAt: integer("last_summary_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const insertUserEventPreferencesSchema = createInsertSchema(userEventPreferences).omit({ id: true });
export type UserEventPreferences = typeof userEventPreferences.$inferSelect;
export type InsertUserEventPreferences = z.infer<typeof insertUserEventPreferencesSchema>;

// System logs - comprehensive logging for production debugging
export const systemLogs = pgTable("system_logs", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(), // telegram, helius, openai, jupiter, resend, etc.
  action: text("action").notNull(), // send_message, api_call, webhook_receive, etc.
  status: text("status").notNull(), // success, error, warning, info
  latencyMs: integer("latency_ms"), // time taken for operation
  errorMessage: text("error_message"), // error details if status=error
  errorStack: text("error_stack"), // stack trace for debugging
  context: jsonb("context").$type<Record<string, any>>(), // additional context data
  userId: integer("user_id"), // related user if applicable
  createdAt: integer("created_at").notNull(),
});

export const insertSystemLogSchema = createInsertSchema(systemLogs).omit({ id: true });
export type SystemLog = typeof systemLogs.$inferSelect;
export type InsertSystemLog = z.infer<typeof insertSystemLogSchema>;

// Link tokens for Telegram deep link account linking (10-minute expiry)
export const linkTokens = pgTable("link_tokens", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const insertLinkTokenSchema = createInsertSchema(linkTokens).omit({ id: true });
export type LinkToken = typeof linkTokens.$inferSelect;
export type InsertLinkToken = z.infer<typeof insertLinkTokenSchema>;

// AI prediction tracking - Miss Pincher's self-accuracy monitoring
export const aiPredictions = pgTable("ai_predictions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  snapshotId: integer("snapshot_id"),
  
  // Prediction data
  predictedScore: integer("predicted_score").notNull(), // 0-100 score at time of prediction
  predictedOutcome: text("predicted_outcome").notNull(), // "bullish" | "bearish" | "neutral"
  confidenceLevel: real("confidence_level").default(0.5), // 0-1 how confident was the prediction
  reasoning: text("reasoning"), // Why this prediction was made
  redFlags: jsonb("red_flags").$type<string[]>(),
  greenFlags: jsonb("green_flags").$type<string[]>(),
  
  // Outcome data (filled in after resolution)
  actualOutcome: text("actual_outcome"), // "win" | "loss" | "breakeven"
  priceAtPrediction: real("price_at_prediction"),
  priceAtResolution: real("price_at_resolution"),
  outcomeMultiplier: real("outcome_multiplier"), // actual price change multiplier
  holdTimeMinutes: integer("hold_time_minutes"),
  wasAccurate: boolean("was_accurate"), // true if prediction matched outcome
  
  // Timing
  predictedAt: integer("predicted_at").notNull(),
  resolvedAt: integer("resolved_at"),
  
  // Context for learning
  priceContextAt: jsonb("price_context_at").$type<{
    marketCap?: number;
    liquidity?: number;
    volume24h?: number;
    heatScore?: number;
    whaleActivity?: boolean;
  }>(),
});

export const insertAiPredictionSchema = createInsertSchema(aiPredictions).omit({ id: true });
export type AiPrediction = typeof aiPredictions.$inferSelect;
export type InsertAiPrediction = z.infer<typeof insertAiPredictionSchema>;

// AI accuracy stats - aggregated accuracy metrics
export const aiAccuracyStats = pgTable("ai_accuracy_stats", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  
  // Overall stats
  totalPredictions: integer("total_predictions").default(0),
  resolvedPredictions: integer("resolved_predictions").default(0),
  accuratePredictions: integer("accurate_predictions").default(0),
  overallHitRate: real("overall_hit_rate"), // 0-1
  
  // By outcome type
  bullishPredictions: integer("bullish_predictions").default(0),
  bullishAccurate: integer("bullish_accurate").default(0),
  bearishPredictions: integer("bearish_predictions").default(0),
  bearishAccurate: integer("bearish_accurate").default(0),
  
  // Performance metrics
  avgMultiplierOnWins: real("avg_multiplier_on_wins"),
  avgMultiplierOnLosses: real("avg_multiplier_on_losses"),
  avgConfidence: real("avg_confidence"),
  
  // Time-based tracking
  last7dHitRate: real("last_7d_hit_rate"),
  last30dHitRate: real("last_30d_hit_rate"),
  
  // Confidence calibration
  highConfidenceHitRate: real("high_confidence_hit_rate"), // predictions with confidence > 0.7
  lowConfidenceHitRate: real("low_confidence_hit_rate"), // predictions with confidence < 0.4
  
  lastUpdated: integer("last_updated").notNull(),
});

export const insertAiAccuracyStatsSchema = createInsertSchema(aiAccuracyStats).omit({ id: true });
export type AiAccuracyStats = typeof aiAccuracyStats.$inferSelect;
export type InsertAiAccuracyStats = z.infer<typeof insertAiAccuracyStatsSchema>;

// Pattern triggers - Pincher learns patterns and correlates to outcomes
export const patternTriggers = pgTable("pattern_triggers", {
  id: serial("id").primaryKey(),
  patternType: text("pattern_type").notNull(), // whale_entry, holder_spike, volume_surge, etc.
  tokenMint: text("token_mint"),
  triggerData: jsonb("trigger_data").$type<Record<string, any>>().notNull(), // pattern-specific data
  predictedOutcome: text("predicted_outcome"), // moon, dump, sideways
  actualOutcome: text("actual_outcome"), // filled in after resolution
  confidence: real("confidence"), // 0-1 confidence score
  outcomeMultiplier: real("outcome_multiplier"), // actual price change multiplier
  resolvedAt: integer("resolved_at"),
  createdAt: integer("created_at").notNull(),
});

export const insertPatternTriggerSchema = createInsertSchema(patternTriggers).omit({ id: true });
export type PatternTrigger = typeof patternTriggers.$inferSelect;
export type InsertPatternTrigger = z.infer<typeof insertPatternTriggerSchema>;

// Wallet reputation - track wallet performance over time
export const walletReputation = pgTable("wallet_reputation", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  rugCount: integer("rug_count").default(0), // tokens that went to zero
  successfulTrades: integer("successful_trades").default(0), // trades with positive outcome
  totalTrades: integer("total_trades").default(0),
  avgHoldTimeMinutes: integer("avg_hold_time_minutes"), // average hold time
  avgMultiplier: real("avg_multiplier"), // average return multiplier
  lastTradeAt: integer("last_trade_at"),
  reputationScore: real("reputation_score"), // computed score 0-100
  notes: text("notes"), // admin/AI notes about this wallet
  updatedAt: integer("updated_at").notNull(),
});

export const insertWalletReputationSchema = createInsertSchema(walletReputation).omit({ id: true });
export type WalletReputation = typeof walletReputation.$inferSelect;
export type InsertWalletReputation = z.infer<typeof insertWalletReputationSchema>;

// Holder snapshots - track holder distribution over time for pattern analysis
export const holderSnapshots = pgTable("holder_snapshots", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  snapshotTime: integer("snapshot_time").notNull(),
  topHolders: jsonb("top_holders").$type<{ address: string; percent: number; amount: number }[]>(),
  totalHolders: integer("total_holders"),
  top10Percent: real("top_10_percent"), // concentration in top 10
  top50Percent: real("top_50_percent"), // concentration in top 50
  concentrationScore: real("concentration_score"), // computed score
  createdAt: integer("created_at").notNull(),
});

export const insertHolderSnapshotSchema = createInsertSchema(holderSnapshots).omit({ id: true });
export type HolderSnapshot = typeof holderSnapshots.$inferSelect;
export type InsertHolderSnapshot = z.infer<typeof insertHolderSnapshotSchema>;

// Pincher data requests - AI can request new data points, admin approves
export const pincherDataRequests = pgTable("pincher_data_requests", {
  id: serial("id").primaryKey(),
  requestType: text("request_type").notNull(), // new_metric, api_integration, pattern_tracking
  description: text("description").notNull(), // what Pincher wants and why
  reasoning: text("reasoning"), // AI's reasoning for the request
  priority: text("priority").default("normal"), // low, normal, high
  status: text("status").default("pending"), // pending, approved, rejected, implemented
  adminNotes: text("admin_notes"), // admin response/notes
  resolvedBy: integer("resolved_by"), // admin user id
  resolvedAt: integer("resolved_at"),
  createdAt: integer("created_at").notNull(),
});

export const insertPincherDataRequestSchema = createInsertSchema(pincherDataRequests).omit({ id: true });
export type PincherDataRequest = typeof pincherDataRequests.$inferSelect;
export type InsertPincherDataRequest = z.infer<typeof insertPincherDataRequestSchema>;

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

// API usage tracking table for budget management
export const apiUsage = pgTable("api_usage", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(), // helius, dexscreener, openai
  endpoint: text("endpoint"), // optional endpoint detail
  callCount: integer("call_count").notNull().default(1),
  timestamp: integer("timestamp").notNull(), // unix timestamp
  date: text("date").notNull(), // YYYY-MM-DD for daily aggregation
  month: text("month").notNull(), // YYYY-MM for monthly aggregation
});

export const insertApiUsageSchema = createInsertSchema(apiUsage).omit({ id: true });
export type ApiUsage = typeof apiUsage.$inferSelect;
export type InsertApiUsage = z.infer<typeof insertApiUsageSchema>;

// API budget configuration
export const apiBudgetConfig = pgTable("api_budget_config", {
  id: serial("id").primaryKey(),
  service: text("service").notNull().unique(), // helius, dexscreener, openai
  monthlyLimit: integer("monthly_limit").notNull().default(10000),
  dailyLimit: integer("daily_limit").notNull().default(500),
  warningThreshold: integer("warning_threshold").notNull().default(80), // percent
  pauseThreshold: integer("pause_threshold").notNull().default(95), // percent
  isPaused: boolean("is_paused").notNull().default(false),
  updatedAt: integer("updated_at"),
});

export const insertApiBudgetConfigSchema = createInsertSchema(apiBudgetConfig).omit({ id: true });
export type ApiBudgetConfig = typeof apiBudgetConfig.$inferSelect;
export type InsertApiBudgetConfig = z.infer<typeof insertApiBudgetConfigSchema>;

// User-supplied API keys - users can add their own keys to increase wallet limits
export const userApiKeys = pgTable("user_api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  service: text("service").notNull(), // helius, dexscreener
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyLabel: text("key_label"), // optional label like "My Helius Key"
  isValid: boolean("is_valid").default(true), // set to false if key fails validation
  lastValidatedAt: integer("last_validated_at"),
  createdAt: integer("created_at").notNull(),
});

export const insertUserApiKeySchema = createInsertSchema(userApiKeys).omit({ id: true });
export type UserApiKey = typeof userApiKeys.$inferSelect;
export type InsertUserApiKey = z.infer<typeof insertUserApiKeySchema>;

// Admin API key pool - multiple keys for backend load balancing and redundancy
export const adminApiKeys = pgTable("admin_api_keys", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(), // helius, dexscreener
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyLabel: text("key_label").notNull(), // descriptive label like "Helius Key 1"
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(0), // higher = preferred
  usageCount: integer("usage_count").default(0),
  lastUsedAt: integer("last_used_at"),
  createdAt: integer("created_at").notNull(),
});

export const insertAdminApiKeySchema = createInsertSchema(adminApiKeys).omit({ id: true });
export type AdminApiKey = typeof adminApiKeys.$inferSelect;
export type InsertAdminApiKey = z.infer<typeof insertAdminApiKeySchema>;

// Wallet limits configuration
export const walletLimitsConfig = pgTable("wallet_limits_config", {
  id: serial("id").primaryKey(),
  baseWalletLimit: integer("base_wallet_limit").notNull().default(2), // free tier
  walletsPerApiKey: integer("wallets_per_api_key").notNull().default(2), // bonus per key
  maxWalletLimit: integer("max_wallet_limit").notNull().default(20), // hard cap
  updatedAt: integer("updated_at"),
});

export const insertWalletLimitsConfigSchema = createInsertSchema(walletLimitsConfig).omit({ id: true });
export type WalletLimitsConfig = typeof walletLimitsConfig.$inferSelect;
export type InsertWalletLimitsConfig = z.infer<typeof insertWalletLimitsConfigSchema>;
