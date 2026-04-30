import { db } from "./db";
import { eq, and, lte } from "drizzle-orm";
import { rawTokenTrades } from "@shared/schema";

/**
 * Calculate top 20 holders and their PnL at a given snapshot moment
 *
 * For each holder:
 * - Find first buy (entry price)
 * - Calculate holdings at snapshot time
 * - Compute multiplier vs current price
 */
export async function getTopHoldersWithPnL(
  tokenMint: string,
  snapshotPrice: number,
  snapshotTimestamp?: number
): Promise<
  Array<{
    walletAddress: string;
    tokensHeld: number;
    entryPrice: number;
    multiplier: number;
    profitable: boolean;
  }>
> {
  const now = snapshotTimestamp || Math.floor(Date.now() / 1000);

  // Get all trades for this token up to snapshot time
  const trades = await db.query.rawTokenTrades.findMany({
    where: and(
      eq(rawTokenTrades.tokenMint, tokenMint),
      lte(rawTokenTrades.timestamp, now)
    ),
  });

  // Aggregate holdings per wallet
  const walletHoldings = new Map<
    string,
    {
      tokensHeld: number;
      totalBuyCost: number;
      totalTokensBought: number;
      firstBuyPrice: number;
      firstBuyTime: number;
    }
  >();

  for (const trade of trades) {
    if (!walletHoldings.has(trade.walletAddress)) {
      walletHoldings.set(trade.walletAddress, {
        tokensHeld: 0,
        totalBuyCost: 0,
        totalTokensBought: 0,
        firstBuyPrice: trade.price ?? 0,
        firstBuyTime: trade.timestamp,
      });
    }

    const holder = walletHoldings.get(trade.walletAddress)!;

    if (trade.direction === "buy") {
      holder.tokensHeld += trade.amountTokens;
      holder.totalBuyCost += trade.amountSol;
      holder.totalTokensBought += trade.amountTokens;
      // Update first buy price if this is earlier
      if (trade.timestamp < holder.firstBuyTime) {
        holder.firstBuyPrice = trade.price ?? 0;
        holder.firstBuyTime = trade.timestamp;
      }
    } else {
      holder.tokensHeld -= trade.amountTokens;
    }
  }

  // Calculate PnL for holders with current holdings
  const holdersWithPnL = Array.from(walletHoldings.entries())
    .filter(([_, holder]) => holder.tokensHeld > 0) // Only holders with current balance
    .map(([address, holder]) => {
      const entryPrice = holder.totalTokensBought > 0
        ? holder.totalBuyCost / holder.totalTokensBought
        : holder.firstBuyPrice;

      const multiplier = snapshotPrice / entryPrice;

      return {
        walletAddress: address,
        tokensHeld: holder.tokensHeld,
        entryPrice,
        multiplier,
        profitable: multiplier > 1,
      };
    })
    .sort((a, b) => b.tokensHeld - a.tokensHeld) // Sort by tokens held (largest first)
    .slice(0, 20); // Top 20

  return holdersWithPnL;
}
