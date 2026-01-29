# Penny Pincher

## Overview
Penny Pincher is a real-time, multi-user application designed to monitor Solana wallet swap transactions and provide automated copy trading capabilities. It aims to empower users with tools for tracking specific wallet activities, receiving timely notifications, and executing automated trades based on predefined strategies. The core vision is to offer a sophisticated, yet user-friendly platform for Solana ecosystem participants to gain insights and automate their trading actions, with a strong focus on security, user data isolation, and efficient blockchain interaction.

## User Preferences
- I prefer simple language.
- I want iterative development.
- Ask before making major changes.
- I prefer detailed explanations.
- Do not make changes to the folder `Z`.
- Do not make changes to the file `Y`.

## System Architecture

### High-Level Design
The application employs a client-server architecture with a React-based frontend and an Express.js backend. Real-time communication is facilitated via WebSockets, and data persistence is handled by a PostgreSQL database. A key architectural decision is the reliance on Helius webhooks for real-time, push-based swap detection, minimizing polling overhead. Each user's data, including monitored wallets, settings, and trading activities, is completely isolated.

### Frontend (React + Vite)
The user interface is built with React and Vite, featuring a dark-first theme with crypto-themed green accents. It includes dedicated sections for monitoring wallets, managing copy trading configurations, and interacting with AI-driven insights. Key pages include a secure login, a comprehensive dashboard with tabbed navigation, and components for managing monitored wallets and copy trading settings. The frontend is structured into a 4-page system: Dashboard, Watchlist, Trading, and Settings, with a dedicated Token sub-page and an omnipresent AI chat component (Pincher Footer).

### Backend (Express)
The Express backend manages user authentication (session-based with httpOnly cookies), integrates with external Solana services, and handles all business logic. It processes Helius webhooks for swap events, uses Resend for email notifications, and integrates with Jupiter for executing token swaps. A WebSocket server broadcasts real-time swap updates to connected clients.

### Database (PostgreSQL)
A PostgreSQL database stores all application data, including user accounts, sessions, monitored wallets, swap history, user settings, copy trading configurations, and AI-related data such as token snapshots and chat history. The database schema is designed to ensure strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Utilizes Helius webhooks for push-based, persistent monitoring of Solana wallet swaps.
- **Automated Copy Trading**: Implements a hot wallet system with AES-256-GCM encryption for secure, server-side key management. It features dynamic priority fees, automatic buys, a split buy system, and progressive take-profit strategies. Each buy uses a unique, disposable token wallet.
- **AI Token Analysis (Miss Pincher)**: An AI component (GPT-4o-mini powered) provides dynamic token heat scoring and qualitative analysis based on comprehensive token snapshots. It offers a chat interface for user interaction and can trigger actions via natural language.
- **Security**: Robust authentication mechanisms including PBKDF2 for password hashing, secure session management, and encrypted storage for sensitive data.
- **Scalability**: Designed with user isolation and webhook-driven event processing.
- **API Budget & Key Management**: Comprehensive API call tracking with daily/monthly limits, warning thresholds, and automatic pausing. Admin API key pool for load balancing. User-supplied API keys increase personal wallet limits.
- **Wallet Limits**: Base limit of 2 monitored wallets per user, extendable up to 20 with valid API keys.
- **Tiered Price Aggregation**: OHLC+ price data with multi-tier retention and in-memory tick buffer for real-time swing detection.
- **Whale Detection**: Cached top-100 holder lists per token with event-triggered refresh. Detects whale activity (buyer/seller in top-100 holders) and broadcasts whale events via WebSocket. Includes "Emerging Whale Detection" for new top-10 holders.
- **Enhanced Heat Scoring**: Token heat scores incorporate whale activity (20% weighted factor), alongside recent buys, price volatility, user attention, and recency.
- **Telegram Integration (Two-Way)**: A webhook-based Telegram bot for two-way communication, supporting deep link account linking, a setup wizard, and role-based commands for users and admins. It provides swap, whale, and emerging whale alerts, and routes non-command messages to Miss Pincher AI for natural conversation.
- **Notifications Architecture**: Prioritizes Telegram notifications, with email as a secondary option. Alerts follow a concise `[emoji] [what happened] | [key metric]` format.
- **AI Budget System**: Manages AI interactions ($1/day per user) with gradual throttling and budget allocation across chat, batch analysis, and alert generation. Features heat-gated analysis and cached alerts to optimize AI usage.

## External Dependencies

- **Helius**: Real-time Solana blockchain data, swap transaction webhooks, dynamic priority fee estimation.
- **Resend**: Sending email notifications.
- **Jupiter**: Executing token swaps on the Solana blockchain.
- **PostgreSQL**: Primary database for persistent storage.
- **DexScreener**: Fetching token metadata (price, market cap, liquidity, FDV, volume).
- **GPT-4o-mini (via Replit AI Integrations)**: Powers AI Token Analysis features.

## Frontend Redesign Implementation

### New 4-Page Structure
| Route | Page | Contents |
|-------|------|----------|
| /dashboard | Dashboard | Portfolio overview, alerts feed, swap history, heat scores |
| /watchlist | Watchlist | Monitored wallets, community wallets |
| /trading | Trading | Holdings list, swap/send actions |
| /trading/:token | Token | Per-token details, analysis, swap/send |
| /settings | Settings | API keys, notifications, account, admin |

### PHASE 1: Foundation ✅
- [x] Sidebar navigation with Shell logo
- [x] Route structure: /dashboard, /watchlist, /trading, /trading/:token, /settings
- [x] PincherFooter component - omnipresent AI chat widget
- [x] Page-aware context display (badge shows current page)

### PHASE 2: Page Reorganization ✅
- [x] Dashboard: Portfolio overview, alerts feed, swap history (side-by-side layout)
- [x] Watchlist: Monitored wallets, community wallets
- [x] Trading: Holdings display with PnL, copy trading settings
- [x] Token: Per-token details, Miss Pincher's AI analysis, token metrics
- [x] Settings: API keys, notifications, account, admin panel

### PHASE 3: Pincher Backend Enhancements ✅
- [x] Channel awareness (telegram/web tone adjustment) - PincherContext includes channel, buildChannelContext adjusts tone
- [x] Cross-channel context queries - getCrossChannelHistory queries all channels, added to system prompt
- [x] Cached alerts (AI generates once, system delivers) - cachedAlerts table, getCachedAlert/generateAndCacheAlert functions
- [x] Admin instructions injection - adminSettings table, setAdminInstructions, admin endpoint POST /api/admin/pincher-instructions

### PHASE 4: Security & Community Features ✅
- [x] Anti-prompt-injection security rules - Comprehensive defense against system prompt leakage, override attempts
- [x] Data isolation rules - Never reveal other users' data, hot wallet status, or cross-user information
- [x] Conversational admin instructions - Admin can set instructions by chatting with Pincher using secret codeword + confirmation
- [x] Show/clear admin commands - Admin can view or wipe instructions via chat
- [x] Capabilities documentation - Pincher can explain her features in plain language when asked
- [x] Community insights table - Anonymous token opinions with consent-based sharing
- [x] Insight consent flow - Pincher asks permission before sharing alpha anonymously
- [x] Insight retrieval with disclaimers - Community opinions framed as unverified, possible manipulation

### Miss Pincher Personality
- **Voice**: Dry wit, tough love, casual but serious when needed
- **Crab Mystery**: Name/logo suspicious, denies being a crab, subtle slip-ups
- **Trading Soul**: Realistic advice, score-weighted responses
- **Relationship Tracking**: Affinity scores, keeps receipts for clap backs
- **Professional Core**: Never sabotages function, alerts/analysis stay accurate

### PHASE 5: AI Trading Control ✅
- [x] Trading action tools: propose_buy, propose_sell with permission confirmation flow
- [x] Server-side confirmation enforcement: userConfirmed flag required before execution
- [x] Configuration tools: set_copy_trading, get_copy_trading_settings
- [x] Wallet monitoring tools: enable_wallet_copy, disable_wallet_copy, list_monitored_wallets
- [x] Query tools: check_wallet_balance, get_holdings_summary, get_pending_orders
- [x] 3-minute expiry on pending trades with automatic cleanup
- [x] Webhook copy trading checks BOTH global setting AND wallet-specific copyTradeEnabled
- [x] Take-profit automation in price-monitor.ts (reclaim at 4x, progressive at 10x/100x/1000x)

### Miss Pincher Trading Capabilities
Miss Pincher can now control trading through natural conversation with explicit permission:

**Trading Flow (Propose → Confirm → Execute)**:
1. User: "buy some BONK"
2. Pincher: Proposes buy with amount and price, asks for confirmation
3. User: "yes" / "do it" / "confirm"
4. Server: Sets userConfirmed flag (server-side enforcement)
5. Pincher: Calls execute_pending_trade, executes trade

**Available Actions**:
- **propose_buy/propose_sell**: Propose trades (requires explicit confirmation)
- **execute_pending_trade**: Execute after user confirms
- **cancel_pending_trade**: Cancel pending proposal
- **set_copy_trading**: Configure copy trading (enable/disable, buy amounts, slippage)
- **enable/disable_wallet_copy**: Toggle copy trading per wallet
- **check_wallet_balance, get_holdings_summary, get_pending_orders**: Query state

**Security Model**:
- All trades require explicit user confirmation ("yes", "do it", "confirm", etc.)
- Server-side userConfirmed flag prevents LLM from bypassing confirmation
- 3-minute expiry on pending trades
- Automatic cleanup of expired trades every minute

### PHASE 6: AI Health & Cost Optimization ✅
- [x] AI health tracking system (ai-health.ts) - Tracks consecutive failures, availability status
- [x] Health endpoint (/api/ai/health) - Returns availability, unavailable features, fallback messages
- [x] Intent parser (intent-parser.ts) - Handles simple commands without AI calls
- [x] Graceful degradation - When AI unavailable, manual controls still work
- [x] Telegram fallback - Intent parser + fallback messages in Telegram bot
- [x] Web fallback - Same behavior for web chat endpoint

**AI Cost Optimization Strategy**:
- Simple queries (balance, holdings, pending, enable/disable copy) handled by backend intent parser
- AI only called for complex analysis and natural conversation
- Health tracking records success/failure of each AI call
- After 3 consecutive failures, AI marked as unavailable
- 60-second cooldown before retrying after failures
- All manual trading features remain functional when AI is down

**Intent Parser Commands** (no AI needed):
- `balance` / `check balance` - Hot wallet SOL balance
- `holdings` / `portfolio` - Current token holdings with PnL
- `pending` / `queued` - Pending buy orders
- `enable copy` / `start copy` - Enable copy trading
- `disable copy` / `stop copy` - Disable copy trading