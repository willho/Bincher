/**
 * DexPaprika SSE Latency Test - Real Trade Streaming
 *
 * Measures real-time latency of DexPaprika SSE trade streaming:
 * 1. Fetch trending tokens from DexScreener
 * 2. Subscribe to DexPaprika SSE for live trade events
 * 3. Measure latency from trade timestamp to client receipt
 * 4. Report P50, P95, P99 percentiles
 */

import axios from "axios";
// @ts-ignore
import { EventSource } from "eventsource";

interface TradeEvent {
  mint: string;
  price: number;
  volume: number;
  timestamp: number;
  [key: string]: any;
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

const TEST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOKENS = 15;

let tradesReceived = 0;
let tradeLatencies: number[] = [];
const tokenCounts = new Map<string, number>();

/**
 * Fetch trending tokens - use hardcoded popular tokens if API fails
 */
async function getTrendingTokens(): Promise<string[]> {
  console.log("[DexScreener] Fetching trending tokens...");

  // Fallback: popular Solana tokens with active trading
  const fallbackTokens = [
    "So11111111111111111111111111111111111111112", // SOL
    "EPjFWaLb3crLvSm3DRH6DA9UA98md2AewEAUShtHsFAP", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenErt", // USDT
    "7kHv5D5V384E7LNbSrRDhWBxnqJ2Z5B834x3SNUjysEm", // COPE
    "DUSTawucrTsGU8hcqyL5FSVSuJ8RD6YvWEAhjGtXMwxx", // DUST
    "bSo13r4TkiE4KumL71LsqwLvMKLDVF699jYXstEaAsS", // bSOL
    "jupSolatWQQtfmXxGPbXknwQaNauGztB份", // JUP
  ];

  try {
    const response = await axios.get(
      "https://api.dexscreener.com/latest/dex/tokens/solana/trending",
      {
        timeout: 10000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://dexscreener.com/",
          Accept: "application/json",
        },
      }
    );

    const tokens = response.data
      .slice(0, MAX_TOKENS)
      .map((t: any) => t.address || t.mint)
      .filter((m: string) => m && m.length > 30);

    console.log(`[DexScreener] ✓ Found ${tokens.length} trending tokens`);
    return tokens;
  } catch (error) {
    console.warn(
      "[DexScreener] Could not fetch trending tokens, using fallback:",
      error instanceof Error ? error.message : error
    );
    return fallbackTokens.slice(0, MAX_TOKENS);
  }
}

/**
 * Subscribe to DexPaprika SSE and stream trades
 */
async function subscribeDexPaprikaSSE(mints: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tokenList = mints.join(",");
    const url = `https://streaming.dexpaprika.com/stream?tokens=${tokenList}&method=t_p`;

    console.log(
      `[DexPaprika] Subscribing to SSE for ${mints.length} tokens...`
    );
    console.log(`[DexPaprika] URL: ${url.substring(0, 80)}...`);

    const startTime = Date.now();
    let isOpen = false;

    const es = new EventSource(url);

    es.onopen = () => {
      isOpen = true;
      console.log("[DexPaprika] ✓ SSE connection established");
    };

    es.onmessage = (event) => {
      if (!isOpen) isOpen = true;

      try {
        const trade = JSON.parse(event.data) as TradeEvent;

        tradesReceived++;
        const clientTimestamp = Date.now();
        const tradeTimestamp = (trade.timestamp || 0) * 1000;
        const latency = clientTimestamp - tradeTimestamp;

        if (latency >= 0 && latency < 60000) {
          tradeLatencies.push(latency);
        }

        tokenCounts.set(trade.mint, (tokenCounts.get(trade.mint) || 0) + 1);

        if (tradesReceived % 100 === 0) {
          const avgLat = Math.round(
            tradeLatencies.reduce((a, b) => a + b, 0) / tradeLatencies.length
          );
          console.log(
            `[DexPaprika] Received ${tradesReceived} trades, avg latency: ${avgLat}ms`
          );
        }
      } catch (e) {
        // Malformed JSON, skip
      }

      // Check test duration
      if (Date.now() - startTime > TEST_DURATION_MS) {
        console.log("[DexPaprika] Test duration complete, closing...");
        es.close();
        resolve();
      }
    };

    es.onerror = (error) => {
      console.error("[DexPaprika] SSE Error:", error);
      es.close();
      if (!isOpen) {
        reject(
          new Error(
            "Failed to connect to DexPaprika SSE. Check endpoint and network."
          )
        );
      } else {
        resolve();
      }
    };
  });
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
  console.log("=".repeat(70));
  console.log("DexPaprika SSE Real Trade Latency Test");
  console.log("=".repeat(70));
  console.log(`Duration: ${TEST_DURATION_MS / 1000 / 60} minutes`);
  console.log(`Max tokens: ${MAX_TOKENS}\n`);

  try {
    // Get trending tokens
    const tokens = await getTrendingTokens();

    if (tokens.length === 0) {
      throw new Error("No tokens found");
    }

    // Subscribe to SSE stream
    await subscribeDexPaprikaSSE(tokens);

    // Calculate and report stats
    const stats = calculateStats();

    console.log("\n" + "=".repeat(70));
    console.log("LATENCY RESULTS");
    console.log("=".repeat(70));
    console.log(`Total trades received: ${stats.tradeCount}`);

    if (stats.tradeCount > 0) {
      console.log(`Latency percentiles:`);
      console.log(`  Min:  ${Math.round(stats.minLatency)}ms`);
      console.log(`  P50:  ${Math.round(stats.p50Latency)}ms`);
      console.log(`  P95:  ${Math.round(stats.p95Latency)}ms`);
      console.log(`  P99:  ${Math.round(stats.p99Latency)}ms`);
      console.log(`  Avg:  ${Math.round(stats.avgLatency)}ms`);
      console.log(`  Max:  ${Math.round(stats.maxLatency)}ms`);
    } else {
      console.log("⚠ No trades received - check API connectivity");
    }

    if (tokenCounts.size > 0) {
      console.log(`\nTop active tokens:`);
      Array.from(tokenCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([mint, count], i) => {
          console.log(`  ${i + 1}. ${mint.slice(0, 8)}... (${count} trades)`);
        });
    }

    console.log("\n" + "=".repeat(70));
    console.log("ASSESSMENT");
    console.log("=".repeat(70));

    if (stats.p95Latency > 0) {
      const p95 = stats.p95Latency;
      if (p95 < 2000) {
        console.log("✓ EXCELLENT: P95 < 2s (real-time viable)");
      } else if (p95 < 5000) {
        console.log("✓ ACCEPTABLE: P95 < 5s (acceptable latency)");
      } else if (p95 < 10000) {
        console.log("⚠ MARGINAL: P95 < 10s (may miss fast trades)");
      } else {
        console.log("✗ POOR: P95 > 10s (not suitable for monitoring)");
      }
    }

    console.log("=".repeat(70) + "\n");
  } catch (error) {
    console.error("\n✗ Test failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

runTest().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
