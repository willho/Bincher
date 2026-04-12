#!/usr/bin/env node

/**
 * Test ALL Pump.fun WebSocket Providers
 *
 * Run from a NORMAL terminal (not Claude Code) to bypass Anthropic proxy:
 *   node test-websocket-providers.js
 *
 * Requires: npm install ws
 */

import WebSocket from 'ws';

const PROVIDERS = [
  {
    name: 'PumpDev.io',
    url: 'wss://pumpdev.io/ws',
    subscribe: null, // auto-streams on connect
    docs: 'https://pumpdev.io/data-api/',
  },
  {
    name: 'PumpPortal',
    url: 'wss://pumpportal.fun/api/data',
    subscribe: JSON.stringify({ method: 'subscribeNewToken' }),
    docs: 'https://pumpportal.fun/data-api/real-time/',
  },
  {
    name: 'Solana Tracker',
    url: 'wss://ws.solanatracker.io/',
    subscribe: null,
    docs: 'https://docs.solanatracker.io/public-data-api/websocket',
  },
];

console.log('=== Pump.fun WebSocket Provider Test ===\n');
console.log('Testing from your IP (not Claude Code proxy)\n');

let completed = 0;
const results = [];

for (const provider of PROVIDERS) {
  testProvider(provider);
}

function testProvider(provider) {
  const startTime = Date.now();
  let messageCount = 0;
  let firstMessage = null;

  console.log(`[${provider.name}] Connecting to ${provider.url}...`);

  const ws = new WebSocket(provider.url);

  ws.on('open', () => {
    console.log(`[${provider.name}] ✅ Connected!`);
    if (provider.subscribe) {
      ws.send(provider.subscribe);
      console.log(`[${provider.name}] Sent subscribe message`);
    }
  });

  ws.on('message', (data) => {
    messageCount++;
    if (!firstMessage) {
      firstMessage = data.toString().substring(0, 300);
      const elapsed = Date.now() - startTime;
      console.log(`[${provider.name}] ✅ First message in ${elapsed}ms`);
      console.log(`[${provider.name}] Data: ${firstMessage}\n`);
    }

    // After 3 messages, close and report
    if (messageCount >= 3) {
      ws.close();
      reportResult(provider.name, true, messageCount, Date.now() - startTime, firstMessage);
    }
  });

  ws.on('error', (error) => {
    console.log(`[${provider.name}] ❌ Error: ${error.message}\n`);
    reportResult(provider.name, false, 0, Date.now() - startTime, error.message);
  });

  ws.on('close', () => {
    if (messageCount === 0) {
      reportResult(provider.name, false, 0, Date.now() - startTime, 'Closed without data');
    }
  });

  // Per-provider timeout
  setTimeout(() => {
    if (messageCount === 0) {
      console.log(`[${provider.name}] ⏰ Timeout (15s)`);
      ws.close();
      reportResult(provider.name, false, 0, 15000, 'Timeout');
    } else if (messageCount < 3) {
      ws.close();
      reportResult(provider.name, true, messageCount, Date.now() - startTime, firstMessage);
    }
  }, 15000);
}

function reportResult(name, success, messages, elapsed, data) {
  results.push({ name, success, messages, elapsed, data });
  completed++;

  if (completed === PROVIDERS.length) {
    printSummary();
  }
}

function printSummary() {
  console.log('\n=== RESULTS ===\n');

  for (const r of results) {
    const status = r.success ? '✅ WORKS' : '❌ FAILED';
    console.log(`${status} | ${r.name} | ${r.messages} msgs in ${r.elapsed}ms`);
    if (!r.success) {
      console.log(`         Reason: ${r.data}`);
    }
  }

  const working = results.filter(r => r.success);
  console.log(`\n${working.length}/${results.length} providers working`);

  if (working.length > 0) {
    console.log('\nRecommended for Penny-Pincher2:');
    console.log(`  ${working[0].name} (${working[0].elapsed}ms to first message)`);
  } else {
    console.log('\nNo WebSocket providers working. Stick with polling.');
  }

  process.exit(0);
}
