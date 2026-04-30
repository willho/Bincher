/**
 * Proxy Configuration & Management
 *
 * Manages connections to proxy instances with API key rotation
 * Each proxy has:
 * - Own auth key (for Pincher2 to authenticate)
 * - Own Shyft API key (unlimited free tier)
 * - Own Chainstack RPC (1M credits/month)
 */

export interface ProxyInstance {
  name: "proxy-1" | "proxy-2" | "proxy-3";
  url: string; // https://proxy-1.replit.dev
  authKey: string; // Bearer token for Pincher2 → Proxy auth
  shyftKey: string; // Shyft HTTP RPC key
  chainstackRpc: string; // Chainstack JSON-RPC endpoint
  status: "connected" | "disconnected" | "error";
  outboundIp?: string; // Detected on health check
  lastHealthCheck?: number;
  requestCount: number; // Track usage for rotation
}

/**
 * Get proxy configuration from environment
 */
export function getProxyConfigs(): ProxyInstance[] {
  const proxies: ProxyInstance[] = [];

  // Proxy 1
  if (process.env.PROXY_1_URL && process.env.PROXY_1_AUTH_KEY) {
    proxies.push({
      name: "proxy-1",
      url: process.env.PROXY_1_URL,
      authKey: process.env.PROXY_1_AUTH_KEY,
      shyftKey: process.env.PROXY_1_SHYFT_KEY || "",
      chainstackRpc: process.env.PROXY_1_CHAINSTACK_RPC || "",
      status: "disconnected",
      requestCount: 0,
    });
  }

  // Proxy 2
  if (process.env.PROXY_2_URL && process.env.PROXY_2_AUTH_KEY) {
    proxies.push({
      name: "proxy-2",
      url: process.env.PROXY_2_URL,
      authKey: process.env.PROXY_2_AUTH_KEY,
      shyftKey: process.env.PROXY_2_SHYFT_KEY || "",
      chainstackRpc: process.env.PROXY_2_CHAINSTACK_RPC || "",
      status: "disconnected",
      requestCount: 0,
    });
  }

  // Proxy 3
  if (process.env.PROXY_3_URL && process.env.PROXY_3_AUTH_KEY) {
    proxies.push({
      name: "proxy-3",
      url: process.env.PROXY_3_URL,
      authKey: process.env.PROXY_3_AUTH_KEY,
      shyftKey: process.env.PROXY_3_SHYFT_KEY || "",
      chainstackRpc: process.env.PROXY_3_CHAINSTACK_RPC || "",
      status: "disconnected",
      requestCount: 0,
    });
  }

  return proxies;
}

/**
 * Verify proxy health and detect outbound IP
 */
export async function verifyProxyHealth(proxy: ProxyInstance): Promise<boolean> {
  try {
    const response = await fetch(`${proxy.url}/api/proxy/health`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${proxy.authKey}`,
      },
      timeout: 5000,
    });

    if (!response.ok) {
      proxy.status = "error";
      return false;
    }

    const data = (await response.json()) as {
      status: string;
      outboundIp?: string;
    };
    proxy.status = "connected";
    proxy.outboundIp = data.outboundIp;
    proxy.lastHealthCheck = Date.now();

    return true;
  } catch (error) {
    proxy.status = "error";
    console.error(`[ProxyConfig] Health check failed for ${proxy.name}:`, error);
    return false;
  }
}

/**
 * Get next healthy proxy using round-robin with request count
 */
export function selectHealthyProxy(proxies: ProxyInstance[]): ProxyInstance | null {
  const healthy = proxies.filter((p) => p.status === "connected");

  if (healthy.length === 0) {
    return null;
  }

  // Round-robin by request count (least-loaded proxy)
  return healthy.reduce((prev, current) =>
    prev.requestCount <= current.requestCount ? prev : current
  );
}

/**
 * Format proxy URLs for different services
 */
export function getProxyApiEndpoint(
  proxy: ProxyInstance,
  service: "shyft" | "chainstack"
): string {
  if (service === "shyft") {
    return `${proxy.url}/api/shyft?key=${proxy.shyftKey}`;
  } else if (service === "chainstack") {
    return `${proxy.url}/api/rpc?endpoint=${encodeURIComponent(proxy.chainstackRpc)}`;
  }
  throw new Error(`Unknown service: ${service}`);
}

/**
 * Log proxy stats for monitoring
 */
export function logProxyStats(proxies: ProxyInstance[]): void {
  console.log("[ProxyConfig] Proxy Status Report:");
  for (const proxy of proxies) {
    console.log(
      `  ${proxy.name}: ${proxy.status} | IP: ${proxy.outboundIp || "unknown"} | Requests: ${proxy.requestCount}`
    );
  }
}
