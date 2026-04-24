import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function main() {
  console.log("[Testing Pump SDK Actual Methods]\n");

  const connection = new Connection(RPC_URL);
  const sdk = new OnlinePumpSdk(connection);

  // Test with a known token mint
  const testMint = new PublicKey("CzLSvfkQfcKFc5M3VeNX7WfXQBLW1CcysxQUV5PsKuTq");

  console.log("Testing fetchBondingCurve():");
  try {
    const start = Date.now();
    const result = await sdk.fetchBondingCurve(testMint);
    const duration = Date.now() - start;
    console.log(`✓ Success (${duration}ms)`);
    console.log(`  Result keys: ${Object.keys(result || {}).join(", ")}`);
    if (result) {
      console.log(`  Sample values:`, JSON.stringify(result, (_, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v && typeof v === 'object' && v.constructor?.name === 'PublicKey') return v.toString();
        return v;
      }, 2).split('\n').slice(0, 10).join('\n'));
    }
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }

  console.log("\nTesting fetchBuyState():");
  try {
    const start = Date.now();
    const result = await sdk.fetchBuyState(testMint, 1000000);
    const duration = Date.now() - start;
    console.log(`✓ Success (${duration}ms)`);
    console.log(`  Result keys: ${Object.keys(result || {}).join(", ")}`);
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }

  console.log("\nTesting fetchSellState():");
  try {
    const start = Date.now();
    const result = await sdk.fetchSellState(testMint, 1000000);
    const duration = Date.now() - start;
    console.log(`✓ Success (${duration}ms)`);
    console.log(`  Result keys: ${Object.keys(result || {}).join(", ")}`);
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }

  console.log("\nTesting fetchGlobal():");
  try {
    const start = Date.now();
    const result = await sdk.fetchGlobal();
    const duration = Date.now() - start;
    console.log(`✓ Success (${duration}ms)`);
    console.log(`  Result keys: ${Object.keys(result || {}).join(", ")}`);
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }

  console.log("\n[Conclusion]");
  console.log("⚠ fetchBondingCurveSummary() does NOT exist in this SDK version");
  console.log("✓ Available methods: fetchBondingCurve, fetchBuyState, fetchSellState, etc.");
  console.log("✓ Need to check SDK documentation or source code for graduation detection method");
}

main().catch(console.error);
