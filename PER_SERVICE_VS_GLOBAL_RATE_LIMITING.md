# Per-Service vs Global Rate Limiting: Architecture Decision

## What Old System Actually Used

### RPC Providers (from rpc-provider.ts)
```typescript
const RpcProviders = ["chainstack", "quicknode", "helius"];

// Helius preferred for token metadata operations
// Chainstack/QuickNode as fallback
// Each has daily limits tracked via budget-manager
```

### API Services (from api-budget.ts)
```typescript
const RATE_LIMITS = {
  jupiter:       { perMinute: 10 },      // 0.167 req/sec
  dexscreener:   { perMinute: 300 },     // 5 req/sec
  geckoterminal: { perMinute: 30 },      // 0.5 req/sec
  helius:        { perMinute: 600 },     // 10 req/sec (webhook/API, not RPC)
};
```

**Helius served TWO purposes**:
1. RPC provider (token metadata, blockchain queries, daily limits)
2. Webhook service (unified swap monitoring, monthly usage limits)

---

## Per-Service vs Global Rate Limiting

**User's correct point**: Per-service limits are fine if each service respects its own strictest constraint.

### Per-Service Approach (Current, Better)

```typescript
// Each service enforces its own limit via shouldAllowApiCall()

// Jupiter: Never exceed 10 req/min
if (!await shouldAllowApiCall("jupiter")) {
  return;  // Back off, don't call
}
const quote = await jupiter.getQuote(...);
await trackApiCall("jupiter", 1);

// DexScreener: Never exceed 300 req/min  
if (!await shouldAllowApiCall("dexscreener")) {
  return;
}
const prices = await dexscreener.batch(...);
await trackApiCall("dexscreener", 1);
```

**Advantage**: Each service runs at its own ceiling, no artificial throttling.

### Why Global Limiter is Unnecessary

If per-service limits are working correctly:
- Jupiter won't exceed 10 req/min (self-limited)
- DexScreener won't exceed 300 req/min (self-limited)
- System throughput naturally respects the strictest (Jupiter)

**No need for global flat rate** — per-service is more efficient.

---

## Alchemy: Monthly Limits & Unpredictability

**You're right to be cautious.**

Alchemy characteristics:
- Websocket: Event-driven (unpredictable usage spikes)
- Monthly limits: Hard caps, easy to exceed
- Different cost model than per-minute APIs

```
Traditional APIs:
  - Per-minute: Predictable, throttleable
  - Can control exactly when calls happen

Alchemy websocket:
  - Per-block: ~400ms intervals, automatic
  - Every block consumes usage (unpredictable volume)
  - Monthly cap = fixed cost ceiling
```

**Example problem**:
- Alchemy free tier: 300M compute units/month
- 1 block subscription = ~1000 units/hour
- 150 blocks/hour × 24 hours = 3,600 blocks/day
- 3,600 × 30 days = 108,000 blocks/month
- Compute cost: 108M units/month ≈ 36% of monthly budget

If system processes each block (price check, exit validation):
- Could easily exceed monthly limit in high-activity periods

---

## Recommendation: Keep Helius, Reconsider Alchemy

### Current: Helius only
```
Helius provides:
✓ RPC provider (token metadata, daily limits)
✓ Webhook service (unified swap monitoring, monthly limits)
✓ Already paid for (~$10-20/month)
✓ Predictable cost model
✓ Good for real-time webhooks on known events
```

### Proposed: Add Alchemy for websocket
```
Problem:
✗ Unpredictable per-block consumption
✗ Could exceed monthly budget in spikes
✗ Websocket is "always on" (can't throttle)
✗ Additional cost on top of Helius

Better alternative:
Use on-chain Raydium price reading (free)
instead of Alchemy websocket for exit monitoring
```

---

## Architecture Without Alchemy

### For Exit Monitoring (Real-Time)

Instead of Alchemy websocket:

```typescript
// Option 1: On-chain Raydium prices (FREE)
async function getExitCheckInterval() {
  // Check exits every 5-10 seconds via polling
  // Use on-chain Raydium pool state (no API cost)
  
  const poolState = await connection.getAccountInfo(raydiumPoolAddress);
  const price = parseRaydiumPrice(poolState);
  
  checkPositionExits(position, price);  // Free, real-time
}

// Option 2: DexScreener batch (if on-chain is complex)
async function getExitCheckWithAPI() {
  // Check exits every 30 seconds
  // Use DexScreener batch (300 req/min, safe)
  
  const prices = await getBatchTokenPrices(mints);
  checkPositionExits(positions, prices);
}
```

### For Pool Discovery (Real-Time)

Use Helius webhook (already integrated):

```typescript
// Helius webhook on token creation
app.post("/api/webhook/helius", async (req, res) => {
  const { transaction } = req.body;
  
  if (isTokenCreation(transaction)) {
    const newToken = extractTokenFromTx(transaction);
    registerTokenForMonitoring(newToken);
  }
});
```

### For Price Monitoring (Periodic)

Use DexScreener batch (already implemented):

```typescript
// Every 5 minutes: Check all open positions
async function checkPricesAndReclaim() {
  const positions = await getOpenPositions();
  const mints = [...new Set(positions.map(p => p.tokenMint))];
  
  const prices = await getBatchTokenPrices(mints);  // 1 API call
  
  for (const position of positions) {
    checkPositionExits(position, prices.get(position.tokenMint));
  }
}
```

---

## Per-Service Rate Limits (Sufficient)

```typescript
const RATE_LIMITS = {
  // API services: per-minute enforced
  jupiter:       { perMinute: 10 },      // Self-limits to 0.167 req/sec
  dexscreener:   { perMinute: 300 },     // Self-limits to 5 req/sec
  geckoterminal: { perMinute: 30 },      // Self-limits to 0.5 req/sec
  
  // RPC providers: daily limits enforced
  helius:        { dailyCap: 1_000_000 } // Monthly quota
  quicknode:     { dailyCap: unlimited }
  chainstack:    { dailyCap: unlimited }
};

// No global throttler needed
// Each service self-regulates via shouldAllowApiCall()
```

**Result**: 
- Jupiter (strictest) sets effective system ceiling at 0.167 req/sec
- Other services run freely within their limits
- No artificial blocking or queueing

---

## Why This Works Better

### Alchemy Websocket Problems
1. **Unpredictable**: Each block triggers usage, can't control frequency
2. **Monthly ceiling**: Hard cap, easy to hit in spike periods
3. **All-or-nothing**: Can't selectively reduce websocket consumption
4. **Cost**: Additional expense on top of Helius

### On-Chain Alternative Advantages
1. **Predictable**: You control polling frequency
2. **Free**: RPC read, no API cost
3. **Scalable**: Can check more frequently without cost
4. **Simple**: No new API to manage

### DexScreener Batch Advantages
1. **Safe**: 300 req/min = 10x headroom vs Jupiter
2. **Proven**: Already in old system, works well
3. **Simple**: API call, get results, move on
4. **Transparent**: Per-call cost known in advance

---

## Conclusion

**Stick with per-service rate limiting** (what old system did):

```
✓ Keep Helius (RPC + webhook, already paid)
✓ Use DexScreener batch (prices, 300 req/min safe)
✓ Use on-chain Raydium (exits, free)
✓ Jupiter only for execution (10 req/min strict limit)

✗ Don't add Alchemy websocket (unpredictable monthly cost)
✗ Don't use global throttler (per-service is simpler)
```

Each service's `shouldAllowApiCall()` handles its own limit. System naturally respects Jupiter's 10 req/min as the bottleneck. Done.
