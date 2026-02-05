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
  // Recovery email for password resets
  recoveryEmail: text("recovery_email"),
  // User's Helius API key (free tier available)
  heliusApiKey: text("helius_api_key"),
  // Default cashout wallet for emergency fund recovery
  defaultCashoutWallet: text("default_cashout_wallet"),
  // Telegram integration
  telegramChatId: text("telegram_chat_id"),
  telegramLinkToken: text("telegram_link_token"),
  telegramLinkedAt: integer("telegram_linked_at"),
  // Email notification settings (user provides own keys)
  emailProvider: text("email_provider"), // "resend" | "sendgrid" | "mailgun" | "smtp"
  emailApiKey: text("email_api_key"),
  emailFromAddress: text("email_from_address"),
  smtpConfig: jsonb("smtp_config"), // { host, port, user, pass } for SMTP provider
  // Onboarding state
  onboardingCompleted: boolean("onboarding_completed").default(false),
  
  // Security settings
  withdrawalPinHash: text("withdrawal_pin_hash"), // Hashed 4-6 digit PIN
  pinMode: text("pin_mode").default("withdrawals_only"), // "withdrawals_only" | "all_trades" | "threshold"
  pinThresholdUsd: real("pin_threshold_usd").default(100), // PIN required for trades over this amount
  dailySpendLimitUsd: real("daily_spend_limit_usd"), // Max total spend per day
  withdrawalWhitelist: jsonb("withdrawal_whitelist").$type<string[]>().default([]), // Approved external addresses
  telegramConfirmLargeTransfers: boolean("telegram_confirm_large_transfers").default(false), // Confirm large transfers via Telegram
  largeTransferThresholdUsd: real("large_transfer_threshold_usd").default(500), // What counts as "large"
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
  copyAutoMirror: boolean("copy_auto_mirror").default(false), // Legacy: combined mirror setting
  copyMirrorBuys: boolean("copy_mirror_buys"), // Mirror additional buys from this wallet (null = inherit from copyAutoMirror)
  copyMirrorSells: boolean("copy_mirror_sells"), // Mirror sells from this wallet (null = inherit from copyAutoMirror)
  
  // Enhanced initial buy settings
  copyInitialBuyMode: text("copy_initial_buy_mode").default("fixed"), // "fixed" | "percent_wallet" | "percent_budget"
  
  // Budget settings
  copyBudgetEnabled: boolean("copy_budget_enabled").default(false),
  copyBudgetTimeframe: text("copy_budget_timeframe").default("daily"), // "hourly" | "daily" | "weekly"
  copyBudgetAmount: real("copy_budget_amount"), // SOL amount for budget
  
  // Mirror buy limits
  copyMirrorBuyMode: text("copy_mirror_buy_mode").default("same"), // "same" | "fixed" | "percent_wallet" | "proportional"
  copyMirrorBuyAmount: real("copy_mirror_buy_amount"), // Amount for mirror buys (if not "same")
  copyMirrorBuyMaxPerToken: integer("copy_mirror_buy_max_per_token"), // Max mirror buys per token
  copyMirrorBuyMaxPerHour: integer("copy_mirror_buy_max_per_hour"), // Max mirror buys per hour
  copyMirrorBuyMaxPerDay: integer("copy_mirror_buy_max_per_day"), // Max mirror buys per day
  copyPositionCapUsd: real("copy_position_cap_usd"), // Stop mirroring if bag exceeds this USD
  
  // Mirror sell settings
  copyMirrorSellMode: text("copy_mirror_sell_mode").default("match_percent"), // "match_percent" | "fixed_percent" | "fixed_amount" | "full_exit_only"
  copyMirrorSellPercent: real("copy_mirror_sell_percent"), // For fixed_percent mode
  copyMirrorSellAmount: real("copy_mirror_sell_amount"), // For fixed_amount mode (SOL)
  
  // Deduplication options
  dedupSkipIfHolding: boolean("dedup_skip_if_holding").default(true), // Skip if already holding
  dedupSkipIfEverHeld: boolean("dedup_skip_if_ever_held").default(false), // Skip if ever held
  dedupSkipIfPending: boolean("dedup_skip_if_pending").default(true), // Skip if already pending
  dedupFirstBuyOnly: boolean("dedup_first_buy_only").default(false), // Only copy signal's first entry, not top-ups
  dedupCrossSignalPrevention: boolean("dedup_cross_signal_prevention").default(false), // Only one signal can trigger per token
  dedupMaxBuysPerTokenDaily: integer("dedup_max_buys_per_token_daily"), // Max buys per token per day
  dedupMaxBuysPerTokenWeekly: integer("dedup_max_buys_per_token_weekly"), // Max buys per token per week
  dedupPriceProtectionPercent: real("dedup_price_protection_percent"), // Skip if price moved more than X% since signal
});

// Wallet rule defaults - per-wallet default rules for positions
// When a new position is created from this wallet, these rules are inherited
// Position can override with ruleSource="override" and its own take profit/stop loss values
export const walletRuleDefaults = pgTable("wallet_rule_defaults", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull().unique(), // Reference to monitored_wallets.id - one defaults per wallet
  userId: integer("user_id").notNull(),
  
  // Take profit configuration
  takeProfitThresholds: jsonb("take_profit_thresholds").$type<number[]>().default([4, 10, 25, 100]), // Multipliers to trigger sells
  takeProfitPercentages: jsonb("take_profit_percentages").$type<number[]>().default([25, 25, 25, 25]), // Percent to sell at each threshold
  takeProfitEnabled: jsonb("take_profit_enabled").$type<boolean[]>().default([true, true, true, true]), // Whether each tier is enabled
  
  // Stop loss configuration
  stopLossPercent: real("stop_loss_percent").default(50), // Sell if down this %
  stopLossFloorUsd: real("stop_loss_floor_usd"), // Skip stop-loss if position value below this $
  stopLossMode: text("stop_loss_mode").default("auto"), // "auto" | "alert"
  
  // Autonomy defaults
  autoMirrorSells: boolean("auto_mirror_sells").default(false), // Mirror signal wallet sells
  autonomyEnabled: boolean("autonomy_enabled").default(false), // Allow AI to manage positions
  
  // Metadata
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertWalletRuleDefaultsSchema = createInsertSchema(walletRuleDefaults).omit({ id: true });
export type InsertWalletRuleDefaults = z.infer<typeof insertWalletRuleDefaultsSchema>;
export type WalletRuleDefaults = typeof walletRuleDefaults.$inferSelect;

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
  solPriceAtTrade: real("sol_price_at_trade"),
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
  takeProfitEnabled: jsonb("take_profit_enabled").$type<boolean[]>(), // Whether each tier is enabled
  stopLossPercent: real("stop_loss_percent"), // Sell if price drops by this %
  stopLossFloorUsd: real("stop_loss_floor_usd"), // Sell if value drops below this $
  stopLossMode: text("stop_loss_mode").default("auto"), // "auto" (sell immediately) | "alert" (notify, wait for confirmation)
  stopLossTriggered: boolean("stop_loss_triggered").default(false), // True if stop-loss was executed
  stopLossTimestamp: integer("stop_loss_timestamp"), // Unix timestamp when stop-loss was triggered
  stopLossSignature: text("stop_loss_signature"), // Transaction signature of stop-loss sell
  stopLossLastAlertedAt: integer("stop_loss_last_alerted_at"), // Debounce: last time stop-loss alert was sent
  takeProfitLastTriggeredAt: integer("take_profit_last_triggered_at"), // Debounce: prevent oscillation re-triggers
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
  
  // Position status (active/pending/inactive for filtering and swing trading)
  positionStatus: text("position_status").default("active"), // "active" (holding), "pending" (buy order), "inactive" (sold/watching)
  
  // Autonomy controls - per-position AI trading permissions
  autonomyEnabled: boolean("autonomy_enabled").default(false), // Allow AI to manage this position
  
  // Rule inheritance - whether position uses wallet defaults or custom overrides
  ruleSource: text("rule_source").default("inherited"), // "inherited" (use wallet defaults) | "override" (use position-specific values)
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
  
  // Slippage configuration
  slippageMode: text("slippage_mode").default("auto"), // "auto" | "fixed"
  slippageMaxBps: integer("slippage_max_bps").default(500), // Max slippage in basis points (500 = 5%)
  slippageMinBps: integer("slippage_min_bps").default(50), // Min slippage for auto mode (50 = 0.5%)
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

// Token blacklist - global list of tokens to never trade
export const tokenBlacklist = pgTable("token_blacklist", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  tokenName: text("token_name"),
  reason: text("reason"), // "rug" | "scam" | "frozen" | "manual" | etc.
  addedAt: integer("added_at").notNull(),
  addedBy: text("added_by").default("manual"), // "manual" | "auto" | "ai"
});

export const insertTokenBlacklistSchema = createInsertSchema(tokenBlacklist).omit({ id: true });
export type InsertTokenBlacklist = z.infer<typeof insertTokenBlacklistSchema>;
export type TokenBlacklist = typeof tokenBlacklist.$inferSelect;

// Global copy trading defaults - applies to all signal wallets unless overridden
export const copyTradingDefaults = pgTable("copy_trading_defaults", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  
  // Initial buy defaults
  copyBuyType: text("copy_buy_type").default("percentage"), // "fixed_sol" | "fixed_usd" | "percentage"
  copyBuyAmount: real("copy_buy_amount").default(10), // Amount based on type
  copyInitialBuyMode: text("copy_initial_buy_mode").default("fixed"), // "fixed" | "percent_wallet" | "percent_budget"
  
  // Budget defaults
  copyBudgetEnabled: boolean("copy_budget_enabled").default(false),
  copyBudgetTimeframe: text("copy_budget_timeframe").default("daily"), // "hourly" | "daily" | "weekly"
  copyBudgetAmount: real("copy_budget_amount"), // SOL amount for budget
  
  // Mirror buy defaults
  copyMirrorBuys: boolean("copy_mirror_buys").default(false),
  copyMirrorBuyMode: text("copy_mirror_buy_mode").default("same"), // "same" | "fixed" | "percent_wallet" | "percent_budget"
  copyMirrorBuyAmount: real("copy_mirror_buy_amount"),
  copyMirrorBuyMaxPerToken: integer("copy_mirror_buy_max_per_token"),
  copyMirrorBuyMaxPerHour: integer("copy_mirror_buy_max_per_hour"),
  copyMirrorBuyMaxPerDay: integer("copy_mirror_buy_max_per_day"),
  copyPositionCapUsd: real("copy_position_cap_usd"),
  
  // Mirror sell defaults
  copyMirrorSells: boolean("copy_mirror_sells").default(false),
  copyMirrorSellMode: text("copy_mirror_sell_mode").default("match_percent"), // "match_percent" | "fixed_percent" | "fixed_amount" | "full_exit_only"
  copyMirrorSellPercent: real("copy_mirror_sell_percent"),
  copyMirrorSellAmount: real("copy_mirror_sell_amount"),
  
  // Dedup defaults
  dedupSkipIfHolding: boolean("dedup_skip_if_holding").default(true),
  dedupSkipIfEverHeld: boolean("dedup_skip_if_ever_held").default(false),
  dedupSkipIfPending: boolean("dedup_skip_if_pending").default(true),
  dedupFirstBuyOnly: boolean("dedup_first_buy_only").default(false),
  dedupCrossSignalPrevention: boolean("dedup_cross_signal_prevention").default(false),
  dedupMaxBuysPerTokenDaily: integer("dedup_max_buys_per_token_daily"),
  dedupMaxBuysPerTokenWeekly: integer("dedup_max_buys_per_token_weekly"),
  dedupPriceProtectionPercent: real("dedup_price_protection_percent"),
  
  // Global safety settings
  frozenTokenCheck: boolean("frozen_token_check").default(true), // Auto-block frozen tokens
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertCopyTradingDefaultsSchema = createInsertSchema(copyTradingDefaults).omit({ id: true });
export type InsertCopyTradingDefaults = z.infer<typeof insertCopyTradingDefaultsSchema>;
export type CopyTradingDefaults = typeof copyTradingDefaults.$inferSelect;

// Signal cumulative tracking - track what signal wallets have bought per token
// Used for proportional mirror sells
export const signalCumulativeTracking = pgTable("signal_cumulative_tracking", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  signalWalletId: integer("signal_wallet_id").notNull(), // Reference to monitored_wallets
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  
  // Cumulative tracking from when user started mirroring
  totalTokensBought: real("total_tokens_bought").default(0), // Total tokens signal bought
  totalSolSpent: real("total_sol_spent").default(0), // Total SOL signal spent
  totalTokensSold: real("total_tokens_sold").default(0), // Total tokens signal sold
  buyCount: integer("buy_count").default(0), // Number of buys from signal
  sellCount: integer("sell_count").default(0), // Number of sells from signal
  
  firstBuyAt: integer("first_buy_at"), // When signal first bought
  lastBuyAt: integer("last_buy_at"), // When signal last bought
  lastSellAt: integer("last_sell_at"), // When signal last sold
  
  // Calculated fields
  remainingTokens: real("remaining_tokens").default(0), // totalBought - totalSold
  avgBuyPrice: real("avg_buy_price"), // Weighted average
});

export const insertSignalCumulativeTrackingSchema = createInsertSchema(signalCumulativeTracking).omit({ id: true });
export type InsertSignalCumulativeTracking = z.infer<typeof insertSignalCumulativeTrackingSchema>;
export type SignalCumulativeTracking = typeof signalCumulativeTracking.$inferSelect;

// Trade rules - flexible buy/sell triggers with configurable parameters
// Can be applied at hot wallet (default), signal wallet, or position level
export const tradeRules = pgTable("trade_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  
  // Rule scope: where this rule applies
  scope: text("scope").notNull().default("hotWallet"), // "hotWallet" | "signalWallet" | "position" | "token"
  scopeId: integer("scope_id"), // signalWalletId, holdingId, or null for hotWallet
  tokenMint: text("token_mint"), // For token-specific rules
  
  // Rule name and status
  name: text("name").notNull(),
  enabled: boolean("enabled").default(true),
  
  // Action type
  action: text("action").notNull(), // "buy" | "sell"
  
  // Trigger conditions
  direction: text("direction").notNull(), // "up" | "down" - price direction
  percentChange: real("percent_change").notNull(), // Trigger at this % change
  timeframeMinutes: integer("timeframe_minutes"), // Within this time window (null = any)
  
  // Execution parameters
  amountType: text("amount_type").notNull().default("percent"), // "percent" | "fixed"
  amountValue: real("amount_value").notNull(), // % of position or fixed USD
  maxAmountUsd: real("max_amount_usd"), // Cap for fixed amounts
  
  // Execution count limits
  maxTriggerCount: integer("max_trigger_count"), // How many times this can fire (null = unlimited)
  triggerCount: integer("trigger_count").default(0), // How many times it has fired
  cooldownMinutes: integer("cooldown_minutes").default(15), // Min time between triggers
  lastTriggeredAt: integer("last_triggered_at"),
  
  // Additional filters
  requireAutonomy: boolean("require_autonomy").default(true), // Only execute if position has autonomy enabled
  minPositionValueUsd: real("min_position_value_usd"), // Only for positions above this value
  maxPositionValueUsd: real("max_position_value_usd"), // Only for positions below this value
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Trade rule presets - saved parameter sets for quick application
export const tradeRulePresets = pgTable("trade_rule_presets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  
  name: text("name").notNull(), // User-defined preset name
  description: text("description"),
  isDefault: boolean("is_default").default(false), // Apply to new positions automatically
  
  // Stored rules as JSON array
  rules: jsonb("rules").$type<{
    name: string;
    action: "buy" | "sell";
    direction: "up" | "down";
    percentChange: number;
    timeframeMinutes: number | null;
    amountType: "percent" | "fixed";
    amountValue: number;
    maxAmountUsd?: number;
    cooldownMinutes: number;
  }[]>().notNull(),
  
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

// Trade filters - AI-configured filters via Miss Pincher chat
export const tradeFilters = pgTable("trade_filters", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  metric: text("metric").notNull(), // marketCap, liquidity, holders, volume, age, fdv
  operator: text("operator").notNull(), // gte, lte, eq
  value: real("value").notNull(),
  enabled: boolean("enabled").default(true),
  createdAt: integer("created_at").notNull(),
});

export const insertTradeFilterSchema = createInsertSchema(tradeFilters).omit({ id: true });
export type InsertTradeFilter = z.infer<typeof insertTradeFilterSchema>;
export type TradeFilter = typeof tradeFilters.$inferSelect;

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

// Portfolio snapshots - tracks portfolio value over time for charts
// Stored at multiple tiers (hourly, daily) piggybacking on price aggregation
export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tier: text("tier").notNull(), // "hourly" | "daily"
  bucketStart: integer("bucket_start").notNull(), // Unix timestamp for bucket start
  
  // Portfolio value metrics
  totalValueUsd: real("total_value_usd").notNull(), // Sum of all position values
  totalCostBasisUsd: real("total_cost_basis_usd"), // Sum of all SOL spent converted to USD
  unrealizedPnlUsd: real("unrealized_pnl_usd"), // totalValueUsd - totalCostBasisUsd
  unrealizedPnlPercent: real("unrealized_pnl_percent"), // % change from cost basis
  
  // Position counts
  positionCount: integer("position_count").notNull(), // Number of active positions
  profitableCount: integer("profitable_count"), // Positions in profit
  losingCount: integer("losing_count"), // Positions in loss
  
  // Top positions snapshot (for allocation chart)
  topPositions: jsonb("top_positions").$type<{
    tokenMint: string;
    tokenSymbol: string;
    valueUsd: number;
    percentOfPortfolio: number;
  }[]>(),
  
  // SOL price at snapshot (for historical conversions)
  solPriceUsd: real("sol_price_usd"),
  
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

export const adminChatMessages = pgTable("admin_chat_messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
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
export const insertPortfolioSnapshotSchema = createInsertSchema(portfolioSnapshots).omit({ id: true });
export const insertAiChatMessageSchema = createInsertSchema(aiChatMessages).omit({ id: true });
export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({ id: true });
export const insertCommunityInsightSchema = createInsertSchema(communityInsights).omit({ id: true });
export const insertSignalWalletProfileSchema = createInsertSchema(signalWalletProfiles).omit({ id: true });
export const insertAutonomousSettingsSchema = createInsertSchema(autonomousSettings).omit({ id: true });
export const insertSwingTradeSettingsSchema = createInsertSchema(swingTradeSettings).omit({ id: true });
export const insertTradeRuleSchema = createInsertSchema(tradeRules).omit({ id: true });
export const insertTradeRulePresetSchema = createInsertSchema(tradeRulePresets).omit({ id: true });

// Trade rule types
export type TradeRule = typeof tradeRules.$inferSelect;
export type InsertTradeRule = z.infer<typeof insertTradeRuleSchema>;
export type TradeRulePreset = typeof tradeRulePresets.$inferSelect;
export type InsertTradeRulePreset = z.infer<typeof insertTradeRulePresetSchema>;

// Price aggregate types
export type PriceAggregate = typeof priceAggregates.$inferSelect;
export type InsertPriceAggregate = z.infer<typeof insertPriceAggregateSchema>;
export type AggregateTier = "15min" | "hourly" | "daily" | "weekly";

// Portfolio snapshot types
export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = z.infer<typeof insertPortfolioSnapshotSchema>;
export type PortfolioSnapshotTier = "hourly" | "daily";

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
  userId: z.number().optional(),
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
  takeProfitEnabled: z.array(z.boolean()).optional(),
  stopLossPercent: z.number().optional(),
  stopLossFloorUsd: z.number().optional(),
  stopLossMode: z.enum(["auto", "alert"]).default("auto"),
  autoMirrorSells: z.boolean().default(false),
  positionSource: z.string().default("copy"),
  signalWalletId: z.number().optional(),
  entryReason: z.string().optional(),
  // Position status and autonomy (Phase 9)
  positionStatus: z.enum(["active", "pending", "inactive"]).default("active"),
  autonomyEnabled: z.boolean().default(false),
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
  // Stop-loss defaults (Phase 8)
  stopLossPercent: z.number().optional(),
  stopLossFloorUsd: z.number().optional(),
  // Trading budget limits (Phase 8)
  maxTradeUsd: z.number().optional(),
  maxDailySpendUsd: z.number().optional(),
  // Slippage configuration
  slippageMode: z.enum(["auto", "fixed"]).default("auto"),
  slippageMaxBps: z.number().default(500),
  slippageMinBps: z.number().default(50),
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

// ============ Separate Log Tables ============

// AI Logs - Miss Pincher AI calls tracking
export const aiLogs = pgTable("ai_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  action: text("action").notNull(), // chat, analyze_token, create_filter, etc.
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  estimatedCostUsd: real("estimated_cost_usd").notNull(),
  latencyMs: integer("latency_ms"),
  model: text("model").default("gpt-4o-mini"),
  context: jsonb("context").$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull(),
});

export const insertAiLogSchema = createInsertSchema(aiLogs).omit({ id: true });
export type AiLog = typeof aiLogs.$inferSelect;
export type InsertAiLog = z.infer<typeof insertAiLogSchema>;

// API Logs - External API calls (Jupiter, DexScreener, GeckoTerminal, etc.)
export const apiLogs = pgTable("api_logs", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(), // jupiter, dexscreener, geckoterminal, binance
  endpoint: text("endpoint").notNull(), // getQuote, fetchTokenMetadata, etc.
  success: boolean("success").notNull(),
  latencyMs: integer("latency_ms"),
  statusCode: integer("status_code"),
  context: jsonb("context").$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull(),
});

export const insertApiLogSchema = createInsertSchema(apiLogs).omit({ id: true });
export type ApiLog = typeof apiLogs.$inferSelect;
export type InsertApiLog = z.infer<typeof insertApiLogSchema>;

// Webhook Logs - Helius swap notifications
export const webhookLogs = pgTable("webhook_logs", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(), // helius
  eventType: text("event_type").notNull(), // swap_detected, token_transfer, etc.
  walletAddress: text("wallet_address"),
  tokenMint: text("token_mint"),
  status: text("status").notNull(), // received, processed, ignored, error
  processingTimeMs: integer("processing_time_ms"),
  context: jsonb("context").$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull(),
});

export const insertWebhookLogSchema = createInsertSchema(webhookLogs).omit({ id: true });
export type WebhookLog = typeof webhookLogs.$inferSelect;
export type InsertWebhookLog = z.infer<typeof insertWebhookLogSchema>;

// Trade Logs - Copy trade executions
export const tradeLogs = pgTable("trade_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  signalWalletId: integer("signal_wallet_id"),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  action: text("action").notNull(), // buy, sell, mirror_buy, mirror_sell
  status: text("status").notNull(), // pending, queued, executing, success, failed, skipped
  amountSol: real("amount_sol"),
  amountUsd: real("amount_usd"),
  priceAtExecution: real("price_at_execution"),
  txSignature: text("tx_signature"),
  failureReason: text("failure_reason"),
  latencyMs: integer("latency_ms"),
  context: jsonb("context").$type<Record<string, any>>(),
  createdAt: integer("created_at").notNull(),
});

export const insertTradeLogSchema = createInsertSchema(tradeLogs).omit({ id: true });
export type TradeLog = typeof tradeLogs.$inferSelect;
export type InsertTradeLog = z.infer<typeof insertTradeLogSchema>;

// Error Logs - All failures across the system
export const errorLogs = pgTable("error_logs", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(), // ai, api, webhook, trade, system
  action: text("action").notNull(), // what was being attempted
  errorType: text("error_type").notNull(), // timeout, validation, network, auth, etc.
  errorMessage: text("error_message").notNull(),
  errorStack: text("error_stack"),
  userId: integer("user_id"),
  context: jsonb("context").$type<Record<string, any>>(),
  resolved: boolean("resolved").default(false),
  createdAt: integer("created_at").notNull(),
});

export const insertErrorLogSchema = createInsertSchema(errorLogs).omit({ id: true });
export type ErrorLog = typeof errorLogs.$inferSelect;
export type InsertErrorLog = z.infer<typeof insertErrorLogSchema>;

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
  
  // Market factor snapshot for adaptive learning (AI predictions)
  factorsSnapshot: jsonb("factors_snapshot").$type<{
    liquidityHealth?: number;      // Liquidity/mcap ratio quality
    volumeStrength?: number;       // Trading volume level
    whaleConcentration?: number;   // Holder concentration risk
    whaleActivity?: number;        // Recent whale movements
    tokenFreshness?: number;       // How new/fresh the token is
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

// Event bucket type for tiered event tracking
export interface EventBucket {
  tier: "15min" | "hourly" | "daily";
  bucketStart: number; // timestamp
  holderDelta: number;
  priceRange: { low: number; high: number };
  whaleEvents: Array<{ wallet: string; action: "buy" | "sell"; rank: number; timestamp: number }>;
  eventCount: number;
  peakMultiplier: number;
}

// Position scoring snapshots - track position factor performance for adaptive learning
export const positionScoreSnapshots = pgTable("position_score_snapshots", {
  id: serial("id").primaryKey(),
  holdingId: integer("holding_id").notNull(),
  userId: integer("user_id"),
  tokenMint: text("token_mint").notNull(),
  
  // Position factors at time of scoring
  factorsSnapshot: jsonb("factors_snapshot").$type<{
    priceChange: number;       // Entry price vs current price movement
    timeDecay: number;         // Holding duration penalty
    whaleActivity: number;     // Recent whale movements
    signalWalletStatus: number; // Signal wallet still holding?
    volumeTrend: number;       // Volume change direction
  }>().notNull(),
  
  // Score computed
  computedScore: integer("computed_score").notNull(),
  scoreTier: text("score_tier").notNull(), // strong/neutral/weak
  
  // Context at scoring time
  priceAtScoring: real("price_at_scoring"),
  entryPrice: real("entry_price"),
  holdTimeHours: real("hold_time_hours"),
  
  // Tiered event buckets - detailed recent, summarized historical
  entrySnapshot: jsonb("entry_snapshot").$type<{
    holderCount: number;
    price: number;
    marketCap: number;
    timestamp: number;
  }>(),
  eventBuckets: jsonb("event_buckets").$type<EventBucket[]>().default([]),
  currentSnapshot: jsonb("current_snapshot").$type<{
    holderCount: number;
    price: number;
    marketCap: number;
    peakMultiplier: number;
    significantEvents: number;
    timestamp: number;
  }>(),
  
  // Outcome tracking (filled in when position closes or later)
  exitPrice: real("exit_price"),
  exitMultiplier: real("exit_multiplier"),
  wasGoodScore: boolean("was_good_score"), // true if score matched eventual outcome
  outcomeType: text("outcome_type"), // profit_exit, loss_exit, held_through
  
  scoredAt: integer("scored_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

export const insertPositionScoreSnapshotSchema = createInsertSchema(positionScoreSnapshots).omit({ id: true });
export type PositionScoreSnapshot = typeof positionScoreSnapshots.$inferSelect;
export type InsertPositionScoreSnapshot = z.infer<typeof insertPositionScoreSnapshotSchema>;

// Discovered factors - AI-discovered correlations for potential new factors
export const discoveredFactors = pgTable("discovered_factors", {
  id: serial("id").primaryKey(),
  factorType: text("factor_type").notNull(), // market | position
  factorName: text("factor_name").notNull(), // e.g., "superLiquidity", "fastFlipperSource"
  description: text("description").notNull(),
  
  // Discovery stats
  correlationStrength: real("correlation_strength"), // 0-1 how strongly it correlates
  sampleSize: integer("sample_size").notNull(),
  successRate: real("success_rate"), // % of positive outcomes with this factor
  avgMultiplier: real("avg_multiplier"),
  
  // Status
  status: text("status").default("proposed"), // proposed, testing, active, rejected
  addedToScoringAt: integer("added_to_scoring_at"),
  
  // Examples
  exampleConditions: jsonb("example_conditions").$type<string[]>(),
  
  discoveredAt: integer("discovered_at").notNull(),
  lastUpdated: integer("last_updated").notNull(),
});

export const insertDiscoveredFactorSchema = createInsertSchema(discoveredFactors).omit({ id: true });
export type DiscoveredFactor = typeof discoveredFactors.$inferSelect;
export type InsertDiscoveredFactor = z.infer<typeof insertDiscoveredFactorSchema>;

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

// User-supplied API keys - users can add their own keys for budget/wallet limits
export const userApiKeys = pgTable("user_api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  service: text("service").notNull(), // helius, dexscreener
  encryptedApiKey: text("encrypted_api_key").notNull(),
  keyLabel: text("key_label"), // optional label like "My Helius Key"
  isValid: boolean("is_valid").default(true), // set to false if key fails validation
  lastValidatedAt: integer("last_validated_at"),
  
  // Budget tracking for Helius keys
  monthlyBudget: integer("monthly_budget").default(1000000), // 1M credits default (Helius free tier)
  walletLimit: integer("wallet_limit").default(100), // 100 signal wallets per key
  currentWalletCount: integer("current_wallet_count").default(0), // tracked wallet count
  
  // Pool participation
  contributesToPool: boolean("contributes_to_pool").default(true), // surplus shared with pool
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
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

// Familiar whales - cross-token tracking of whale wallets and their performance
export const familiarWhales = pgTable("familiar_whales", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  totalTokensSeen: integer("total_tokens_seen").default(0), // unique tokens they've held
  profitableExits: integer("profitable_exits").default(0), // exits where price > entry
  totalExits: integer("total_exits").default(0),
  avgExitMultiplier: real("avg_exit_multiplier").default(1), // avg return on exits
  bestExitMultiplier: real("best_exit_multiplier").default(1),
  avgHoldTimeMinutes: integer("avg_hold_time_minutes"), // avg time in position
  earlyEntryCount: integer("early_entry_count").default(0), // times they entered before major pumps
  // Derived metrics
  successRate: real("success_rate").default(0), // profitableExits / totalExits
  reliabilityScore: real("reliability_score").default(50), // 0-100 composite score
  label: text("label"), // user-assigned or auto-generated label
  
  // Cluster membership
  clusterId: integer("cluster_id"), // References whale_clusters.id
  clusterAssignedAt: integer("cluster_assigned_at"),
});

export const insertFamiliarWhaleSchema = createInsertSchema(familiarWhales).omit({ id: true });
export type FamiliarWhale = typeof familiarWhales.$inferSelect;
export type InsertFamiliarWhale = z.infer<typeof insertFamiliarWhaleSchema>;

// Whale token positions - track when whales enter/exit specific tokens
export const whaleTokenPositions = pgTable("whale_token_positions", {
  id: serial("id").primaryKey(),
  whaleId: integer("whale_id").notNull(), // references familiarWhales.id
  walletAddress: text("wallet_address").notNull(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  entryTimestamp: integer("entry_timestamp").notNull(),
  entryRank: integer("entry_rank"), // their holder rank when they entered
  entryPriceUsd: real("entry_price_usd"),
  entryMarketCap: real("entry_market_cap"),
  exitTimestamp: integer("exit_timestamp"),
  exitPriceUsd: real("exit_price_usd"),
  exitMarketCap: real("exit_market_cap"),
  exitMultiplier: real("exit_multiplier"), // exitPrice / entryPrice
  status: text("status").default("holding"), // holding, exited, partial_exit
  peakMultiplier: real("peak_multiplier"), // highest multiplier during hold
  holdTimeMinutes: integer("hold_time_minutes"),
});

export const insertWhaleTokenPositionSchema = createInsertSchema(whaleTokenPositions).omit({ id: true });
export type WhaleTokenPosition = typeof whaleTokenPositions.$inferSelect;
export type InsertWhaleTokenPosition = z.infer<typeof insertWhaleTokenPositionSchema>;

// User relationships - tracks Miss Pincher's relationship with each user
export const userRelationships = pgTable("user_relationships", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  affinityScore: integer("affinity_score").default(0), // -100 to +100
  relationshipType: text("relationship_type").default("new"), // new, adversarial, professional, friendly, playful_banter, try_hard
  
  // Multi-dimensional relationship scores (0-100 each, for vector learning)
  adversarialScore: integer("adversarial_score").default(0), // competitive/confrontational energy
  friendlyScore: integer("friendly_score").default(50), // warmth and approachability
  playfulScore: integer("playful_score").default(30), // teasing and banter level
  professionalScore: integer("professional_score").default(50), // business-like vs casual
  
  // Nickname/trust progression
  nicknameTier: integer("nickname_tier").default(0), // 0=Miss Pincher, 1=Pinchy allowed, 2=Penny sometimes, 3=Full name revealed
  trustLevel: integer("trust_level").default(0), // 0-100, earned through consistent behavior
  sassLevel: integer("sass_level").default(3), // 1-10, how much attitude she gives (increases with comfort)
  secretsShared: integer("secrets_shared").default(0), // 0-5, how much backstory revealed
  
  // Interaction tracking
  totalInteractions: integer("total_interactions").default(0),
  crabMentions: integer("crab_mentions").default(0),
  crabInsults: integer("crab_insults").default(0),
  complimentsGiven: integer("compliments_given").default(0),
  petPeevesTriggered: integer("pet_peeves_triggered").default(0), // times user annoyed her
  
  // Trading relationship
  tradesWonTogether: integer("trades_won_together").default(0),
  tradesLostTogether: integer("trades_lost_together").default(0),
  warningsIgnored: integer("warnings_ignored").default(0),
  warningsFollowed: integer("warnings_followed").default(0),
  
  // Memory
  lastInteraction: integer("last_interaction"),
  insideJokes: jsonb("inside_jokes").$type<string[]>().default([]), // shared references
  memorableEvents: jsonb("memorable_events").$type<string[]>().default([]), // significant moments to reference
  notes: jsonb("notes").default([]), // array of string notes
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertUserRelationshipSchema = createInsertSchema(userRelationships).omit({ id: true });
export type UserRelationshipRow = typeof userRelationships.$inferSelect;
export type InsertUserRelationship = z.infer<typeof insertUserRelationshipSchema>;

// Behavior vectors - per-user personality axis values for procedural personality mixing
export const behaviorVectors = pgTable("behavior_vectors", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  
  // Six behavior axes (0-100 scale, 50 = baseline)
  slangLevel: integer("slang_level").default(50), // Caribbean idioms and slang usage
  crabHintLevel: integer("crab_hint_level").default(30), // How often crab mystery slips through
  teasingLevel: integer("teasing_level").default(40), // Playful teasing intensity
  proactivityLevel: integer("proactivity_level").default(50), // Unsolicited advice/suggestions
  culturalRefLevel: integer("cultural_ref_level").default(40), // Caribbean cultural references
  tradingCautionLevel: integer("trading_caution_level").default(60), // Conservative vs aggressive advice
  
  // Dampening factors for stable learning
  slangDampening: real("slang_dampening").default(1.0),
  crabDampening: real("crab_dampening").default(1.0),
  teasingDampening: real("teasing_dampening").default(1.0),
  proactivityDampening: real("proactivity_dampening").default(1.0),
  culturalDampening: real("cultural_dampening").default(1.0),
  tradingDampening: real("trading_dampening").default(1.0),
  
  // Update tracking
  lastVectorUpdate: integer("last_vector_update"),
  totalUpdates: integer("total_updates").default(0),
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertBehaviorVectorSchema = createInsertSchema(behaviorVectors).omit({ id: true });
export type BehaviorVectorRow = typeof behaviorVectors.$inferSelect;
export type InsertBehaviorVector = z.infer<typeof insertBehaviorVectorSchema>;

// Memory clusters - tracks conversation topics and patterns for learning
export const memoryClusters = pgTable("memory_clusters", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  
  // Cluster identification
  clusterType: text("cluster_type").notNull(), // topic, pattern, preference, trigger
  clusterKey: text("cluster_key").notNull(), // specific identifier (e.g., "tokens_discussed", "time_preference")
  
  // Cluster data
  value: jsonb("value").$type<Record<string, any>>().default({}), // flexible storage for cluster data
  frequency: integer("frequency").default(1), // how often this cluster appears
  lastSeen: integer("last_seen"),
  
  // Learning metadata
  confidence: real("confidence").default(0.5), // 0-1, how confident we are in this pattern
  decayFactor: real("decay_factor").default(0.95), // for forgetting old patterns
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertMemoryClusterSchema = createInsertSchema(memoryClusters).omit({ id: true });
export type MemoryClusterRow = typeof memoryClusters.$inferSelect;
export type InsertMemoryCluster = z.infer<typeof insertMemoryClusterSchema>;

// Global baselines - stores the global personality vector that evolves from aggregated trends
export const globalBaselines = pgTable("global_baselines", {
  id: serial("id").primaryKey(),
  baselineType: text("baseline_type").notNull().unique(), // "personality" for now, extensible
  
  // Six behavior axis baselines (same as behavior_vectors)
  slangLevel: integer("slang_level").default(50),
  crabHintLevel: integer("crab_hint_level").default(30),
  teasingLevel: integer("teasing_level").default(40),
  proactivityLevel: integer("proactivity_level").default(50),
  culturalRefLevel: integer("cultural_ref_level").default(40),
  tradingCautionLevel: integer("trading_caution_level").default(60),
  
  // Aggregation metadata
  sampleCount: integer("sample_count").default(0), // how many users contributed
  lastAggregation: integer("last_aggregation"), // timestamp of last update
  version: integer("version").default(1), // for tracking evolution
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertGlobalBaselineSchema = createInsertSchema(globalBaselines).omit({ id: true });
export type GlobalBaselineRow = typeof globalBaselines.$inferSelect;
export type InsertGlobalBaseline = z.infer<typeof insertGlobalBaselineSchema>;

// ============ Budget & API Management System ============

// Per-user monthly budget tracking - tracks usage against projected end-of-month budget
export const userBudgetUsage = pgTable("user_budget_usage", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  apiKeyId: integer("api_key_id"), // references user_api_keys.id (null = admin key)
  month: text("month").notNull(), // YYYY-MM format
  
  // Credits tracking
  monthlyBudget: integer("monthly_budget").notNull().default(1000000), // 1M credits default
  creditsUsed: integer("credits_used").notNull().default(0),
  creditsRemaining: integer("credits_remaining").notNull().default(1000000),
  
  // Projection math
  daysInMonth: integer("days_in_month").notNull().default(30),
  currentDay: integer("current_day").notNull().default(1),
  targetDailyRate: integer("target_daily_rate"), // credits/day to hit month end
  actualDailyRate: integer("actual_daily_rate"), // current usage rate
  
  // Throttle status
  isThrottled: boolean("is_throttled").default(false),
  throttleFactor: real("throttle_factor").default(1.0), // 1.0 = normal, 0.5 = 50% speed
  surplusCredits: integer("surplus_credits").default(0), // credits ahead of pace
  
  // Timestamps
  lastCalculatedAt: integer("last_calculated_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertUserBudgetUsageSchema = createInsertSchema(userBudgetUsage).omit({ id: true });
export type UserBudgetUsage = typeof userBudgetUsage.$inferSelect;
export type InsertUserBudgetUsage = z.infer<typeof insertUserBudgetUsageSchema>;

// API request queue - priority-ordered queue for API calls
export const apiQueue = pgTable("api_queue", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // null = system/discovery request
  
  // Request details
  requestType: text("request_type").notNull(), // copy_trade, ui_request, background, discovery
  service: text("service").notNull(), // helius, dexscreener
  endpoint: text("endpoint").notNull(), // specific API endpoint
  payload: jsonb("payload").$type<Record<string, any>>(), // request data
  
  // Priority (higher = first)
  priority: integer("priority").notNull().default(50), // 100=copy_trade, 75=ui_active, 50=ui, 25=background, 10=discovery
  isUiActive: boolean("is_ui_active").default(false), // user is viewing relevant page
  
  // Status
  status: text("status").notNull().default("pending"), // pending, processing, completed, failed, cancelled
  scheduledFor: integer("scheduled_for"), // delay execution until this timestamp
  
  // Result
  result: jsonb("result").$type<Record<string, any>>(),
  errorMessage: text("error_message"),
  creditsUsed: integer("credits_used"),
  
  // Timing
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
});

export const insertApiQueueSchema = createInsertSchema(apiQueue).omit({ id: true });
export type ApiQueueItem = typeof apiQueue.$inferSelect;
export type InsertApiQueueItem = z.infer<typeof insertApiQueueSchema>;

// Holder cache - shared holder lists with webhook-based updates
export const holderCache = pgTable("holder_cache", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull().unique(),
  
  // Holder data
  holders: jsonb("holders").$type<{ address: string; amount: number; percent: number; rank: number }[]>().default([]),
  totalHolders: integer("total_holders").default(0),
  top10Concentration: real("top_10_concentration"), // % held by top 10
  
  // Source tracking
  fetchedVia: text("fetched_via").default("api"), // api, webhook_derived
  fetchedByUserId: integer("fetched_by_user_id"), // who paid for the fetch
  
  // TTL and freshness
  fetchedAt: integer("fetched_at").notNull(),
  expiresAt: integer("expires_at").notNull(), // stale after this
  lastWebhookUpdate: integer("last_webhook_update"), // last holder change from webhook
  webhookUpdateCount: integer("webhook_update_count").default(0), // updates since last fetch
  
  // Refresh priority
  isActive: boolean("is_active").default(true), // token still being monitored
  refreshPriority: integer("refresh_priority").default(50), // for opportunistic refresh ordering
});

export const insertHolderCacheSchema = createInsertSchema(holderCache).omit({ id: true });
export type HolderCacheEntry = typeof holderCache.$inferSelect;
export type InsertHolderCacheEntry = z.infer<typeof insertHolderCacheSchema>;

// Token data pool - unified cache for all token data
export const tokenDataPool = pgTable("token_data_pool", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull().unique(),
  tokenSymbol: text("token_symbol"),
  tokenName: text("token_name"),
  
  // Price data
  priceUsd: real("price_usd"),
  priceUpdatedAt: integer("price_updated_at"),
  priceSource: text("price_source"), // webhook, dexscreener, geckoterminal, cache
  
  // Market data
  marketCap: real("market_cap"),
  fdv: real("fdv"),
  liquidity: real("liquidity"),
  volume24h: real("volume_24h"),
  priceChange24h: real("price_change_24h"),
  marketDataUpdatedAt: integer("market_data_updated_at"),
  
  // Metadata
  pairAddress: text("pair_address"),
  dexId: text("dex_id"),
  pairCreatedAt: integer("pair_created_at"),
  
  // Source tracking
  lastFetchedBy: integer("last_fetched_by"), // userId who fetched
  lastFetchSource: text("last_fetch_source"), // frontend, backend, webhook
  
  // Freshness
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
  
  // Activity tracking
  isActive: boolean("is_active").default(true),
  lastAccessedAt: integer("last_accessed_at"),
  accessCount: integer("access_count").default(0),
  
  // Safety data (RugCheck + GoPlus)
  rugcheckData: jsonb("rugcheck_data"), // Raw RugCheck API response
  rugcheckCheckedAt: integer("rugcheck_checked_at"),
  goplusData: jsonb("goplus_data"), // Raw GoPlus API response
  goplusCheckedAt: integer("goplus_checked_at"),
  safetySource: text("safety_source"), // rugcheck, goplus, both
  
  // Pump.fun tracking
  isPumpfun: boolean("is_pumpfun"),
  pumpfunGraduated: boolean("pumpfun_graduated"),
  pumpfunGraduationTime: integer("pumpfun_graduation_time"),
  pumpfunAgeAtGraduation: integer("pumpfun_age_at_graduation"), // seconds from creation to graduation
  pumpfunBondingCurveProgress: real("pumpfun_bonding_curve_progress"), // 0-100%
});

export const insertTokenDataPoolSchema = createInsertSchema(tokenDataPool).omit({ id: true });
export type TokenDataPoolEntry = typeof tokenDataPool.$inferSelect;
export type InsertTokenDataPoolEntry = z.infer<typeof insertTokenDataPoolSchema>;

// Price history cache - OHLCV data from DexScreener
export const priceHistoryCache = pgTable("price_history_cache", {
  id: serial("id").primaryKey(),
  tokenMint: text("token_mint").notNull(),
  
  // Candle data
  timeframe: text("timeframe").notNull(), // 1m, 5m, 15m, 1h, 4h, 1d
  timestamp: integer("timestamp").notNull(), // candle open time
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume"),
  
  // Source
  source: text("source").default("dexscreener"), // dexscreener, geckoterminal, webhook_derived
  fetchedAt: integer("fetched_at").notNull(),
});

export const insertPriceHistoryCacheSchema = createInsertSchema(priceHistoryCache).omit({ id: true });
export type PriceHistoryCacheEntry = typeof priceHistoryCache.$inferSelect;
export type InsertPriceHistoryCacheEntry = z.infer<typeof insertPriceHistoryCacheSchema>;

// Work queue for crowdsourced frontend fetching
export const fetchWorkQueue = pgTable("fetch_work_queue", {
  id: serial("id").primaryKey(),
  
  // What to fetch
  resourceType: text("resource_type").notNull(), // price_history, token_metadata
  tokenMint: text("token_mint").notNull(),
  
  // Request details
  priority: integer("priority").default(50), // higher = more urgent
  requestedBy: integer("requested_by"), // userId who triggered the need
  
  // Status
  status: text("status").notNull().default("pending"), // pending, claimed, completed, failed
  claimedBy: integer("claimed_by"), // userId who is fetching
  claimedAt: integer("claimed_at"),
  
  // Result
  completedAt: integer("completed_at"),
  errorMessage: text("error_message"),
  
  // Timing
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"), // auto-cancel if not claimed
});

export const insertFetchWorkQueueSchema = createInsertSchema(fetchWorkQueue).omit({ id: true });
export type FetchWorkQueueItem = typeof fetchWorkQueue.$inferSelect;
export type InsertFetchWorkQueueItem = z.infer<typeof insertFetchWorkQueueSchema>;

// Surplus pool - tracks pooled surplus credits for sharing
export const surplusPool = pgTable("surplus_pool", {
  id: serial("id").primaryKey(),
  month: text("month").notNull().unique(), // YYYY-MM format
  
  // Pool totals
  totalSurplus: integer("total_surplus").default(0), // sum of all user surpluses
  throttledUserAllocation: integer("throttled_user_allocation").default(0), // 50% for throttled users
  discoveryAllocation: integer("discovery_allocation").default(0), // 50% for discovery
  
  // Usage tracking
  throttledUsed: integer("throttled_used").default(0),
  discoveryUsed: integer("discovery_used").default(0),
  
  // Contributing users
  contributorCount: integer("contributor_count").default(0),
  borrowerCount: integer("borrower_count").default(0),
  
  // Timestamps
  lastCalculatedAt: integer("last_calculated_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertSurplusPoolSchema = createInsertSchema(surplusPool).omit({ id: true });
export type SurplusPoolEntry = typeof surplusPool.$inferSelect;
export type InsertSurplusPoolEntry = z.infer<typeof insertSurplusPoolSchema>;

// =====================
// PAPER TRADING SCHEMA
// =====================

// Wallet strategies - Pincher's learned patterns for each signal wallet
export const walletStrategies = pgTable("wallet_strategies", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  userId: integer("user_id").notNull(),
  
  // Strategy classification
  strategyType: text("strategy_type"), // momentum, swing, pump_fun, sniper
  tradingStyle: text("trading_style"), // aggressive, conservative, balanced
  
  // Learned parameters
  avgHoldDuration: integer("avg_hold_duration"), // seconds
  avgPositionSize: real("avg_position_size"), // in SOL
  winRate: real("win_rate"), // 0.0-1.0
  avgProfit: real("avg_profit"),
  avgLoss: real("avg_loss"),
  profitFactor: real("profit_factor"),
  
  // Entry patterns
  preferredEntryTime: text("preferred_entry_time"),
  entryTokenAge: text("entry_token_age"), // fresh, established, mature
  entryMarketCap: text("entry_market_cap"), // micro, small, mid
  
  // Exit patterns
  takeProfitMultiplier: real("take_profit_multiplier"),
  stopLossPercent: real("stop_loss_percent"),
  trailingSellEnabled: boolean("trailing_sell_enabled"),
  
  // Risk profile
  riskLevel: integer("risk_level"), // 1-10
  diversification: real("diversification"),
  maxConcurrentPositions: integer("max_concurrent_positions"),
  
  // Confidence
  confidenceScore: real("confidence_score").default(0),
  sampleSize: integer("sample_size").default(0),
  lastUpdatedAt: integer("last_updated_at"),
  version: integer("version").default(1),
  createdAt: integer("created_at").notNull(),
  
  // AI-generated recommendations from Miss Pincher
  aiRecommendations: text("ai_recommendations"),
  
  // Cache invalidation - track swap count at time of analysis
  swapCountAtAnalysis: integer("swap_count_at_analysis"),
  
  // Discovery insights context
  behaviorType: text("behavior_type"), // bot, leader, follower, organic, unknown
  behaviorConfidence: real("behavior_confidence"),
  discoveryInsights: text("discovery_insights"), // JSON array of relevant insights
});

export const insertWalletStrategiesSchema = createInsertSchema(walletStrategies).omit({ id: true });
export type WalletStrategy = typeof walletStrategies.$inferSelect;
export type InsertWalletStrategy = z.infer<typeof insertWalletStrategiesSchema>;

// Paper positions - simulated trades
export const paperPositions = pgTable("paper_positions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  
  // Position details
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  tokenName: text("token_name"),
  
  // Entry
  entryPrice: real("entry_price").notNull(),
  entrySol: real("entry_sol").notNull(),
  entryTokens: real("entry_tokens").notNull(),
  entryTimestamp: integer("entry_timestamp").notNull(),
  entryTxSignature: text("entry_tx_signature"),
  
  // Exit
  exitPrice: real("exit_price"),
  exitSol: real("exit_sol"),
  exitTimestamp: integer("exit_timestamp"),
  exitTxSignature: text("exit_tx_signature"),
  exitReason: text("exit_reason"), // take_profit, stop_loss, mirror_sell, manual
  
  // P&L
  realizedPnl: real("realized_pnl"),
  realizedPnlPercent: real("realized_pnl_percent"),
  highestPrice: real("highest_price"),
  lowestPrice: real("lowest_price"),
  
  // Source
  strategyId: integer("strategy_id"),
  signalWallet: text("signal_wallet"),
  experimentId: integer("experiment_id"),
  
  // Paper trade type for learning system
  paperTradeType: text("paper_trade_type").default("manual"), // "manual" | "experiment" | "best_theory"
  metaExperimentId: text("meta_experiment_id"), // Links to meta_experiments for experiment types
  theoryId: text("theory_id"), // Links to winning theories for best_theory type
  experimentVariant: text("experiment_variant"), // "control" | "variant" for A/B experiments
  
  // Config at entry
  takeProfitMultiplier: real("take_profit_multiplier"),
  stopLossPercent: real("stop_loss_percent"),
  trailingStop: boolean("trailing_stop"),
  
  // Status
  status: text("status").notNull().default("open"), // open, closed, expired
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertPaperPositionsSchema = createInsertSchema(paperPositions).omit({ id: true });
export type PaperPosition = typeof paperPositions.$inferSelect;
export type InsertPaperPosition = z.infer<typeof insertPaperPositionsSchema>;

// Strategy experiments - A/B testing
export const strategyExperiments = pgTable("strategy_experiments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  
  name: text("name").notNull(),
  description: text("description"),
  
  // What to test
  signalWallet: text("signal_wallet"),
  strategyId: integer("strategy_id"),
  
  // Control vs variant
  controlConfig: text("control_config"), // JSON
  variantConfig: text("variant_config"), // JSON
  
  // Budget
  paperBudgetSol: real("paper_budget_sol").notNull(),
  usedBudgetSol: real("used_budget_sol").default(0),
  
  // Results
  tradesControl: integer("trades_control").default(0),
  tradesVariant: integer("trades_variant").default(0),
  pnlControl: real("pnl_control").default(0),
  pnlVariant: real("pnl_variant").default(0),
  winRateControl: real("win_rate_control"),
  winRateVariant: real("win_rate_variant"),
  
  // Statistics
  pValue: real("p_value"),
  confidenceLevel: real("confidence_level"),
  
  // Duration
  startedAt: integer("started_at").notNull(),
  endsAt: integer("ends_at"),
  endedAt: integer("ended_at"),
  
  // Status
  status: text("status").notNull().default("active"), // active, paused, completed
  winner: text("winner"), // control, variant, inconclusive
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertStrategyExperimentsSchema = createInsertSchema(strategyExperiments).omit({ id: true });
export type StrategyExperiment = typeof strategyExperiments.$inferSelect;
export type InsertStrategyExperiment = z.infer<typeof insertStrategyExperimentsSchema>;

// =============================================
// PHASE E: DISCOVERY & AI LEARNING
// =============================================

// Discovery triggers - configurable thresholds that fire discovery events
export const discoveryTriggers = pgTable("discovery_triggers", {
  id: serial("id").primaryKey(),
  
  // Trigger identification
  name: text("name").notNull(),
  description: text("description"),
  metric: text("metric").notNull(), // price_surge, volume_spike, whale_buy, cluster_activity, heat_score, holder_growth
  
  // Threshold configuration
  threshold: real("threshold").notNull(), // Value to exceed
  timeWindowMinutes: integer("time_window_minutes").default(60), // Lookback window
  operator: text("operator").notNull().default("gte"), // gte, lte, eq, change_pct
  
  // Priority and cooldowns
  priority: integer("priority").notNull().default(50), // 1-100, higher = more important
  cooldownMinutes: integer("cooldown_minutes").default(30), // Min time between fires per token
  
  // AI evolution tracking
  isAiProposed: boolean("is_ai_proposed").default(false),
  shadowMode: boolean("shadow_mode").default(false), // Tracks but doesn't act
  promotedAt: integer("promoted_at"), // When shadow->active
  parentTriggerId: integer("parent_trigger_id"), // For AI-evolved variants
  
  // Performance stats
  fireCount: integer("fire_count").default(0),
  truePositives: integer("true_positives").default(0), // Led to profit
  falsePositives: integer("false_positives").default(0), // Led to loss
  precision: real("precision"), // TP / (TP + FP)
  
  // Dampening
  currentWeight: real("current_weight").default(1.0),
  dampeningFactor: real("dampening_factor").default(0.1), // How fast weights change
  explorationPhase: boolean("exploration_phase").default(true), // Fast learning
  
  // Status
  enabled: boolean("enabled").default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertDiscoveryTriggersSchema = createInsertSchema(discoveryTriggers).omit({ id: true });
export type DiscoveryTrigger = typeof discoveryTriggers.$inferSelect;
export type InsertDiscoveryTrigger = z.infer<typeof insertDiscoveryTriggersSchema>;

// Discovery events - fired when triggers match
export const discoveryEvents = pgTable("discovery_events", {
  id: serial("id").primaryKey(),
  
  triggerId: integer("trigger_id").notNull(),
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  
  // Event context
  metricValue: real("metric_value").notNull(), // Actual value that triggered
  threshold: real("threshold").notNull(), // Threshold at fire time
  priority: integer("priority").notNull(),
  
  // Market snapshot at discovery
  priceAtDiscovery: real("price_at_discovery"),
  marketCapAtDiscovery: real("market_cap_at_discovery"),
  liquidityAtDiscovery: real("liquidity_at_discovery"),
  volumeAtDiscovery: real("volume_at_discovery"),
  
  // Outcome tracking
  priceAfter1h: real("price_after_1h"),
  priceAfter4h: real("price_after_4h"),
  priceAfter24h: real("price_after_24h"),
  outcome: text("outcome"), // profit, loss, neutral, pending
  outcomePercent: real("outcome_percent"),
  
  // Actions taken
  paperPositionId: integer("paper_position_id"),
  wasActedUpon: boolean("was_acted_upon").default(false),
  
  // Status
  status: text("status").notNull().default("pending"), // pending, tracked, expired
  firedAt: integer("fired_at").notNull(),
  expiresAt: integer("expires_at"),
  evaluatedAt: integer("evaluated_at"),
});

export type DiscoveryEvent = typeof discoveryEvents.$inferSelect;

// Discovery metrics - self-evolving metric definitions
export const discoveryMetrics = pgTable("discovery_metrics", {
  id: serial("id").primaryKey(),
  
  name: text("name").notNull().unique(), // price_surge, volume_spike, etc.
  description: text("description"),
  
  // Calculation method
  calculationType: text("calculation_type").notNull(), // absolute, percent_change, ratio, composite
  formula: text("formula"), // For composite: JSON of sub-metrics
  
  // Data sources
  primarySource: text("primary_source").notNull(), // token_data_pool, swap_history, holder_cache
  updateFrequency: integer("update_frequency_seconds").default(60),
  
  // Performance baseline
  baselineHitRate: real("baseline_hit_rate"), // Expected precision
  currentHitRate: real("current_hit_rate"),
  sampleSize: integer("sample_size").default(0),
  
  // AI proposals for improvement
  proposedVariants: text("proposed_variants"), // JSON array of AI-proposed tweaks
  
  // Status
  isCore: boolean("is_core").default(false), // Built-in vs AI-created
  enabled: boolean("enabled").default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export type DiscoveryMetric = typeof discoveryMetrics.$inferSelect;

// Regime detection - market condition tracking
export const marketRegimes = pgTable("market_regimes", {
  id: serial("id").primaryKey(),
  
  // Regime identification
  name: text("name").notNull(), // bull, bear, crab, volatile, quiet
  
  // Detection criteria
  solPriceChangeThreshold: real("sol_price_change_threshold"), // e.g., +10% = bull
  volumeRatioThreshold: real("volume_ratio_threshold"), // Current vs avg
  volatilityThreshold: real("volatility_threshold"),
  
  // Current regime tracking
  detectedAt: integer("detected_at"),
  confidence: real("confidence"),
  duration: integer("duration_minutes"),
  
  // Performance by regime
  avgTriggerPrecision: real("avg_trigger_precision"),
  avgOutcomePercent: real("avg_outcome_percent"),
  sampleSize: integer("sample_size").default(0),
  
  // Recommended adjustments
  thresholdMultiplier: real("threshold_multiplier").default(1.0), // Scale triggers in this regime
  cooldownMultiplier: real("cooldown_multiplier").default(1.0),
  
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export type MarketRegime = typeof marketRegimes.$inferSelect;

// Discovery job runs - hourly/daily job tracking
export const discoveryJobRuns = pgTable("discovery_job_runs", {
  id: serial("id").primaryKey(),
  
  jobType: text("job_type").notNull(), // hourly_monitor, daily_tune, regime_detect
  
  // Run details
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
  
  // Stats
  triggersEvaluated: integer("triggers_evaluated").default(0),
  eventsFired: integer("events_fired").default(0),
  outcomesUpdated: integer("outcomes_updated").default(0),
  thresholdsAdjusted: integer("thresholds_adjusted").default(0),
  
  // Regime at run time
  currentRegime: text("current_regime"),
  
  // Summary
  summary: text("summary"), // JSON of key findings
  status: text("status").notNull().default("running"), // running, completed, failed
  error: text("error"),
});

// Whale clusters - groups of wallets that trade together
export const whaleClusters = pgTable("whale_clusters", {
  id: serial("id").primaryKey(),
  
  // Cluster membership - stored as array of wallet addresses
  memberAddresses: jsonb("member_addresses").$type<string[]>().notNull(),
  memberCount: integer("member_count").notNull().default(0),
  
  // Formation tracking
  firstSeenTogether: integer("first_seen_together").notNull(),
  lastSeenTogether: integer("last_seen_together").notNull(),
  coordinatedEventCount: integer("coordinated_event_count").default(0),
  
  // Behavioral classification
  clusterType: text("cluster_type"), // bot_ring, copytrade_group, whale_pod, organic_herd
  typeConfidence: real("type_confidence"), // 0-1 confidence in classification
  
  // Performance tracking
  totalTokensTraded: integer("total_tokens_traded").default(0),
  profitableTokens: integer("profitable_tokens").default(0),
  avgExitMultiplier: real("avg_exit_multiplier"),
  
  // Derived metrics
  clusterSuccessRate: real("cluster_success_rate"), // profitableTokens / totalTokensTraded
  reliabilityScore: real("reliability_score").default(50), // 0-100 composite
  
  // Status
  isActive: boolean("is_active").default(true),
  lastActivityAt: integer("last_activity_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertWhaleClusterSchema = createInsertSchema(whaleClusters).omit({ id: true });
export type WhaleCluster = typeof whaleClusters.$inferSelect;
export type InsertWhaleCluster = z.infer<typeof insertWhaleClusterSchema>;

// Cluster outcomes - P&L tracking per cluster per token
export const clusterOutcomes = pgTable("cluster_outcomes", {
  id: serial("id").primaryKey(),
  clusterId: integer("cluster_id").notNull(), // References whale_clusters.id
  tokenMint: text("token_mint").notNull(),
  tokenSymbol: text("token_symbol"),
  
  // Entry data
  entryTimestamp: integer("entry_timestamp").notNull(),
  entryPriceUsd: real("entry_price_usd"),
  entryMarketCap: real("entry_market_cap"),
  membersEntered: integer("members_entered").default(0),
  
  // Exit data
  exitTimestamp: integer("exit_timestamp"),
  exitPriceUsd: real("exit_price_usd"),
  avgExitMultiplier: real("avg_exit_multiplier"),
  membersExited: integer("members_exited").default(0),
  
  // Outcome
  outcome: text("outcome"), // win, loss, partial, still_holding
  peakMultiplier: real("peak_multiplier"),
  
  createdAt: integer("created_at").notNull(),
});

export const insertClusterOutcomeSchema = createInsertSchema(clusterOutcomes).omit({ id: true });
export type ClusterOutcome = typeof clusterOutcomes.$inferSelect;
export type InsertClusterOutcome = z.infer<typeof insertClusterOutcomeSchema>;

// Wallet fingerprints - behavioral signatures for signal wallets
export const walletFingerprints = pgTable("wallet_fingerprints", {
  id: serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  
  // Time in market behavior
  avgHoldDurationMinutes: integer("avg_hold_duration_minutes"),
  holdDurationStdDev: real("hold_duration_std_dev"), // Consistency measure
  shortestHold: integer("shortest_hold"), // minutes
  longestHold: integer("longest_hold"), // minutes
  
  // Size discipline
  avgEntrySizeUsd: real("avg_entry_size_usd"),
  entrySizeStdDev: real("entry_size_std_dev"), // Consistency measure
  avgEntryPercent: real("avg_entry_percent"), // Percent of wallet used per trade
  
  // Sell patterns
  partialSellRate: real("partial_sell_rate"), // % of trades with partial sells
  avgSellTiers: real("avg_sell_tiers"), // Average number of sell tranches
  rageExitRate: real("rage_exit_rate"), // % of positions sold all at once at loss
  
  // Timing signals
  preVolumeBuyRate: real("pre_volume_buy_rate"), // % of buys before volume spikes
  avgEntryToVolumeSpike: integer("avg_entry_to_volume_spike"), // seconds before spike
  
  // Playbook consistency
  playbookScore: real("playbook_score"), // 0-100, how consistent is behavior
  regimeAdaptation: real("regime_adaptation"), // Changes behavior in different markets?
  
  // Chaos avoidance
  tradesInChaos: integer("trades_in_chaos").default(0), // Trades during high volatility
  totalTrades: integer("total_trades").default(0),
  chaosAvoidanceScore: real("chaos_avoidance_score"), // Higher = avoids chaos
  
  // Crowding risk
  copyingUsersCount: integer("copying_users_count").default(0),
  alphaDecayFactor: real("alpha_decay_factor"), // How fast alpha decays when copied
  
  // Metadata
  firstAnalyzedAt: integer("first_analyzed_at").notNull(),
  lastUpdatedAt: integer("last_updated_at").notNull(),
  sampleSize: integer("sample_size").default(0), // Number of trades analyzed
});

export const insertWalletFingerprintSchema = createInsertSchema(walletFingerprints).omit({ id: true });
export type WalletFingerprint = typeof walletFingerprints.$inferSelect;
export type InsertWalletFingerprint = z.infer<typeof insertWalletFingerprintSchema>;

// API health tracking - per-source reliability metrics
export const apiHealthMetrics = pgTable("api_health_metrics", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().unique(), // rugcheck, goplus, dexscreener, helius
  
  // Response metrics (rolling 1hr)
  avgResponseTimeMs: integer("avg_response_time_ms"),
  successRate: real("success_rate"), // 0-1
  errorCount: integer("error_count").default(0),
  requestCount: integer("request_count").default(0),
  
  // Rate limit tracking
  rateLimitHits: integer("rate_limit_hits").default(0),
  lastRateLimitAt: integer("last_rate_limit_at"),
  
  // Fallback priority (auto-adjusted)
  fallbackPriority: integer("fallback_priority").default(1), // Lower = preferred
  
  // Timestamps
  lastSuccessAt: integer("last_success_at"),
  lastErrorAt: integer("last_error_at"),
  updatedAt: integer("updated_at").notNull(),
});

export type ApiHealthMetric = typeof apiHealthMetrics.$inferSelect;

// ============ Vector Routing System ============

// Route intents - self-optimizing intent vectors for chat routing cascade
export const routeIntents = pgTable("route_intents", {
  id: serial("id").primaryKey(),
  intent: text("intent").notNull().unique(), // casual, safety, wallet, strategy, trading
  
  // Intent vector (embedding that evolves)
  vector: jsonb("vector").$type<number[]>().default([]), // 384-dim or similar
  vectorDimension: integer("vector_dimension").default(384),
  
  // What vectors to load when this intent matches
  vectorNeeds: jsonb("vector_needs").$type<string[]>().default([]), // ["safety", "behavior"] etc
  
  // Tier 1: Exact keyword cache (fastest, no API)
  tier1Keywords: jsonb("tier_1_keywords").$type<string[]>().default([]), // ["safe", "rug", "honeypot"]
  
  // Learning metrics
  hitCount: integer("hit_count").default(0),
  confidence: real("confidence").default(0.5), // 0-1
  lastMatchScore: real("last_match_score"), // most recent cosine similarity
  
  // Dampening for stability
  dampingFactor: real("damping_factor").default(0.95), // high usage = stable
  learningRate: real("learning_rate").default(0.1),
  
  // Origin tracking
  createdBy: text("created_by").default("manual"), // "manual" | "system"
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertRouteIntentSchema = createInsertSchema(routeIntents).omit({ id: true });
export type RouteIntent = typeof routeIntents.$inferSelect;
export type InsertRouteIntent = z.infer<typeof insertRouteIntentSchema>;

// Strategy clusters - groups of signal wallets with similar trading patterns
export const strategyClusters = pgTable("strategy_clusters", {
  id: serial("id").primaryKey(),
  clusterId: text("cluster_id").notNull().unique(), // unique cluster identifier
  
  // Pattern identification
  pattern: text("pattern").notNull(), // momentum, swing, pump_specialist, sniper, whale_follower
  patternDescription: text("pattern_description"), // human-readable description
  
  // Wallet membership
  walletAddresses: jsonb("wallet_addresses").$type<string[]>().default([]),
  walletCount: integer("wallet_count").default(0),
  
  // Cluster vector (for similarity matching new wallets)
  vector: jsonb("vector").$type<number[]>().default([]),
  vectorDimension: integer("vector_dimension").default(384),
  
  // Outcomes tracking
  outcomes: jsonb("outcomes").$type<{
    totalTrades: number;
    wins: number;
    losses: number;
    avgPnlPercent: number;
    totalPnlSol: number;
    winRate: number;
    bestTrade: { token: string; pnlPercent: number; timestamp: number } | null;
    worstTrade: { token: string; pnlPercent: number; timestamp: number } | null;
  }>().default({
    totalTrades: 0, wins: 0, losses: 0, avgPnlPercent: 0,
    totalPnlSol: 0, winRate: 0, bestTrade: null, worstTrade: null
  }),
  
  // Learning metrics
  confidence: real("confidence").default(0.5),
  stabilityScore: real("stability_score"), // how consistent are outcomes
  sampleSize: integer("sample_size").default(0),
  
  // Origin tracking
  createdBy: text("created_by").default("manual"), // "manual" | "system"
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertStrategyClusterSchema = createInsertSchema(strategyClusters).omit({ id: true });
export type StrategyCluster = typeof strategyClusters.$inferSelect;
export type InsertStrategyCluster = z.infer<typeof insertStrategyClusterSchema>;

// Vector updates - 8-hour bucket aggregation for batch vector updates
export const vectorUpdates = pgTable("vector_updates", {
  id: serial("id").primaryKey(),
  
  // Target identification
  vectorType: text("vector_type").notNull(), // route_intent, behavior, strategy, memory
  targetId: text("target_id").notNull(), // intent name, userId, clusterId, etc
  
  // Signal data
  signalType: text("signal_type").notNull(), // route_success, route_fail, trade_win, trade_loss, chat_interaction
  signalData: jsonb("signal_data").$type<Record<string, any>>(), // raw signal payload
  
  // Embedding (if applicable)
  embedding: jsonb("embedding").$type<number[]>(), // message embedding for route updates
  
  // Weight factors
  weight: real("weight").default(1.0), // engagement weight (trade=3, chat=1, passive=0.5)
  
  // Bucket assignment
  bucketId: text("bucket_id").notNull(), // YYYY-MM-DD-HH (8-hour buckets: 00, 08, 16)
  
  // Processing status
  processed: boolean("processed").default(false),
  processedAt: integer("processed_at"),
  
  // Timestamp
  createdAt: integer("created_at").notNull(),
});

export const insertVectorUpdateSchema = createInsertSchema(vectorUpdates).omit({ id: true });
export type VectorUpdate = typeof vectorUpdates.$inferSelect;
export type InsertVectorUpdate = z.infer<typeof insertVectorUpdateSchema>;

// Discovery sources - self-optimizing discovery channels
export const discoverySources = pgTable("discovery_sources", {
  id: serial("id").primaryKey(),
  sourceId: text("source_id").notNull().unique(),
  
  // Source type and details
  sourceType: text("source_type").notNull(), // dexscreener_new, dexscreener_gainers, twitter, telegram, whale_follows
  sourceConfig: jsonb("source_config").$type<Record<string, any>>(), // specific source params
  
  // Intent vector (embedding for similarity matching)
  vector: jsonb("vector").$type<number[]>().default([]),
  vectorDimension: integer("vector_dimension").default(384),
  
  // Performance metrics
  successRate: real("success_rate").default(0), // wins / total discoveries
  sampleCount: integer("sample_count").default(0),
  avgPnlPercent: real("avg_pnl_percent").default(0),
  bestDiscovery: jsonb("best_discovery").$type<{ tokenMint: string; pnl: number; date: number }>(),
  
  // Learning metrics
  confidence: real("confidence").default(0.5),
  dampingFactor: real("damping_factor").default(0.95),
  learningRate: real("learning_rate").default(0.1),
  
  // Status
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(50), // 1-100, higher = more likely to be selected
  
  // Origin tracking
  createdBy: text("created_by").default("manual"), // "manual" | "system"
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertDiscoverySourceSchema = createInsertSchema(discoverySources).omit({ id: true });
export type DiscoverySource = typeof discoverySources.$inferSelect;
export type InsertDiscoverySource = z.infer<typeof insertDiscoverySourceSchema>;

// Discovery experiments - tracks primary vs experiment outcomes
export const discoveryExperiments = pgTable("discovery_experiments", {
  id: serial("id").primaryKey(),
  experimentId: text("experiment_id").notNull().unique(),
  
  // Token discovered
  tokenMint: text("token_mint").notNull(),
  
  // Sources compared
  primarySourceId: text("primary_source_id").notNull(), // best strategy source
  experimentSourceId: text("experiment_source_id"), // experiment source (if any)
  
  // Allocation
  primaryAllocation: real("primary_allocation").notNull(), // e.g., 0.9 for 90%
  experimentAllocation: real("experiment_allocation"), // e.g., 0.1 for 10%
  
  // Outcomes
  primaryOutcome: jsonb("primary_outcome").$type<{
    executed: boolean;
    pnlPercent: number | null;
    holdTimeMinutes: number | null;
  }>(),
  experimentOutcome: jsonb("experiment_outcome").$type<{
    executed: boolean;
    pnlPercent: number | null;
    holdTimeMinutes: number | null;
  }>(),
  
  // Which performed better
  winner: text("winner"), // "primary" | "experiment" | "both" | "neither"
  
  // Status
  status: text("status").default("pending"), // pending, active, completed
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

export const insertDiscoveryExperimentSchema = createInsertSchema(discoveryExperiments).omit({ id: true });
export type DiscoveryExperiment = typeof discoveryExperiments.$inferSelect;
export type InsertDiscoveryExperiment = z.infer<typeof insertDiscoveryExperimentSchema>;

// Discovery config - global discovery settings with self-optimizing ratio
export const discoveryConfig = pgTable("discovery_config", {
  id: serial("id").primaryKey(),
  configKey: text("config_key").notNull().unique(), // "global" or user-specific
  
  // Explore/exploit ratio (self-optimizing within bounds)
  exploreRatio: real("explore_ratio").default(0.1), // current ratio
  exploreRatioMin: real("explore_ratio_min").default(0.1), // floor: 10%
  exploreRatioMax: real("explore_ratio_max").default(0.5), // ceiling: 50%
  
  // Adjustment signals
  exploitWinRate: real("exploit_win_rate").default(0), // recent exploit performance
  exploreWinRate: real("explore_win_rate").default(0), // recent explore performance
  
  // Vector creation threshold
  vectorCreationThreshold: real("vector_creation_threshold").default(0.7), // confidence needed to spawn new vector
  vectorPruneThreshold: real("vector_prune_threshold").default(0.2), // below this, system vectors get pruned
  
  // Adjustment history (for learning from ratio changes)
  adjustmentHistory: jsonb("adjustment_history").$type<Array<{
    timestamp: number;
    oldRatio: number;
    newRatio: number;
    reason: string;
    outcomeImproved: boolean | null;
  }>>().default([]),
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertDiscoveryConfigSchema = createInsertSchema(discoveryConfig).omit({ id: true });
export type DiscoveryConfig = typeof discoveryConfig.$inferSelect;
export type InsertDiscoveryConfig = z.infer<typeof insertDiscoveryConfigSchema>;

// Emergent patterns - tracks patterns that don't match existing vectors
export const emergentPatterns = pgTable("emergent_patterns", {
  id: serial("id").primaryKey(),
  patternId: text("pattern_id").notNull().unique(),
  
  // Pattern type
  patternType: text("pattern_type").notNull(), // discovery_source, strategy, route_intent
  
  // Pattern characteristics
  patternSignature: jsonb("pattern_signature").$type<Record<string, any>>(), // distinguishing features
  embedding: jsonb("embedding").$type<number[]>(), // vector representation
  
  // Evidence
  occurrenceCount: integer("occurrence_count").default(1),
  examples: jsonb("examples").$type<Array<{ tokenMint?: string; message?: string; outcome?: any }>>().default([]),
  
  // Confidence (when reaches threshold, spawns new vector)
  confidence: real("confidence").default(0),
  confidenceThreshold: real("confidence_threshold").default(0.7),
  
  // Status
  status: text("status").default("tracking"), // tracking, promoted, rejected
  promotedToId: text("promoted_to_id"), // ID of created vector if promoted
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
});

export const insertEmergentPatternSchema = createInsertSchema(emergentPatterns).omit({ id: true });
export type EmergentPattern = typeof emergentPatterns.$inferSelect;
export type InsertEmergentPattern = z.infer<typeof insertEmergentPatternSchema>;

// Heat factor config - self-learning heat score weights
export const heatFactorConfig = pgTable("heat_factor_config", {
  id: serial("id").primaryKey(),
  configKey: text("config_key").notNull().unique(), // "global" or user-specific
  
  // Factor weights (must sum to ~1.0)
  recentBuysWeight: real("recent_buys_weight").default(0.25),
  volatilityWeight: real("volatility_weight").default(0.20),
  userAttentionWeight: real("user_attention_weight").default(0.20),
  recencyWeight: real("recency_weight").default(0.15),
  whaleActivityWeight: real("whale_activity_weight").default(0.20),
  discoveryQualityWeight: real("discovery_quality_weight").default(0), // new factor, starts at 0
  
  // Weight bounds (min/max for each factor)
  weightBounds: jsonb("weight_bounds").$type<Record<string, { min: number; max: number }>>().default({
    recentBuys: { min: 0.05, max: 0.40 },
    volatility: { min: 0.05, max: 0.35 },
    userAttention: { min: 0.05, max: 0.35 },
    recency: { min: 0.05, max: 0.30 },
    whaleActivity: { min: 0.05, max: 0.35 },
    discoveryQuality: { min: 0, max: 0.25 }
  }),
  
  // Learning metrics per factor
  factorPerformance: jsonb("factor_performance").$type<Record<string, {
    winCorrelation: number;
    sampleCount: number;
    confidence: number;
  }>>().default({}),
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
});

export const insertHeatFactorConfigSchema = createInsertSchema(heatFactorConfig).omit({ id: true });
export type HeatFactorConfig = typeof heatFactorConfig.$inferSelect;
export type InsertHeatFactorConfig = z.infer<typeof insertHeatFactorConfigSchema>;

// ============================================================================
// APP INTELLIGENCE LAYER - Meta-optimization and emergent strategy system
// ============================================================================

// System events - unified event log for cross-system correlation
export const systemEvents = pgTable("system_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(), // nanoid
  
  // Event classification
  eventType: text("event_type").notNull(), // discovery_fired, heat_calculated, copy_executed, ai_recommendation, trade_opened, trade_closed, whale_detected, etc.
  sourceSystem: text("source_system").notNull(), // discovery, heat_score, copy_trading, ai_chat, paper_trading, strategy_cluster, etc.
  targetSystem: text("target_system"), // system that was affected (if any)
  
  // Context
  userId: integer("user_id"), // null for system-level events
  tokenMint: text("token_mint"),
  walletAddress: text("wallet_address"),
  positionId: integer("position_id"),
  correlationId: text("correlation_id"), // links related events across systems
  
  // Event data
  payload: jsonb("payload").$type<Record<string, any>>(), // event-specific data
  metrics: jsonb("metrics").$type<Record<string, number>>(), // numeric metrics for correlation analysis
  
  // Outcome tracking (updated later)
  outcomeType: text("outcome_type"), // win, loss, neutral, pending
  outcomePnl: real("outcome_pnl"),
  outcomeRecordedAt: integer("outcome_recorded_at"),
  
  // Timestamps
  timestamp: integer("timestamp").notNull(),
  bucketId: text("bucket_id"), // 8-hour bucket for aggregation
});

export const insertSystemEventSchema = createInsertSchema(systemEvents).omit({ id: true });
export type SystemEvent = typeof systemEvents.$inferSelect;
export type InsertSystemEvent = z.infer<typeof insertSystemEventSchema>;

// Meta experiments - system-level A/B tests for cross-system optimization
export const metaExperiments = pgTable("meta_experiments", {
  id: serial("id").primaryKey(),
  experimentId: text("experiment_id").notNull().unique(), // nanoid
  
  // Experiment definition
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(), // "Increasing heat threshold with whale activity improves win rate"
  experimentType: text("experiment_type").notNull(), // parameter_tuning, rule_testing, system_interaction
  
  // Target systems
  targetSystems: jsonb("target_systems").$type<string[]>().default([]), // which systems are being tested
  
  // Configurations
  controlConfig: jsonb("control_config").$type<Record<string, any>>(), // current/baseline config
  variantConfig: jsonb("variant_config").$type<Record<string, any>>(), // new config to test
  
  // Assignment
  assignmentRatio: real("assignment_ratio").default(0.5), // % assigned to variant
  
  // Metrics
  controlTrades: integer("control_trades").default(0),
  variantTrades: integer("variant_trades").default(0),
  controlWinRate: real("control_win_rate").default(0),
  variantWinRate: real("variant_win_rate").default(0),
  controlPnl: real("control_pnl").default(0),
  variantPnl: real("variant_pnl").default(0),
  
  // Statistical significance
  pValue: real("p_value"),
  confidenceLevel: real("confidence_level"),
  minSampleSize: integer("min_sample_size").default(20),
  
  // Status
  status: text("status").default("active"), // active, paused, completed, promoted, discarded
  winner: text("winner"), // control, variant, inconclusive
  
  // Timing
  startedAt: integer("started_at").notNull(),
  endsAt: integer("ends_at"), // optional auto-end
  completedAt: integer("completed_at"),
  
  // Audit
  createdBy: text("created_by").default("system"), // system, user, ai
  promotedConfig: jsonb("promoted_config").$type<Record<string, any>>(), // final config if promoted
});

export const insertMetaExperimentSchema = createInsertSchema(metaExperiments).omit({ id: true });
export type MetaExperiment = typeof metaExperiments.$inferSelect;
export type InsertMetaExperiment = z.infer<typeof insertMetaExperimentSchema>;

// Emergent rules - AI-discovered trading rules with trigger/condition/action
export const emergentRules = pgTable("emergent_rules", {
  id: serial("id").primaryKey(),
  ruleId: text("rule_id").notNull().unique(), // nanoid
  
  // Rule identity
  name: text("name").notNull(), // AI-generated descriptive name
  description: text("description"), // Natural language explanation
  
  // Trigger - when to evaluate this rule
  triggerType: text("trigger_type").notNull(), // interval, event, threshold
  triggerConfig: jsonb("trigger_config").$type<{
    type: 'interval' | 'event' | 'threshold';
    intervalMinutes?: number; // for interval triggers
    eventType?: string; // for event triggers (whale_sell, volume_drop, etc.)
    metric?: string; // for threshold triggers
    threshold?: number;
    operator?: string; // gte, lte, gt, lt
  }>(),
  
  // Condition - what must be true (supports AND/OR/NOT composition)
  condition: jsonb("condition").$type<{
    operator: 'AND' | 'OR' | 'NOT' | 'SIMPLE';
    conditions?: any[]; // nested conditions for AND/OR
    metric?: string; // for SIMPLE conditions
    comparator?: string; // eq, gte, lte, gt, lt
    value?: number | string;
  }>(),
  
  // Action - what to do when triggered and condition met
  actionType: text("action_type").notNull(), // sell_percent, sell_all, adjust_stop, add_position, alert
  actionConfig: jsonb("action_config").$type<{
    type: 'sell_percent' | 'sell_all' | 'adjust_stop' | 'add_position' | 'alert';
    percent?: number; // for sell_percent
    stopLossPercent?: number; // for adjust_stop
    amount?: number; // for add_position
    message?: string; // for alert
  }>(),
  
  // Scope
  scope: text("scope").default("global"), // global, per_token, per_wallet, per_user
  appliesTo: jsonb("applies_to").$type<string[]>().default([]), // specific tokens/wallets if scoped
  
  // Learning metrics
  confidence: real("confidence").default(0), // 0-1 learned success rate
  sampleCount: integer("sample_count").default(0),
  winCount: integer("win_count").default(0),
  totalPnl: real("total_pnl").default(0),
  avgPnlPerTrade: real("avg_pnl_per_trade").default(0),
  
  // Origin tracking
  origin: text("origin").default("evolved"), // preset, evolved, ai_created, user_created
  parentRuleId: text("parent_rule_id"), // if evolved from another rule
  discoveredPattern: text("discovered_pattern"), // pattern that led to this rule
  
  // Status
  status: text("status").default("testing"), // testing, active, paused, deprecated
  enabled: boolean("enabled").default(true),
  paperOnly: boolean("paper_only").default(true), // only use for paper trading until proven
  
  // Promotion criteria
  minSampleForPromotion: integer("min_sample_for_promotion").default(20),
  minConfidenceForPromotion: real("min_confidence_for_promotion").default(0.6),
  promotedAt: integer("promoted_at"),
  
  // Timestamps
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at"),
  lastTriggeredAt: integer("last_triggered_at"),
});

export const insertEmergentRuleSchema = createInsertSchema(emergentRules).omit({ id: true });
export type EmergentRule = typeof emergentRules.$inferSelect;
export type InsertEmergentRule = z.infer<typeof insertEmergentRuleSchema>;

// System correlations - discovered relationships between system events
export const systemCorrelations = pgTable("system_correlations", {
  id: serial("id").primaryKey(),
  correlationId: text("correlation_id").notNull().unique(), // nanoid
  
  // Correlation definition
  sourceEventType: text("source_event_type").notNull(), // e.g., "discovery_fired"
  sourceSystem: text("source_system").notNull(),
  targetEventType: text("target_event_type").notNull(), // e.g., "trade_win"
  targetSystem: text("target_system").notNull(),
  
  // Conditions that strengthen correlation
  conditions: jsonb("conditions").$type<Array<{
    metric: string;
    operator: string;
    value: number | string;
  }>>().default([]),
  
  // Statistics
  occurrenceCount: integer("occurrence_count").default(0),
  correlationStrength: real("correlation_strength").default(0), // -1 to 1
  pValue: real("p_value"),
  
  // Outcome tracking
  positiveOutcomes: integer("positive_outcomes").default(0),
  negativeOutcomes: integer("negative_outcomes").default(0),
  avgPnlWhenPresent: real("avg_pnl_when_present"),
  avgPnlWhenAbsent: real("avg_pnl_when_absent"),
  
  // Status
  status: text("status").default("tracking"), // tracking, significant, actionable, deprecated
  actionableInsight: text("actionable_insight"), // AI-generated recommendation
  
  // Timestamps
  discoveredAt: integer("discovered_at").notNull(),
  lastUpdatedAt: integer("last_updated_at"),
  lastSeenAt: integer("last_seen_at"),
});

export const insertSystemCorrelationSchema = createInsertSchema(systemCorrelations).omit({ id: true });
export type SystemCorrelation = typeof systemCorrelations.$inferSelect;
export type InsertSystemCorrelation = z.infer<typeof insertSystemCorrelationSchema>;

// System-wide insights for bidirectional LLM <-> Trigger flow
export const systemInsights = pgTable("system_insights", {
  id: serial("id").primaryKey(),
  insightId: text("insight_id").notNull().unique(), // nanoid
  
  // Source and type
  sourceSystem: text("source_system").notNull(), // discovery, heat_score, ai_chat, rule_executor, whale_detection, etc.
  insightType: text("insight_type").notNull(), // pattern, recommendation, performance, warning, correlation
  
  // The insight content
  title: text("title").notNull(), // Short description
  payload: jsonb("payload").$type<{
    pattern?: string;
    signal?: string;
    metric?: string;
    value?: number;
    threshold?: number;
    recommendation?: string;
    relatedTokens?: string[];
    relatedWallets?: string[];
    ruleId?: string;
    [key: string]: any;
  }>().default({}),
  
  // Confidence and weight
  confidence: real("confidence").default(0.5), // 0-1
  sampleCount: integer("sample_count").default(1),
  
  // Targeting (null = global insight)
  tokenMint: text("token_mint"),
  walletAddress: text("wallet_address"),
  userId: integer("user_id"),
  
  // Lifecycle
  status: text("status").default("active"), // active, consumed, expired, archived
  consumedBy: text("consumed_by"), // Which system consumed this insight
  consumedAt: integer("consumed_at"),
  
  // Timestamps and decay
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"), // When insight should be ignored
  lastAccessedAt: integer("last_accessed_at"),
  accessCount: integer("access_count").default(0),
});

export const insertSystemInsightSchema = createInsertSchema(systemInsights).omit({ id: true });
export type SystemInsight = typeof systemInsights.$inferSelect;
export type InsertSystemInsight = z.infer<typeof insertSystemInsightSchema>;
