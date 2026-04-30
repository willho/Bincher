# Critical Issues: Fresh Wallets, Batching, Exit Reaction Times

## Issue 1: Fresh Wallets Per Token (Creator Clustering)

**Problem**: Many creators use new wallet addresses for each launch.

```
Creator ABC launches:
  Token 1: createdBy 0xWallet1 (fresh address)
  Token 2: createdBy 0xWallet2 (fresh address)
  Token 3: createdBy 0xWallet3 (fresh address)

Current system: Looks up 0xWallet1, 0xWallet2, 0xWallet3 separately
Result: Each treated as unknown creator (no history) ✗
```

**Solution**: Creator Clustering

Detect when multiple fresh wallets are actually the same creator:

```typescript
interface CreatorCluster {
  clusterId: string;
  walletAddresses: Set<string>;
  commonPatterns: {
    launchInterval: number;      // Time between launches
    liquidityAmount: number;      // Typical liquidity
    initialBuyAmount: number;     // Typical entry amount
    profitTakingPattern?: string; // How they exit
  };
  successRate: number;            // Across all wallets in cluster
  rugRate: number;
  confidence: number;
}

// Detect fresh wallet → existing cluster
async function linkWalletToCreatorCluster(walletAddress: string): Promise<CreatorCluster | null> {
  // Check if this wallet has on-chain patterns matching known clusters
  
  // 1. Get wallet creation time
  const walletAge = await getWalletAge(walletAddress);
  if (walletAge > 7 days) return null;  // Not a fresh wallet
  
  // 2. Check first transaction type
  const firstTx = await getWalletFirstTransaction(walletAddress);
  if (firstTx.type !== "pool_creation") return null;
  
  // 3. Analyze token launch pattern
  const tokens = await getTokensLaunchedByWallet(walletAddress);
  if (tokens.length !== 1) return null;  // First token from this wallet
  
  const token = tokens[0];
  const pattern = {
    launchTime: token.createdAt,
    liquidity: token.initialLiquidity,
    initialBuy: token.firstBuyAmount,
    firstBuyer: token.firstBuyerAddress
  };
  
  // 4. Match against known creator clusters
  const matches = await findSimilarLaunchPatterns(pattern);
  
  // If we find 3+ wallets with identical patterns → likely same creator
  if (matches.length >= 3) {
    return {
      clusterId: `creator_${hashPatterns(matches)}`,
      walletAddresses: new Set(matches.map(m => m.wallet)),
      commonPatterns: pattern,
      successRate: calculateAverageSuccessRate(matches),
      rugRate: calculateAverageRugRate(matches),
      confidence: 0.8  // Pattern-based clustering
    };
  }
  
  return null;
}
```

**Pattern Recognition**:
```
Launch pattern fingerprint:
- Time between token launches (e.g., always 2.5 hours apart)
- Liquidity amount (always around $50k)
- Initial buy size (always 2-3 SOL)
- Profit taking behavior (always sells at 3x)
- Wallet entropy (low, same seed phrase likely)

If we see 3 fresh wallets with IDENTICAL patterns in sequence
→ Cluster them as same creator
→ Aggregate their success/rug history
```

**Integration**:
```typescript
async function getCreatorReputation(walletOrClusterId: string): Promise<CreatorHistory> {
  // First: Check if it's part of a known creator cluster
  const cluster = await linkWalletToCreatorCluster(walletOrClusterId);
  
  if (cluster) {
    // Use cluster history (all wallets combined)
    console.log(`[CreatorRep] Wallet linked to cluster ${cluster.clusterId}`);
    return {
      totalLaunches: cluster.walletAddresses.size,
      successRate: cluster.successRate,
      rugRate: cluster.rugRate,
      confidence: cluster.confidence,
    };
  }
  
  // Fallback: Treat as unknown (cluster will grow over time)
  return {
    totalLaunches: 0,
    successRate: 0.5,
    confidence: 0.0,
  };
}
```

**Benefit**: Over time, even "fresh wallet" creators get identified and tracked.

---

## Issue 2: Batching for Price Polling Efficiency

**Current Issue**: Polling each position separately

```typescript
// Current (inefficient)
for (const position of positions) {
  const price = await getTokenPrice(position.tokenMint);  // 50 separate API calls
}
// Cost: 50 API calls per poll cycle
```

**Solution**: Batch all mints into single API call

```typescript
// Efficient batching
const mints = positions.map(p => p.tokenMint);
const uniqueMints = [...new Set(mints)];  // Remove duplicates

const batchPrices = await getBatchTokenPrices(uniqueMints);
// Cost: 1 API call for up to 100 mints

// Then distribute prices to positions
const priceMap = new Map(batchPrices);
for (const position of positions) {
  const price = priceMap.get(position.tokenMint);
  checkPositionExits(position, price);
}
```

**Implementation in price-monitor.ts**:
```typescript
export async function checkPricesAndReclaim(): Promise<void> {
  const holdingsList = await db.select().from(holdings);
  
  // BATCH: Collect all unique mints
  const uniqueMints = [...new Set(holdingsList.map(h => h.tokenMint))];
  
  // SINGLE API CALL for all prices
  const batchPrices = await getBatchTokenPrices(uniqueMints);
  
  // DISTRIBUTE: Check each position against batch prices
  for (const holding of holdingsList) {
    const priceData = batchPrices.get(holding.tokenMint);
    if (priceData) {
      checkPositionExits(holding, priceData);
    }
  }
}
```

**Cost Reduction**:
```
50 positions (paper trading)
- Without batching: 50 API calls per cycle
- With batching: 1-5 API calls per cycle (batch size ~20 per call)

Result: 10x reduction in API cost
```

**Jupiter Batch Quote API**:
```typescript
// Jupiter supports batch quotes
const quotes = await jupiter.getQuotes({
  quoteRequests: [
    { inputMint: 'Token1', outputMint: 'USDC', amount: 1000000 },
    { inputMint: 'Token2', outputMint: 'USDC', amount: 1000000 },
    // ... up to 50 per batch
  ]
});
```

---

## Issue 3: Exit Execution Reaction Times

**Critical Problem**: System picks need real-time price monitoring for exits.

Current architecture:
```
System picks opens position
↓
price-monitor.ts polls every 30 seconds (PRICE_CHECK_INTERVAL_MS)
↓
Check if SL/TP hit
↓
Close position

ISSUE: 30-second polling delay is too slow for volatile tokens
If token crashes 40% in 5 seconds, we hit SL in 5 sec but don't realize until +25 sec
```

**Requirements**:
- Exit targets (TP multipliers) need <5 second reaction time
- Stop losses need <10 second reaction time
- Current polling: 30-second intervals (too slow)

**Solutions**:

### Option 1: Sub-Second Polling (Simple, Expensive)

```typescript
const EXIT_MONITORING_INTERVAL_MS = 1000;  // 1 second

setInterval(async () => {
  const openPositions = await getOpenPositions();
  const mints = [...new Set(openPositions.map(p => p.tokenMint))];
  
  const prices = await getBatchTokenPrices(mints);  // Batch!
  
  for (const position of openPositions) {
    const price = prices.get(position.tokenMint);
    checkPositionExits(position, price);
  }
}, EXIT_MONITORING_INTERVAL_MS);
```

**Cost**: 
- 50 positions
- Batched into 5 API calls
- Every 1 second = 5 * 60 * 60 = 18,000 calls/hour
- Need provider supporting 5 req/sec sustained

**Providers**:
- Jupiter: 1.67 req/sec free tier (too slow)
- Alchemy: 100 req/sec free tier (sufficient!)
- QuickNode: 300 req/sec free tier (sufficient!)

### Option 2: Websocket Real-Time (Better, Complex)

Use Alchemy's websocket for block-level price updates:

```typescript
// Alchemy websocket subscription
const ws = new WebSocket('wss://sol-mainnet.g.alchemy.com/v2/YOUR_KEY');

ws.on('message', (event) => {
  if (event.type === 'block') {
    // New block produced → get fresh prices
    // Typically 400ms latency (vs 1-30 second polling)
    
    const mints = getOpenPositionMints();
    const prices = await getRaydiumPoolPrices(mints);  // On-chain, free
    
    for (const position of openPositions) {
      checkPositionExits(position, prices[position.tokenMint]);
    }
  }
});
```

**Benefits**:
- ~400ms latency (new block time)
- Real-time updates
- Can use on-chain Raydium prices (free, no API cost)

### Option 3: Hybrid (Recommended)

```typescript
// 1. Websocket for real-time block updates
setupAlchemyWebsocket((blockData) => {
  // ~400ms latency, check all positions
  checkExitsForBlock(blockData);
});

// 2. Fallback polling if websocket drops
setInterval(async () => {
  // Every 5 seconds, poll as backup
  const openPositions = await getOpenPositions();
  const prices = await getBatchTokenPrices([...openPositions.map(p => p.tokenMint)]);
  checkPositionExits(openPositions, prices);
}, 5000);
```

---

## Recommended Architecture

### For Position Exit Monitoring

```typescript
// Real-time exit monitoring
class PositionExitMonitor {
  private ws: WebSocket;
  private fallbackInterval: NodeJS.Timeout;
  
  async start() {
    // Primary: Alchemy websocket
    this.ws = new WebSocket('wss://sol-mainnet.g.alchemy.com/v2/...');
    this.ws.on('message', (event) => {
      if (event.type === 'block') {
        this.checkExitsRealTime();
      }
    });
    
    // Secondary: Fallback polling
    this.fallbackInterval = setInterval(
      () => this.checkExitsFallback(),
      5000  // Every 5 seconds
    );
  }
  
  private async checkExitsRealTime() {
    const positions = await getOpenPositions();
    const mints = [...new Set(positions.map(p => p.tokenMint))];
    
    // Option A: Use on-chain Raydium prices (free)
    const prices = await getRaydiumPoolPrices(mints);
    
    // Option B: Use Jupiter batch quotes
    const prices = await jupiter.getQuotes({
      quoteRequests: mints.map(m => ({
        inputMint: m,
        outputMint: 'USDC...',
        amount: 1000000
      }))
    });
    
    // Check positions immediately
    for (const position of positions) {
      const price = prices[position.tokenMint];
      await checkPositionExits(position, price);
    }
  }
  
  private async checkExitsFallback() {
    // If websocket is down, poll every 5 sec
    // Same as above but less frequently
  }
}
```

### For Pool Discovery

```typescript
// Pool discovery (can be slower, webhook is fine)
// Use DexScreener/Birdeye polling (60-second intervals)
// No need for sub-second here
```

### For Creator Identification

```typescript
// Creator clustering (can be async, background job)
// Run periodically (every hour) to identify fresh wallet clusters
// No API cost blocker
```

---

## Implementation Priority

### Immediate (Exit Reaction Times - Blocking)
1. [ ] Set up Alchemy websocket for block events
2. [ ] Implement real-time exit checking on block
3. [ ] Add fallback polling (every 5 seconds)
4. [ ] Ensure batch pricing (1 call for 50 positions)
5. [ ] Test with live positions

### Near-term (Creator Clustering - High Value)
1. [ ] Analyze fresh wallet patterns
2. [ ] Implement creator clustering logic
3. [ ] Link new wallets to clusters
4. [ ] Track cluster success/rug rates

### Medium-term (Optimization)
1. [ ] On-chain Raydium price reading (free alternative)
2. [ ] Reduce Jupiter API dependency
3. [ ] Implement circuit breaker (switch to on-chain if APIs fail)

---

## Cost Comparison

### Current System
```
- GeckoTerminal: 0.5 req/sec (too tight)
- DexScreener: 0.033 req/sec ✓
- Jupiter: 0.04 req/sec ✓
- Price polling: 30 sec intervals, unbatched (inefficient)

Total: Barely sustainable
```

### Proposed System
```
- Pool discovery: DexScreener (0.033 req/sec) ✓
- Exit monitoring: Alchemy websocket (free block events) ✓
- Price polling: Batched (1-5 calls per cycle) ✓
- Creator clustering: Background async (free) ✓

Total: Highly efficient, real-time, low cost
```

---

## Alchemy vs Helius Comparison

| Feature | Alchemy | Helius | Cost |
|---------|---------|--------|------|
| Websocket support | ✓ (100 req/sec) | ✓ | Free tier |
| Block events | ✓ Real-time | ✓ | Included |
| Rate limits | 100 req/sec free | Paid | Helius more expensive |
| Token API | No | Yes | Helius better |
| RPC performance | Good | Better | Helius optimized |

**Recommendation**: Use **Alchemy for exit monitoring** (websocket, high rate limit), keep Helius for what it's best at.

Actually: Can we use **BOTH**? 
- Alchemy websocket for real-time block events
- Helius for token creation detection (webhook)
- DexScreener for pool discovery
- Raydium on-chain for free prices

Result: Best-of-breed architecture, no single point of failure.
