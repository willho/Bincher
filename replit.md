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
- When a task list is paused, record it in the "Paused Tasks / Backlog" section below.
- When discussing trading errors or copy trading issues, always assume production environment (not development).

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
- **Security**: Robust authentication (PBKDF2 hashing, secure sessions), encrypted sensitive data storage. PIN protection system for trading actions with configurable modes (withdrawals_only, all_trades, threshold), daily spend limits, withdrawal address whitelisting, and Telegram confirmation for large transfers.
- **Scalability**: Designed with user isolation and webhook-driven event processing.
- **API Budget & Key Management**: Tracks API calls with limits and uses an admin API key pool for load balancing.
- **Tiered Price Aggregation**: OHLC+ price data with multi-tier retention for swing detection.
- **Whale Detection**: Caches top-100 holder lists and detects whale activity, broadcasting events via WebSocket.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity (20% weighted), recent buys, price volatility, user attention, and recency.
- **Telegram Integration (Two-Way)**: A webhook-based bot for alerts (swap, whale, emerging whale) and routing non-command messages to Miss Pincher AI.
- **Notifications Architecture**: Multi-provider email support (Resend, SendGrid, Mailgun, SMTP) with Telegram as priority. Users provide their own email service API keys via Settings > Alerts tab.
- **AI Filter Creation**: Natural language filter creation via Miss Pincher chat (e.g., "only buy tokens above 500k market cap"). Filters stored in `trade_filters` table.
- **USD Conversions**: Live SOL-to-USD conversion throughout the UI using cached price data.
- **AI Budget System**: Manages AI interactions ($1/day per user) with throttling, heat-gated analysis, and cached alerts for optimization.
- **AI Trading Control**: Miss Pincher can propose and execute trades, and manage copy trading configurations through natural language, requiring explicit user confirmation for all trade executions.
- **AI Health & Cost Optimization**: Includes an AI health tracking system, an intent parser for simple commands (reducing AI calls), and graceful degradation to ensure manual controls remain functional if AI is unavailable.
- **Network Mode**: Supports dynamic switching between Devnet and Mainnet with separate API endpoints and features like faucet links for Devnet.
- **Position Model**: Each trading position is stored in the `holdings` table, which tracks: token wallet (`tokenWalletPublicKey`), token (`tokenMint`), source (`sourceWalletAddress`, `signalWalletId`), and per-position config (`takeProfitThresholds`, `stopLossPercent`, `positionSource`). Multiple positions on the same token are allowed from different signal sources.
- **Per-Wallet Copy Config**: Granular settings for buy amounts, minimum balances, trade filters, score thresholds, and timing.
- **Risk Management**: Configurable take-profit, stop-loss, auto-mirroring, and trading budget limits.
- **Adaptive AI with Dampening**: Dual learning systems (market factors for predictions, position factors for holdings) with adaptive dampening that caps weight shifts at 2-10% based on data confidence. Factor discovery runs hourly for faster learning.
- **Familiar Whale Tracking**: Tracks whales across tokens, building success profiles (profitableExits, avgExitMultiplier, reliabilityScore). API endpoints: `/api/whales/top`, `/api/whales/token/:mint`, `/api/whales/history/:wallet`.
- **Tiered Event Buckets**: Position snapshots store journey data in compressed tiers (15min detailed → hourly summaries → daily), piggybacking on OHLC aggregation to avoid data bloat.
- **Stop-Loss Mode**: Per-position `stopLossMode` setting: "auto" (immediate sell) or "alert" (notify and wait for user confirmation with 15-min debounce).
- **Signal Wallet Detail Page**: Individual wallet activity pages at `/signal/:id` showing trade history with timestamps, hit rate, realized P&L, trading style analysis, and timeframe filters (24h/7d/30d/all). Includes real-time WebSocket updates for new swaps and manual Helius backfill for historical data.
- **Autonomous Mode (Planned)**: Future: user-defined risk profiles, stop conditions, and AI-initiated trades with explicit confirmation.
- **Swing Trading (Planned)**: Future feature for pattern detection (support/resistance, OHLC patterns, volume spikes) to enable automated swing trading.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Fetching token metadata (price, market cap, liquidity, FDV, volume).
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.

## Paused Tasks / Backlog

### Critical Wiring (Pending)
- Wire `logTokenEvent()` calls into webhook handler when swaps are detected
- Wire `logTokenEvent()` calls into price-monitor for significant price movements
- Wire `logTokenEvent()` calls into familiar-whales when whale activity is detected
- Wire `generateAndCacheAlert()` calls at appropriate trigger points for user notifications

### Security System Implementation Status
**Completed:**
- PIN schema fields in users table (withdrawalPinHash, pinMode, pinThresholdUsd, etc.)
- SecuritySettings UI component with full settings management
- Security API routes (GET/POST /api/settings/security, set-pin, verify-pin, execute-pending)
- server/security.ts module with utility functions
- PIN verification modal for web UI (bypasses AI chat)
- Security context for global PIN verification state management
- Telegram security verification flow with pending state tracking
- PIN/password interception before AI routing in Telegram handler
- PIN enforcement in AI trade execution (blocks execution, signals verification required)

**Security Flow Design:**
- **Web UI**: PIN entered via modal dialog, sent directly to /api/trade/execute-pending
- **Telegram**: Bot intercepts messages when in pending verification state, verifies PIN or password (if no PIN set) before executing action
- **AI Chat**: PIN/password never goes through AI - security prompts handled by UI/bot directly

**Pending Wiring:**
- Wire PIN checks into copy trading processor (trade-processor.ts)
- Wire withdrawal whitelist checks into transfer/withdraw endpoints
- Implement daily spend limit tracking and enforcement
- Add Telegram confirmation flow for large transfers

### Copy Trading Considerations
- **dedupSkipIfPending default**: Currently defaults to `true`, which blocks multiple buys of the same token if a pending buy exists. This may prevent copying a signal trader who averages into positions (buys same token multiple times). Consider changing default to `false` to better mirror signal behavior. Needs more thought before implementation.

### Data Retention (When data exceeds 10k rows)
- **AI Chat Summarization**: Keep 7 days detailed, weekly AI summarization of older messages with overlap for context, delete raw after summarization
- **System Logs**: Keep 7 days detailed → aggregate to daily counts by type → delete raw after 30 days
- **Token Events**: Bucket hourly → daily → weekly (like OHLC)
- **Cached Alerts**: Expire after 7 days
- **API Usage**: Bucket to daily totals per endpoint, delete raw after 7 days
- **Holder Snapshots**: Keep only latest per token, delete previous snapshots
- **AI Predictions**: Keep 30 days for learning, then aggregate accuracy stats only
- Implementation: Add scheduled daily cleanup job, piggyback on price aggregation pattern

### Miss Pincher Relationship System (Pending Enhancements)
- Relationship system is now wired up with `userRelationships` database table
- Currently tracks: affinityScore (-100 to +100), relationshipType, tradesWonTogether, warningsFollowed/Ignored
- Auto-adjusts relationship type based on affinity (friendly ≥50, professional ≥20, adversarial ≤-30)
- **Remaining**: Update affinity dynamically based on trade outcomes and warning compliance

### Community Insights / Crowd Wisdom (Pending)
- Schema exists (`communityInsights` table) but not wired up
- **Tokens**: Miss Pincher shares anonymized opinions like "A few traders I've chatted with are bullish on this one"
- **Signal Wallets**: "Several traders I know have had good results following this wallet" or "This wallet tends to exit positions quickly"
- Needs: consent mechanism, insight extraction from chat, query tool for Miss Pincher
- Never exposes user identity - only sentiment, credibility level, and summary
- Could track insight accuracy over time (did bullish calls age well?)

### UI Improvements (Proposed)
- Add real-time alerts for significant market movements
- Focus on clarity and ease of navigation
- (Add more as proposed)