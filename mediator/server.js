import express from 'express';
import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'default-token-change-me';
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || '30000'); // 30 seconds

app.use(express.json());

// Global browser instance
let browser = null;

/**
 * Initialize Puppeteer browser
 */
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  }
  return browser;
}

/**
 * Middleware: Verify auth token
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');

  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * POST /execute
 * Execute JavaScript code in a browser context
 */
app.post('/execute', authMiddleware, async (req, res) => {
  const { url, code } = req.body;

  if (!url || !code) {
    return res.status(400).json({
      error: 'Missing required fields: url, code',
    });
  }

  let page;
  try {
    // Initialize browser if needed
    const browserInstance = await initBrowser();

    // Create new page
    page = await browserInstance.newPage();

    // Set timeout for navigation
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);

    // Navigate to URL
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Execute user code with timeout
    const result = await Promise.race([
      page.evaluate((userCode) => {
        // User code has access to:
        // - document, window, navigator (standard DOM APIs)
        // - Can use await for async operations
        // Return last expression
        return eval(userCode);
      }, code),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Execution timeout')), EXECUTION_TIMEOUT)
      ),
    ]);

    res.json({
      success: true,
      result,
      url,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      url,
    });
  } finally {
    if (page) {
      await page.close();
    }
  }
});

/**
 * GET /health
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    browser: browser ? 'initialized' : 'not initialized',
  });
});

/**
 * GET /
 * Info page
 */
app.get('/', (req, res) => {
  res.json({
    name: 'Mediator - Universal Web Access Service',
    version: '1.0.0',
    endpoints: {
      'POST /execute': {
        description: 'Execute JavaScript code on a website',
        auth: 'Bearer token required',
        body: {
          url: 'string (target URL)',
          code: 'string (JavaScript code to execute)',
        },
        example: {
          url: 'https://example.com',
          code: 'return document.title',
        },
      },
      'GET /health': 'Health check',
    },
  });
});

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('Shutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Start server
 */
async function start() {
  try {
    // Pre-initialize browser
    await initBrowser();
    console.log('✓ Puppeteer browser initialized');

    app.listen(PORT, () => {
      console.log(`✓ Mediator running on port ${PORT}`);
      console.log(`✓ Auth token: ${AUTH_TOKEN.substring(0, 8)}...`);
      console.log(`✓ Execution timeout: ${EXECUTION_TIMEOUT}ms`);
      console.log(`\nReady to execute code on remote websites`);
    });
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
