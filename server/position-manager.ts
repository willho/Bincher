import { db } from "./db";
import { holdings } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";

export interface ExistingPosition {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string | null;
  currentAmount: number;
  solSpent: number;
  buyPrice: number;
  avgEntryPrice: number | null;
  totalBuys: number | null;
  totalSolInvested: number | null;
  positionSource: string | null;
  signalWalletId: number | null;
  sourceWalletAddress: string | null;
}

export async function findExistingPosition(
  userId: number,
  tokenMint: string,
  positionSource: string = "manual",
  signalWalletId?: number
): Promise<ExistingPosition | null> {
  const conditions = [
    eq(holdings.userId, userId),
    eq(holdings.tokenMint, tokenMint),
    eq(holdings.reclaimed, false),
  ];

  if (positionSource === "copy" && signalWalletId) {
    conditions.push(eq(holdings.positionSource, "copy"));
    conditions.push(eq(holdings.signalWalletId, signalWalletId));
  } else if (positionSource === "manual") {
    conditions.push(eq(holdings.positionSource, "manual"));
    conditions.push(isNull(holdings.signalWalletId));
  } else {
    conditions.push(eq(holdings.positionSource, positionSource));
  }

  const [existing] = await db
    .select({
      id: holdings.id,
      tokenMint: holdings.tokenMint,
      tokenSymbol: holdings.tokenSymbol,
      tokenName: holdings.tokenName,
      currentAmount: holdings.currentAmount,
      solSpent: holdings.solSpent,
      buyPrice: holdings.buyPrice,
      avgEntryPrice: holdings.avgEntryPrice,
      totalBuys: holdings.totalBuys,
      totalSolInvested: holdings.totalSolInvested,
      positionSource: holdings.positionSource,
      signalWalletId: holdings.signalWalletId,
      sourceWalletAddress: holdings.sourceWalletAddress,
    })
    .from(holdings)
    .where(and(...conditions))
    .limit(1);

  return existing || null;
}

export async function findAllPositionsForToken(
  userId: number,
  tokenMint: string
): Promise<ExistingPosition[]> {
  return db
    .select({
      id: holdings.id,
      tokenMint: holdings.tokenMint,
      tokenSymbol: holdings.tokenSymbol,
      tokenName: holdings.tokenName,
      currentAmount: holdings.currentAmount,
      solSpent: holdings.solSpent,
      buyPrice: holdings.buyPrice,
      avgEntryPrice: holdings.avgEntryPrice,
      totalBuys: holdings.totalBuys,
      totalSolInvested: holdings.totalSolInvested,
      positionSource: holdings.positionSource,
      signalWalletId: holdings.signalWalletId,
      sourceWalletAddress: holdings.sourceWalletAddress,
    })
    .from(holdings)
    .where(
      and(
        eq(holdings.userId, userId),
        eq(holdings.tokenMint, tokenMint),
        eq(holdings.reclaimed, false)
      )
    );
}

export interface TopUpResult {
  success: boolean;
  newAvgPrice: number;
  newTotalBuys: number;
  newTotalSolInvested: number;
  newCurrentAmount: number;
}

export async function topUpPosition(
  positionId: number,
  additionalTokens: number,
  additionalSol: number,
  newTokenPrice: number
): Promise<TopUpResult> {
  const [position] = await db
    .select()
    .from(holdings)
    .where(eq(holdings.id, positionId))
    .limit(1);

  if (!position) {
    throw new Error("Position not found");
  }

  const now = Math.floor(Date.now() / 1000);
  const prevTotalSol = position.totalSolInvested ?? position.solSpent;
  const prevTotalTokens = position.totalTokensBought ?? position.amountBought;
  const prevBuys = position.totalBuys ?? 1;

  const newTotalSol = prevTotalSol + additionalSol;
  const newTotalTokens = prevTotalTokens + additionalTokens;
  const newCurrentAmount = position.currentAmount + additionalTokens;
  const newBuys = prevBuys + 1;

  const newAvgPrice = newTotalSol / newTotalTokens;

  await db
    .update(holdings)
    .set({
      currentAmount: newCurrentAmount,
      amountBought: position.amountBought + additionalTokens,
      solSpent: position.solSpent + additionalSol,
      avgEntryPrice: newAvgPrice,
      totalBuys: newBuys,
      totalTokensBought: newTotalTokens,
      totalSolInvested: newTotalSol,
      lastTopUpTimestamp: now,
      lastPrice: newTokenPrice,
      lastPriceCheck: now,
    })
    .where(eq(holdings.id, positionId));

  return {
    success: true,
    newAvgPrice,
    newTotalBuys: newBuys,
    newTotalSolInvested: newTotalSol,
    newCurrentAmount,
  };
}

export function getPositionIdentityKey(
  userId: number,
  tokenMint: string,
  positionSource: string,
  signalWalletId?: number
): string {
  if (positionSource === "copy" && signalWalletId) {
    return `${userId}-${tokenMint}-copy-${signalWalletId}`;
  }
  return `${userId}-${tokenMint}-${positionSource}`;
}

export function formatPositionSummary(position: ExistingPosition): string {
  const avgPrice = position.avgEntryPrice ?? position.buyPrice;
  const totalSol = position.totalSolInvested ?? position.solSpent;
  const buys = position.totalBuys ?? 1;
  
  let source = "";
  if (position.positionSource === "copy") {
    source = position.sourceWalletAddress
      ? ` (copied from ${position.sourceWalletAddress.slice(0, 6)}...)`
      : " (copy trade)";
  } else if (position.positionSource === "manual") {
    source = " (manual)";
  } else if (position.positionSource) {
    source = ` (${position.positionSource})`;
  }
  
  return `${position.tokenSymbol}${source}: ${position.currentAmount.toLocaleString()} tokens, ${totalSol.toFixed(4)} SOL invested, avg price $${avgPrice.toFixed(8)}, ${buys} buy${buys !== 1 ? 's' : ''}`;
}
