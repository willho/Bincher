# Penny Pincher

## Overview
Penny Pincher is an automated Solana trading platform designed to offer copy trading, manual trading, and AI-driven trading. It aims to provide a secure, intelligent, and comprehensive solution on the Solana blockchain, emphasizing automated risk management, adaptive AI learning, and pattern-based swing trading to improve user profitability and experience in decentralized finance. The project envisions enhancing financial accessibility and intelligence within the DeFi space.

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
The UI is developed with React and Vite, adopting a dark, mobile-first design (480px centered column) on a dark background. Navigation is managed via a fixed bottom navigation bar with three primary tabs: **Portfolio** (`/`), **Discovery** (`/discovery`), and **Appraisal** (`/signals`). Key design tokens include `--mint` (#34d399), `--rose`, `--amber`, `--violet`. Typography uses JetBrains Mono for numbers/addresses, Instrument Serif for display headings, and Inter for body text. The Portfolio page (`/pages/portfolio.tsx`) includes an auto-trading toggle, a P&L hero card with sparkline, a 4-up grid for key metrics, and lists for open positions and transaction history.

### Backend
The Express backend handles user authentication (session-based), integrates with Solana services, and manages business logic. It processes Helius webhooks, uses Resend for email notifications, and integrates Jupiter for token swaps. A WebSocket server provides real-time updates.

### Database
PostgreSQL is used for persistent storage, housing user accounts, sessions, monitored wallets, swap history, settings, copy trading configurations, and AI-related data, all with strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Achieved through Helius webhooks for immediate transaction detection.
- **Automated Copy Trading**: Features a hot wallet system with advanced encryption, dynamic priority fees, split buy systems, progressive take-profit, and backup gas funding. It supports configurable initial buy modes, budget controls, and mirror trading.
- **AI Token Analysis (Miss Pincher)**: A GPT-4o-mini powered AI provides dynamic token heat scoring and qualitative analysis via a chat interface, requiring explicit user confirmation for trades.
- **Security**: Implemented with robust authentication, encrypted data, PIN protection, daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Ensured through user isolation and webhook-driven event processing.
- **API Management**: Tracks API usage with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: Uses OHLC+ price data with multi-tier retention for swing detection.
- **Whale Tracking**: Employs a three-tier system (Active, Watch, Archive) with weekly rotation based on composite reputation scores.
- **Whale-Sourced Token Discovery**: Automatically discovers tokens based on whale activity, with per-whale limits and recency filters.
- **Telegram Integration**: Provides two-way communication for alerts and AI routing.
- **AI Filter Creation**: Allows natural language filter creation via an AI chat interface.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Features dual learning systems with adaptive dampening for weight shifts based on data confidence.
- **Production System Logging**: Utilizes a separated logging architecture with dedicated tables for various log types.
- **Budget & API Management System**: Implements per-minute rate limiting for all providers with smooth throttling and exponential backoff.
- **Dual-Source Price System**: Uses primary prices from swap webhooks and secondary data from DexScreener, including price discrepancy detection.
- **Memory-First Caching**: In-memory token data cache with periodic database flushes.
- **Storage Bucketing**: Tiered data compression with a daily scheduler to manage database costs.
- **Daily Price Snapshots**: Midnight UTC snapshots with pre-computed price change calculations and summary jobs for various insights.
- **Discovery Metrics**: Computes 8 metrics per token (e.g., trending momentum, boost intensity, deployer track record).
- **Historical Context System**: Tracks token history, wallet pattern analysis, and holder overlap analysis.
- **Social Signal System**: Tracks Twitter/Telegram callers as alpha sources, evaluates outcomes, and computes trust scores.
- **Discovery Event Bus**: A reactive event bus connecting data sources for immediate discovery scans and vector updates.
- **Discovery Optimizer**: An adaptive review scheduler with LLM graduation and self-adjusting thresholds.
- **Distributed Compute Framework**: Supports backend, compute-node, and browser worker tasks with trust scoring and prioritization.
- **Vector Learning**: Incorporates multi-dimensional personality and trading vectors, strategy clustering, and unified vector routing.
- **System Insight Bus**: Facilitates cross-system knowledge sharing via a `systemInsights` table for LLM-Trigger flows.
- **Admin Chat Interface**: A conversational AI interface for system monitoring with dynamic context injection.
- **Discovery-Enhanced Strategy Analysis**: Integrates discovery engine insights for behavior classification and leader/follower relationships.
- **Technical Indicators Engine**: Computes various technical indicators (EMA, RSI, MACD, Bollinger Bands, OBV, Stochastic) from price history.
- **Paper Trading System**: Provides risk-free strategy testing via simulated trades, integrated into the Holdings page.
- **Discovery Auto-Paper-Trading**: Automatically opens paper trades on high-scoring tokens to learn optimal setups, with batch and event-triggered modes.
- **Unified Webhook Manager**: Manages a single Helius webhook with priority routing for different transaction types.
- **Discovery Source Tracking**: Tags tokens and positions with their discovery source to measure performance.
- **Cluster-Whale Enrichment**: Enriches cluster detection with whale reputation data.
- **Indicator Vectors for Pattern Learning**: Snapshots technical indicators at trade entry/exit points and correlates patterns with outcomes.
- **Enriched Snapshot Learning**: Captures comprehensive trade journey data and market context for learning optimal ranges.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, and dynamic priority fee estimation.
- **Chainstack**: Primary RPC provider for raw Solana calls, with automatic failover to Helius.
- **Resend**: For sending email notifications.
- **Jupiter**: For executing token swaps on the Solana blockchain and as a fallback for token symbol/name lookup.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Secondary source for token metadata (price, market cap, liquidity, FDV, volume) and boost tracking.
- **GeckoTerminal**: Primary token metadata provider for trending tokens and new Solana pools.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.