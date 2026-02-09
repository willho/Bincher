import { db } from "./db";
import { socialCallers, socialCalls, tokenDataPool } from "@shared/schema";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import type { SocialCaller, SocialCall } from "@shared/schema";

export async function getOrCreateCaller(
  platform: string,
  handle: string,
  displayName?: string,
  platformUrl?: string
): Promise<SocialCaller> {
  const now = Math.floor(Date.now() / 1000);
  const normalizedHandle = handle.toLowerCase().replace(/^@/, "");

  const existing = await db.select()
    .from(socialCallers)
    .where(and(
      eq(socialCallers.platform, platform),
      eq(socialCallers.handle, normalizedHandle)
    ))
    .limit(1);

  if (existing.length > 0) {
    if (displayName || platformUrl) {
      const updates: Record<string, any> = { updatedAt: now };
      if (displayName) updates.displayName = displayName;
      if (platformUrl) updates.platformUrl = platformUrl;
      await db.update(socialCallers)
        .set(updates)
        .where(eq(socialCallers.id, existing[0].id));
    }
    return existing[0];
  }

  const [caller] = await db.insert(socialCallers).values({
    platform,
    handle: normalizedHandle,
    displayName: displayName || null,
    platformUrl: platformUrl || null,
    callCount: 0,
    winCount: 0,
    lossCount: 0,
    hitRate: 0,
    avgReturn: 0,
    trustScore: 0.5,
    vector: [],
    vectorDimension: 384,
    isActive: true,
    firstSeenAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return caller;
}

export async function recordCall(params: {
  callerId: number;
  tokenMint: string;
  tokenSymbol?: string;
  platform: string;
  sourceUrl?: string;
  messageText?: string;
}): Promise<SocialCall> {
  const now = Math.floor(Date.now() / 1000);

  const callerCheck = await db.select({ id: socialCallers.id, platform: socialCallers.platform })
    .from(socialCallers)
    .where(eq(socialCallers.id, params.callerId))
    .limit(1);
  if (callerCheck.length === 0) {
    throw new Error(`Caller ${params.callerId} not found`);
  }

  const tokenData = await db.select({
    priceUsd: tokenDataPool.priceUsd,
    marketCap: tokenDataPool.marketCap,
    liquidity: tokenDataPool.liquidity,
  })
    .from(tokenDataPool)
    .where(eq(tokenDataPool.tokenMint, params.tokenMint))
    .limit(1);

  const td = tokenData[0];

  const [call] = await db.insert(socialCalls).values({
    callerId: params.callerId,
    tokenMint: params.tokenMint,
    tokenSymbol: params.tokenSymbol || null,
    platform: params.platform,
    sourceUrl: params.sourceUrl || null,
    messageText: params.messageText || null,
    priceAtCall: td?.priceUsd ?? null,
    marketCapAtCall: td?.marketCap ?? null,
    liquidityAtCall: td?.liquidity ?? null,
    outcome: "pending",
    calledAt: now,
    createdAt: now,
  }).returning();

  await db.update(socialCallers)
    .set({
      callCount: sql`${socialCallers.callCount} + 1`,
      lastCallAt: now,
      updatedAt: now,
    })
    .where(eq(socialCallers.id, params.callerId));

  try {
    const { emit } = await import("./discovery-event-bus");
    await emit({
      type: "social_call" as any,
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol,
      source: `social_${params.platform}`,
      data: {
        callerId: params.callerId,
        platform: params.platform,
        callId: call.id,
      },
      timestamp: Date.now(),
      urgency: 5,
    });

    const caller = await db.select().from(socialCallers).where(eq(socialCallers.id, params.callerId)).limit(1);
    if (caller[0] && (caller[0].trustScore ?? 0) >= 0.7 && (caller[0].callCount ?? 0) >= 5) {
      await emit({
        type: "social_call" as any,
        tokenMint: params.tokenMint,
        tokenSymbol: params.tokenSymbol,
        source: `high_trust_caller`,
        data: {
          callerId: params.callerId,
          handle: caller[0].handle,
          trustScore: caller[0].trustScore,
          hitRate: caller[0].hitRate,
          platform: params.platform,
        },
        timestamp: Date.now(),
        urgency: 7,
      });
    }
  } catch (e) {}

  return call;
}

export async function evaluatePendingCalls(): Promise<{ evaluated: number; wins: number; losses: number }> {
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;

  const pending = await db.select()
    .from(socialCalls)
    .where(and(
      eq(socialCalls.outcome, "pending"),
      gte(socialCalls.calledAt, now - 86400 * 7)
    ));

  let evaluated = 0;
  let wins = 0;
  let losses = 0;

  for (const call of pending) {
    if (!call.priceAtCall || call.priceAtCall <= 0) continue;
    const ageSeconds = now - call.calledAt;
    if (ageSeconds < 3600) continue;

    const currentToken = await db.select({ priceUsd: tokenDataPool.priceUsd })
      .from(tokenDataPool)
      .where(eq(tokenDataPool.tokenMint, call.tokenMint))
      .limit(1);

    const currentPrice = currentToken[0]?.priceUsd;
    if (!currentPrice) continue;

    const returnPct = ((currentPrice - call.priceAtCall) / call.priceAtCall) * 100;
    const multiplier = currentPrice / call.priceAtCall;

    const updateData: Record<string, any> = {
      evaluatedAt: now,
      returnPercent: returnPct,
    };

    if (ageSeconds >= 3600 && !call.priceAfter1h) {
      updateData.priceAfter1h = currentPrice;
    }
    if (ageSeconds >= 21600 && !call.priceAfter6h) {
      updateData.priceAfter6h = currentPrice;
    }
    if (ageSeconds >= 86400 && !call.priceAfter24h) {
      updateData.priceAfter24h = currentPrice;
    }

    if (!call.peakPriceAfter || currentPrice > call.peakPriceAfter) {
      updateData.peakPriceAfter = currentPrice;
      updateData.peakMultiplier = multiplier;
    }

    if (ageSeconds >= 86400) {
      if (returnPct >= 20) {
        updateData.outcome = "win";
        wins++;
      } else if (returnPct <= -30) {
        updateData.outcome = "loss";
        losses++;
      } else {
        updateData.outcome = "neutral";
      }
      evaluated++;
    } else if (returnPct <= -50) {
      updateData.outcome = "loss";
      losses++;
      evaluated++;
    } else if (returnPct >= 100) {
      updateData.outcome = "win";
      wins++;
      evaluated++;
    }

    await db.update(socialCalls)
      .set(updateData)
      .where(eq(socialCalls.id, call.id));

    if (updateData.outcome && updateData.outcome !== "pending") {
      await updateCallerStats(call.callerId);
    }
  }

  return { evaluated, wins, losses };
}

async function updateCallerStats(callerId: number): Promise<void> {
  const calls = await db.select()
    .from(socialCalls)
    .where(and(
      eq(socialCalls.callerId, callerId),
      sql`${socialCalls.outcome} IS NOT NULL AND ${socialCalls.outcome} != 'pending'`
    ));

  if (calls.length === 0) return;

  const winCalls = calls.filter(c => c.outcome === "win");
  const lossCalls = calls.filter(c => c.outcome === "loss");
  const returns = calls.filter(c => c.returnPercent !== null).map(c => c.returnPercent!);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const bestReturn = returns.length > 0 ? Math.max(...returns) : null;
  const worstReturn = returns.length > 0 ? Math.min(...returns) : null;
  const hitRate = calls.length > 0 ? winCalls.length / calls.length : 0;

  const trustScore = computeTrustScore(hitRate, calls.length, avgReturn, winCalls.length);

  await db.update(socialCallers)
    .set({
      winCount: winCalls.length,
      lossCount: lossCalls.length,
      hitRate,
      avgReturn,
      bestReturn,
      worstReturn,
      trustScore,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(socialCallers.id, callerId));
}

function computeTrustScore(hitRate: number, totalCalls: number, avgReturn: number, winCount: number): number {
  let score = 0.3;

  score += hitRate * 0.3;

  const sampleConfidence = Math.min(1.0, totalCalls / 20);
  score *= (0.5 + 0.5 * sampleConfidence);

  if (avgReturn > 0) {
    score += Math.min(0.2, avgReturn / 500);
  } else {
    score -= Math.min(0.2, Math.abs(avgReturn) / 200);
  }

  if (winCount >= 3 && hitRate >= 0.5) score += 0.1;
  if (winCount >= 10 && hitRate >= 0.6) score += 0.1;

  return Math.max(0, Math.min(1.0, score));
}

export async function getTopCallers(limit: number = 20): Promise<SocialCaller[]> {
  return db.select()
    .from(socialCallers)
    .where(eq(socialCallers.isActive, true))
    .orderBy(desc(socialCallers.trustScore))
    .limit(limit);
}

export async function getCallerCalls(callerId: number, limit: number = 50): Promise<SocialCall[]> {
  return db.select()
    .from(socialCalls)
    .where(eq(socialCalls.callerId, callerId))
    .orderBy(desc(socialCalls.calledAt))
    .limit(limit);
}

export async function getCallerById(callerId: number): Promise<SocialCaller | null> {
  const results = await db.select()
    .from(socialCallers)
    .where(eq(socialCallers.id, callerId))
    .limit(1);
  return results[0] || null;
}

let evaluationInterval: NodeJS.Timeout | null = null;

export function startSocialEvaluationJob(): void {
  if (evaluationInterval) return;

  evaluationInterval = setInterval(async () => {
    try {
      const result = await evaluatePendingCalls();
      if (result.evaluated > 0) {
        console.log(`[SocialSignals] Evaluated ${result.evaluated} calls: ${result.wins} wins, ${result.losses} losses`);
      }
    } catch (e) {
      console.error("[SocialSignals] Evaluation error:", e);
    }
  }, 15 * 60 * 1000);

  console.log("[SocialSignals] Evaluation job started (every 15min)");
}
