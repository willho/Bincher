/**
 * Proxy Registration & Status Tracking
 * Handles registration of proxy servers and tracks their status
 */

interface ProxyInfo {
  name: string;
  outboundIP: string;
  port: number;
  registeredAt: number;
  lastHeartbeat: number;
}

class ProxyRegistry {
  private proxies: Map<string, ProxyInfo> = new Map();
  private expectedProxyNames = ['proxy-1', 'proxy-2']; // 2 proxies expected

  /**
   * Register a proxy
   */
  registerProxy(name: string, outboundIP: string, port: number = 3000): ProxyInfo {
    const now = Date.now();
    const proxy: ProxyInfo = {
      name,
      outboundIP,
      port,
      registeredAt: now,
      lastHeartbeat: now,
    };

    this.proxies.set(name, proxy);
    console.log(`[Proxy Registry] Registered: ${name} @ ${outboundIP}:${port}`);
    return proxy;
  }

  /**
   * Update heartbeat for a proxy
   */
  updateHeartbeat(name: string): boolean {
    const proxy = this.proxies.get(name);
    if (!proxy) return false;

    proxy.lastHeartbeat = Date.now();
    return true;
  }

  /**
   * Get all registered proxies
   */
  getAllProxies(): ProxyInfo[] {
    return Array.from(this.proxies.values());
  }

  /**
   * Get status of all expected proxies
   */
  getStatus() {
    const status = this.expectedProxyNames.map((name) => {
      const proxy = this.proxies.get(name);
      return {
        name,
        registered: !!proxy,
        ip: proxy?.outboundIP || null,
        lastSeen: proxy ? `${Math.round((Date.now() - proxy.lastHeartbeat) / 1000)}s ago` : null,
      };
    });

    const allRegistered = status.every((s) => s.registered);
    const ips = status
      .filter((s) => s.ip)
      .map((s) => s.ip) as string[];
    const uniqueIPs = new Set(ips).size === ips.length;

    return {
      proxies: status,
      allRegistered,
      uniqueIPs,
      ipCount: new Set(ips).size,
    };
  }

  /**
   * Check if all expected proxies are registered with unique IPs
   */
  areAllProxiesReady(): boolean {
    const status = this.getStatus();
    return status.allRegistered && status.uniqueIPs;
  }

  /**
   * Get proxy count
   */
  getProxyCount(): number {
    return this.proxies.size;
  }

  /**
   * Clear all proxies (for testing)
   */
  clear(): void {
    this.proxies.clear();
  }
}

export const proxyRegistry = new ProxyRegistry();
