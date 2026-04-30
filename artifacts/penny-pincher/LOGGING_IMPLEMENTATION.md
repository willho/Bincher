# Comprehensive Logging & Metrics Implementation Guide

## Overview

The system includes two integrated logging layers:

1. **Existing Application Logging** - Service-specific logs (AI usage, API calls, trades, webhooks)
2. **Pipeline Metrics Logging** - Comprehensive data flow tracking with in-memory buffer

## Using the Pipeline Logger

### Basic Usage

```typescript
import { logPipeline, createPipelineTracer, getPipelineMetrics, flushPipelineLogs } from "./system-logger";

// Simple log
logPipeline("discovery", "New token discovered", "info", {
  tokenMint: "ABC123...",
  metrics: { apiCalls: 1, dbWrites: 1 }
});

// Error log
logPipeline("features", "Failed to extract features", "error", {
  tokenMint: "ABC123...",
  metrics: { latencyMs: 500 }
});
```

### Using Tracers for Operations

```typescript
const tracer = createPipelineTracer("features", "extractEarlyDynamics");

// Operation starts
tracer.start();

try {
  // Do work...
  
  // Log progress
  tracer.log("Extracted 50 features", "info", {
    dbReads: 5,
    latencyMs: 150
  });
  
  // Operation complete
  tracer.end(true); // true = success
} catch (error) {
  tracer.end(false); // false = failure
}
```

### Metrics Categories

| Category | When to Use |
|----------|-------------|
| `discovery` | Token discovery, PumpPortal WebSocket messages |
| `features` | Feature extraction, ANN input preparation |
| `ann` | ANN model training, inference |
| `snapshot` | Snapshot creation, OHLCV data capture |
| `trades` | Trade processing, summarization |
| `graduation` | Token graduation detection, migration |
| `retrolearner` | Retrolearner cycles, wallet discovery |
| `api` | API calls (Pump SDK, DexScreener, etc.) |
| `db` | Database operations (reads, writes, deletes) |
| `capacity` | Monitoring capacity checks, deathbedding |
| `system` | System events, crashes, startup |

## Implementing Logging in Each Stage

### Stage 1: Token Discovery

```typescript
// In discovery-engine.ts or pumpfun-websocket.ts

function handleNewTokenMessage(message: any) {
  const tracer = createPipelineTracer("discovery", `token_${message.mint}`);
  tracer.start();

  try {
    // Store to DB
    const created = await insertToken(message);

    tracer.log("Stored token metadata", "info", {
      dbWrites: 1,
      metrics: { latencyMs: tracer.end(true) }
    });
  } catch (error) {
    logPipeline("discovery", "Failed to store token", "error", {
      tokenMint: message.mint,
      error: error instanceof Error ? error.message : "Unknown"
    });
    tracer.end(false);
  }
}
```

### Stage 2: Early Dynamics Collection

```typescript
// In token-success-ann.ts

export async function extractEarlyDynamicsFeatures(tokenMint: string) {
  const tracer = createPipelineTracer("features", `extract_${tokenMint.slice(0, 8)}`);
  tracer.start();

  try {
    // Fetch data
    const candles = await db.select().from(priceHistoryCache)...;
    const trades = await db.select().from(rawTokenTrades)...;
    
    tracer.log(`Fetched ${candles.length} candles, ${trades.length} trades`, "debug", {
      dbReads: 2,
      latencyMs: Date.now() - startTime
    });

    // Extract features
    const features = calculateFeatures(candles, trades);
    
    tracer.log("Calculated 50 features", "info", {
      latencyMs: Date.now() - startTime
    });

    return features;
  } catch (error) {
    logPipeline("features", "Feature extraction failed", "error", {
      tokenMint,
      error: error instanceof Error ? error.message : "Unknown"
    });
    tracer.end(false);
    throw error;
  }
}
```

### Stage 3: ANN Inference

```typescript
// In token-success-ann.ts

export async function predictTokenSuccess(features: number[]): Promise<number> {
  const tracer = createPipelineTracer("ann", "predict_success");
  tracer.start();

  try {
    const input = tf.tensor2d([features]);
    const output = model.predict(input);
    const probability = (await output.data())[0];

    tracer.log(`Inference complete: ${probability.toFixed(4)} probability`, "debug", {
      latencyMs: Date.now() - startTime
    });

    input.dispose();
    output.dispose();

    return probability;
  } catch (error) {
    logPipeline("ann", "Inference failed", "error", {
      error: error instanceof Error ? error.message : "Unknown"
    });
    tracer.end(false);
    throw error;
  }
}
```

### Stage 4: Snapshot Creation

```typescript
// In snapshot-trigger-manager.ts

export async function createSnapshot(tokenMint: string, reason: string) {
  const tracer = createPipelineTracer("snapshot", `snapshot_${reason}`);
  tracer.start();

  try {
    const snapshotData = {
      tokenMint,
      timestamp: Date.now(),
      bondingProgress: ...,
      currentPrice: ...,
      // ... other fields
    };

    const result = await db.insert(tokenFingerprints).values(snapshotData);

    tracer.log(`Created snapshot for ${reason}`, "info", {
      snapshotId: result.id,
      dbWrites: 1,
      latencyMs: tracer.end(true)
    });
  } catch (error) {
    logPipeline("snapshot", "Snapshot creation failed", "error", {
      tokenMint,
      error: error instanceof Error ? error.message : "Unknown"
    });
    tracer.end(false);
  }
}
```

### Stage 5: Trade Summarization

```typescript
// In retrolearner.ts

export async function summarizeRawTrades(since6HoursAgo: number) {
  const tracer = createPipelineTracer("trades", "summarize_trades");
  tracer.start();

  try {
    // Query trades
    const trades = await db.select().from(rawTokenTrades)
      .where(gte(rawTokenTrades.timestamp, since6HoursAgo));

    tracer.log(`Retrieved ${trades.length} trades`, "debug", {
      dbReads: 1,
      latencyMs: Date.now() - startTime
    });

    // Create candles
    const candles = groupAndAggregate(trades);
    
    tracer.log(`Created ${candles.length} OHLCV candles`, "info", {
      latencyMs: Date.now() - startTime
    });

    // Insert candles
    await db.insert(priceHistoryCache).values(candles);
    
    tracer.log(`Inserted ${candles.length} candles`, "info", {
      dbWrites: candles.length,
      latencyMs: Date.now() - startTime
    });

    // Delete old trades
    await db.delete(rawTokenTrades).where(lt(...));
    
    tracer.log(`Deleted ${trades.length} old trades`, "info", {
      dbDeletes: trades.length,
      latencyMs: tracer.end(true)
    });

    return {
      tradesSummarized: trades.length,
      candlesCreated: candles.length
    };
  } catch (error) {
    logPipeline("trades", "Trade summarization failed", "error", {
      error: error instanceof Error ? error.message : "Unknown"
    });
    tracer.end(false);
    throw error;
  }
}
```

### Stage 6: Retrolearner Cycle

```typescript
// In retrolearner.ts

export async function performRetrolearningCycle() {
  const cycleTracer = createPipelineTracer("retrolearner", "cycle");
  cycleTracer.start();

  try {
    // Step 0: Trade summarization
    const step0Tracer = createPipelineTracer("retrolearner", "step0_summarize");
    step0Tracer.start();
    const tradeStats = await summarizeRawTrades(...);
    const step0Duration = step0Tracer.end(true);

    logPipeline("retrolearner", `Step 0: Trade summarization`, "info", {
      metrics: {
        latencyMs: step0Duration,
        dbReads: 1,
        dbWrites: tradeStats.candlesCreated,
        dbDeletes: tradeStats.tradesSummarized
      }
    });

    // Step 1: ANN training
    const step1Tracer = createPipelineTracer("retrolearner", "step1_ann_train");
    step1Tracer.start();
    const annMetrics = await trainANNModel(100);
    const step1Duration = step1Tracer.end(true);

    logPipeline("retrolearner", `Step 1: ANN training`, "info", {
      metrics: {
        latencyMs: step1Duration,
        dbReads: annMetrics.samplesUsed
      }
    });

    // ... Steps 2-5 similarly ...

    cycleTracer.log("Retrolearner cycle complete", "info", {
      metrics: {
        latencyMs: cycleTracer.end(true)
      }
    });
  } catch (error) {
    logPipeline("retrolearner", "Retrolearner cycle failed", "error", {
      error: error instanceof Error ? error.message : "Unknown"
    });
    cycleTracer.end(false);
  }
}
```

## Metrics Tracking

### API Call Tracking

```typescript
// Track each API call
logPipeline("api", "PumpPortal subscription update", "debug", {
  metrics: {
    apiCalls: 1 // PumpPortal message
  }
});

logPipeline("api", "Pump SDK bonding curve check", "debug", {
  metrics: {
    apiCalls: 1 // RPC call
  }
});

logPipeline("api", "DexScreener trending check", "debug", {
  metrics: {
    apiCalls: 1 // HTTP request
  }
});
```

### Database Operation Tracking

```typescript
// Track DB reads
logPipeline("db", "Fetched token metadata", "debug", {
  metrics: {
    dbReads: 1
  }
});

// Track DB writes
logPipeline("db", "Stored new snapshot", "debug", {
  metrics: {
    dbWrites: 1
  }
});

// Track deletes
logPipeline("db", "Deleted old trades", "debug", {
  metrics: {
    dbDeletes: 500
  }
});
```

### Performance Tracking

```typescript
const startMs = Date.now();

// ... operation ...

const latencyMs = Date.now() - startMs;

logPipeline("features", "Feature extraction complete", "info", {
  metrics: {
    latencyMs,
    dbReads: 5,
    dbWrites: 0,
    memoryMb: process.memoryUsage().rss / 1024 / 1024
  }
});
```

## Accessing Logs & Metrics

### Get Recent Events

```typescript
import { getPipelineEvents, getPipelineMetrics } from "./system-logger";

// Get last 100 events
const recent = getPipelineEvents(100);

// Get current metrics
const metrics = getPipelineMetrics();
console.log(`Active tokens: ${metrics.activeTokens}`);
console.log(`API calls this hour: ${metrics.apiUsage.pumpPortal}`);
console.log(`Memory usage: ${metrics.memory}MB`);
```

### Create API Endpoint for Monitoring

```typescript
// In routes.ts
app.get("/api/system/logs", (req, res) => {
  const count = req.query.count ? parseInt(req.query.count) : 100;
  const events = getPipelineEvents(count);
  const metrics = getPipelineMetrics();

  res.json({
    metrics,
    recentEvents: events,
    eventCount: events.length
  });
});

app.get("/api/system/metrics", (req, res) => {
  const metrics = getPipelineMetrics();
  res.json(metrics);
});
```

### Dashboard Example

```typescript
// Create a simple dashboard that shows:
// - Active tokens count
// - Monitoring capacity %
// - API calls vs limits (hourly)
// - DB operations (hourly)
// - Latency metrics (average)
// - Error count
// - Last errors

function renderDashboard(metrics: SystemMetricsSnapshot) {
  return `
    === Penny-Pincher2 System Status ===
    
    MONITORING
    Active Tokens: ${metrics.activeTokens}
    Active Snapshots: ${metrics.activeSnapshots}
    Capacity: ${metrics.capacityPercent.toFixed(1)}%
    
    API USAGE (Hourly)
    PumpPortal: ${metrics.apiUsage.pumpPortal} / unlimited
    DexPaprika: ${metrics.apiUsage.dexPaprika} / 12,000
    DexScreener: ${metrics.apiUsage.dexScreener} / 1,200
    Chainstack: ${metrics.apiUsage.chainstack} / 104
    
    DATABASE (Hourly)
    Reads: ${metrics.dbOps.reads}
    Writes: ${metrics.dbOps.writes}
    Deletes: ${metrics.dbOps.deletes}
    
    PERFORMANCE (Averages)
    Feature Extraction: ${metrics.avgLatencies.feature}ms
    ANN Inference: ${metrics.avgLatencies.ann}ms
    DB Write: ${metrics.avgLatencies.dbWrite}ms
    API Call: ${metrics.avgLatencies.api}ms
    
    SYSTEM
    Memory: ${metrics.memory}MB
    CPU: ${metrics.cpu}%
    Errors (hour): ${metrics.errors}
  `;
}
```

## Flushing to Database

### Periodic Flush

```typescript
import { startPeriodicFlushing } from "./system-logger";

// In index.ts startup
startPeriodicFlushing(5 * 60 * 1000); // Flush every 5 minutes
```

### Manual Flush

```typescript
import { flushPipelineLogs } from "./system-logger";

// Flush on demand
const flushed = await flushPipelineLogs();
console.log(`Flushed ${flushed} events to database`);
```

### Crash Dump

```typescript
import { pipelineCrashDump } from "./system-logger";

// Automatic on crash, but can trigger manually
process.on("SIGTERM", async () => {
  console.log("Graceful shutdown, flushing logs...");
  await pipelineCrashDump();
  process.exit(0);
});
```

## Data Flow for Analysis

The logged events in the in-memory buffer preserve:

1. **Complete execution trace** - Every operation from discovery to result
2. **API call costs** - Track usage against limits
3. **Database operations** - Reads, writes, deletes with context
4. **Latencies** - Performance metrics at each stage
5. **Errors** - Full error context and stack traces
6. **Resource usage** - Memory and CPU at operation time

### Example Analysis Queries

```typescript
// Find slow operations
const slowOps = getPipelineEvents(1000)
  .filter(e => e.metrics?.latencyMs && e.metrics.latencyMs > 500);

// Find error patterns
const errors = getPipelineEvents(1000)
  .filter(e => e.level === "error");
const errorsByCategory = {};
errors.forEach(e => {
  errorsByCategory[e.category] = (errorsByCategory[e.category] || 0) + 1;
});

// Track API usage
const apiEvents = getPipelineEvents(1000)
  .filter(e => e.category === "api");
const totalApiCalls = apiEvents.reduce((sum, e) => sum + (e.metrics?.apiCalls || 0), 0);
```

## Next Steps

1. **Integrate into all major operations** - Add logging to discovery, features, snapshots, trades
2. **Create monitoring dashboard** - Real-time view of metrics
3. **Set up database schema** - Create system_logs table for persistent storage
4. **Configure alerts** - Alert when capacity > 85%, errors spike, latencies exceed thresholds
5. **Periodic analysis** - Daily/weekly reports on API usage, performance, errors
