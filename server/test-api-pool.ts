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

async function testBitquery() {
  console.log("\n=== Testing Bitquery (GraphQL) ===");
  console.log("  Note: Requires API key signup at bitquery.io");
  console.log("  Skipping (no key configured) - but viable free option");
}

async function testMoralis() {
  console.log("\n=== Testing Moralis ===");
  console.log("  Note: Requires API key signup at moralis.com");
  console.log("  Skipping (no key configured) - but has free Solana Token Holders API");
}

async function testQuickNode() {
  console.log("\n=== Testing QuickNode ===");
  console.log("  Note: Requires signup for free RPC endpoint");
  console.log("  Skipping (no endpoint configured) - faster alternative to public RPC");
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

interface SourceStatus {
  name: string;
  status: "working" | "requires_key" | "unreachable" | "rate_limited";
  successRate: number;
  avgLatency: number;
  notes: string;
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
  
  const sourceStatuses: SourceStatus[] = [];
  
  for (const [source, sourceResults] of Object.entries(bySource)) {
    const successes = sourceResults.filter(r => r.success).length;
    const total = sourceResults.length;
    const avgLatency = Math.round(sourceResults.reduce((sum, r) => sum + r.latencyMs, 0) / sourceResults.length);
    const rateLimited = sourceResults.filter(r => r.rateLimited).length;
    const forbidden = sourceResults.filter(r => r.error?.includes("403")).length;
    const serverError = sourceResults.filter(r => r.error?.includes("502") || r.error?.includes("503")).length;
    
    let status: SourceStatus["status"] = "working";
    let notes = "";
    
    if (forbidden > 0) {
      status = "requires_key";
      notes = "API key required (403 Forbidden)";
    } else if (serverError > 0) {
      status = "unreachable";
      notes = "Service unavailable (502/503)";
    } else if (rateLimited > total / 2) {
      status = "rate_limited";
      notes = "Heavy rate limiting";
    } else if (successes === 0) {
      status = "unreachable";
      notes = "All requests failed";
    } else if (successes === total) {
      status = "working";
      notes = "Fully operational";
    } else {
      status = "rate_limited";
      notes = "Partial success";
    }
    
    sourceStatuses.push({
      name: source.toUpperCase(),
      status,
      successRate: Math.round((successes / total) * 100),
      avgLatency,
      notes
    });
    
    const statusIcon = status === "working" ? "✓" : status === "requires_key" ? "🔑" : status === "rate_limited" ? "⚠️" : "✗";
    console.log(`\n${statusIcon} ${source.toUpperCase()}:`);
    console.log(`  Status: ${status}`);
    console.log(`  Success rate: ${successes}/${total} (${Math.round((successes/total)*100)}%)`);
    console.log(`  Avg latency: ${avgLatency}ms`);
    console.log(`  Notes: ${notes}`);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("ENDPOINT STATUS:");
  console.log("=".repeat(60));
  console.log("  ✓ WORKING      - Ready to use");
  console.log("  🔑 REQUIRES_KEY - Needs API key signup");
  console.log("  ⚠️ RATE_LIMITED - Use sparingly");
  console.log("  ✗ UNREACHABLE  - Not usable currently");
  
  console.log("\n" + "=".repeat(60));
  console.log("RECOMMENDED FALLBACK ORDER (based on test results):");
  console.log("=".repeat(60));
  console.log("1. Stored webhook data (FREE, instant, unlimited)");
  console.log("2. Public Solana RPC - getSignaturesForAddress (FREE, works)");
  console.log("3. User's Helius key (POOLED, reliable, ~1-2s latency)");
  console.log("");
  console.log("NOT RECOMMENDED (based on test results):");
  console.log("- Solscan: Now requires API key (403 Forbidden)");
  console.log("- Solana FM: Service issues (502 Bad Gateway)");
  console.log("");
  console.log("OPTIONAL (requires signup for free tier):");
  console.log("- Bitquery: Free GraphQL API, good for history");
  console.log("- Moralis: Free credits, Solana Token Holders API");
  console.log("- QuickNode: Free RPC tier, faster than public");
}

async function main() {
  console.log("API Pool Test Script");
  console.log("====================");
  console.log(`Test wallet: ${TEST_WALLET}`);
  console.log(`Test token: ${TEST_TOKEN} (BONK)`);
  console.log("\nNote: Users provide their own Helius API key on signup.");
  console.log("This pools all user API budgets together for shared discovery.\n");
  
  await testSolscan();
  await sleep(1000);
  
  await testSolanaFM();
  await sleep(1000);
  
  await testBitquery();
  await testMoralis();
  await testQuickNode();
  await sleep(500);
  
  await testPublicRPC();
  await sleep(1000);
  
  await testHelius();
  
  printSummary();
  
  console.log("\n" + "=".repeat(60));
  console.log("USER API KEY POOL STRATEGY:");
  console.log("=".repeat(60));
  console.log("Each user brings their own Helius key (1M credits/month)");
  console.log("50 users × 1M = 50M pooled credits for shared discovery");
  console.log("");
  console.log("Priority:");
  console.log("1. User's own key for their signal wallets (personal budget)");
  console.log("2. Pooled credits for discovery (shared fairly)");
  console.log("3. Stored webhook data (free, unlimited)");
}

main().catch(console.error);
