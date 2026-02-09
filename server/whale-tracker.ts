import { db } from "./db";
import { familiarWhales, whaleTokenPositions, tokenDataPool, FamiliarWhale } from "@shared/schema";
import { eq, and, desc, gte, inArray, sql, or } from "drizzle-orm";
import { addWhaleWallet, removeWhaleWallet } from "./unified-webhook";

const MAX_ACTIVE_WHALES = 50;
const MAX_WATCH_WHALES = 200;
const WATCH_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const TIER_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const WHALE_TOKEN_CAP = 10; // Max tokens per whale in discovery pool

type WhaleTier = "active" | "watch" | "archive";

let watchPollTimer: ReturnType<typeof setInterval> | null = null;
let rotationTimer: ReturnType<typeof setInterval> | null = null;

function computeTierScore(whale: FamiliarWhale): number {
  let score = 0;
  
  // Recency: more recent activity = higher score (0-30 points)
  const daysSinceLastSeen = (Date.now() / 1000 - whale.lastSeenAt) / 86400;
  score += Math.max(0, 30 - daysSinceLastSeen * 2);
  
  // Success rate: better track record = higher score (0-25 points)
  const successRate = whale.successRate || 0;
  score += successRate * 25;
  
  // Volume: more trades = higher score (0-20 points, diminishing)
  const totalExits = whale.totalExits || 0;
  score += Math.min(20, totalExits * 2);
  
  // Reliability: composite reliability score (0-15 points)
  const reliability = whale.reliabilityScore || 50;
  score += (reliability / 100) * 15;
  
  // Early entry bonus (0-10 points)
  const earlyEntries = whale.earlyEntryCount || 0;
  score += Math.min(10, earlyEntries * 2);
  
  return Math.round(score * 10) / 10;
}

export async function getWhalesByTier(tier: WhaleTier): Promise<FamiliarWhale[]> {
  return db.select().from(familiarWhales)
    .where(eq(familiarWhales.monitoringTier, tier))
    .orderBy(desc(familiarWhales.tierScore));
}

export async function getActiveWhaleCount(): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(familiarWhales)
    .where(eq(familiarWhales.monitoringTier, "active"));
  return result?.count || 0;
}

export async function setWhaleTier(whaleId: number, tier: WhaleTier): Promise<void> {
  const [whale] = await db.select().from(familiarWhales)
    .where(eq(familiarWhales.id, whaleId));
  
  if (!whale) return;
  
  const oldTier = whale.monitoringTier || "archive";
  const now = Math.floor(Date.now() / 1000);
  
  await db.update(familiarWhales)
    .set({
      monitoringTier: tier,
      tierAssignedAt: now,
      tierScore: computeTierScore(whale),
    })
    .where(eq(familiarWhales.id, whaleId));
  
  // Manage webhook registrations
  if (tier === "active" && oldTier !== "active") {
    addWhaleWallet(whale.walletAddress, { whaleId: whale.id });
    console.log(`[WhaleTracker] Promoted ${whale.walletAddress.slice(0,8)} to ACTIVE (webhook)`);
  } else if (tier !== "active" && oldTier === "active") {
    removeWhaleWallet(whale.walletAddress);
    console.log(`[WhaleTracker] Demoted ${whale.walletAddress.slice(0,8)} from ACTIVE to ${tier.toUpperCase()}`);
  }
}

export async function promoteToActive(walletAddress: string): Promise<boolean> {
  const activeCount = await getActiveWhaleCount();
  if (activeCount >= MAX_ACTIVE_WHALES) return false;
  
  const [whale] = await db.select().from(familiarWhales)
    .where(eq(familiarWhales.walletAddress, walletAddress));
  
  if (!whale) return false;
  if (whale.monitoringTier === "active") return true;
  
  await setWhaleTier(whale.id, "active");
  return true;
}

export async function promoteToWatch(walletAddress: string): Promise<boolean> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(familiarWhales)
    .where(eq(familiarWhales.monitoringTier, "watch"));
  
  const watchCount = result?.count || 0;
  if (watchCount >= MAX_WATCH_WHALES) return false;
  
  const [whale] = await db.select().from(familiarWhales)
    .where(eq(familiarWhales.walletAddress, walletAddress));
  
  if (!whale) return false;
  if (whale.monitoringTier === "active" || whale.monitoringTier === "watch") return true;
  
  await setWhaleTier(whale.id, "watch");
  return true;
}

export async function rotateTiers(): Promise<{ promoted: number; demoted: number }> {
  const now = Math.floor(Date.now() / 1000);
  let promoted = 0;
  let demoted = 0;
  
  // Recompute tier scores for all non-archive whales
  const allWhales = await db.select().from(familiarWhales)
    .where(or(
      eq(familiarWhales.monitoringTier, "active"),
      eq(familiarWhales.monitoringTier, "watch")
    ));
  
  for (const whale of allWhales) {
    const newScore = computeTierScore(whale);
    await db.update(familiarWhales)
      .set({ tierScore: newScore })
      .where(eq(familiarWhales.id, whale.id));
  }
  
  // Also score watch+archive candidates for promotion
  const archiveCandidates = await db.select().from(familiarWhales)
    .where(and(
      eq(familiarWhales.monitoringTier, "archive"),
      gte(familiarWhales.lastSeenAt, now - 30 * 86400) // Active in last 30 days
    ));
  
  for (const whale of archiveCandidates) {
    const newScore = computeTierScore(whale);
    await db.update(familiarWhales)
      .set({ tierScore: newScore })
      .where(eq(familiarWhales.id, whale.id));
  }
  
  // Get all whales ranked by score
  const allRanked = await db.select().from(familiarWhales)
    .where(gte(familiarWhales.tierScore, 10)) // Minimum threshold
    .orderBy(desc(familiarWhales.tierScore));
  
  // Assign tiers: top 50 = active, next 200 = watch, rest = archive
  for (let i = 0; i < allRanked.length; i++) {
    const whale = allRanked[i];
    let targetTier: WhaleTier;
    
    if (i < MAX_ACTIVE_WHALES) {
      targetTier = "active";
    } else if (i < MAX_ACTIVE_WHALES + MAX_WATCH_WHALES) {
      targetTier = "watch";
    } else {
      targetTier = "archive";
    }
    
    const currentTier = (whale.monitoringTier || "archive") as WhaleTier;
    
    if (targetTier !== currentTier) {
      await setWhaleTier(whale.id, targetTier);
      
      if (targetTier === "active" && currentTier !== "active") promoted++;
      if (targetTier === "archive" && currentTier !== "archive") demoted++;
      if (targetTier === "watch" && currentTier === "active") demoted++;
      if (targetTier === "active" && currentTier === "watch") promoted++;
    }
  }
  
  // Demote whales with score below threshold to archive
  const lowScoreWhales = await db.select().from(familiarWhales)
    .where(and(
      or(
        eq(familiarWhales.monitoringTier, "active"),
        eq(familiarWhales.monitoringTier, "watch")
      ),
      sql`${familiarWhales.tierScore} < 10`
    ));
  
  for (const whale of lowScoreWhales) {
    await setWhaleTier(whale.id, "archive");
    demoted++;
  }
  
  if (promoted > 0 || demoted > 0) {
    console.log(`[WhaleTracker] Rotation complete: ${promoted} promoted, ${demoted} demoted`);
  }
  
  return { promoted, demoted };
}

async function pollWatchTierWhales(): Promise<void> {
  const watchWhales = await getWhalesByTier("watch");
  if (watchWhales.length === 0) return;
  
  // Batch check: look for recent transactions from watch-tier whales
  // Using the Chainstack/Helius RPC to check signatures
  const batchSize = 20;
  const now = Math.floor(Date.now() / 1000);
  const lookbackSeconds = 15 * 60; // 15 minute lookback
  
  for (let i = 0; i < watchWhales.length; i += batchSize) {
    const batch = watchWhales.slice(i, i + batchSize);
    
    for (const whale of batch) {
      try {
        // Check for recent transaction signatures via RPC
        const { getSignaturesForAddress } = await import("./rpc-provider");
        const recentTxs = await getSignaturesForAddress(whale.walletAddress, { limit: 5 });
        
        if (recentTxs && recentTxs.length > 0) {
          // Update last seen
          await db.update(familiarWhales)
            .set({ lastSeenAt: now })
            .where(eq(familiarWhales.id, whale.id));
          
          // If whale is very active, consider promoting to active tier
          const score = computeTierScore({ ...whale, lastSeenAt: now });
          if (score >= 60) {
            const activeCount = await getActiveWhaleCount();
            if (activeCount < MAX_ACTIVE_WHALES) {
              await setWhaleTier(whale.id, "active");
              console.log(`[WhaleTracker] Watch whale ${whale.walletAddress.slice(0,8)} promoted to ACTIVE (score=${score})`);
            }
          }
        }
      } catch (err) {
        // Silently continue - RPC errors are expected
      }
    }
    
    // Rate limit between batches
    if (i + batchSize < watchWhales.length) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function getWhaleTokenCount(whaleAddress: string): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` })
    .from(whaleTokenPositions)
    .where(and(
      eq(whaleTokenPositions.walletAddress, whaleAddress),
      eq(whaleTokenPositions.status, "holding")
    ));
  return result?.count || 0;
}

export async function isWhaleTokenCapReached(whaleAddress: string): Promise<boolean> {
  const count = await getWhaleTokenCount(whaleAddress);
  return count >= WHALE_TOKEN_CAP;
}

export function getTrackerStats(): {
  maxActive: number;
  maxWatch: number;
  tokenCapPerWhale: number;
} {
  return {
    maxActive: MAX_ACTIVE_WHALES,
    maxWatch: MAX_WATCH_WHALES,
    tokenCapPerWhale: WHALE_TOKEN_CAP,
  };
}

export async function initializeWhaleTracker(): Promise<void> {
  // Register existing active-tier whales with the unified webhook
  const activeWhales = await getWhalesByTier("active");
  
  for (const whale of activeWhales) {
    addWhaleWallet(whale.walletAddress, { whaleId: whale.id });
  }
  
  console.log(`[WhaleTracker] Initialized: ${activeWhales.length} active whales registered with webhook`);
  
  // Start periodic watch-tier polling
  watchPollTimer = setInterval(async () => {
    try {
      await pollWatchTierWhales();
    } catch (err) {
      console.error("[WhaleTracker] Watch poll error:", err);
    }
  }, WATCH_POLL_INTERVAL_MS);
  
  // Start weekly tier rotation
  rotationTimer = setInterval(async () => {
    try {
      await rotateTiers();
    } catch (err) {
      console.error("[WhaleTracker] Rotation error:", err);
    }
  }, TIER_ROTATION_INTERVAL_MS);
  
  // Run initial rotation after 5 minutes
  setTimeout(() => {
    rotateTiers().catch(err => console.error("[WhaleTracker] Initial rotation error:", err));
  }, 5 * 60 * 1000);
}

export function stopWhaleTracker(): void {
  if (watchPollTimer) {
    clearInterval(watchPollTimer);
    watchPollTimer = null;
  }
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  console.log("[WhaleTracker] Stopped");
}
