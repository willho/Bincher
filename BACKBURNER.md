# Backburner Ideas

Low-priority optimizations and nice-to-haves. Worth revisiting when core system is stable and scaling.

---

## Feature Importance-Driven Cluster Splitting

**Status:** Identified, cost/benefit analyzed, deferred  
**Effort:** Medium (1-2 days)  
**Expected ROI:** +5-8% win rate (estimated)  
**Compute Cost:** ~100ms per retraining cycle  
**I/O Cost:** Negligible

### Problem

Current cluster splitting logic:
- Detects when to split (variance > 0.35 or bimodal outcomes)
- But doesn't know *which dimension* to split on
- Results in broad, noisy clusters (40-60% outcome purity)
- Compensated by multi-cluster blending (system blends 3+ clusters per prediction)

### Solution

Extract feature importance from trained ANN:
1. After ANN training, compute first-layer weight importance for all 26 features
2. When cluster split is triggered, use top 3-4 dimensions to stratify tokens
3. Result: Homogeneous clusters (75-85% outcome purity), single-cluster matches

### Example

**Without importance:**
```
Cluster "Early Movers"
  Outcomes: [success: 40%, fail: 60%]
  Action: Blend with 2+ other clusters → 55% prediction
  Decision: Weak signal, 0.5x position size
```

**With importance:**
```
ANN learned: whale_count (0.42), volume_accel (0.38) are most predictive

Split along whale_count:
  - High whale: Cluster "Whale Pumps" [success: 80%]
  - Low whale: Cluster "Early Movers" [success: 20%]

Token with high whale activity → 80% prediction, 1.5x position size
```

### Trade-offs

| Aspect | Cost | Benefit |
|--------|------|---------|
| Compute | +100ms/retraining | N/A |
| I/O | Negligible | Tighter clusters |
| Complexity | +15% code | Better signals |
| **ROI** | **Low** | **Medium** |

### Why Deferred

1. **Multi-cluster blending already mitigates** — even noisy clusters blend to reasonable outcomes
2. **Bigger bottlenecks elsewhere** — token discovery, wallet history, rate limits
3. **Nice-to-have polish** — not blocking live trading validation

### When to Revisit

- After Phase 2 (wallet discovery) is done
- If win rate plateaus despite more data
- If cluster variance remains >0.35 in production
- If you have >1000 clusters (scaling issue)

### Implementation Checklist

- [ ] Extract ANN first-layer weights after training
- [ ] Compute feature importance ranking (gradient-based or raw weights)
- [ ] Implement actual cluster split logic in `fingerprint-cluster-management.ts` (line 924)
- [ ] Split along top importance dimensions
- [ ] Update cluster DB with new stratifications
- [ ] Validate that resulting clusters have <0.35 variance
- [ ] A/B test: noisy clusters vs. smart-split clusters
- [ ] Measure win rate improvement

---

## Moonbag Risk Management for Deathbed Tokens

**Status:** Identified post-Phase A, deferred  
**Effort:** Low (a few hours)  
**Expected ROI:** Prevents -20% to -40% losses on abandoned tokens  
**Triggers:** Phase D retrolearner parameter optimization

### Problem

Moonbag strategy (leave 5-10% on trajectory collapse) assumes retained capital will rebound:
- Works well for most clusters (tokens that "bled out" sometimes recover)
- **Critical failure case:** Tokens matching "deathbed" archetype
- Deathbed signals: >70% probability of crash_fast + slow_bleed + never recovers
- Current system still leaves moonbag, locking capital in tokens that won't recover

### Solution

1. **Query token outcome history** before leaving moonbag
2. **Skip moonbag if**: Sum(crash_fast + slow_bleed + deathbed) > 90% in historical snapshots
3. **Or use smaller moonbag**: Leave 2-3% instead of 7.5% for high-deathbed-probability tokens
4. **Or reinvest moonbag**: Auto-close moonbags older than 72h with no price recovery

### Implementation Notes

- Hook in `position-exit-manager.ts` at `leaveMoonbag()` function
- Query token fingerprints for outcome distributions
- Check if deathbed archetype confidence >70%
- Conditional moonbag size: standard 7.5% for normal exits, 2% for deathbed, 0% for certain crashes
- Add metric: track "avoided moonbag losses" vs. "recovered moonbags" for retrolearner feedback

### When to Revisit

- After Phase D (retrolearner) completes and learns deathbed detection
- If moonbag recovery rate drops below 20% in live trading
- If capital tied in moonbags exceeds 5% of fund

---

## Budget Allocation Optimization Using Historical Outcome Data

**Status:** Identified post-Phase A, deferred  
**Effort:** Medium (1-2 days)  
**Expected ROI:** +15-25% fund utilization, better position sizing  
**Depends on:** Phase D retrolearner, extended outcome tracking

### Problem

Current Phase A budget allocation:
- Uses simple `baseAllocationPerPosition = balance / (expectedPositions × 1.2)`
- Treats all positions equally (every position gets same size)
- Ignores historical success rates per cluster/archetype
- Leaves capital on table when discovery velocity low, wastes when high

### Solution

1. **Segment allocation by cluster type**
   - Clusters with 70%+ win rate: allocate 1.5x base
   - Clusters with 40-70% win rate: allocate 1.0x base
   - Clusters with <40% win rate: allocate 0.5x base

2. **Dynamic allocation based on recent performance**
   - Rolling 50-trade window per cluster
   - If cluster's last 50 trades: +15% avg profit → boost future allocations +25%
   - If cluster's last 50 trades: -5% avg profit → reduce future allocations -25%

3. **Time-of-day allocation optimization**
   - Historical data shows some hours produce better outcomes
   - Allocate 20-30% more capital during peak hours (e.g., USA market open)
   - Reduce allocation 20-30% during low-signal periods (e.g., 2-5am UTC)

4. **Ape budget smart deployment**
   - Instead of fixed weekly reset, tie ape budget to cluster performance
   - High-performing clusters earn proportionally larger ape boosts
   - Low-performing clusters have ape boosts suspended until recovery

### Implementation Notes

- Extend `dayOfWeekAggregates` table to track outcome rates per cluster
- Create `clusterPerformanceHistory` table (win rate, avg multiplier per cluster + time window)
- Update `position-allocator.ts` `calculateAllocation()` to accept cluster type parameter
- Fetch cluster performance from cache, apply multiplier to baseAllocation
- Add retrolearner feedback loop: outcomes update cluster metrics daily

### Metrics to Track

- Allocation efficiency: `totalReturns / totalAllocated` (target >1.5x)
- Capital utilization: % of balance deployed vs. sitting idle
- Per-cluster ROI: returns per cluster type
- Time-of-day ROI: returns by hour of discovery

### When to Revisit

- After Phase D retrolearner Phase 2 (multi-criteria holder ranking) completes
- After 3+ months of live trading with Phase A (to build historical outcome dataset)
- If fund growth plateaus despite more positions
- When analysis shows clear hour/cluster performance disparities (>30% variance)

---

## Initial Reclaiming Strategy for Risk-Free Gains

**Status:** Identified post-Phase A, deferred  
**Effort:** Low (a few hours)  
**Expected ROI:** Psychological win + risk reduction, ~5-10% additional capital freed  
**Triggers:** Position reaches 2x entry price

### Problem

Current strategy:
- Open positions at 0.1 SOL, let them run until TSL or take-profit
- If position doubles, entire stack is "at risk" again if it crashes
- Capital tied up in unrealized gains, can't be redeployed
- Psychologically draining to watch +100% become +20% due to volatility

### Solution

**Initial reclaiming:** Sell partial position when price 2x entry
1. Position opens at 0.1 SOL entry price
2. Price rises to 2x → sell 0.2 SOL worth of tokens (original entry + profit)
3. Remaining tokens ride with trailing stop loss
4. Result: Original capital freed, locked in break-even, profit floats

**Implementation approach:**
- Track `entrySol` (original investment amount)
- On price milestone hit (2.0x, 3.0x, etc.), calculate % to sell
- Execute market sell for `entrySol + buffer` SOL worth
- Leave remainder with normal TSL management
- Record exit as "partial_reclaim" reason

### Example Flow

```
Entry: 0.1 SOL at $0.0001/token = 1000 tokens
Price rises: $0.0002/token
Position value: 0.2 SOL

Reclaim trigger (2x):
- Sell 0.2 SOL worth of tokens at current price
- Get back original 0.1 SOL capital + 0.1 SOL profit
- Keep remaining tokens riding to moonshot or TSL

Final outcome options:
- Token crashes 50%: Lost nothing (initial reclaimed), recovered 0.05 SOL on remainder
- Token moons 10x: Reclaimed 0.1 SOL, remainder now worth 1.8 SOL (10x of what was left)
```

### Cascading Reclaims

Optional: Multiple reclaim levels
- At 2x: Reclaim 100% of initial
- At 3x: Reclaim 50% of profits
- At 5x: Reclaim 75% of profits
- Remainder free-roll at 10x+

### Integration Notes

- Add `partialReclaim()` function to `position-exit-manager.ts`
- Track reclaim events separately from full exits (new `exitReason: "partial_reclaim"`)
- Update UI to show "reclaimed capital" vs. "floating profit" sections
- Calculate capital freed per position for allocation optimization
- Add metric: "capital recovery rate" (% of invested capital returned before final exit)

### Trade-offs

| Aspect | Benefit | Cost |
|--------|---------|------|
| Risk | Locks in gains, frees capital | Leaves potential on table if crashes before reclaim |
| Psychology | Feels like "win" early | Creates exit points (might sell too early) |
| Capital | Frees ~5-10% more to reinvest | Requires market sells (slippage, fees) |
| Complexity | Clear exit logic | More position states to track |

### When to Revisit

- After Phase A proves position reliability (50+ trades)
- If fund plateau hits and capital reallocation needed
- If volatility spikes (higher chance of reaching 2x faster)
- User feedback: "want to reclaim without closing position"

---

## Other Backlog Items

(To be added as they're identified)
