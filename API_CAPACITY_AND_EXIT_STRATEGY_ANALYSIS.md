# API Capacity & Exit Strategy Assessment

## Part 1: API Rate Limit Analysis

### Current System Load Estimation

#### GeckoTerminal (Raydium Pool Discovery)
- **Frequency**: Every 30 seconds
- **Requests per call**: 1 (fetch `/api/v2/networks/solana/new_pools`)
- **Calculated load**: 2 requests/second (120/min)
- **Free tier limit**: Typically 20-50 req/min (source varies)
- **Status**: ⚠️ **CRITICAL** - Exceeds free tier by 2.4-6x
- **Mitigation**: Need paid tier or implement local node

#### DexScreener (Graduation tracking + Trending)
- **Frequency**: 
  - Graduation poll: Every 60 seconds (1 req/min)
  - Trending backstop: Every 60 seconds (1 req/min)
  - Creator data lookups: ~10-20 new tokens/day = ~0.015 req/min
- **Calculated load**: ~2 req/min = 0.033 req/second
- **Free tier limit**: 60-100 req/min standard
- **Status**: ✓ **SAFE**

#### Jupiter (Latency sampling + System picks validation)
- **Latency sampling** (every 30 minutes):
  - 3 methods × multiple samples = ~15 requests/30min = 0.008 req/sec
- **System picks validation** (every 2-5 minutes):
  - Per scan: ~30 candidates, validate 3-5 with Jupiter = 4 req/scan
  - 12-30 scans/hour = ~48-120 calls/hour = 0.013-0.033 req/sec
- **Total Jupiter**: ~0.02-0.04 req/sec = 1.8-3.5 req/min
- **Free tier limit**: 100 req/min standard
- **Status**: ✓ **SAFE**

#### PumpPortal (Creator history)
- **Frequency**: ~10-20 new tokens/day = 0.007-0.014 req/min
- **Free tier limit**: Unknown (needs verification)
- **Status**: ? **VERIFY AVAILABILITY**

#### Helius (Unified webhook)
- **Cost model**: ~$10-20/month for webhook events
- **Status**: ✓ **PAID** (already integrated)

### Summary

| Service | Load (req/sec) | Free Tier | Status | Priority |
|---------|---|---|---|---|
| GeckoTerminal | **2.0** | ~0.33-0.83 | ❌ EXCEEDS | **CRITICAL FIX** |
| DexScreener | 0.033 | ~1.0-1.67 | ✓ Safe | OK |
| Jupiter | 0.02-0.04 | ~1.67 | ✓ Safe | OK |
| PumpPortal | 0.015 | Unknown | ? | **VERIFY** |
| Helius | Paid | - | ✓ Paid | OK |
| **TOTAL** | **~2.1 req/sec** | - | **EXCEEDS FREE** | - |

### Critical Issue: GeckoTerminal

**Problem**: 30-second polling of GeckoTerminal new pools endpoint violates free tier rate limits.

**Options**:
1. **Paid tier**: GeckoTerminal has paid plans (~$50-200/month for higher limits)
2. **Reduce frequency**: Poll every 120 seconds instead of 30 (reduces to 0.5 req/sec, still 50x free tier)
3. **Local RPC fallback**: Run private Solana RPC node, use getProgramAccounts directly
4. **Hybrid approach**: Use GeckoTerminal as primary with 120sec interval, have local RPC fallback for high-frequency updates

**Recommendation**: 
- **Short-term**: Increase polling interval to 120 seconds (0.5 req/sec)
- **Medium-term**: Implement local RPC node or upgrade to paid tier
- **Current status**: Code has no rate limit protection - will hit soft bans within hours

---

## Part 2: Exit Strategy Gap Analysis

### Current Implementation

In `system-picks-v2.ts`, each cluster defines:
```typescript
spike_and_bleed: {
  entryWindow: 5,
  takeProfitMultiplier: 5,        // ← SINGLE exit point
  stopLossPercent: 30,
  trailingStopPercent: 15,
  maxHoldMinutes: 60,
}
```

In `paper-trading.ts`, exit logic is:
```typescript
if (position.takeProfitMultiplier && 
    currentPrice >= position.entryPrice * position.takeProfitMultiplier) {
  await closePositionInternal(position.id, "take_profit", position.experimentId);
  // Exits ENTIRE position at once
}
```

### The Problem: Missing Take-Initial Strategy

**Take-Profit (current)**: Exit entire position at fixed multiplier (5x)
- Risk: Miss larger moves, but capture guaranteed profit
- Example: Buy at $0.001, sell all at $0.005 = 5x, done

**Take-Initial (not implemented)**: Scale out gradually
- Risk/Reward: Capture early profits, keep runner for larger moves
- Example: 
  - Buy 1000 tokens at $0.001 (entry)
  - At $0.002 (2x): Sell 250 tokens (25%), take $0.50 profit
  - At $0.004 (4x): Sell 250 tokens (25%), take $1.00 profit
  - At $0.010 (10x): Sell 250 tokens (25%), take $2.50 profit
  - Remaining 250 tokens: Hold with TSL for moonshot

### Impact on System

**For retrolearner**:
- Current fingerprint: "Win rate 72%" (binary: profit/loss)
- Needed: Track partial exit distribution: "25% at 2x, 25% at 4x, 25% at 10x, 25% runner"

**For system picks**:
- Current strategy: Binary decision for each position
- Needed: Multiple exit tiers per cluster

**For position tracking**:
- Current: One close per position (all-or-nothing)
- Needed: Multiple partial closes with separate tracking

**For P&L tracking**:
- Current: Single `realizedPnl` value
- Needed: Aggregate realized from multiple exits + unrealized from remainder

### Database/Schema Changes Needed

**paper_positions table** changes:
```typescript
// New fields for exit tiers
exitTiers: {                  // JSON: [{"price": 2.0, "percent": 25}, ...]
  multiplier: number;         // Exit multiplier
  percentage: number;         // % of position to exit at this level
  triggered: boolean;         // Has this tier been hit?
  executedAt?: number;        // Timestamp when executed
}[]

// Track partial exits
remainingTokens: number;      // Tokens still held (calculated from exits)
remainingSol: number;         // SOL value still at risk
totalRealizedPnl: number;     // Sum of all partial exits
totalRealizedPercent: number; // Aggregate return %
```

---

## Part 3: Recommended Implementation

### Phase 1: Fix GeckoTerminal API Load (Immediate)

**File**: `server/raydium-pool-discovery.ts`

Change:
```typescript
// Current: every 30 seconds
setInterval(async () => {
  await pollNewPools();
}, 30_000);

// New: every 120 seconds (reduces load to 0.5 req/sec)
setInterval(async () => {
  await pollNewPools();
}, 120_000);
```

**Impact**: Still detects new pools within 2 minutes (acceptable for most cases)

**Alternative**: Add rate limit protection
```typescript
const rateLimiter = new RateLimiter(60 / 20); // 20 req/min max
await rateLimiter.waitForSlot();
await makeRequest();
```

### Phase 2: Implement Take-Initial Exit Strategy (Medium Priority)

**New function**: `server/exit-strategies.ts`

```typescript
interface ExitTier {
  multiplier: number;   // 2.0, 4.0, 10.0, etc
  percentage: number;   // 0-100
}

interface ClusterExitStrategy {
  takeProfitMultiplier?: number;  // Single exit (backward compat)
  exitTiers?: ExitTier[];          // Scaled exits
  stopLossPercent: number;
  trailingStopPercent?: number;
  maxHoldMinutes: number;
}

// Updated cluster strategies:
const strategies = {
  spike_and_bleed: {
    exitTiers: [
      { multiplier: 2.0, percentage: 25 },
      { multiplier: 4.0, percentage: 25 },
      { multiplier: 5.0, percentage: 25 },
      { multiplier: 10.0, percentage: 25 }  // runner
    ],
    stopLossPercent: 30,
    trailingStopPercent: 15,
    maxHoldMinutes: 60,
  }
}
```

**Position exit logic change**:
```typescript
// Instead of all-or-nothing:
if (position.takeProfitMultiplier && 
    currentPrice >= position.entryPrice * position.takeProfitMultiplier) {
  await closePositionInternal(position.id, "take_profit");
}

// Do this:
for (const tier of position.exitTiers) {
  if (!tier.triggered && currentPrice >= position.entryPrice * tier.multiplier) {
    await closePartialPosition(position.id, tier);
    tier.triggered = true;
  }
}
```

### Phase 3: Update Retrolearner Fingerprints

**File**: `server/retrolearner-v2.ts`

Update fingerprint structure:
```typescript
interface TokenFingerprint {
  // Current fields...
  
  // New: Exit tier breakdown
  exitTierDistribution: {
    tier1_multiplier: number;      // e.g., 2.0
    tier1_hitRate: number;         // % of trades reaching this
    tier2_multiplier: number;      // e.g., 4.0
    tier2_hitRate: number;
    // ...
    runnerMultiplier: number;      // e.g., 10.0
    runnerHitRate: number;         // % that reach moon level
  }
  
  // For pattern correlation
  scalingOutVsHoldRate: number;   // % choosing scale-out vs hold-all
}
```

---

## Immediate Action Items

### Critical (Today)
- [ ] Verify GeckoTerminal free tier rate limits
- [ ] Reduce `raydium-pool-discovery.ts` polling from 30s → 120s
- [ ] Add rate limiter to prevent API bans

### High Priority (This Sprint)
- [ ] Verify PumpPortal API availability and rate limits
- [ ] Design exit-strategies.ts with take-initial support
- [ ] Update paper-trading.ts to handle partial position closes

### Medium Priority (Next Sprint)
- [ ] Implement take-initial exit tier tracking
- [ ] Update retrolearner-v2.ts fingerprint structure
- [ ] Validate system picks v2 with new exit strategies

---

## API Fallback Strategy

For maximum reliability:
```
Primary APIs (tested):
- DexScreener (graduation + trending)
- Jupiter (latency + quotes)
- Helius (webhook)

Fallback APIs:
- Birdeye (trending, creator data)
- Magic Eden (pool discovery)
- Alchemy (if Helius fails)

Local nodes (if needed):
- Solana RPC node for getProgramAccounts
- Geyser plugin for real-time pool detection
```

---

## Success Metrics

After fixes:
- [ ] API load: <1.0 req/sec peak
- [ ] No rate limit errors for 48 hours
- [ ] Exit tiers tracked in 90%+ of positions
- [ ] Retrolearner validates exit tier effectiveness
- [ ] System picks v2 uses cluster-specific exit strategies
