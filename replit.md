# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform offering copy trading from signal wallets, manual trading, and AI-driven trading. It aims to be a comprehensive, intelligent, and secure solution on the Solana blockchain, focusing on automated risk management, adaptive AI learning, and pattern-based swing trading to enhance user profitability and experience in decentralized finance.

## User Preferences
- I prefer simple language.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.
- When a task list is paused, record it in the "Paused Tasks / Backlog" section below.
- When discussing trading errors or copy trading issues, always assume production environment (not development).

## System Architecture

### High-Level Design
The application uses a client-server architecture with a React frontend, an Express.js backend, and a PostgreSQL database. Real-time communication is handled by WebSockets, and Helius webhooks enable push-based swap detection. User data is strictly isolated.

### Frontend
The UI is built with React and Vite, featuring a dark theme with crypto-themed green accents. It includes a Dashboard, Watchlist, Trading (with Token sub-page), Settings, and an omnipresent AI chat component. Navigation is dashboard-centric, using panels.

### Backend
The Express backend manages user authentication (session-based), Solana service integrations, and business logic. It processes Helius webhooks, uses Resend for email, and integrates Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
PostgreSQL stores user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, with strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Utilizes Helius webhooks for immediate transaction detection.
- **Automated Copy Trading**: Includes a hot wallet system with advanced encryption, dynamic priority fees, split buy systems, progressive take-profit, unique disposable token wallets, and backup gas funding. Offers configurable initial buy modes, budget controls, and mirror trading options.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis via a chat interface, requiring explicit user confirmation for trades.
- **Security**: Robust authentication, encrypted data, PIN protection, daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Achieved through user isolation and webhook-driven event processing.
- **API Management**: Tracks API usage with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: Uses OHLC+ price data with multi-tier retention for swing detection.
- **Three-Tier Whale Tracking**: Active tier (~50 wallets on webhook for realtime monitoring), Watch tier (~200 wallets with periodic RPC checks), Archive tier (stored only). Weekly rotation based on composite reputation scores (recency, success rate, volume, reliability, early entries). Managed by `whale-tracker.ts`.
- **Whale-Sourced Token Discovery**: Auto-discovers tokens from whale activity with per-whale 10-token cap, 24h recency filter, and multi-hop whale detection from token holders. Managed by `whale-discovery.ts`.
- **Whale Detection (Legacy)**: Caches top-100 holder lists and broadcasts whale activity events.
- **Telegram Integration**: Two-way webhook-based bot for alerts and AI routing.
- **AI Filter Creation**: Natural language filter creation via AI chat.
- **USD Conversions**: Live SOL-to-USD conversion using cached price data.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet.
- **Position Model**: Each trading position is stored in the `holdings` table, tracking token details, source, and per-position configurations, allowing multiple positions on the same token.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Dual learning systems with adaptive dampening for weight shifts based on data confidence.
- **Production System Logging**: Separated logging architecture with dedicated tables for AI, API, webhook, trade, and error logs for faster queries and independent retention.
- **Budget & API Management System**: Implements per-minute rate limiting for all providers with smooth throttling and exponential backoff.
- **Dual-Source Price System**: Primary prices from swap webhooks, with batched DexScreener calls as a secondary source. Includes price discrepancy detection.
- **Browser-Based Discovery Worker**: Distributed task queue for token metadata lookups using user browsers.
- **Memory-First Caching**: In-memory token data cache with 5-minute flush cycles to the database.
- **Storage Bucketing**: Tiered data compression (1-day→3-day→weekly buckets) with a daily scheduler to manage database costs.
- **Daily Price Snapshots**: Midnight UTC snapshots with pre-computed price change calculations and summary jobs for wallet profiles, token popularity, and cross-wallet correlations.
- **Discovery Metrics**: 8 computed metrics per token: trending_momentum, boost_intensity, multi_wallet_convergence, deployer_track_record, price_slope, crash_recovery, repeat_interest, wallet_quality.
- **Historical Context System**: Tracks token history, wallet pattern analysis, and holder overlap analysis.
- **Social Signal System**: Tracks Twitter/Telegram callers as alpha sources, recording calls with price-at-call snapshots and evaluating outcomes to compute trust scores and hit rates.
- **Discovery Event Bus**: Reactive event bus connecting all data sources, with various event types and combo detection, triggering immediate discovery scans and vector updates.
- **Discovery Optimizer**: Adaptive review scheduler, LLM graduation system, and self-adjusting thresholds based on win/loss outcomes.
- **Distributed Compute Framework**: Expanded `computeTasks` table supporting backend, compute-node, and browser worker types, including trust scoring, task prioritization, and dynamic TTLs.
- **Vector Learning**: Incorporates multi-dimensional personality and trading vectors, strategy clustering, unified vector routing, and 8-hour bucket aggregation for self-optimization.
- **System Insight Bus**: Cross-system knowledge sharing via `systemInsights` table, facilitating LLM→Trigger and Trigger→LLM flows for rule creation and AI context.
- **Admin Chat Interface**: Conversational AI interface for system monitoring with dynamic system context injection.
- **Discovery-Enhanced Strategy Analysis**: Signal wallet strategy analysis integrates discovery engine insights for behavior classification and leader/follower relationships.
- **Technical Indicators Engine**: Computes EMA, RSI, MACD, Bollinger Bands, OBV, and Stochastic from priceHistoryCache OHLCV candles with 5-minute caching and composite scoring.
- **Discovery Event Bus Indicator Scanner**: Runs every 15 minutes on top 50 active tokens, emitting `price_surge` events and publishing insights to the System Insight Bus.
- **Discovery Page** (`/discovery`): Ranked token and wallet lists, stats counters, recent insights feed, and engine status panel.
- **Paper Trading System**: Risk-free strategy testing via simulated trades. Integrated into the Holdings page. Supports manual trades with token preview and auto-close background jobs.
- **Discovery Auto-Paper-Trading**: Auto-opens paper trades on high-scoring tokens to learn optimal setups. Supports batch-triggered and event-triggered modes with token qualification filters and a 4-5 position strategy per token. Features adaptive thresholds, a 450+50 token pool, 1 SOL entry size, trailing stop exit, and enhanced close conditions. Distinguishes `token_discovery` vs `wallet_copy` trades for separate strategy learning. Includes a dedup guard and data retention policies.
- **Two-Tier Paper Trading Pricing**: Tier 1 (~100 tokens) gets realtime webhook prices with 1.0x learning weight. Tier 2 uses conservative 30-min OHLCV batch evaluation (0.5x weight) with worst-case candle assumptions (high for TP, low for SL). Tier assignment at position open based on webhook capacity. Managed by `paper-autoclose.ts`.
- **Unified Webhook Manager**: Single Helius webhook with priority routing handles signal wallets (P1), real positions (P2), paper positions (P3), whale activity (P4). Server-side address registry supports 100k+ addresses with priority-based classification. Managed by `unified-webhook.ts`.
- **Discovery Source Tracking**: Tags tokens and positions with discovery source (whale, signal_wallet, event_bus, trending, boosted). Aggregates paper trade outcomes per source to measure which discovery channels produce the best results.
- **Cluster-Whale Enrichment**: Cluster detection enriched with whale reputation data from familiar_whales, providing whale overlap percentage and average reputation scores per cluster.
- **Indicator Vectors for Pattern Learning**: Snapshots technical indicators (RSI, MACD, EMA, Bollinger, OBV, Stochastic, composite score) at trade entry/exit points and periodically for open positions. Correlates indicator patterns with trade outcomes per strategy cluster via adaptive dampening and nudge vectors. Produces learned optimal indicator ranges per cluster (e.g., optimal RSI entry range, preferred EMA cross direction). Integrated into AI batch scoring (vector match score), AI chat context, and strategy cluster analysis. Processed during 8-hour aggregation cycles. Managed by `indicator-vectors.ts`.
- **Enriched Snapshot Learning**: Exit snapshots include full trade journey data (price high/low, max drawdown, max unrealized gain, hold duration, volume stats, indicators at high/low points) computed from existing OHLCV candles — zero API calls. Entry/exit snapshots enriched with market context (liquidity, mcap, token age, holder count), whale context (count, reputation, sentiment), signal wallet confidence, discovery source, timing (hour/day), and derived metrics (SOL correlation, price velocity, relative volume, lifecycle stage, cluster crowding). Vector learning tracks optimal ranges for all context dimensions (ideal liquidity, preferred discovery source, best time-of-day, avg win/loss drawdown patterns). Managed by `snapshot-enrichment.ts`.

## Paused Tasks / Backlog

### Attention Score + Pincher Score Consolidation
- **Naming**: "Attention Score" = fast non-LLM numeric scoring (determines which tokens get system resources). "Pincher Score" = AI/LLM analysis (triggered by Pincher analysis button). Attention triggers Pincher when threshold crossed.
- Rename `computeHeatScore` in pincher-scoring.ts → `computeAttentionScore`, rename `heatScore` schema column → `attentionScore`
- Merge `heat-score.ts` activity signals (recent buys, user attention, recency) into attention score as sub-components, migrate all consumers
- Add LP safety/rugcheck/pumpfun/discovery source quality factors to attention score
- Pincher Score should weigh more heavily for discovery decisions
- Extract LP burn/lock data from existing RugCheck API response (currently not parsed), store in tokenDataPool
- Enrich AI Pincher Score prompt with: LP burn/lock, rugcheck score/risks, pumpfun status, trending/boost rank, discovery source
- Add LP/rugcheck to snapshot-enrichment.ts market context for vector learning
- Pass LP data through routes.ts enrichment + buildPoolFallback to frontend
- Show LP burned/locked status on token page UI

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, and dynamic priority fee estimation.
- **Chainstack**: Primary RPC provider for raw Solana calls, with automatic failover to Helius.
- **Resend**: For sending email notifications.
- **Jupiter**: For executing token swaps on the Solana blockchain and as a fallback for token symbol/name lookup.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Secondary source for token metadata (price, market cap, liquidity, FDV, volume) and boost tracking.
- **GeckoTerminal**: Primary token metadata provider for trending tokens and new Solana pools.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.