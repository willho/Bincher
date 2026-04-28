/**
 * Proxy Startup Verification
 *
 * Verifies all proxy instances are healthy before allowing Pincher2 startup
 * Blocks startup if any proxy is unreachable (critical for 2/3 mesh redundancy)
 */

import { getProxyConfigs, verifyProxyHealth, logProxyStats } from "./proxy-config";

export interface StartupVerificationResult {
  success: boolean;
  connectedProxies: number;
  totalProxies: number;
  errors: string[];
}

/**
 * Verify all proxies are healthy before startup
 */
export async function verifyProxiesForStartup(): Promise<StartupVerificationResult> {
  console.log("[ProxyStartup] Starting proxy verification...");

  const proxies = getProxyConfigs();
  const result: StartupVerificationResult = {
    success: false,
    connectedProxies: 0,
    totalProxies: proxies.length,
    errors: [],
  };

  if (proxies.length === 0) {
    result.errors.push("No proxy configuration found in environment variables");
    console.warn("[ProxyStartup] ⚠️  No proxies configured - startup will continue but without proxy redundancy");
    result.success = true; // Allow startup but warn
    return result;
  }

  // Verify each proxy in parallel
  const verificationPromises = proxies.map((proxy) => verifyProxyHealth(proxy));
  await Promise.all(verificationPromises);

  // Count results
  for (const proxy of proxies) {
    if (proxy.status === "connected") {
      result.connectedProxies++;
      console.log(`[ProxyStartup] ✓ ${proxy.name} connected (IP: ${proxy.outboundIp})`);
    } else {
      result.errors.push(`${proxy.name}: ${proxy.status}`);
      console.error(`[ProxyStartup] ✗ ${proxy.name} failed: ${proxy.status}`);
    }
  }

  // For 2/3 mesh: need at least 2 proxies connected
  // For minimal setup: allow 1 proxy (degraded mode)
  if (result.connectedProxies >= 2) {
    console.log(
      `[ProxyStartup] ✓ Proxy verification PASSED (${result.connectedProxies}/${result.totalProxies} connected)`
    );
    result.success = true;
  } else if (result.connectedProxies === 1) {
    console.warn(
      `[ProxyStartup] ⚠️  Only 1 proxy connected (${result.connectedProxies}/${result.totalProxies}) - running in degraded mode`
    );
    result.success = true; // Allow startup but degraded
  } else {
    console.error(
      `[ProxyStartup] ✗ Proxy verification FAILED (${result.connectedProxies}/${result.totalProxies} connected)`
    );
    result.success = false;
  }

  // Log proxy stats
  logProxyStats(proxies);

  return result;
}

/**
 * Print startup verification report
 */
export function printProxyStartupReport(result: StartupVerificationResult): void {
  if (result.success) {
    console.log("[ProxyStartup] ✓ Proxy startup verification PASSED");
    if (result.errors.length > 0) {
      console.log("[ProxyStartup] Warnings:");
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
    }
  } else {
    console.error("[ProxyStartup] ✗ Proxy startup verification FAILED");
    console.error("[ProxyStartup] This is blocking Pincher2 startup for reliability");
    console.error("[ProxyStartup] Please ensure proxies are running and accessible:");
    for (const error of result.errors) {
      console.error(`  ✗ ${error}`);
    }
  }
}

/**
 * Optional: Retry proxy verification with exponential backoff
 * Useful if proxies are still starting up
 */
export async function verifyProxiesWithRetry(
  maxRetries: number = 3,
  retryDelayMs: number = 5000
): Promise<StartupVerificationResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[ProxyStartup] Verification attempt ${attempt}/${maxRetries}...`);

    const result = await verifyProxiesForStartup();

    if (result.success && result.connectedProxies >= 1) {
      return result;
    }

    if (attempt < maxRetries) {
      console.log(`[ProxyStartup] Waiting ${retryDelayMs}ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  // Final attempt
  return await verifyProxiesForStartup();
}
