CREATE TABLE "active_token_trajectories" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"snapshot_sequence" integer NOT NULL,
	"snapshot_timestamp" integer NOT NULL,
	"token_age_minutes" real,
	"snapshot_trigger" text NOT NULL,
	"trigger_context" jsonb,
	"fingerprint_vector" vector(undefined) NOT NULL,
	"current_multiplier" real,
	"trade_count" integer,
	"holder_count" integer,
	"final_multiplier" real,
	"archive_reason" text,
	"archived_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "admin_api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"key_label" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"usage_count" integer DEFAULT 0,
	"last_used_at" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"priority" text DEFAULT 'normal',
	"target_user_id" integer,
	"created_by" integer NOT NULL,
	"created_at" integer NOT NULL,
	"expires_at" integer
);
--> statement-breakpoint
CREATE TABLE "admin_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" integer NOT NULL,
	"updated_by" integer,
	CONSTRAINT "admin_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ai_accuracy_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"total_predictions" integer DEFAULT 0,
	"resolved_predictions" integer DEFAULT 0,
	"accurate_predictions" integer DEFAULT 0,
	"overall_hit_rate" real,
	"bullish_predictions" integer DEFAULT 0,
	"bullish_accurate" integer DEFAULT 0,
	"bearish_predictions" integer DEFAULT 0,
	"bearish_accurate" integer DEFAULT 0,
	"avg_multiplier_on_wins" real,
	"avg_multiplier_on_losses" real,
	"avg_confidence" real,
	"last_7d_hit_rate" real,
	"last_30d_hit_rate" real,
	"high_confidence_hit_rate" real,
	"low_confidence_hit_rate" real,
	"last_updated" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"channel" text DEFAULT 'web',
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"estimated_cost_usd" real NOT NULL,
	"latency_ms" integer,
	"model" text DEFAULT 'gpt-4o-mini',
	"context" jsonb,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"snapshot_id" integer,
	"predicted_score" integer NOT NULL,
	"predicted_outcome" text NOT NULL,
	"confidence_level" real DEFAULT 0.5,
	"reasoning" text,
	"red_flags" jsonb,
	"green_flags" jsonb,
	"actual_outcome" text,
	"price_at_prediction" real,
	"price_at_resolution" real,
	"outcome_multiplier" real,
	"hold_time_minutes" integer,
	"was_accurate" boolean,
	"predicted_at" integer NOT NULL,
	"resolved_at" integer,
	"price_context_at" jsonb,
	"factors_snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE "api_budget_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"monthly_limit" integer DEFAULT 10000 NOT NULL,
	"daily_limit" integer DEFAULT 500 NOT NULL,
	"warning_threshold" integer DEFAULT 80 NOT NULL,
	"pause_threshold" integer DEFAULT 95 NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"updated_at" integer,
	CONSTRAINT "api_budget_config_service_unique" UNIQUE("service")
);
--> statement-breakpoint
CREATE TABLE "api_health_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"avg_response_time_ms" integer,
	"success_rate" real,
	"error_count" integer DEFAULT 0,
	"request_count" integer DEFAULT 0,
	"rate_limit_hits" integer DEFAULT 0,
	"last_rate_limit_at" integer,
	"fallback_priority" integer DEFAULT 1,
	"last_success_at" integer,
	"last_error_at" integer,
	"updated_at" integer NOT NULL,
	CONSTRAINT "api_health_metrics_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "api_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"endpoint" text NOT NULL,
	"success" boolean NOT NULL,
	"latency_ms" integer,
	"status_code" integer,
	"context" jsonb,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"request_type" text NOT NULL,
	"service" text NOT NULL,
	"endpoint" text NOT NULL,
	"payload" jsonb,
	"priority" integer DEFAULT 50 NOT NULL,
	"is_ui_active" boolean DEFAULT false,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_for" integer,
	"result" jsonb,
	"error_message" text,
	"credits_used" integer,
	"created_at" integer NOT NULL,
	"started_at" integer,
	"completed_at" integer
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"endpoint" text,
	"call_count" integer DEFAULT 1 NOT NULL,
	"timestamp" integer NOT NULL,
	"date" text NOT NULL,
	"month" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomous_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"enabled" boolean DEFAULT false,
	"enabled_at" integer,
	"risk_profile" text DEFAULT 'balanced',
	"max_open_positions" integer DEFAULT 5,
	"max_position_size_usd" real DEFAULT 50,
	"min_token_score" integer DEFAULT 70,
	"allowed_sources" jsonb DEFAULT '["copy"]'::jsonb,
	"preferred_wallets" jsonb,
	"min_mcap" real,
	"max_mcap" real,
	"min_liquidity" real,
	"default_take_profit" jsonb DEFAULT '[4,10,25]'::jsonb,
	"default_stop_loss" real DEFAULT 50,
	"stop_on_daily_loss_usd" real,
	"stop_on_drawdown_percent" real,
	"stop_on_win_target_usd" real,
	"stop_on_loss_streak" integer,
	"stop_on_trade_count" integer,
	"stop_on_min_balance_sol" real,
	"today_loss_usd" real DEFAULT 0,
	"today_win_usd" real DEFAULT 0,
	"today_trade_count" integer DEFAULT 0,
	"consecutive_losses" integer DEFAULT 0,
	"peak_balance_sol" real,
	"state_reset_at" integer,
	"stopped_reason" text,
	"stopped_at" integer,
	"warning_acknowledged" boolean DEFAULT false,
	"acknowledged_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "autonomous_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "behavior_vectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"slang_level" integer DEFAULT 50,
	"crab_hint_level" integer DEFAULT 30,
	"teasing_level" integer DEFAULT 40,
	"proactivity_level" integer DEFAULT 50,
	"cultural_ref_level" integer DEFAULT 40,
	"trading_caution_level" integer DEFAULT 60,
	"slang_dampening" real DEFAULT 1,
	"crab_dampening" real DEFAULT 1,
	"teasing_dampening" real DEFAULT 1,
	"proactivity_dampening" real DEFAULT 1,
	"cultural_dampening" real DEFAULT 1,
	"trading_dampening" real DEFAULT 1,
	"last_vector_update" integer,
	"total_updates" integer DEFAULT 0,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "behavior_vectors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "bot_flagged_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"bot_confidence" real NOT NULL,
	"timing_regularity" real,
	"replication_score" real,
	"profitability_paradox" real,
	"pump_dump_score" real,
	"replenishment_anomaly" real,
	"flagged_at" integer NOT NULL,
	"flagged_by" text DEFAULT 'automatic',
	"reflag_eligible_at" integer,
	"reflag_count" integer DEFAULT 0,
	"api_quota_saved_calls" integer DEFAULT 0,
	"api_quota_saved_usd" real DEFAULT 0,
	"score_history" text,
	"created_at" integer NOT NULL,
	CONSTRAINT "bot_flagged_wallets_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "cache_invalidation_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target_id" text,
	"reason" text NOT NULL,
	"triggered_by" text NOT NULL,
	"invalidated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cached_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_type" text NOT NULL,
	"event_key" text NOT NULL,
	"web_message" text NOT NULL,
	"telegram_message" text NOT NULL,
	"token_mint" text,
	"token_symbol" text,
	"metadata" text,
	"created_at" integer NOT NULL,
	"expires_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"entry_timestamp" integer NOT NULL,
	"entry_price_usd" real,
	"entry_market_cap" real,
	"members_entered" integer DEFAULT 0,
	"exit_timestamp" integer,
	"exit_price_usd" real,
	"avg_exit_multiplier" real,
	"members_exited" integer DEFAULT 0,
	"outcome" text,
	"peak_multiplier" real,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"sentiment" text NOT NULL,
	"summary" text NOT NULL,
	"source_user_id" integer NOT NULL,
	"consented_at" integer NOT NULL,
	"source_credibility" text,
	"price_at_share" real,
	"created_at" integer NOT NULL,
	"expires_at" integer,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "compute_source_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"date" text NOT NULL,
	"tasks_completed" integer DEFAULT 0,
	"tasks_failed" integer DEFAULT 0,
	"total_compute_time_ms" integer DEFAULT 0,
	"total_bytes_processed" integer DEFAULT 0,
	"spot_checks_passed" integer DEFAULT 0,
	"spot_checks_failed" integer DEFAULT 0,
	"trust_score" real DEFAULT 0.5,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"priority" integer DEFAULT 50,
	"status" text DEFAULT 'pending',
	"assigned_to" integer,
	"assigned_source" text,
	"is_user_relevant" boolean DEFAULT false,
	"ttl_seconds" integer DEFAULT 3,
	"assigned_at" integer,
	"completed_at" integer,
	"created_at" integer NOT NULL,
	"result" jsonb,
	"error_message" text,
	"compute_time_ms" integer,
	"result_size_bytes" integer,
	"validation_status" text
);
--> statement-breakpoint
CREATE TABLE "copy_trading_defaults" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"copy_buy_type" text DEFAULT 'percentage',
	"copy_buy_amount" real DEFAULT 10,
	"copy_initial_buy_mode" text DEFAULT 'fixed',
	"copy_budget_enabled" boolean DEFAULT false,
	"copy_budget_timeframe" text DEFAULT 'daily',
	"copy_budget_amount" real,
	"copy_mirror_buys" boolean DEFAULT false,
	"copy_mirror_buy_mode" text DEFAULT 'same',
	"copy_mirror_buy_amount" real,
	"copy_mirror_buy_max_per_token" integer,
	"copy_mirror_buy_max_per_hour" integer,
	"copy_mirror_buy_max_per_day" integer,
	"copy_position_cap_usd" real,
	"copy_mirror_sells" boolean DEFAULT false,
	"copy_mirror_sell_mode" text DEFAULT 'match_percent',
	"copy_mirror_sell_percent" real,
	"copy_mirror_sell_amount" real,
	"dedup_skip_if_holding" boolean DEFAULT true,
	"dedup_skip_if_ever_held" boolean DEFAULT false,
	"dedup_skip_if_pending" boolean DEFAULT true,
	"dedup_first_buy_only" boolean DEFAULT false,
	"dedup_cross_signal_prevention" boolean DEFAULT false,
	"dedup_max_buys_per_token_daily" integer,
	"dedup_max_buys_per_token_weekly" integer,
	"dedup_price_protection_percent" real,
	"frozen_token_check" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "copy_trading_defaults_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "creator_reputation" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_address" text NOT NULL,
	"creator_name" text,
	"total_launches" integer DEFAULT 0,
	"successful_launches" integer DEFAULT 0,
	"rug_count" integer DEFAULT 0,
	"win_rate" real,
	"rug_rate" real,
	"avg_multiplier" real,
	"median_multiplier" real,
	"avg_time_to_2x" real,
	"avg_time_to_peak" real,
	"avg_hold_duration" real,
	"confidence" real,
	"last_analyzed_at" integer,
	"first_launch_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "creator_reputation_creator_address_unique" UNIQUE("creator_address")
);
--> statement-breakpoint
CREATE TABLE "discovered_factors" (
	"id" serial PRIMARY KEY NOT NULL,
	"factor_type" text NOT NULL,
	"factor_name" text NOT NULL,
	"description" text NOT NULL,
	"correlation_strength" real,
	"sample_size" integer NOT NULL,
	"success_rate" real,
	"avg_multiplier" real,
	"status" text DEFAULT 'proposed',
	"added_to_scoring_at" integer,
	"example_conditions" jsonb,
	"discovered_at" integer NOT NULL,
	"last_updated" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"config_key" text NOT NULL,
	"explore_ratio" real DEFAULT 0.1,
	"explore_ratio_min" real DEFAULT 0.1,
	"explore_ratio_max" real DEFAULT 0.5,
	"exploit_win_rate" real DEFAULT 0,
	"explore_win_rate" real DEFAULT 0,
	"vector_creation_threshold" real DEFAULT 0.7,
	"vector_prune_threshold" real DEFAULT 0.2,
	"adjustment_history" jsonb DEFAULT '[]'::jsonb,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "discovery_config_config_key_unique" UNIQUE("config_key")
);
--> statement-breakpoint
CREATE TABLE "discovery_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"metric_value" real NOT NULL,
	"threshold" real NOT NULL,
	"priority" integer NOT NULL,
	"price_at_discovery" real,
	"market_cap_at_discovery" real,
	"liquidity_at_discovery" real,
	"volume_at_discovery" real,
	"price_after_1h" real,
	"price_after_4h" real,
	"price_after_24h" real,
	"outcome" text,
	"outcome_percent" real,
	"paper_position_id" integer,
	"was_acted_upon" boolean DEFAULT false,
	"status" text DEFAULT 'pending' NOT NULL,
	"fired_at" integer NOT NULL,
	"expires_at" integer,
	"evaluated_at" integer
);
--> statement-breakpoint
CREATE TABLE "discovery_experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"token_mint" text NOT NULL,
	"primary_source_id" text NOT NULL,
	"experiment_source_id" text,
	"primary_allocation" real NOT NULL,
	"experiment_allocation" real,
	"primary_outcome" jsonb,
	"experiment_outcome" jsonb,
	"winner" text,
	"status" text DEFAULT 'pending',
	"created_at" integer NOT NULL,
	"completed_at" integer,
	CONSTRAINT "discovery_experiments_experiment_id_unique" UNIQUE("experiment_id")
);
--> statement-breakpoint
CREATE TABLE "discovery_job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"started_at" integer NOT NULL,
	"completed_at" integer,
	"triggers_evaluated" integer DEFAULT 0,
	"events_fired" integer DEFAULT 0,
	"outcomes_updated" integer DEFAULT 0,
	"thresholds_adjusted" integer DEFAULT 0,
	"current_regime" text,
	"summary" text,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "discovery_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"calculation_type" text NOT NULL,
	"formula" text,
	"primary_source" text NOT NULL,
	"update_frequency_seconds" integer DEFAULT 60,
	"baseline_hit_rate" real,
	"current_hit_rate" real,
	"sample_size" integer DEFAULT 0,
	"proposed_variants" text,
	"is_core" boolean DEFAULT false,
	"enabled" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "discovery_metrics_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_config" jsonb,
	"vector" jsonb DEFAULT '[]'::jsonb,
	"vector_dimension" integer DEFAULT 384,
	"success_rate" real DEFAULT 0,
	"sample_count" integer DEFAULT 0,
	"avg_pnl_percent" real DEFAULT 0,
	"best_discovery" jsonb,
	"confidence" real DEFAULT 0.5,
	"damping_factor" real DEFAULT 0.95,
	"learning_rate" real DEFAULT 0.1,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 50,
	"created_by" text DEFAULT 'manual',
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "discovery_sources_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
CREATE TABLE "discovery_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_to" integer,
	"assigned_at" integer,
	"ttl_seconds" integer DEFAULT 60 NOT NULL,
	"result" jsonb,
	"error_message" text,
	"priority" integer DEFAULT 10 NOT NULL,
	"created_at" integer NOT NULL,
	"completed_at" integer
);
--> statement-breakpoint
CREATE TABLE "discovery_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metric" text NOT NULL,
	"threshold" real NOT NULL,
	"time_window_minutes" integer DEFAULT 60,
	"operator" text DEFAULT 'gte' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"cooldown_minutes" integer DEFAULT 30,
	"is_ai_proposed" boolean DEFAULT false,
	"shadow_mode" boolean DEFAULT false,
	"promoted_at" integer,
	"parent_trigger_id" integer,
	"fire_count" integer DEFAULT 0,
	"true_positives" integer DEFAULT 0,
	"false_positives" integer DEFAULT 0,
	"precision" real,
	"current_weight" real DEFAULT 1,
	"dampening_factor" real DEFAULT 0.1,
	"exploration_phase" boolean DEFAULT true,
	"enabled" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "emergent_patterns" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern_id" text NOT NULL,
	"pattern_type" text NOT NULL,
	"pattern_signature" jsonb,
	"embedding" jsonb,
	"occurrence_count" integer DEFAULT 1,
	"examples" jsonb DEFAULT '[]'::jsonb,
	"confidence" real DEFAULT 0,
	"confidence_threshold" real DEFAULT 0.7,
	"status" text DEFAULT 'tracking',
	"promoted_to_id" text,
	"created_at" integer NOT NULL,
	"last_seen_at" integer,
	CONSTRAINT "emergent_patterns_pattern_id_unique" UNIQUE("pattern_id")
);
--> statement-breakpoint
CREATE TABLE "emergent_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb,
	"condition" jsonb,
	"action_type" text NOT NULL,
	"action_config" jsonb,
	"scope" text DEFAULT 'global',
	"applies_to" jsonb DEFAULT '[]'::jsonb,
	"confidence" real DEFAULT 0,
	"sample_count" integer DEFAULT 0,
	"win_count" integer DEFAULT 0,
	"total_pnl" real DEFAULT 0,
	"avg_pnl_per_trade" real DEFAULT 0,
	"origin" text DEFAULT 'evolved',
	"parent_rule_id" text,
	"discovered_pattern" text,
	"status" text DEFAULT 'testing',
	"enabled" boolean DEFAULT true,
	"paper_only" boolean DEFAULT true,
	"min_sample_for_promotion" integer DEFAULT 20,
	"min_confidence_for_promotion" real DEFAULT 0.6,
	"promoted_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"last_triggered_at" integer,
	CONSTRAINT "emergent_rules_rule_id_unique" UNIQUE("rule_id")
);
--> statement-breakpoint
CREATE TABLE "error_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"action" text NOT NULL,
	"error_type" text NOT NULL,
	"error_message" text NOT NULL,
	"error_stack" text,
	"user_id" integer,
	"context" jsonb,
	"resolved" boolean DEFAULT false,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_strategy_learnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"cluster_name" text NOT NULL,
	"baseline_strategy" jsonb NOT NULL,
	"learned_strategy" jsonb NOT NULL,
	"sample_count" integer NOT NULL,
	"confidence" real NOT NULL,
	"improvement" real,
	"tier_hit_rates" jsonb,
	"tier_average_pnl" jsonb,
	"created_at" integer NOT NULL,
	"applied_at" integer,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "familiar_whales" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"first_seen_at" integer NOT NULL,
	"last_seen_at" integer NOT NULL,
	"total_tokens_seen" integer DEFAULT 0,
	"profitable_exits" integer DEFAULT 0,
	"total_exits" integer DEFAULT 0,
	"avg_exit_multiplier" real DEFAULT 1,
	"best_exit_multiplier" real DEFAULT 1,
	"avg_hold_time_minutes" integer,
	"early_entry_count" integer DEFAULT 0,
	"success_rate" real DEFAULT 0,
	"reliability_score" real DEFAULT 50,
	"label" text,
	"monitoring_tier" text DEFAULT 'archive',
	"tier_assigned_at" integer,
	"tier_score" real DEFAULT 0,
	"cluster_id" integer,
	"cluster_assigned_at" integer,
	CONSTRAINT "familiar_whales_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "fetch_work_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"token_mint" text NOT NULL,
	"priority" integer DEFAULT 50,
	"requested_by" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_by" integer,
	"claimed_at" integer,
	"completed_at" integer,
	"error_message" text,
	"created_at" integer NOT NULL,
	"expires_at" integer
);
--> statement-breakpoint
CREATE TABLE "fingerprint_lifecycle_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint_cluster_id" text NOT NULL,
	"sample_token_count" integer,
	"early_win_rate" real,
	"sustainable_rate" real,
	"peak_multiplier_median" real,
	"peak_multiplier_95th" real,
	"median_time_to_peak_minutes" integer,
	"median_hold_minutes" integer,
	"early_buyer_win_rate" real,
	"early_buyer_median_multiplier" real,
	"confidence_score" real,
	"drawdown_percentile" real,
	"volatility_percent" real,
	"last_calculated_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "fingerprint_snapshot_reference" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint_id" integer NOT NULL,
	"t0_milestone_snapshot_id" integer NOT NULL,
	"t1_milestone_snapshot_id" integer,
	"t2_milestone_snapshot_id" integer,
	"is_immutable" boolean DEFAULT true,
	"frozen_at" integer NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_baselines" (
	"id" serial PRIMARY KEY NOT NULL,
	"baseline_type" text NOT NULL,
	"slang_level" integer DEFAULT 50,
	"crab_hint_level" integer DEFAULT 30,
	"teasing_level" integer DEFAULT 40,
	"proactivity_level" integer DEFAULT 50,
	"cultural_ref_level" integer DEFAULT 40,
	"trading_caution_level" integer DEFAULT 60,
	"sample_count" integer DEFAULT 0,
	"last_aggregation" integer,
	"version" integer DEFAULT 1,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "global_baselines_baseline_type_unique" UNIQUE("baseline_type")
);
--> statement-breakpoint
CREATE TABLE "good_traders" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"win_rate" real,
	"total_trades" integer,
	"profitable_count" integer,
	"total_pnl" real,
	"avg_hold_minutes" real,
	"sharpe_ratio" real,
	"discovery_score" real,
	"discovered_from_tokens" jsonb,
	"last_assessed_at" integer,
	"is_active" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	CONSTRAINT "good_traders_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "graduation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"graduation_time" integer NOT NULL,
	"source_pool_address" text,
	"destination_pool_address" text NOT NULL,
	"time_to_graduation" integer,
	"liquidity_on_graduation" real,
	"price_on_graduation" real,
	"learning_exported" boolean DEFAULT false,
	"created_at" integer NOT NULL,
	CONSTRAINT "graduation_events_token_mint_unique" UNIQUE("token_mint")
);
--> statement-breakpoint
CREATE TABLE "heat_factor_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"config_key" text NOT NULL,
	"recent_buys_weight" real DEFAULT 0.25,
	"volatility_weight" real DEFAULT 0.2,
	"user_attention_weight" real DEFAULT 0.2,
	"recency_weight" real DEFAULT 0.15,
	"whale_activity_weight" real DEFAULT 0.2,
	"discovery_quality_weight" real DEFAULT 0,
	"weight_bounds" jsonb DEFAULT '{"recentBuys":{"min":0.05,"max":0.4},"volatility":{"min":0.05,"max":0.35},"userAttention":{"min":0.05,"max":0.35},"recency":{"min":0.05,"max":0.3},"whaleActivity":{"min":0.05,"max":0.35},"discoveryQuality":{"min":0,"max":0.25}}'::jsonb,
	"factor_performance" jsonb DEFAULT '{}'::jsonb,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "heat_factor_config_config_key_unique" UNIQUE("config_key")
);
--> statement-breakpoint
CREATE TABLE "holder_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"holders" jsonb DEFAULT '[]'::jsonb,
	"total_holders" integer DEFAULT 0,
	"top_10_concentration" real,
	"fetched_via" text DEFAULT 'api',
	"fetched_by_user_id" integer,
	"fetched_at" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"last_webhook_update" integer,
	"webhook_update_count" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"refresh_priority" integer DEFAULT 50,
	CONSTRAINT "holder_cache_token_mint_unique" UNIQUE("token_mint")
);
--> statement-breakpoint
CREATE TABLE "holder_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"snapshot_time" integer NOT NULL,
	"top_holders" jsonb,
	"total_holders" integer,
	"top_10_percent" real,
	"top_50_percent" real,
	"concentration_score" real,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"token_mint" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_name" text,
	"amount_bought" real NOT NULL,
	"sol_spent" real NOT NULL,
	"buy_price" real NOT NULL,
	"buy_timestamp" integer NOT NULL,
	"buy_signature" text NOT NULL,
	"current_amount" real NOT NULL,
	"reclaimed" boolean DEFAULT false,
	"reclaim_timestamp" integer,
	"reclaim_signature" text,
	"last_price_check" integer,
	"last_price" real,
	"highest_multiplier" real DEFAULT 1,
	"alerted_milestones" jsonb DEFAULT '[]'::jsonb,
	"reclaimed_milestones" jsonb DEFAULT '[]'::jsonb,
	"dump_alert_sent" boolean DEFAULT false,
	"token_wallet_public_key" text,
	"token_wallet_encrypted_key" text,
	"source_swap_id" integer,
	"source_wallet_address" text,
	"source_wallet_label" text,
	"source_wallet_buy_count" integer,
	"source_wallet_sell_count" integer,
	"source_wallet_max_held_pct" real,
	"source_wallet_current_pct" real,
	"is_dead" boolean DEFAULT false,
	"is_dust" boolean DEFAULT false,
	"total_buys" integer DEFAULT 1,
	"avg_entry_price" real,
	"total_tokens_bought" real,
	"total_sol_invested" real,
	"last_top_up_timestamp" integer,
	"take_profit_thresholds" jsonb,
	"take_profit_percentages" jsonb,
	"take_profit_enabled" jsonb,
	"stop_loss_percent" real,
	"stop_loss_floor_usd" real,
	"stop_loss_mode" text DEFAULT 'auto',
	"stop_loss_triggered" boolean DEFAULT false,
	"stop_loss_timestamp" integer,
	"stop_loss_signature" text,
	"stop_loss_last_alerted_at" integer,
	"take_profit_last_triggered_at" integer,
	"auto_mirror_sells" boolean DEFAULT false,
	"position_source" text DEFAULT 'copy',
	"signal_wallet_id" integer,
	"signal_buy_amount_tokens" real,
	"entry_reason" text,
	"position_score" integer,
	"position_score_tier" text,
	"score_last_updated" integer,
	"score_factors" jsonb,
	"signal_wallet_sold" boolean DEFAULT false,
	"signal_wallet_sold_at" integer,
	"position_status" text DEFAULT 'active',
	"autonomy_enabled" boolean DEFAULT false,
	"rule_source" text DEFAULT 'inherited'
);
--> statement-breakpoint
CREATE TABLE "hot_wallet" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"public_key" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indicator_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"position_id" integer,
	"snapshot_type" text NOT NULL,
	"timeframe" text DEFAULT '1h',
	"rsi" real,
	"macd_histogram" real,
	"ema_cross_signal" text,
	"bollinger_position" text,
	"bollinger_bandwidth" real,
	"obv_trend" text,
	"stochastic_k" real,
	"composite_score" real,
	"composite_bias" text,
	"price_at_snapshot" real,
	"bucket_id" text NOT NULL,
	"created_at" integer NOT NULL,
	"price_high" real,
	"price_low" real,
	"high_timestamp" integer,
	"low_timestamp" integer,
	"max_drawdown_percent" real,
	"max_unrealized_gain_percent" real,
	"hold_duration_minutes" integer,
	"avg_volume" real,
	"total_volume" real,
	"liquidity_at_snapshot" real,
	"market_cap_at_snapshot" real,
	"token_age_hours" real,
	"holder_count_at_snapshot" integer,
	"whale_count" integer,
	"whale_avg_reputation" real,
	"whale_net_sentiment" real,
	"discovery_source" text,
	"signal_wallet_win_rate" real,
	"signal_wallet_style" text,
	"hour_of_day" integer,
	"day_of_week" integer,
	"sol_correlation" real,
	"price_velocity" real,
	"relative_volume" real,
	"lifecycle_stage" text,
	"cluster_crowding" integer,
	"dex_listing_count" integer,
	"indicators_at_high" jsonb,
	"indicators_at_low" jsonb
);
--> statement-breakpoint
CREATE TABLE "indicator_vectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"vector_type" text NOT NULL,
	"optimal_rsi_low" real DEFAULT 25,
	"optimal_rsi_high" real DEFAULT 45,
	"optimal_macd_histogram_min" real DEFAULT -0.001,
	"preferred_ema_cross" text DEFAULT 'bullish',
	"preferred_bollinger_position" text DEFAULT 'below',
	"optimal_bandwidth_min" real DEFAULT 0.02,
	"optimal_bandwidth_max" real DEFAULT 0.15,
	"preferred_obv_trend" text DEFAULT 'accumulating',
	"optimal_stoch_k_low" real DEFAULT 15,
	"optimal_stoch_k_high" real DEFAULT 40,
	"optimal_composite_min" real DEFAULT 55,
	"win_count" integer DEFAULT 0,
	"loss_count" integer DEFAULT 0,
	"sample_count" integer DEFAULT 0,
	"confidence" real DEFAULT 0.5,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	"optimal_liquidity_low" real,
	"optimal_liquidity_high" real,
	"optimal_mcap_low" real,
	"optimal_mcap_high" real,
	"optimal_token_age_low" real,
	"optimal_token_age_high" real,
	"optimal_whale_sentiment_low" real,
	"optimal_whale_sentiment_high" real,
	"optimal_whale_count_low" integer,
	"optimal_whale_count_high" integer,
	"preferred_discovery_source" text,
	"preferred_hour_of_day" integer,
	"preferred_lifecycle_stage" text,
	"optimal_price_velocity_low" real,
	"optimal_price_velocity_high" real,
	"optimal_relative_volume_low" real,
	"optimal_relative_volume_high" real,
	"avg_win_drawdown" real,
	"avg_loss_drawdown" real,
	"avg_win_max_gain" real,
	"avg_win_hold_minutes" real,
	"avg_loss_hold_minutes" real
);
--> statement-breakpoint
CREATE TABLE "jupiter_latency_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"environment" text NOT NULL,
	"p50_latency" real NOT NULL,
	"p95_latency" real NOT NULL,
	"p99_latency" real NOT NULL,
	"avg_slippage" real,
	"success_rate" real DEFAULT 1,
	"sample_count" integer NOT NULL,
	"sampled_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	CONSTRAINT "link_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sol_price_change_threshold" real,
	"volume_ratio_threshold" real,
	"volatility_threshold" real,
	"detected_at" integer,
	"confidence" real,
	"duration_minutes" integer,
	"avg_trigger_precision" real,
	"avg_outcome_percent" real,
	"sample_size" integer DEFAULT 0,
	"threshold_multiplier" real DEFAULT 1,
	"cooldown_multiplier" real DEFAULT 1,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "memory_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"cluster_type" text NOT NULL,
	"cluster_key" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb,
	"frequency" integer DEFAULT 1,
	"last_seen" integer,
	"confidence" real DEFAULT 0.5,
	"decay_factor" real DEFAULT 0.95,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "message_read_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"read_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"experiment_type" text NOT NULL,
	"target_systems" jsonb DEFAULT '[]'::jsonb,
	"control_config" jsonb,
	"variant_config" jsonb,
	"assignment_ratio" real DEFAULT 0.5,
	"control_trades" integer DEFAULT 0,
	"variant_trades" integer DEFAULT 0,
	"control_win_rate" real DEFAULT 0,
	"variant_win_rate" real DEFAULT 0,
	"control_pnl" real DEFAULT 0,
	"variant_pnl" real DEFAULT 0,
	"p_value" real,
	"confidence_level" real,
	"min_sample_size" integer DEFAULT 20,
	"status" text DEFAULT 'active',
	"winner" text,
	"started_at" integer NOT NULL,
	"ends_at" integer,
	"completed_at" integer,
	"created_by" text DEFAULT 'system',
	"promoted_config" jsonb,
	CONSTRAINT "meta_experiments_experiment_id_unique" UNIQUE("experiment_id")
);
--> statement-breakpoint
CREATE TABLE "monitored_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"copy_trade_enabled" boolean DEFAULT false,
	"is_shared" boolean DEFAULT false,
	"share_status" text DEFAULT 'none',
	"ai_score" integer,
	"ai_score_details" text,
	"ai_score_updated_at" integer,
	"copy_buy_type" text DEFAULT 'percentage',
	"copy_buy_amount" real DEFAULT 10,
	"copy_min_balance" real,
	"copy_min_trade_usd" real,
	"copy_score_threshold" integer,
	"copy_timing" text DEFAULT 'immediate',
	"copy_delay_minutes" integer,
	"copy_auto_mirror" boolean DEFAULT false,
	"copy_mirror_buys" boolean,
	"copy_mirror_sells" boolean,
	"copy_initial_buy_mode" text DEFAULT 'fixed',
	"copy_budget_enabled" boolean DEFAULT false,
	"copy_budget_timeframe" text DEFAULT 'daily',
	"copy_budget_amount" real,
	"copy_mirror_buy_mode" text DEFAULT 'same',
	"copy_mirror_buy_amount" real,
	"copy_mirror_buy_max_per_token" integer,
	"copy_mirror_buy_max_per_hour" integer,
	"copy_mirror_buy_max_per_day" integer,
	"copy_position_cap_usd" real,
	"copy_mirror_sell_mode" text DEFAULT 'match_percent',
	"copy_mirror_sell_percent" real,
	"copy_mirror_sell_amount" real,
	"dedup_skip_if_holding" boolean DEFAULT true,
	"dedup_skip_if_ever_held" boolean DEFAULT false,
	"dedup_skip_if_pending" boolean DEFAULT true,
	"dedup_first_buy_only" boolean DEFAULT false,
	"dedup_cross_signal_prevention" boolean DEFAULT false,
	"dedup_max_buys_per_token_daily" integer,
	"dedup_max_buys_per_token_weekly" integer,
	"dedup_price_protection_percent" real,
	"user_notes" text,
	"temporary" boolean DEFAULT false,
	"last_viewed_at" integer
);
--> statement-breakpoint
CREATE TABLE "monitoring_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"is_active" boolean DEFAULT false,
	"webhook_id" text,
	"last_updated" integer NOT NULL,
	"total_swaps_detected" integer DEFAULT 0,
	"webhook_env" text DEFAULT 'production'
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"token_name" text,
	"entry_price" real NOT NULL,
	"entry_sol" real NOT NULL,
	"entry_tokens" real NOT NULL,
	"entry_timestamp" integer NOT NULL,
	"entry_tx_signature" text,
	"exit_price" real,
	"exit_sol" real,
	"exit_timestamp" integer,
	"exit_tx_signature" text,
	"exit_reason" text,
	"realized_pnl" real,
	"realized_pnl_percent" real,
	"highest_price" real,
	"lowest_price" real,
	"strategy_id" integer,
	"signal_wallet" text,
	"experiment_id" integer,
	"paper_trade_type" text DEFAULT 'manual',
	"meta_experiment_id" text,
	"theory_id" text,
	"experiment_variant" text,
	"trigger_type" text,
	"reaction_speed_ms" integer,
	"trigger_event_id" text,
	"strategy_slot" text,
	"source_type" text,
	"trailing_stop_percent" real,
	"take_profit_multiplier" real,
	"stop_loss_percent" real,
	"trailing_stop" boolean,
	"price_tier" text,
	"learning_weight" real DEFAULT 1,
	"discovery_source" text,
	"discovery_source_wallet" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" integer NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" integer NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "pattern_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"pattern_type" text NOT NULL,
	"token_mint" text,
	"trigger_data" jsonb NOT NULL,
	"predicted_outcome" text,
	"actual_outcome" text,
	"confidence" real,
	"outcome_multiplier" real,
	"resolved_at" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_buys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"token_mint" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_name" text,
	"detected_at" integer NOT NULL,
	"scheduled_buy_at" integer NOT NULL,
	"initial_price" real,
	"buy_triggered" boolean DEFAULT false,
	"trigger_reason" text,
	"buy_count" integer DEFAULT 0,
	"initial_buy_count" integer DEFAULT 0,
	"status" text DEFAULT 'active',
	"pause_reason" text,
	"segment_index" integer DEFAULT 1,
	"total_segments" integer DEFAULT 1,
	"parent_buy_id" integer,
	"sol_amount" real,
	"token_wallet_public_key" text,
	"token_wallet_encrypted_key" text,
	"snapshot_id" integer,
	"ai_score" integer,
	"source_swap_id" integer,
	"source_wallet_address" text,
	"source_wallet_label" text,
	"signal_wallet_id" integer,
	"signal_buy_amount_tokens" real,
	"copy_timing" text DEFAULT 'delayed'
);
--> statement-breakpoint
CREATE TABLE "pincher_data_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_type" text NOT NULL,
	"description" text NOT NULL,
	"reasoning" text,
	"priority" text DEFAULT 'normal',
	"status" text DEFAULT 'pending',
	"admin_notes" text,
	"resolved_by" integer,
	"resolved_at" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tier" text NOT NULL,
	"bucket_start" integer NOT NULL,
	"total_value_usd" real NOT NULL,
	"total_cost_basis_usd" real,
	"unrealized_pnl_usd" real,
	"unrealized_pnl_percent" real,
	"position_count" integer NOT NULL,
	"profitable_count" integer,
	"losing_count" integer,
	"top_positions" jsonb,
	"sol_price_usd" real,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_score_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"holding_id" integer NOT NULL,
	"user_id" integer,
	"token_mint" text NOT NULL,
	"factors_snapshot" jsonb NOT NULL,
	"computed_score" integer NOT NULL,
	"score_tier" text NOT NULL,
	"price_at_scoring" real,
	"entry_price" real,
	"hold_time_hours" real,
	"entry_snapshot" jsonb,
	"event_buckets" jsonb DEFAULT '[]'::jsonb,
	"current_snapshot" jsonb,
	"exit_price" real,
	"exit_multiplier" real,
	"was_good_score" boolean,
	"outcome_type" text,
	"scored_at" integer NOT NULL,
	"resolved_at" integer
);
--> statement-breakpoint
CREATE TABLE "price_aggregates" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"tier" text NOT NULL,
	"bucket_start" integer NOT NULL,
	"price_open" real,
	"price_high" real,
	"price_low" real,
	"price_close" real,
	"lp_open" real,
	"lp_close" real,
	"volume" real,
	"buys" integer,
	"sells" integer,
	"market_cap" real,
	"fdv" real,
	"holder_count" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"timeframe" text NOT NULL,
	"timestamp" integer NOT NULL,
	"open" real NOT NULL,
	"high" real NOT NULL,
	"low" real NOT NULL,
	"close" real NOT NULL,
	"volume" real,
	"source" text DEFAULT 'dexscreener',
	"fetched_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"snapshot_type" text DEFAULT 'daily' NOT NULL,
	"open" real NOT NULL,
	"high" real NOT NULL,
	"low" real NOT NULL,
	"close" real NOT NULL,
	"volume" real,
	"volume_buckets" jsonb,
	"market_cap" real,
	"liquidity" real,
	"holder_count" integer,
	"data_point_count" integer DEFAULT 1,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_token_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"signature" text NOT NULL,
	"wallet_address" text NOT NULL,
	"amount_sol" real NOT NULL,
	"amount_tokens" real NOT NULL,
	"direction" text NOT NULL,
	"price" real,
	"source" text,
	"timestamp" integer NOT NULL,
	"discovered_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	CONSTRAINT "raw_token_trades_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "raydium_pool_discoveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_address" text NOT NULL,
	"base_token_mint" text NOT NULL,
	"quote_token_mint" text NOT NULL,
	"creator_address" text,
	"discovered_at" integer NOT NULL,
	"source_type" text NOT NULL,
	"liquidity_usd" real,
	"last_updated_at" integer NOT NULL,
	"associated_token_mint" text,
	"is_verified" boolean DEFAULT false,
	"quality_score" real,
	CONSTRAINT "raydium_pool_discoveries_pool_address_unique" UNIQUE("pool_address")
);
--> statement-breakpoint
CREATE TABLE "retrolearner_thresholds" (
	"id" serial PRIMARY KEY NOT NULL,
	"threshold_type" text NOT NULL,
	"threshold_value" real NOT NULL,
	"expected_success_rate" real NOT NULL,
	"sample_size" integer,
	"confidence" real,
	"analysis_date" integer NOT NULL,
	"data_window_days" integer,
	"context" jsonb,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "retrolearner_wallet_analysis" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"last_analyzed_at" integer,
	"last_tx_checked_at" integer,
	"total_pnl_7d" real,
	"win_rate_7d" real,
	"avg_hold_minutes" real,
	"sharpe_ratio" real,
	"sample_count" integer,
	"discovered_from_tokens" jsonb,
	"discovery_confidence" real,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "retrolearner_wallet_analysis_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "route_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent" text NOT NULL,
	"vector" jsonb DEFAULT '[]'::jsonb,
	"vector_dimension" integer DEFAULT 384,
	"vector_needs" jsonb DEFAULT '[]'::jsonb,
	"tier_1_keywords" jsonb DEFAULT '[]'::jsonb,
	"hit_count" integer DEFAULT 0,
	"confidence" real DEFAULT 0.5,
	"last_match_score" real,
	"damping_factor" real DEFAULT 0.95,
	"learning_rate" real DEFAULT 0.1,
	"created_by" text DEFAULT 'manual',
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "route_intents_intent_unique" UNIQUE("intent")
);
--> statement-breakpoint
CREATE TABLE "rpc_usage_daily_bucket" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"date" text NOT NULL,
	"total_calls" integer DEFAULT 0 NOT NULL,
	"success_calls" integer DEFAULT 0 NOT NULL,
	"error_calls" integer DEFAULT 0 NOT NULL,
	"fallback_calls" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" integer,
	"max_latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "rpc_usage_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"success" boolean NOT NULL,
	"latency_ms" integer,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"fallback_provider" text,
	"error_message" text,
	"timestamp" integer NOT NULL,
	"date" text NOT NULL,
	"call_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rpc_usage_monthly_bucket" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"month" text NOT NULL,
	"total_calls" integer DEFAULT 0 NOT NULL,
	"success_calls" integer DEFAULT 0 NOT NULL,
	"error_calls" integer DEFAULT 0 NOT NULL,
	"fallback_calls" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "rpc_usage_weekly_bucket" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"week_start" text NOT NULL,
	"total_calls" integer DEFAULT 0 NOT NULL,
	"success_calls" integer DEFAULT 0 NOT NULL,
	"error_calls" integer DEFAULT 0 NOT NULL,
	"fallback_calls" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" integer
);
--> statement-breakpoint
CREATE TABLE "scan_context_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"trigger_source" text NOT NULL,
	"wallet_hit_rate" real,
	"wallet_address" text,
	"token_age" integer,
	"signal_wallet_count" integer,
	"time_of_day" integer,
	"trending_rank" integer,
	"boost_rank" integer,
	"price_change_percent" real,
	"holder_overlap_score" real,
	"discovery_event_fired" boolean DEFAULT false,
	"discovery_event_id" integer,
	"price_delta_24h" real,
	"copy_trade_triggered" boolean,
	"trade_profit" real,
	"outcome_recorded_at" integer,
	"scan_urgency_score" real,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_name" text NOT NULL,
	"token_mint" text,
	"wallet_address" text,
	"subscription_type" text NOT NULL,
	"assigned_at" integer NOT NULL,
	"status" text DEFAULT 'active'
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"email" text NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb,
	"enabled" boolean DEFAULT true,
	"min_swap_amount" real
);
--> statement-breakpoint
CREATE TABLE "signal_cumulative_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"signal_wallet_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"total_tokens_bought" real DEFAULT 0,
	"total_sol_spent" real DEFAULT 0,
	"total_tokens_sold" real DEFAULT 0,
	"buy_count" integer DEFAULT 0,
	"sell_count" integer DEFAULT 0,
	"first_buy_at" integer,
	"last_buy_at" integer,
	"last_sell_at" integer,
	"remaining_tokens" real DEFAULT 0,
	"avg_buy_price" real
);
--> statement-breakpoint
CREATE TABLE "signal_wallet_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"avg_entry_mcap" real,
	"median_hold_time_minutes" integer,
	"avg_exit_multiplier" real,
	"max_exit_multiplier" real,
	"min_exit_multiplier" real,
	"total_trades" integer DEFAULT 0,
	"winning_trades" integer DEFAULT 0,
	"rugged_trades" integer DEFAULT 0,
	"win_rate" real,
	"rug_rate" real,
	"trading_style" text,
	"style_confidence" real,
	"recent_win_rate" real,
	"recent_avg_multiplier" real,
	"first_seen_at" integer,
	"last_trade_at" integer,
	"updated_at" integer NOT NULL,
	CONSTRAINT "signal_wallet_profiles_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "social_callers" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"platform_url" text,
	"call_count" integer DEFAULT 0,
	"win_count" integer DEFAULT 0,
	"loss_count" integer DEFAULT 0,
	"hit_rate" real DEFAULT 0,
	"avg_return" real DEFAULT 0,
	"best_return" real,
	"worst_return" real,
	"trust_score" real DEFAULT 0.5,
	"vector" jsonb DEFAULT '[]'::jsonb,
	"vector_dimension" integer DEFAULT 384,
	"is_active" boolean DEFAULT true,
	"last_call_at" integer,
	"first_seen_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "social_callers_platform_handle_unique" UNIQUE("platform","handle")
);
--> statement-breakpoint
CREATE TABLE "social_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"caller_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"platform" text NOT NULL,
	"source_url" text,
	"message_text" text,
	"price_at_call" real,
	"market_cap_at_call" real,
	"liquidity_at_call" real,
	"peak_price_after" real,
	"peak_multiplier" real,
	"price_after_1h" real,
	"price_after_6h" real,
	"price_after_24h" real,
	"outcome" text,
	"return_percent" real,
	"evaluated_at" integer,
	"called_at" integer NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_bucket_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"total_size_bytes" integer,
	"table_sizes" jsonb,
	"last_compression_at" integer,
	"last_compression_level" text,
	"oldest_raw_data_at" integer,
	"cold_archive_count" integer DEFAULT 0,
	"cold_archive_size_bytes" integer DEFAULT 0,
	"last_archive_at" integer,
	"checked_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"pattern" text NOT NULL,
	"pattern_description" text,
	"wallet_addresses" jsonb DEFAULT '[]'::jsonb,
	"wallet_count" integer DEFAULT 0,
	"vector" jsonb DEFAULT '[]'::jsonb,
	"vector_dimension" integer DEFAULT 384,
	"outcomes" jsonb DEFAULT '{"totalTrades":0,"wins":0,"losses":0,"avgPnlPercent":0,"totalPnlSol":0,"winRate":0,"bestTrade":null,"worstTrade":null}'::jsonb,
	"confidence" real DEFAULT 0.5,
	"stability_score" real,
	"sample_size" integer DEFAULT 0,
	"created_by" text DEFAULT 'manual',
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "strategy_clusters_cluster_id_unique" UNIQUE("cluster_id")
);
--> statement-breakpoint
CREATE TABLE "strategy_experiments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"signal_wallet" text,
	"strategy_id" integer,
	"control_config" text,
	"variant_config" text,
	"paper_budget_sol" real NOT NULL,
	"used_budget_sol" real DEFAULT 0,
	"trades_control" integer DEFAULT 0,
	"trades_variant" integer DEFAULT 0,
	"pnl_control" real DEFAULT 0,
	"pnl_variant" real DEFAULT 0,
	"win_rate_control" real,
	"win_rate_variant" real,
	"p_value" real,
	"confidence_level" real,
	"started_at" integer NOT NULL,
	"ends_at" integer,
	"ended_at" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"winner" text,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "strategy_validations" (
	"id" serial PRIMARY KEY NOT NULL,
	"position_id" integer NOT NULL,
	"strategy_theory" text NOT NULL,
	"expected_outcome" real NOT NULL,
	"actual_outcome" real,
	"actual_exit_reason" text,
	"simulation_passed" boolean DEFAULT true,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" integer NOT NULL,
	"confirmed_at" integer
);
--> statement-breakpoint
CREATE TABLE "surplus_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"total_surplus" integer DEFAULT 0,
	"throttled_user_allocation" integer DEFAULT 0,
	"discovery_allocation" integer DEFAULT 0,
	"throttled_used" integer DEFAULT 0,
	"discovery_used" integer DEFAULT 0,
	"contributor_count" integer DEFAULT 0,
	"borrower_count" integer DEFAULT 0,
	"last_calculated_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "surplus_pool_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "swaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"signature" text NOT NULL,
	"timestamp" integer NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"from_token" text NOT NULL,
	"from_token_symbol" text NOT NULL,
	"from_amount" real NOT NULL,
	"to_token" text NOT NULL,
	"to_token_symbol" text NOT NULL,
	"to_amount" real NOT NULL,
	"fee" real,
	"slot" integer NOT NULL,
	"notification_sent" boolean DEFAULT false,
	"to_token_metadata" jsonb,
	"sol_price_at_trade" real,
	CONSTRAINT "swaps_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "swing_trade_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"enabled" boolean DEFAULT false,
	"detect_support_resistance" boolean DEFAULT true,
	"detect_volume_spikes" boolean DEFAULT true,
	"detect_ohlc_patterns" boolean DEFAULT true,
	"detect_consolidation" boolean DEFAULT true,
	"detect_breakout" boolean DEFAULT true,
	"min_support_bounces" integer DEFAULT 3,
	"breakout_volume_factor" real DEFAULT 2,
	"consolidation_min_hours" integer DEFAULT 4,
	"swing_position_size_usd" real DEFAULT 25,
	"max_swing_positions" integer DEFAULT 3,
	"resistance_take_profit" boolean DEFAULT true,
	"trailing_stop_percent" real,
	"time_limit_hours" integer,
	"min_token_score" integer DEFAULT 60,
	"min_liquidity" real DEFAULT 50000,
	"min_mcap" real DEFAULT 100000,
	"max_mcap" real DEFAULT 10000000,
	"auto_entry" boolean DEFAULT false,
	"auto_exit" boolean DEFAULT true,
	"alert_only" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "swing_trade_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "system_correlations" (
	"id" serial PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"source_event_type" text NOT NULL,
	"source_system" text NOT NULL,
	"target_event_type" text NOT NULL,
	"target_system" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb,
	"occurrence_count" integer DEFAULT 0,
	"correlation_strength" real DEFAULT 0,
	"p_value" real,
	"positive_outcomes" integer DEFAULT 0,
	"negative_outcomes" integer DEFAULT 0,
	"avg_pnl_when_present" real,
	"avg_pnl_when_absent" real,
	"status" text DEFAULT 'tracking',
	"actionable_insight" text,
	"discovered_at" integer NOT NULL,
	"last_updated_at" integer,
	"last_seen_at" integer,
	CONSTRAINT "system_correlations_correlation_id_unique" UNIQUE("correlation_id")
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_system" text NOT NULL,
	"target_system" text,
	"user_id" integer,
	"token_mint" text,
	"wallet_address" text,
	"position_id" integer,
	"correlation_id" text,
	"payload" jsonb,
	"metrics" jsonb,
	"outcome_type" text,
	"outcome_pnl" real,
	"outcome_recorded_at" integer,
	"timestamp" integer NOT NULL,
	"bucket_id" text,
	CONSTRAINT "system_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "system_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"insight_id" text NOT NULL,
	"source_system" text NOT NULL,
	"insight_type" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"confidence" real DEFAULT 0.5,
	"sample_count" integer DEFAULT 1,
	"token_mint" text,
	"wallet_address" text,
	"user_id" integer,
	"status" text DEFAULT 'active',
	"consumed_by" text,
	"consumed_at" integer,
	"created_at" integer NOT NULL,
	"expires_at" integer,
	"last_accessed_at" integer,
	"access_count" integer DEFAULT 0,
	CONSTRAINT "system_insights_insight_id_unique" UNIQUE("insight_id")
);
--> statement-breakpoint
CREATE TABLE "system_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"error_message" text,
	"error_stack" text,
	"context" jsonb,
	"user_id" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_blacklist" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"token_name" text,
	"reason" text,
	"added_at" integer NOT NULL,
	"added_by" text DEFAULT 'manual'
);
--> statement-breakpoint
CREATE TABLE "token_data_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"token_name" text,
	"price_usd" real,
	"price_updated_at" integer,
	"price_source" text,
	"market_cap" real,
	"fdv" real,
	"liquidity" real,
	"volume_24h" real,
	"price_change_24h" real,
	"market_data_updated_at" integer,
	"pair_address" text,
	"dex_id" text,
	"pair_created_at" integer,
	"last_fetched_by" integer,
	"last_fetch_source" text,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"is_active" boolean DEFAULT true,
	"last_accessed_at" integer,
	"access_count" integer DEFAULT 0,
	"rugcheck_data" jsonb,
	"rugcheck_checked_at" integer,
	"goplus_data" jsonb,
	"goplus_checked_at" integer,
	"safety_source" text,
	"is_pumpfun" boolean,
	"pumpfun_graduated" boolean,
	"pumpfun_graduation_time" integer,
	"pumpfun_age_at_graduation" integer,
	"pumpfun_bonding_curve_progress" real,
	"boost_rank" integer,
	"boost_updated_at" integer,
	"trending_rank" integer,
	"trending_source" text,
	"trending_updated_at" integer,
	"price_change_1h" real,
	"price_change_6h" real,
	"price_change_7d" real,
	"price_change_14d" real,
	"price_change_30d" real,
	"deployer_address" text,
	"has_twitter" boolean DEFAULT false,
	"has_telegram" boolean DEFAULT false,
	"has_website" boolean DEFAULT false,
	"twitter_url" text,
	"telegram_url" text,
	"website_url" text,
	"social_first_detected_at" integer,
	"social_score" real,
	"twitter_mentions" integer DEFAULT 0,
	"telegram_mentions" integer DEFAULT 0,
	"social_checked_at" integer,
	"pincher_score" real,
	"pincher_score_raw" real,
	"pincher_verdict" text,
	"pincher_confidence" text,
	"pincher_scored_at" integer,
	"discovery_source" text,
	"discovery_source_wallet" text,
	"discovery_hop_depth" integer,
	"whale_holder_count" integer DEFAULT 0,
	"whale_avg_reputation" real,
	"whale_best_reputation" real,
	"whale_worst_reputation" real,
	"whale_net_sentiment" real,
	"whale_context_updated_at" integer,
	"holder_count" integer,
	"holder_count_updated_at" integer,
	"image_url" text,
	"image_url_fetched_at" integer,
	"raydium_pool_address" text,
	"raydium_pool_discovered_at" integer,
	"raydium_liquidity_usd" real,
	"raydium_creator_address" text,
	"raydium_creator_reputation" real,
	"raydium_top_holder_count" integer,
	"raydium_holder_concentration" real,
	"is_direct_raydium_launch" boolean DEFAULT false,
	"pool_origin_type" text,
	"last_snapshot_at" integer,
	"last_snapshot_trade_count" integer DEFAULT 0,
	"total_trade_count" integer DEFAULT 0,
	"triggered_milestones" jsonb DEFAULT '{}'::jsonb,
	"last_milestone_multiplier" real,
	"is_deathbed" boolean DEFAULT false,
	"deathbed_detected_at" integer,
	"deathbed_snapshot_created" boolean DEFAULT false,
	"trajectory_outcome_label" text,
	"snapshots_count" integer DEFAULT 0,
	"last_ann_score" real,
	"composite_score" real,
	"is_monitored" boolean DEFAULT false,
	"added_to_pool_at" integer,
	"evicted_from_pool_at" integer,
	"eviction_reason" text,
	"volume_24h_sol" real,
	CONSTRAINT "token_data_pool_token_mint_unique" UNIQUE("token_mint")
);
--> statement-breakpoint
CREATE TABLE "token_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text NOT NULL,
	"event_type" text NOT NULL,
	"priority" text DEFAULT 'normal',
	"title" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" integer NOT NULL,
	"price_at_event" real,
	"value_usd" real,
	"related_wallet" text
);
--> statement-breakpoint
CREATE TABLE "token_fingerprint_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"type" text DEFAULT 'dead' NOT NULL,
	"lifecycle_stage" text,
	"centroid" vector(undefined) NOT NULL,
	"outcome_distribution" jsonb,
	"sample_count" integer NOT NULL,
	"snapshot_token_mints" jsonb,
	"cohesion" real NOT NULL,
	"min_similarity" real,
	"max_similarity" real,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	"last_rebalanced_at" integer,
	CONSTRAINT "token_fingerprint_clusters_cluster_id_unique" UNIQUE("cluster_id")
);
--> statement-breakpoint
CREATE TABLE "token_fingerprint_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"timestamp" integer NOT NULL,
	"token_age_seconds" integer NOT NULL,
	"snapshot_number" integer NOT NULL,
	"position_in_arc" real,
	"snapshot_trigger" text NOT NULL,
	"trigger_value" text,
	"trajectory_anchored" jsonb NOT NULL,
	"trajectory_current" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"top20_holder_metrics" jsonb,
	"worst_latency_ms" integer,
	"worst_slippage_percent" real,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_fingerprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint_type" text NOT NULL,
	"snapshot_trigger" text,
	"archetype_cluster_id" text,
	"token_mint" text,
	"creator_address" text,
	"snapshot_timestamp" integer,
	"token_age_minutes" real,
	"win_rate" real,
	"median_multiplier" real,
	"sample_count" integer DEFAULT 0,
	"entry_slippage_avg" real,
	"entry_slippage_p95" real,
	"sl_hit_rate" real,
	"sl_threshold_percent" real,
	"tsl_curve_start_multiplier" real,
	"tsl_curve_end_multiplier" real,
	"tsl_curve_hold_minutes" integer,
	"avg_hold_minutes" real,
	"median_hold_minutes" integer,
	"whale_entered_1sol" integer DEFAULT 0,
	"whale_entered_5sol" integer DEFAULT 0,
	"whale_entered_10sol" integer DEFAULT 0,
	"time_since_first_whale_1sol" integer,
	"time_since_first_whale_5sol" integer,
	"fingerprint_vector" jsonb,
	"confidence" real DEFAULT 0.5,
	"trajectory_outcome" text,
	"final_multiplier" real,
	"final_timestamp" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_milestone_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"milestone_bucket" text NOT NULL,
	"bucket_duration_seconds" integer,
	"snapshot_timestamp" integer NOT NULL,
	"token_age_seconds" integer NOT NULL,
	"price_usd" real,
	"market_cap_usd" real,
	"liquidity_usd" real,
	"volume_24h_usd" real,
	"buys_in_bucket" integer,
	"sells_in_bucket" integer,
	"volume_in_bucket" real,
	"holder_count" integer,
	"top_holder_percent" real,
	"known_whales_active" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"early_buyer_win_rate" real,
	"early_buyer_median_multiplier" real,
	"profitable_wallet_count" integer,
	"peak_multiplier_all_time" real,
	"peak_multiplier_current_window" real,
	"time_to_peak_minutes" integer,
	"is_played_out" boolean DEFAULT false,
	"played_out_reason" text,
	"bonding_velocity" real,
	"bonding_buyer_growth_rate" real,
	"bonding_early_buyer_concentration" real,
	"raydium_volume_acceleration" real,
	"raydium_price_slope" real,
	"raydium_holder_growth" real,
	"last_analyzed_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "token_outcomes_token_mint_unique" UNIQUE("token_mint")
);
--> statement-breakpoint
CREATE TABLE "token_popularity" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"signal_wallet_count" integer DEFAULT 0,
	"total_buys" integer DEFAULT 0,
	"total_sells" integer DEFAULT 0,
	"independent_confirmations" integer DEFAULT 0,
	"avg_return_percent" real,
	"median_return_percent" real,
	"best_return_percent" real,
	"worst_return_percent" real,
	"avg_pump_duration_minutes" integer,
	"repeat_interest_count" integer DEFAULT 0,
	"trending_appearances" integer DEFAULT 0,
	"crash_recovery_count" integer DEFAULT 0,
	"deployer_address" text,
	"deployer_token_count" integer,
	"deployer_avg_return" real,
	"first_seen_at" integer,
	"last_activity_at" integer,
	"updated_at" integer,
	"created_at" integer NOT NULL,
	CONSTRAINT "token_popularity_token_mint_unique" UNIQUE("token_mint")
);
--> statement-breakpoint
CREATE TABLE "token_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_name" text,
	"captured_at" integer NOT NULL,
	"price_usd" real,
	"market_cap" real,
	"fdv" real,
	"liquidity" real,
	"volume_24h" real,
	"price_change_24h" real,
	"pair_created_at" integer,
	"token_age_minutes" integer,
	"buys_24h" integer,
	"sells_24h" integer,
	"buy_volume_24h" real,
	"sell_volume_24h" real,
	"holders" integer,
	"top_holder_percent" real,
	"dev_wallet_percent" real,
	"top_holders" jsonb,
	"lp_burned" boolean,
	"lp_locked_percent" real,
	"source_wallets" jsonb DEFAULT '[]'::jsonb,
	"known_whales_buying" integer DEFAULT 0,
	"has_twitter" boolean DEFAULT false,
	"has_telegram" boolean DEFAULT false,
	"has_website" boolean DEFAULT false,
	"twitter_handle" text,
	"social_search_result" text,
	"ai_score" integer,
	"ai_analysis" text,
	"ai_scored_at" integer,
	"final_multiplier" real,
	"hold_time_minutes" integer,
	"outcome_updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "trade_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"enabled" boolean DEFAULT false,
	"buy_percentage" real DEFAULT 10,
	"min_delay_minutes" integer DEFAULT 20,
	"max_delay_minutes" integer DEFAULT 40,
	"high_volume_buy_count" integer DEFAULT 10,
	"price_rise_trigger_percent" real DEFAULT 15,
	"reclaim_multiplier" real DEFAULT 4,
	"progressive_tp_thresholds" jsonb DEFAULT '[10,100,1000,10000]'::jsonb,
	"progressive_tp_percents" jsonb DEFAULT '[10,10,10,10]'::jsonb,
	"milestones_to_alert" jsonb DEFAULT '[2,4,10]'::jsonb,
	"dump_alert_enabled" boolean DEFAULT true,
	"dump_alert_threshold" real DEFAULT 50,
	"min_buy_score" integer,
	"stop_loss_percent" real,
	"stop_loss_floor_usd" real,
	"max_trade_usd" real,
	"max_daily_spend_usd" real,
	"min_reserve_sol" real,
	"daily_spent_usd" real DEFAULT 0,
	"daily_spent_reset_at" integer,
	"slippage_mode" text DEFAULT 'auto',
	"slippage_max_bps" integer DEFAULT 500,
	"slippage_min_bps" integer DEFAULT 50
);
--> statement-breakpoint
CREATE TABLE "trade_filters" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"operator" text NOT NULL,
	"value" real NOT NULL,
	"enabled" boolean DEFAULT true,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"signal_wallet_id" integer,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"amount_sol" real,
	"amount_usd" real,
	"price_at_execution" real,
	"tx_signature" text,
	"failure_reason" text,
	"latency_ms" integer,
	"context" jsonb,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_rule_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false,
	"rules" jsonb NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"scope" text DEFAULT 'hotWallet' NOT NULL,
	"scope_id" integer,
	"token_mint" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"action" text NOT NULL,
	"direction" text NOT NULL,
	"percent_change" real NOT NULL,
	"timeframe_minutes" integer,
	"amount_type" text DEFAULT 'percent' NOT NULL,
	"amount_value" real NOT NULL,
	"max_amount_usd" real,
	"max_trigger_count" integer,
	"trigger_count" integer DEFAULT 0,
	"cooldown_minutes" integer DEFAULT 15,
	"last_triggered_at" integer,
	"require_autonomy" boolean DEFAULT true,
	"min_position_value_usd" real,
	"max_position_value_usd" real,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"service" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"key_label" text,
	"is_valid" boolean DEFAULT true,
	"last_validated_at" integer,
	"monthly_budget" integer DEFAULT 1000000,
	"wallet_limit" integer DEFAULT 100,
	"current_wallet_count" integer DEFAULT 0,
	"contributes_to_pool" boolean DEFAULT true,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "user_budget_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"api_key_id" integer,
	"month" text NOT NULL,
	"monthly_budget" integer DEFAULT 1000000 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"credits_remaining" integer DEFAULT 1000000 NOT NULL,
	"days_in_month" integer DEFAULT 30 NOT NULL,
	"current_day" integer DEFAULT 1 NOT NULL,
	"target_daily_rate" integer,
	"actual_daily_rate" integer,
	"is_throttled" boolean DEFAULT false,
	"throttle_factor" real DEFAULT 1,
	"surplus_credits" integer DEFAULT 0,
	"last_calculated_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "user_event_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"min_value_threshold" real DEFAULT 0,
	"muted_tokens" jsonb DEFAULT '[]'::jsonb,
	"focus_wallets" jsonb DEFAULT '[]'::jsonb,
	"summary_focus" text,
	"pinch_emails_enabled" boolean DEFAULT true,
	"last_summary_at" integer,
	"updated_at" integer NOT NULL,
	CONSTRAINT "user_event_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"affinity_score" integer DEFAULT 0,
	"relationship_type" text DEFAULT 'new',
	"adversarial_score" integer DEFAULT 0,
	"friendly_score" integer DEFAULT 50,
	"playful_score" integer DEFAULT 30,
	"professional_score" integer DEFAULT 50,
	"nickname_tier" integer DEFAULT 0,
	"trust_level" integer DEFAULT 0,
	"sass_level" integer DEFAULT 3,
	"secrets_shared" integer DEFAULT 0,
	"total_interactions" integer DEFAULT 0,
	"crab_mentions" integer DEFAULT 0,
	"crab_insults" integer DEFAULT 0,
	"compliments_given" integer DEFAULT 0,
	"pet_peeves_triggered" integer DEFAULT 0,
	"trades_won_together" integer DEFAULT 0,
	"trades_lost_together" integer DEFAULT 0,
	"warnings_ignored" integer DEFAULT 0,
	"warnings_followed" integer DEFAULT 0,
	"last_interaction" integer,
	"inside_jokes" jsonb DEFAULT '[]'::jsonb,
	"memorable_events" jsonb DEFAULT '[]'::jsonb,
	"notes" jsonb DEFAULT '[]'::jsonb,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "user_relationships_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_token_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"viewed_at" integer NOT NULL,
	"ai_analysis_score" integer,
	"pnl_percent" real,
	"source_wallet_id" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false,
	"created_at" integer NOT NULL,
	"last_login_at" integer,
	"recovery_email" text,
	"helius_api_key" text,
	"default_cashout_wallet" text,
	"telegram_chat_id" text,
	"telegram_link_token" text,
	"telegram_linked_at" integer,
	"email_provider" text,
	"email_api_key" text,
	"email_from_address" text,
	"smtp_config" jsonb,
	"onboarding_completed" boolean DEFAULT false,
	"withdrawal_pin_hash" text,
	"pin_mode" text DEFAULT 'withdrawals_only',
	"pin_threshold_usd" real DEFAULT 100,
	"daily_spend_limit_usd" real,
	"withdrawal_whitelist" jsonb DEFAULT '[]'::jsonb,
	"telegram_confirm_large_transfers" boolean DEFAULT false,
	"large_transfer_threshold_usd" real DEFAULT 500,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "vector_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"vector_type" text NOT NULL,
	"target_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"signal_data" jsonb,
	"embedding" jsonb,
	"weight" real DEFAULT 1,
	"bucket_id" text NOT NULL,
	"processed" boolean DEFAULT false,
	"processed_at" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"wallet_addresses" jsonb,
	"cluster_type" text,
	"avg_win_rate" real,
	"avg_hold_duration" real,
	"coordination_score" real,
	"sample_count" integer,
	"cohesion" real,
	"centroid" jsonb,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "wallet_clusters_cluster_id_unique" UNIQUE("cluster_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_correlations" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_a" text NOT NULL,
	"wallet_b" text NOT NULL,
	"shared_token_count" integer DEFAULT 0,
	"timing_correlation" real,
	"same_group_likelihood" real,
	"updated_at" integer,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_fingerprint_discovery" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"fingerprint_id" integer NOT NULL,
	"token_mint" text NOT NULL,
	"discovery_milestone" text NOT NULL,
	"discovered_at_timestamp" integer NOT NULL,
	"trade_count" integer,
	"first_trade_timestamp" integer,
	"last_trade_timestamp" integer,
	"wallet_pnl" real,
	"wallet_multiplier" real,
	"hold_duration_minutes" integer,
	"discovered_by" text,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_fingerprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"avg_hold_duration_minutes" integer,
	"hold_duration_std_dev" real,
	"shortest_hold" integer,
	"longest_hold" integer,
	"avg_entry_size_usd" real,
	"entry_size_std_dev" real,
	"avg_entry_percent" real,
	"partial_sell_rate" real,
	"avg_sell_tiers" real,
	"rage_exit_rate" real,
	"pre_volume_buy_rate" real,
	"avg_entry_to_volume_spike" integer,
	"playbook_score" real,
	"regime_adaptation" real,
	"trades_in_chaos" integer DEFAULT 0,
	"total_trades" integer DEFAULT 0,
	"chaos_avoidance_score" real,
	"copying_users_count" integer DEFAULT 0,
	"alpha_decay_factor" real,
	"first_analyzed_at" integer NOT NULL,
	"last_updated_at" integer NOT NULL,
	"sample_size" integer DEFAULT 0,
	CONSTRAINT "wallet_fingerprints_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "wallet_funding_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"funder_wallet" text NOT NULL,
	"recipient_wallet" text NOT NULL,
	"sol_amount" real NOT NULL,
	"transferred_at" integer NOT NULL,
	"discovered_at" integer NOT NULL,
	"recipient_status" text DEFAULT 'pending' NOT NULL,
	"recipient_first_action_at" integer,
	"recipient_first_action_type" text,
	"next_hop_wallet" text,
	"chain_depth" integer DEFAULT 0 NOT NULL,
	"signal_strength" real DEFAULT 1 NOT NULL,
	"funder_success_rate" real,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "idx_funding_unique" UNIQUE("funder_wallet","recipient_wallet","transferred_at")
);
--> statement-breakpoint
CREATE TABLE "wallet_limits_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_wallet_limit" integer DEFAULT 2 NOT NULL,
	"wallets_per_api_key" integer DEFAULT 2 NOT NULL,
	"max_wallet_limit" integer DEFAULT 20 NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "wallet_reputation" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"rug_count" integer DEFAULT 0,
	"successful_trades" integer DEFAULT 0,
	"total_trades" integer DEFAULT 0,
	"avg_hold_time_minutes" integer,
	"avg_multiplier" real,
	"last_trade_at" integer,
	"reputation_score" real,
	"notes" text,
	"updated_at" integer NOT NULL,
	CONSTRAINT "wallet_reputation_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "wallet_rule_defaults" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"take_profit_thresholds" jsonb DEFAULT '[4,10,25,100]'::jsonb,
	"take_profit_percentages" jsonb DEFAULT '[25,25,25,25]'::jsonb,
	"take_profit_enabled" jsonb DEFAULT '[true,true,true,true]'::jsonb,
	"stop_loss_percent" real DEFAULT 50,
	"stop_loss_floor_usd" real,
	"stop_loss_mode" text DEFAULT 'auto',
	"auto_mirror_sells" boolean DEFAULT false,
	"autonomy_enabled" boolean DEFAULT false,
	"created_at" integer NOT NULL,
	"updated_at" integer,
	CONSTRAINT "wallet_rule_defaults_wallet_id_unique" UNIQUE("wallet_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"user_id" integer NOT NULL,
	"strategy_type" text,
	"trading_style" text,
	"avg_hold_duration" integer,
	"avg_position_size" real,
	"win_rate" real,
	"avg_profit" real,
	"avg_loss" real,
	"profit_factor" real,
	"preferred_entry_time" text,
	"entry_token_age" text,
	"entry_market_cap" text,
	"take_profit_multiplier" real,
	"stop_loss_percent" real,
	"trailing_sell_enabled" boolean,
	"risk_level" integer,
	"diversification" real,
	"max_concurrent_positions" integer,
	"confidence_score" real DEFAULT 0,
	"sample_size" integer DEFAULT 0,
	"last_updated_at" integer,
	"version" integer DEFAULT 1,
	"created_at" integer NOT NULL,
	"ai_recommendations" text,
	"swap_count_at_analysis" integer,
	"behavior_type" text,
	"behavior_confidence" real,
	"discovery_insights" text
);
--> statement-breakpoint
CREATE TABLE "wallet_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"hit_rate" real,
	"avg_hold_time_minutes" integer,
	"avg_return_percent" real,
	"total_trades" integer DEFAULT 0,
	"winning_trades" integer DEFAULT 0,
	"losing_trades" integer DEFAULT 0,
	"best_hour_utc" integer,
	"best_day_of_week" integer,
	"timing_patterns" jsonb,
	"sector_preference" text,
	"sector_breakdown" jsonb,
	"avg_entry_market_cap" real,
	"market_cap_success_rates" jsonb,
	"buy_sell_ratio" real,
	"avg_buy_size" real,
	"compute_trust_score" real DEFAULT 0.5,
	"compute_tasks_completed" integer DEFAULT 0,
	"compute_tasks_failed" integer DEFAULT 0,
	"last_trade_at" integer,
	"updated_at" integer,
	"created_at" integer NOT NULL,
	CONSTRAINT "wallet_summaries_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
CREATE TABLE "webhook_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"wallet_address" text,
	"token_mint" text,
	"status" text NOT NULL,
	"processing_time_ms" integer,
	"context" jsonb,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whale_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_addresses" jsonb NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"first_seen_together" integer NOT NULL,
	"last_seen_together" integer NOT NULL,
	"coordinated_event_count" integer DEFAULT 0,
	"cluster_type" text,
	"type_confidence" real,
	"total_tokens_traded" integer DEFAULT 0,
	"profitable_tokens" integer DEFAULT 0,
	"avg_exit_multiplier" real,
	"cluster_success_rate" real,
	"reliability_score" real DEFAULT 50,
	"is_active" boolean DEFAULT true,
	"last_activity_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer
);
--> statement-breakpoint
CREATE TABLE "whale_token_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"whale_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text,
	"entry_timestamp" integer NOT NULL,
	"entry_rank" integer,
	"entry_price_usd" real,
	"entry_market_cap" real,
	"exit_timestamp" integer,
	"exit_price_usd" real,
	"exit_market_cap" real,
	"exit_multiplier" real,
	"status" text DEFAULT 'holding',
	"peak_multiplier" real,
	"hold_time_minutes" integer
);
--> statement-breakpoint
CREATE INDEX "idx_token_mint_trajectory" ON "active_token_trajectories" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX "idx_snapshot_sequence" ON "active_token_trajectories" USING btree ("token_mint","snapshot_sequence");--> statement-breakpoint
CREATE INDEX "idx_snapshot_timestamp" ON "active_token_trajectories" USING btree ("snapshot_timestamp");--> statement-breakpoint
CREATE INDEX "idx_archived_at" ON "active_token_trajectories" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX "idx_current_multiplier" ON "active_token_trajectories" USING btree ("current_multiplier");--> statement-breakpoint
CREATE INDEX "idx_bot_wallet" ON "bot_flagged_wallets" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_bot_confidence" ON "bot_flagged_wallets" USING btree ("bot_confidence");--> statement-breakpoint
CREATE INDEX "idx_bot_flagged_at" ON "bot_flagged_wallets" USING btree ("flagged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_source_date_unique" ON "compute_source_stats" USING btree ("source_id","date");--> statement-breakpoint
CREATE INDEX "idx_creator_win_rate" ON "creator_reputation" USING btree ("win_rate");--> statement-breakpoint
CREATE INDEX "idx_creator_samples" ON "creator_reputation" USING btree ("total_launches");--> statement-breakpoint
CREATE INDEX "idx_fingerprint_cluster_id" ON "fingerprint_lifecycle_metrics" USING btree ("fingerprint_cluster_id");--> statement-breakpoint
CREATE INDEX "idx_early_win_rate" ON "fingerprint_lifecycle_metrics" USING btree ("early_win_rate");--> statement-breakpoint
CREATE INDEX "idx_confidence_score" ON "fingerprint_lifecycle_metrics" USING btree ("confidence_score");--> statement-breakpoint
CREATE INDEX "idx_fingerprint_id" ON "fingerprint_snapshot_reference" USING btree ("fingerprint_id");--> statement-breakpoint
CREATE INDEX "idx_t0_snapshot_id" ON "fingerprint_snapshot_reference" USING btree ("t0_milestone_snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_is_immutable" ON "fingerprint_snapshot_reference" USING btree ("is_immutable");--> statement-breakpoint
CREATE INDEX "idx_win_rate" ON "good_traders" USING btree ("win_rate");--> statement-breakpoint
CREATE INDEX "idx_total_pnl" ON "good_traders" USING btree ("total_pnl");--> statement-breakpoint
CREATE INDEX "idx_discovery_score" ON "good_traders" USING btree ("discovery_score");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wallet_address_unique" ON "good_traders" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_graduation_time" ON "graduation_events" USING btree ("graduation_time");--> statement-breakpoint
CREATE INDEX "idx_token_mint" ON "graduation_events" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX "idx_method_env" ON "jupiter_latency_stats" USING btree ("method","environment");--> statement-breakpoint
CREATE INDEX "idx_sampled_at" ON "jupiter_latency_stats" USING btree ("sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "price_snapshot_mint_date" ON "price_snapshots" USING btree ("token_mint","snapshot_date","snapshot_type");--> statement-breakpoint
CREATE INDEX "price_snapshot_mint_type" ON "price_snapshots" USING btree ("token_mint","snapshot_type");--> statement-breakpoint
CREATE INDEX "idx_token_mint_recent" ON "raw_token_trades" USING btree ("token_mint","discovered_at");--> statement-breakpoint
CREATE INDEX "idx_created_at" ON "raw_token_trades" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_discovered_at" ON "raydium_pool_discoveries" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "idx_base_token" ON "raydium_pool_discoveries" USING btree ("base_token_mint");--> statement-breakpoint
CREATE INDEX "idx_threshold_type" ON "retrolearner_thresholds" USING btree ("threshold_type");--> statement-breakpoint
CREATE INDEX "idx_threshold_confidence" ON "retrolearner_thresholds" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "idx_retrolearner_wallet" ON "retrolearner_wallet_analysis" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_retrolearner_last_analyzed" ON "retrolearner_wallet_analysis" USING btree ("last_analyzed_at");--> statement-breakpoint
CREATE INDEX "idx_retrolearner_active" ON "retrolearner_wallet_analysis" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_server_name" ON "server_subscriptions" USING btree ("server_name");--> statement-breakpoint
CREATE INDEX "idx_subscription_type" ON "server_subscriptions" USING btree ("subscription_type");--> statement-breakpoint
CREATE INDEX "idx_ss_token_mint" ON "server_subscriptions" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX "idx_wallet_address" ON "server_subscriptions" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "idx_archetype_type" ON "token_fingerprint_clusters" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_stage" ON "token_fingerprint_clusters" USING btree ("lifecycle_stage");--> statement-breakpoint
CREATE INDEX "idx_outcome_distribution" ON "token_fingerprint_clusters" USING btree ("outcome_distribution");--> statement-breakpoint
CREATE INDEX "idx_archetype_cohesion" ON "token_fingerprint_clusters" USING btree ("cohesion");--> statement-breakpoint
CREATE INDEX "idx_archetype_sample_count" ON "token_fingerprint_clusters" USING btree ("sample_count");--> statement-breakpoint
CREATE INDEX "idx_token_mint_timestamp" ON "token_fingerprint_snapshots" USING btree ("token_mint","timestamp");--> statement-breakpoint
CREATE INDEX "idx_token_mint_snapshot_number" ON "token_fingerprint_snapshots" USING btree ("token_mint","snapshot_number");--> statement-breakpoint
CREATE INDEX "idx_position_in_arc" ON "token_fingerprint_snapshots" USING btree ("position_in_arc");--> statement-breakpoint
CREATE INDEX "idx_fingerprint_type_trigger" ON "token_fingerprints" USING btree ("fingerprint_type","snapshot_trigger");--> statement-breakpoint
CREATE INDEX "idx_token_mint_snapshots" ON "token_fingerprints" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX "idx_creator_address" ON "token_fingerprints" USING btree ("creator_address");--> statement-breakpoint
CREATE INDEX "idx_whale_entries" ON "token_fingerprints" USING btree ("whale_entered_5sol","token_age_minutes");--> statement-breakpoint
CREATE INDEX "idx_archetype_cluster_id" ON "token_fingerprints" USING btree ("archetype_cluster_id");--> statement-breakpoint
CREATE INDEX "idx_token_mint_milestone" ON "token_milestone_snapshots" USING btree ("token_mint","milestone_bucket");--> statement-breakpoint
CREATE INDEX "idx_milestone_bucket" ON "token_milestone_snapshots" USING btree ("milestone_bucket");--> statement-breakpoint
CREATE INDEX "idx_tms_snapshot_timestamp" ON "token_milestone_snapshots" USING btree ("snapshot_timestamp");--> statement-breakpoint
CREATE INDEX "idx_token_mint_outcomes" ON "token_outcomes" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX "idx_is_played_out" ON "token_outcomes" USING btree ("is_played_out");--> statement-breakpoint
CREATE INDEX "idx_last_analyzed" ON "token_outcomes" USING btree ("last_analyzed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_token_unique" ON "user_token_views" USING btree ("user_id","token_mint");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cluster_id_unique" ON "wallet_clusters" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "idx_cluster_type" ON "wallet_clusters" USING btree ("cluster_type");--> statement-breakpoint
CREATE INDEX "idx_coordination_score" ON "wallet_clusters" USING btree ("coordination_score");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_pair_unique" ON "wallet_correlations" USING btree ("wallet_a","wallet_b");--> statement-breakpoint
CREATE INDEX "idx_wallet_address_fingerprint" ON "wallet_fingerprint_discovery" USING btree ("wallet_address","fingerprint_id");--> statement-breakpoint
CREATE INDEX "idx_fingerprint_id_discovery" ON "wallet_fingerprint_discovery" USING btree ("fingerprint_id");--> statement-breakpoint
CREATE INDEX "idx_discovery_milestone" ON "wallet_fingerprint_discovery" USING btree ("discovery_milestone");--> statement-breakpoint
CREATE INDEX "idx_wallet_multiplier" ON "wallet_fingerprint_discovery" USING btree ("wallet_multiplier");--> statement-breakpoint
CREATE INDEX "idx_funding_funder" ON "wallet_funding_links" USING btree ("funder_wallet");--> statement-breakpoint
CREATE INDEX "idx_funding_recipient" ON "wallet_funding_links" USING btree ("recipient_wallet");--> statement-breakpoint
CREATE INDEX "idx_funding_status" ON "wallet_funding_links" USING btree ("recipient_status");--> statement-breakpoint
CREATE INDEX "idx_funding_verified" ON "wallet_funding_links" USING btree ("is_verified");