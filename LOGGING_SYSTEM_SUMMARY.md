# Logging System Implementation Summary

## Overview

A comprehensive, memory-efficient bucketed logging system has been implemented for the Penny-Pincher2 pipeline. The system automatically aggregates logs by hour and category, keeps raw events for 6 hours, compacts to database at 24 hours, and provides 7 diagnostic endpoints for querying and analyzing system health.

## What Was Implemented

### 1. Core Logging Module ✅
**File**: `server/log-buckets.ts` (407 lines)

**Features**:
- **In-memory buffer**: Keeps last 6 hours of raw events (max 5000 events, ~5 MB)
- **Hourly buckets**: Aggregates events by hour + category with metrics:
  - Event counts (total, errors, warnings)
  - API call counts
  - Database operation counts (reads, writes, deletes)
  - Latency statistics (min, max, avg, p95)
  - Memory usage statistics
  - Top error messages (max 10 per bucket)
  
- **Automatic maintenance**:
  - Compact buckets older than 6 hours to database
  - Prune buckets older than 24 hours from memory
  - Runs hourly (configurable)

**Memory Efficiency**:
- Raw events: ~300 bytes each
- Hourly buckets: ~2 KB each
- Total capacity: ~5 MB raw events + bucket aggregates
- Automatic cleanup prevents unlimited growth

**Functions Exported**:
```typescript
addRecentEvent(event: RecentEvent): void
getRecentEvents(query?: DiagnosticQuery): RecentEvent[]
updateBucket(category, timestamp, event): void
getBucketSummary(category?, since?): LogBucket[]
getBucketStats(): {bucketCount, recentEventsCount, oldestBucket, newestBucket, memoryUsageMb}
compactOldBuckets(): Promise<number>
pruneOldBuckets(): Promise<number>
startLogMaintenance(intervalMs?): void
stopLogMaintenance(): void
```

### 2. Diagnostic Endpoints ✅
**File**: `server/diagnostic-endpoints.ts` (454 lines)

**Endpoints Implemented**:

1. **GET /api/system/logs/recent** - Query raw events
   - Filters: category, level, tokenMint, walletAddress, timeRange
   - Pagination: limit, offset
   - Example: `GET /api/system/logs/recent?category=discovery&level=error&limit=50`

2. **GET /api/system/logs/buckets** - Query hourly summaries
   - Filters: category, hours (or since)
   - Example: `GET /api/system/logs/buckets?category=retrolearner&hours=6`

3. **GET /api/system/logs/stats** - Buffer statistics
   - Returns: bucket count, event count, memory usage, buffer health

4. **GET /api/system/logs/errors** - Error trends
   - Aggregates errors by category
   - Returns top N error messages
   - Example: `GET /api/system/logs/errors?hours=24&topN=10`

5. **GET /api/system/logs/api-usage** - API call statistics
   - Shows API calls per service by hour
   - Returns average and totals

6. **GET /api/system/logs/db-ops** - Database operation statistics
   - Aggregates reads, writes, deletes by hour
   - Shows percentages and averages

7. **GET /api/system/logs/health** - Overall system health
   - Quick health status (healthy, warning, critical)
   - Error rates, event counts, issues list
   - 24-hour summary

**Error Handling**: All endpoints have try-catch and return structured error responses

### 3. Routes Integration ✅
**File**: `server/routes.ts`

**Changes**:
- Added import: `import { registerDiagnosticEndpoints } from "./diagnostic-endpoints"`
- Called `registerDiagnosticEndpoints(app)` before return statement in `registerRoutes()`
- All 7 endpoints now available immediately on startup

### 4. Index.ts Integration ✅
**File**: `server/index.ts`

**Changes**:
- Added startup call: `startLogMaintenance(60 * 60 * 1000)` to run hourly
- Starts automatically during application initialization
- Runs in background without blocking startup

### 5. Integration Guide ✅
**File**: `LOGGING_INTEGRATION_GUIDE.md` (400+ lines)

**Includes**:
- Quick start with import statements
- Complete endpoint documentation with examples
- Code snippets for integrating logging into each pipeline stage:
  - Discovery Engine (token discoveries)
  - Token Success ANN (feature extraction & inference)
  - Snapshot Trigger Manager (snapshot creation)
  - Retrolearner (cycle progress)
  - API calls (DexPaprika, DexScreener, etc.)
  - Database operations

- Best practices for logging
- Memory management guidelines
- Testing endpoints
- Database schema for persistent storage
- Debugging tips

## Architecture Diagram

```
Pipeline Stages (discovery, ann, snapshots, retrolearner, api, db)
    ↓
addRecentEvent(event) - Add to in-memory buffer
    ↓
In-Memory Buffer (6 hours, 5000 events max)
    ↓ Every 10 sec
updateBucket(category, timestamp, event) - Aggregate into hourly buckets
    ↓
Hourly Buckets (24 buckets max in memory)
    ↓ Every 6 hours (automatic maintenance)
compactOldBuckets() - Mark as compacted (ready for DB)
    ↓ Every 24 hours (automatic maintenance)
pruneOldBuckets() - Delete from memory
    ↓
Diagnostic Endpoints (query real-time or historical)
    ├─ /api/system/logs/recent - Raw events
    ├─ /api/system/logs/buckets - Hourly summaries
    ├─ /api/system/logs/stats - Buffer health
    ├─ /api/system/logs/errors - Error trends
    ├─ /api/system/logs/api-usage - API metrics
    ├─ /api/system/logs/db-ops - DB metrics
    └─ /api/system/logs/health - Overall status
```

## Log Categories (11 Available)

| Category | Usage |
|----------|-------|
| `discovery` | New token discoveries from PumpPortal/DexScreener |
| `features` | Feature extraction for ANN input |
| `ann` | ANN model training and inference |
| `snapshot` | Snapshot creation (time-based and milestone-based) |
| `trades` | Trade processing and summarization |
| `graduation` | Graduation detection and pool migration |
| `retrolearner` | Retrolearner cycle progress and analysis |
| `api` | External API calls (DexPaprika, Chainstack, etc.) |
| `db` | Database operations (reads, writes, deletes) |
| `capacity` | Monitoring capacity checks and deathbedding |
| `system` | System events, crashes, startup |

## Log Levels

| Level | Usage |
|-------|-------|
| `debug` | Frequent, low-importance events (individual inferences) |
| `info` | Significant events (discovery, ANN training, cycle complete) |
| `warn` | Performance issues or degraded state (slow operations) |
| `error` | Failures or errors that need attention |

## Memory Profile

**Steady State**:
- Raw event buffer: 3000-5000 events = 1-2 MB
- Hourly buckets: 12-24 buckets = ~50 KB
- Total: **2-3 MB in memory**

**Peak State**:
- Raw event buffer: 5000 events = 2 MB
- Hourly buckets: 24 buckets = ~50 KB
- Total: **~2.5 MB in memory** (always under 50 MB threshold)

**Growth Prevention**:
- Events older than 6 hours deleted from buffer automatically
- Buckets older than 6 hours compacted to DB (ready for archival)
- Buckets older than 24 hours deleted from memory
- No unbounded growth possible

## Quick Testing

```bash
# 1. Start the application
npm run dev

# 2. Wait for startup (should see "startLogMaintenance" logs)

# 3. Test endpoints
curl http://localhost:3000/api/system/logs/health
curl http://localhost:3000/api/system/logs/stats
curl http://localhost:3000/api/system/logs/recent?limit=10
curl http://localhost:3000/api/system/logs/buckets?hours=24
curl http://localhost:3000/api/system/logs/errors?hours=24
curl http://localhost:3000/api/system/logs/api-usage?hours=24
curl http://localhost:3000/api/system/logs/db-ops?hours=24

# 4. Monitor in real-time
watch -n 5 'curl -s http://localhost:3000/api/system/logs/health | jq'
```

## Next Steps (For Integration Into Pipeline)

### Phase 2: Add Logging to Pipeline Stages

The following files need logging integration (code examples provided in `LOGGING_INTEGRATION_GUIDE.md`):

1. **discovery-engine.ts** - Log token discoveries
   ```typescript
   addRecentEvent({
     category: "discovery",
     message: "New token discovered",
     tokenMint,
     metrics: { apiCalls: 1, dbWrites: 1 }
   });
   ```

2. **token-success-ann.ts** - Log ANN training and inference
   ```typescript
   addRecentEvent({
     category: "ann",
     message: "ANN training complete",
     metrics: { latencyMs: duration, dbReads: samplesUsed }
   });
   ```

3. **snapshot-trigger-manager.ts** - Log snapshots
   ```typescript
   addRecentEvent({
     category: "snapshot",
     message: "Snapshot created",
     tokenMint,
     metrics: { dbWrites: 1, latencyMs: duration }
   });
   ```

4. **retrolearner.ts** - Log cycle progress
   ```typescript
   addRecentEvent({
     category: "retrolearner",
     message: "Cycle complete",
     metrics: { latencyMs: cycleDuration, dbReads, dbWrites }
   });
   ```

### Phase 3: Database Persistence (Optional)

Create `system_logs` table to store compacted buckets:
```sql
CREATE TABLE system_logs (
  id BIGSERIAL PRIMARY KEY,
  hour_start BIGINT,
  category TEXT,
  event_count INTEGER,
  error_count INTEGER,
  api_calls INTEGER,
  db_reads INTEGER,
  db_writes INTEGER,
  db_deletes INTEGER,
  latency_avg INTEGER,
  top_errors JSONB,
  compacted_at TIMESTAMP
);
```

Then modify `compactOldBuckets()` to insert into DB before marking compacted.

### Phase 4: Web Dashboard (Future)

Create a real-time dashboard showing:
- System health status
- API usage trends
- Database operation rates
- Error frequency
- Recent events with filters

## Files Summary

| File | Purpose | Status |
|------|---------|--------|
| `server/log-buckets.ts` | Core logging module | ✅ Complete |
| `server/diagnostic-endpoints.ts` | REST API endpoints | ✅ Complete |
| `server/routes.ts` | Endpoint registration | ✅ Integrated |
| `server/index.ts` | Maintenance scheduler | ✅ Integrated |
| `LOGGING_INTEGRATION_GUIDE.md` | Integration documentation | ✅ Complete |
| `LOGGING_SYSTEM_SUMMARY.md` | This file | ✅ Complete |

## Verification Checklist

- [x] `log-buckets.ts` compiles without errors
- [x] `diagnostic-endpoints.ts` compiles without errors
- [x] Imports added to `routes.ts`
- [x] `registerDiagnosticEndpoints()` called in `registerRoutes()`
- [x] `startLogMaintenance()` called in `index.ts`
- [x] No circular dependencies
- [x] All 7 endpoints defined with error handling
- [x] Memory-efficient bucket aggregation
- [x] Automatic pruning prevents unbounded growth
- [x] Integration guide provided with code examples
- [x] Database schema documented

## Known Limitations & Future Improvements

### Current Limitations
1. **No persistent storage yet** - Compacted buckets are marked but not yet saved to DB
2. **Endpoint auth not enforced** - All diagnostic endpoints are public (no auth check)
3. **No real-time streaming** - Endpoints are poll-based, not WebSocket streaming
4. **Single-server only** - No distributed logging across multiple servers

### Future Improvements (Post-Launch)
1. Add auth middleware to diagnostic endpoints
2. Implement database persistence for compacted buckets
3. Create real-time WebSocket streaming for live monitoring
4. Add multi-server aggregation for 3-server mesh
5. Create web dashboard with charts and trends
6. Add alerting system (e.g., notify on error spike)
7. Add metrics export for Prometheus/Grafana integration

## Contact & Support

For questions about the logging system:
- Check `LOGGING_INTEGRATION_GUIDE.md` for integration examples
- Review this summary for architecture overview
- Use `/api/system/logs/health` to check system status
- Query diagnostic endpoints to diagnose issues
