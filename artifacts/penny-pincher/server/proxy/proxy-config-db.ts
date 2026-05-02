import { db } from "../db";
import { proxyConfigs } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface ProxyConfigRecord {
  id?: number;
  proxyName: string;
  outboundIp: string;
  port: number;
  status: "idle" | "healthy" | "degraded" | "unhealthy";
  shyftKeyHash: string;
  chainstackUrlHash: string;
  lastSeenAt?: number;
  healthCheckLatency?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Create or update proxy configuration record
 */
export async function upsertProxyConfig(
  config: ProxyConfigRecord
): Promise<ProxyConfigRecord> {
  const now = Math.floor(Date.now() / 1000);

  // Check if exists
  const existing = await db
    .select()
    .from(proxyConfigs)
    .where(eq(proxyConfigs.proxyName, config.proxyName))
    .limit(1);

  if (existing.length > 0) {
    // Update existing
    await db
      .update(proxyConfigs)
      .set({
        outboundIp: config.outboundIp,
        port: config.port,
        status: config.status,
        shyftKeyHash: config.shyftKeyHash,
        chainstackUrlHash: config.chainstackUrlHash,
        lastSeenAt: config.lastSeenAt || now,
        healthCheckLatency: config.healthCheckLatency,
        updatedAt: now,
      })
      .where(eq(proxyConfigs.proxyName, config.proxyName));

    return {
      ...config,
      lastSeenAt: config.lastSeenAt || now,
      updatedAt: now,
    };
  } else {
    // Insert new
    await db.insert(proxyConfigs).values({
      proxyName: config.proxyName,
      outboundIp: config.outboundIp,
      port: config.port,
      status: config.status,
      shyftKeyHash: config.shyftKeyHash,
      chainstackUrlHash: config.chainstackUrlHash,
      lastSeenAt: config.lastSeenAt || now,
      healthCheckLatency: config.healthCheckLatency,
      createdAt: now,
      updatedAt: now,
    });

    return {
      ...config,
      lastSeenAt: config.lastSeenAt || now,
      createdAt: now,
      updatedAt: now,
    };
  }
}

/**
 * Get all proxy configurations
 */
export async function getAllProxyConfigs(): Promise<ProxyConfigRecord[]> {
  const results = await db.select().from(proxyConfigs);
  return results.map((r) => ({
    id: r.id,
    proxyName: r.proxyName,
    outboundIp: r.outboundIp,
    port: r.port,
    status: r.status as "idle" | "healthy" | "degraded" | "unhealthy",
    shyftKeyHash: r.shyftKeyHash,
    chainstackUrlHash: r.chainstackUrlHash,
    lastSeenAt: r.lastSeenAt,
    healthCheckLatency: r.healthCheckLatency,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Get single proxy configuration by name
 */
export async function getProxyConfigByName(
  proxyName: string
): Promise<ProxyConfigRecord | null> {
  const results = await db
    .select()
    .from(proxyConfigs)
    .where(eq(proxyConfigs.proxyName, proxyName))
    .limit(1);

  if (results.length === 0) return null;

  const r = results[0];
  return {
    id: r.id,
    proxyName: r.proxyName,
    outboundIp: r.outboundIp,
    port: r.port,
    status: r.status as "idle" | "healthy" | "degraded" | "unhealthy",
    shyftKeyHash: r.shyftKeyHash,
    chainstackUrlHash: r.chainstackUrlHash,
    lastSeenAt: r.lastSeenAt,
    healthCheckLatency: r.healthCheckLatency,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Update proxy status
 */
export async function updateProxyStatus(
  proxyName: string,
  status: "idle" | "healthy" | "degraded" | "unhealthy",
  latency?: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  const result = await db
    .update(proxyConfigs)
    .set({
      status,
      lastSeenAt: now,
      healthCheckLatency: latency,
      updatedAt: now,
    })
    .where(eq(proxyConfigs.proxyName, proxyName));

  return result.rowCount > 0;
}

/**
 * Delete proxy configuration
 */
export async function deleteProxyConfig(proxyName: string): Promise<boolean> {
  const result = await db
    .delete(proxyConfigs)
    .where(eq(proxyConfigs.proxyName, proxyName));

  return result.rowCount > 0;
}

/**
 * Get all key hashes for conflict detection
 */
export async function getAllKeyHashes(): Promise<{
  pincher2?: { shyftKeyHash: string; chainstackUrlHash: string };
  proxies: Array<{
    proxyName: string;
    shyftKeyHash: string;
    chainstackUrlHash: string;
  }>;
}> {
  const allConfigs = await getAllProxyConfigs();

  // Try to find pincher2 config (would be in env, but we can store a reference)
  // For now, return only proxy configs
  return {
    proxies: allConfigs.map((c) => ({
      proxyName: c.proxyName,
      shyftKeyHash: c.shyftKeyHash,
      chainstackUrlHash: c.chainstackUrlHash,
    })),
  };
}
