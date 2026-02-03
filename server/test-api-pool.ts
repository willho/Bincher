/**
 * API Pool Test Script
 * 
 * Tests rate limits and data quality for:
 * - Solscan (unofficial API)
 * - Solana FM
 * - Helius (baseline comparison)
 * 
 * Run with: npx tsx server/test-api-pool.ts
 */

const TEST_WALLET = "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"; // Known active wallet
const TEST_TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK

interface TestResult {
  source: string;
  endpoint: string;
  success: boolean;
  latencyMs: number;
  dataCount?: number;
  error?: string;
  rateLimited?: boolean;
}

const results: TestResult[] = [];

async function testEndpoint(
  source: string,
  endpoint: string,
  url: string,
  headers?: Record<string, string>
): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(url, { headers });
    const latencyMs = Date.now() - start;
    
    if (response.status === 429) {
      return { source, endpoint, success: false, latencyMs, rateLimited: true, error: "Rate limited (429)" };
    }
    
    if (!response.ok) {
      return { source, endpoint, success: false, latencyMs, error: `HTTP ${response.status}` };
    }
    
    const data = await response.json();
    let dataCount = 0;
    
    if (Array.isArray(data)) {
      dataCount = data.length;
    } else if (data.data && Array.isArray(data.data)) {
      dataCount = data.data.length;
    } else if (data.result && Array.isArray(data.result)) {
      dataCount = data.result.length;
    } else if (typeof data === 'object') {
      dataCount = Object.keys(data).length;
    }
    
    return { source, endpoint, success: true, latencyMs, dataCount };
  } catch (error: any) {
    return { source, endpoint, success: false, latencyMs: Date.now() - start, error: error.message };
  }
}

async function testSolscan() {
  console.log("\n=== Testing Solscan ===");
  
  const tests = [
    {
      name: "account_transactions",
      url: `https://api.solscan.io/v2/account/transactions?address=${TEST_WALLET}&limit=10`
    },
    {
      name: "token_holders",
      url: `https://api.solscan.io/v2/token/holders?token=${TEST_TOKEN}&limit=20`
    },
    {
      name: "token_meta",
      url: `https://api.solscan.io/v2/token/meta?token=${TEST_TOKEN}`
    }
  ];
  
  for (const test of tests) {
    const result = await testEndpoint("solscan", test.name, test.url);
    results.push(result);
    console.log(`  ${test.name}: ${result.success ? '✓' : '✗'} ${result.latencyMs}ms${result.dataCount !== undefined ? ` (${result.dataCount} items)` : ''}${result.error ? ` - ${result.error}` : ''}`);
    await sleep(100);
  }
  
  console.log("\n  Rate limit test (rapid fire 25 requests)...");
  let rateLimitHit = 0;
  let successCount = 0;
  for (let i = 0; i < 25; i++) {
    const result = await testEndpoint("solscan", `rapid_${i}`, `https://api.solscan.io/v2/token/meta?token=${TEST_TOKEN}`);
    if (result.rateLimited) rateLimitHit++;
    else if (result.success) successCount++;
  }
  console.log(`  Rapid test: ${successCount} success, ${rateLimitHit} rate limited`);
}

async function testSolanaFM() {
  console.log("\n=== Testing Solana FM ===");
  
  const tests = [
    {
      name: "account_transactions",
      url: `https://api.solana.fm/v0/accounts/${TEST_WALLET}/transactions?limit=10`
    },
    {
      name: "token_info",
      url: `https://api.solana.fm/v0/tokens/${TEST_TOKEN}`
    }
  ];
  
  for (const test of tests) {
    const result = await testEndpoint("solana_fm", test.name, test.url, { Accept: "application/json" });
    results.push(result);
    console.log(`  ${test.name}: ${result.success ? '✓' : '✗'} ${result.latencyMs}ms${result.dataCount !== undefined ? ` (${result.dataCount} items)` : ''}${result.error ? ` - ${result.error}` : ''}`);
    await sleep(100);
  }
  
  console.log("\n  Rate limit test (rapid fire 15 requests)...");
  let rateLimitHit = 0;
  let successCount = 0;
  for (let i = 0; i < 15; i++) {
    const result = await testEndpoint("solana_fm", `rapid_${i}`, `https://api.solana.fm/v0/tokens/${TEST_TOKEN}`);
    if (result.rateLimited) rateLimitHit++;
    else if (result.success) successCount++;
  }
  console.log(`  Rapid test: ${successCount} success, ${rateLimitHit} rate limited`);
}

async function testHelius() {
  console.log("\n=== Testing Helius (baseline) ===");
  
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.log("  HELIUS_API_KEY not set - skipping");
    return;
  }
  
  const tests = [
    {
      name: "parsed_transactions",
      url: `https://api.helius.xyz/v0/addresses/${TEST_WALLET}/transactions?api-key=${apiKey}&type=SWAP&limit=10`
    }
  ];
  
  for (const test of tests) {
    const result = await testEndpoint("helius", test.name, test.url);
    results.push(result);
    console.log(`  ${test.name}: ${result.success ? '✓' : '✗'} ${result.latencyMs}ms${result.dataCount !== undefined ? ` (${result.dataCount} items)` : ''}${result.error ? ` - ${result.error}` : ''}`);
  }
  
  const rpcTests = [
    {
      name: "getTokenLargestAccounts",
      url: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      body: { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [TEST_TOKEN] }
    }
  ];
  
  for (const test of rpcTests) {
    const start = Date.now();
    try {
      const response = await fetch(test.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(test.body)
      });
      const latencyMs = Date.now() - start;
      const data = await response.json();
      const dataCount = data.result?.value?.length || 0;
      console.log(`  ${test.name}: ✓ ${latencyMs}ms (${dataCount} items)`);
      results.push({ source: "helius", endpoint: test.name, success: true, latencyMs, dataCount });
    } catch (error: any) {
      console.log(`  ${test.name}: ✗ - ${error.message}`);
      results.push({ source: "helius", endpoint: test.name, success: false, latencyMs: Date.now() - start, error: error.message });
    }
  }
}

async function testPublicRPC() {
  console.log("\n=== Testing Public Solana RPC ===");
  
  const rpcUrl = "https://api.mainnet-beta.solana.com";
  
  const tests = [
    {
      name: "getSignaturesForAddress",
      body: { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [TEST_WALLET, { limit: 10 }] }
    },
    {
      name: "getTokenLargestAccounts",
      body: { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [TEST_TOKEN] }
    }
  ];
  
  for (const test of tests) {
    const start = Date.now();
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(test.body)
      });
      const latencyMs = Date.now() - start;
      
      if (response.status === 429) {
        console.log(`  ${test.name}: ✗ Rate limited`);
        results.push({ source: "public_rpc", endpoint: test.name, success: false, latencyMs, rateLimited: true });
        continue;
      }
      
      const data = await response.json();
      if (data.error) {
        console.log(`  ${test.name}: ✗ - ${data.error.message}`);
        results.push({ source: "public_rpc", endpoint: test.name, success: false, latencyMs, error: data.error.message });
        continue;
      }
      
      const dataCount = Array.isArray(data.result) ? data.result.length : (data.result?.value?.length || 0);
      console.log(`  ${test.name}: ✓ ${latencyMs}ms (${dataCount} items)`);
      results.push({ source: "public_rpc", endpoint: test.name, success: true, latencyMs, dataCount });
    } catch (error: any) {
      console.log(`  ${test.name}: ✗ - ${error.message}`);
      results.push({ source: "public_rpc", endpoint: test.name, success: false, latencyMs: Date.now() - start, error: error.message });
    }
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  
  const bySource: Record<string, TestResult[]> = {};
  for (const r of results) {
    if (!bySource[r.source]) bySource[r.source] = [];
    bySource[r.source].push(r);
  }
  
  for (const [source, sourceResults] of Object.entries(bySource)) {
    const successes = sourceResults.filter(r => r.success).length;
    const avgLatency = Math.round(sourceResults.reduce((sum, r) => sum + r.latencyMs, 0) / sourceResults.length);
    const rateLimited = sourceResults.filter(r => r.rateLimited).length;
    
    console.log(`\n${source.toUpperCase()}:`);
    console.log(`  Success rate: ${successes}/${sourceResults.length}`);
    console.log(`  Avg latency: ${avgLatency}ms`);
    if (rateLimited > 0) console.log(`  Rate limited: ${rateLimited} times`);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("RECOMMENDATIONS:");
  console.log("=".repeat(60));
  console.log("1. Use stored webhook data first (free, instant)");
  console.log("2. Fallback cascade: Solscan → Solana FM → Public RPC → Helius");
  console.log("3. Cache aggressively with TTL");
  console.log("4. Reserve Helius budget for high-priority calls");
}

async function main() {
  console.log("API Pool Test Script");
  console.log("====================");
  console.log(`Test wallet: ${TEST_WALLET}`);
  console.log(`Test token: ${TEST_TOKEN} (BONK)`);
  
  await testSolscan();
  await sleep(1000);
  
  await testSolanaFM();
  await sleep(1000);
  
  await testPublicRPC();
  await sleep(1000);
  
  await testHelius();
  
  printSummary();
}

main().catch(console.error);
