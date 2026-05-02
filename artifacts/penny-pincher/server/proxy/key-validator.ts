import crypto from "crypto";

interface KeyConflict {
  keyType: "shyft" | "chainstack";
  conflictingProxies: string[];
  duplicateValue: string;
}

interface KeyOverlapReport {
  hasConflicts: boolean;
  conflicts: KeyConflict[];
  timestamp: number;
}

/**
 * Generate SHA-256 hash of API key for conflict detection
 * Hash is used for comparison without storing actual keys in database
 */
export function hashApiKey(key: string): string {
  if (!key) return "";
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Detect API key overlaps between Pincher2 and all registered proxies
 * Compares SHA-256 hashes to find duplicate keys
 */
export function detectKeyOverlap(
  pincher2Config: {
    shyftKeyHash: string;
    chainstackUrlHash: string;
  },
  proxyConfigs: Array<{
    proxyName: string;
    shyftKeyHash: string;
    chainstackUrlHash: string;
  }>
): KeyOverlapReport {
  const conflicts: KeyConflict[] = [];
  const timestamp = Math.floor(Date.now() / 1000);

  // Track all Shyft key hashes
  const shyftHashes = new Map<string, string[]>();
  shyftHashes.set(pincher2Config.shyftKeyHash, ["pincher2"]);

  for (const proxy of proxyConfigs) {
    if (!shyftHashes.has(proxy.shyftKeyHash)) {
      shyftHashes.set(proxy.shyftKeyHash, []);
    }
    shyftHashes.get(proxy.shyftKeyHash)!.push(proxy.proxyName);
  }

  // Find duplicate Shyft keys
  for (const [keyHash, proxies] of shyftHashes) {
    if (proxies.length > 1 && keyHash) {
      conflicts.push({
        keyType: "shyft",
        conflictingProxies: proxies,
        duplicateValue: keyHash.substring(0, 8) + "...",
      });
    }
  }

  // Track all Chainstack URL hashes
  const chainstackHashes = new Map<string, string[]>();
  chainstackHashes.set(pincher2Config.chainstackUrlHash, ["pincher2"]);

  for (const proxy of proxyConfigs) {
    if (!chainstackHashes.has(proxy.chainstackUrlHash)) {
      chainstackHashes.set(proxy.chainstackUrlHash, []);
    }
    chainstackHashes.get(proxy.chainstackUrlHash)!.push(proxy.proxyName);
  }

  // Find duplicate Chainstack URLs
  for (const [urlHash, proxies] of chainstackHashes) {
    if (proxies.length > 1 && urlHash) {
      conflicts.push({
        keyType: "chainstack",
        conflictingProxies: proxies,
        duplicateValue: urlHash.substring(0, 8) + "...",
      });
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    timestamp,
  };
}

/**
 * Validate single key format before testing connectivity
 */
export function validateKeyFormat(
  key: string,
  type: "shyft" | "chainstack"
): { valid: boolean; error?: string } {
  if (!key || typeof key !== "string") {
    return { valid: false, error: `${type} key is required` };
  }

  if (type === "shyft") {
    if (key.length < 20) {
      return { valid: false, error: "Shyft key must be at least 20 characters" };
    }
    if (!/^[a-zA-Z0-9\-_]+$/.test(key)) {
      return {
        valid: false,
        error: "Shyft key contains invalid characters",
      };
    }
  }

  if (type === "chainstack") {
    if (!key.startsWith("https://")) {
      return {
        valid: false,
        error: "Chainstack URL must start with https://",
      };
    }
    if (!key.includes("solana-")) {
      return {
        valid: false,
        error: "Chainstack URL must be a Solana endpoint",
      };
    }
  }

  return { valid: true };
}

/**
 * Test Shyft API key connectivity with a simple RPC call
 */
export async function testShyftKey(key: string): Promise<{
  works: boolean;
  error?: string;
  latency?: number;
}> {
  const start = Date.now();

  try {
    const response = await fetch("https://api.shyft.to/sol/v1/rpc", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLatestBlockhash",
        params: [],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const latency = Date.now() - start;

    if (!response.ok) {
      if (response.status === 401) {
        return {
          works: false,
          error: "Invalid Shyft API key (401 Unauthorized)",
          latency,
        };
      }
      return {
        works: false,
        error: `Shyft API returned ${response.status}`,
        latency,
      };
    }

    const data = (await response.json()) as {
      error?: { message: string };
      result?: unknown;
    };
    if (data.error) {
      return {
        works: false,
        error: `Shyft RPC error: ${data.error.message}`,
        latency,
      };
    }

    return { works: true, latency };
  } catch (error) {
    return {
      works: false,
      error: `Failed to test Shyft key: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Test Chainstack RPC endpoint connectivity
 */
export async function testChainstackUrl(url: string): Promise<{
  works: boolean;
  error?: string;
  latency?: number;
}> {
  const start = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBlockCommitment",
        params: [0],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const latency = Date.now() - start;

    if (!response.ok) {
      return {
        works: false,
        error: `Chainstack returned ${response.status}`,
        latency,
      };
    }

    const data = (await response.json()) as {
      error?: { message: string };
      result?: unknown;
    };
    if (data.error) {
      return {
        works: false,
        error: `RPC error: ${data.error.message}`,
        latency,
      };
    }

    return { works: true, latency };
  } catch (error) {
    return {
      works: false,
      error: `Failed to test Chainstack endpoint: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Generate conflict report for display
 */
export function generateConflictReport(report: KeyOverlapReport): string {
  if (!report.hasConflicts) {
    return "✓ No API key overlaps detected";
  }

  let message = "⚠️ API Key Conflicts Detected:\n";

  for (const conflict of report.conflicts) {
    message += `\n${conflict.keyType.toUpperCase()} Key shared by: ${conflict.conflictingProxies.join(", ")}`;
  }

  message += "\n\nAction: Use unique API keys for each proxy to ensure independent rate limits.";

  return message;
}
