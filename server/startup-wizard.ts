/**
 * Startup Wizard
 * Interactive verification of proxy connectivity and API health on startup
 */

import axios from "axios";
import { proxyRegistry } from "./proxy-registry";
import { apiHealthChecker, type HealthStatus } from "./api-health-check";

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

interface WizardConfig {
  proxyWaitTimeoutMs?: number;
  checkAPIs?: boolean;
}

class StartupWizard {
  private ownIP: string | null = null;

  /**
   * Detect own outbound IP
   */
  private async detectOwnIP(): Promise<string> {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: 5000
      });
      return response.data.ip;
    } catch (error) {
      console.warn(`${COLORS.yellow}⚠ Could not detect own IP${COLORS.reset}`);
      return 'unknown';
    }
  }

  /**
   * Print colored status line
   */
  private printStatus(symbol: string, text: string, color: string = COLORS.reset): void {
    console.log(`${color}${symbol} ${text}${COLORS.reset}`);
  }

  /**
   * Wait for proxies to register with timeout and retry
   */
  private async waitForProxies(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    let lastPrintTime = 0;

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - startTime;

        // Print status every 2 seconds
        if (now - lastPrintTime > 2000) {
          const status = proxyRegistry.getStatus();
          console.clear();

          console.log(
            `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}`
          );
          console.log(
            `${COLORS.cyan}Penny-Pincher2 Startup Wizard${COLORS.reset}`
          );
          console.log(
            `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}\n`
          );

          // Own IP
          this.printStatus('✓', `Penny-Pincher2 IP: ${this.ownIP}`, COLORS.green);

          // Proxy status
          console.log(`\n${COLORS.cyan}Proxy Connections:${COLORS.reset}`);
          status.proxies.forEach((proxy) => {
            if (proxy.registered) {
              this.printStatus(
                '✓',
                `${proxy.name}: ${proxy.ip} (${proxy.lastSeen})`,
                COLORS.green
              );
            } else {
              this.printStatus('⏳', `${proxy.name}: (waiting...)`, COLORS.yellow);
            }
          });

          console.log(`\nWaiting for proxies... (${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s)`);
          lastPrintTime = now;
        }

        // Check if all proxies ready
        if (proxyRegistry.areAllProxiesReady()) {
          clearInterval(checkInterval);
          resolve(true);
        }

        // Check timeout
        if (elapsed > timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 500);
    });
  }

  /**
   * Check API health and display results
   */
  private async checkAPIs(): Promise<HealthStatus[]> {
    console.log(`\n${COLORS.cyan}Checking API Health:${COLORS.reset}`);
    const results = await apiHealthChecker.checkAllAPIs();

    results.forEach((result) => {
      if (result.status === 'healthy') {
        this.printStatus(
          '✓',
          `${result.service} - OK${result.latency ? ` (${result.latency}ms)` : ''}`,
          COLORS.green
        );
      } else if (result.status === 'degraded') {
        this.printStatus(
          '⚠',
          `${result.service} - Degraded${result.error ? ` (${result.error})` : ''}`,
          COLORS.yellow
        );
      } else {
        this.printStatus(
          '✗',
          `${result.service} - Unavailable${result.error ? ` (${result.error})` : ''}`,
          COLORS.red
        );
      }
    });

    return results;
  }

  /**
   * Main startup wizard flow
   */
  async run(config: WizardConfig = {}): Promise<boolean> {
    const {
      proxyWaitTimeoutMs = 60000, // 60 seconds default
      checkAPIs = true
    } = config;

    // Detect own IP
    this.ownIP = await this.detectOwnIP();

    // Wait for proxies
    console.log(
      `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}Penny-Pincher2 Startup Wizard${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}\n`
    );

    this.printStatus('✓', `Penny-Pincher2 IP: ${this.ownIP}`, COLORS.green);
    console.log(`\n${COLORS.cyan}Waiting for proxies to connect...${COLORS.reset}`);

    const proxiesReady = await this.waitForProxies(proxyWaitTimeoutMs);

    // Clear and show final status
    console.clear();
    console.log(
      `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}Penny-Pincher2 Startup Status${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}${'='.repeat(70)}${COLORS.reset}\n`
    );

    this.printStatus('✓', `Penny-Pincher2 IP: ${this.ownIP}`, COLORS.green);

    // Show proxy status
    console.log(`\n${COLORS.cyan}Proxy Status:${COLORS.reset}`);
    const proxyStatus = proxyRegistry.getStatus();
    proxyStatus.proxies.forEach((proxy) => {
      if (proxy.registered) {
        this.printStatus(
          '✓',
          `${proxy.name}: ${proxy.ip}`,
          COLORS.green
        );
      } else {
        this.printStatus('✗', `${proxy.name}: Not connected`, COLORS.red);
      }
    });

    if (!proxiesReady) {
      this.printStatus(
        '✗',
        'Not all proxies connected (timeout)',
        COLORS.red
      );
      console.log(
        `\n${COLORS.yellow}⚠ You can retry proxy connection manually later${COLORS.reset}`
      );
      console.log(
        `${COLORS.gray}Proxy connection is required for redundancy. Blocking startup.${COLORS.reset}\n`
      );
      return false;
    }

    if (!proxyStatus.uniqueIPs) {
      this.printStatus(
        '✗',
        'Proxy IPs are not unique',
        COLORS.red
      );
      console.log(
        `${COLORS.gray}IPs detected: ${proxyStatus.ipCount} unique out of ${proxyStatus.proxies.length} proxies${COLORS.reset}\n`
      );
      return false;
    }

    this.printStatus('✓', 'All proxies connected with unique IPs', COLORS.green);

    // Check APIs
    if (checkAPIs) {
      const apiResults = await this.checkAPIs();
      const healthyCount = apiResults.filter((r) => r.status === 'healthy').length;
      const totalCount = apiResults.length;

      console.log(
        `\n${COLORS.cyan}Health Summary: ${healthyCount}/${totalCount} services healthy${COLORS.reset}`
      );

      const hasUnavailable = apiResults.some((r) => r.status === 'unavailable');
      if (hasUnavailable) {
        console.log(
          `${COLORS.yellow}⚠ Some APIs are unavailable, but startup will continue${COLORS.reset}`
        );
      }
    }

    console.log(`\n${COLORS.green}✓ Startup verified, initializing main app...${COLORS.reset}\n`);
    return true;
  }
}

export const startupWizard = new StartupWizard();

/**
 * Run startup wizard and return success/failure
 */
export async function runStartupWizard(): Promise<boolean> {
  try {
    return await startupWizard.run({
      proxyWaitTimeoutMs: 60000,
      checkAPIs: true
    });
  } catch (error) {
    console.error('Startup wizard error:', error);
    return false;
  }
}
