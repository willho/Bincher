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