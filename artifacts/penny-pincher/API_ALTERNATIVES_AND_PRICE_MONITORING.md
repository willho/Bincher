# Free API Alternatives & Price Monitoring Within Limits

## Problem: GeckoTerminal Rate Limit

Current: 2 req/sec (needs 0.5 req/sec minimum for 120s polling)
Free tier: ~0.33-0.83 req/sec (20-50 req/min)
**Status**: Tight margin, need fallback/supplement

---

## Alternative 1: DexScreener (Pool Discovery)

**Endpoint**: `/latest/dex/trades?chainId=solana`

**Features**:
- Real-time trades on Solana
- Includes new pool detection
- Free tier, no auth needed
- Response time: ~1-2 seconds

**Rate Limit**: 60 requests/minute = 1 req/sec (safe!)

**Implementation**:
```typescript
// Poll DexScreener trending instead of new_pools
const response = await fetch('https://api.dexscreener.com/latest/dex/trades?chainId=solana');
const trades = response.data; // Contains pool addresses + new pools

// Filter to only last 5 minutes of trades
const newPools = trades.filter(t => 
  t.timestamp > Date.now() - 300_000 && 
  !seenBefore.has(t.pair.address)
);
```

**Pros**:
- ✓ Higher rate limit (1 req/sec vs 0.33-0.83)
- ✓ Real trades included (better signal than just pool listing)
- ✓ No fallback needed - primary source

**Cons**:
- Detects pools slightly slower (trades → pool discovery)
- Requires filtering out old trades

**Cost**: Free

---

## Alternative 2: Birdeye (Pool Discovery + Token Data)

**Endpoints**:
- `/defi/token_list` - Token discovery (free tier limited)
- `/defi/v2/tokens` - Token metadata (free tier)
- `/public/token/{address}` - Token price + details

**Rate Limit**: Free tier = 100 requests/minute = 1.67 req/sec (safe!)

**Implementation**:
```typescript
// Birdeye for token metadata + prices
const response = await fetch(
  'https://public-api.birdeye.so/defi/token/{mint}?solana',
  { headers: { 'X-API-KEY': process.env.BIRDEYE_KEY } }
);

const tokenData = response.data;
// Returns: price, liquidity, holder count, 24h volume, etc
```

**Pros**:
- ✓ Includes holder concentration (quality scoring)
- ✓ 24h volume data (helps identify active pools)
- ✓ Creator address on-chain
- ✓ Higher rate limit than GeckoTerminal

**Cons**:
- Requires API key (free tier available)
- Slightly more complex response parsing

**Cost**: Free tier available, ~$50-100/month for paid

---

## Alternative 3: Local RPC + Helius Webhooks (Best Long-term)

**Current Setup**: Already have Helius integrated for webhooks

**Enhancement: Use Helius for token creation events**
```typescript
// Helius webhook subscribes to:
// - Token creation events (new pool deployment)
// - Raydium program events (pool initialization)
// - Get real-time notification instead of polling

webhook.on('raydium_pool_created', (data) => {
  // Instant detection, zero polling overhead
  const { poolAddress, baseToken, quoteToken } = data;
  
  // Store in DB immediately
  await recordNewPool(poolAddress);
});
```

**Helius Cost**: $10-20/month (already paying)
**Polling Eliminated**: Save all GeckoTerminal requests

**Pros**:
- ✓ Real-time (instant detection, not polling delay)
- ✓ Already integrated
- ✓ Eliminates polling overhead entirely
- ✓ Event-driven, not rate-limited

**Cons**:
- Requires webhook setup (already done)
- Need to parse Helius event format

**Cost**: Included in current $10-20/month Helius bill

---

## Recommended: Hybrid Approach

**Primary**: Helius webhooks (instant, no polling)
**Fallback 1**: DexScreener trades (1 req/sec, safe limit)
**Fallback 2**: Birdeye tokens (1.67 req/sec, safe limit)
**Eliminate**: GeckoTerminal polling

### Implementation

```typescript
// server/pool-discovery-hybrid.ts

async function startPoolDiscovery() {
  // 1. Primary: Listen to Helius webhooks (real-time, zero cost)
  const { subscribeToPoolEvents } = await import('./helius-pool-webhook');
  subscribeToPoolEvents((pool) => {
    console.log('[PoolDiscovery] Real-time pool from webhook:', pool.address);
    recordNewPool(pool);
  });

  // 2. Fallback: Poll DexScreener every 60 seconds (1 req/sec safe)
  setInterval(async () => {
    try {
      const trades = await fetchDexScreenerTrades();
      const newPools = detectNewPoolsFromTrades(trades);
      for (const pool of newPools) {
        if (!hasBeenSeen(pool.address)) {
          recordNewPool(pool);
        }
      }
    } catch (error) {
      console.log('[PoolDiscovery] DexScreener fallback failed:', error);
    }
  }, 60_000); // 60 seconds = 1 req/min = 0.017 req/sec (trivial)

  // 3. Secondary fallback: Birdeye token list (every 5 min for safety)
  setInterval(async () => {
    try {
      const tokens = await fetchBirdeyeTokens();
      const newPools = filterToNewPools(tokens);
      // ... record new pools
    } catch (error) {
      console.log('[PoolDiscovery] Birdeye fallback failed:', error);
    }
  }, 300_000); // 300 seconds = 1 req/5min = 0.003 req/sec (negligible)
}
```

**Result**: 
- No GeckoTerminal polling needed
- Helius webhook catches 90% in real-time
- DexScreener catches misses within 60 seconds
- Birdeye is safety net
- **Total API cost**: $0 extra (Helius already paid)

---

## Price Monitoring Within API Limits

**Current system estimates**:
- System picks scanning: 2-5 min intervals = 12-30 scans/hour
- Per scan: validate 3-5 positions with Jupiter = ~15-25 calls/hour
- Jupiter quote endpoint: ~1.67 req/sec limit
- **Usage**: 0.013 req/sec (well within limits)

**Addition: Continuous Price Monitoring**

For tracking position prices without constant polling:

### Option 1: Raydium On-Chain Data (Free)

```typescript
// Read Raydium pool state directly (no API cost)
const poolState = await connection.getAccountInfo(poolAddress);
const { price } = parseRaydiumPoolState(poolState);

// Cost: RPC node read (included with Helius or free Solana RPC)
// Frequency: On-demand (no rate limit)
// Accuracy: Block-height accurate
```

**Pros**:
- ✓ Real-time (block-accurate)
- ✓ No API cost
- ✓ No rate limits

**Cons**:
- Slightly more complex parsing
- Depends on RPC node availability

### Option 2: Jupiter Price API (Safe Within Limits)

```typescript
// Check position prices every 30 seconds during market hours
async function updatePositionPrices() {
  const openPositions = await getOpenPositions();
  
  for (const position of openPositions) {
    const quote = await jupiter.getQuote({
      inputMint: position.tokenMint,
      outputMint: 'USDC...',
      amount: 1_000_000,
    });
    position.currentPrice = quote.outAmount / 1_000_000;
  }
}

// Run every 30 seconds = 2 req/sec
// But batch by mint to reduce calls
// With 50 open positions, batch into ~5 mints = 10 req/min = 0.17 req/sec
```

**Frequency Analysis**:
- 50 open positions max
- 5-10 unique mints typically
- Batch quotes by mint
- Result: ~0.17 req/sec to Jupiter (safe vs 1.67 limit)

**Pros**:
- ✓ Already integrated
- ✓ Real prices for execution validation
- ✓ Safe within rate limits

### Option 3: Hybrid - Raydium + Jupiter

```typescript
// Use Raydium on-chain for free continuous monitoring
// Use Jupiter only before entering/exiting (execution prices)

// Every 10 seconds: Check Raydium pool state (free)
setInterval(async () => {
  for (const position of openPositions) {
    const price = await getRaydiumPoolPrice(position.tokenMint);
    checkPositionExits(position, price); // Track SL/TP
  }
}, 10_000); // 10 second = zero API cost

// Before executing trade: Get Jupiter quote (real price)
const quote = await jupiter.getQuote(...);
if (quote.outAmount > minAcceptable) {
  executeSwap(quote);
}
```

**Result**: 
- Continuous price tracking: FREE (Raydium on-chain)
- Execution validation: ~0.17 req/sec Jupiter (safe)
- **Total cost**: $0 additional

---

## Complete API Budget Analysis

### Current System (with fixes)

| Service | Purpose | Frequency | Rate | Limit | Safety |
|---------|---------|-----------|------|-------|--------|
| GeckoTerminal | Pool discovery | 120s | 0.5 req/sec | 0.33-0.83 | ⚠️ Tight |
| DexScreener | Graduation tracking | 60s | 0.017 req/sec | 1.0 | ✓ Safe |
| DexScreener | Trending backstop | 60s | 0.017 req/sec | 1.0 | ✓ Safe |
| Jupiter | Latency sampling | 30min | 0.008 req/sec | 1.67 | ✓ Safe |
| Jupiter | System picks validation | 2-5min | 0.007 req/sec | 1.67 | ✓ Safe |
| Helius | Webhook events | Real-time | Paid | Included | ✓ Safe |
| **TOTAL** | | | **1.05 req/sec** | | ⚠️ Over limit |

### Optimized System (with alternatives)

| Service | Purpose | Frequency | Rate | Limit | Safety |
|---------|---------|-----------|------|-------|--------|
| Helius | Pool webhooks (primary) | Real-time | Paid | Included | ✓ Safe |
| DexScreener | Pool discovery (fallback) | 60s | 0.017 req/sec | 1.0 | ✓ Safe |
| Birdeye | Token data (fallback) | 300s | 0.003 req/sec | 1.67 | ✓ Safe |
| DexScreener | Graduation tracking | 60s | 0.017 req/sec | 1.0 | ✓ Safe |
| Jupiter | Position prices | 30s batched | 0.17 req/sec | 1.67 | ✓ Safe |
| Jupiter | Latency sampling | 30min | 0.008 req/sec | 1.67 | ✓ Safe |
| Raydium | Price monitoring | 10s on-chain | FREE | N/A | ✓ Safe |
| **TOTAL** | | | **0.23 req/sec** | | ✓ Safe |

---

## Action Plan

### Phase 1: Eliminate GeckoTerminal (Immediate)
- ✓ Already reduced polling to 120s (buys time)
- [ ] Switch to DexScreener for pool discovery
- [ ] Add Birdeye as secondary fallback
- [ ] Cost: $0 (both free)

### Phase 2: Leverage Helius Webhooks (Near-term)
- [ ] Subscribe to Raydium pool creation events via Helius
- [ ] Real-time detection (instant vs 60s delay)
- [ ] Eliminates polling entirely
- [ ] Cost: Included in $10-20/month Helius

### Phase 3: On-chain Price Monitoring (Medium-term)
- [ ] Read Raydium pool state for continuous pricing
- [ ] Only use Jupiter for execution validation
- [ ] Reduces Jupiter load by 95%
- [ ] Cost: Negligible RPC overhead

### Phase 4: Full Optimization (Long-term)
- [ ] Combine all fallbacks into resilient system
- [ ] <0.25 req/sec total external APIs
- [ ] Real-time pool detection via webhooks
- [ ] Continuous price tracking via on-chain reads
- [ ] Final cost: $10-20/month Helius only

---

## Risk Mitigation

**If DexScreener fails**: Birdeye kicks in (~5min delay)
**If Birdeye fails**: Manual backlog monitoring (acceptable)
**If Helius fails**: DexScreener polling continues (0.017 req/sec, safe)
**If Jupiter fails**: Use Raydium prices instead (free alternative)

No single API outage blocks the system.
