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

### Key Components
- `/server/helius.ts` - Helius API client for webhook management and swap parsing
- `/server/email.ts` - Resend email sending with styled HTML templates
- `/server/routes.ts` - API endpoints and webhook handler
- `/client/src/pages/dashboard.tsx` - Main dashboard UI

## Configuration

### Environment Variables (Secrets)
- `HELIUS_API_KEY` - Helius API key for Solana blockchain data
- `RESEND_API_KEY` - Resend API key for email notifications

### Monitored Wallet
- Address: `C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak`
- Notification Email: `will728@gmail.com`

## API Endpoints
- `GET /api/status` - Get monitoring status
- `POST /api/monitoring/start` - Start monitoring (creates Helius webhook)
- `POST /api/monitoring/stop` - Stop monitoring (deletes webhook)
- `POST /api/webhook/helius` - Webhook endpoint for Helius to push swap data
- `GET /api/swaps` - Get all detected swaps
- `GET /api/settings` - Get notification settings
- `PATCH /api/settings` - Update notification settings
- `GET /api/wallet` - Get monitored wallet address

## Notes
- Resend connector was declined; using direct RESEND_API_KEY secret instead
- Helius webhooks push swap data in real-time (no polling required)
- WebSocket at `/ws` for real-time frontend updates

## Running
```bash
npm run dev
```
Starts both frontend (Vite) and backend (Express) on port 5000.
