/**
 * Startup Wizard
 * Interactive verification of proxy connectivity and API health on startup
 */

import axios from "axios";
import { proxyRegistry } from "./proxy-registry";
import { apiHealthChecker, type HealthStatus } from "./api-health-check";
import { verifyProxiesForStartup, printProxyStartupReport } from "./proxy-startup-verifier";

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

    // Display wizard header
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

    // Verify proxy health (independent of registry registration)
    console.log(`\n${COLORS.cyan}Verifying proxy health...${COLORS.reset}`);
    const proxyVerificationResult = await verifyProxiesForStartup();

    if (proxyVerificationResult.success) {
      this.printStatus(
        '✓',
        `${proxyVerificationResult.connectedProxies}/${proxyVerificationResult.totalProxies} proxies verified`,
        COLORS.green
      );
    } else if (proxyVerificationResult.connectedProxies > 0) {
      this.printStatus(
        '⚠',
        `${proxyVerificationResult.connectedProxies}/${proxyVerificationResult.totalProxies} proxies verified (degraded mode)`,
        COLORS.yellow
      );
    } else {
      this.printStatus(
        '✗',
        'No proxies available',
        COLORS.red
      );
    }

    if (proxyVerificationResult.errors.length > 0) {
      // Check for critical issues (duplicate IPs, duplicate API keys)
      const criticalErrors = proxyVerificationResult.errors.filter((e) =>
        e.includes("DUPLICATE") || e.includes("breaks IP-based")
      );

      if (criticalErrors.length > 0) {
        console.log(`\n${COLORS.red}⚠️  CRITICAL CONFIGURATION ISSUES:${COLORS.reset}`);
        criticalErrors.forEach((error) => {
          console.log(`  ${COLORS.red}${error}${COLORS.reset}`);
        });
      }

      const warnings = proxyVerificationResult.errors.filter(
        (e) => !e.includes("DUPLICATE") && !e.includes("breaks IP-based")
      );
      if (warnings.length > 0) {
        console.log(`\n${COLORS.yellow}Proxy verification notes:${COLORS.reset}`);
        warnings.forEach((error) => {
          console.log(`  ${COLORS.gray}${error}${COLORS.reset}`);
        });
      }
    }

    // Wait for proxies to register with timeout
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

    // Show proxy verification status
    console.log(`\n${COLORS.cyan}Proxy Verification:${COLORS.reset}`);
    if (proxyVerificationResult.success) {
      this.printStatus(
        '✓',
        `${proxyVerificationResult.connectedProxies}/${proxyVerificationResult.totalProxies} proxies healthy`,
        COLORS.green
      );
    } else if (proxyVerificationResult.connectedProxies > 0) {
      this.printStatus(
        '⚠',
        `${proxyVerificationResult.connectedProxies}/${proxyVerificationResult.totalProxies} proxies healthy (degraded mode)`,
        COLORS.yellow
      );
    } else {
      this.printStatus(
        '✗',
        'No proxies available',
        COLORS.red
      );
    }

    // Show proxy registry status
    console.log(`\n${COLORS.cyan}Proxy Registration:${COLORS.reset}`);
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

    // Block startup if no proxies available (critical for redundancy)
    if (proxyVerificationResult.connectedProxies === 0) {
      console.log(
        `\n${COLORS.red}✗ STARTUP BLOCKED: No proxies available${COLORS.reset}`
      );
      console.log(
        `${COLORS.gray}Proxy connectivity is required. Ensure proxies are running and accessible.${COLORS.reset}\n`
      );
      return false;
    }

    // Warn if proxies not ready but allow startup if verification passed (they may still be registering)
    if (!proxiesReady && proxyVerificationResult.connectedProxies > 0) {
      this.printStatus(
        '⚠',
        'Proxies healthy but registration timeout',
        COLORS.yellow
      );
      console.log(
        `${COLORS.gray}Proxies verified healthy but not yet registered. Proceeding with caution.${COLORS.reset}\n`
      );
    } else if (!proxiesReady) {
      this.printStatus(
        '✗',
        'Not all proxies connected (timeout)',
        COLORS.red
      );
      console.log(
        `\n${COLORS.yellow}⚠ You can retry proxy connection manually later${COLORS.reset}`
      );
      console.log(
        `${COLORS.gray}Proxy connection required for redundancy. Blocking startup.${COLORS.reset}\n`
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
  // Skip proxy validation on Replit (single-server deployment)
  if (process.env.REPLIT_DEPLOYMENT) {
    console.log(`${COLORS.cyan}✓ Running on Replit, skipping proxy validation${COLORS.reset}`);
    return true;
  }

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
