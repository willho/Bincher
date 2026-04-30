# Penny-Pincher2 Complete Architecture (Phase 1)

> Document Last Updated: April 28, 2026

## Executive Summary

Penny-Pincher2 is a real-time token discovery and analysis system for Solana that detects promising tokens early in their lifecycle and extracts patterns for ML-driven learning.

**Core Principle**: Immutable fingerprints cluster (not fluid tokens). Pattern discovery happens at the fingerprint/cluster level, with multi-token validation.

## System Overview

```
REAL-TIME SUBSCRIPTIONS (WebSocket)
  ↓
DISCOVERY + SCORING (ANN Model)
  ↓
MONITORING (Dynamic Duration via ANN)
  ↓
GRADUATION DETECTION (Pump SDK)
  ↓
POST-GRAD MONITORING (DexPaprika SSE)
  ↓
RETROLEARNER (4-hour Cycle)
  ↓
[PATTERN LEARNING] → ANN Improvement
```

## Architecture Components

### 1. Cache Coherence System (NEW - cache-coordinator.ts)

**Problem**: Replit has 1 concurrent read/write, causing memory-DB disconnects

**Solution**: Multi-instance cache coordination via DB log table

**Components**:
- `cache-coordinator.ts`: Manages invalidation signals, startup recovery, external write polling
- `cacheInvalidationLog` table: Logs all invalidations for multi-instance discovery
- Integration in `memory-cache.ts`: startupRecovery(), pollForExternalInvalidations(), registerWrite()

**Key Features**:
- Startup recovery: Detect crash gap by comparing last flush vs current time
- Write registration: Track when each token was flushed to DB
- External invalidation polling: Detect writes from other processes (every 30s)
- Listener pattern: Local broadcast of cache invalidation signals
- No additional API quota: Uses existing DB logging

### 2. Storage-Bucketing System (NEW - T0/T1/T2 Lifecycle)

**Problem**: Unclear distinction between token snapshots at different lifecycle stages

**Solution**: Explicit milestone snapshots (immutable T0 → T1 → T2)

**New Tables**:

#### tokenMilestoneSnapshots
- T0 (creation): First 30 seconds
- T1 (early dynamics): 30s - 10 minutes
- T2 (mid-phase): 10-30 minutes
- Tracks: Market state, trading activity, holder data at each milestone

#### fingerprintSnapshotReference
- Links immutable fingerprints to T0 milestone snapshots
- Fingerprint locked at creation (isImmutable=true, frozenAt=timestamp)
- Multi-milestone support for validation (T0→T1, T0→T2 features)

#### walletFingerprintDiscovery
- Tracks which wallets discovered at each fingerprint
- Stores: Trade counts, hold duration, outcome metrics
- Enables: Wallet trajectory analysis across multiple tokens

#### fingerprintLifecycleMetrics
- Aggregated success metrics per fingerprint cluster
- Outcome distribution: earlyWinRate, sustainableRate, peakMultiplier stats
- Wallet-level metrics: Early buyer success rates, confidence scores
- Updated by retrolearner every 4 hours

**Key Insight**: Fingerprints cluster (immutable), tokens don't (fluid outcomes). Patterns discovered from fingerprint clusters validate across multiple tokens.

### 3. Token Success ANN (token-success-ann.ts)

**Purpose**: Predict which early dynamics (T0→T1) predict token success

**Model**:
- Input: 26 early dynamics features
  - Price dynamics: OHLCV, slope, volatility
  - Volume: Total, acceleration, first-minute, first-5-minute
  - Whale patterns: Entry count, timing, clustering
  - Holder distribution: Concentration, diversity
  - Buyer metrics: Volume/count, entry spread
  - Creator signals: Success rate, lock %
  - Launch timing: Hour of day, day of week
  
- Architecture: 26 → Dense[128, ReLU, Dropout(0.2)] → Dense[64, ReLU, Dropout(0.2)] → Dense[1, Sigmoid]
- Output: Success probability [0.0, 1.0]

**Training**:
- Called by retrolearner every 4 hours
- Uses: tokenOutcomes table (7-day lookback)
- Label: success = peakMultiplier > 2x
- Exported: Model weights + feature normalizer (mean/std)

**Prediction**:
- Used by discovery-engine at T+5min
- Score drives monitoring duration:
  - High (>0.70): 30min baseline
  - Medium (0.50-0.70): 10min baseline
  - Low (<0.50): 5min baseline

### 4. Pump SDK Graduation Monitor (NEW - graduation-monitor.ts)

**Problem**: DexScreener polling is slow (60+ second delay) and costs API quota

**Solution**: Pump SDK reads BondingCurve PDA directly (instant, no quota)

**Components**:
- `initializeGraduationMonitor(connection)`: Initialize SDK at startup
- `startMonitoringToken(mint)`: Begin monitoring when token discovered
  - Baseline: Check every 10 seconds
  - At 95%+: Increase to 1-second checks
  - At 100% (graduated): Trigger handler, stop monitoring
- `stopMonitoringToken(mint)`: Cleanup when graduated or monitoring expires

**Key Features**:
- `getBondingCurveProgress(mint)`: Returns 0-100% via SDK
- `isTokenGraduated(mint)`: Returns boolean from SDK
- Per-token frequency adjustment (no global polling)
- No API quota impact (RPC-only)
- Deterministic: isGraduated flag is source of truth

**Integration**: discovery-engine calls `startMonitoringToken()` when token discovered

### 5. Graduation Handler (graduation-tracker.ts)

**Purpose**: Process tokens when graduation detected

**Flow**:
1. Pump SDK detects isGraduated=true
2. Calls `handleGraduation(mint)`
3. Queries DexScreener for PumpSwap pool address
4. Updates tokenDataPool: pumpfunGraduated, raydiumPoolAddress, etc.
5. Creates graduationEvents record
6. Emits pumpfun_graduated event
7. Hands off to post-grad monitoring

### 6. DexPaprika Post-Grad Manager (dexpaprika-post-grad-manager.ts)

**Purpose**: Monitor trades on post-grad pools (Raydium/Orca)

**Features**:
- SSE subscriptions to post-grad tokens
- Batch monitoring (100 tokens per request)
- Rotation every 5 minutes (keep top performers)
- Trade capture and analysis

### 7. Retrolearner (server/retrolearner.ts)

**Purpose**: 4-hour cycle that discovers patterns and trains ANN

**Cycle**:
1. Analyze tokens graduated in last 4 hours
2. Train ANN on historical outcomes
3. Detect slow-grower patterns (profitable trades on missed tokens)
4. Extract wallets from successful tokens
5. Update wallet discovery table
6. Log pattern insights

**Training Loop**:
```
retrolearner.ts runs every 4 hours:
  → tokenSuccessANN.trainOnHistoricalOutcomes(lookbackDays=7)
    → Fetch tokens with outcomes from tokenOutcomes table
    → Extract 26 features for each token
    → Train: 26 features → [128, 64] → 1 output
    → Compute accuracy, loss
    → Save model weights + normalizer
  → Detect slow-growers
    → Find tokens system missed but wallets profited
    → Extract early dynamics features
    → Store in slowGrowerPatterns
  → Update fingerprintLifecycleMetrics
    → Aggregate success rates per fingerprint cluster
    → Calculate confidence scores
```

## Data Flow: Token Lifecycle

### T=0 (Discovery)
```
PumpPortal subscribeNewToken
  ↓ (message: {mint, name, symbol, ...})
discovery-engine.discoveryNewTokens()
  ↓
tokenMilestoneSnapshots: INSERT T0 snapshot
tokenFingerprints: CREATE with T0 reference
  ↓
graduation-monitor.startMonitoringToken(mint)
  ↓ (Pump SDK check: 10s interval)
```

### T=0 to T=10min (Early Dynamics)
```
PumpPortal subscribeTokenTrade
  ↓ (for subscribed mints)
memory-cache.setToken()
  ↓
priceHistoryCache: Aggregated 1-min candles
swaps: Individual trade records
  ↓
tokenMilestoneSnapshots: INSERT T1 snapshot at T=10min
```

### T=5min (ANN Scoring)
```
discovery-engine notices T0→T1 complete
  ↓
tokenSuccessANN.predictTokenSuccess(mint)
  ↓ (26 features extracted from T0-T1 data)
Score: 0.0-1.0
  ↓
Set monitoring duration:
  if score > 0.70: monitor 30 min
  else if score > 0.50: monitor 10 min
  else: monitor 5 min
```

### T=5-100min (Graduation Detection)
```
graduation-monitor.startMonitoringToken(mint)
  ↓ (every 10s: getBondingCurveProgress)
Progress increases: 0% → 50% → 95% → 100%
  ↓ (at 95%+: increase to 1s checks)
SDK detects: isGraduated = true
  ↓
graduation-tracker.handleGraduation(mint)
  ↓
Update tokenDataPool: raydiumPoolAddress, pumpfunGraduated
  ↓
Emit: pumpfun_graduated event
  ↓
dexpaprika-post-grad-manager: START SSE subscription
```

### T=graduated onwards (Post-Grad Monitoring)
```
DexPaprika SSE stream trades on PumpSwap pool
  ↓
memory-cache: Update token price, volume
  ↓
Track: Whale exits, profit-taking, price action
```

### T=every 4h (Retrolearner Cycle)
```
retrolearner.ts:performRetrolearningCycle()
  ↓
1. Fetch tokens graduated 0-4h ago
2. Get tokenOutcomes for tokens in pool
3. For each token:
   - Extract 26 features from T0-T1 snapshot
   - Outcome label: success (2x+) vs failure
   ↓
tokenSuccessANN.trainOnHistoricalOutcomes()
  ↓
Train model on accumulated outcomes
Save weights + normalizer
Report: Loss, accuracy, samples used
  ↓
detectSlowGrowerPatterns()
  ↓
Find wallets with profitable trades system missed
Extract those tokens' early features
Store slow-grower patterns
  ↓
Update fingerprintLifecycleMetrics
  ↓
Continue loop
```

## Rate Limiting & Quotas

### Per-Instance (Penny-Pincher2 + 3 proxies)

| API | Type | Limit | Budget | Action |
|-----|------|-------|--------|--------|
| Chainstack RPC | Monthly | 1M credits | 950K (5% buffer) | Hard stop at 95% |
| Helius RPC | Monthly | 1M credits | 950K (5% buffer) | Hard stop at 95% |
| DexPaprika Polling | Per-minute | 200 req/min | 85% utilization | Token bucket |
| DexPaprika SSE | Per-minute | 200 req/min | 85% utilization | Token bucket |
| DexScreener | Per-minute | 300 req/min | 20% utilization | Token bucket |
| PumpPortal WebSocket | Per-second | 200 msg/sec | 50% utilization | Circuit breaker |
| Shyft HTTP RPC | Monthly | Unlimited | None | Unlimited |
| Shyft gRPC | Connections | 1 stream (free) | 1 active | Exclusive |

### No Quota Impact
- Pump SDK graduation checks (uses RPC quota only)
- Cache coordinator DB logging (internal)
- Retrolearner ANN training (in-memory)
- Memory cache operations (in-memory)

## Key Innovation: Immutable Fingerprints

**Constraint**: Token outcomes are fluid (can exit early, can hold, can peak then dump)
**Solution**: Fingerprint at T0, outcomes append to same fingerprint

**Semantics**:
- One fingerprint per T0 state (creation snapshot)
- Same fingerprint can appear across multiple tokens
- When multiple tokens have same fingerprint → strong validation signal
- Pattern learning happens at fingerprint level, not token level

**Example**:
```
Token A (mint_A):
  ├─ T0 Snapshot: {price=0.00001, whales=3, holders=50, ...}
  ├─ Fingerprint: {vector=[...50 dims...]}
  └─ Outcome: peaked at 50x, duration 2 hours

Token B (mint_B):
  ├─ T0 Snapshot: {price=0.00001, whales=3, holders=50, ...}
  ├─ Fingerprint: {vector=[...same 50 dims...]}  ← Same fingerprint
  └─ Outcome: peaked at 45x, duration 2.1 hours

Discovery:
  "Fingerprint with early whale entries → 50x+ success rate (2/2 samples)"
  This pattern is now learned and can predict future tokens with same T0 signature
```

## Testing Strategy

### Unit Tests
- `tokenSuccessANN.extractFeatures()`: Feature extraction correctness
- `tokenSuccessANN.trainOnHistoricalOutcomes()`: Training convergence
- `graduation-monitor.getBondingCurveProgress()`: SDK integration
- `cache-coordinator.startupRecovery()`: Crash recovery logic

### Integration Tests
- **Token Lifecycle**: Mint → Monitor → Graduate → Post-Grad
- **ANN Scoring**: Prediction accuracy on holdout test set
- **Graduation Detection**: SDK detection speed (should be <1s at 95%+)
- **Retrolearner Cycle**: Full 4-hour cycle with pattern learning

### Load Tests
- **Concurrent Monitoring**: 500 tokens simultaneously
- **Memory Cache**: 10K tokens in cache, flush performance
- **API Rate Limits**: Burst requests, token bucket behavior

## Deployment Checklist

- [ ] Database migrations applied (schema for milestone snapshots, etc.)
- [ ] Pump SDK initialized with Solana connection
- [ ] Cache coordinator polling interval set (30s)
- [ ] Retrolearner scheduled (every 4 hours)
- [ ] ANN model file location configured (./models/token-success-ann.json)
- [ ] DexScreener API rate limiter configured (300 req/min)
- [ ] PumpPortal WebSocket subscription limits set (200 msg/sec)
- [ ] Monitoring duration thresholds tuned per deployment
- [ ] Alerting configured for rate limit breaches

## Future Enhancements

### Phase 2
- [ ] Wallet cluster detection (coordinate trades across addresses)
- [ ] Funding relationship discovery (where did early traders get money)
- [ ] Creator reputation system (track success rate by token creator)
- [ ] Multi-milestone ANN (extend from 26 to 50+ features across T0→T2)

### Phase 3
- [ ] Autotrading system (execute positions based on ANN score)
- [ ] Risk management (position sizing, stop losses)
- [ ] Portfolio rebalancing (profit-taking signals)
- [ ] Community insights (aggregate winner patterns across users)

## References

- Cache coherence: `/server/cache-coordinator.ts`
- Storage bucketing: `/shared/schema.ts` (tokenMilestoneSnapshots, etc.)
- Token ANN: `/server/token-success-ann.ts`
- Pump SDK monitor: `/server/graduation-monitor.ts`
- Graduation handler: `/server/graduation-tracker.ts`
- Retrolearner: `/server/retrolearner.ts`
