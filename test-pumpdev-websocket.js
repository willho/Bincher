#!/usr/bin/env node

/**
 * Test PumpDev WebSocket Real-Time Token Stream
 *
 * Tests if pumpdev.io WebSocket works from this environment
 * Source: https://pumpdev.io/ws
 */

import WebSocket from 'ws';

console.log('Testing PumpDev WebSocket connection...\n');

const ws = new WebSocket('wss://pumpdev.io/ws');
let messageCount = 0;
const startTime = Date.now();

ws.on('open', () => {
  console.log('✅ Connected to PumpDev WebSocket!');
  console.log('Listening for new token launches...\n');
});

ws.on('message', (data) => {
  messageCount++;

  try {
    const message = JSON.parse(data.toString());

    // Filter for token creation events
    if (message.type === 'create' || message.txType === 'create') {
      console.log(`\n✅ NEW TOKEN EVENT #${messageCount}:`);
      console.log('  Mint:', message.mint || message.tokenMint || 'N/A');
      console.log('  Name:', message.name || 'N/A');
      console.log('  Symbol:', message.symbol || 'N/A');
      console.log('  Creator:', message.creator || 'N/A');
      console.log('  Raw:', data.toString().substring(0, 150) + '...\n');

      // Success - close after first token
      console.log('✅ SUCCESS - PumpDev WebSocket works!');
      console.log(`Connected for ${Date.now() - startTime}ms`);
      ws.close();
      process.exit(0);
    }
  } catch (e) {
    // Raw message, not JSON
    console.log(`Message ${messageCount}:`, data.toString().substring(0, 100) + '...\n');
  }
});

ws.on('error', (error) => {
  console.error('❌ ERROR:', error.message);
  process.exit(1);
});

ws.on('close', () => {
  if (messageCount === 0) {
    console.error('❌ Connection closed without receiving data');
    process.exit(1);
  }
});

// Timeout after 30 seconds
setTimeout(() => {
  console.error(`❌ TIMEOUT - No token events in 30 seconds`);
  console.error(`Received ${messageCount} total messages`);
  ws.close();
  process.exit(1);
}, 30000);
