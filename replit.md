# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform designed for copy trading from signal wallets, manual trading, and AI-driven trading. It aims to be a comprehensive, intelligent, and secure solution on the Solana blockchain, offering automated risk management, adaptive AI learning, and pattern-based swing trading to improve user profitability and experience in decentralized finance.

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
The application employs a client-server architecture, featuring a React frontend, an Express.js backend, and a PostgreSQL database. Real-time communication is facilitated by WebSockets, and Helius webhooks are utilized for push-based swap detection. User data is strictly isolated.

### Frontend
The UI is built with React and Vite, featuring a dark theme with crypto-themed green accents. It includes a Dashboard, Watchlist, Trading (with Token sub-page), Settings, and an omnipresent AI chat component (Pincher Footer). Navigation is dashboard-centric, utilizing panels as the primary navigation mechanism.

### Backend
The Express backend handles user authentication (session-based), Solana service integrations, and business logic. It processes Helius webhooks, uses Resend for email, and integrates Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
PostgreSQL is used for persistent storage of user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, with strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Leverages Helius webhooks for immediate transaction detection.
- **Automated Copy Trading**: Features a hot wallet system with advanced encryption, dynamic priority fees, split buy systems, progressive take-profit, unique disposable token wallets per buy, and backup gas funding. Includes configurable initial buy modes, budget controls, and mirror trading options.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis via a chat interface, requiring explicit user confirmation for trades.
- **Security**: Robust authentication (PBKDF2, secure sessions), encrypted data, PIN protection, daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Achieved through user isolation and webhook-driven event processing.
- **API Management**: Tracks API usage with limits and uses an admin API key pool for load balancing across providers.
- **Tiered Price Aggregation**: Uses OHLC+ price data with multi-tier retention for swing detection.
- **Whale Detection**: Caches top-100 holder lists and broadcasts whale activity events.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity, recent buys, price volatility, user attention, and recency.
- **Telegram Integration**: Two-way webhook-based bot for alerts and routing non-command messages to Miss Pincher AI.
- **AI Filter Creation**: Natural language filter creation via Miss Pincher chat.
- **USD Conversions**: Live SOL-to-USD conversion using cached price data.
- **AI Budget System**: Manages AI interactions with throttling and heat-gated analysis.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet.
- **Position Model**: Each trading position is stored in the `holdings` table, tracking token details, source, and per-position configurations, allowing multiple positions on the same token.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Dual learning systems with adaptive dampening for weight shifts based on data confidence.
- **Familiar Whale Tracking**: Tracks whales across tokens and builds success profiles.
- **Tiered Event Buckets**: Position snapshots store journey data in compressed tiers.
- **Stop-Loss Mode**: Per-position `stopLossMode` setting: "auto" (immediate sell) or "alert" (notify and wait for user confirmation).
- **Signal Wallet Detail Page**: Displays individual wallet activity, trade history, hit rate, P&L, trading style analysis, and timeframe filters, with real-time WebSocket updates.
- **AI-Controlled Blacklist**: Miss Pincher can add, remove, and list blacklisted tokens via natural language commands.
- **AI Relationship System**: Tracks user affinity, relationship type, trades won, and warnings followed/ignored, with auto-adjustment of relationship type.
- **Production System Logging**: Separated logging architecture with dedicated tables for AI, API, webhook, trade, and error logs for faster queries and independent retention.
- **Copy Trade Decision Logging**: All copy trade decisions are logged to `trade_logs` with full context, including user, signal wallet, token, copy settings, and check results.
- **Budget & API Management System**: Implements per-minute rate limiting for all providers (GeckoTerminal, DexScreener, Helius, OpenAI) with smooth throttling and exponential backoff on 429 errors.
- **Dual-Source Price System**: Primary prices from swap webhooks, with batched DexScreener calls as a secondary source for market data. Includes price discrepancy detection.
- **Batched DexScreener Refresh**: Background job for refreshing DexScreener data, targeting 80% of the daily budget, with dynamic interval adjustment.
- **Browser-Based Discovery Worker**: Distributed task queue for token metadata lookups using user browsers, with atomic tasks and auto-requeue on disconnect.
- **Memory-First Caching**: In-memory token data cache with 5-minute flush cycles to the database, reducing DB writes by approximately 90%.
- **Storage Bucketing**: Tiered data compression (1-day→3-day→weekly buckets) with a daily scheduler to manage database costs.
- **GeckoTerminal Integration**: Primary data source for trending tokens and new Solana pools, with rate-limited scheduling and error handling.
- **Daily Price Snapshots**: Midnight UTC snapshots with pre-computed 7d/14d/30d price change calculations and summary jobs for wallet profiles, token popularity, and cross-wallet correlations.
- **Discovery Metrics**: 8 computed metrics per token: trending_momentum, boost_intensity, multi_wallet_convergence, deployer_track_record, price_slope, crash_recovery, repeat_interest, wallet_quality.
- **Historical Context System**: Tracks token history (rugpulls, relaunches), wallet pattern analysis, and holder overlap analysis.
- **Context-Aware Scanning**: Urgency scoring system for discovery scans with context logging and a self-improvement system for generating new scan triggers.
- **Discovery Event Bus**: Reactive event bus connecting all data sources, with event types like `trending_spotted`, `signal_buy`, `new_token`, and combo detection. Triggers immediate discovery scans and generates vector updates.
- **Discovery Optimizer**: Adaptive review scheduler, LLM graduation system to skip LLM when rules exceed confidence, and self-adjusting thresholds based on win/loss outcomes.
- **Distributed Compute Framework**: Expanded `computeTasks` table supporting backend, compute-node, and browser worker types. Includes trust scoring, task prioritization, spot-checking, and dynamic TTLs.
- **Vector Learning**: Incorporates multi-dimensional personality and trading vectors, strategy clustering, unified vector routing, and 8-hour bucket aggregation for self-optimization.
- **System Insight Bus**: Cross-system knowledge sharing via `systemInsights` table. Facilitates LLM→Trigger flow for rule creation and Trigger→LLM flow for AI context injection and rule performance feedback.
- **Admin Chat Interface**: Conversational AI interface for system monitoring with dynamic system context injection, summary cards, and recent observations.
- **Discovery-Enhanced Strategy Analysis**: Signal wallet strategy analysis integrates discovery engine insights for behavior classification and leader/follower relationships, with smart auto-caching.
- **Token Detail Page**: Enhanced `/trading/:token` page with DexScreener price chart, external resource links, and Paper Buy/Sell buttons.
- **Signal Wallet Page Enhancements**: Paper Copy button for simulated copy trading, and improved visibility of Trade History.
- **Technical Indicators Engine**: Computes EMA(12/26), RSI(14), MACD, Bollinger Bands(20,2), OBV, and Stochastic(14,3,3) from priceHistoryCache OHLCV candles with 5-minute caching and composite scoring (0-100 with buy/sell/neutral bias).
- **Discovery Event Bus Indicator Scanner**: Runs every 15 minutes on top 50 active tokens, emits price_surge events when indicators cross thresholds, publishes insights to the System Insight Bus.
- **Discovery Page** (`/discovery`): Ranked token list (sortable by discovery score, volume, trending, boost, price change), ranked wallet list (by win rate and composite wallet score), stats counters (active tokens, tracked wallets, events, insights, trending, boosted), recent insights feed, and engine status panel. API routes aggregate from discoveryEvents, tokenDataPool, walletStrategies, and systemInsights tables.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, and dynamic priority fee estimation.
- **Chainstack**: Primary RPC provider for raw Solana calls, with automatic failover to Helius.
- **Resend**: For sending email notifications.
- **Jupiter**: For executing token swaps on the Solana blockchain and as a fallback for token symbol/name lookup.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Secondary source for token metadata (price, market cap, liquidity, FDV, volume) and boost tracking.
- **GeckoTerminal**: Primary token metadata provider for trending tokens and new Solana pools.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.

## Paused Tasks / Backlog
- **Bubblemaps Integration**: Embed Bubblemaps holder distribution and wallet activity iframes on token and signal wallet pages. Requires domain whitelisting with Bubblemaps for production embedding (demo partnerId only works on localhost). Re-add when whitelisting is available.