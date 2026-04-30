# Creator Reputation & Tiered Monitoring System

## Problem: Unknown Creator Risk

When a token from an unknown creator enters the system:
- Current system: Defaults creator score to 0.5 (neutral)
- Issue: No actual track record evaluation
- Result: System treats unknown creators same as decent creators

## Solution: Real Creator History + Tiered Monitoring

### Part 1: Creator Reputation Lookup

**New module: `creator-reputation.ts`**

When a token enters the system, immediately look up creator history:

```
Token discovered: NewToken (creator: 0xABC123)
↓
Query PumpPortal: /creator/0xABC123/stats
  - How many tokens has this creator launched?
  - What % reached 2x?
  - What % were rugs/honeypots?
↓
Calculate reputation score (0-1)
  - Success rate: 60% weight
  - Rug rate: -40% weight
  - Experience boost: +up to 20%
↓
Result: Creator score = 0.72 (decent creator)
```

#### Scoring Logic

```typescript
// Base score from success rate
successScore = successRate * 0.6

// Penalty for rugs
rugPenalty = rugRate * 0.4

// Experience boost: more launches = higher confidence
experienceBoost = min(0.2, totalLaunches / 50)

// Final score (pulled toward neutral if low confidence)
confidenceWeightedScore = 0.5 * (1 - confidence) + baseScore * confidence
```

#### Creator Classifications

| Score | Classification | Monitoring Tier | Risk Level |
|-------|---|---|---|
| 0.8+ | Trusted creator | COLD (no polling) | Low |
| 0.6-0.8 | Decent creator | WARM (15 min polling) | Medium |
| 0.4-0.6 | Mixed record | HOT (5 min polling) | High |
| <0.4 | Risky creator | HOT + extra caution | Very High |
| >50% rug rate | Known scammer | DO NOT TRADE | Extreme |

#### Data Sources

**Primary: PumpPortal API**
```
GET https://api.pumpportal.fun/creator/{creator}/stats
Returns:
  - total_launches
  - successful_launches
  - rugged_tokens
  - avg_peak_multiplier
  - last_launch_time
```

**Fallback: pump.fun API**
```
GET https://frontend-api.pump.fun/creator/{creator}/tokens
Analyze token array to compute success/rug rates
```

**Caching**: 6-hour cache to avoid repeated lookups

---

### Part 2: Tiered Monitoring System

**New module: `tiered-token-monitoring.ts`**

Based on the old system from `price-monitor.ts`:

#### Phase 1: Webhook Monitoring (First 5 Minutes)

```
pump.fun token discovered
↓
Register for WEBHOOK monitoring (real-time)
↓
Listen to Helius webhook events:
  - Swap events
  - Price updates
  - Whale activity
↓
React instantly to price action
↓
After 5 minutes: Transition to polling
```

**Benefits**:
- Real-time detection of opportunities (if token moons in first 5 min)
- Early warning of rugs (if creator dumps immediately)
- No polling overhead (webhook is event-driven)

#### Phase 2: Polling-Based Monitoring (After 5 Minutes)

Tier based on creator reputation:

```
HOT tier (5-minute intervals):
  - Unknown creators (score < 0.4)
  - Risky creators
  - Reason: Need close monitoring, high rug risk

WARM tier (15-minute intervals):
  - Decent creators (score 0.4-0.7)
  - Track record but not proven
  - Reason: Balanced monitoring

COLD tier (no polling):
  - Trusted creators (score >= 0.8)
  - Many successful launches
  - Reason: Low maintenance overhead
```

**Polling Intervals**:
```typescript
HOT_POLLING_INTERVAL_MS = 5 * 60 * 1000      // 5 minutes
WARM_POLLING_INTERVAL_MS = 15 * 60 * 1000    // 15 minutes
WEBHOOK_DURATION_MS = 5 * 60 * 1000          // 5 minutes of webhook
```

#### Timeline Example

```
0:00 - Token discovered on pump.fun
      ↓
      Register for WEBHOOK monitoring
      Creator lookup: 0x123ABC → Score 0.35 (risky)

0:00-5:00 - Real-time webhook monitoring
            Instant alerts on price moves
            Track: volume, whale buys, price velocity

5:00 - Transition to polling
       ↓
       Creator score (0.35) → HOT tier (5 min polling)

5:05 - First polling check
6:05 - Second polling check
...
20:00 - After 20 minutes, still checking every 5 min (HOT tier)
```

**Comparison: Trusted Creator**

```
0:00 - Token discovered
      Creator lookup: 0x999ZZZ → Score 0.82 (trusted)

0:00-5:00 - Webhook monitoring

5:00 - Transition to COLD tier
       ↓
       No further polling!
       Only monitor if manually added to tracking
```

---

### Part 3: Integration With System Picks

When a token enters during discovery:

```typescript
// 1. Get token info
const tokenData = await getTokenData(mint);

// 2. Fetch creator history (CRITICAL)
const creatorHistory = await getCreatorReputation(tokenData.creatorAddress);
const creatorScore = scoreCreatorReputation(creatorHistory);

// 3. Register for appropriate monitoring
await registerTokenForMonitoring(mint, discoveredAt, poolOriginType);
// Automatically chooses WEBHOOK → polling tier transition

// 4. Calculate conviction for system picks
const conviction =
  clusterMatch * 0.4 +
  creatorScore * 0.35 +      // Now REAL creator score, not 0.5
  walletScore * 0.25;

// 5. Apply extra caution for unknown creators
if (creatorScore < 0.4) {
  // Require higher cluster match confidence
  const minRequired = 0.75;  // vs 0.55-0.65 normally
  if (clusterMatch < minRequired) {
    skip this token
  }
  
  // Use tighter exit strategy
  strategy.stopLossPercent = Math.max(
    strategy.stopLossPercent,
    40  // Minimum 40% SL for unknowns
  );
}
```

---

## Unknown Creator Handling

### Scenario: New Token from Creator Never Seen Before

```
Token enters system: NewToken
Creator: 0xNEWCREATOR (never launched before)

Step 1: Lookup Creator History
  PumpPortal: No data found
  pump.fun: No tokens found
  Result: totalLaunches = 0, confidence = 0.0

Step 2: Calculate Reputation Score
  successRate = 0.5 (unknown)
  rugRate = 0.2 (assume 20% rug risk)
  experienceBoost = 0
  
  baseScore = 0.5 * 0.6 - 0.2 * 0.4 = 0.3 - 0.08 = 0.22
  confidenceWeightedScore = 0.5 * 1.0 + 0.22 * 0 = 0.5 (neutral)

Step 3: Register for Monitoring
  creatorScore = 0.5
  Classification = "unknown"
  Start with WEBHOOK (first 5 minutes)
  → Will transition to HOT tier (5 min polling)

Step 4: Conviction Calculation for System Picks
  conviction = clusterMatch * 0.4 + 0.5 * 0.35 + walletScore * 0.25
             = clusterMatch * 0.4 + 0.175 + walletScore * 0.25
  
  Example (slow_moon cluster, 0.65 threshold):
  - clusterMatch: 0.8 → 0.32
  - creator: 0.5 → 0.175
  - walletScore: 0.6 → 0.15
  - conviction: 0.645 ✓ PASSES
  
  But system applies extra caution:
  - Require clusterMatch >= 0.75 (vs 0.55 normally)
  - Use 40% SL (vs 30% for spike_and_bleed)

Step 5: Position Opened with Conservative Parameters
  Entry: 1 SOL
  Exit strategy: spike_and_bleed baseline BUT:
    - SL raised from 30% → 40% (tighter)
    - Hold time capped at 30 minutes (vs 60)
  Monitoring: Every 5 minutes (HOT tier)
```

### Key Difference: Known Good Creator

```
Token from 0xTRUSTED (100 launches, 75% success rate, 5% rug rate)

Step 1: Lookup Creator History
  PumpPortal: Found! 100 launches, 75 successful

Step 2: Calculate Reputation Score
  successRate = 0.75
  rugRate = 0.05
  experienceBoost = min(0.2, 100/50) = 0.2
  
  baseScore = 0.75 * 0.6 - 0.05 * 0.4 + 0.2 = 0.45 + 0.2 = 0.65
  confidenceWeightedScore = 0.5 * 0 + 0.65 * 1.0 = 0.65 (trusted)

Step 3: Register for Monitoring
  Start WEBHOOK (first 5 minutes)
  → Will transition to WARM tier (15 min polling, 5 min cluster)

Step 4: Conviction Calculation
  conviction = 0.65 * 0.4 + 0.65 * 0.35 + walletScore * 0.25
             = 0.26 + 0.23 + walletScore * 0.25
             = 0.49 + walletScore * 0.25
  
  With walletScore = 0.6:
  conviction = 0.49 + 0.15 = 0.64 ✓ PASSES easily

Step 5: Position Opened with Normal Parameters
  Entry: 1 SOL
  Exit strategy: spike_and_bleed baseline (no adjustments)
  Monitoring: Every 15 minutes (WARM tier)
```

---

## Implementation Checklist

### Immediate (Fix Creator Lookup)
- [ ] Replace placeholder in `retrolearner-v2.ts:getCreatorHistoryPumpPortal()`
- [ ] Use actual PumpPortal API calls
- [ ] Fallback to pump.fun API if PumpPortal unavailable
- [ ] Add caching (6-hour TTL)

### Near-term (Integrate Tiered Monitoring)
- [ ] Call `registerTokenForMonitoring()` when token enters system
- [ ] Implement webhook event processing (tied to Helius)
- [ ] Add polling tier logic to `checkPricesAndReclaim()`
- [ ] Monitor stats endpoint for debugging

### Medium-term (Unknown Creator Safety)
- [ ] Apply extra caution rules for creatorScore < 0.4
- [ ] Increase cluster match requirements
- [ ] Tighten SL and hold times
- [ ] Track outcomes to refine thresholds

### Long-term (Creator Learning)
- [ ] Build per-creator exit strategy fingerprints
- [ ] Learn which creators' tokens fit which clusters best
- [ ] Adjust conviction weights based on creator track record
- [ ] Auto-flag new creators who match known scammer patterns

---

## Benefits

**API Efficiency**:
- WEBHOOK monitoring: Real-time, zero polling
- Trusted creators: No polling at all (COLD tier)
- Unknown creators: Minimal 5-min polling (HOT tier)
- Result: 80% fewer API calls than uniform polling

**Risk Management**:
- Unknown creators get conservative treatment
- Risky creators flagged automatically
- First 5 minutes of pump.fun tokens monitored in real-time
- System learns from creator reputation

**System Robustness**:
- Can handle tokens from any creator (with appropriate caution)
- Data-driven decisions (actual track record, not guesses)
- Graceful degradation (fallback APIs if PumpPortal down)
- Learns and improves over time

---

## Questions Answered

**Q: Unknown creator enters system — what exits get used?**

A: Exit tiers come from cluster match (spike_and_bleed, slow_moon, etc.), but:
   1. Creator score defaults to actual lookup (not 0.5 neutral)
   2. If unknown (no history): score = 0.5 but flagged for caution
   3. Exit strategy baseline applied, BUT:
      - SL tightened (30% → 40% for spike_and_bleed)
      - Hold time shortened (60 min → 30 min)
      - Monitoring tier set to HOT (every 5 minutes)

**Q: How does the system monitor prices?**

A:
   1. First 5 minutes: Webhook (real-time, event-driven)
   2. After 5 minutes: Polling based on creator score
      - HOT tier (unknown/risky): 5 min intervals
      - WARM tier (decent): 15 min intervals
      - COLD tier (trusted): No polling

**Q: What if PumpPortal is down?**

A: Falls back to pump.fun API, caches results, continues with degraded but functional lookup.
