import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const sdk = new OnlinePumpSdk(connection);

// A well-known pump.fun token that has graduated
const testMint = new PublicKey("CzLSvfkQfcKFc5M3VeNX7WfXQBLW1CcysxQUV5PsKuTq");

async function main() {
  console.log("Testing fetchBondingCurve structure:");
  try {
    const result = await sdk.fetchBondingCurve(testMint);
    console.log("✓ Method exists");
    console.log("Result structure:");
    for (const [key, value] of Object.entries(result || {})) {
      const type = typeof value;
      const display = 
        type === 'bigint' ? `BigInt(${value.toString().substring(0, 20)}...)` :
        type === 'object' ? (value?.constructor?.name || 'Object') :
        type === 'boolean' ? value :
        (typeof value === 'string' ? value.substring(0, 50) : value);
      console.log(`  ${key}: ${type} = ${display}`);
    }
  } catch (error) {
    console.log(`✗ Error: ${error.message}`);
  }
}

main();
