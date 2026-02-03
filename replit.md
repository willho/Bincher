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

## Paused Tasks / Backlog

### Miss Pincher Personality Quick Wins
*Paused: 2026-02-01*

Prompt optimization to make personality shine immediately (no schema changes required):

1. **Rewrite CORE_PERSONALITY**: Dense punchy prose, full name Penelope Soraya Ibis Despinchard prominent, voice examples
2. **Condense CARIBBEAN_LANGUAGE_SYSTEM**: Examples + triggers format, drop verbose percentage breakdowns
3. **Tighten CRAB_MYSTERY**: Compact slip-ups list and trigger reactions
4. **Rewrite TRADING_PHILOSOPHY**: Signature reaction lines, condense PROFESSIONAL_BOUNDARIES/BACKSTORY/SECURITY
5. **Rewrite buildRelationshipContext**: Pass computed state numbers not paragraphs
6. **Increase AI temperature to 0.85**: More personality expression
7. **Test chat**: Verify personality shines from first message

---

## Vector Learning Update (Future)
*Added: 2026-02-03*

Vision: Self-optimizing AI trading system. Miss Pincher evolves from copy-trading → understanding → autonomous strategy generation. Unified vector learning powers personality AND trading intelligence.

### Phase 1: Foundation (Schema + Architecture)
**1.1 Vector Storage** ✅ *Completed 2026-02-03*
- ✅ Expanded `user_relationships`: multi-dimensional scores (adversarial, friendly, playful, professional), memorableEvents array
- ✅ Added `behavior_vectors` table: 6 behavior axes with dampening factors
- ✅ Added `memory_clusters` table: topic/pattern tracking with confidence/decay
- Consent-aware data storage (future: UI toggle)

**1.2 Baseline Architecture**
- Global baseline personality vector (evolves from aggregated trends)
- Per-user instance inherits baseline + local adjustments

### Phase 2: Personality Vectors
**2.1 Six Behavior Axes**
- Slang/idioms, Crab hints, Teasing, Proactivity, Cultural refs, Trading behavior
- Numeric vectors with affinity-weighted updates
- Dampening mechanics (reuse heat score math)

**2.2 Chat-Based Affinity**
- +1 per message, +2 compliments, +3 following advice
- Decay for ignored advice, negative reactions
- Trades become secondary relationship driver

**2.3 Procedural Personality Mixer**
- Compute personality blend from dimension scores
- Pass compact state to AI (~300 tokens vs ~800)

### Phase 3: Trading Vectors
**3.1 Strategy Clusters**
- Signal wallet profiles with cluster tags (momentum, swing, Pump specialist)
- Track outcomes per cluster - learn "why" wallets win

**3.2 Latency-Aware Learning**
- Record execution delays, learn optimal timing
- "When not to trade" learning from losses
- Patience as feature (filters rugs)

### Phase 4: Self-Optimization
**4.1 8-Hour Bucket Aggregation**
- Collect signals, calculate engagement-weighted deltas
- Update baseline vectors incrementally
- Dampening prevents oscillation

**4.2 Token Optimization**
- Vector similarity triggers (LLM only when needed)
- Eventual distillation to smaller/faster models

### Phase 5: Multi-Agent (Future)
**5.1 Specialized Agents**
- Momentum, Swing, Pump.fun specialists
- Supervisor for capital allocation + risk management
- Ring-fenced capital for high-variance plays (5-10% max)

**5.2 Self-Awareness**
- Reflect on own performance
- Suggest improvements to user
- Emergent cross-agent learning

### Key Principles
- Ethical: no frontrunning, no sniping
- Full-cycle learning: wins + losses + "when not to trade"
- Token-sparse LLM calls
- Anti-overfitting: regime detection, forgetting mechanisms

### Identity Reference
- Full legal name: Penelope Soraya Ibis Despinchard
- Professional: Miss Pincher
- Aliases: Pinchét, Cruz-Pinchét (denied humorously)