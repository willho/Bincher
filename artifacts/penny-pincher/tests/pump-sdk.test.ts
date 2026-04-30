/**
 * Pump SDK Test Suite
 * Tests SDK functionality, performance, and identifies any limits
 */

import { initializePumpSdk, fetchBondingCurveProgress, isTokenGraduated, getBondingCurvePercentage } from "../server/pump-sdk-client";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

interface TestResult {
  name: string;
  status: "pass" | "fail" | "error";
  duration: number;
  details?: any;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, status: "pass", duration });
    console.log(`✓ ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.push({
      name,
      status: "error",
      duration,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(`✗ ${name} (${duration}ms):`, error instanceof Error ? error.message : error);
  }
}

async function runTests(): Promise<void> {
  console.log("[PumpSDK Test Suite] Starting...\n");

  // Test 1: Initialization
  await test("SDK Initialization", async () => {
    await initializePumpSdk();
  });

  // Test 2: Fetch bonding curve for a pre-grad token
  // Using a token that should be in bonding curve
  const preGradToken = "8tPvn5v2N9p7vRJ4YmvF5JRMN9vQ5X7D2J8vK3p2L9q";
  await test("Fetch bonding curve (pre-grad token)", async () => {
    const result = await fetchBondingCurveProgress(preGradToken);
    if (!result) throw new Error("No result returned");
    console.log(`  Market Cap: ${result.marketCap}, Progress: ${result.progressBps}bps (${result.progressBps / 100}%), Graduated: ${result.isGraduated}`);
  });

  // Test 3: Check if token is graduated
  await test("Check if token graduated", async () => {
    const graduated = await isTokenGraduated(preGradToken);
    console.log(`  Token graduated: ${graduated}`);
  });

  // Test 4: Get bonding curve percentage
  await test("Get bonding curve percentage", async () => {
    const percentage = await getBondingCurvePercentage(preGradToken);
    console.log(`  Bonding curve: ${percentage}%`);
  });

  // Test 5: Test with invalid mint
  await test("Handle invalid mint gracefully", async () => {
    const result = await fetchBondingCurveProgress("invalid_mint_address");
    if (result !== null) throw new Error("Expected null for invalid mint");
    console.log(`  Returned null as expected`);
  });

  // Test 6: Measure latency on batch calls
  await test("Batch latency test (10 sequential calls)", async () => {
    const mints = [
      preGradToken,
      "6rnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "7rnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "8rnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "9rnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "ArnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "BrnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "CrnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "DrnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
      "ErnZLCM4C8qBJVD4vCJCW7W5cW5J7W5vC7W5X8Y9Z",
    ];

    const batchStart = Date.now();
    const batchResults = await Promise.all(
      mints.map(mint => fetchBondingCurveProgress(mint).catch(() => null))
    );
    const batchDuration = Date.now() - batchStart;

    const successCount = batchResults.filter(r => r !== null).length;
    console.log(`  10 calls in ${batchDuration}ms (${(batchDuration / 10).toFixed(1)}ms per call), ${successCount} successful`);
  });

  // Test 7: Check all available SDK methods
  await test("List available SDK methods", async () => {
    const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
    const sdk = new OnlinePumpSdk(connection);

    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(sdk))
      .filter(m => typeof (sdk as any)[m] === 'function' && m !== 'constructor');

    console.log(`  Available methods:`);
    methods.forEach(m => console.log(`    - ${m}`));
  });

  // Print summary
  console.log("\n[Test Summary]");
  const passed = results.filter(r => r.status === "pass").length;
  const failed = results.filter(r => r.status === "fail").length;
  const errors = results.filter(r => r.status === "error").length;

  console.log(`Total: ${results.length} tests`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`✗ Errors: ${errors}`);

  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  console.log(`Total duration: ${totalDuration}ms`);
  console.log(`Average per test: ${(totalDuration / results.length).toFixed(1)}ms`);

  // Check for rate limits
  const avgLatency = totalDuration / (results.length - 1); // exclude init test
  console.log(`\n[Performance Analysis]`);
  console.log(`Average call latency: ${avgLatency.toFixed(1)}ms`);
  console.log(`Estimated calls/sec: ${(1000 / avgLatency).toFixed(1)}`);
  console.log(`Estimated calls/hour: ${(3600000 / avgLatency).toFixed(0)}`);

  // List any errors
  if (errors > 0) {
    console.log(`\n[Errors]`);
    results.filter(r => r.status === "error").forEach(r => {
      console.log(`${r.name}: ${r.error}`);
    });
  }
}

// Run tests
runTests().catch(console.error);
