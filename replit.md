# Solana Wallet Swap Monitor

## Overview
This project is a real-time, multi-user application designed to monitor Solana wallet swap transactions and provide automated copy trading capabilities. It aims to empower users with tools for tracking specific wallet activities, receiving timely notifications, and executing automated trades based on predefined strategies. The core vision is to offer a sophisticated, yet user-friendly platform for Solana ecosystem participants to gain insights and automate their trading actions, with a strong focus on security, user data isolation, and efficient blockchain interaction.

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
The user interface is built with React and Vite, featuring a dark-first theme with crypto-themed green accents. It includes dedicated sections for monitoring wallets, managing copy trading configurations, and interacting with AI-driven insights. Key pages include a secure login, a comprehensive dashboard with tabbed navigation, and components for managing monitored wallets and copy trading settings.

### Backend (Express)
The Express backend manages user authentication (session-based with httpOnly cookies), integrates with external Solana services, and handles all business logic. It processes Helius webhooks for swap events, uses Resend for email notifications, and integrates with Jupiter for executing token swaps. A WebSocket server broadcasts real-time swap updates to connected clients.

### Database (PostgreSQL)
A PostgreSQL database stores all application data, including user accounts, sessions, monitored wallets, swap history, user settings, copy trading configurations, and AI-related data such as token snapshots and chat history. The database schema is designed to ensure strict user data isolation.

### Key Features & Design Patterns
- **Real-time Swap Monitoring**: Utilizes Helius webhooks for push-based, persistent monitoring of Solana wallet swaps.
- **Automated Copy Trading**: Implements a hot wallet system with AES-256-GCM encryption for secure, server-side key management. It features dynamic priority fees, automatic buys triggered by monitored wallet activity, a split buy system for stealth, and progressive take-profit strategies. Each buy uses a unique, disposable token wallet for enhanced privacy.
- **AI Token Analysis (Miss Pincher)**: An AI component (GPT-4o-mini powered) provides dynamic token heat scoring and qualitative analysis based on comprehensive token snapshots. It offers a chat interface for user interaction and can trigger actions via natural language. Token snapshots are shared across users for collective learning.
- **Security**: Robust authentication mechanisms including PBKDF2 for password hashing, secure session management, and encrypted storage for sensitive data like hot wallet private keys.
- **Scalability**: Designed with user isolation and webhook-driven event processing to support multiple users efficiently.
- **API Budget & Key Management**: Comprehensive API call tracking with daily/monthly limits, warning thresholds, and automatic pausing. Admin API key pool for load balancing and redundancy. User-supplied API keys increase personal wallet limits.
- **Wallet Limits**: Base limit of 2 monitored wallets per user, increased by +2 per valid API key supplied, up to 20 maximum.
- **Tiered Price Aggregation**: OHLC+ price data with multi-tier retention (15min buckets for 2hr, hourly for 48hr, daily for 14 days, weekly for 90 days). In-memory tick buffer for real-time swing detection, with background aggregation job compressing ticks into database rows.
- **Whale Detection**: Cached top-100 holder lists per token with event-triggered refresh. Swap webhook detects whale activity (buyer/seller in top-100 holders) and broadcasts whale events via WebSocket. Holder tiers: Top 10 = high signal, Top 50 = medium, Top 100 = info. Holder cache now includes token amounts (raw and human-readable uiAmount) for accurate comparisons.
- **Emerging Whale Detection**: Detects when a large token purchase could create a new top-10 holder. Compares swap.toAmount (human-readable) against top-10 holder threshold using uiAmount for unit consistency. Broadcasts NEW_TOP_HOLDER WebSocket event and triggers immediate holder list refresh. Skips wallets already in top-10 to prevent false positives. Currently only detects SOL->Token swaps (USDC routes not covered).
- **Enhanced Heat Scoring**: Token heat scores now include whale activity as a 20% weighted factor, considering recent whale events and top-10 holder concentration. Other factors: recentBuys (25%), priceVolatility (20%), userAttention (20%), recency (15%).

## External Dependencies

- **Helius**: Used for real-time Solana blockchain data, specifically for receiving swap transaction webhooks and for dynamic priority fee estimation.
- **Resend**: Integrated for sending email notifications to users regarding swap detections and trading milestones.
- **Jupiter**: Utilized for executing token swaps on the Solana blockchain as part of the automated copy trading functionality.
- **PostgreSQL**: The primary database for persistent storage of all application data.
- **DexScreener**: Used to fetch token metadata such as price, market cap, liquidity, FDV, and volume for token analysis.
- **GPT-4o-mini (via Replit AI Integrations)**: Powers the AI Token Analysis features, providing token scoring, insights, and natural language interaction.

## TODO

- [ ] Add full USDC swap monitoring: USDC→Token and Token→USDC swaps should be detected and processed the same as SOL swaps (webhook parsing, swap recording, whale detection, emerging whale detection, notifications)