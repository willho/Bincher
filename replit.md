# Solana Wallet Swap Monitor

## Overview
A multi-user, real-time monitoring application that tracks swap transactions for Solana wallets and sends email notifications when swaps occur. Each user has their own isolated hot wallet for automated copy trading.

## Authentication
- **Session-based auth**: Uses httpOnly cookies with secure settings
- **Password hashing**: PBKDF2 with 10,000 iterations and random salt per user
- **Remember me**: 1-day (default) or 30-day sessions
- **User isolation**: All data is scoped per user via userId filtering
- **Admin role**: Users with isAdmin=true have access to admin dashboard
- **Username uniqueness**: Case-insensitive at registration, case-sensitive for login
- **New user defaults**: Blank email settings (no pre-filled emails)

## Architecture

### Frontend (React + Vite)
- **Login Page**: Username/password form with "remember this device" option
- **Dashboard**: Main page with tabbed interface for Monitor and Copy Trade sections
- **Monitored Wallets**: Add/edit/remove multiple Solana wallet addresses per user
- **WebSocket**: Real-time updates when new swaps are detected
- **Theme**: Dark-first design with crypto-themed green accent colors

### Backend (Express)
- **Auth Middleware**: Session cookie validation with userId extraction
- **Helius Integration**: Uses webhooks for real-time swap detection (push-based, not polling)
- **Resend Email**: Sends formatted email notifications on swap detection
- **Jupiter Integration**: Executes token swaps for copy trading
- **WebSocket Server**: Broadcasts swap updates to connected clients
- **PostgreSQL Database**: Persists users, monitoring state, settings, swap history, and copy trading data

### Database Tables
- `users` - User accounts with username and hashed password
- `sessions` - Active user sessions with expiration
- `monitored_wallets` - Wallet addresses being monitored per user (with enabled flag)
- `swaps` - Stores detected swap transactions with token metadata (linked to userId)
- `settings` - Stores notification settings per user (emails, enabled status, min amount)
- `monitoring_state` - Stores webhook ID and monitoring status (survives restarts)
- `hot_wallet` - Stores encrypted hot wallet keypair per user for copy trading
- `holdings` - Stores tokens bought through copy trading per user
- `pending_buys` - Queue of tokens waiting to be bought per user
- `trade_config` - Copy trading configuration settings per user

### Key Components
- `/server/db.ts` - Database connection using Drizzle ORM
- `/server/storage.ts` - Database storage layer with CRUD operations
- `/server/auth.ts` - User authentication, session management, password hashing
- `/server/helius.ts` - Helius API client for webhook management and swap parsing
- `/server/email.ts` - Resend email sending with styled HTML templates
- `/server/wallet.ts` - Hot wallet management with encrypted keypair storage
- `/server/jupiter.ts` - Jupiter swap execution with rate limiting
- `/server/trade-processor.ts` - Pending buy queue processor
- `/server/price-monitor.ts` - Price monitoring and auto-reclaim logic
- `/server/routes.ts` - API endpoints, webhook handler, and startup restoration
- `/client/src/pages/dashboard.tsx` - Main dashboard UI
- `/client/src/pages/login.tsx` - Login and registration page
- `/client/src/components/copy-trading.tsx` - Copy trading UI component
- `/client/src/components/monitored-wallets.tsx` - Monitored wallets management UI
- `/client/src/components/admin-dashboard.tsx` - Admin dashboard UI (admin only)
- `/shared/schema.ts` - Database schema and Zod types

## Configuration

### Environment Variables (Secrets)
- `HELIUS_API_KEY` - Helius API key for Solana blockchain data
- `RESEND_API_KEY` - Resend API key for email notifications
- `SESSION_SECRET` - Required (32+ chars) for hot wallet encryption
- `DATABASE_URL` - PostgreSQL connection string (auto-provisioned)

## API Endpoints

### Authentication
- `GET /api/auth/check-setup` - Check if any users exist
- `POST /api/auth/register` - Create new user account
- `POST /api/auth/login` - Login with username/password
- `GET /api/auth/session` - Check current session
- `POST /api/auth/logout` - End session

### Monitoring
- `GET /api/status` - Get monitoring status
- `POST /api/monitoring/start` - Start monitoring (creates Helius webhook)
- `POST /api/monitoring/stop` - Stop monitoring (deletes webhook)
- `POST /api/webhook/helius` - Webhook endpoint for Helius to push swap data
- `GET /api/swaps` - Get all detected swaps for current user
- `GET /api/settings` - Get notification settings
- `PATCH /api/settings` - Update notification settings
- `GET /api/wallet` - Get user's monitored wallet addresses
- `GET /api/webhooks` - Debug: list all Helius webhooks

### Monitored Wallets
- `GET /api/monitored-wallets` - Get user's monitored wallets
- `POST /api/monitored-wallets` - Add a new wallet to monitor
- `PATCH /api/monitored-wallets/:id` - Update wallet (label, enabled)
- `DELETE /api/monitored-wallets/:id` - Delete monitored wallet
- `POST /api/monitored-wallets/sync` - Sync webhook with all monitored wallets

### Copy Trading
- `GET /api/copy-trade/wallet` - Get hot wallet info
- `POST /api/copy-trade/wallet` - Create hot wallet
- `GET /api/copy-trade/balance` - Get hot wallet balance
- `GET /api/copy-trade/config` - Get trade configuration
- `PATCH /api/copy-trade/config` - Update trade configuration
- `GET /api/copy-trade/holdings` - Get token holdings
- `GET /api/copy-trade/pending` - Get pending buy queue
- `POST /api/copy-trade/pending/:pendingId/pause` - Pause a pending buy
- `POST /api/copy-trade/pending/:pendingId/resume` - Resume a paused pending buy
- `POST /api/copy-trade/pending/:pendingId/cancel` - Cancel a pending buy

### Admin (requires isAdmin)
- `GET /api/admin/users` - Get all users
- `DELETE /api/admin/users/:userId` - Delete a user and all their data
- `GET /api/admin/wallets` - Get all monitored wallets across all users
- `GET /api/admin/stats` - Get system-wide statistics

## Features

### Swap Monitoring
- **Persistent Monitoring**: Webhook ID and monitoring status stored in database, survives app restarts
- **Auto-restore**: On startup, automatically updates webhook URL to current deployment URL
- **Multiple Email Recipients**: Add/remove multiple email addresses for notifications
- **Token Metadata**: Fetches price, market cap, liquidity, FDV, volume from DexScreener
- **Real-time Updates**: WebSocket pushes new swaps to connected clients

### Copy Trading
- **Hot Wallet**: Server-side Solana keypair with AES-256-GCM encrypted storage
- **Per-Token Wallets**: Each buy gets a unique disposable wallet for maximum privacy
  - Generates new keypair for each purchase
  - Main wallet funds token wallet with buyAmount + (fee × 4)
  - Token wallet encrypted key stored in holdings table
  - On sells, keeps 4x gas reserve and sends profits to main wallet
- **Dynamic Priority Fees**: Uses Helius RPC to estimate current network fees
- **Automatic Buys**: Queues token purchases when monitored wallet buys SOL → Token
- **Random Delay**: 20-40 minute random delay before executing buy (configurable)
- **Early Triggers**: Buy immediately if 10+ buys detected OR 10% price rise from queue time
- **Buy Size**: Uses 10% of hot wallet SOL balance per trade (configurable)
- **Auto-Reclaim at 4x**: Automatically sells 2x initial investment when tokens hit 4x multiplier
- **Progressive Take-Profit**: Sells 10% of remaining holdings at 10x, 100x, 1000x+ milestones
- **Milestone Tracking**: Each reclaim milestone tracked per token (4x, 10x, 100x, etc.)
- **Milestone Alerts**: Email notifications at 2x, 4x, 10x multipliers (configurable)
- **Duplicate Prevention**: Never buys the same token twice (checks holdings + active/paused pending buys)
- **Rate Limiting**: Jupiter/DexScreener API calls rate-limited to stay within free tier
- **SOL Withdrawal**: Withdraw SOL from hot wallet to any external Solana address
- **Manual Sell**: Sell holdings manually at 25%, 50%, or 100%
- **Pending Buy States**: active (waiting), paused (insufficient funds), cancelled, completed
- **Auto-Pause**: Pending buys are automatically paused when hot wallet balance is too low
- **Manual Control**: Users can pause, resume, or cancel pending buys via UI

## Security
- User passwords hashed with PBKDF2 (10,000 iterations, random salt per user)
- Session tokens stored in httpOnly cookies with secure/sameSite settings
- All API routes protected with auth middleware requiring valid session
- Complete user isolation: all queries filter by userId
- Hot wallet private key encrypted with AES-256-GCM (authenticated encryption)
- Random salt per encryption for stronger security
- SESSION_SECRET required (32+ chars minimum)
- Backward compatible with existing CBC-encrypted keys

## Notes
- Multi-user support with complete data isolation
- Each user has their own monitored wallets, hot wallet, and trading data
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

## Future Enhancements (TODO)

### Private Key Export
- Add secure "Show Private Key" feature to backup hot wallet
- Export base58 format for import into Phantom/Solflare
