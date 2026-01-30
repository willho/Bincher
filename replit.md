# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform that uses AI for analysis and execution. Its primary purpose is to enable users to copy trades from signal wallets, execute manual trades, and eventually allow an AI assistant, Miss Pincher, to trade autonomously based on user-defined rules and her evolving scoring models. Key capabilities include automated risk management, adaptive AI learning from trading outcomes, and pattern-based swing trading using OHLC data. The project aims to provide a comprehensive and intelligent trading solution on the Solana blockchain.

## User Preferences
- I prefer simple language.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.

## System Architecture

### High-Level Design
The application utilizes a client-server architecture with a React frontend and an Express.js backend. Real-time communication is handled via WebSockets. A PostgreSQL database stores all persistent data, ensuring strict user data isolation. The system leverages Helius webhooks for real-time, push-based swap detection, minimizing polling.

### Frontend
The user interface, built with React and Vite, features a dark-first theme with crypto-themed green accents. It is structured into a 4-page system: Dashboard, Watchlist, Trading (with a dedicated Token sub-page), and Settings, complemented by an omnipresent AI chat component (Pincher Footer).

### Backend
The Express backend manages user authentication (session-based), integrates with Solana services, and processes business logic. It handles Helius webhooks for swap events, uses Resend for email notifications, and integrates with Jupiter for token swaps. A WebSocket server broadcasts real-time updates.

### Database
A PostgreSQL database stores user accounts, sessions, monitored wallets, swap history, user settings, copy trading configurations, and AI-related data, designed for strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Utilizes Helius webhooks for push-based monitoring of Solana wallet swaps.
- **Automated Copy Trading**: Implements a hot wallet system with AES-256-GCM encryption, dynamic priority fees, split buy systems, and progressive take-profit strategies. Each buy uses a unique, disposable token wallet.
- **AI Token Analysis (Miss Pincher)**: An AI component (GPT-4o-mini powered) provides dynamic token heat scoring and qualitative analysis, offering a chat interface for user interaction and natural language-triggered actions.
- **Security**: Robust authentication (PBKDF2 hashing, secure sessions), encrypted sensitive data storage.
- **Scalability**: Designed with user isolation and webhook-driven event processing.
- **API Budget & Key Management**: Tracks API calls with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: OHLC+ price data with multi-tier retention for swing detection.
- **Whale Detection**: Caches top-100 holder lists and detects whale activity, broadcasting events via WebSocket.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity (20% weighted), recent buys, price volatility, user attention, and recency.
- **Telegram Integration (Two-Way)**: A webhook-based bot for alerts (swap, whale, emerging whale) and routing non-command messages to Miss Pincher AI.
- **Notifications Architecture**: Prioritizes Telegram, with email as a secondary option.
- **AI Budget System**: Manages AI interactions ($1/day per user) with throttling, heat-gated analysis, and cached alerts for optimization.
- **AI Trading Control**: Miss Pincher can propose and execute trades, and manage copy trading configurations through natural language, requiring explicit user confirmation for all trade executions.
- **AI Health & Cost Optimization**: Includes an AI health tracking system, an intent parser for simple commands (reducing AI calls), and graceful degradation to ensure manual controls remain functional if AI is unavailable.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet with separate API endpoints and features like faucet links for Devnet.
- **Position Model**: Each trading position is stored in the `holdings` table, which tracks: token wallet (`tokenWalletPublicKey`), token (`tokenMint`), source (`sourceWalletAddress`, `signalWalletId`), and per-position config (`takeProfitThresholds`, `stopLossPercent`, `positionSource`). Multiple positions on the same token are allowed from different signal sources.
- **Per-Wallet Copy Config**: Granular settings for buy amounts, minimum balances, trade filters, score thresholds, and timing.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI & Autonomous Mode (Planned)**: Future enhancements include adaptive scoring based on outcome feedback, continuous position scoring updates, familiar whale tracking, and an autonomous trading mode with user-defined risk profiles and stop conditions.
- **Swing Trading (Planned)**: Future feature for pattern detection (support/resistance, OHLC patterns, volume spikes) to enable automated swing trading.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Fetching token metadata (price, market cap, liquidity, FDV, volume).
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.