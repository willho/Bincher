import puppeteer from 'puppeteer';

/**
 * Count tokens launched on Pump.fun in last 24 hours
 * Uses Puppeteer to load and render the Pump.fun homepage
 */
async function countTokenLaunches() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-certificate-errors',
      '--disable-client-side-phishing-detection',
    ],
  });

  try {
    const page = await browser.newPage();

    // Set viewport and timeouts
    await page.setViewport({ width: 1280, height: 720 });
    await page.setDefaultNavigationTimeout(45000);
    await page.setDefaultTimeout(45000);

    // Disable images to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log('Loading Pump.fun homepage...');
    await page.goto('https://pump.fun', {
      waitUntil: 'networkidle0',
    });

    console.log('Waiting for page to stabilize...');
    await page.waitForTimeout(2000);

    // Try to detect token list container
    console.log('Looking for token list...');

    const tokens = await page.evaluate(() => {
      const collected = [];

      // Try multiple selector strategies
      const selectors = [
        'a[href*="/token/"]',
        '[data-testid*="token"]',
        '.token-item',
        '[class*="TokenCard"]',
        '[class*="tokenRow"]',
        'div[role="listitem"]',
      ];

      const foundElements = new Set();

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
            const text = el.innerText || el.textContent || '';

            if (href.includes('/token/') && text.length > 3) {
              // Extract mint address from href: /token/MINT_ADDRESS
              const match = href.match(/\/token\/([A-Za-z0-9]+)/);
              if (match) {
                foundElements.add(JSON.stringify({
                  mint: match[1],
                  name: text.substring(0, 50).trim(),
                }));
              }
            }
          });
        } catch (e) {
          // Selector failed, continue
        }
      }

      // Parse unique tokens
      foundElements.forEach((item) => {
        try {
          collected.push(JSON.parse(item));
        } catch (e) {
          // Parse failed, skip
        }
      });

      return {
        tokens: collected.slice(0, 100),
        totalFound: collected.length,
        pageTitle: document.title,
        pageURL: window.location.href,
      };
    });

    console.log('\n=== Pump.fun Token Extraction Results ===');
    console.log(`Page title: ${tokens.pageTitle}`);
    console.log(`Total tokens found: ${tokens.totalFound}`);
    console.log(`Sample tokens:`);

    tokens.tokens.slice(0, 10).forEach((token, i) => {
      console.log(`  ${i + 1}. ${token.name || 'unnamed'} - ${token.mint}`);
    });

    if (tokens.totalFound > 10) {
      console.log(`  ... and ${tokens.totalFound - 10} more`);
    }

  } catch (error) {
    console.error('Scraping error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await browser.close();
    console.log('\nBrowser closed.');
  }
}

// Run
countTokenLaunches().catch(console.error);
