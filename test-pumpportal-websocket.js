#!/usr/bin/env node

/**
 * Test PumpPortal WebSocket Real-Time Token Stream
 *
 * Run this on your local machine to test if PumpPortal WebSocket works with your IP
 * Usage: node test-pumpportal-websocket.js
 */

import WebSocket from 'ws';

console.log('Testing PumpPortal WebSocket connection...\n');

const ws = new WebSocket('wss://pumpportal.fun/api/data');
let messageCount = 0;

ws.on('open', () => {
  console.log('✅ Connected to PumpPortal WebSocket!');
  console.log('Subscribing to new token launches...\n');

  // Subscribe to new tokens
  ws.send(JSON.stringify({
    method: 'subscribeNewToken',
  }));
});

ws.on('message', (data) => {
  messageCount++;
  console.log(`Message ${messageCount}:`, data.toString().substring(0, 200) + '...\n');

  // Close after first message to keep test short
  if (messageCount >= 1) {
    console.log('✅ SUCCESS - Received token launch data!');
    console.log('PumpPortal WebSocket works from your IP');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (error) => {
  console.error('❌ ERROR:', error.message);
  console.error('\nPumpPortal WebSocket failed - likely due to:');
  console.error('1. IP is blocked by PumpPortal');
  console.error('2. Endpoint requires authentication');
  console.error('3. Service has been discontinued\n');
  process.exit(1);
});

ws.on('close', () => {
  if (messageCount === 0) {
    console.error('❌ Connection closed without receiving data');
    process.exit(1);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  console.error('❌ TIMEOUT - No response from PumpPortal');
  console.error('\nPumpPortal WebSocket may not be responding');
  ws.close();
  process.exit(1);
}, 10000);
