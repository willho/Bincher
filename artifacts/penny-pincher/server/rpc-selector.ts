import axios from "axios";

const RPC_CONFIG = {
  shyft: {
    endpoint: "https://api.shyft.to/sol/v1/rpc",
    rpsLimit: 10, // 10 requests per second
    priority: 1, // Try first
    budget: "unlimited",
  },
  chainstack: {
    endpoint: `https://solana-mainnet.core.chainstack.com/${process.env.CHAINSTACK_API_KEY}`,
    rpsLimit: 10, // Per second
    priority: 2, // Fallback
    budget: "1M credits/month",
  },
};

interface RpcCallOptions {
  method: string;
  params: any[];
  provider?: "shyft" | "chainstack"; // Force specific provider
}

interface RpcCallResult {
  result: any;
  usedProvider: "shyft" | "chainstack";
  latencyMs: number;
}

// Rate limiting: track RPS per provider
const rpsTrackers = {
  shyft: { callsThisSecond: 0, lastSecondReset: Date.now() },
  chainstack: { callsThisSecond: 0, lastSecondReset: Date.now() },
};

/**
 * Ensure we stay under RPS limit
 */
async function respectRpsLimit(provider: "shyft" | "chainstack"): Promise<void> {
  const tracker = rpsTrackers[provider];
  const now = Date.now();
  const timeSinceReset = now - tracker.lastSecondReset;

  // Reset counter if 1 second has passed
  if (timeSinceReset >= 1000) {
    tracker.callsThisSecond = 0;
    tracker.lastSecondReset = now;
  }

  // If we've hit the limit, wait until next second
  const limit = RPC_CONFIG[provider].rpsLimit;
  if (tracker.callsThisSecond >= limit) {
    const timeToWait = 1000 - timeSinceReset;
    if (timeToWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeToWait));
      tracker.callsThisSecond = 0;
      tracker.lastSecondReset = Date.now();
    }
  }

  tracker.callsThisSecond++;
}

/**
 * Make RPC call with automatic provider failover
 * Prefers Shyft (unlimited), falls back to Chainstack
 */
export async function callRpc(options: RpcCallOptions): Promise<RpcCallResult> {
  const { method, params, provider: forceProvider } = options;

  // If provider forced, use it
  if (forceProvider) {
    return callRpcOnProvider(forceProvider, method, params);
  }

  // Try Shyft first (unlimited)
  try {
    await respectRpsLimit("shyft");
    const startTime = Date.now();

    const response = await axios.post(RPC_CONFIG.shyft.endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });

    const latencyMs = Date.now() - startTime;

    if (response.data.error) {
      throw new Error(`Shyft RPC error: ${response.data.error.message}`);
    }

    return {
      result: response.data.result,
      usedProvider: "shyft",
      latencyMs,
    };
  } catch (error: any) {
    console.warn(
      `[RpcSelector] Shyft failed (${error.message}), falling back to Chainstack`
    );

    // Fall back to Chainstack
    return callRpcOnProvider("chainstack", method, params);
  }
}

/**
 * Call specific RPC provider
 */
async function callRpcOnProvider(
  provider: "shyft" | "chainstack",
  method: string,
  params: any[]
): Promise<RpcCallResult> {
  await respectRpsLimit(provider);

  const config = RPC_CONFIG[provider];
  const startTime = Date.now();

  const response = await axios.post(config.endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  const latencyMs = Date.now() - startTime;

  if (response.data.error) {
    throw new Error(
      `${provider} RPC error: ${response.data.error.message}`
    );
  }

  return {
    result: response.data.result,
    usedProvider: provider,
    latencyMs,
  };
}

/**
 * Get RPS usage statistics
 */
export function getRpsStats(): Record<
  string,
  { callsThisSecond: number; limit: number; utilization: number }
> {
  return {
    shyft: {
      callsThisSecond: rpsTrackers.shyft.callsThisSecond,
      limit: RPC_CONFIG.shyft.rpsLimit,
      utilization:
        (rpsTrackers.shyft.callsThisSecond / RPC_CONFIG.shyft.rpsLimit) * 100,
    },
    chainstack: {
      callsThisSecond: rpsTrackers.chainstack.callsThisSecond,
      limit: RPC_CONFIG.chainstack.rpsLimit,
      utilization:
        (rpsTrackers.chainstack.callsThisSecond / RPC_CONFIG.chainstack.rpsLimit) *
        100,
    },
  };
}

/**
 * Common RPC methods as helpers
 */
export async function getSignaturesForAddress(
  address: string,
  limit: number = 100
): Promise<any[]> {
  const result = await callRpc({
    method: "getSignaturesForAddress",
    params: [address, { limit }],
  });
  return result.result || [];
}

export async function getAccountInfo(address: string): Promise<any> {
  const result = await callRpc({
    method: "getAccountInfo",
    params: [address],
  });
  return result.result || null;
}

export async function getBalance(address: string): Promise<number> {
  const result = await callRpc({
    method: "getBalance",
    params: [address],
  });
  return result.result?.value || 0;
}

export async function getTokenAccountsByOwner(
  owner: string,
  programId: string
): Promise<any[]> {
  const result = await callRpc({
    method: "getTokenAccountsByOwner",
    params: [owner, { programId }],
  });
  return result.result?.value || [];
}
