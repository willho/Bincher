# Solana Wallet Swap Monitor

## Overview
A real-time monitoring application that tracks swap transactions for a specific Solana wallet and sends email notifications when swaps occur.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Main page showing monitoring status, swap history, and notification settings
- **WebSocket**: Real-time updates when new swaps are detected
- **Theme**: Dark-first design with crypto-themed green accent colors

### Backend (Express)
- **Helius Integration**: Uses webhooks for real-time swap detection (push-based, not polling)
- **Resend Email**: Sends formatted email notifications on swap detection
- **WebSocket Server**: Broadcasts swap updates to connected clients
- **PostgreSQL Database**: Persists monitoring state, settings, and swap history

### Database Tables
- `swaps` - Stores detected swap transactions with token metadata
- `settings` - Stores notification settings (emails, enabled status, min amount)
- `monitoring_state` - Stores webhook ID and monitoring status (survives restarts)

### Key Components
- `/server/db.ts` - Database connection using Drizzle ORM
- `/server/storage.ts` - Database storage layer with CRUD operations
- `/server/helius.ts` - Helius API client for webhook management and swap parsing
- `/server/email.ts` - Resend email sending with styled HTML templates
- `/server/routes.ts` - API endpoints, webhook handler, and startup monitoring restoration
- `/client/src/pages/dashboard.tsx` - Main dashboard UI
- `/shared/schema.ts` - Database schema and Zod types

## Configuration

### Environment Variables (Secrets)
- `HELIUS_API_KEY` - Helius API key for Solana blockchain data
- `RESEND_API_KEY` - Resend API key for email notifications
- `DATABASE_URL` - PostgreSQL connection string (auto-provisioned)

### Monitored Wallet
- Address: `C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak`
- Notification Emails: Multiple recipients supported

## API Endpoints
- `GET /api/status` - Get monitoring status
- `POST /api/monitoring/start` - Start monitoring (creates Helius webhook)
- `POST /api/monitoring/stop` - Stop monitoring (deletes webhook)
- `POST /api/webhook/helius` - Webhook endpoint for Helius to push swap data
- `GET /api/swaps` - Get all detected swaps
- `GET /api/settings` - Get notification settings
- `PATCH /api/settings` - Update notification settings
- `GET /api/wallet` - Get monitored wallet address
- `GET /api/webhooks` - Debug: list all Helius webhooks

## Features
- **Persistent Monitoring**: Webhook ID and monitoring status stored in database, survives app restarts
- **Auto-restore**: On startup, automatically updates webhook URL to current deployment URL
- **Multiple Email Recipients**: Add/remove multiple email addresses for notifications
- **Token Metadata**: Fetches price, market cap, liquidity, FDV, volume from DexScreener
- **Real-time Updates**: WebSocket pushes new swaps to connected clients

## Notes
- Resend connector was declined; using direct RESEND_API_KEY secret instead
- Helius webhooks push swap data in real-time (no polling required)
- WebSocket at `/ws` for real-time frontend updates
- Webhook URL automatically adapts between dev and production environments

## Running
```bash
npm run dev
```
Starts both frontend (Vite) and backend (Express) on port 5000.

## Database Commands
```bash
npm run db:push  # Push schema changes to database
```
