/**
 * Test: Pump.fun frontend API endpoints
 * Base: https://frontend-api.pump.fun
 */

import axios from "axios";

async function testPumpFunAPI(): Promise<void> {
  const baseUrl = "https://frontend-api.pump.fun";

  // Try various endpoints
  const endpoints = [
    { path: "/coins", params: { offset: 0, limit: 5 }, desc: "Latest coins" },
    { path: "/coins", params: { offset: 0, limit: 5, sort: "graduated" }, desc: "Graduated (sorted)" },
    { path: "/graduated", params: { offset: 0, limit: 5 }, desc: "Graduated coins" },
    { path: "/graduations", params: { offset: 0, limit: 5 }, desc: "Graduations endpoint" },
    { path: "/coins/graduated", params: {}, desc: "Graduated coins path" },
    { path: "/events/graduations", params: {}, desc: "Graduation events" },
  ];

  console.log(`Testing Pump.fun API (${baseUrl})\n`);

  for (const { path, params, desc } of endpoints) {
    try {
      const url = `${baseUrl}${path}`;
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
      const fullUrl = query ? `${url}?${query}` : url;

      console.log(`Testing: ${desc}`);
      console.log(`  ${fullUrl}`);

      const response = await axios.get(fullUrl, {
        timeout: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      });

      console.log(`  ✓ Status ${response.status}`);

      if (Array.isArray(response.data)) {
        console.log(`  Array with ${response.data.length} items`);
        if (response.data.length > 0) {
          const first = response.data[0];
          console.log(`  Sample keys: ${Object.keys(first).slice(0, 8).join(", ")}`);
          console.log(`  Sample: ${JSON.stringify(first).substring(0, 150)}...`);
        }
      } else if (typeof response.data === "object") {
        console.log(`  Object keys: ${Object.keys(response.data).join(", ")}`);
      } else {
        console.log(`  Data type: ${typeof response.data}`);
      }
      console.log();
    } catch (error: any) {
      const status = error.response?.status || "no response";
      const msg = error.message.split("\n")[0];
      console.log(`  ✗ ${status} - ${msg}`);
      console.log();
    }
  }
}

testPumpFunAPI().catch(console.error);
