# API Rate Limiting & Batching Strategy

## Critical Finding: Jupiter is the Bottleneck

From `api-budget.ts` rate limits:

```typescript
const RATE_LIMITS = {
  geckoterminal: { perMinute: 30 },      // 0.5 req/sec
  dexscreener:   { perMinute: 300 },     // 5 req/sec
  helius:        { perMinute: 600 },     // 10 req/sec
  openai:        { perMinute: 60 },      // 1 req/sec
  jupiter:       { perMinute: 10 },      // 0.167 req/sec ⚠️ STRICTEST
};
```

**Jupiter at 10 requests/minute (0.167 req/sec) is the system bottleneck.**

This means:
- Cannot make more than 10 Jupiter calls per minute
- Total system throughput capped by Jupiter
- All other APIs are "free" relative to Jupiter

---

## How Old System Handled This

### 1. Rate Limiting Implementation

**File: `api-budget.ts`**

```typescript
export async function shouldAllowApiCall(service: ApiService): Promise<{
  allowed: boolean;
  reason?: string;
  throttleFactor?: number;
}> {
  const limits = RATE_LIMITS[service];
  const tracker = getMinuteTracker(service);
  
  // Check 1: Per-minute limit
  if (tracker.calls >= limits.perMinute) {
    return { allowed: false, reason: "rate limit reached" };
  }
  
  // Check 2: Backoff after 429
  if (Date.now() < tracker.backoffUntil) {
    return { allowed: false, reason: "backing off after 429" };
  }
  
  // Check 3: Daily/monthly caps
  const dailyUsage = await getDailyUsage(service);
  if (dailyUsage >= limits.dailyCap) {
    return { allowed: false, reason: "daily cap reached" };
  }
  
  return { allowed: true };
}
```

### 2. Batching Strategy

**For price fetching**: Uses **DexScreener batch endpoint**

```typescript
// DexScreener batch quote (up to 30 tokens per request)
const pairs = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`);
```

**NOT Jupiter batch quotes** — Jupiter is saved for critical execution decisions.

### 3. Tracking & Accounting

**File: `api-budget.ts`**

```typescript
export async function trackApiCall(
  service: ApiService,
  endpoint?: string,
  callCount: number = 1
): Promise<void> {
  // Log API call with call count (for batching)
  // One batch call = one call in tracker (not 30 calls)
  
  await db.insert(apiUsage).values({
    service,
    endpoint,
    callCount,    // ← Tracks batch size
    timestamp,
  });
}
```

Important: Batching doesn't reduce per-minute counter — a batch call still counts as 1 call. But it reduces the total number of API round trips.

---

## Applying to Current System

### The Problem

Current implementation:
- Alchemy websocket for real-time blocks (good!)
- But then calls Jupiter for batch quotes on each block
- ~400ms per block = ~150 blocks/minute
- If Jupiter batch is 10 mints, could hit 15 calls/minute
- **Exceeds Jupiter limit of 10 req/min!**

### The Solution: Global Rate Limiter

```typescript
// Global rate limiter respecting strictest limit (Jupiter: 0.167 req/sec)
class GlobalRateLimiter {
  private minRequestIntervalMs = 6000;  // 1 / 0.167 req/sec = 6 seconds
  private lastRequestTime = 0;
  
  async waitForSlot(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestIntervalMs) {
      await new Promise(resolve => 
        setTimeout(resolve, this.minRequestIntervalMs - timeSinceLastRequest)
      );
    }
    
    this.lastRequestTime = Date.now();
  }
}

// Usage everywhere:
await globalRateLimiter.waitForSlot();
const quotes = await jupiter.getQuotes(...);
```

**Result**: System never exceeds 0.167 req/sec across all APIs.

---

## Alchemy: Does It Support Batch Pricing?

**Answer: No, Alchemy does NOT have a batch quote endpoint.**

Alchemy has:
- ✓ Websocket (real-time, event-driven, not API calls)
- ✓ RPC methods (getTokenMetadata, etc.)
- ✗ No batch price quotes

**Options for price data with Alchemy**:

### Option 1: On-Chain Raydium Prices (Best)
```typescript
// Read Raydium pool state directly from blockchain
// Free: RPC read, no API cost
const poolState = await connection.getAccountInfo(raydiumPoolAddress);
const reserves = parseRaydiumPool(poolState);
const price = reserves.quoteReserve / reserves.baseReserve;
```

**Pros**:
- Free (RPC read included)
- Real-time (block-accurate)
- No rate limits

**Cons**:
- More complex parsing
- Need to identify Raydium pool for each token

### Option 2: DexScreener Batch (Current)
```typescript
// Use DexScreener for batch pricing (what old system does)
// 300 req/min = 5 req/sec, plenty of headroom
const prices = await fetch(
  `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`
);
```

**Pros**:
- Already implemented
- High rate limit (300 req/min)
- Reliable

**Cons**:
- ~2 second latency
- May not be block-accurate

### Option 3: Jupiter Batch (Bottleneck)
```typescript
// Jupiter batch quotes
// 10 req/min = 0.167 req/sec, VERY tight
const quotes = await jupiter.getQuotes({
  quoteRequests: mints.map(m => ({
    inputMint: m,
    outputMint: 'USDC',
    amount: 1000000
  }))
});
```

**Pros**:
- Most accurate (actual swap prices)
- Good for execution validation

**Cons**:
- Lowest rate limit (10 req/min)
- Expensive to use for continuous monitoring

---

## Recommended Architecture

### For Real-Time Exit Monitoring

```
Alchemy websocket: On each block (~400ms)
  ↓
Need current prices immediately
  ↓
Option A: On-chain Raydium prices (free, real-time)
  Cost: RPC read (negligible)
  Latency: <100ms
  
Option B: DexScreener batch (if on-chain is complex)
  Cost: 1 API call per batch
  Latency: 1-2 seconds
  
Option C: DON'T check exits every block
  Instead: Check only if:
    - New block AND
    - (Enough time passed for rate limit) OR
    - Jupiter call quota available
```

### For Position Monitoring in price-monitor.ts

```typescript
// Batch check every 5 minutes
async function checkPricesAndReclaim() {
  const positions = await getOpenPositions();
  const mints = [...new Set(positions.map(p => p.tokenMint))];
  
  // Use DexScreener batch (300 req/min headroom)
  const prices = await getBatchTokenPrices(mints);  // 1 API call
  
  // Check all positions against batch result
  for (const position of positions) {
    checkPositionExits(position, prices.get(position.tokenMint));
  }
  
  // Track the API call
  await trackApiCall("dexscreener", "getBatchTokenPrices", 1);
}
```

### For System Picks Execution

```typescript
// Before opening position: Get fresh Jupiter quote
// This is the ONLY time we use Jupiter
// Cost: 1 Jupiter call per position opened (limited by conviction threshold)

const quote = await jupiter.getQuote({
  inputMint: 'SOL',
  outputMint: tokenMint,
  amount: 1_000_000_000  // 1 SOL in lamports
});

if (quote.outAmount > minAcceptable) {
  executeSwap(quote);
  
  // Track this Jupiter call
  await trackApiCall("jupiter", "getQuote", 1);
}
```

---

## Implementation Steps

### Step 1: Verify Rate Limiting Works

```typescript
// Check: shouldAllowApiCall() is called before ALL API requests
// Verify in:
// - jupiter.ts
// - data-pool.ts (DexScreener calls)
// - Any new API integration

// Pattern should be:
const budgetCheck = await shouldAllowApiCall("dexscreener");
if (!budgetCheck.allowed) {
  console.log("Rate limited:", budgetCheck.reason);
  return;
}

const response = await fetch(...);
await trackApiCall("dexscreener", "endpoint", 1);
```

### Step 2: Use Batch Pricing

```typescript
// ✓ Good: Batch call to DexScreener
const prices = await getBatchTokenPrices(['mint1', 'mint2', ..., 'mint30']);

// ✗ Bad: Individual calls in loop
for (const mint of mints) {
  const price = await getTokenPrice(mint);  // 30 API calls!
}
```

### Step 3: Global Rate Limiter for Jupiter

```typescript
// Add to system-picks-v2.ts
const jupiterRateLimiter = new RateLimiter({
  maxRequests: 10,
  windowMs: 60000  // 10 requests per minute
});

// Before Jupiter calls:
await jupiterRateLimiter.wait();
const quote = await jupiter.getQuote(...);
```

### Step 4: Integrate Alchemy Smartly

```typescript
// Use Alchemy websocket (no API cost) for detection
// Alchemy websocket: real-time blocks

// Get prices from:
// - DexScreener batch (safe, 300 req/min)
// - Or on-chain Raydium (free)

// Use Jupiter ONLY for execution validation
```

---

## Rate Limit Summary by Use Case

| Use Case | API | Limit | Per Minute |
|----------|-----|-------|-----------|
| Pool discovery | DexScreener | 300 req/min | 1 call = 5 mins |
| Price monitoring | DexScreener | 300 req/min | 1 call per batch |
| Execution validation | Jupiter | 10 req/min | Only when trading |
| Real-time exit check | On-chain RPC | Unlimited | Free |

**Total safe throughput**: 
- DexScreener: 5 req/sec (not limiting)
- Jupiter: 0.167 req/sec (LIMITING)
- On-chain: Unlimited

**Design principle**: Use expensive Jupiter only for critical decisions (execution). Use cheap DexScreener for monitoring. Use free on-chain for exits.

---

## What Changed from Old System

| Aspect | Old | New (Needed) |
|--------|-----|------------|
| Pool discovery | GeckoTerminal (slow) | DexScreener (batched) |
| Price monitoring | 30s polling | Alchemy websocket |
| Exit monitoring | 30s polling → Jupiter | On-chain reads (free) |
| Rate limiting | Per-service | **Global (Jupiter-limited)** |
| Batching | DexScreener ✓ | Need to verify everywhere |

**The critical gap**: Alchemy real-time detection is good, but exit monitoring can't hit Jupiter 10x per block. Need to either:
1. Use on-chain Raydium prices (free)
2. Check exits only once per Jupiter quota
3. Cache prices and check async
