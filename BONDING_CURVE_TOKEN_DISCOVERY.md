# Bonding Curve Token Discovery & Batch APIs

## Problem: Missing Bonding Curve Tokens

Current discovery relies on:
- DexScreener (Raydium pools only)
- GeckoTerminal (Raydium pools only)
- GeckoTerminal (new_pools endpoint)

**Issue**: Bonding curve tokens on pump.fun never appear in these APIs.

```
Token lifecycle:
  0-4 hours: Bonding curve (pump.fun only) ← NOT in DexScreener/GeckoTerminal
  4+ hours:  Graduation to Raydium         ← Appears in DexScreener
```

**Result**: Missing first 4 hours of best trading window (lowest prices, highest upside).

---

## pump.fun & PumpPortal Batch APIs

### pump.fun Frontend API (Free, Batch Support)

**Endpoint**: `https://frontend-api.pump.fun`

#### Get New/Trending Tokens
```typescript
// Fetch new tokens on bonding curve
const response = await fetch('https://frontend-api.pump.fun/coins', {
  method: 'GET',
  params: {
    offset: 0,
    limit: 30,  // Batch: up to 30 per request
    sort: 'latest',  // or 'trending'
    order: 'desc'
  }
});

// Returns array of tokens still on bonding curve
const tokens = response.data.coins;  // Array of 30 tokens

// Each token has:
// - mint: token address
// - name: token name
// - symbol: token symbol  
// - description: token description
// - image_uri: token image
// - created_timestamp: when bonding curve started
// - usd_market_cap: current market cap on curve
// - reply_count: engagement metric
// - last_reply: when last activity occurred
// - king_of_the_hill: boolean (trending indicator)
```

**Rate Limit**: Not explicitly published, appears to be permissive (probably 100+ req/min)

#### Get Creator's Tokens (Batch)
```typescript
// Get all tokens from one creator
const response = await fetch(
  `https://frontend-api.pump.fun/creator/${creatorAddress}/tokens`,
  { limit: 100 }  // Batch: up to 100 tokens
);

const creatorTokens = response.data.tokens;  // Array of all tokens from creator
```

#### Get Token Details
```typescript
// Get detailed token info
const response = await fetch(
  `https://frontend-api.pump.fun/coin/${mint}`
);

const tokenData = response.data.coin;
// - bonding_curve_progress: 0-100 (% to graduation)
// - virtual_sol_reserves: liquidity on curve
// - virtual_token_reserves: token supply on curve
// - price: current price on curve
// - market_cap: current market cap
```

---

### PumpPortal API (Batch Support)

**Endpoint**: `https://api.pumpportal.fun`

#### Batch Trending Tokens
```typescript
// Get trending tokens (batch endpoint)
const response = await fetch('https://api.pumpportal.fun/trending', {
  params: {
    period: '5m',  // or '1h', '6h', '24h'
    limit: 50,     // Batch: up to 50
    include_bonding_curve: true
  }
});

const trendingTokens = response.data;  // Array of trending tokens
// Includes both bonding curve AND graduated tokens
```

#### Batch Creator Stats
```typescript
// Get stats for multiple creators (implicit batch)
const creators = ['0xAbc...', '0xDef...', '0xGhi...'];

const stats = await Promise.all(
  creators.map(creator =>
    fetch(`https://api.pumpportal.fun/creator/${creator}/stats`)
  )
);
```

#### Batch Token Metadata
```typescript
// PumpPortal may support batch token lookups
// Check: https://api.pumpportal.fun/token/{mints}
// (some endpoints support comma-separated mints)
```

---

## Discovery Strategy (With Bonding Curve Support)

### Phase 1: Bonding Curve Monitoring (0-4 hours)

```typescript
setInterval(async () => {
  // Poll pump.fun every 30 seconds for new/trending bonding curve tokens
  const response = await fetch('https://frontend-api.pump.fun/coins?limit=30&sort=latest');
  const newTokens = response.data.coins;
  
  for (const token of newTokens) {
    if (!seenBefore.has(token.mint)) {
      registerBondingCurveToken({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        bondingCurveProgress: 0,  // Just created
        creator: token.creator,  // If available
        createdAt: token.created_timestamp,
      });
      
      // Immediately evaluate for system picks
      await evaluateTokenForSystemPicks(token);
    }
  }
}, 30_000);  // Every 30 seconds
```

**Cost**: ~1 call per 30s = 2,880 calls/day (safe if limit is 100+ req/min)

### Phase 2: Track Bonding Curve Progress

```typescript
// Poll bonding curve tokens to track progress toward graduation
setInterval(async () => {
  const trackingTokens = await getBondingCurveTokens();
  
  for (const token of trackingTokens) {
    const details = await fetch(
      `https://frontend-api.pump.fun/coin/${token.mint}`
    );
    
    const progress = details.data.coin.bonding_curve_progress;
    
    // Update: bonding curve progress, market cap, price
    await updateTokenProgress(token.mint, {
      bondingCurveProgress: progress,
      usdMarketCap: details.data.coin.market_cap,
      price: details.data.coin.price,
      virtualLiquidity: details.data.coin.virtual_sol_reserves,
    });
    
    // If approaching graduation (>95%), prepare for Raydium pool detection
    if (progress > 95) {
      flagForGraduationTracking(token.mint);
    }
  }
}, 60_000);  // Every minute
```

**Cost**: ~100 calls per min = 144,000 calls/day (need to verify if this is within pump.fun limits)

### Phase 3: Graduation Detection

When bonding curve progress reaches 100%, watch for Raydium pool creation:

```typescript
// Check if graduated token has Raydium pool yet
setInterval(async () => {
  const graduatingTokens = await getTokensFlaggedForGraduation();
  
  for (const token of graduatingTokens) {
    // Check DexScreener for Raydium pool
    const poolData = await dexscreener.getTokenPools(token.mint);
    
    if (poolData.length > 0) {
      // Graduated! Update tracking
      await markTokenAsGraduated({
        mint: token.mint,
        raydiumPool: poolData[0].address,
        graduatedAt: Date.now(),
      });
      
      // Immediately re-evaluate with new pool data
      await evaluateTokenPostGraduation(token.mint);
    }
  }
}, 30_000);  // Every 30 seconds for graduating tokens
```

---

## Full Token Lifecycle Tracking

```
T=0: Token created on pump.fun
     ↓ Poll pump.fun /coins endpoint every 30 seconds
T=0-30s: Detected (if high enough ranking)
     ↓ Register for bonding curve monitoring
T=0-4h: Bonding curve phase
     ↓ Poll /coin/{mint} every minute for progress
     ↓ Evaluate for system picks every 5 minutes
T=4h: Approaching graduation (>95% progress)
     ↓ Flag for graduation tracking
     ↓ Poll DexScreener every 30 seconds for Raydium pool
T=4h+: Graduation detected
     ↓ Update token with Raydium pool address
     ↓ Re-evaluate with post-grad metrics
T=4h+: Post-grad phase
     ↓ Switch to Raydium price monitoring
     ↓ Use learned post-grad fingerprints
```

---

## API Cost Analysis (With Bonding Curve)

```
Current (Raydium only):
  - DexScreener: ~2 calls/min
  - GeckoTerminal: 0.5 calls/min
  - Total: ~2.5 req/min

With Bonding Curve Support:
  - pump.fun new tokens: 1 call/30s = 2 calls/min
  - pump.fun progress: ~100 calls/min (need to verify limit)
  - DexScreener: ~2 calls/min
  - Total: ~104 req/min

Question: What is pump.fun API rate limit?
```

---

## Rate Limit Discovery Needed

Need to determine:
1. **pump.fun /coins endpoint limit** (trending/new)
2. **pump.fun /coin/{mint} endpoint limit** (details)
3. **PumpPortal endpoint limits** (batch trending, creator stats)
4. **Whether batch requests are actually supported** (e.g., can we do /coins?mints=mint1,mint2,mint3)

**Assumption**: pump.fun APIs are permissive since they're free frontend APIs. Probably 100+ req/min per endpoint.

---

## Implementation Strategy

### Conservative (Proven Safe)
```
Poll pump.fun /coins every 30 seconds: 2 calls/min
Poll pump.fun /coin/{mint} details every 5 minutes: ~20 calls/min
Total: ~22 req/min (safe)

Latency: 
  - New token detection: 0-30 seconds
  - Graduation detection: 0-30 seconds
```

### Aggressive (Higher Coverage)
```
Poll pump.fun /coins every 10 seconds: 6 calls/min
Poll pump.fun /coin/{mint} details every 1 minute: ~100 calls/min
Total: ~106 req/min (need verification)

Latency:
  - New token detection: 0-10 seconds
  - Real-time bonding curve tracking
```

---

## Benefits of Bonding Curve Support

```
✓ Access tokens 4 hours BEFORE Raydium graduation
✓ Catch best entry prices (lowest market caps)
✓ Track creator reputation through bonding curves
✓ Detect pump patterns pre-graduation
✓ Pre-compute conviction scores before graduation
✓ Execute system picks immediately on Raydium graduation
✗ Requires learning pre-grad fingerprints (separate from post-grad)
```

---

## Recommendation

1. **Verify pump.fun API rate limits** (critical unknown)
2. **Start conservative**: Poll /coins every 30s, /coin/{mint} every 5min
3. **Add bonding curve token tracking to system**
4. **Learn pre-grad fingerprints separately** from post-grad
5. **Trigger system picks on graduation detection**

If pump.fun rates allow, can be much more aggressive with polling frequency.

---

## Questions for Implementation

1. What is pump.fun /coins endpoint rate limit?
2. What is pump.fun /coin/{mint} endpoint rate limit?
3. Does pump.fun support batch endpoints (comma-separated mints)?
4. Should we track ALL bonding curve tokens or filter by engagement/velocity?
5. How much pre-grad data is useful for predicting post-grad outcomes?
