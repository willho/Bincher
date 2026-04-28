# Hierarchical Trade Summarization Strategy

## Core Insight

**Retrolearner learns optimal entry/exit shapes on Day 1.** After that, it only needs summaries (not raw trades) to:
- Track which wallets profited
- Adjust exit strategies on active tokens
- Update outcome data

Raw trades can be deleted after daily summarization, reducing storage from **1.8TB → ~200GB** while keeping all retrolearner data.

---

## Timeline: From Launch to Archive

### Day 0: Token Detected

```
Action: Collect raw trades
Storage: ~50 MB raw trades (fingerprints calculated from these)
Timeline: T+0 to T+24h
Purpose: Fingerprinting + initial retrolearner analysis
```

### Day 1 (T+24h): Retrolearner Learns Shapes

```
Action: Run retrolearner analysis
  ├─ Input: Raw trades + fingerprints
  ├─ Learn: Optimal entry prices, entry timing, exit prices
  ├─ Learn: Token shape patterns (which shapes = winners)
  ├─ Output: Thresholds updated, confidence scores set
  └─ Result: Entry/exit strategy LOCKED IN

Action: Create daily summary
  ├─ Extract: Buy count, sell count, avg prices, wallets
  ├─ Store: DailySummary table (5-10 KB)
  └─ Delete: Raw trades (retrolearner has learned)

Storage freed: 50 MB raw trades → 10 KB summary (98% reduction)
```

### Days 2-7: Active Token Still Trading

```
If token still active (hasn't peaked yet):
  ├─ Store: New trades as daily summaries (NOT raw)
  ├─ Update: Outcome tracking (wallet profits)
  ├─ Run: Retrolearner only adjusts EXIT prices (entry shape learned)
  └─ Storage: 7 daily summaries = ~70 KB total

vs raw trades: Would be 350 GB for the week
```

### Days 7+: Long-Running Tokens

```
If token STILL active (running 2+ weeks):
  ├─ Compress: Daily summaries → Weekly summary
  ├─ Keep: Weekly summaries (not daily)
  ├─ Storage: ~5 KB per week vs ~50 GB raw trades
  └─ Result: Historical archive is tiny

Example: Token runs 30 days
  ├─ Day 1-7: 7 daily summaries (70 KB)
  ├─ Day 8-14: 1 weekly summary (5 KB)
  ├─ Day 15-21: 1 weekly summary (5 KB)
  ├─ Day 22-30: 1 weekly summary (5 KB)
  └─ Total: 85 KB vs 1.5 TB raw trades
```

### On Peak/Graduation: Update & Archive

```
Action: Token reaches peak or graduates
  ├─ Retrolearner: Records final outcome
  ├─ Update: creator_reputation, tokenOutcomes
  ├─ Adjust: Exit prices (if needed) based on new data
  └─ Archive: Daily/weekly summaries moved to cold storage

Storage: Final token data = ~100 KB (summaries + metadata)
```

---

## Daily Summarization Logic

### What Gets Summarized

```typescript
DailySummary = {
  tokenMint,        // Which token
  date,             // YYYY-MM-DD
  buyCount,         // Number of buy trades
  sellCount,        // Number of sell trades
  totalBuyVolume,   // SOL spent buying
  totalSellVolume,  // SOL raised selling
  avgBuyPrice,      // Average entry price
  avgSellPrice,     // Average exit price
  minPrice,         // Lowest price
  maxPrice,         // Highest price
  uniqueWallets,    // How many wallets traded
  holdingWallets,   // How many still hold tokens
  profitableWallets // How many made money
}

Size: ~10 KB per daily summary
```

### When Gets Deleted

**Raw trades deleted after:**
1. Daily summary created ✓
2. Retrolearner has analyzed ✓
3. No need to recalculate fingerprints ✓

**Timeline:**
- T+0 to T+24h: Keep raw trades (fingerprinting window)
- T+24h: Create daily summary, delete raw trades
- T+24h to T+48h: Keep summary only (retrolearner learns on day 2 if needed)
- T+48h+: Keep daily summaries (for historical tracking)

---

## Retrolearner Behavior with Summaries

### Day 1: Full Analysis (Uses Raw Trades)

```
Input: Raw trades for token
Learn:
  ├─ Optimal entry price (learned from historical outcomes)
  ├─ Optimal entry timing (early buyer analysis)
  ├─ Expected hold duration (from successful trades)
  ├─ Exit prices (learned from historical outcomes)
  └─ Token shape pattern (fingerprint clustering)

Output: Entry/exit strategy locked in, thresholds updated
```

### Days 2+: Outcome Tracking (Uses Summaries)

```
Input: Daily summary (not raw trades)
Update:
  ├─ Which wallets are still holding (from holdingWallets)
  ├─ Profitability trend (from profitableWallets)
  ├─ Price range (minPrice, maxPrice)
  └─ Exit strategy (already learned, just monitor)

Result: Retrolearner adjusts ONLY exit prices if token unexpectedly pumps
```

### Key Point: Entry Strategy Immutable After Day 1

```
Day 1: Retrolearner learns "optimal entry = 0.0005 SOL, within first 3 mins"
Day 2+: Can't change this decision
         Only adjusts: "If price reaches 2x, exit this % of position"
         
Implication: Raw trades not needed after Day 1
             Summaries tell us if it's working (wallets profitable) or not
```

---

## Storage Reduction Math

### Single Token Lifecycle

```
Age         Data Type                Storage    vs Raw Trades
─────────────────────────────────────────────────────────────
0-1 day     Raw trades               50 MB      -
1-7 days    Daily summaries (7x)     70 KB      vs 350 GB
8-30 days   Weekly summaries (3x)    15 KB      vs 1.05 TB
30+ days    Monthly archive          5 KB       vs 1.5 TB

Total for 1 month: 90 KB          vs 1.9 TB (21,000x smaller!)
```

### Monthly Scale (100 tokens/hour average)

```
Month intake: 36,000 tokens
Age distribution:
  ├─ 0-1 day (active): 1,400 tokens × 50 MB = 70 GB
  ├─ 1-7 days (graduated some): 9,800 tokens × 70 KB = 686 GB
  ├─ 7-30 days (old summaries): 24,800 tokens × 15 KB = 372 GB
  └─ Archive (minimal): ~50 GB

TOTAL: ~1,178 GB / month

vs naive approach: 1.8 TB raw trades + 250 GB fingerprints = 2.05 TB

Savings: ~880 GB/month (43% reduction)
```

**Wait, that's still high.** Key optimization:

```
Delete old summaries too!
  ├─ Keep raw trades: 1 day
  ├─ Keep daily summaries: 7 days
  ├─ Keep weekly summaries: 30 days
  ├─ Archive very old: compressed

Revised storage:
  ├─ 0-1 day raw: 70 GB
  ├─ 1-7 day summaries: 50 GB
  ├─ 7-30 day summaries: 30 GB
  ├─ Fingerprints (0-30d): 200 GB
  └─ TOTAL: ~350 GB/month (vs 2.05 TB)

Savings: 1.7 TB/month!
Cost at paid tier: 350 GB × $0.15/GB = $52.50/month
```

---

## Implementation Cron Schedule

```
3 AM UTC: Summarize 1-day-old trades
  ├─ For each token with trades from 24h ago
  ├─ Create: daily_summaries record
  ├─ Delete: rawTokenTrades (safe now, summary exists)
  └─ Log: "1,400 tokens processed, 70 GB freed"

2 PM UTC: Weekly compression (optional, if token still active)
  ├─ For tokens 7+ days old with summaries
  ├─ Compress: 7 daily summaries → 1 weekly
  ├─ Delete: Old daily summaries
  └─ Log: "Compressed to weekly, freed 35 GB"

Weekly: Monthly compression (optional, long-running tokens)
  ├─ Compress: 4 weekly summaries → 1 monthly
  ├─ Archive: Old summaries to cold storage
  └─ Log: "Archived old data"

4 AM UTC: Run retrolearner (unchanged)
  ├─ Analyze outcomes using summaries
  ├─ Learn thresholds
  └─ Update exit strategies for active tokens
```

---

## What Retrolearner Can Do with Summaries

✅ **CAN:**
- Track wallet profitability (profitableWallets per day)
- Detect peak conditions (maxPrice rising/falling)
- Update exit strategies (adjust take-profit if price unexpectedly high)
- Calculate hold durations (from timestamps)
- Verify creator reputation (which tokens they launched profited)
- Learn outcome distributions (winners vs losers)

❌ **CANNOT:**
- Recalculate fingerprints (need raw trades) - but don't need to after day 1!
- Perform high-frequency analysis (no tick-by-tick data) - but don't need to!
- Detect exact entry point timing (sub-minute granularity) - but learned on day 1!

---

## Risk Mitigation

### What if we need to recalculate fingerprints?

**Answer:** Only needed in first 24 hours.
- After 24h: Retrolearner has analyzed, fingerprints complete
- Raw trades safe to delete
- If absolutely needed: Can reconstruct approximate fingerprints from daily summaries (degraded fidelity)

### What if we need to audit a wallet's trades?

**Answer:** Summaries provide enough detail for most queries
- Daily summary shows: total buys, sells, wallets, profitability
- Can drill down to specific wallet if needed (keep wallet trade mapping table)
- For forensics: Archive detailed data separately

### What if token behavior changes unexpectedly?

**Answer:** Retrolearner monitors via summaries
- Day 1: Learns optimal entry/exit
- Days 2+: Summary shows price range, profitability
- If unexpected: Retrolearner adjusts exit strategy only
- Entry strategy locked in (was learned from historical data)

---

## Final Storage Estimate

```
MONTHLY STORAGE WITH HIERARCHICAL SUMMARIZATION:

0-1 day:  Raw trades only                    70 GB (deleted daily)
1-7 days: Daily summaries                    50 GB (deleted after 7 days)
7-30 days: Weekly summaries                  30 GB
0-30 days: Fingerprints + metadata          200 GB
30+ days:  Archived (cold storage)           50 GB

TOTAL: ~400 GB/month steady-state

Cost at paid tier: 400 GB × $0.15/GB = $60/month

vs naive approach (keep all trades): 2.05 TB/month ($307/month)
Savings: $247/month + 80% storage reduction
```

---

## Summary: Why This Works

1. ✅ **Retrolearner learns shapes on Day 1** - no need for raw trades after
2. ✅ **Summaries contain all outcome data** - wallet profitability, pricing
3. ✅ **Daily → Weekly → Monthly compression** - hierarchical bucketing
4. ✅ **Storage scales logarithmically** - older data compresses better
5. ✅ **Active tokens still tracked** - summaries updated daily
6. ✅ **Cost predictable** - ~$60/month regardless of scale
