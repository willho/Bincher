# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.6
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod, `drizzle-zod`
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/penny-pincher run dev` — run Penny Pincher locally
- `pnpm --filter @workspace/penny-pincher run db:push` — push Penny Pincher DB schema

## Artifacts

### Penny Pincher (`artifacts/penny-pincher`)
- **Kind**: Web application (React + Express, monolithic)
- **Port**: 23576
- **Preview path**: `/`
- **Dev command**: `NODE_ENV=development tsx server/index.ts`
- **Architecture**: Express serves both REST API (`/api/*`) and React via Vite middleware
- **Database**: Shared PostgreSQL (132 tables including pgvector extension for ML)
- **Key features**: Solana automated trading, WebSocket dual-provider (PumpPortal + PumpDev), AI predictions, copy trading, wallet analysis
- **Required secrets**: See `artifacts/penny-pincher/.env.example` for all required API keys (Helius, Chainstack, OpenAI, etc.)
- **Single-server mode**: `SKIP_STARTUP_WIZARD=true` is set in artifact.toml — bypasses the multi-proxy startup check

### API Server (`artifacts/api-server`)
- **Kind**: API
- **Port**: 8080
- **Preview path**: `/workspace-api`
- Workspace utility server (not part of Penny Pincher product)

### Canvas / Mockup Sandbox (`artifacts/mockup-sandbox`)
- **Kind**: Design / component preview
- **Port**: 8081
- **Preview path**: `/__mockup`

## Database Notes

- pgvector extension is enabled (for token fingerprint ML features)
- Two tables required manual creation due to drizzle-kit `vector(undefined)` bug: `active_token_trajectories`, `token_fingerprint_clusters` — both use `vector(26)` columns
- Duplicate index names fixed in schema: `idx_ss_token_mint` (server_subscriptions), `idx_tms_snapshot_timestamp` (token_milestone_snapshots)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
