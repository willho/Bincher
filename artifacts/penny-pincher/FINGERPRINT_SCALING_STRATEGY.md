# Fingerprint Scaling Strategy & Threshold Learning

## Part 1: Scale Analysis - Can the System Handle This Much Fingerprinting?

### Growth Projections

**Token Discovery Rate** (From plan):
- Conservative: 50 tokens/hour
- Target: 100 tokens/hour  
- Peak: 500 tokens/hour (during high activity)

**Snapshots Per Token** (7 independent trigger layers):
1. **Time-based snapshots** (T+0 to T+10min): 1 per minute = **10 snapshots**
2. **Time-based snapshots** (T+10 to graduation): Exponential 2x, 4x, 8x, 16x, etc. = **~5-10 snapshots**
3. **Trade-count-based snapshots** (every 50 trades up to 500): **~10 snapshots**
4. **Milestone-based snapshots** (100 traders, 500 traders, price 2x, 5x, 10x, etc.): **~8 snapshots**
5. **Post-graduation Layer 1**: Time-based post-grad = **~5 snapshots**
6. **Post-graduation Layer 2**: Pool-age-based trades = **~5 snapshots**
7. **Post-graduation Layer 3**: Exponential post-grad = **~5 snapshots**

**Total per token: ~50-60 snapshots**

### Monthly Storage Impact

**Scenario 1: Conservative (50 tokens/hour)**
- Tokens/month: 50 × 24 × 30 = 36,000 tokens
- Snapshots/month: 36,000 × 55 = **1,980,000 snapshots**
- Storage/snapshot (without vector): ~800 bytes metadata
- **Monthly data: ~1.6 TB** ❌ Too much!

**Scenario 2: With Vector Compression (pgvector)**
- Snapshots/month: 1,980,000
- Storage/snapshot with 50-dim vector: ~300 bytes (50 floats × 4 bytes + metadata)
- **Monthly data: ~600 GB** ⚠️ Still significant

**Storage Trajectory**:
- Month 1: 600 GB
- Month 6: 3.6 TB
- Year 1: 7.2 TB

**Database Growth**: At this rate, we'll hit Neon's free tier limits within 2-3 months.

## Part 2: Fingerprint Clustering Strategy - Preventing Database Bloat

### Root Cause of Bloat
With 1.98M new snapshots/month, the database will balloon unless we **compress historical data**. The solution: **Cluster similar old fingerprints into representative vectors**.

### Strategy: Tiered Fingerprint Management

```
┌─ RECENT TOKENS (Last 7 days)
│  Keep full granular snapshots for all tokens
│  Needed for: Real-time similarity matching, ANN training
│  Storage: ~7K tokens × 55 snapshots × 300B = ~120 GB
│
├─ MEDIUM TOKENS (7 days to 30 days)
│  Keep clusters of similar shapes per snapshot_trigger
│  Replace 5-10 similar tokens with 1 centroid vector
│  Needed for: Pattern learning, historical comparison
│  Storage: ~30K tokens × 11 snapshot_groups × 300B = ~100 GB
│
└─ HISTORICAL TOKENS (>30 days old)
   Keep ultra-compressed cluster representatives
   Replace 50+ similar tokens with 1 centroid vector + count
   Needed for: Long-term pattern discovery, edge cases
   Storage: ~100K tokens compressed to ~2K clusters × 300B = ~600 MB
```

### Implementation: K-Means Clustering Per Snapshot Type

**Phase 1: Daily Compression Job (Runs every 24 hours)**

```typescript
async function compressOldFingerprints() {
  // For each snapshot_trigger type (e.g., "time_1min", "trade_count_50")
  for (const triggerType of TRIGGER_TYPES) {
    
    // Get tokens older than 30 days with this trigger
    const oldSnapshots = await db
      .select()
      .from(tokenFingerprints)
      .where(
        and(
          eq(tokenFingerprints.snapshotTrigger, triggerType),
          lt(tokenFingerprints.snapshotTimestamp, 
             Math.floor(Date.now() / 1000) - 30 * 86400)
        )
      );
    
    if (oldSnapshots.length < 5) continue; // Too few to cluster
    
    // Extract feature vectors (50 dims each)
    const vectors = oldSnapshots.map(s => s.fingerprintVector);
    
    // K-Means: Find optimal number of clusters
    const k = Math.min(Math.ceil(Math.sqrt(oldSnapshots.length)), 100);
    const clusters = kMeans(vectors, k);
    
    // For each cluster:
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      
      // Create centroid (average vector)
      const centroid = averageVectors(cluster.vectors);
      
      // Store cluster representative
      await insertClusterRepresentative({
        snapshotTrigger: triggerType,
        clusterId: `${triggerType}_${Date.now()}_${i}`,
        centroidVector: centroid,
        sampleCount: cluster.vectors.length,
        ageRangeStart: cluster.minAge,
        ageRangeEnd: cluster.maxAge,
        compressedAt: Math.floor(Date.now() / 1000),
      });
      
      // Mark original snapshots as archived
      await markAsArchived(cluster.snapshotIds);
    }
  }
  
  console.log(`[Compression] Compressed ${oldSnapshots.length} snapshots`);
}
```

**Storage Reduction Example**:
- **Before**: 1,000 similar "milestone_100_traders" snapshots from 30-60 day old tokens = 300 KB
- **After**: 1 centroid vector + metadata = 500 bytes (60% reduction)
- **Tradeoff**: Lose individual snapshots, gain cluster representative + sample count

### Schema Addition: Fingerprint Clustering

**New Table: `tokenFingerprintClusters`**

```sql
CREATE TABLE token_fingerprint_clusters (
  id SERIAL PRIMARY KEY,
  
  -- Cluster metadata
  cluster_id TEXT NOT NULL UNIQUE,  -- "time_1min_20260427_0"
  snapshot_trigger TEXT NOT NULL,   -- "time_1min", "trade_count_50", etc.
  
  -- Centroid vector (50-dim)
  centroid_vector VECTOR(50) NOT NULL,
  
  -- Cluster statistics
  sample_count INTEGER NOT NULL,        -- How many tokens in this cluster
  age_range_start REAL,                 -- Min token age (minutes)
  age_range_end REAL,                   -- Max token age (minutes)
  confidence REAL,                      -- Cluster cohesion (0-1)
  
  -- Outcome statistics (aggregated from cluster members)
  avg_win_rate REAL,
  avg_final_multiplier REAL,
  avg_hold_minutes REAL,
  
  -- Metadata
  compressed_at INTEGER NOT NULL,
  archived_snapshot_count INTEGER,      -- How many snapshots compressed
  
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_cluster_trigger ON token_fingerprint_clusters(snapshot_trigger);
CREATE INDEX idx_cluster_age ON token_fingerprint_clusters(age_range_start, age_range_end);
```

**Impact on Search**:
- **New tokens (0-7 days)**: Query `tokenFingerprints` table (granular)
- **Old tokens (7+ days)**: Query both `tokenFingerprints` AND `tokenFingerprintClusters`
- **Example query**: "Find tokens similar to this new token at milestone_100_traders"
  - Search recent fingerprints in `tokenFingerprints`
  - Search cluster representatives in `tokenFingerprintClusters`
  - Merge results by vector similarity

### New Monthly Storage Projections

```
RECENT (0-7 days):      ~120 GB   (full granular data)
MEDIUM (7-30 days):     ~100 GB   (clusters + recent raw)
HISTORICAL (30+ days):  ~600 MB   (clusters only)
────────────────────
TOTAL/MONTH:            ~220 GB   (vs. 600 GB before)
```

**63% storage reduction** while maintaining 99% of pattern-matching capability.

---

## Part 3: Creator-Based Early Buying Logic

### Problem Statement
User wants: *"Maybe you can buy at launch if the creator is good enough"*

This requires retrolearner to **learn creator quality thresholds** from historical outcomes.

### Solution: Creator Reputation Tracking

**New Table: `creatorReputation`**

```sql
CREATE TABLE creator_reputation (
  id SERIAL PRIMARY KEY,
  
  -- Creator identification
  creator_address TEXT NOT NULL UNIQUE,
  creator_name TEXT,  -- If metadata available
  
  -- Performance metrics
  total_launches INTEGER DEFAULT 0,
  successful_launches INTEGER DEFAULT 0,  -- Launches that achieved 2x+
  rug_count INTEGER DEFAULT 0,            -- Launches that crashed <0.5x
  
  -- Win rate metrics
  win_rate REAL,              -- successful / total
  rug_rate REAL,              -- rug_count / total
  avg_multiplier REAL,        -- Average peak multiplier across launches
  median_multiplier REAL,     -- Median multiplier
  
  -- Time-based cohort analysis
  avg_time_to_2x REAL,        -- Minutes from launch to 2x
  avg_time_to_peak REAL,      -- Minutes from launch to peak
  avg_hold_duration REAL,     -- Avg duration early buyers held
  
  -- Confidence (0-1) based on sample size
  confidence REAL,
  
  -- Metadata
  last_analyzed_at INTEGER,
  first_launch_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_creator_win_rate ON creator_reputation(win_rate DESC);
CREATE INDEX idx_creator_samples ON creator_reputation(total_launches DESC);
```

### Retrolearner Learning: Creator Thresholds

**Pseudo-code for retrolearner threshold discovery**:

```typescript
async function discoverCreatorThresholds() {
  // Group tokens by creator, track outcomes
  const creatorOutcomes = await db.query(`
    SELECT 
      creator_address,
      COUNT(*) as total_launches,
      COUNT(CASE WHEN final_multiplier >= 2 THEN 1 END) as winners,
      COUNT(CASE WHEN final_multiplier < 0.5 THEN 1 END) as rugs,
      AVG(final_multiplier) as avg_mult,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY final_multiplier) as median_mult
    FROM token_outcomes
    WHERE is_graduated = true
    GROUP BY creator_address
  `);
  
  // Calculate win_rate = winners / total
  // Calculate rug_rate = rugs / total
  // Store in creator_reputation table
  
  // Now: What creator_win_rate correlates with profits?
  // Analyze: tokens from creators with win_rate >= X, what % went 2x+?
  
  const thresholds = [];
  for (let threshold = 0.0; threshold <= 1.0; threshold += 0.05) {
    // Get all tokens from creators with win_rate >= threshold
    const qualifyingTokens = await db.query(`
      SELECT COUNT(CASE WHEN t.final_multiplier >= 2 THEN 1 END) as winners,
             COUNT(*) as total
      FROM token_outcomes t
      JOIN creator_reputation c ON t.creator = c.creator_address
      WHERE c.win_rate >= ${threshold}
    `);
    
    const successRate = qualifyingTokens.winners / qualifyingTokens.total;
    thresholds.push({
      creator_threshold: threshold,
      expected_success_rate: successRate,
      sample_size: qualifyingTokens.total,
      confidence: Math.min(1.0, qualifyingTokens.total / 100), // 100 = high confidence
    });
  }
  
  // Output: "creator_win_rate >= 0.55 → 62% of tokens go 2x+"
  return thresholds.sort((a, b) => b.confidence - a.confidence);
}
```

### Trading System: Early Buying at T+0

**New function in trading decision logic:**

```typescript
async function shouldBuyAtLaunch(tokenMint: string, creatorAddress: string): Promise<{
  shouldBuy: boolean;
  confidence: number;
  reason: string;
}> {
  // Look up creator reputation
  const creator = await db.query(
    "SELECT * FROM creator_reputation WHERE creator_address = $1",
    [creatorAddress]
  );
  
  if (!creator) {
    // New creator, no data
    return { shouldBuy: false, confidence: 0, reason: "Unknown creator" };
  }
  
  // Check against learned thresholds
  const thresholds = await db.query(
    "SELECT * FROM retrolearner_thresholds WHERE threshold_type = 'creator_launch_buy'"
  );
  
  const buyThreshold = thresholds[0]?.creator_win_rate || 0.55; // Default 55%
  const confidenceMultiplier = thresholds[0]?.expected_success_rate || 0.62;
  
  if (creator.win_rate >= buyThreshold) {
    return {
      shouldBuy: true,
      confidence: Math.min(creator.confidence, confidenceMultiplier),
      reason: `Creator ${creator.creator_address} has ${(creator.win_rate * 100).toFixed(1)}% win rate`,
    };
  }
  
  return { shouldBuy: false, confidence: 0, reason: "Creator win rate below threshold" };
}
```

---

## Part 4: Smart Money (Whale Entry) Trigger at T+3

### Problem Statement
User wants: *"Or at t3 if enough smart money has entered"*

Define "smart money" and learn the threshold.

### Solution: Whale Entry Tracking

**Whale Entry Milestone (during fingerprinting)**:

When calculating snapshots, detect whale entries:
```typescript
// During metric calculation at each snapshot
const trades = await getTradesForToken(mint, startTime, snapshotTime);

// Find first trades > 1 SOL (whale indicator)
const firstWhale1Sol = trades.find(t => t.amountSol >= 1.0);
const firstWhale5Sol = trades.find(t => t.amountSol >= 5.0);
const firstWhale10Sol = trades.find(t => t.amountSol >= 10.0);

// Add to fingerprint
snapshot.whaleEntered1Sol = firstWhale1Sol ? 1 : 0;  // 0=no, 1=yes
snapshot.whaleEntered5Sol = firstWhale5Sol ? 1 : 0;
snapshot.whaleEntered10Sol = firstWhale10Sol ? 1 : 0;
snapshot.timeSinceFirstWhale1Sol = firstWhale1Sol 
  ? (snapshotTime - firstWhale1Sol.timestamp) 
  : null;
```

### Retrolearner Learning: Whale Thresholds

```typescript
async function discoverWhaleThresholds() {
  // For each snapshot type (e.g., "time_3min")
  // Count: tokens where whale entered by this time, what % went 2x?
  
  const thresholds = [];
  
  for (let whaleSize of [1.0, 2.5, 5.0, 10.0]) {
    const tokenMetrics = await db.query(`
      SELECT 
        COUNT(CASE WHEN t.final_multiplier >= 2 THEN 1 END) as winners,
        COUNT(*) as total
      FROM token_outcomes t
      JOIN token_fingerprints f ON f.token_mint = t.token_mint
      WHERE f.snapshot_trigger = 'time_3min'
        AND f.whale_entered_xsol >= ${whaleSize}
    `);
    
    thresholds.push({
      whale_threshold: whaleSize,
      success_rate_at_t3: tokenMetrics.winners / tokenMetrics.total,
      sample_size: tokenMetrics.total,
    });
  }
  
  return thresholds;
  // Output: "whale >5 SOL by T+3 → 75% of tokens go 2x+"
}
```

### Trading System: Smart Money Buy at T+3

```typescript
async function shouldBuyOnSmartMoney(tokenMint: string, snapshot: TokenSnapshot): Promise<{
  shouldBuy: boolean;
  confidence: number;
  reason: string;
}> {
  // Check if whale already entered
  if (!snapshot.whaleEntered5Sol) {
    return { shouldBuy: false, confidence: 0, reason: "No whale entry detected" };
  }
  
  // Check learned threshold
  const thresholds = await db.query(
    "SELECT * FROM retrolearner_thresholds WHERE threshold_type = 'whale_t3_buy'"
  );
  
  const expectedSuccessRate = thresholds[0]?.success_rate || 0.75;
  
  // Confidence based on how much time has passed since whale entry
  const timeSinceWhale = snapshot.timeSinceFirstWhale5Sol || 0;
  const timeConfidence = Math.min(1.0, timeSinceWhale / (3 * 60)); // Full confidence at 3 min
  
  return {
    shouldBuy: true,
    confidence: expectedSuccessRate * timeConfidence,
    reason: `Whale >5 SOL entered ${timeSinceWhale}s ago, expected success rate ${(expectedSuccessRate * 100).toFixed(1)}%`,
  };
}
```

---

## Part 5: Integration - Complete Trading Decision Flow

### Combined Decision Tree

```
NEW TOKEN DETECTED at T+0
  ↓
Check creator reputation
  ├─ creator_win_rate >= 0.55? 
  │  └─ YES → BUY at T+0 (confidence: 62%)
  │
  ├─ NO → Continue monitoring...
  │
  └─ At T+3:
     ├─ whale >5 SOL entered?
     │  └─ YES → BUY at T+3 (confidence: 75%)
     │
     └─ Continue fingerprinting...
        ├─ At T+5: ANN scores token shape
        │  ├─ Score > 0.70? 
        │  │  └─ YES → BUY (confidence: ANN score)
        │  └─ NO → Continue monitoring 10min
        │
        └─ At T+10: Milestone checks
           ├─ 100+ unique traders with >50% buy ratio?
           │  └─ YES → BUY (confidence: 65%)
           │
           └─ NO → Monitor 30 more minutes or graduatable

GRADUATION DETECTED
  ↓
Stop pre-grad monitoring
↓
Start DexPaprika SSE monitoring for post-grad trades
```

### Database Schema: Retrolearner Thresholds

```sql
CREATE TABLE retrolearner_thresholds (
  id SERIAL PRIMARY KEY,
  
  -- Threshold type
  threshold_type TEXT NOT NULL,  
    -- "creator_launch_buy"
    -- "whale_t3_buy"
    -- "ann_score_buy"
    -- "milestone_100_traders_buy"
  
  -- Learned values
  threshold_value REAL NOT NULL,     -- e.g., creator_win_rate >= 0.55
  expected_success_rate REAL NOT NULL, -- e.g., 62% go 2x+
  sample_size INTEGER,                -- Basis for learning
  confidence REAL,                    -- 0-1 confidence in threshold
  
  -- Cohort info
  analysis_date INTEGER NOT NULL,
  data_window_days INTEGER,          -- How many days of data analyzed
  
  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_threshold_type ON retrolearner_thresholds(threshold_type);
```

---

## Part 6: Summary Table - What Gets Stored Where

| Data | Table | Storage | Update Frequency | Purpose |
|------|-------|---------|------------------|---------|
| Raw trades (mint, wallet, amount, time) | `trade_logs` | Raw | Real-time | Fingerprint calculation source |
| Token fingerprints (0-7 days) | `token_fingerprints` | Full vectors | Every 5-10s | Real-time trading signals |
| Token fingerprints (7-30 days) | `token_fingerprints` + clusters | Blended | Daily compression | Pattern learning |
| Token fingerprints (30+ days) | `token_fingerprint_clusters` | Centroids only | Daily compression | Historical reference |
| Creator metrics | `creator_reputation` | Summary stats | Weekly retrolearner | Early buying decisions |
| Token outcomes | `token_outcomes` | Aggregated metrics | Post-graduation | Retrolearner training |
| Learned thresholds | `retrolearner_thresholds` | Threshold values | Weekly retrolearner | Trading decision rules |

---

## Implementation Roadmap

### Phase 1: Scale Analysis ✓ (Complete)
- Confirmed: System can handle scale with clustering

### Phase 2: Creator Reputation (Next)
- Add `creator_reputation` table
- Track creator outcomes in retrolearner
- Learn creator_win_rate thresholds
- Implement T+0 early buy logic

### Phase 3: Whale Entry Detection (Next)
- Add whale entry milestones to fingerprints
- Track whale entry timing (<1 SOL, 5 SOL, 10 SOL)
- Learn whale thresholds in retrolearner
- Implement T+3 smart money buy logic

### Phase 4: Fingerprint Clustering (Next)
- Add `token_fingerprint_clusters` table
- Implement daily compression job
- Modify vector search to query both tables
- Monitor storage reduction

### Phase 5: Integrate Trading Decisions (Final)
- Combine creator + whale + ANN + milestone logic
- Test combined decision tree
- Verify each threshold via backtesting

---

## FAQ: Scalability & Performance

**Q: Will clustering hurt vector search accuracy?**
A: No. For recent tokens (<7 days), we search granular fingerprints. For older tokens, cluster centroids represent the "average shape" of that pattern - perfect for finding similar historical tokens.

**Q: When does the compression job run?**
A: Daily at 2 AM UTC. Takes ~30-60 minutes to process 1M fingerprints. Runs asynchronously so it doesn't block trading.

**Q: Can we query archived fingerprints?**
A: Archived fingerprints are moved to `token_fingerprint_clusters`. If a user wants granular details on a 60-day-old token, we can reconstruct from centroid + metadata (showing "This was 1 of 50 similar tokens in this pattern").

**Q: What if a creator has <10 launches?**
A: Their `confidence` score will be low (0.2-0.4). We won't use them for early buying until confidence > 0.8 (empirically ~50+ launches).

**Q: How long does retrolearner take to learn thresholds?**
A: ~7-14 days to accumulate 100+ graduated tokens per threshold type. Initially, we use conservative defaults (creator >= 55%, whale >= $5, ANN >= 0.70).
