# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform offering copy trading from signal wallets, manual trading, and autonomous AI-driven trading. Its primary purpose is to provide a comprehensive, intelligent, and secure solution on the Solana blockchain, incorporating automated risk management, adaptive AI learning, and pattern-based swing trading. The platform aims to enhance user profitability and experience in decentralized finance through features like the AI assistant, Miss Pincher, which autonomously trades based on user-defined rules and evolving scoring models.

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
The application utilizes a client-server architecture with a React frontend, an Express.js backend, and a PostgreSQL database. Real-time communication is handled via WebSockets, and Helius webhooks are used for push-based swap detection. User data is strictly isolated.

### Frontend
The UI, built with React and Vite, features a dark theme with crypto-themed green accents. It includes a Dashboard, Watchlist, Trading (with Token sub-page), Settings, and an omnipresent AI chat component (Pincher Footer). Navigation is dashboard-centric, using panels as the primary navigation mechanism, eliminating sidebars and bottom navigation.

### Backend
The Express backend manages user authentication (session-based), Solana service integrations, and business logic. It processes Helius webhooks, uses Resend for email, and integrates Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
PostgreSQL is used for persistent storage of user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, with strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Leverages Helius webhooks.
- **Automated Copy Trading**: Includes a hot wallet system with AES-256-GCM encryption, dynamic priority fees, split buy systems, progressive take-profit strategies, unique disposable token wallets for each buy, and backup gas funding. Configurable initial buy modes, budget controls, mirror buy limits, mirror sell modes, and enhanced deduplication options are available.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis via a chat interface for natural language interaction and action triggers, requiring explicit user confirmation for trades and copy trading configuration changes.
- **Security**: Features robust authentication (PBKDF2, secure sessions), encrypted data storage, PIN protection, daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Achieved through user isolation and webhook-driven event processing.
- **API Management**: Tracks API calls with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: Uses OHLC+ price data with multi-tier retention for swing detection.
- **Whale Detection**: Caches top-100 holder lists and broadcasts whale activity events.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity, recent buys, price volatility, user attention, and recency.
- **Telegram Integration**: Two-way webhook-based bot for alerts and routing non-command messages to Miss Pincher AI.
- **Notifications Architecture**: Multi-provider email support with Telegram as priority.
- **AI Filter Creation**: Natural language filter creation via Miss Pincher chat.
- **USD Conversions**: Live SOL-to-USD conversion using cached price data.
- **AI Budget System**: Manages AI interactions with throttling and heat-gated analysis.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet.
- **Position Model**: Each trading position is stored in the `holdings` table, tracking token details, source, and per-position configurations, allowing multiple positions on the same token.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Dual learning systems with adaptive dampening for weight shifts based on data confidence.
- **Familiar Whale Tracking**: Tracks whales across tokens and builds success profiles.
- **Tiered Event Buckets**: Position snapshots store journey data in compressed tiers (15min detailed → hourly summaries → daily).
- **Stop-Loss Mode**: Per-position `stopLossMode` setting: "auto" (immediate sell) or "alert" (notify and wait for user confirmation).
- **Signal Wallet Detail Page**: Displays individual wallet activity, trade history, hit rate, P&L, trading style analysis, and timeframe filters, with real-time WebSocket updates.
- **AI-Controlled Blacklist**: Miss Pincher can add, remove, and list blacklisted tokens via natural language commands.
- **AI Relationship System**: Tracks user affinity, relationship type, trades won, and warnings followed/ignored, with auto-adjustment of relationship type.
- **Production System Logging**: Persistent logs in `system_logs` table for debugging copy trading issues. Hourly cleanup keeps only 100 most recent entries. Miss Pincher can query logs via the `query_system_logs` tool to help diagnose production issues. Key events logged: webhook errors, pending buy queued/skipped, swap execution success/failure.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain, fallback for token symbol/name lookup.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Primary source for token metadata (price, market cap, liquidity, FDV, volume).
- **GeckoTerminal**: Fallback token metadata provider.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.