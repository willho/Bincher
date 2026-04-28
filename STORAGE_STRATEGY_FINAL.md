# Final Storage Strategy: 320-370 GB/Month (From 900 GB)

## The Insight

**Fingerprints ARE the trades** - they're the aggregated summary. Once calculated, raw trades are redundant data.

```
Raw Trades          Fingerprints (Aggregated)
├─ 500 trades       ├─ [OHLCV, volume, whales, diversity, ...]
├─ price per tx     │  (single 50-dim vector per snapshot)
├─ timestamp        ├─ Multiple snapshots over token lifetime
└─ wallet           └─ Compressed/clustered over time

Use raw trades to:
✓ Calculate fingerprint snapshots (once per milestone/time interval)
✗ Trading decisions (use fingerprints instead)
✗ Pattern matching (use fingerprints instead)
✗ Retrolearner (uses outcomes + fingerprints, not trades)
```

## Storage Breakdown

### What to Keep

**1. Raw Token Trades (SHORT RETENTION)**
```
Purpose: Calculate fingerprints
Retention: 1 day only (auto-deleted)
Volume: ~1,400 tokens/day × 500 trades × 100B = 70 GB/day
Kept in: rawTokenTrades table
Deleted via: cleanupOldTrades(maxAgeDays=1) job
```

**2. Token Fingerprints (LONG RETENTION)**
```
Purpose: Trading decisions, pattern matching
Retention: 30 days (granular) + archived (clustered)
Volume: 
  ├─ Recent (0-7d granular): 100 GB
  ├─ Medium (7-30d granular + clusters): 100 GB
  └─ Old (30+ compressed): 50 GB
Total: ~250 GB
Kept in: tokenFingerprints + tokenFingerprintClusters tables
```

**3. Metadata (PERMANENT)**
```
Purpose: Retrolearner training, trading decisions
Kept:
  ├─ creatorReputation (per creator)
  ├─ retrolearnerThresholds (per condition type)
  ├─ tokenOutcomes (per graduated token)
  └─ tokenFingerprintClusters (per cluster)
Total: ~20-50 GB
```

**4. Raw Trades (Optional Archive)**
```
Purpose: Audit trail / compliance (if needed)
Retention: Move to archive before deletion
Volume: Grows slowly (old trades appended, never updated)
Cost: Only if compliance required
Implementation: archiveOldTrades(maxAgeDays=7) before deletion
```

## Storage Trajectory

```
MONTH 1
├─ Raw trades collected: 18M trades × 100B = 1.8 TB
├─ Fingerprints calculated: ~250 GB
├─ Cleanup job deletes 1-day-old trades
└─ Net: 250 GB kept (trades deleted daily)

MONTH 2+
├─ Incoming trades: 70 GB/day, deleted after 1 day
├─ Fingerprints grow: +200 GB (30 new days worth)
├─ Compression kicks in: Old fingerprints → clusters
└─ Net: 250-370 GB steady state

STEADY STATE
├─ 0-1 day: Raw trades (70 GB) → Auto-deleted
├─ 0-7 days: Granular fingerprints (100 GB)
├─ 7-30 days: Granular + cluster hybrids (100 GB)
├─ 30+ days: Cluster centroids only (50 GB)
└─ TOTAL: ~320-370 GB/month CAPPED
```

## Implementation

### 1. Capture Trades
```typescript
// From PumpPortal WebSocket
const trade = {
  tokenMint: "...",
  signature: "...", // Unique, prevents duplicates
  walletAddress: "...",
  amountSol: 0.5,
  amountTokens: 1000,
  direction: "buy",
  price: 0.0005,
  timestamp: Date.now() / 1000,
};

await db.insert(rawTokenTrades).values(trade);
```

### 2. Calculate Fingerprints (Every 5-10 seconds per token)
```typescript
// Aggregate trades since last snapshot
const trades = await db
  .select()
  .from(rawTokenTrades)
  .where(
    and(
      eq(rawTokenTrades.tokenMint, mint),
      gte(rawTokenTrades.createdAt, lastSnapshotTime)
    )
  );

// Calculate metrics from trades
const metrics = calculateMetrics(trades);

// Create fingerprint snapshot
await db.insert(tokenFingerprints).values({
  tokenMint: mint,
  snapshotTrigger: "time_1min",
  fingerprintVector: metrics.vector,
  // ... other fields
});
```

### 3. Cleanup Old Trades (Every night at 3 AM)
```typescript
// Delete trades older than 1 day
const cleanup = await cleanupOldTrades(maxAgeDays=1);
console.log(`Deleted ${cleanup.deletedCount} trades, freed ${cleanup.storageCleaned}`);

// Monitor table health
const stats = await getTradeTableStats();
console.log(`Oldest trade: ${stats.oldestTradeAgeHours}h old`);
console.log(`Estimated size: ${stats.estimatedSizeGB} GB`);
```

## Storage Savings Math

### Scenario: 50 tokens/hour average

```
Input: 50 tokens/hour × 24h × 30 days = 36,000 tokens/month
Trades: 36,000 × 500 avg trades = 18,000,000 trades/month

KEEPING ALL TRADES:
├─ Raw trades: 18M × 100B = 1.8 TB
├─ Fingerprints: 250 GB
└─ Total: 2.05 TB/month ❌

KEEPING TRADES 1 DAY ONLY:
├─ Raw trades: 40M × 100B = 70 GB (rolling, deleted daily)
├─ Fingerprints: 250 GB
└─ Total: 320 GB/month ✅

SAVINGS: 1.73 TB/month (85% reduction!)
```

## What Fingerprints Capture

Each fingerprint snapshot captures (as 50-dim vector):
```
Price dynamics:
  ├─ OHLCV (open, high, low, close, volume)
  ├─ Volatility / momentum
  └─ Price range

Volume & liquidity:
  ├─ Total volume in window
  ├─ Buy vs sell ratio
  └─ Volume velocity (acceleration)

Holder patterns:
  ├─ Number of unique traders
  ├─ Concentration (Herfindahl index)
  ├─ Trader diversity
  └─ New buyer rate

Whale signals:
  ├─ Whale entries (1 SOL, 5 SOL, 10 SOL)
  ├─ Whale timing
  └─ Whale concentration
```

Everything needed for trading decisions is captured in these 50 dimensions. Raw trade logs are just the source data.

## Retention Summary

| What | Keep | Delete | Reason |
|------|------|--------|--------|
| Raw trades | 1 day | After 1 day | Aggregated into fingerprints |
| Fingerprints | 30 days | After compression | Compressed into clusters |
| Clusters | Forever | Never | Historical pattern library |
| Creator reputation | Forever | Never | Used for early buying |
| Thresholds | Forever | Never | Learned from outcomes |
| Outcomes | Forever | Never | Used for retrolearner |

## Final Numbers

```
STORAGE PER MONTH
├─ Fresh data (0-30d): 250 GB
├─ Compressed (30+d): 50 GB
├─ Metadata: 30 GB
├─ Raw trades (1d only): 70 GB (rolling, deleted daily)
└─ TOTAL: 320-370 GB/month STABLE
```

**Compared to:**
- Without cleanup: 900 GB fingerprints + 1.8 TB trades = 2.7 TB/month ❌
- With cleanup: 320-370 GB ✅
- **Savings: 2.33 TB/month**

## Cron Jobs

```
1 AM UTC: Compress old fingerprints
  └─ compressOldFingerprints()

2 AM UTC: Update creator reputation
  └─ updateCreatorReputation()

3 AM UTC: Delete old trades ← NEW
  └─ cleanupOldTrades(maxAgeDays=1)

4 AM UTC: Learn thresholds
  └─ performThresholdLearningCycle()
```

## Risk Mitigation

**What if we need to recalculate fingerprints?**
- Recent tokens (0-1 day): Raw trades still available
- Older tokens: Snapshots exist, recalculation unnecessary
- If absolutely needed: Regenerate from fingerprint metadata (degraded but possible)

**What if we need audit trail?**
- Optional: Archive trades before deletion
- archiveOldTrades(maxAgeDays=7) moves to separate table
- Archive grows slowly, can be compressed separately

**What if trades are needed for debugging?**
- Recent trades (1 day): Always available
- For older trades: Ask "What problem are we solving?" - usually fingerprints suffice

## Bottom Line

✅ **Fingerprints are sufficient** for all trading decisions
✅ **Raw trades are redundant** after aggregation
✅ **Delete safely** with 1-day grace period for recalculation
✅ **Storage caps at 320-370 GB/month** (vs 2.7 TB unbounded)
✅ **Savings: 2.3 TB/month**
