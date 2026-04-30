# Token Lifecycle Architecture: Bonding Curve → Graduation → Raydium

## Overview

The Penny-Pincher2 system now supports tracking tokens through their complete lifecycle, from launch on pump.fun through bonding curve graduation to Raydium pools. This document describes the architecture and integration points.

## Token Lifecycle Phases

### Phase 0: Bonding Curve (0-4 hours on pump.fun)

**When**: Token first created on pump.fun
**Where**: `pumpfun-bonding-curve.ts`
**Tracking**: Polling pump.fun /coins and /coin/{mint} APIs

```
Pump.fun Bonding Curve:
├─ Time: T=0 to T=4h
├─ Price: Starts at $0, rises as bonding curve fills
├─ Buyers: Early adopters, community members
├─ Tracking: Progress 0% → 100%
└─ Key Metrics: Bonding velocity, buyer growth, holder concentration
```

**Implementation**:
1. Poll `/coins` endpoint every 60 seconds for new tokens
2. Register discovered tokens to `tokenDataPool` with `isPumpfun=true`
3. Track progress via `/coin/{mint}` every 5 minutes
4. Emit `pumpfun_bonding_curve` discovery event for system picks evaluation
5. Collect pre-grad metrics for fingerprint learning

**API Endpoints**:
- `GET /api/pumpfun/bonding-curve/tracked` - Current tracked tokens
- `GET /api/pumpfun/bonding-curve/stats` - Monitoring statistics
- `GET /api/pumpfun/bonding-curve/force-check` - Manual poll

**Rate Limits**:
- Bonding curve checks: 2 requests/minute (safe)
- Progress tracking: 20 requests/minute for ~100 tracked tokens (safe)
- Total: ~22 req/min (pump.fun appears to allow 100+ req/min)

### Phase 1: Graduation Detection (at 100% progress)

**When**: Token reaches 100% bonding curve progress
**Where**: `graduation-tracker.ts`
**Tracking**: Polls DexScreener for Raydium pool creation

```
Graduation Event:
├─ Trigger: Bonding curve progress >= 100%
├─ Detection: Query DexScreener for Raydium pool address
├─ Action: Link token to Raydium pool, record migration time
└─ Output: graduationEvents table + pumpfun_graduated event
```

**Implementation**:
1. Graduation tracker polls for tokens with `pumpfunGraduated=false` and recent `pumpfunGraduationTime`
2. Query DexScreener API for Raydium pools matching the mint
3. When pool found:
   - Update `tokenDataPool`: Set `raydiumPoolAddress`, `poolOriginType=pumpfun_graduated`
   - Create `graduationEvents` record with timing and liquidity info
   - Emit `pumpfun_graduated` event (urgency=85)
4. Start post-grad phase monitoring

**Key Data**:
- Time to graduation (seconds from launch)
- Starting liquidity on Raydium
- Raydium pool address
- Creator reputation (for post-grad analysis)

### Phase 2: Raydium Pool Tracking (post-graduation)

**When**: After successful graduation, indefinitely
**Where**: `raydium-pool-discovery.ts`, `raydium-pool-quality.ts`
**Tracking**: New pool discovery + quality scoring

```
Raydium Post-Grad:
├─ Time: T=4h+ indefinitely
├─ Pool: Created by pump.fun graduation mechanism
├─ Trading: Real Raydium swaps, market dynamics
├─ Monitoring: Price, volume, liquidity, holders
└─ Exit: System picks evaluate for entry/exit
```

**Pool Quality Scoring** (0-100):
- **Liquidity** (0-25 pts): USD liquidity in pool
- **Holder Distribution** (0-25 pts): Concentration analysis, top holder %
- **Creator Reputation** (0-25 pts): Creator's historical track record
- **Pool Age** (0-25 pts): Optimal window ~2 hours old

**Implementation**:
1. GeckoTerminal new_pools endpoint polled every 120s
2. New pools discovered → stored in `raydiumPoolDiscoveries`
3. Quality scoring runs on new pools
4. Associated tokens linked to `tokenDataPool` if not direct Raydium launches

## Learning Pipeline

### Pre-Graduation Fingerprints (Bonding Curve Phase)

Learned patterns **before** graduation, stored with `fingerprintType: "pregrad_bonding_curve"`

**Metrics**:
- Entry slippage (typical 0.5-2% for bonding curve buys)
- Optimal stop loss threshold based on volatility
- Hold time characteristics (early exit, hold for launch, etc.)
- Win rate and median multiplier for early buyers

**Learning Algorithm**:
```
For each graduated token:
  1. Collect bonding curve metrics (velocity, buyer growth, concentration)
  2. Calculate entry slippage from bonding curve characteristics
  3. Estimate optimal SL based on outcome performance
  4. Create fingerprints per cluster (spike_and_bleed, slow_moon, etc.)
  5. Store with confidence score based on sample size
```

**Used by**: System picks when evaluating tokens still on bonding curve

### Post-Graduation Fingerprints (Raydium Phase)

Learned patterns **after** graduation, stored with `fingerprintType: "postgrad_raydium"`

**Metrics**:
- Entry slippage on Raydium (typically 0.5-5% depending on liquidity)
- Stop loss performance (higher volatility = higher hit rate)
- Trailing stop loss curve (adjusts with token maturity/multiplier)
- Hold duration, peak timing, volume acceleration

**Learning Algorithm**:
```
For each graduated token (>30 min post-grad):
  1. Collect Raydium phase metrics (volume acceleration, price slope, holder growth)
  2. Analyze win rates and multiplier distribution
  3. Calculate optimal TSL curve based on token maturity
  4. Create fingerprints per cluster
  5. Store with confidence adjusted for time since graduation
```

**Used by**: System picks when evaluating tokens on Raydium post-graduation

## System Picks Integration

### Conviction Scoring for Bonding Curve Tokens

When a bonding curve token is discovered, system picks immediately evaluates:

```
Conviction Score:
├─ Cluster Match (40%): How well does this token match known patterns?
├─ Creator Reputation (35%): Creator's historical success rate
├─ Wallet Signals (25%): High-quality whales buying?
└─ Final Conviction: Weighted average
```

**Entry Decision**:
```
if conviction >= cluster_threshold:
  1. Fetch fresh Jupiter quote
  2. Validate entry price hasn't slipped >10%
  3. Open paper position with learned pre-grad parameters
```

### Pre-Grad Entry Parameters (from learned fingerprints)

When entering bonding curve token:
- Entry slippage target: Use learned average + 1 std dev
- Stop loss: Use learned optimal threshold for cluster
- Take profit tiers: Cluster-specific (spike_and_bleed: 2x/4x/5x/10x)
- Hold time expectation: Cluster-specific (~30 min pre-grad)

### Post-Grad Entry Parameters (from learned fingerprints)

When entering same token on Raydium:
- Entry slippage target: Use learned Raydium slippage + buffer
- Stop loss: Use learned post-grad optimal (typically higher)
- Take profit tiers: Adjust based on post-grad performance
- TSL curve: Use learned curve adjusted for current multiplier

## Discovering Non-Pump.fun Tokens

Tokens launched **directly** on Raydium (no bonding curve):

```
Direct Raydium Launches:
├─ Source: Created directly as Raydium pool (no pump.fun)
├─ Discovery: GeckoTerminal new_pools endpoint
├─ Pool Quality: Evaluated for holder concentration, liquidity
├─ Learning: Post-grad fingerprints only (no pre-grad data)
└─ Entry: System picks evaluates with reduced confidence
```

**Process**:
1. New pool discovered via GeckoTermian → stored in `raydiumPoolDiscoveries`
2. Quality score computed
3. If `associatedTokenMint` identified → link to `tokenDataPool`
4. Emit `raydium_new_pool` discovery event
5. System picks evaluates if quality score high enough

## Database Schema

### Core Tables

**tokenDataPool** (extended with graduation fields):
```sql
-- Pump.fun tracking
isPumpfun: boolean
pumpfunGraduated: boolean
pumpfunGraduationTime: integer
pumpfunBondingCurveProgress: real  -- 0-100%
pumpfunAgeAtGraduation: integer

-- Raydium tracking
raydiumPoolAddress: string
raydiumPoolDiscoveredAt: integer
raydiumLiquidityUsd: real
raydiumCreatorAddress: string
raydiumCreatorReputation: real
raydiumTopHolderCount: integer
raydiumHolderConcentration: real  -- % held by top 10
isDirectRaydiumLaunch: boolean
poolOriginType: enum  -- "pumpfun_graduated" | "direct_raydium" | "other_dex"
```

**graduationEvents**:
```sql
tokenMint: string (unique)
graduationTime: integer
sourcePoolAddress: string
destinationPoolAddress: string
timeToGraduation: integer  -- seconds from creation
liquidityOnGraduation: real
priceOnGraduation: real
learningExported: boolean
```

**raydiumPoolDiscoveries**:
```sql
poolAddress: string (unique)
baseTokenMint: string
quoteTokenMint: string
discoveredAt: integer
sourceType: enum  -- "rpc_scan" | "webhook" | "event_detected"
liquidityUsd: real
associatedTokenMint: string
isVerified: boolean
qualityScore: real  -- 0-100
```

**tokenFingerprints**:
```sql
fingerprintType: enum  -- "pregrad_bonding_curve" | "postgrad_raydium"
clusterId: string
tokenMint: string

-- Performance metrics
winRate: real
medianMultiplier: real
sampleCount: integer

-- Entry/exit parameters
entrySlippageAvg: real
entrySlippageP95: real
slHitRate: real
slThresholdPercent: real

-- TSL curve (for Raydium post-grad)
tslCurveStartMultiplier: real
tslCurveEndMultiplier: real
tslCurveHoldMinutes: integer

-- Confidence
confidence: real  -- 0-1
```

**tokenOutcomes** (with lifecycle metrics):
```sql
-- Pre-grad bonding curve metrics
bondingVelocity: real  -- % per hour
bondingBuyerGrowthRate: real  -- new buyers per hour
bondingEarlyBuyerConcentration: real

-- Post-grad Raydium metrics
raydiumVolumeAcceleration: real
raydiumPriceSlope: real
raydiumHolderGrowth: real

-- Lifecycle
isPlayedOut: boolean
playedOutReason: string
```

## Event Flow

### Complete Workflow Example: New Token Launch

```
T=0:00 - Token created on pump.fun
  ↓
T=0:01 - pumpfun-bonding-curve polls /coins, discovers token
         ├─ Register in tokenDataPool: isPumpfun=true, progress=0%
         ├─ Emit pumpfun_bonding_curve event
         ├─ System picks evaluates conviction
         └─ If conviction high: open paper position
  ↓
T=0:05 to T=4:00 - Track bonding curve progress
         ├─ Poll /coin/{mint} every 5 minutes
         ├─ Update pumpfunBondingCurveProgress
         ├─ Collect pre-grad metrics (velocity, buyer growth)
         └─ Monitor position (if open)
  ↓
T=4:00 - Token reaches 100% bonding curve progress
  ↓
T=4:01 - graduation-tracker detects graduation
         ├─ Find Raydium pool address via DexScreener
         ├─ Create graduationEvents record
         ├─ Update tokenDataPool: raydiumPoolAddress, poolOriginType
         ├─ Emit pumpfun_graduated event
         └─ System picks might re-evaluate for Raydium entry
  ↓
T=4:05 - raydium-pool-discovery detects new pool (if not found yet)
         ├─ Create raydiumPoolDiscoveries record
         ├─ Score pool quality
         ├─ Link to tokenDataPool
         └─ Emit raydium_new_pool event
  ↓
T=4:30 onwards - Token lifecycle learning
         ├─ Collect pre-grad metrics from bonding curve phase
         ├─ Collect post-grad metrics from Raydium phase (>30 min)
         ├─ Create/update fingerprints per cluster
         ├─ Store confidence scores
         └─ Used by future tokens matching same pattern
```

## Integration Points

### With Existing Systems

1. **System Picks V2** (`system-picks-v2.ts`):
   - Queries tokenDataPool for bonding curve tokens
   - Uses pre-grad fingerprints for conviction scoring
   - Uses post-grad fingerprints for graduated token evaluation

2. **Retrolearner V2** (`retrolearner-v2.ts`):
   - Discovers outcome clusters from token results
   - Provides cluster matching for conviction calculation
   - Integrates with lifecycle learning

3. **Discovery Event Bus** (`discovery-event-bus.ts`):
   - Receives: `pumpfun_bonding_curve`, `pumpfun_graduated`, `raydium_new_pool` events
   - Routes to system picks and retrolearner for evaluation

4. **Exit Strategies** (`exit-strategies.ts`):
   - Uses cluster-specific parameters
   - Adjusted based on token lifecycle phase
   - Pre-grad vs post-grad tiers differ

5. **Paper Trading** (`paper-trading.ts`):
   - Opens positions on discovered tokens
   - Tracks entry/exit per lifecycle phase
   - Collects outcome data for learning

## Configuration & Tuning

### Conservative (Safe) Settings (Current)

```typescript
// Bonding curve discovery
newTokensCheckInterval: 60000      // 60s (2 req/min)
progressCheckInterval: 300000       // 5 min (20 req/min for ~100 tokens)
minBondingCurveAge: 30              // Only track >30s old
minMarketCapForTracking: 1000       // Ignore <$1k tokens

// Graduation detection
graduationPollInterval: 60000       // 60s polling
graduationProgressThreshold: 99     // Start looking at 99%

// Learning
learningCycleInterval: 6h           // Every 6 hours
minSamplesForFingerprint: 10        // 10+ samples to learn
minConfidenceScore: 0.3             // 30% min confidence
```

### Aggressive (More Coverage)

```typescript
// Faster polling, higher API usage
newTokensCheckInterval: 30000       // 30s (4 req/min)
progressCheckInterval: 60000        // 1 min (100+ req/min for 100 tokens)

// Requires verification that pump.fun API allows
// Could increase up to 100+ req/min based on API characteristics
```

## Rate Limit Analysis

### Pump.fun API (Frontend Free API)

- **Endpoint**: `https://frontend-api.pump.fun`
- **Limit**: Appears to be permissive (likely 100+ req/min)
- **Current Usage**: 22 req/min (conservative)
- **Safety Margin**: 80%+ headroom

### DexScreener API

- **Endpoint**: `https://api.dexscreener.com`
- **Limit**: 300 req/min per IP
- **Current Usage**: <5 req/min for graduation detection
- **Safety Margin**: 98%+ headroom

### GeckoTerminal API

- **Endpoint**: `https://api.geckoterminal.com`
- **Limit**: ~30 req/min free tier
- **Current Usage**: 0.5 req/min (one call every 120s)
- **Safety Margin**: 98%+ headroom

## Testing

Integration tests in `test-graduation-pools.ts`:
- **Test 0**: Bonding curve discovery and tracking
- **Test 1**: Graduation event creation and pool linking
- **Test 2**: Pool discovery and quality scoring
- **Test 3**: Fingerprint learning from outcomes
- **Test 4**: System picks integration
- **End-to-End**: Full pipeline validation

Run with: `npm run test:graduation`

## Future Enhancements

1. **Direct Raydium Launch Detection**: Identify tokens created directly on Raydium (no bonding curve history)
2. **Pre-Launch Detection**: Monitor pump.fun activity before official launch
3. **Creator Clustering**: Link fresh wallets to proven creators
4. **Multi-Pool Tokens**: Handle tokens on multiple DEXes simultaneously
5. **Graduated Token Resurfacing**: Track tokens that re-enter trading after quiet periods
6. **Bonding Curve Velocity Signals**: Use bonding velocity as trading signal
7. **Batch Graduation Processing**: Handle multiple graduations in single cycle

## Summary

The token lifecycle architecture enables:

✅ **Early Entry**: Catch tokens from T=0 on bonding curve (4 hours before Raydium)
✅ **Seamless Tracking**: Single mint tracked through all lifecycle phases
✅ **Pattern Learning**: Separate fingerprints for pre-grad and post-grad phases
✅ **Intelligent Execution**: Use learned patterns for entry/exit parameters
✅ **Complete Coverage**: Bonding curve + Raydium + direct Raydium launches
✅ **Low Cost**: Free APIs only, ~22 req/min with 80% safety headroom
✅ **Flexible**: Conservative defaults, tunable for more aggressive discovery
