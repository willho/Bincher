import { db } from "./db";
import { strategyClusters, walletFingerprints, vectorUpdates } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export type StrategyPattern = 
  | "momentum"
  | "swing"
  | "pump_specialist"
  | "sniper"
  | "whale_follower"
  | "scalper"
  | "holder"
  | "mixed";

interface WalletProfile {
  walletAddress: string;
  avgHoldMinutes: number;
  entrySize: number;
  partialSellRate: number;
  preVolumeRate: number;
  playbookScore: number;
}

function classifyPattern(profile: WalletProfile): StrategyPattern {
  const { avgHoldMinutes, partialSellRate, preVolumeRate, playbookScore } = profile;
  
  if (avgHoldMinutes < 5) {
    return "sniper";
  }
  
  if (avgHoldMinutes < 30 && preVolumeRate > 0.5) {
    return "momentum";
  }
  
  if (avgHoldMinutes >= 30 && avgHoldMinutes < 240 && partialSellRate > 0.5) {
    return "swing";
  }
  
  if (avgHoldMinutes < 60 && playbookScore < 40) {
    return "pump_specialist";
  }
  
  if (avgHoldMinutes >= 240) {
    return "holder";
  }
  
  if (avgHoldMinutes < 15) {
    return "scalper";
  }
  
  return "mixed";
}

export async function assignWalletToCluster(walletAddress: string): Promise<string | null> {
  try {
    const fingerprint = await db.select()
      .from(walletFingerprints)
      .where(eq(walletFingerprints.walletAddress, walletAddress))
      .limit(1);
    
    if (!fingerprint[0]) return null;
    
    const profile: WalletProfile = {
      walletAddress,
      avgHoldMinutes: fingerprint[0].avgHoldDurationMinutes || 60,
      entrySize: fingerprint[0].avgEntrySizeUsd || 100,
      partialSellRate: fingerprint[0].partialSellRate || 0,
      preVolumeRate: fingerprint[0].preVolumeBuyRate || 0,
      playbookScore: fingerprint[0].playbookScore || 50
    };
    
    const pattern = classifyPattern(profile);
    
    const existingCluster = await db.select()
      .from(strategyClusters)
      .where(eq(strategyClusters.pattern, pattern))
      .limit(1);
    
    const now = Math.floor(Date.now() / 1000);
    
    if (existingCluster[0]) {
      const currentAddresses = (existingCluster[0].walletAddresses as string[]) || [];
      
      if (!currentAddresses.includes(walletAddress)) {
        const newAddresses = [...currentAddresses, walletAddress];
        
        await db.update(strategyClusters)
          .set({
            walletAddresses: newAddresses,
            walletCount: newAddresses.length,
            updatedAt: now
          })
          .where(eq(strategyClusters.clusterId, existingCluster[0].clusterId));
      }
      
      return existingCluster[0].clusterId;
    } else {
      const clusterId = `cluster_${pattern}_${nanoid(8)}`;
      
      await db.insert(strategyClusters).values({
        clusterId,
        pattern,
        patternDescription: getPatternDescription(pattern),
        walletAddresses: [walletAddress],
        walletCount: 1,
        vector: [],
        outcomes: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          avgPnlPercent: 0,
          totalPnlSol: 0,
          winRate: 0,
          bestTrade: null,
          worstTrade: null
        },
        confidence: 0.5,
        sampleSize: 0,
        createdAt: now,
        updatedAt: now
      });
      
      return clusterId;
    }
  } catch (err) {
    console.error("[StrategyClusters] Failed to assign wallet:", err);
    return null;
  }
}

function getPatternDescription(pattern: StrategyPattern): string {
  const descriptions: Record<StrategyPattern, string> = {
    momentum: "Quick entries on volume spikes, rides momentum waves",
    swing: "Holds for hours, takes partial profits systematically",
    pump_specialist: "Fast in/out on pump tokens, high risk tolerance",
    sniper: "Ultra-fast entries, often first buyers, may be bot-assisted",
    whale_follower: "Follows large wallet movements closely",
    scalper: "Very short holds, small consistent profits",
    holder: "Long-term positions, patient accumulator",
    mixed: "No clear pattern, varies strategy by market conditions"
  };
  return descriptions[pattern];
}

export async function recordTradeOutcome(
  walletAddress: string,
  tokenMint: string,
  pnlPercent: number,
  pnlSol: number
): Promise<void> {
  try {
    const clusters = await db.select()
      .from(strategyClusters);
    
    for (const cluster of clusters) {
      const addresses = (cluster.walletAddresses as string[]) || [];
      if (addresses.includes(walletAddress)) {
        const now = Math.floor(Date.now() / 1000);
        const bucketId = getCurrentBucketId();
        
        await db.insert(vectorUpdates).values({
          vectorType: "strategy",
          targetId: cluster.clusterId,
          signalType: pnlPercent >= 0 ? "trade_win" : "trade_loss",
          signalData: {
            walletAddress,
            tokenMint,
            pnlPercent,
            pnlSol
          },
          weight: Math.abs(pnlPercent) > 50 ? 2.0 : 1.0,
          bucketId,
          processed: false,
          createdAt: now
        });
        
        break;
      }
    }
  } catch (err) {
    console.error("[StrategyClusters] Failed to record outcome:", err);
  }
}

function getCurrentBucketId(): string {
  const now = new Date();
  const hour = now.getUTCHours();
  const bucket = hour < 8 ? "00" : hour < 16 ? "08" : "16";
  return `${now.toISOString().slice(0, 10)}-${bucket}`;
}

export async function getClusterStats(): Promise<{
  totalClusters: number;
  patterns: { pattern: string; count: number; winRate: number }[];
  topPerformers: { clusterId: string; pattern: string; winRate: number; avgPnl: number }[];
}> {
  const clusters = await db.select()
    .from(strategyClusters)
    .orderBy(desc(strategyClusters.sampleSize));
  
  const patternStats = new Map<string, { count: number; totalWinRate: number }>();
  
  for (const cluster of clusters) {
    const outcomes = cluster.outcomes as { winRate: number } | null;
    const winRate = outcomes?.winRate || 0;
    
    const current = patternStats.get(cluster.pattern) || { count: 0, totalWinRate: 0 };
    current.count++;
    current.totalWinRate += winRate;
    patternStats.set(cluster.pattern, current);
  }
  
  const patterns = Array.from(patternStats.entries()).map(([pattern, stats]) => ({
    pattern,
    count: stats.count,
    winRate: stats.count > 0 ? stats.totalWinRate / stats.count : 0
  }));
  
  const topPerformers = clusters
    .filter(c => (c.sampleSize || 0) >= 5)
    .slice(0, 5)
    .map(c => {
      const outcomes = c.outcomes as { winRate: number; avgPnlPercent: number } | null;
      return {
        clusterId: c.clusterId,
        pattern: c.pattern,
        winRate: outcomes?.winRate || 0,
        avgPnl: outcomes?.avgPnlPercent || 0
      };
    });
  
  return {
    totalClusters: clusters.length,
    patterns,
    topPerformers
  };
}

export async function findSimilarWallets(walletAddress: string): Promise<string[]> {
  const fingerprint = await db.select()
    .from(walletFingerprints)
    .where(eq(walletFingerprints.walletAddress, walletAddress))
    .limit(1);
  
  if (!fingerprint[0]) return [];
  
  const profile: WalletProfile = {
    walletAddress,
    avgHoldMinutes: fingerprint[0].avgHoldDurationMinutes || 60,
    entrySize: fingerprint[0].avgEntrySizeUsd || 100,
    partialSellRate: fingerprint[0].partialSellRate || 0,
    preVolumeRate: fingerprint[0].preVolumeBuyRate || 0,
    playbookScore: fingerprint[0].playbookScore || 50
  };
  
  const pattern = classifyPattern(profile);
  
  const cluster = await db.select()
    .from(strategyClusters)
    .where(eq(strategyClusters.pattern, pattern))
    .limit(1);
  
  if (!cluster[0]) return [];
  
  const addresses = (cluster[0].walletAddresses as string[]) || [];
  return addresses.filter(a => a !== walletAddress).slice(0, 10);
}
