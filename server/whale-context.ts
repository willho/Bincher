import { db } from "./db";
import { familiarWhales, tokenDataPool } from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";

const WHALE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const MIN_HOLDER_PERCENT = 0.5;

interface WhaleContext {
  whaleHolderCount: number;
  whaleAvgReputation: number;
  whaleBestReputation: number | null;
  whaleWorstReputation: number | null;
  whaleNetSentiment: number;
  newWhalesDiscovered: number;
}

export async function scanAndStoreWhaleContext(tokenMint: string): Promise<WhaleContext | null> {
  try {
    const existing = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, tokenMint),
      columns: { whaleContextUpdatedAt: true },
    });

    if (existing?.whaleContextUpdatedAt) {
      const age = Date.now() - existing.whaleContextUpdatedAt * 1000;
      if (age < WHALE_CONTEXT_TTL_MS) return null;
    }

    const { getHoldersCached } = await import("./price-aggregator");
    const holderData = await getHoldersCached(tokenMint, false);

    if (!holderData || !holderData.holders || holderData.holders.length === 0) {
      return null;
    }

    const holderAddresses = holderData.holders
      .filter((h: any) => h.address && (h.percent == null || h.percent >= MIN_HOLDER_PERCENT))
      .slice(0, 50)
      .map((h: any) => h.address);

    if (holderAddresses.length === 0) return null;

    const knownWhales = await db.select({
      walletAddress: familiarWhales.walletAddress,
      successRate: familiarWhales.successRate,
      reliabilityScore: familiarWhales.reliabilityScore,
      tierScore: familiarWhales.tierScore,
      totalExits: familiarWhales.totalExits,
      monitoringTier: familiarWhales.monitoringTier,
    })
      .from(familiarWhales)
      .where(inArray(familiarWhales.walletAddress, holderAddresses));

    let newWhalesDiscovered = 0;

    const nonWhaleHolders = holderAddresses.filter(
      (addr: string) => !knownWhales.some(w => w.walletAddress === addr)
    );

    if (nonWhaleHolders.length > 0) {
      const { discoverNewWhalesFromToken } = await import("./whale-discovery");
      newWhalesDiscovered = await discoverNewWhalesFromToken(tokenMint, "discovery_scan");
    }

    const now = Math.floor(Date.now() / 1000);

    if (knownWhales.length === 0) {
      await db.update(tokenDataPool)
        .set({
          whaleHolderCount: 0,
          whaleAvgReputation: null,
          whaleBestReputation: null,
          whaleWorstReputation: null,
          whaleNetSentiment: 0,
          whaleContextUpdatedAt: now,
        })
        .where(eq(tokenDataPool.tokenMint, tokenMint));

      return {
        whaleHolderCount: 0,
        whaleAvgReputation: 0,
        whaleBestReputation: null,
        whaleWorstReputation: null,
        whaleNetSentiment: 0,
        newWhalesDiscovered,
      };
    }

    const reputations = knownWhales.map(w => {
      const successWeight = (w.successRate || 0) * 40;
      const reliabilityWeight = ((w.reliabilityScore || 50) / 100) * 30;
      const tierWeight = Math.min(30, (w.tierScore || 0) / 3);
      return successWeight + reliabilityWeight + tierWeight;
    });

    const avgRep = reputations.reduce((a, b) => a + b, 0) / reputations.length;
    const bestRep = Math.max(...reputations);
    const worstRep = Math.min(...reputations);

    const NEUTRAL_THRESHOLD = 40;
    const positiveWhales = reputations.filter(r => r >= NEUTRAL_THRESHOLD).length;
    const negativeWhales = reputations.filter(r => r < NEUTRAL_THRESHOLD).length;
    const netSentiment = knownWhales.length > 0
      ? ((positiveWhales - negativeWhales) / knownWhales.length) * 100
      : 0;

    await db.update(tokenDataPool)
      .set({
        whaleHolderCount: knownWhales.length,
        whaleAvgReputation: Math.round(avgRep * 10) / 10,
        whaleBestReputation: Math.round(bestRep * 10) / 10,
        whaleWorstReputation: Math.round(worstRep * 10) / 10,
        whaleNetSentiment: Math.round(netSentiment * 10) / 10,
        whaleContextUpdatedAt: now,
      })
      .where(eq(tokenDataPool.tokenMint, tokenMint));

    if (knownWhales.length > 0) {
      console.log(`[WhaleContext] ${tokenMint.slice(0, 8)}: ${knownWhales.length} whales, avg rep=${avgRep.toFixed(1)}, sentiment=${netSentiment.toFixed(1)}`);
    }

    return {
      whaleHolderCount: knownWhales.length,
      whaleAvgReputation: avgRep,
      whaleBestReputation: bestRep,
      whaleWorstReputation: worstRep,
      whaleNetSentiment: netSentiment,
      newWhalesDiscovered,
    };
  } catch (err) {
    console.error(`[WhaleContext] Error scanning ${tokenMint.slice(0, 8)}:`, err);
    return null;
  }
}

export async function batchScanWhaleContext(tokenMints: string[]): Promise<number> {
  let scanned = 0;
  for (const mint of tokenMints) {
    const result = await scanAndStoreWhaleContext(mint);
    if (result) scanned++;
    if (scanned % 10 === 0 && scanned > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return scanned;
}
