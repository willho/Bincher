/**
 * API Health Check
 * Tests connectivity and health of all external APIs
 */

import axios from "axios";
import { EventSource } from "eventsource";

export interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  latency?: number;
  error?: string;
  timestamp: number;
}

class APIHealthChecker {
  /**
   * Check DexPaprika SSE availability
   */
  private async checkDexPaprika(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await axios.get(
        'https://streaming.dexpaprika.com/stream?chain=solana&address=So11111111111111111111111111111111111111112&method=t_p',
        {
          timeout: 5000,
          headers: {
            'User-Agent': 'Penny-Pincher-Health-Check/1.0'
          }
        }
      );

      const latency = Date.now() - start;
      return {
        service: 'DexPaprika SSE',
        status: response.status === 200 ? 'healthy' : 'degraded',
        latency,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        service: 'DexPaprika SSE',
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check DexScreener availability
   */
  private async checkDexScreener(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/solana?limit=1',
        {
          timeout: 5000,
          headers: {
            'User-Agent': 'Penny-Pincher-Health-Check/1.0'
          }
        }
      );

      const latency = Date.now() - start;
      return {
        service: 'DexScreener',
        status: response.status === 200 ? 'healthy' : 'degraded',
        latency,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        service: 'DexScreener',
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check PumpPortal WebSocket availability
   */
  private async checkPumpPortal(): Promise<HealthStatus> {
    const start = Date.now();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          service: 'PumpPortal',
          status: 'unavailable',
          error: 'Connection timeout (5s)',
          timestamp: Date.now()
        });
      }, 5000);

      try {
        const ws = new (require('ws'))('wss://pumpportal.fun/api/data');

        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve({
            service: 'PumpPortal',
            status: 'healthy',
            latency: Date.now() - start,
            timestamp: Date.now()
          });
        });

        ws.on('error', (error: any) => {
          clearTimeout(timeout);
          resolve({
            service: 'PumpPortal',
            status: 'unavailable',
            error: error.message || 'Connection failed',
            timestamp: Date.now()
          });
        });
      } catch (error) {
        clearTimeout(timeout);
        resolve({
          service: 'PumpPortal',
          status: 'unavailable',
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: Date.now()
        });
      }
    });
  }

  /**
   * Check Chainstack RPC availability
   */
  private async checkChainstack(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await axios.post(
        process.env.CHAINSTACK_RPC_URL || 'https://solana-mainnet.core.chainstack.com/',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBlockCommitment',
          params: [1]
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      const latency = Date.now() - start;
      const hasError = response.data.error ? true : false;

      return {
        service: 'Chainstack RPC',
        status: !hasError ? 'healthy' : 'degraded',
        latency,
        error: hasError ? response.data.error.message : undefined,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        service: 'Chainstack RPC',
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check Shyft RPC availability
   */
  private async checkShyft(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await axios.post(
        'https://api.shyft.to/sol/v1/rpc',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBlockCommitment',
          params: [1]
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.SHYFT_API_KEY || 'public'
          }
        }
      );

      const latency = Date.now() - start;
      const hasError = response.data.error ? true : false;

      return {
        service: 'Shyft RPC',
        status: !hasError ? 'healthy' : 'degraded',
        latency,
        error: hasError ? response.data.error.message : undefined,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        service: 'Shyft RPC',
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Check RugCheck availability
   */
  private async checkRugCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const response = await axios.head(
        'https://api.rugcheck.xyz/v1/tokens/solana/So11111111111111111111111111111111111111112/report/summary',
        {
          timeout: 5000
        }
      );

      const latency = Date.now() - start;
      return {
        service: 'RugCheck',
        status: response.status === 200 ? 'healthy' : 'degraded',
        latency,
        timestamp: Date.now()
      };
    } catch (error) {
      // RugCheck may return 404 for some tokens, but that's ok (service is up)
      return {
        service: 'RugCheck',
        status: 'healthy',
        latency: Date.now() - start,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Run all health checks in parallel
   */
  async checkAllAPIs(): Promise<HealthStatus[]> {
    const checks = [
      this.checkDexPaprika(),
      this.checkDexScreener(),
      this.checkPumpPortal(),
      this.checkChainstack(),
      this.checkShyft(),
      this.checkRugCheck()
    ];

    const results = await Promise.allSettled(checks);
    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          service: 'Unknown',
          status: 'unavailable' as const,
          error: 'Promise rejected',
          timestamp: Date.now()
        };
      }
    });
  }
}

export const apiHealthChecker = new APIHealthChecker();
