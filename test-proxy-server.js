#!/usr/bin/env node

/**
 * Simple proxy server for DexPaprika batch test
 * Serves HTML test files and proxies WebSocket connections
 * Run: node test-proxy-server.js
 * Then open: http://localhost:8000/dexpaprika-batch-test.html
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

const PORT = 8000;

const server = http.createServer((req, res) => {
  // Serve HTML test files
  if (req.url === '/' || req.url === '') {
    return serveFile(res, 'dexpaprika-batch-test.html', 'text/html');
  }

  if (req.url === '/dexpaprika-batch-test.html') {
    return serveFile(res, 'dexpaprika-batch-test.html', 'text/html');
  }

  if (req.url === '/dexpaprika-sse-parser-test.html') {
    return serveFile(res, 'dexpaprika-sse-parser-test.html', 'text/html');
  }

  // Proxy WebSocket collections
  if (req.url === '/api/test/collect-mints' && req.method === 'GET') {
    return collectMints(req, res);
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function serveFile(res, filename, contentType) {
  const filepath = path.join(__dirname, filename);

  fs.readFile(filepath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found: ' + filename);
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function collectMints(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const count = Math.min(parseInt(url.searchParams.get('count')) || 20, 100);

  const mints = [];
  let timeout;

  try {
    const ws = new WebSocket('wss://pumpportal.fun/api/data');

    ws.on('open', () => {
      console.log('Connected to PumpPortal, subscribing to new tokens...');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Extract mint address
        const mint = message.mint || message.token || message.signature;

        // Filter: must be 43-44 chars (Solana address length)
        if (mint && typeof mint === 'string' && mint.length > 40 && !mints.includes(mint)) {
          mints.push(mint);
          console.log(`Collected mint ${mints.length}/${count}: ${mint.substring(0, 8)}...`);

          // Stop when we have enough
          if (mints.length >= count) {
            ws.close();
            clearTimeout(timeout);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mints, collected: mints.length }));
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error('WebSocket error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `WebSocket error: ${err.message}`, mints }));
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mints, collected: mints.length }));
      }
    });

    // Timeout after 30 seconds
    timeout = setTimeout(() => {
      ws.close();
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: mints.length > 0, mints, collected: mints.length, timeout: true }));
      }
    }, 30000);
  } catch (error) {
    console.error('Error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message, mints }));
  }
}

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  DexPaprika Batch Test Server                      ║
║  Running on: http://localhost:${PORT}                  ║
║  Open: http://localhost:${PORT}/dexpaprika-batch-test.html ║
║  Stop: Press Ctrl+C                                ║
╚════════════════════════════════════════════════════╝
  `);
});
