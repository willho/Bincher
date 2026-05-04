/**
 * Test: Pump.fun graduation endpoint
 * Check if pump.fun API exposes graduation events/endpoint
 */

import axios from "axios";

async function testPumpFunGraduationEndpoint(): Promise<void> {
  const endpoints = [
    "https://api.pump.fun/graduations",
    "https://api.pump.fun/api/graduations",
    "https://api.pump.fun/v1/graduations",
    "https://pump.fun/api/graduations",
    "https://api.pump.fun/events/graduations",
    "https://api.pump.fun/tokens/graduated",
  ];

  console.log("Testing Pump.fun graduation endpoints...\n");

  for (const url of endpoints) {
    try {
      console.log(`Testing: ${url}`);
      const response = await axios.get(url, {
        timeout: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });

      console.log(`  ✓ Status ${response.status}`);
      console.log(`  Response type: ${typeof response.data}`);
      if (Array.isArray(response.data)) {
        console.log(`  Array length: ${response.data.length}`);
        if (response.data.length > 0) {
          console.log(`  Sample: ${JSON.stringify(response.data[0]).substring(0, 200)}`);
        }
      } else if (typeof response.data === "object") {
        console.log(`  Keys: ${Object.keys(response.data).join(", ")}`);
      }
      console.log();
    } catch (error: any) {
      const status = error.response?.status || "no response";
      const msg = error.message.split("\n")[0];
      console.log(`  ✗ ${status} - ${msg}`);
    }
  }

  // Also try WebSocket subscription for graduations
  console.log("\n" + "=".repeat(60));
  console.log("Testing WebSocket graduation subscriptions...\n");

  const wsEndpoints = [
    { provider: "PumpPortal", url: "wss://pumpportal.fun/api/data", method: "subscribeGraduations" },
    { provider: "PumpDev", url: "wss://pumpdev.io/ws", method: "subscribeGraduations" },
  ];

  for (const { provider, url, method } of wsEndpoints) {
    console.log(`${provider}: ${method}`);
    console.log(`  (Would test via WebSocket if environment allows)\n`);
  }
}

testPumpFunGraduationEndpoint().catch(console.error);
