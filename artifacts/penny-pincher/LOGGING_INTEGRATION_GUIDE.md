# Logging Integration Guide

This guide shows exactly where and how to integrate the bucketed logging system (`log-buckets.ts`) into each pipeline stage.

## Quick Start

All logging functions are exported from `log-buckets.ts`:

```typescript
import {
  addRecentEvent,
  updateBucket,
  getBucketSummary,
  getBucketStats,
  startLogMaintenance,
} from "./log-buckets";
```

The diagnostic endpoints are auto-registered in `routes.ts` via:
```typescript
import { registerDiagnosticEndpoints } from "./diagnostic-endpoints";
registerDiagnosticEndpoints(app); // Called in registerRoutes()
```

## Diagnostic Endpoints (Already Available)

### 1. GET /api/system/logs/recent
Query recent raw events with optional filtering

```
GET /api/system/logs/recent?category=discovery&level=error&limit=50
GET /api/system/logs/recent?tokenMint=ABC123&limit=200
GET /api/system/logs/recent?walletAddress=5FhwQ...&hours=6
```

**Query Parameters:**
- `category`: discovery, features, ann, snapshot, trades, graduation, retrolearner, api, db, capacity, system
- `level`: debug, info, warn, error
- `tokenMint`: filter by token
- `walletAddress`: filter by wallet
- `limit`: 1-1000 (default 100)
- `offset`: for pagination

### 2. GET /api/system/logs/buckets
Query hourly bucket summaries

```
GET /api/system/logs/buckets - last 24h, all categories
GET /api/system/logs/buckets?category=retrolearner&hours=6 - last 6h, retrolearner only
GET /api/system/logs/buckets?category=api&since=3600000 - last 1h, API only
```

### 3. GET /api/system/logs/stats
Get current buffer and bucket statistics

```json
{
  "stats": {
    "bucketCount": 24,
    "recentEventsCount": 4523,
    "oldestBucket": 1713206400000,
    "newestBucket": 1713292800000,
    "memoryUsageMb": 12.5
  },
  "bufferHealth": {
    "recentEventsFilled": "90.5%",
    "bucketCount": 24,
    "memoryHealthy": true,
    "recommendation": "Buffer within healthy limits"
  }
}
```

### 4. GET /api/system/logs/errors
Get error trends and summary

```
GET /api/system/logs/errors?hours=24&topN=10
GET /api/system/logs/errors?category=retrolearner&hours=6
```

### 5. GET /api/system/logs/api-usage
Show API call statistics per service

```
GET /api/system/logs/api-usage?hours=24
```

### 6. GET /api/system/logs/db-ops
Show database operation statistics

```
GET /api/system/logs/db-ops?hours=24
```

### 7. GET /api/system/logs/health
Overall system health summary

```
GET /api/system/logs/health
```

## Integration Points

### 1. Discovery Engine (Token Discovery)

**File:** `server/discovery-engine.ts`

**When to log:** When new token is discovered and inserted into database

**Code to add:**

```typescript
import { addRecentEvent } from "./log-buckets";

// Inside the token creation handler (wherever new tokens are inserted)
async function handleNewToken(message: any) {
  // ... existing code ...
  
  // Log the discovery
  addRecentEvent({
    timestamp: Date.now(),
    category: "discovery",
    level: "info",
    message: `New token discovered: ${tokenMint}`,
    tokenMint,
    metrics: {
      apiCalls: 1, // PumpPortal message
      dbWrites: 1, // INSERT into tokenDataPool
    },
  });
}
```

### 2. Token Success ANN (Feature Extraction & Inference)

**File:** `server/token-success-ann.ts`

**When to log:** 
- When features are extracted from a token
- When ANN inference produces a score
- When ANN training completes

**Code to add:**

```typescript
import { addRecentEvent } from "./log-buckets";

// Inside trainANNModel()
export async function trainANNModel(minSampleCount: number) {
  const startTime = Date.now();
  
  // ... training code ...
  
  const duration = Date.now() - startTime;
  addRecentEvent({
    timestamp: Date.now(),
    category: "ann",
    level: "info",
    message: `ANN training complete: ${samplesUsed} samples, accuracy=${accuracy.toFixed(3)}`,
    metrics: {
      latencyMs: duration,
      dbReads: queryCount, // Number of DB queries for training data
    },
  });
}

// Inside predictTokenSuccess()
export async function predictTokenSuccess(
  tokenMint: string,
  features: number[]
): Promise<number> {
  const startTime = Date.now();
  
  // ... inference code ...
  const probability = await model.predict(features);
  
  const duration = Date.now() - startTime;
  addRecentEvent({
    timestamp: Date.now(),
    category: "ann",
    level: "debug",
    message: `ANN inference: ${probability.toFixed(4)} confidence`,
    tokenMint,
    metrics: {
      latencyMs: duration,
    },
  });
  
  return probability;
}
```

### 3. Snapshot Trigger Manager (Snapshots & Milestones)

**File:** `server/snapshot-trigger-manager.ts`

**When to log:** When snapshots are created (time-based or milestone-based)

**Code to add:**

```typescript
import { addRecentEvent, updateBucket } from "./log-buckets";

// Inside createSnapshot() or wherever snapshots are created
async function createSnapshot(tokenMint: string, reason: string) {
  const startTime = Date.now();
  
  // ... snapshot creation code ...
  
  const duration = Date.now() - startTime;
  addRecentEvent({
    timestamp: Date.now(),
    category: "snapshot",
    level: "info",
    message: `Snapshot created: ${reason}`,
    tokenMint,
    metrics: {
      latencyMs: duration,
      dbWrites: 1, // INSERT into tokenFingerprints
    },
  });
  
  // Also update hourly bucket for aggregated stats
  updateBucket("snapshot", Date.now(), {
    level: "info",
    message: `Snapshot: ${reason}`,
    metrics: {
      dbWrites: 1,
      latencyMs: duration,
    },
  });
}

// Inside milestone detection
async function detectMilestones(tokenMint: string, currentMultiplier: number) {
  // ... milestone detection code ...
  
  if (milestonesTriggered.length > 0) {
    addRecentEvent({
      timestamp: Date.now(),
      category: "snapshot",
      level: "info",
      message: `Milestones triggered: ${milestonesTriggered.join(", ")}`,
      tokenMint,
      metrics: {
        dbWrites: milestonesTriggered.length,
      },
    });
  }
}
```

### 4. Retrolearner (Cycle Progress & Analysis)

**File:** `server/retrolearner.ts`

**When to log:**
- At each major step in the retrolearning cycle
- When trades are summarized
- When ANN is trained
- When wallets are discovered
- When cycle completes

**Code to add:**

```typescript
import { addRecentEvent, updateBucket } from "./log-buckets";

// Inside performRetrolearningCycle()
async function performRetrolearningCycle(): Promise<void> {
  const cycleStartTime = Date.now();
  
  try {
    // Step 0: Summarize trades
    console.log("[Retrolearner] Summarizing raw trades...");
    const tradeStatsStartTime = Date.now();
    const tradeStats = await summarizeRawTrades(sixHoursAgoSeconds);
    const tradeStatsDuration = Date.now() - tradeStatsStartTime;
    
    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "info",
      message: `Step 0: Summarized ${tradeStats.tradesSummarized} trades for ${tradeStats.tokensProcessed} tokens`,
      metrics: {
        latencyMs: tradeStatsDuration,
        dbReads: 1,
        dbWrites: tradeStats.tokensProcessed,
        dbDeletes: tradeStats.rawTradesDeleted,
      },
    });
    
    // Step 1: Train ANN
    console.log("[Retrolearner] Training ANN...");
    const annStartTime = Date.now();
    const annMetrics = await trainANNModel(100);
    const annDuration = Date.now() - annStartTime;
    
    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "info",
      message: `Step 1: ANN trained on ${annMetrics.samplesUsed} samples (accuracy ${annMetrics.accuracy.toFixed(3)})`,
      metrics: {
        latencyMs: annDuration,
        dbReads: annMetrics.samplesUsed,
      },
    });
    
    // Step 7: Discover wallets
    console.log("[Retrolearner] Discovering wallets...");
    const walletStartTime = Date.now();
    const missedTokens = await discoverWalletsFromMissedTokens(24, 5);
    const walletDuration = Date.now() - walletStartTime;
    
    let totalWallets = 0;
    for (const holders of missedTokens.values()) {
      totalWallets += holders.length;
    }
    
    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "info",
      message: `Step 7: Discovered ${totalWallets} wallets from ${missedTokens.size} missed tokens`,
      metrics: {
        latencyMs: walletDuration,
        dbReads: missedTokens.size,
        dbWrites: totalWallets,
      },
    });
    
    // Cycle complete
    const cycleTotalDuration = Date.now() - cycleStartTime;
    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "info",
      message: `Retrolearner cycle complete (${(cycleTotalDuration / 1000).toFixed(1)}s)`,
      metrics: {
        latencyMs: cycleTotalDuration,
      },
    });
    
  } catch (error) {
    addRecentEvent({
      timestamp: Date.now(),
      category: "retrolearner",
      level: "error",
      message: `Retrolearner cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    retrolearnerRunning = false;
  }
}
```

### 5. API Calls (DexPaprika, DexScreener, Chainstack, etc.)

**File:** Wherever API calls are made

**When to log:** Each external API call

**Code to add:**

```typescript
import { addRecentEvent } from "./log-buckets";

// Before API call
const startTime = Date.now();

// Make API call
const response = await axios.get(apiUrl);

// Log the call
const duration = Date.now() - startTime;
addRecentEvent({
  timestamp: Date.now(),
  category: "api",
  level: "debug",
  message: `DexPaprika: Fetched ${mints.length} token prices`,
  metrics: {
    apiCalls: 1,
    latencyMs: duration,
  },
});
```

### 6. Database Operations (Already Tracked Elsewhere)

Database operations are tracked implicitly through metrics in events logged from discovery, retrolearner, snapshots, etc.

**Pattern for explicit DB tracking:**

```typescript
import { addRecentEvent } from "./log-buckets";

// For significant DB operations
const startTime = Date.now();
const result = await db.insert(tokenDataPool).values(data);
const duration = Date.now() - startTime;

addRecentEvent({
  timestamp: Date.now(),
  category: "db",
  level: "debug",
  message: `Inserted ${data.length} tokens`,
  metrics: {
    dbWrites: data.length,
    latencyMs: duration,
  },
});
```

## Logging Best Practices

### 1. Message Format
- **Info**: "Action completed: X items processed"
- **Warn**: "Action partially completed or slow"
- **Error**: "Action failed: error description"
- **Debug**: "Detailed operation trace"

### 2. Metrics to Always Include
```typescript
metrics: {
  latencyMs: duration,      // Operation duration
  apiCalls: callCount,      // If API calls made
  dbReads: readCount,       // If DB reads
  dbWrites: writeCount,     // If DB writes
  dbDeletes: deleteCount,   // If DB deletes
  memoryMb: heapUsage,      // Optional, for resource tracking
}
```

### 3. Avoid Over-Logging
- Log at **INFO** level for significant events (discovery, ANN training, cycle complete)
- Log at **DEBUG** level for frequent events (individual inferences, small API calls)
- Log at **WARN** level for performance issues (slow operations >500ms)
- Log at **ERROR** level for failures

### 4. Filtering in Queries
Use the diagnostic endpoints to filter and analyze:

```bash
# Get all errors in last 24h
curl "http://localhost:3000/api/system/logs/errors?hours=24"

# Get discovery events for specific token
curl "http://localhost:3000/api/system/logs/recent?category=discovery&tokenMint=ABC123&limit=100"

# Get slow operations (>500ms latency)
curl "http://localhost:3000/api/system/logs/buckets?category=retrolearner&hours=24" | jq '.buckets[] | select(.latencyMs.avg > 500)'

# Get API usage trends
curl "http://localhost:3000/api/system/logs/api-usage?hours=24"
```

## Memory Management

The logging system automatically:
- **Keeps raw events for 6 hours** in memory (~5 MB)
- **Compacts buckets at 6+ hours** to database (mark compacted=true, free events)
- **Prunes buckets at 24+ hours** from memory completely
- **Runs maintenance hourly** (automatic via startLogMaintenance in index.ts)

**If memory issues occur:**
1. Check `/api/system/logs/stats` for buffer health
2. If >50 MB: reduce RECENT_EVENTS_WINDOW_MS in log-buckets.ts
3. If >80 MB: immediately compact old buckets manually or reduce MAX_RECENT_EVENTS

## Testing Endpoints

```bash
# 1. Get recent events
curl "http://localhost:3000/api/system/logs/recent?limit=10"

# 2. Get bucket summaries
curl "http://localhost:3000/api/system/logs/buckets?hours=24"

# 3. Get buffer stats
curl "http://localhost:3000/api/system/logs/stats"

# 4. Get health status
curl "http://localhost:3000/api/system/logs/health"

# 5. Get error trends
curl "http://localhost:3000/api/system/logs/errors?hours=24&topN=10"

# 6. Get API usage
curl "http://localhost:3000/api/system/logs/api-usage?hours=24"

# 7. Get DB operations
curl "http://localhost:3000/api/system/logs/db-ops?hours=24"
```

## Database Schema (For Persistent Storage)

When compacted buckets are stored to database, use this schema:

```sql
CREATE TABLE IF NOT EXISTS system_logs (
  id BIGSERIAL PRIMARY KEY,
  hour_start BIGINT NOT NULL,           -- Timestamp of hour start
  category TEXT NOT NULL,               -- discovery, features, ann, snapshot, etc.
  event_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  
  -- API metrics
  api_calls INTEGER DEFAULT 0,
  
  -- Database metrics
  db_reads INTEGER DEFAULT 0,
  db_writes INTEGER DEFAULT 0,
  db_deletes INTEGER DEFAULT 0,
  
  -- Performance metrics
  latency_min INTEGER,
  latency_max INTEGER,
  latency_avg INTEGER,
  latency_p95 INTEGER,
  
  memory_min DECIMAL,
  memory_max DECIMAL,
  memory_avg DECIMAL,
  
  -- Error summary
  top_errors JSONB,
  
  -- Metadata
  compacted_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_category_hour (category, hour_start)
);
```

## Next Steps

1. **Phase 1 (Complete)**: Diagnostic endpoints created and registered ✅
2. **Phase 2 (In Progress)**: Integrate logging into pipeline stages
   - [ ] discovery-engine.ts - token discoveries
   - [ ] token-success-ann.ts - ANN training and inference
   - [ ] snapshot-trigger-manager.ts - snapshot creation
   - [ ] retrolearner.ts - cycle progress
3. **Phase 3 (Future)**: Create system_logs table and store compacted buckets
4. **Phase 4 (Future)**: Create web dashboard for real-time monitoring

## Debugging Tips

**Problem**: No events appearing in `/api/system/logs/recent`
- **Solution**: Verify `addRecentEvent()` is being called from pipeline stages

**Problem**: Memory usage growing beyond 50 MB
- **Solution**: Check if `startLogMaintenance()` is running (should be in index.ts)

**Problem**: Specific category not appearing in bucket summaries
- **Solution**: Verify events are using the correct category name from the 11 defined categories

**Problem**: All errors showing as "unknown"
- **Solution**: Ensure error field is populated: `error instanceof Error ? error.message : String(error)`
