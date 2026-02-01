import { db } from "./db";
import { familiarWhales, whaleTokenPositions, tokenEvents } from "@shared/schema";
import { eq, and, desc, sql, gt, isNull } from "drizzle-orm";

export interface WhaleActivityEvent {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  action: "buy" | "sell";
  rank: number;
  priceUsd?: number;
  marketCap?: number;
}

export interface FamiliarWhaleAlert {
  whale: typeof familiarWhales.$inferSelect;
  position: typeof whaleTokenPositions.$inferSelect;
  isKnownSuccessful: boolean;
  successRate: number;
  tokensTraded: number;
  message: string;
}

export async function recordWhaleActivity(event: WhaleActivityEvent): Promise<FamiliarWhaleAlert | null> {
  const now = Math.floor(Date.now() / 1000);
  
  try {
    let whale = await db.select().from(familiarWhales)
      .where(eq(familiarWhales.walletAddress, event.walletAddress))
      .then(rows => rows[0]);
    
    if (!whale) {
      const [newWhale] = await db.insert(familiarWhales).values({
        walletAddress: event.walletAddress,
        firstSeenAt: now,
        lastSeenAt: now,
        totalTokensSeen: 1,
      }).returning();
      whale = newWhale;
    } else {
      await db.update(familiarWhales)
        .set({ lastSeenAt: now })
        .where(eq(familiarWhales.id, whale.id));
    }
    
    if (event.action === "buy") {
      const existingPosition = await db.select().from(whaleTokenPositions)
        .where(and(
          eq(whaleTokenPositions.whaleId, whale.id),
          eq(whaleTokenPositions.tokenMint, event.tokenMint),
          eq(whaleTokenPositions.status, "holding")
        ))
        .then(rows => rows[0]);
      
      if (!existingPosition) {
        const existingTokens = await db.select({ count: sql<number>`count(distinct token_mint)` })
          .from(whaleTokenPositions)
          .where(eq(whaleTokenPositions.whaleId, whale.id))
          .then(rows => rows[0]?.count || 0);
        
        const isNewToken = await db.select().from(whaleTokenPositions)
          .where(and(
            eq(whaleTokenPositions.whaleId, whale.id),
            eq(whaleTokenPositions.tokenMint, event.tokenMint)
          ))
          .then(rows => rows.length === 0);
        
        if (isNewToken) {
          await db.update(familiarWhales)
            .set({ totalTokensSeen: (whale.totalTokensSeen || 0) + 1 })
            .where(eq(familiarWhales.id, whale.id));
        }
        
        const [position] = await db.insert(whaleTokenPositions).values({
          whaleId: whale.id,
          walletAddress: event.walletAddress,
          tokenMint: event.tokenMint,
          tokenSymbol: event.tokenSymbol,
          entryTimestamp: now,
          entryRank: event.rank,
          entryPriceUsd: event.priceUsd,
          entryMarketCap: event.marketCap,
          status: "holding",
          peakMultiplier: 1,
        }).returning();
        
        const isKnownSuccessful = (whale.successRate || 0) >= 0.6 && (whale.totalExits || 0) >= 3;
        
        if (isKnownSuccessful || (whale.totalTokensSeen || 0) >= 5) {
          const updatedWhale = await db.select().from(familiarWhales)
            .where(eq(familiarWhales.id, whale.id))
            .then(rows => rows[0]);
          
          const message = isKnownSuccessful
            ? `Known successful whale (${((whale.successRate || 0) * 100).toFixed(0)}% win rate, ${whale.totalExits} trades) just entered ${event.tokenSymbol || 'this token'}!`
            : `Familiar whale spotted in ${event.tokenSymbol || 'this token'} (seen in ${whale.totalTokensSeen} tokens)`;
          
          await db.insert(tokenEvents).values({
            tokenMint: event.tokenMint,
            tokenSymbol: event.tokenSymbol || "???",
            eventType: isKnownSuccessful ? "successful_whale_buy" : "familiar_whale_buy",
            priority: isKnownSuccessful ? "high" : "normal",
            title: isKnownSuccessful 
              ? `Successful whale entered ${event.tokenSymbol || 'token'}`
              : `Familiar whale entered ${event.tokenSymbol || 'token'}`,
            description: message,
            metadata: {
              walletAddress: event.walletAddress,
              rank: event.rank,
              successRate: (whale.successRate || 0) * 100,
              totalExits: whale.totalExits || 0,
              totalTokensSeen: whale.totalTokensSeen || 1,
            },
            createdAt: now,
            priceAtEvent: event.priceUsd,
            relatedWallet: event.walletAddress,
          }).catch(err => console.error("[FamiliarWhale] logTokenEvent error:", err));
          
          return {
            whale: updatedWhale || whale,
            position,
            isKnownSuccessful,
            successRate: (whale.successRate || 0) * 100,
            tokensTraded: whale.totalTokensSeen || 1,
            message,
          };
        }
      }
    } else if (event.action === "sell") {
      const position = await db.select().from(whaleTokenPositions)
        .where(and(
          eq(whaleTokenPositions.whaleId, whale.id),
          eq(whaleTokenPositions.tokenMint, event.tokenMint),
          eq(whaleTokenPositions.status, "holding")
        ))
        .then(rows => rows[0]);
      
      if (position) {
        const exitMultiplier = (position.entryPriceUsd && event.priceUsd)
          ? event.priceUsd / position.entryPriceUsd
          : 1;
        const holdTimeMinutes = Math.floor((now - position.entryTimestamp) / 60);
        
        await db.update(whaleTokenPositions)
          .set({
            exitTimestamp: now,
            exitPriceUsd: event.priceUsd,
            exitMarketCap: event.marketCap,
            exitMultiplier,
            status: "exited",
            holdTimeMinutes,
          })
          .where(eq(whaleTokenPositions.id, position.id));
        
        await updateWhaleStats(whale.id);
        
        if (exitMultiplier > 1.5) {
          const holdTimeHours = (holdTimeMinutes / 60).toFixed(1);
          await db.insert(tokenEvents).values({
            tokenMint: event.tokenMint,
            tokenSymbol: event.tokenSymbol || position.tokenSymbol || "???",
            eventType: "whale_profit_exit",
            priority: exitMultiplier >= 3 ? "high" : "normal",
            title: `Whale exited ${event.tokenSymbol || 'token'} at ${exitMultiplier.toFixed(1)}x`,
            description: `Familiar whale exited with ${exitMultiplier.toFixed(2)}x profit after ${holdTimeHours}h`,
            metadata: {
              walletAddress: event.walletAddress,
              exitMultiplier,
              holdTimeMinutes,
              entryPriceUsd: position.entryPriceUsd,
              exitPriceUsd: event.priceUsd,
            },
            createdAt: now,
            priceAtEvent: event.priceUsd,
            relatedWallet: event.walletAddress,
          }).catch(err => console.error("[FamiliarWhale] exit event error:", err));
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error("[FamiliarWhales] Error recording activity:", error);
    return null;
  }
}

async function updateWhaleStats(whaleId: number): Promise<void> {
  try {
    const exitedPositions = await db.select().from(whaleTokenPositions)
      .where(and(
        eq(whaleTokenPositions.whaleId, whaleId),
        eq(whaleTokenPositions.status, "exited")
      ));
    
    if (exitedPositions.length === 0) return;
    
    const profitableExits = exitedPositions.filter(p => (p.exitMultiplier || 1) > 1).length;
    const totalExits = exitedPositions.length;
    const successRate = totalExits > 0 ? profitableExits / totalExits : 0;
    
    const avgExitMultiplier = exitedPositions.reduce((sum, p) => sum + (p.exitMultiplier || 1), 0) / totalExits;
    const bestExitMultiplier = Math.max(...exitedPositions.map(p => p.exitMultiplier || 1));
    
    const holdTimes = exitedPositions.filter(p => p.holdTimeMinutes).map(p => p.holdTimeMinutes!);
    const avgHoldTimeMinutes = holdTimes.length > 0
      ? Math.floor(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length)
      : null;
    
    const reliabilityScore = calculateReliabilityScore(successRate, totalExits, avgExitMultiplier);
    
    await db.update(familiarWhales)
      .set({
        profitableExits,
        totalExits,
        successRate,
        avgExitMultiplier,
        bestExitMultiplier,
        avgHoldTimeMinutes,
        reliabilityScore,
      })
      .where(eq(familiarWhales.id, whaleId));
  } catch (error) {
    console.error("[FamiliarWhales] Error updating stats:", error);
  }
}

function calculateReliabilityScore(successRate: number, totalExits: number, avgMultiplier: number): number {
  const experienceWeight = Math.min(totalExits / 10, 1);
  const successWeight = successRate * 50;
  const multiplierWeight = Math.min((avgMultiplier - 1) * 25, 30);
  
  return Math.min(100, Math.max(0, experienceWeight * 20 + successWeight + multiplierWeight));
}

export async function getTopFamiliarWhales(limit: number = 20): Promise<(typeof familiarWhales.$inferSelect)[]> {
  return db.select().from(familiarWhales)
    .where(gt(familiarWhales.totalExits!, 2))
    .orderBy(desc(familiarWhales.reliabilityScore))
    .limit(limit);
}

export async function checkForFamiliarWhalesInToken(tokenMint: string): Promise<FamiliarWhaleAlert[]> {
  try {
    const activePositions = await db.select({
      position: whaleTokenPositions,
      whale: familiarWhales,
    })
      .from(whaleTokenPositions)
      .innerJoin(familiarWhales, eq(whaleTokenPositions.whaleId, familiarWhales.id))
      .where(and(
        eq(whaleTokenPositions.tokenMint, tokenMint),
        eq(whaleTokenPositions.status, "holding")
      ));
    
    return activePositions
      .filter(({ whale }) => (whale.successRate || 0) >= 0.5 && (whale.totalExits || 0) >= 2)
      .map(({ whale, position }) => ({
        whale,
        position,
        isKnownSuccessful: (whale.successRate || 0) >= 0.6 && (whale.totalExits || 0) >= 3,
        successRate: (whale.successRate || 0) * 100,
        tokensTraded: whale.totalTokensSeen || 0,
        message: `Familiar whale (${((whale.successRate || 0) * 100).toFixed(0)}% success, ${whale.totalExits} trades) is holding this token`,
      }));
  } catch (error) {
    console.error("[FamiliarWhales] Error checking token:", error);
    return [];
  }
}

export async function getWhaleHistory(walletAddress: string): Promise<{
  whale: typeof familiarWhales.$inferSelect | null;
  positions: (typeof whaleTokenPositions.$inferSelect)[];
}> {
  try {
    const whale = await db.select().from(familiarWhales)
      .where(eq(familiarWhales.walletAddress, walletAddress))
      .then(rows => rows[0] || null);
    
    if (!whale) {
      return { whale: null, positions: [] };
    }
    
    const positions = await db.select().from(whaleTokenPositions)
      .where(eq(whaleTokenPositions.whaleId, whale.id))
      .orderBy(desc(whaleTokenPositions.entryTimestamp))
      .limit(50);
    
    return { whale, positions };
  } catch (error) {
    console.error("[FamiliarWhales] Error getting history:", error);
    return { whale: null, positions: [] };
  }
}

export async function updatePeakMultipliers(tokenMint: string, currentPriceUsd: number): Promise<void> {
  try {
    const holdingPositions = await db.select().from(whaleTokenPositions)
      .where(and(
        eq(whaleTokenPositions.tokenMint, tokenMint),
        eq(whaleTokenPositions.status, "holding")
      ));
    
    for (const position of holdingPositions) {
      if (position.entryPriceUsd && currentPriceUsd > 0) {
        const currentMultiplier = currentPriceUsd / position.entryPriceUsd;
        if (currentMultiplier > (position.peakMultiplier || 1)) {
          await db.update(whaleTokenPositions)
            .set({ peakMultiplier: currentMultiplier })
            .where(eq(whaleTokenPositions.id, position.id));
        }
      }
    }
  } catch (error) {
    console.error("[FamiliarWhales] Error updating peak multipliers:", error);
  }
}
