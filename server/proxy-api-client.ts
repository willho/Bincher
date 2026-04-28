/**
 * Proxy API Client
 *
 * Routes requests through proxy instances for redundancy
 * Implements load-balancing and automatic failover
 */

import {
  type ProxyInstance,
  getProxyConfigs,
  selectHealthyProxy,
} from "./proxy-config";
import { rateLimiter } from "./unified-rate-limiter";

export interface ProxyRequestOptions {
  service: "shyft" | "chainstack" | "dexpaprika"; // Service to route through
  method?: "GET" | "POST";
  body?: any;
  timeout?: number;
}

export interface ProxyRequestResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  proxyUsed?: string;
}

/**
 * Make a request through a healthy proxy
 */
export async function requestViaProxy<T = any>(
  path: string,
  options: ProxyRequestOptions
): Promise<ProxyRequestResult<T>> {
  const proxies = getProxyConfigs();
  const healthyProxy = selectHealthyProxy(proxies);

  if (!healthyProxy) {
    return {
      success: false,
      error: "No healthy proxies available",
    };
  }

  try {
    // Enforce rate limit for the service being called
    await rateLimiter.waitUntilAllowed(options.service);

    // Build proxy URL
    const proxyUrl = `${healthyProxy.url}/api/proxy-forward`;

    // Prepare request payload
    const payload = {
      service: options.service,
      path,
      method: options.method || "GET",
      body: options.body,
      apiKeys: {
        shyft: healthyProxy.shyftKey,
        chainstack: healthyProxy.chainstackRpc,
      },
    };

    // Make request to proxy
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${healthyProxy.authKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeout: options.timeout || 10000,
    });

    // Track usage for load-balancing
    healthyProxy.requestCount++;

    if (!response.ok) {
      return {
        success: false,
        error: `Proxy error: ${response.status} ${response.statusText}`,
        proxyUsed: healthyProxy.name,
      };
    }

    const data = (await response.json()) as T;
    return {
      success: true,
      data,
      proxyUsed: healthyProxy.name,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      proxyUsed: healthyProxy.name,
    };
  }
}

/**
 * Request with automatic retry on different proxy
 */
export async function requestViaProxyWithFallback<T = any>(
  path: string,
  options: ProxyRequestOptions,
  maxRetries: number = 2
): Promise<ProxyRequestResult<T>> {
  let lastError: ProxyRequestResult<T> | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await requestViaProxy<T>(path, options);

    if (result.success) {
      return result;
    }

    lastError = result;

    if (attempt < maxRetries - 1) {
      console.warn(
        `[ProxyClient] Request failed via ${result.proxyUsed}, retrying (attempt ${attempt + 2}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return lastError || {
    success: false,
    error: "All proxy attempts failed",
  };
}

/**
 * Helper: Make Shyft RPC call through proxy
 */
export async function callShyftRpcViaProxy<T = any>(
  method: string,
  params: any[]
): Promise<ProxyRequestResult<T>> {
  return requestViaProxyWithFallback<T>(
    "/api/shyft/rpc",
    {
      service: "shyft",
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method,
        params,
        id: 1,
      },
    }
  );
}

/**
 * Helper: Make Chainstack RPC call through proxy
 */
export async function callChainstackRpcViaProxy<T = any>(
  method: string,
  params: any[]
): Promise<ProxyRequestResult<T>> {
  return requestViaProxyWithFallback<T>(
    "/api/chainstack/rpc",
    {
      service: "chainstack",
      method: "POST",
      body: {
        jsonrpc: "2.0",
        method,
        params,
        id: 1,
      },
    }
  );
}

/**
 * Helper: Get token info via Shyft through proxy
 */
export async function getTokenInfoViaProxy(mint: string): Promise<ProxyRequestResult<any>> {
  return requestViaProxyWithFallback(
    `/api/shyft/tokens/${mint}`,
    {
      service: "shyft",
      method: "GET",
    }
  );
}

/**
 * Log proxy usage stats
 */
export function logProxyUsageStats(): void {
  const proxies = getProxyConfigs();
  console.log("[ProxyClient] Usage Stats:");
  for (const proxy of proxies) {
    console.log(
      `  ${proxy.name}: ${proxy.requestCount} requests | Status: ${proxy.status}`
    );
  }
}
