# Exit Strategy Learning System with Dampening

## Problem: Static Exit Tiers Are Suboptimal

Current implementation has hardcoded exit multipliers per cluster:
```typescript
spike_and_bleed: {
  exitTiers: [
    { multiplier: 2.0, percentage: 25 },  // Guess
    { multiplier: 4.0, percentage: 25 },  // Guess
    { multiplier: 5.0, percentage: 25 },  // Guess
    { multiplier: 10.0, percentage: 25 }, // Guess
  ]
}
```

**Issue**: These are best-guess baselines. Real data shows:
- Some tokens hit 2x 95% of the time (target is too conservative)
- Others rarely reach 5x in real conditions (target is unrealistic)
- Different market conditions require different strategies

## Solution: Learnable Exit Strategies with Dampening

The system continuously refines exit tier multipliers based on **actual position outcomes**, with **dampening** to prevent oscillation.

### How It Works

#### Step 1: Collect Position Data (Paper Trading)
```
Position recorded:
- Entry price: $0.001
- Exit price: $0.0025 (2.5x)
- Exit reason: "scale_out_2x" ← Hit 2x tier
- PnL: +150%

System asks: "Did we reach the 2x target?"
Answer: YES (actually exited at 2.5x)
```

#### Step 2: Learn from Outcomes
```
Cluster: spike_and_bleed
Analyzed 50 positions from last 7 days:

Tier 2x:
  - Hit in 48/50 positions (96% hit rate)
  - Problem: TOO EASY, we're cashing out too early
  - Action: Raise target (e.g., 2.0x → 2.3x)

Tier 4x:
  - Hit in 35/50 positions (70% hit rate)
  - Problem: Hit too often, missing larger moves
  - Action: Raise target (e.g., 4.0x → 4.5x)

Tier 5x:
  - Hit in 20/50 positions (40% hit rate)
  - Problem: Hit too often still
  - Action: Raise target (e.g., 5.0x → 5.5x)

Tier 10x (runner):
  - Hit in 8/50 positions (16% hit rate)
  - Problem: Rare achievement, keep as moonshot
  - Action: Keep at 10.0x
```

#### Step 3: Apply Dampening (Prevent Overreaction)

**Without dampening** (naive learning):
```
Day 1: Hit rates = [96%, 70%, 40%, 16%]
       → Immediately jump to [2.3x, 4.5x, 5.5x, 10.0x]

Day 2: New sample shows different behavior
       → Immediately swing back to [2.1x, 4.2x, 5.1x, 10.0x]

Day 3: Bounces again
       → Thrashing and oscillation, no convergence
```

**With dampening** (momentum-based learning):
```
Baseline 2x tier = 2.0x

Day 1 learning suggests: 2.3x
Dampened new value = 2.0 * 0.85 + 2.3 * 0.15 = 2.045x
(Only 15% of learning, 85% from previous)

Day 2 learning suggests: 2.1x
Current value now: 2.045x
Dampened new value = 2.045 * 0.85 + 2.1 * 0.15 = 2.059x

Day 3 learning suggests: 2.2x
Dampened new value = 2.059 * 0.85 + 2.2 * 0.15 = 2.088x

...slowly converges on optimal value instead of thrashing
```

### Configuration: Dampening Parameters

```typescript
const LEARNING_CONFIG = {
  // Momentum: how much new data influences the average
  exitTierMomentum: 0.15,      // New data = 15%, previous = 85%

  // Minimum samples before dampening applies
  minSamplesForDampening: 20,  // Below 20 samples, use more momentum (faster learning)

  // Outlier protection: ignore extreme results
  outlierThreshold: 3.0,        // Ignore if 3x median PnL

  // Only apply learned strategy if confident enough
  minConfidenceForApplication: 0.65,

  // Maximum change per cycle (prevent wild swings)
  maxMultiplierAdjustmentPercent: 15, // Can't change >15% per cycle
};
```

### Why Dampening Matters

#### Scenario 1: One Lucky Trade
```
Position that 50x (outlier due to whale buy)
Without dampening: Raises all targets toward 50x (breaks strategy)
With dampening: Outlier filtered out, targets stay reasonable
```

#### Scenario 2: Market Regime Change
```
Market becomes more volatile (easier to 2x)
Without dampening: Instantly raises 2x target (might overcompensate)
With dampening: Gradually moves toward new target over 2-3 weeks
More robust to temporary market conditions
```

#### Scenario 3: Sample Size Growth
```
After 10 positions: High momentum (30%), learn fast
After 50 positions: Medium momentum (15%), learn steady
After 500 positions: Low momentum (5%), very conservative
```

**Benefit**: Early in learning cycle, system is responsive. As confidence grows, changes are more conservative (less likely to break what's working).

## Exit Tier Adjustment Logic

```
IF hitRate > 70% (tier too easy):
  RAISE multiplier
  If 96% hit: raise by ~(96%-70%)*0.5 = +13%
  2.0x → 2.26x

IF hitRate < 30% (tier too hard):
  LOWER multiplier
  If 20% hit: lower by ~(100%-20%)*0.15 = -12%
  5.0x → 4.4x

IF 30% <= hitRate <= 70% (just right):
  KEEP multiplier unchanged (Goldilocks zone)
```

## Runner Tier Protection

The final "runner" tier (10x, 20x) is **never optimized**. It stays as-is because:
- Rare by design (catch moonshots, don't expect them)
- Increasing it would reduce hit rate to near zero
- Decreasing it would prevent capturing larger moves
- Keep as fixed aspiration target

## Data Flow: Position → Learning → Optimization

```
1. System Picks Opens Position
   ├─ Entry: $0.001, 1000 tokens
   ├─ Exit tiers: [2x, 4x, 5x, 10x]
   └─ Conviction: 0.72

2. Token Moves, Position Tracking
   ├─ Price: $0.002 → Hit 2x tier
   ├─ Sells 250 tokens (25%), realizes profit
   ├─ Price: $0.004 → Hit 4x tier
   ├─ Sells 250 tokens (25%)
   └─ Position closed at 4x

3. Paper Trading Records Outcome
   ├─ Entry: $0.001
   ├─ Partial exits: [{price: 0.002, pnl: +100%}, {price: 0.004, pnl: +300%}]
   ├─ Exit reason: "scale_out_4x"
   ├─ Cluster: "spike_and_bleed"
   └─ Status: "closed"

4. Every 12 Hours: Learning Job Runs
   ├─ Fetch all closed positions (last 7 days, this cluster)
   ├─ For each tier, compute: hit rate, avg PnL, confidence
   ├─ Apply dampening to current baselines
   ├─ Compare: improvement vs baseline
   └─ Store in exitStrategyLearnings table

5. System Picks Uses Learned Strategy
   ├─ Get cluster strategy for "spike_and_bleed"
   ├─ Check: learned strategy exists & confidence > 65%?
   ├─ YES: Use learned tiers [2.1x, 4.2x, 5.1x, 10.0x]
   ├─ NO: Stick with baseline [2.0x, 4.0x, 5.0x, 10.0x]
   └─ Open position with optimized exits
```

## Implementation Integration

### Current State
- ✓ Paper trading records position outcomes
- ✓ Positions track entry/exit prices
- ✓ exitStrategyLearning.ts module written
- ✓ Schema table created
- ✓ Learning job framework ready

### TODO: Complete Integration
1. Update `paper-trading.ts` to support partial exits (scale-out tiers)
2. Update `system-picks-v2.ts` to call `getOptimizedExitStrategy()` instead of `getExitStrategy()`
3. Hook learning job into server startup (add to index.ts)
4. Add monitoring/dashboards to see learned vs baseline performance

### Validation & Monitoring

Track in real-time:
- Learned vs baseline strategy win rate
- Hit rate per tier (should converge toward 50-70% zone)
- Dampening effectiveness (compare to naive learning)
- Outlier rejection rate (% of data filtered)

Example dashboard output:
```
spike_and_bleed (Confidence: 78%)
  Baseline 2x tier:  [2.0x]  → Learned: 2.15x (+7.5%)
  Hit rate: 82% (target: 60-70%)
  Improvement: +12% vs baseline (42 samples)

slow_moon (Confidence: 45%)
  Still learning (insufficient confidence)
  Using baseline: [1.5x, 2.5x, 3x, 8x]

late_bloomer (Confidence: 92%)
  Baseline:  [3.0x, 5.0x, 8.0x, 15.0x]
  Learned:   [2.8x, 5.2x, 8.8x, 15.0x]
  Improvement: +18% vs baseline (156 samples)
```

## Key Insights

1. **Dampening prevents overtraining** - System learns from signal, not noise
2. **Outlier protection** - Single lucky trades don't break the strategy
3. **Confidence-based adoption** - Only apply learned tiers once they're reliable
4. **Asymptotic convergence** - Momentum decreases as samples grow, preventing overcorrection
5. **Runner tier safety** - Final tier stays fixed to prevent losing moonshot potential

This approach lets the system discover optimal exit strategies **per cluster** while maintaining stability and avoiding the "overfitting to recent data" trap.
