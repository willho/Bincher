import { db } from "./db";
import { familiarWhales, whaleTokenPositions, tokenDataPool, FamiliarWhale } from "@shared/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { upsertTokenData } from "./data-pool";
import { isWhaleTokenCapReached, promoteToWatch } from "./whale-tracker";

const RECENCY_FILTER_HOURS = 24;
const WHALE_TOKEN_CAP = 10;
const MIN_WHALE_SCORE = 30; // Minimum tier score to source tokens from
const HOP_DISCOVERY_ENABLED = true;
const MAX_HOP_DEPTH = 1; // Only discover 1 hop from source whale

interface WhaleDiscoveryResult {
  tokenMint: string;
  tokenSymbol?: string;
  whaleAddress: string;
  whaleScore: number;
  hopDepth: number;
  discoverySource: "whale";
}

export async function processWhaleTokenDiscovery(
  whaleAddress: string,
  tokenMint: string,
  tokenSymbol?: string,
  action: "buy" | "sell" = "buy"
): Promise<WhaleDiscoveryResult | null> {
  if (action !== "buy") return null;

  // Check recency - only process tokens bought in last 24h
  // (the whale just bought, so this is inherently recent)

  // Look up whale
  const [whale] = await db.select().from(familiarWhales)
    .where(eq(familiarWhales.walletAddress, whaleAddress));

  if (!whale) return null;

  const whaleScore = whale.tierScore || 0;
  if (whaleScore < MIN_WHALE_SCORE) return null;

  // Check per-whale token cap
  if (await isWhaleTokenCapReached(whaleAddress)) {
    console.log(`[WhaleDiscovery] Cap reached for whale ${whaleAddress.slice(0,8)} (${WHALE_TOKEN_CAP} tokens)`);
    return null;
  }

  // Check if token already in pool
  const [existing] = await db.select({ tokenMint: tokenDataPool.tokenMint })
    .from(tokenDataPool)
    .where(eq(tokenDataPool.tokenMint, tokenMint))
    .limit(1);

  if (existing) {
    // Token already known — update discovery source if whale is better source
    await db.update(tokenDataPool)
      .set({
        discoverySource: "whale",
        discoverySourceWallet: whaleAddress,
        discoveryHopDepth: 0,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(and(
        eq(tokenDataPool.tokenMint, tokenMint),
        sql`${tokenDataPool.discoverySource} IS NULL OR ${tokenDataPool.discoverySource} != 'whale'`
      ));

    return {
      tokenMint,
      tokenSymbol,
      whaleAddress,
      whaleScore,
      hopDepth: 0,
      discoverySource: "whale",
    };
  }

  // New token — add to pool with whale source
  try {
    await upsertTokenData(tokenMint, {
      tokenSymbol: tokenSymbol || undefined,
    }, "whale_discovery");

    // Tag with discovery source
    await db.update(tokenDataPool)
      .set({
        discoverySource: "whale",
        discoverySourceWallet: whaleAddress,
        discoveryHopDepth: 0,
      })
      .where(eq(tokenDataPool.tokenMint, tokenMint));

    console.log(`[WhaleDiscovery] New token ${tokenSymbol || tokenMint.slice(0,8)} sourced from whale ${whaleAddress.slice(0,8)} (score=${whaleScore})`);

    // Emit discovery event
    try {
      const { emit } = await import("./discovery-event-bus");
      await emit({
        type: "whale_activity" as any,
        tokenMint,
        tokenSymbol,
        source: "whale_discovery",
        data: {
          walletAddress: whaleAddress,
          whaleScore,
          discoveryHop: 0,
          action: "buy",
        },
        timestamp: Date.now(),
        urgency: 8,
      });
    } catch (_) {}

    return {
      tokenMint,
      tokenSymbol,
      whaleAddress,
      whaleScore,
      hopDepth: 0,
      discoverySource: "whale",
    };
  } catch (err) {
    console.error(`[WhaleDiscovery] Failed to add token ${tokenMint}:`, err);
    return null;
  }
}

export async function discoverNewWhalesFromToken(
  tokenMint: string,
  sourceWhaleAddress: string
): Promise<number> {
  if (!HOP_DISCOVERY_ENABLED) return 0;

  // Look at top holders of this token to find new potential whales
  const { getHoldersCached } = await import("./price-aggregator");
  const holderData = await getHoldersCached(tokenMint, false);

  if (!holderData || !holderData.holders || holderData.holders.length === 0) {
    return 0;
  }

  let newWhalesFound = 0;
  const topHolders = holderData.holders.slice(0, 20); // Top 20 holders

  for (const holder of topHolders) {
    const holderAddress = holder.address;
    if (!holderAddress || holderAddress === sourceWhaleAddress) continue;

    // Check if this holder is already tracked
    const [existing] = await db.select({ id: familiarWhales.id })
      .from(familiarWhales)
      .where(eq(familiarWhales.walletAddress, holderAddress))
      .limit(1);

    if (existing) continue;

    // New whale — add to archive tier (will be promoted via rotation if they perform well)
    const now = Math.floor(Date.now() / 1000);
    try {
      await db.insert(familiarWhales).values({
        walletAddress: holderAddress,
        firstSeenAt: now,
        lastSeenAt: now,
        totalTokensSeen: 1,
        monitoringTier: "archive",
        tierScore: 5, // Low initial score
      });

      // Try to promote to Watch tier
      await promoteToWatch(holderAddress);
      newWhalesFound++;
    } catch (err) {
      // Likely duplicate address, skip
    }
  }

  if (newWhalesFound > 0) {
    console.log(`[WhaleDiscovery] Discovered ${newWhalesFound} new whale candidates from token ${tokenMint.slice(0,8)} (hop from ${sourceWhaleAddress.slice(0,8)})`);
  }

  return newWhalesFound;
}

export async function getWhaleDiscoveryStats(): Promise<{
  totalWhaleSourcedTokens: number;
  recentDiscoveries: number;
  activeWhalesWithTokens: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;

  const [total] = await db.select({ count: sql<number>`count(*)` })
    .from(tokenDataPool)
    .where(eq(tokenDataPool.discoverySource, "whale"));

  const [recent] = await db.select({ count: sql<number>`count(*)` })
    .from(tokenDataPool)
    .where(and(
      eq(tokenDataPool.discoverySource, "whale"),
      gte(tokenDataPool.createdAt, oneDayAgo)
    ));

  const [activeWithTokens] = await db.select({ count: sql<number>`count(distinct ${whaleTokenPositions.walletAddress})` })
    .from(whaleTokenPositions)
    .where(eq(whaleTokenPositions.status, "holding"));

  return {
    totalWhaleSourcedTokens: total?.count || 0,
    recentDiscoveries: recent?.count || 0,
    activeWhalesWithTokens: activeWithTokens?.count || 0,
  };
}
