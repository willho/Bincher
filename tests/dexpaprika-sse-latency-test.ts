/**
 * DexPaprika SSE Latency Test
 *
 * Measures real-time latency of DexPaprika SSE trade streaming:
 * 1. Fetch trending tokens from DexScreener
 * 2. Subscribe to those tokens via DexPaprika SSE
 * 3. Measure latency from trade occurrence to SSE receipt
 * 4. Report statistics
 */

import axios from "axios";

interface TrendingToken {
  mint: string;
  symbol: string;
  volume24h?: number;
}

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

const TEST_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOKENS = 20;
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const DEXPAPRIKA_SSE = "https://api.dexpaprika.com/v1/sse/trades";

let tradesReceived = 0;
let tradeLatencies: number[] = [];
const tokenLastSeen = new Map<string, number>();

/**
 * Fetch trending tokens from DexScreener or use fallback
 */
async function getTrendingTokens(): Promise<TrendingToken[]> {
  // Fallback tokens (popular high-volume tokens)
  const fallbackTokens: TrendingToken[] = [
    { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", volume24h: 0 },
    { mint: "EPjFWaLb3crLvSm3DRH6DA9UA98md2AewEAUShtHsFAP", symbol: "USDC", volume24h: 0 },
    { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenErt", symbol: "USDT", volume24h: 0 },
    { mint: "7kHv5D5V384E7LNbSrRDhWBxnqJ2Z5B834x3SNUjysEm", symbol: "COPE", volume24h: 0 },
    { mint: "DUSTawucrTsGU8hcqyL5FSVSuJ8RD6YvWEAhjGtXMwxx", symbol: "DUST", volume24h: 0 },
  ];

  try {
    console.log("[Test] Fetching trending tokens from DexScreener...");

    const response = await axios.get(`${DEXSCREENER_API}/tokens/solana/trending`, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });

    const tokens: TrendingToken[] = response.data
      .slice(0, MAX_TOKENS)
      .map((token: any) => ({
        mint: token.address || token.mint,
        symbol: token.symbol || "UNKNOWN",
        volume24h: token.volume24h || 0,
      }));

    console.log(
      `[Test] ✓ Found ${tokens.length} trending tokens`
    );
    console.log(
      `[Test] Tokens: ${tokens.map((t) => t.symbol).join(", ")}`
    );

    return tokens;
  } catch (error) {
    console.warn(
      "[Test] Warning: Could not fetch from DexScreener, using fallback tokens:",
      error instanceof Error ? error.message : error
    );
    console.log(`[Test] Using ${fallbackTokens.length} fallback tokens for testing`);
    return fallbackTokens;
  }
}

/**
 * Subscribe to DexPaprika SSE for trade data
 */
async function subscribeDexPaprikaSSE(mints: string[]): Promise<void> {
  try {
    console.log(`\n[Test] Subscribing to DexPaprika SSE for ${mints.length} tokens...`);

    // Try multiple URL formats
    const urls = [
      `${DEXPAPRIKA_SSE}?tokens=${mints.join(",")}&method=t_p`,
      `https://streaming.dexpaprika.com/stream?chain=solana&tokens=${mints.join(",")}`,
      `https://api.dexpaprika.com/v1/sse/stream?tokens=${mints.join(",")}`,
    ];

    let response;
    let successUrl = "";

    for (const url of urls) {
      try {
        console.log(`[Test] Trying: ${url.substring(0, 80)}...`);
        response = await axios.get(url, {
          timeout: 5000,
          responseType: "stream",
          headers: {
            Accept: "text/event-stream",
            "User-Agent": "Mozilla/5.0",
          },
        });
        successUrl = url;
        break;
      } catch (e) {
        // Try next URL
        continue;
      }
    }

    if (!response) {
      throw new Error("All DexPaprika SSE endpoints failed");
    }

    console.log(`[Test] ✓ Connected to: ${successUrl.substring(0, 60)}...`);

    console.log(`[Test] ✓ Connected to SSE stream`);

    const startTime = Date.now();
    let connectionLive = true;

    response.data.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");

      for (const line of lines) {
        if (!line.trim() || line.startsWith(":")) continue;

        // Parse SSE format: "data: {...}"
        if (line.startsWith("data: ")) {
          try {
            const jsonStr = line.substring(6);
            const event = JSON.parse(jsonStr) as TradeEvent;

            tradesReceived++;
            const clientTimestamp = Date.now();
            const tradeTimestamp = event.timestamp * 1000; // Convert to ms if needed
            const latency = clientTimestamp - tradeTimestamp;

            // Only count reasonable latencies (0-60s)
            if (latency >= 0 && latency < 60000) {
              tradeLatencies.push(latency);
              tokenLastSeen.set(event.mint, clientTimestamp);

              if (tradesReceived % 50 === 0) {
                console.log(
                  `[Test] Received ${tradesReceived} trades, avg latency: ${Math.round(
                    tradeLatencies.reduce((a, b) => a + b, 0) / tradeLatencies.length
                  )}ms`
                );
              }
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }

      // Check if test duration exceeded
      if (Date.now() - startTime > TEST_DURATION_MS) {
        connectionLive = false;
        response.data.destroy();
      }
    });

    response.data.on("error", (error: any) => {
      console.error("[Test] SSE error:", error.message);
      connectionLive = false;
    });

    response.data.on("end", () => {
      console.log("[Test] SSE connection closed");
      connectionLive = false;
    });

    // Wait for test duration or connection close
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!connectionLive || Date.now() - startTime > TEST_DURATION_MS) {
          clearInterval(checkInterval);
          response.data.destroy();
          resolve();
        }
      }, 1000);
    });
  } catch (error) {
    console.error(
      "[Test] Error subscribing to DexPaprika SSE:",
      error instanceof Error ? error.message : error
    );
    throw error;
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
  console.log(`Test duration: ${TEST_DURATION_MS / 1000}s`);
  console.log(`Max tokens: ${MAX_TOKENS}\n`);

  try {
    // Get trending tokens
    const trendingTokens = await getTrendingTokens();
    const mints = trendingTokens.map((t) => t.mint);

    // Subscribe to SSE
    await subscribeDexPaprikaSSE(mints);

    // Calculate and report stats
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

    console.log(`\nTokens monitored: ${tokenLastSeen.size}`);
    if (tokenLastSeen.size > 0) {
      const tokenList = Array.from(tokenLastSeen.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([mint], i) => {
          const token = trendingTokens.find((t) => t.mint === mint);
          return `${i + 1}. ${token?.symbol || mint.slice(0, 8)}`;
        })
        .join("\n       ");
      console.log(`  Most active:\n       ${tokenList}`);
    }

    console.log("\n" + "=".repeat(60));
    console.log("ASSESSMENT");
    console.log("=".repeat(60));

    const p95 = stats.p95Latency;
    if (p95 < 2000) {
      console.log("✓ EXCELLENT: P95 latency < 2s (real-time viable)");
    } else if (p95 < 5000) {
      console.log("✓ ACCEPTABLE: P95 latency < 5s (acceptable for monitoring)");
    } else if (p95 < 10000) {
      console.log("⚠ MARGINAL: P95 latency < 10s (may miss fast trades)");
    } else {
      console.log("✗ POOR: P95 latency > 10s (not suitable)");
    }

    if (stats.tradeCount < 50) {
      console.log("⚠ WARNING: Low trade volume during test (may be off-peak)");
    }

    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\nTest failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run test
runTest().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
