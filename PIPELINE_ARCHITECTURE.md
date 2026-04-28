# Penny-Pincher2 Complete Pipeline Architecture

## Overview: Data Flow from Discovery to Trading

```
Token Discovery (T+0s)
    ↓ [API: PumpPortal WebSocket]
New Token Message → Parse (mint, name, creator, bonding curve state)
    ↓ [DB: INSERT tokenDataPool]
Store Token Metadata
    ↓ [Monitoring: Subscribe to trades]
Subscribe to tokenMint trades via PumpPortal
    ↓ [For next 10 minutes...]
Early Dynamics Collection (T+0 to T+10min)
    ├─ Price: 1-minute candles (OHLCV)
    ├─ Volume: Every trade, aggregated per minute
    ├─ Whale entries: Detect large buys, timing
    ├─ Holder concentration: Top 10 holder %
    ├─ Buyer diversity: Unique buyer count
    ├─ Cluster activity: Coordinated entry patterns
    └─ Bonding curve progress: % filled
    ↓ [At T+10min]
Extract 50 ANN Features from Early Dynamics
    ↓ [Compute: TensorFlow.js inference]
Run ANN Model → Success Probability (0.0-1.0)
    ↓ [Decision based on ANN score + DexScreener trending]
Determine Monitoring Duration
    ├─ High confidence (>0.70) → Monitor 30 minutes
    ├─ Medium (0.50-0.70) → Monitor 10 minutes
    └─ Low (<0.50) → Rotate after 5 minutes
    ↓ [Until graduation or deathbed...]
Ongoing Monitoring (Activity-Gated Snapshots)
    ├─ T+0-10min: Snapshot every 1 minute (if trades occurred)
    ├─ T+10-60min: Snapshot every 10 minutes (if trades occurred)
    ├─ T+60min-24hr: Snapshot hourly (if trades occurred)
    └─ Milestones: At 2x, 5x, 10x, 50x, 100x, 0.5x, 0.1x, every 50 trades
    ↓ [At T+5-100min]
Graduation Detection (via Pump SDK)
    ├─ Poll bonding curve progress every 10s
    ├─ At 95%: Check every 1 second
    └─ At 100%: Migration detected
    ↓ [After graduation]
Post-Grad Monitoring (Raydium/Orca)
    ├─ API: DexPaprika SSE for post-grad trades
    ├─ Alternative: Shyft gRPC (1 stream max)
    └─ Duration: 4-24 hours depending on token performance
    ↓ [Every 6 hours]
Trade Summarization & Compression
    ├─ Group trades by token + 5-min windows
    ├─ Create OHLCV candles
    ├─ INSERT to priceHistoryCache
    └─ DELETE raw trades older than 6 hours
    ↓ [When capacity > 85%]
Auto-Deathbed Low-Volume Tokens
    ├─ Priority 1: Zero-volume tokens
    ├─ Priority 2: Lowest-volume tokens
    └─ Free up WebSocket subscriptions
    ↓ [Every 4 hours]
Retrolearner Cycle
    ├─ Step 0: Trade OHLCV summarization (6-hour window)
    ├─ Step 1: ANN training on historical outcomes
    ├─ Step 2: Slow-grower detection (wallet wins on missed tokens)
    ├─ Step 3: Trajectory backfill (dead tokens get outcome labels)
    ├─ Step 4: Archetype clustering (snapshot → lifecycle stage + outcome)
    └─ Step 5: Wallet discovery (top holders from successful tokens)
    ↓
Complete Pipeline
```

---

## STAGE 1: Token Discovery (T+0s)

### Data Needed
- Mint address
- Token name, symbol
- Creator wallet
- Initial bonding curve state (token supply, SOL reserve)
- Creation timestamp

### API Calls
| API | Call | Cost | Limit | Per Token |
|-----|------|------|-------|-----------|
| **PumpPortal WebSocket** | subscribeNewToken | Message | 200 msg/sec | 1 message (~100 bytes) |
| **Pump SDK** | fetchBondingCurveSummary() | RPC call | Unlimited | 0 (cached) |

### Database Operations
| Operation | Table | Cost | Per Token |
|-----------|-------|------|-----------|
| INSERT | tokenDataPool | 1 write | 1 row |
| SELECT | tokenDataPool | 1 read | (duplicate check) |

### Logging Dimensions
```typescript
interface DiscoveryLog {
  timestamp: number;
  tokenMint: string;
  source: "pumpportal" | "pumpdev" | "dexscreener";
  creator: string;
  initialSupply: number;
  initialSolReserve: number;
  
  // Metadata
  discoveredAt: number;
  bondingCurveProgress: number; // 0-1
}
```

### CPU/RAM
- Message parsing: ~1ms per token
- Memory: ~500 bytes per active token in memory
- Current scale: 500 tokens/day = ~250 KB storage

---

## STAGE 2: Early Dynamics Collection (T+0 to T+10min)

### Data Needed (50 ANN Features)
1. **Price Dynamics (7 features)**
   - priceOpen, priceHigh, priceLow, priceClose
   - volumeTotal, volatility, priceSlope

2. **Volume Trajectory (3 features)**
   - volumeAcceleration
   - volumeInFirstMin, volumeInFirst5Min

3. **Whale Patterns (3 features)**
   - whaleEntryCount, whaleEntryTiming, whaleClusteringScore

4. **Holder Distribution (4 features)**
   - holderCount, holderConcentration, uniqueBuyerCount, buyerDiversityScore

5. **Cluster Activity (3 features)**
   - clusterActivityCount, clusterActivityTiming, clusterCoordinationScore

6. **Discovery Source (3 features)**
   - isPumpFun, isDirectRaydium, isTrendingSource

7. **Bonding Curve (3 features)**
   - bondingCurveProgress, bondingBuyerGrowthRate, bondingVelocity

8. **Technical Metrics (8 features)**
   - priceChangePercent, volumePerBuyer, entriesPerBuyer, spreadBetweenEntries
   - (4 more derived metrics from above)

### API Calls (Per Active Token, First 10 Minutes)
| API | Call | Cost | Frequency | Per Token |
|-----|------|------|-----------|-----------|
| **PumpPortal WebSocket** | subscribeTokenTrade | Message | Every trade | ~10-100 trades total |
| **Chainstack RPC** | getTokenAccounts | 10 credits | Once at T+5min | 1 call |
| **Chainstack RPC** | getTokenLargestAccounts | 10 credits | Once at T+5min | 1 call |
| **Pump SDK** | fetchBondingCurveSummary | RPC call | Every 10 sec | 1 call |

### Database Operations (Per Active Token)
| Operation | Table | Frequency | Cost |
|-----------|-------|-----------|------|
| INSERT | rawTokenTrades | Per trade | 1 write per trade (~50 trades) |
| UPDATE | tokenDataPool | Every 1 min | 10 updates (progress) |
| SELECT | rawTokenTrades | For features | 1 read (~50 rows) |
| SELECT | tokenDataPool | For context | 1 read |

### Logging Dimensions
```typescript
interface EarlyDynamicsLog {
  tokenMint: string;
  timestamp: number; // When sample taken
  
  // Price data (1-minute candles)
  candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  
  // Trade activity
  tradeCount: number;
  uniqueBuyers: number;
  totalVolume: number;
  
  // ANN features extracted
  features: number[]; // 50-dim vector
  featureQuality: {
    dataComplete: boolean;
    minSampleSize: boolean;
    hasOutliers: boolean;
  };
  
  // Whale detection
  whaleEntries: Array<{
    walletAddress: string;
    timestamp: number;
    amountSol: number;
  }>;
  
  // Holder state
  holderCount: number;
  topHolderPercent: number;
}
```

### CPU/RAM
- Per active token in 10-min window:
  - Memory: ~10 KB for trades, ~5 KB for features = 15 KB
  - Calculation: Feature extraction ~100ms, ANN inference ~50ms
  - At 100 active tokens: ~1.5 MB + 15-20ms latency
- Monitoring 500 tokens/day, 10% active at any time = 50 tokens = 750 KB

---

## STAGE 3: ANN Inference & Monitoring Duration (T+10min)

### Compute
```
Input: 50 features (float32 = 200 bytes)
Model: Dense[128] → Dense[128] → Dense[1]
  - Weights: ~(50×128 + 128×128 + 128×1) × 4 bytes = ~101 KB
  - Forward pass: 50 → 128 (6,400 ops) → 128 (16,384 ops) → 1 (128 ops) = ~23K ops
  - Latency: ~10-50ms on laptop, ~5-20ms on server
Output: success_probability (float32 = 4 bytes)
```

### Database Operations
| Operation | Table | Purpose |
|-----------|-------|---------|
| SELECT | tokenOutcomes | Get historical outcomes (for training later) |
| INSERT | tokenSnapshots | Store T+10min snapshot with ANN score |

### Logging Dimensions
```typescript
interface ANNInferenceLog {
  tokenMint: string;
  timestamp: number;
  
  // Input features
  featureVector: number[];
  featureStats: {
    mean: number;
    std: number;
    min: number;
    max: number;
  };
  
  // Model output
  successProbability: number; // 0.0-1.0
  modelVersion: string; // Which trained model used
  
  // Decision
  monitoringDuration: "5min" | "10min" | "30min";
  reasonForDecision: string; // Why this duration
  
  // Performance metadata
  inferenceLatency: number; // ms
  modelLoadTime: number; // ms (if reloaded)
}
```

---

## STAGE 4: Ongoing Monitoring (Activity-Gated Snapshots)

### Data Collected Per Snapshot
- Snapshot ID (unique per token per time)
- Timestamp
- Bonding curve progress (%)
- Current price
- Volume since last snapshot
- Holder count
- Top 10 holder %
- Unique trades since last
- Milestone triggers

### API Calls
| Phase | API | Call | Frequency | Cost Per Token |
|-------|-----|------|-----------|---------|
| **T+0-10min** | PumpPortal WS | subscribeTokenTrade | Every trade | 10-100 messages |
| **T+10-60min** | PumpPortal WS | subscribeTokenTrade | Every trade | 5-50 messages |
| **T+60min-24hr** | PumpPortal WS | subscribeTokenTrade | Every trade | 1-20 messages |
| **Every 10s** | Pump SDK | fetchBondingCurveSummary | Every 10s | RPC call |
| **At milestones** | DexScreener | GET /latest/dex/tokens/{mint} | 2-5 times | API request |

### Database Operations Per Snapshot
| Operation | Table | Cost |
|-----------|-------|------|
| INSERT | tokenFingerprints | 1 write (~5 KB OHLCV data) |
| UPDATE | tokenDataPool | 1 write (progress, multiplier) |
| INSERT | rawTokenTrades | 1 per trade (~100 bytes each) |

### Expected Snapshots Per Token (Lifetime)
```
T+0-10min: 10 snapshots (1 per minute if trades)
T+10-60min: 5 snapshots (1 per 10 min if trades)
T+60min-24hr: 24 snapshots (1 per hour if trades)
Milestones: 5-20 snapshots (price/trade milestones)
Total: 44-54 snapshots per token

At 500 tokens/day:
  - 44 × 500 = 22,000 snapshots/day
  - At 5 KB per snapshot = 110 MB/day to priceHistoryCache
  - Raw trades (assume 50 per token avg) = 500 × 50 = 25,000 trades
  - At 200 bytes per trade = 5 MB/day to rawTokenTrades
```

### Logging Dimensions
```typescript
interface SnapshotLog {
  tokenMint: string;
  snapshotId: string;
  timestamp: number;
  
  // Trigger reason
  trigger: "time_1min" | "time_10min" | "time_1hr" | "milestone_2x" | "milestone_0.5x" | "trade_50";
  triggerReason: string;
  
  // Snapshot data captured
  snapshot: {
    bondingCurveProgress: number;
    currentPrice: number;
    volumeSinceLastSnapshot: number;
    tradesCount: number;
    holderCount: number;
    topHolderPercent: number;
    uniqueBuyers: number;
  };
  
  // Milestone state
  milestoneState: Record<string, boolean>; // {price_2x: true, price_0.5x: false, ...}
  volatilityBufferActive: boolean;
  volatilityBufferReason?: string;
  
  // Performance
  captureLatency: number; // ms
  dataQuality: {
    completeness: number; // 0-1
    staleness: number; // ms since last trade
  };
}
```

---

## STAGE 5: Graduation Detection & Transition

### API Calls
| API | Call | Frequency | Cost |
|-----|------|-----------|------|
| **Pump SDK** | fetchBondingCurveSummary | Every 10s until 95%, then 1s | RPC calls |
| **DexScreener** | GET /latest/dex/tokens/{mint} | Once at 100% | 1 API request |
| **PumpSwap** (or fallback) | Find pool address | Once at graduation | 1-2 API calls |

### Database Operations
| Operation | Table | Purpose |
|-----------|-------|---------|
| UPDATE | tokenDataPool | Mark pumpfunGraduated=true, set raydiumPoolAddress |
| INSERT | tokenFingerprints | Final pre-grad snapshot |
| INSERT | graduationEvents | Record graduation event |

---

## STAGE 6: Post-Grad Monitoring (Raydium/Orca)

### Data Collected
- DEX pool trades (buyer, seller, amount, price)
- OHLCV on post-grad pool
- Whale exits

### API Calls
| API | Call | Frequency | Cost |
|-----|------|-----------|------|
| **DexPaprika SSE** | Stream post-grad tokens | Batch subscribe | POST request per batch |
| **Shyft gRPC** | logsSubscribe (migration program) | 1 concurrent stream | Network messages |

### Database Operations
| Operation | Table | Cost Per Trade |
|-----------|-------|---------|
| INSERT | rawTokenTrades | 1 write (~200 bytes) |
| UPDATE | tokenDataPool | Every 1 min (price update) |

### Expected Volume
```
Assume: 20 post-grad tokens active at any time
Average: 50-500 trades per hour per token = 5-50 trades/sec across all
At 200 bytes per trade = 1-10 MB/hour
Snapshots: 1 per 1-5 min = 288-1440 per day
```

---

## STAGE 7: Trade Summarization (Every 6 Hours)

### Operations
```
1. SELECT all trades from last 6 hours
   - Query cost: 1 read
   - Expected: 25,000-50,000 rows
   - Transfer: 5-10 MB

2. GROUP BY tokenMint + 5-min windows
   - Memory: ~10 MB intermediate data
   - CPU: ~100ms grouping/aggregation

3. Create OHLCV candles
   - Per candle: 8 floats = 32 bytes
   - Expected: 2,000-4,000 candles
   - Total: 64-128 KB

4. INSERT to priceHistoryCache
   - Cost: 2,000-4,000 writes
   - Time: ~500ms-1s

5. DELETE from rawTokenTrades
   - Cost: 25,000-50,000 deletes
   - Time: ~1-2s
```

### Logging Dimensions
```typescript
interface TradesSummarizationLog {
  timestamp: number;
  cycleNumber: number; // Which 6-hour cycle
  
  // Input data
  tradesSelected: number;
  tokensProcessed: number;
  timeWindow: { start: number; end: number };
  
  // Processing
  candlesCreated: number;
  groupingTime: number; // ms
  aggregationTime: number; // ms
  
  // Output
  insertedCandles: number;
  deletedTrades: number;
  storageFreed: number; // bytes
  
  // Performance
  totalDuration: number; // ms
  peakMemory: number; // MB
  cpuUsage: number; // %
  
  // Errors
  errors: Array<{ stage: string; error: string }>;
}
```

---

## STAGE 8: Retrolearner Cycle (Every 4-6 Hours)

### Step 0: Trade Summarization
- See Stage 7

### Step 1: ANN Training
```
Data: 1000-5000 historical tokens with outcomes
Features: 50-dim vectors
Labels: success (>1x) vs failure (<1x)

Computation:
  - Data loading: 1-2s (DB reads)
  - Feature normalization: 100-200ms
  - ANN training: 5-10s (10 epochs, 32 batch size)
  - Model saving: 100-200ms
  - Total: ~10-15s

Memory:
  - Model weights: ~101 KB
  - Training data: 5000 × 200 bytes = 1 MB
  - Gradients/backprop: ~200 KB
  - Total: ~1.5 MB
```

### Step 2: Slow-Grower Detection
```
Query: Wallet trades on tokens system missed
  - SELECT from walletProfitableActivities WHERE profit > 0 AND tokenNotMonitored
  - Cost: 1 full table scan
  - Expected: 100-500 rows

Analysis:
  - Extract early dynamics from snapshots
  - Calculate missed ANN scores
  - Log patterns system didn't catch
  
CPU: ~500ms per wallet
```

### Step 3: Trajectory Backfill
```
Query: Deathbed tokens without outcome labels
  - SELECT from tokenDataPool WHERE isDeathbed=true AND trajectoryOutcome IS NULL
  - Expected: 50-200 tokens
  - Cost: 1 read per token to get snapshots

Processing:
  - max/min/final multiplier from snapshots
  - Determine trajectory shape (pump_100x, crash_fast, etc.)
  - UPDATE tokenDataPool with outcome label
  
Cost: 50-200 writes
```

### Step 4: Archetype Clustering
```
Query: Non-archived token fingerprints
  - SELECT from tokenFingerprints WHERE isArchived=false
  - Expected: 1000-5000 snapshots
  
Processing:
  - Find k nearest neighbor archetypes (k=5)
  - Cluster to nearest archetype by outcome + stage
  - Update archetype centroid and statistics
  
Similarity calculation:
  - 50-dim vectors → cosine similarity
  - Per snapshot: ~100 similarity calcs × 50-dim = 5K ops
  - Total: 5000 snapshots × 5K ops = 25M ops (~100-500ms)
  
Database:
  - SELECT archetype clusters: 1 read (2000-5000 clusters)
  - INSERT fingerprint→cluster mappings: 1000-5000 writes
  - UPDATE cluster statistics: 100-200 updates
```

### Step 5: Wallet Discovery
```
Query: Top performers from each outcome
  - Identify 50-100 successful tokens
  - Extract top 10 early buyers from each
  - Calculate wallet metrics (win rate, avg hold, sharpe)
  
Database:
  - SELECT top wallets: 50-100 queries
  - Assess PnL: 500-1000 trade lookups
  - UPSERT retrolearner_wallet_analysis: 50-100 writes
  
CPU: ~1-2s total
```

### Retrolearner Logging
```typescript
interface RetrolearnerCycleLog {
  cycleNumber: number;
  startTime: number;
  
  // Step 0: Trade summarization
  step0: TradesSummarizationLog;
  
  // Step 1: ANN training
  step1: {
    samplesUsed: number;
    positiveSamples: number;
    negativeSamples: number;
    trainingTime: number; // ms
    validationAccuracy: number;
    lossImprovement: number; // %
    modelSaved: boolean;
  };
  
  // Step 2: Slow-grower detection
  step2: {
    walletsAnalyzed: number;
    slowGrowersFound: number;
    patternsMissedByANN: number;
    topMissedTokens: Array<{
      tokenMint: string;
      walletCount: number;
      avgMultiplier: number;
      annScoreMissed: number;
    }>;
  };
  
  // Step 3: Trajectory backfill
  step3: {
    deathbedTokensProcessed: number;
    outcomesBackfilled: number;
    outcomeDistribution: Record<string, number>; // {pump_100x: 5, crash_fast: 20, ...}
  };
  
  // Step 4: Archetype clustering
  step4: {
    snapshotsAnalyzed: number;
    archetypesCreated: number;
    archetypesUpdated: number;
    avgClusterSize: number;
    clusteringQuality: {
      avgIntraClusterSim: number;
      avgInterClusterDist: number;
    };
  };
  
  // Step 5: Wallet discovery
  step5: {
    tokensAnalyzed: number;
    walletsDiscovered: number;
    topWallets: Array<{
      address: string;
      winRate: number;
      avgMultiplier: number;
      trades: number;
    }>;
  };
  
  // Summary
  totalDuration: number; // ms
  peakMemory: number; // MB
  dbOperations: {
    reads: number;
    writes: number;
    deletes: number;
  };
  errors: Array<{ step: string; error: string }>;
}
```

---

## COMPREHENSIVE LOGGING SYSTEM

### In-Memory Event Window
```typescript
interface LogEvent {
  timestamp: number;
  level: "info" | "warn" | "error" | "metric";
  category: string; // "discovery", "features", "ann", "snapshot", "trades", "retrolearner"
  message: string;
  
  // Metrics
  metrics?: {
    apiCalls?: number;
    dbReads?: number;
    dbWrites?: number;
    cpuMs?: number;
    memoryMb?: number;
    latencyMs?: number;
    cost?: {
      chainstack?: number;
      helius?: number;
      dexPaprika?: number;
    };
  };
  
  // Context
  tokenMint?: string;
  walletAddress?: string;
  snapshotId?: string;
  
  // Tracing
  traceId: string; // Unique per operation
  parentTraceId?: string;
}

// In-memory ring buffer (last 10K events = ~5 MB)
const eventWindow: LogEvent[] = [];
const MAX_EVENTS = 10_000;

// On crash/shutdown: write to database
async function dumpLogsToDatabase() {
  const logsTable = database("system_logs");
  for (const event of eventWindow) {
    await logsTable.insert({
      timestamp: event.timestamp,
      content: JSON.stringify(event),
      level: event.level,
      category: event.category,
    });
  }
}
```

### Logging Points (Every Stage)

**Discovery Stage**
```
✓ Token discovered (source, mint, creator)
✓ Token stored (DB write cost)
✓ Subscription started (PumpPortal connection)
```

**Early Dynamics Stage**
```
✓ Trade received (count, volume, whale status)
✓ Candle aggregated (1-min OHLCV)
✓ Features extracted (50-dim vector, quality check)
✓ ANN inference complete (probability, decision)
```

**Monitoring Stage**
```
✓ Snapshot triggered (reason, data completeness)
✓ Milestone hit (type, volatility buffer status)
✓ Deathbed detected (multiplier, volume)
✓ Monitoring duration decided (ANN score, actual duration)
```

**Graduation Stage**
```
✓ Graduation progress (%, last check, next check)
✓ Graduation detected (timestamp, pool address)
✓ Transition started (final pre-grad snapshot)
```

**Post-Grad Stage**
```
✓ Post-grad subscription active (DexPaprika/Shyft)
✓ Trade received (count, whale exits)
```

**Trade Summarization**
```
✓ Summarization started (time window, trade count)
✓ Candles created (count, storage size)
✓ Raw trades deleted (count, space freed)
✓ Summarization complete (duration, peak memory)
```

**Retrolearner Stage**
```
✓ Cycle started (cycle number, previous cycle timestamp)
✓ Step 0: Trades summarized (covered above)
✓ Step 1: ANN training complete (accuracy, improvement)
✓ Step 2: Slow-growers found (count, patterns)
✓ Step 3: Trajectories backfilled (count, distribution)
✓ Step 4: Archetypes clustered (count, quality metrics)
✓ Step 5: Wallets discovered (count, top performers)
✓ Cycle complete (total duration, peak memory, errors)
```

### Metrics Dashboard (Real-Time)
```typescript
interface SystemMetrics {
  // Current state
  activeTokens: number;
  activeSnapshots: number;
  monitoringCapacityPercent: number;
  
  // API Usage (current hour)
  apiCalls: {
    pumpPortal: number; // messages
    pumpSdk: number; // calls
    dexPaprika: number; // requests
    chainstack: number; // calls
    helius: number; // calls
  };
  apiLimits: {
    pumpPortal: number; // 200/sec
    dexPaprika: number; // 200/min
    chainstack: number; // 2500/day
    helius: number; // 30000/day
  };
  
  // Database Usage (last hour)
  dbWrites: number;
  dbReads: number;
  dbDeletes: number;
  
  // Performance
  avgLatencies: {
    featureExtraction: number; // ms
    annInference: number; // ms
    dbWrite: number; // ms
    apiCall: number; // ms
  };
  
  // Memory/CPU
  memoryUsage: number; // MB
  cpuUsagePercent: number;
  peakMemoryMb: number; // Last 1 hour
  peakCpuPercent: number; // Last 1 hour
  
  // Errors (last hour)
  errorCount: number;
  errorsByCategory: Record<string, number>;
  lastError: {
    timestamp: number;
    message: string;
    category: string;
  };
  
  // Retrolearner
  lastRetrolearnerCycle: {
    timestamp: number;
    duration: number; // ms
    status: "complete" | "running" | "failed";
  };
}
```

---

## API COST TRACKING

### Daily Budget Summary
```
PumpPortal WebSocket (200 msg/sec)
  - Newtoken subscriptions: ~500 tokens/day = ~500 messages
  - Trade subscriptions: ~500 active tokens × 100 trades = 50K messages
  - Account subscriptions: Varies
  - Total: ~50K+ messages (well under 17.3M/day limit) ✓

DexPaprika (200 req/min)
  - Batch enrichment: 10 req/day for trending
  - Post-grad monitoring: 5 req/day per 10 post-grad tokens
  - Total: ~50+ requests/day (well under 288K/day limit) ✓

DexScreener (20 req/min conservative)
  - Token enrichment: 2 per 500 tokens = 1 req/day
  - Trending checks: ~5 req/day
  - Total: ~6 requests/day (well under 28.8K/day limit) ✓

Chainstack RPC (2500 calls/day)
  - Holder detection: 2 calls per 500 tokens = 0.002 calls/day
  - Fallback for PnL: Minimal
  - Total: ~2 calls/day (well under 2500 limit) ✓

Shyft RPC (Unlimited HTTP, 1 gRPC stream)
  - HTTP RPC: Unlimited (safe)
  - gRPC: 1 concurrent subscription (rotation as needed)
```

### Per-Token Cost Summary
```
Discovery to Deathbed (Average token):
  - Discovery: 1 PumpPortal message, 1 DB write = $0.00001
  - Early dynamics (10 min): 50 trade messages, 10 DB ops, 1 Chainstack call = $0.0001
  - Monitoring (varies): 1-10 more snapshots, 10-100 trades = $0.0001-0.001
  - Graduation: 1 Pump SDK call, 1 DexScreener req, 1 DB write = $0.00001
  - Post-grad (if applies): 5-50 DexPaprika msgs, 5-50 trades = $0.0001
  - Retrolearner processing: Amortized ~0.00001
  
  Total per token: ~$0.0002-0.002 (varies by trajectory)
```

---

## RESOURCE ALLOCATION

### Minimum Viable Setup
```
CPU: 2 vCPU
  - Token discovery: <1ms per token × 500/day = <500ms/day = negligible
  - Early dynamics: 15-20ms per token × 100 concurrent = ~2 seconds continuous
  - ANN inference: 50ms × 100/hour = ~1ms/sec average
  - Trade processing: 1ms per trade × 100 trades/sec peak = continuous
  - Retrolearner: ~15s every 4 hours = ~0.1% average
  - TOTAL: ~10-20% CPU continuous, spikes to 50% during peaks ✓

Memory: 2 GB
  - Node.js baseline: ~300 MB
  - Active tokens (500): 750 KB
  - Active snapshots in memory: ~10 MB
  - TensorFlow model: ~1 MB (weights) + 100 KB (activations)
  - Event window: ~5 MB (10K events)
  - Trade buffer: ~10 MB (1000 pending trades)
  - TOTAL: ~27 MB average (very safe with 2 GB) ✓

Database:
  - Read capacity: ~100 reads/sec (priceHistoryCache queries)
  - Write capacity: ~50 writes/sec (trades, snapshots)
  - Storage: ~500 MB/month (trades + snapshots combined)
```

### High-Scale Setup
```
CPU: 4 vCPU
  - Handles 2000+ active tokens
  - Retrolearner doesn't block discovery
  
Memory: 4-8 GB
  - Larger event window (50K events = 25 MB)
  - Cache more models/features
  
Database:
  - Read replicas for analytics
  - Separate table for archive (old trades)
```

---

## Next Steps: Implementation

1. **Create logging infrastructure**
   - LogEvent interface
   - Ring buffer (in-memory window)
   - Periodic flush to DB on schedule + on crash
   - Dashboard endpoint to view current metrics

2. **Add logging to every stage**
   - Wrap each major operation
   - Track latencies, costs, errors
   - Aggregate metrics per hour

3. **Create monitoring dashboard**
   - Real-time API usage vs limits
   - Memory/CPU graphs
   - Error tracking and patterns
   - Retrolearner cycle status

4. **Implement cost tracking**
   - Per-API costs
   - Per-token costs
   - Daily budget vs spent
   - Alerts when approaching limits

5. **Verify assumptions**
   - Actual API call counts
   - Actual DB operation counts
   - Memory peak usage
   - CPU usage during peak times
