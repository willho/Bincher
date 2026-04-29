# Debug Tools for Penny-Pincher2

## External Data Access Constraints

**Testing Results (April 29, 2026)**:
- ✗ Pump.fun: Blocked - `host_not_allowed` (403)
- ✗ Solscan: Blocked - `host_not_allowed` (403)
- ✗ DexScreener API: Blocked - 403 (CORS/IP blocked)
- ✗ Magic Eden API: Blocked - 403 (CORS/IP blocked)
- ✗ Puppet puppet can't bypass SSL cert errors in this environment

**Conclusion**: External website scraping is not feasible from this deployment environment. All web resources block requests from this IP with host/CORS restrictions.

## Available Debug Approaches

### 1. Internal Data Validation (`compare-data-sources.ts`)
Compare Pincher2's internal database against our own RPC queries:
```bash
# Set DATABASE_URL first
export DATABASE_URL="postgresql://user:pass@host/db"
npm exec -- tsx debug-tools/compare-data-sources.ts
```

**Validates**:
- Token discovery accuracy (is Pincher2 seeing tokens?)
- Trade capture completeness (are all trades being recorded?)
- Holder calculation accuracy (are top holders identified correctly?)

### 2. Snapshot Verification (`verify-snapshots.ts`) [TODO]
Query recent tokens and inspect their fingerprint snapshots:
- Verify snapshot firing logic (time-based, price milestones, trade volume)
- Inspect trajectory data (anchored vs current)
- Validate top 20 holder calculations

### 3. RPC State Inspection (`query-rpc-state.ts`) [TODO]
Query Solana blockchain directly via RPC to verify:
- Token account balances match our records
- Trade signatures exist on-chain for recorded trades
- Holder addresses are legitimate

## Setup

### Prerequisites
1. Database connection (set `DATABASE_URL`)
2. Solana RPC endpoint (use existing Helius/Chainstack config)

### NPM Scripts
```bash
# Compare internal vs RPC state
npm run debug:compare

# Inspect token snapshots (once implemented)
npm run debug:snapshots

# Query blockchain state (once implemented)
npm run debug:rpc-state
```

## Example: Validating Token Discovery

```bash
# 1. Start Penny-Pincher2 normally
npm run dev

# 2. In another terminal, run comparison
npm run debug:compare

# Output shows:
# - X tokens in Pincher2 DB from last 24h
# - Y tokens in accessible sources
# - Overlap and differences
```

This helps answer: "Is Penny-Pincher2 discovering all important tokens?"

## Limitations

Without external API access, we can only validate:
- ✓ Internal consistency (our DB vs our RPC calls)
- ✓ Blockchain state (verify our records on-chain)
- ✗ Completeness vs external sources (can't compare to Pump.fun listings)

For production monitoring, consider:
- Running Penny-Pincher2 on a VPS/server with open internet access
- Using a proxy service that can access blocked sites
- Integrating with a partner service that has Pump.fun data access
