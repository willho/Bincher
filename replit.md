# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform designed to facilitate copy trading from signal wallets, manual trading, and autonomous AI-driven trading. The platform aims to provide a comprehensive, intelligent, and secure trading solution on the Solana blockchain, incorporating automated risk management, adaptive AI learning, and pattern-based swing trading. Its long-term vision includes an AI assistant, Miss Pincher, that can trade autonomously based on user-defined rules and evolving scoring models, enhancing user profitability and experience in decentralized finance.

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
The application uses a client-server architecture with a React frontend, an Express.js backend, and a PostgreSQL database. Real-time communication is enabled via WebSockets, and Helius webhooks are used for push-based swap detection. User data is strictly isolated.

### Frontend
The UI, built with React and Vite, features a dark theme with crypto-themed green accents. It includes a Dashboard, Watchlist, Trading (with Token sub-page), Settings, and an omnipresent AI chat component (Pincher Footer).

### Backend
The Express backend handles user authentication (session-based), Solana service integrations, and business logic. It processes Helius webhooks, uses Resend for email, and integrates Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
PostgreSQL stores user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, designed for strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Utilizes Helius webhooks for efficient Solana wallet swap monitoring.
- **Automated Copy Trading**: Features a hot wallet system with AES-256-GCM encryption, dynamic priority fees, split buy systems, and progressive take-profit strategies. Each buy uses a unique, disposable token wallet. Hot wallet provides backup gas funding to position wallets when SOL runs low before sells.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis, with a chat interface for natural language interaction and action triggers.
- **Security**: Robust authentication (PBKDF2, secure sessions), encrypted data storage, PIN protection for trading actions (configurable modes), daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Designed with user isolation and webhook-driven event processing.
- **API Budget & Key Management**: Tracks API calls with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: Uses OHLC+ price data with multi-tier retention for swing detection.
- **Whale Detection**: Caches top-100 holder lists and detects whale activity, broadcasting events via WebSocket.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity, recent buys, price volatility, user attention, and recency.
- **Telegram Integration**: Two-way webhook-based bot for alerts and routing non-command messages to Miss Pincher AI.
- **Notifications Architecture**: Multi-provider email support (Resend, SendGrid, Mailgun, SMTP) with Telegram as priority.
- **AI Filter Creation**: Natural language filter creation via Miss Pincher chat (e.g., "only buy tokens above 500k market cap").
- **USD Conversions**: Live SOL-to-USD conversion throughout the UI using cached price data.
- **AI Budget System**: Manages AI interactions ($1/day per user) with throttling and heat-gated analysis.
- **AI Trading Control**: Miss Pincher can propose and execute trades and manage copy trading configurations, requiring explicit user confirmation for all trade executions.
- **AI Health & Cost Optimization**: Includes AI health tracking, an intent parser for simple commands, and graceful degradation for manual controls.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet.
- **Position Model**: Each trading position is stored in the `holdings` table, tracking token details, source, and per-position configurations. Multiple positions on the same token are allowed from different signal sources.
- **Per-Wallet Copy Config**: Granular settings for buy amounts, minimum balances, trade filters, score thresholds, and timing.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Dual learning systems with adaptive dampening to cap weight shifts based on data confidence.
- **Familiar Whale Tracking**: Tracks whales across tokens, building success profiles.
- **Tiered Event Buckets**: Position snapshots store journey data in compressed tiers (15min detailed → hourly summaries → daily).
- **Stop-Loss Mode**: Per-position `stopLossMode` setting: "auto" (immediate sell) or "alert" (notify and wait for user confirmation).
- **Signal Wallet Detail Page**: Individual wallet activity pages showing trade history, hit rate, P&L, trading style analysis, and timeframe filters, with real-time WebSocket updates.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Fetching token metadata (price, market cap, liquidity, FDV, volume).
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.