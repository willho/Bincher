/**
 * Latency Monitor Service
 *
 * Continuously samples Jupiter swap quote latency and slippage.
 * Maintains rolling 5-minute window of measurements.
 * Snapshots use worst-case values from last 3 seconds.
 */

interface LatencySample {
  timestamp: number; // Unix seconds
  latencyMs: number;
  slippagePercent: number;
}

class LatencyMonitor {
  private samples: LatencySample[] = [];
  private readonly WINDOW_SIZE_SECONDS = 300; // 5 minutes
  private readonly PRUNE_INTERVAL_MS = 1000; // Check every 1 second
  private isRunning = false;

  /**
   * Start monitoring Jupiter latency
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log("Starting latency monitor (Jupiter quotes every 1s)...");

    // Sample every 1 second
    setInterval(() => this.sampleJupiterLatency(), 1000);

    // Prune old data every 1 second
    setInterval(() => this.pruneOldSamples(), 1000);
  }

  /**
   * Sample Jupiter quote latency
   */
  private async sampleJupiterLatency() {
    try {
      const startTime = Date.now();

      // Sample swap: 1 SOL → random token (use USDC as stable target)
      const response = await fetch(
        "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWaLb3hyccqaTo2hDpAQiicRH2t8UV9hjYYEUqpQ&amount=1000000000&slippageBps=500",
        {
          method: "GET",
          headers: { "User-Agent": "Penny-Pincher2/1.0" },
        }
      );

      const latency = Date.now() - startTime;

      if (!response.ok) {
        console.warn(`Jupiter quote failed: ${response.status}`);
        return;
      }

      const data = (await response.json()) as any;

      // Extract slippage from quote
      const inputAmount = parseFloat(data.inAmount || "1000000000");
      const outputAmount = parseFloat(data.outAmount || "0");
      const priceImpact = data.priceImpactPct || 0;

      this.samples.push({
        timestamp: Math.floor(Date.now() / 1000),
        latencyMs: latency,
        slippagePercent: Math.abs(priceImpact),
      });

      // Log every 10 samples (every 10 seconds)
      if (this.samples.length % 10 === 0) {
        const recent = this.samples.slice(-10);
        const avgLatency =
          recent.reduce((sum, s) => sum + s.latencyMs, 0) / recent.length;
        const avgSlippage =
          recent.reduce((sum, s) => sum + s.slippagePercent, 0) / recent.length;
        console.log(
          `[LatencyMonitor] Samples: ${this.samples.length}, Avg latency: ${avgLatency.toFixed(1)}ms, Avg slippage: ${avgSlippage.toFixed(3)}%`
        );
      }
    } catch (error) {
      console.warn(`Latency sample failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Remove samples older than 5 minutes
   */
  private pruneOldSamples() {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - this.WINDOW_SIZE_SECONDS;

    const beforeCount = this.samples.length;
    this.samples = this.samples.filter((s) => s.timestamp > cutoff);

    if (this.samples.length < beforeCount && this.samples.length % 50 === 0) {
      console.log(`[LatencyMonitor] Pruned to ${this.samples.length} recent samples`);
    }
  }

  /**
   * Get worst latency and slippage from last N seconds
   */
  getWorstInWindow(windowSeconds: number = 3): {
    worstLatencyMs: number;
    worstSlippagePercent: number;
    sampleCount: number;
  } {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - windowSeconds;

    const recentSamples = this.samples.filter((s) => s.timestamp > cutoff);

    if (recentSamples.length === 0) {
      // No recent samples, return safe defaults
      return {
        worstLatencyMs: 1000, // Assume worst case
        worstSlippagePercent: 5.0, // Assume worst case
        sampleCount: 0,
      };
    }

    return {
      worstLatencyMs: Math.max(...recentSamples.map((s) => s.latencyMs)),
      worstSlippagePercent: Math.max(...recentSamples.map((s) => s.slippagePercent)),
      sampleCount: recentSamples.length,
    };
  }

  /**
   * Get statistics for last N seconds
   */
  getStats(windowSeconds: number = 300) {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - windowSeconds;

    const windowSamples = this.samples.filter((s) => s.timestamp > cutoff);

    if (windowSamples.length === 0) {
      return {
        totalSamples: 0,
        minLatency: 0,
        maxLatency: 0,
        avgLatency: 0,
        p95Latency: 0,
        minSlippage: 0,
        maxSlippage: 0,
        avgSlippage: 0,
      };
    }

    const latencies = windowSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const slippages = windowSamples.map((s) => s.slippagePercent).sort((a, b) => a - b);

    return {
      totalSamples: windowSamples.length,
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies),
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95Latency: latencies[Math.floor(latencies.length * 0.95)],
      minSlippage: Math.min(...slippages),
      maxSlippage: Math.max(...slippages),
      avgSlippage: slippages.reduce((a, b) => a + b, 0) / slippages.length,
    };
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      samplesCollected: this.samples.length,
      windowSeconds: this.WINDOW_SIZE_SECONDS,
      stats: this.getStats(300),
    };
  }
}

// Export singleton instance
export const latencyMonitor = new LatencyMonitor();
