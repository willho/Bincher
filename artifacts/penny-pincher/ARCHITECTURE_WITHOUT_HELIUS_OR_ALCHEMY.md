# Architecture Without Helius or Alchemy

## What We Have (Free/Cheap APIs)

```typescript
const AVAILABLE_APIS = {
  // Pool Discovery
  dexscreener:   { perMinute: 300 },     // 5 req/sec (batch pricing too)
  geckoterminal: { perMinute: 30 },      // 0.5 req/sec (reduced to 120s polling)
  
  // Execution Validation
  jupiter:       { perMinute: 10 },      // 0.167 req/sec (bottleneck)
  
  // RPC (Free Public)
  solana_rpc:    { unlimited },          // Free public endpoint
};

// NO Helius (RPC provider)
// NO Alchemy (websocket, monthly limits)
```

---

## What We Can't Do Anymore

```
✗ Real-time webhook detection (no Helius)
✗ Block-level websocket monitoring (no Alchemy)
✗ Instant notifications on token creation
✗ Instant swap/trade event detection
```

---

## What We CAN Still Do

### 1. Pool Discovery via Polling

**Option A: DexScreener (Better)**
```typescript
// Poll trending/new pools from DexScreener
// 300 req/min = 5 req/sec (safe, plenty of headroom)

setInterval(async () => {
  const newPools = await dexscreener.getNewPools();
  // Detect pools created in last 2 minutes
  
  for (const pool of newPools) {
    if (!seenBefore.has(pool.address)) {
      registerTokenForMonitoring(pool);
    }
  }
}, 120_000);  // Every 2 minutes
```

**Option B: GeckoTerminal (Current)**
```typescript
// Already polling every 120 seconds
// 0.5 req/sec (fixed from 2 req/sec)
```

**Latency**: 2-minute delay instead of instant. Acceptable.

### 2. Exit Monitoring via Polling

**On-Chain Raydium Prices (Free)**
```typescript
// Read pool state directly from blockchain
// No API cost, no rate limits

async function checkExits(positions) {
  for (const position of positions) {
    const poolState = await connection.getAccountInfo(raydiumPoolAddress);
    const price = parseRaydiumPrice(poolState);
    
    checkPositionExits(position, price);
  }
}

// Can call frequently (every 5-10 seconds)
// Cost: RPC read, included in free public RPC
```

**DexScreener Batch (Fallback)**
```typescript
// If on-chain parsing is complex, use batch pricing
const prices = await dexscreener.batch(mints);  // 300 req/min, safe
```

**Latency**: 5-10 seconds (acceptable for exits)

### 3. Price Monitoring

**DexScreener Batch**
```typescript
// Every 5 minutes: Check all open positions
async function checkPricesAndReclaim() {
  const mints = getOpenPositionMints();
  const prices = await dexscreener.batch(mints);  // 1 API call
  
  for (const position of positions) {
    checkPositionExits(position, prices.get(position.tokenMint));
  }
}
```

**Cost**: ~1 call per 5 min = 288 calls/day, well within 300 req/min

---

## Polling Intervals (No Real-Time)

```
Pool Discovery:       Every 2 minutes  (DexScreener new_pools)
Exit Monitoring:      Every 5 seconds  (On-chain Raydium reads)
Price Monitoring:     Every 5 minutes  (DexScreener batch)
Position Entry:       When triggered   (Jupiter quote before buy)
```

**Delays**:
- New pool: Up to 2 minutes
- Exit detection: Up to 5 seconds
- Acceptable? Yes — still faster than manual trading

---

## System Picks Execution Flow

```
1. System picks scanner: Every 2 minutes
   ↓
   Get new pools from DexScreener
   Match to clusters
   Check creator reputation
   Calculate conviction
   ↓
2. If conviction passes:
   ↓
   Get fresh Jupiter quote (1 API call)
   Validate entry price
   Open position with 1 SOL
   ↓
3. Position monitoring: Every 5 seconds
   ↓
   Read on-chain Raydium price (free)
   Check SL/TP/TSL
   Execute exits immediately if hit
```

**Cost per position entry**: 1 Jupiter call + RPC reads (free)
**Cost per position monitoring**: RPC reads only (free)

---

## Rate Limit Summary (No Helius/Alchemy)

| Purpose | API | Calls | Interval | Rate | Status |
|---------|-----|-------|----------|------|--------|
| Pool discovery | DexScreener | 1 | 120s | 0.5/min | ✓ Safe |
| Price monitoring | DexScreener | 1 batch | 300s | 0.2/min | ✓ Safe |
| Exit monitoring | RPC read | Many | 5s | 0/API | ✓ Free |
| Entry validation | Jupiter | 1 | On trigger | <1/min | ✓ Safe |
| **TOTAL** | | | | **<1 req/min** | ✓ Very safe |

---

## Implications Without Webhooks

**What Changes**:
- Pool discovery: Polling delay (up to 2 minutes)
- Entry: Slightly slower (no instant webhook trigger)
- Exit: Still fast (polling every 5 seconds on-chain)
- Cost: Significantly lower (all free tier APIs)

**What Stays the Same**:
- Creator reputation lookup (PumpPortal/pump.fun APIs)
- Cluster matching
- Conviction scoring
- Exit strategy tiers
- Learning systems

**Trade-off**: 
- Lose: Instant detection of new pools
- Gain: No Helius/Alchemy dependencies, pure free APIs

---

## Implementation Without Helius

### Removed
- `alchemy-realtime-monitor.ts` (no Alchemy needed)
- Helius RPC provider logic
- Helius webhook handlers

### Keep
- DexScreener batch pricing
- GeckoTerminal pool discovery (120s polling)
- On-chain Raydium price reads (free public RPC)
- Jupiter quotes (entry validation only)
- Creator reputation lookup

### Add
- Free public RPC endpoint (Solana official or QuickNode free tier)
- Raydium pool parsing for on-chain prices
- Polling-based pool discovery (2-minute interval)

---

## Public RPC Options (Free)

```
1. Solana Official RPC (Free)
   https://api.mainnet-beta.solana.com
   Rate: 100 req/s (safe)
   
2. QuickNode Free Tier
   https://api.quicknode.com/sol/free
   Rate: 300 requests/min
   
3. Local Solana RPC (Best)
   Run your own node
   Unlimited, no rate limits
```

---

## Updated Architecture (No Webhooks)

```
New Token Lifecycle:
  
  T=0:00 - Token created on Solana
  
  T=0:00-2:00 - System polling (waiting to detect)
  
  T=2:00 - Pool appears in DexScreener
           System picks scanner runs
           Detects pool, matches cluster
           Calculates conviction
  
  T=2:05 - If conviction passes:
           Get Jupiter quote
           Open position
  
  T=2:05+ - Exit monitoring: Every 5 seconds
            Read on-chain Raydium price
            Check SL/TP/TSL
            Execute exits immediately
```

**Latency**: 2-5 minute delay on entry (polling-based)
**Acceptable?** For crypto trading, yes — many opportunities repeat

---

## Advantages of No Webhooks

```
✓ No Helius cost ($10-20/month)
✓ No Alchemy cost or monthly limits
✓ No dependency on paid services
✓ Simpler architecture (polling only)
✓ Predictable costs (essentially free)
✓ All APIs are free tier
✓ No monthly quota surprises
```

---

## Cost Analysis

**Daily API Usage (without webhooks)**:
```
Pool discovery:    1 call/min × 1440 = 1,440 calls/day
Price monitoring:  1 call/5min × 288 = 288 calls/day
Exit monitoring:   RPC reads (free)
Entry validation:  Jupiter only on trigger (~50/day)

Total API calls:   ~1,800/day
Daily cost:        $0
Monthly cost:      $0
```

**vs Old System**:
- Helius: $10-20/month
- Other APIs: ~$0

**Savings**: $10-20/month

---

## Recommendation

**Without Helius or Alchemy**:
1. Use DexScreener for pool discovery (2-min polling)
2. Use on-chain Raydium for exit monitoring (free RPC)
3. Use Jupiter quotes only for entry validation
4. Accept 2-5 minute latency on new pool detection
5. Gain pure free-tier API architecture

**Trade-off**: Slower detection, zero cost.
