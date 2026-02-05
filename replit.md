# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform providing copy trading from signal wallets, manual trading, and AI-driven trading. Its core purpose is to offer a comprehensive, intelligent, and secure solution on the Solana blockchain, featuring automated risk management, adaptive AI learning, and pattern-based swing trading to enhance user profitability and experience in decentralized finance.

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
The application uses a client-server architecture with a React frontend, an Express.js backend, and a PostgreSQL database. Real-time communication is handled via WebSockets, and Helius webhooks are used for push-based swap detection. User data is strictly isolated.

### Frontend
The UI, built with React and Vite, features a dark theme with crypto-themed green accents. It includes a Dashboard, Watchlist, Trading (with Token sub-page), Settings, and an omnipresent AI chat component (Pincher Footer). Navigation is dashboard-centric, using panels as the primary navigation mechanism.

### Backend
The Express backend manages user authentication (session-based), Solana service integrations, and business logic. It processes Helius webhooks, uses Resend for email, and integrates Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
PostgreSQL is used for persistent storage of user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, with strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Leverages Helius webhooks.
- **Automated Copy Trading**: Includes a hot wallet system with AES-256-GCM encryption, dynamic priority fees, split buy systems, progressive take-profit strategies, unique disposable token wallets for each buy, and backup gas funding. Configurable initial buy modes, budget controls, mirror buy limits, mirror sell modes, and enhanced deduplication options are available.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis via a chat interface, requiring explicit user confirmation for trades and copy trading configuration changes.
- **Security**: Features robust authentication (PBKDF2, secure sessions), encrypted data storage, PIN protection, daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Achieved through user isolation and webhook-driven event processing.
- **API Management**: Tracks API calls with limits and uses an admin API key pool for load balancing.
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
- **Production System Logging**: Separated logging architecture with dedicated tables for faster queries and independent retention for AI, API, webhook, trade, and error logs.
- **Copy Trade Decision Logging**: All copy trade decisions logged to trade_logs with full context (userId, signalWalletId, tokenMint, copySettings, check results). Decision types: queued, skipped_sell, skipped_disabled, skipped_stablecoin, skipped_blacklist, skipped_holding, skipped_pending, skipped_ever_held, skipped_score, skipped_min_trade, skipped_budget. Query via /api/admin/trade-logs with signalWalletId and action filters.
- **Budget & API Management System**: Features a unified priority queue, safety checker (RugCheck + GoPlus), behavioral analysis (bot detection, leader/follower classification), wallet fingerprinting, discovery engine, and cluster learning.
- **Vector Learning**: Incorporates multi-dimensional personality and trading vectors, strategy clustering, unified vector routing, and 8-hour bucket aggregation for self-optimization.
- **System Insight Bus**: Cross-system knowledge sharing via `systemInsights` table. LLM→Trigger flow auto-creates rules from repeated high-confidence AI patterns (5+ occurrences, 60%+ confidence). Trigger→LLM flow injects rule performance into AI context via `buildContextForAI()`. Underperforming rules (<40% confidence) trigger AI fix proposals. All key systems (heat-score, discovery-engine, whale-detection, rule-executor) publish and consume insights. Insights decay in 8-hour aggregation cycle.
- **Admin Chat Interface**: Conversational AI interface for system monitoring at `/admin`. Features GPT-4o-mini powered chat with dynamic system context injection (errors, insights, rule performance, patterns). Summary cards display system health, 24h errors, 7d rules created, and patterns detected. Recent Observations panel shows top insight sources and recent patterns. Chat history stored in `adminChatMessages` table.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain, fallback for token symbol/name lookup.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Primary source for token metadata (price, market cap, liquidity, FDV, volume).
- **GeckoTerminal**: Fallback token metadata provider.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.