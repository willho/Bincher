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

## Other Backlog Items

(To be added as they're identified)
