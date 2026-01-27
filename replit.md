# Solana Wallet Swap Monitor

## Overview
A real-time monitoring application that tracks swap transactions for a specific Solana wallet and sends email notifications when swaps occur. Includes automated copy trading functionality with a hot wallet.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Main page with tabbed interface for Monitor and Copy Trade sections
- **WebSocket**: Real-time updates when new swaps are detected
- **Theme**: Dark-first design with crypto-themed green accent colors

### Backend (Express)
- **Helius Integration**: Uses webhooks for real-time swap detection (push-based, not polling)
- **Resend Email**: Sends formatted email notifications on swap detection
- **Jupiter Integration**: Executes token swaps for copy trading
- **WebSocket Server**: Broadcasts swap updates to connected clients
- **PostgreSQL Database**: Persists monitoring state, settings, swap history, and copy trading data

### Database Tables
- `swaps` - Stores detected swap transactions with token metadata
- `settings` - Stores notification settings (emails, enabled status, min amount)
- `monitoring_state` - Stores webhook ID and monitoring status (survives restarts)
- `hot_wallet` - Stores encrypted hot wallet keypair for copy trading
- `holdings` - Stores tokens bought through copy trading
- `pending_buys` - Queue of tokens waiting to be bought
- `trade_config` - Copy trading configuration settings

### Key Components
- `/server/db.ts` - Database connection using Drizzle ORM
- `/server/storage.ts` - Database storage layer with CRUD operations
- `/server/helius.ts` - Helius API client for webhook management and swap parsing
- `/server/email.ts` - Resend email sending with styled HTML templates
- `/server/wallet.ts` - Hot wallet management with encrypted keypair storage
- `/server/jupiter.ts` - Jupiter swap execution with rate limiting
- `/server/trade-processor.ts` - Pending buy queue processor
- `/server/price-monitor.ts` - Price monitoring and auto-reclaim logic
- `/server/routes.ts` - API endpoints, webhook handler, and startup restoration
- `/client/src/pages/dashboard.tsx` - Main dashboard UI
- `/client/src/components/copy-trading.tsx` - Copy trading UI component
- `/shared/schema.ts` - Database schema and Zod types

## Configuration

### Environment Variables (Secrets)
- `HELIUS_API_KEY` - Helius API key for Solana blockchain data
- `RESEND_API_KEY` - Resend API key for email notifications
- `SESSION_SECRET` - Required (32+ chars) for hot wallet encryption
- `DATABASE_URL` - PostgreSQL connection string (auto-provisioned)

### Monitored Wallet
- Address: `C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak`
- Notification Emails: Multiple recipients supported

## API Endpoints

### Monitoring
- `GET /api/status` - Get monitoring status
- `POST /api/monitoring/start` - Start monitoring (creates Helius webhook)
- `POST /api/monitoring/stop` - Stop monitoring (deletes webhook)
- `POST /api/webhook/helius` - Webhook endpoint for Helius to push swap data
- `GET /api/swaps` - Get all detected swaps
- `GET /api/settings` - Get notification settings
- `PATCH /api/settings` - Update notification settings
- `GET /api/wallet` - Get monitored wallet address
- `GET /api/webhooks` - Debug: list all Helius webhooks

### Copy Trading
- `GET /api/copy-trade/wallet` - Get hot wallet info
- `POST /api/copy-trade/wallet` - Create hot wallet
- `GET /api/copy-trade/balance` - Get hot wallet balance
- `GET /api/copy-trade/config` - Get trade configuration
- `PATCH /api/copy-trade/config` - Update trade configuration
- `GET /api/copy-trade/holdings` - Get token holdings
- `GET /api/copy-trade/pending` - Get pending buy queue

## Features

### Swap Monitoring
- **Persistent Monitoring**: Webhook ID and monitoring status stored in database, survives app restarts
- **Auto-restore**: On startup, automatically updates webhook URL to current deployment URL
- **Multiple Email Recipients**: Add/remove multiple email addresses for notifications
- **Token Metadata**: Fetches price, market cap, liquidity, FDV, volume from DexScreener
- **Real-time Updates**: WebSocket pushes new swaps to connected clients

### Copy Trading
- **Hot Wallet**: Server-side Solana keypair with AES-256-GCM encrypted storage
- **Automatic Buys**: Queues token purchases when monitored wallet buys SOL → Token
- **Random Delay**: 20-40 minute random delay before executing buy (configurable)
- **Early Triggers**: Buy immediately if 10+ buys detected OR 15% price rise
- **Buy Size**: Uses 10% of hot wallet SOL balance per trade (configurable)
- **Auto-Reclaim**: Automatically sells 2x initial investment when tokens hit 4x multiplier
- **One-Time Reclaim**: Each token only reclaimed once, remaining tokens are pure profit
- **Milestone Alerts**: Email notifications at 2x, 4x, 10x multipliers (configurable)
- **Duplicate Prevention**: Never buys the same token twice
- **Rate Limiting**: Jupiter/DexScreener API calls rate-limited to stay within free tier

## Security
- Hot wallet private key encrypted with AES-256-GCM (authenticated encryption)
- Random salt per encryption for stronger security
- SESSION_SECRET required (32+ chars minimum)
- Backward compatible with existing CBC-encrypted keys

## Notes
- Resend connector was declined; using direct RESEND_API_KEY secret instead
- Helius webhooks push swap data in real-time (no polling required)
- Price monitoring uses hybrid approach: push for swaps, minimal polling for prices
- WebSocket at `/ws` for real-time frontend updates
- Webhook URL automatically adapts between dev and production environments
- Trade processor runs every 30 seconds to check pending buys
- Price monitor runs every 60 seconds to check holdings prices

## Running
```bash
npm run dev
```
Starts both frontend (Vite) and backend (Express) on port 5000.

## Database Commands
```bash
npm run db:push  # Push schema changes to database
```
