/**
 * DexPaprika SSE Latency Test
 *
 * Measures real-time latency of DexPaprika SSE trade streaming.
 *
 * TODO: Replace mock data with actual DexPaprika SSE connection
 * - Fetch trending tokens from DexScreener
 * - Subscribe to https://api.dexpaprika.com/v1/sse/trades
 * - Measure latency from trade timestamp to receipt
 */

import axios from "axios";

interface TradeEvent {
  mint: string;
  price: number;
  priceUsd?: number;
  volume: number;
  timestamp: number;
}

interface LatencyMeasurement {
  tradeCount: number;
  latencies: number[];
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
}

const TEST_DURATION_MS = 10000; // 10 seconds for quick testing
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";

let tradesReceived = 0;
let tradeLatencies: number[] = [];

/**
 * Simulate trade events for testing
 * TODO: Replace with actual DexPaprika SSE stream
 */
function* simulateTradeStream(): Generator<TradeEvent> {
  const mints = [
    "So11111111111111111111111111111111111111112", // SOL
    "EPjFWaLb3crLvSm3DRH6DA9UA98md2AewEAUShtHsFAP", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenErt", // USDT
  ];

  let tradeId = 0;
  while (true) {
    const now = Math.floor(Date.now() / 1000);
    const randomLatency = Math.random() * 3000; // 0-3s simulated latency
    const tradeTime = now - Math.floor(randomLatency / 1000);

    yield {
      mint: mints[tradeId % mints.length],
      price: Math.random() * 100,
      volume: Math.random() * 1000,
      timestamp: tradeTime,
    };

    tradeId++;
  }
}

/**
 * Stream trades and measure latency
 */
async function streamTradesWithLatency(): Promise<void> {
  console.log("[Test] Starting trade stream simulation...");
  const generator = simulateTradeStream();
  const startTime = Date.now();

  while (Date.now() - startTime < TEST_DURATION_MS) {
    const event = generator.next().value as TradeEvent | undefined;

    if (!event) {
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }

    tradesReceived++;
    const clientTimestamp = Date.now();
    const tradeTimestamp = event.timestamp * 1000;
    const latency = clientTimestamp - tradeTimestamp;

    if (latency >= 0 && latency < 60000) {
      tradeLatencies.push(latency);
    }

    if (tradesReceived % 50 === 0) {
      const avgLat = Math.round(
        tradeLatencies.reduce((a, b) => a + b, 0) / tradeLatencies.length
      );
      console.log(
        `[Test] Received ${tradesReceived} trades, avg latency: ${avgLat}ms`
      );
    }

    // Simulate arrival rate
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Calculate latency statistics
 */
function calculateStats(): LatencyMeasurement {
  if (tradeLatencies.length === 0) {
    return {
      tradeCount: 0,
      latencies: [],
      minLatency: 0,
      maxLatency: 0,
      avgLatency: 0,
      p50Latency: 0,
      p95Latency: 0,
      p99Latency: 0,
    };
  }

  const sorted = [...tradeLatencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    tradeCount: tradesReceived,
    latencies: sorted,
    minLatency: sorted[0],
    maxLatency: sorted[sorted.length - 1],
    avgLatency: sum / sorted.length,
    p50Latency: sorted[Math.floor(sorted.length * 0.5)],
    p95Latency: sorted[Math.floor(sorted.length * 0.95)],
    p99Latency: sorted[Math.floor(sorted.length * 0.99)],
  };
}

/**
 * Run the test
 */
async function runTest(): Promise<void> {
  console.log("=".repeat(60));
  console.log("DexPaprika SSE Latency Test");
  console.log("=".repeat(60));
  console.log(`Test duration: ${TEST_DURATION_MS / 1000}s (simulated data)`);
  console.log();

  try {
    // Run trade stream
    await streamTradesWithLatency();

    // Calculate stats
    const stats = calculateStats();

    console.log("\n" + "=".repeat(60));
    console.log("RESULTS");
    console.log("=".repeat(60));
    console.log(`Trades received: ${stats.tradeCount}`);
    console.log(`Latency percentiles:`);
    console.log(`  Min:  ${Math.round(stats.minLatency)}ms`);
    console.log(`  P50:  ${Math.round(stats.p50Latency)}ms`);
    console.log(`  P95:  ${Math.round(stats.p95Latency)}ms`);
    console.log(`  P99:  ${Math.round(stats.p99Latency)}ms`);
    console.log(`  Avg:  ${Math.round(stats.avgLatency)}ms`);
    console.log(`  Max:  ${Math.round(stats.maxLatency)}ms`);

    console.log("\n" + "=".repeat(60));
    console.log("NOTES");
    console.log("=".repeat(60));
    console.log("⚠ Using simulated trade data for testing framework");
    console.log("✓ Framework ready for DexPaprika SSE integration");
    console.log("\nNext steps:");
    console.log("1. Connect to DexPaprika SSE: https://api.dexpaprika.com/v1/sse/trades");
    console.log("2. Fetch trending tokens from DexScreener");
    console.log("3. Run against real market data");
    console.log("4. Measure actual latency percentiles");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("Test failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

runTest().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
