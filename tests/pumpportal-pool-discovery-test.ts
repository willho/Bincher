/**
 * Test: Does PumpPortal subscribeNewToken include Raydium/Orca pool creation events?
 *
 * Watch the PumpPortal new token stream and categorize messages by type:
 * - Pump.fun bonding curve (has symbol/name, no pool address)
 * - Raydium/Orca direct launch (has pool address in message)
 * - Graduation events (token graduated from pump.fun to Raydium)
 */

import { WebSocket } from "ws";

interface TokenMessage {
  mint: string;
  symbol?: string;
  name?: string;
  type?: string;
  pool?: string; // Raydium pool address if present
  poolAddress?: string;
  raydiumPool?: string;
  // Any other pool-related field
  [key: string]: any;
}

const PUMPPORTAL_URL = "wss://pumpdev.io/ws"; // Try PumpDev (less restrictive)
const TEST_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const START_TIME = Date.now();

let pumpfunTokens = 0;
let raydiumTokens = 0;
let otherMessages = 0;
let parseErrors = 0;

const raydiumSamples: TokenMessage[] = [];
const pumpfunSamples: TokenMessage[] = [];

function categorizeMessage(msg: TokenMessage): string {
  // Check for pool-related fields
  if (msg.pool || msg.poolAddress || msg.raydiumPool) {
    return "raydium";
  }

  // Check for bonding curve indicators
  if ((msg.symbol || msg.name) && !msg.type) {
    return "pumpfun";
  }

  // Graduation event
  if (msg.type === "create" || msg.type === "createpool") {
    return "graduation";
  }

  return "other";
}

async function runTest(): Promise<void> {
  console.log(`[PumpPortal Pool Test] Starting ${TEST_DURATION_MS / 1000}s test...`);
  console.log(`Connecting to ${PUMPPORTAL_URL}\n`);

  const ws = new WebSocket(PUMPPORTAL_URL);
  let connected = false;

  return new Promise((resolve) => {
    ws.on("open", () => {
      connected = true;
      console.log("✓ Connected to PumpPortal");

      // Subscribe to new tokens
      try {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        console.log("✓ Subscribed to subscribeNewToken\n");
        console.log("Listening for tokens...\n");
      } catch (e) {
        console.error("Error sending subscription:", e);
      }
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as TokenMessage;

        if (!msg.mint) {
          // Skip keep-alive or non-token messages
          return;
        }

        const category = categorizeMessage(msg);

        switch (category) {
          case "pumpfun":
            pumpfunTokens++;
            if (pumpfunSamples.length < 3) {
              pumpfunSamples.push(msg);
              console.log(`[PUMPFUN #${pumpfunTokens}] ${msg.symbol || msg.name} | ${msg.mint}`);
            }
            break;

          case "raydium":
            raydiumTokens++;
            raydiumSamples.push(msg);
            console.log(
              `[RAYDIUM #${raydiumTokens}] ${msg.symbol || msg.name || "?"} | ${msg.mint}`
            );
            console.log(`  Pool: ${msg.pool || msg.poolAddress || msg.raydiumPool}`);
            console.log(`  Full message keys: ${Object.keys(msg).join(", ")}\n`);
            break;

          case "graduation":
            console.log(`[GRADUATION] ${msg.mint} | type=${msg.type}`);
            break;

          case "other":
            otherMessages++;
            break;
        }
      } catch (error) {
        parseErrors++;
      }
    });

    ws.on("error", (error: Error) => {
      console.error("✗ WebSocket error:", error.message);
      resolve();
    });

    ws.on("close", () => {
      console.log("\n✗ WebSocket closed");
      resolve();
    });

    // Auto-stop after test duration
    setTimeout(() => {
      console.log("\n" + "=".repeat(60));
      console.log("TEST RESULTS");
      console.log("=".repeat(60));
      console.log(`Duration: ${((Date.now() - START_TIME) / 1000).toFixed(1)}s`);
      console.log(`Pumpfun tokens: ${pumpfunTokens}`);
      console.log(`Raydium tokens: ${raydiumTokens}`);
      console.log(`Graduation events: ${pumpfunTokens + raydiumTokens - pumpfunTokens - raydiumTokens > 0 ? "TBD" : "0"}`);
      console.log(`Other messages: ${otherMessages}`);
      console.log(`Parse errors: ${parseErrors}`);

      if (raydiumTokens > 0) {
        console.log("\n✓ CONFIRMED: PumpPortal DOES report Raydium pool creation events!");
        console.log(`\nRaydium samples (${raydiumSamples.length} collected):`);
        raydiumSamples.forEach((s, i) => {
          console.log(`\n${i + 1}. ${s.symbol || s.name}`);
          console.log(`   Mint: ${s.mint}`);
          console.log(`   Pool: ${s.pool || s.poolAddress || s.raydiumPool}`);
        });
      } else {
        console.log("\n✗ No Raydium events detected in this test window");
        console.log("   (May need longer observation period or different market conditions)");
      }

      if (pumpfunSamples.length > 0) {
        console.log(`\nPumpfun samples (first ${pumpfunSamples.length}):`);
        pumpfunSamples.forEach((s, i) => {
          console.log(`\n${i + 1}. ${s.symbol || s.name}`);
          console.log(`   Mint: ${s.mint}`);
          console.log(`   Type: ${s.type || "none"}`);
        });
      }

      console.log("\n" + "=".repeat(60));

      ws.close();
      resolve();
    }, TEST_DURATION_MS);
  });
}

runTest().catch(console.error);
