import { updateTokenSafety, isSafetyDataStale, getTokensNeedingSafetyCheck, getTokenPriority, bumpTokenPriority } from "./data-pool";
import { db } from "./db";
import { apiHealthMetrics } from "@shared/schema";
import { eq } from "drizzle-orm";

const RUGCHECK_BASE_URL = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE_URL = "https://api.gopluslabs.io/api/v1";

const RATE_LIMITS = {
  rugcheck: { requestsPerMinute: 60, lastRequestAt: 0, requestCount: 0, windowStart: 0 },
  goplus: { requestsPerMinute: 30, lastRequestAt: 0, requestCount: 0, windowStart: 0 },
};

async function checkRateLimit(source: 'rugcheck' | 'goplus'): Promise<boolean> {
  const now = Date.now();
  const limit = RATE_LIMITS[source];
  
  if (now - limit.windowStart > 60000) {
    limit.windowStart = now;
    limit.requestCount = 0;
  }
  
  if (limit.requestCount >= limit.requestsPerMinute) {
    return false;
  }
  
  limit.requestCount++;
  limit.lastRequestAt = now;
  return true;
}

async function updateApiHealth(source: string, success: boolean, responseTimeMs: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const existing = await db.query.apiHealthMetrics.findFirst({
      where: eq(apiHealthMetrics.source, source),
    });
    
    if (existing) {
      const newRequestCount = (existing.requestCount ?? 0) + 1;
      const newErrorCount = success ? (existing.errorCount ?? 0) : (existing.errorCount ?? 0) + 1;
      const currentAvg = existing.avgResponseTimeMs ?? responseTimeMs;
      const newAvgResponseTime = Math.round((currentAvg * 0.9) + (responseTimeMs * 0.1));
      
      await db.update(apiHealthMetrics)
        .set({
          avgResponseTimeMs: newAvgResponseTime,
          successRate: (newRequestCount - newErrorCount) / newRequestCount,
          errorCount: newErrorCount,
          requestCount: newRequestCount,
          lastSuccessAt: success ? now : existing.lastSuccessAt,
          lastErrorAt: success ? existing.lastErrorAt : now,
          updatedAt: now,
        })
        .where(eq(apiHealthMetrics.id, existing.id));
    } else {
      await db.insert(apiHealthMetrics).values({
        source,
        avgResponseTimeMs: responseTimeMs,
        successRate: success ? 1 : 0,
        errorCount: success ? 0 : 1,
        requestCount: 1,
        lastSuccessAt: success ? now : undefined,
        lastErrorAt: success ? undefined : now,
        updatedAt: now,
      });
    }
  } catch (error) {
    console.error(`[SafetyChecker] Failed to update API health for ${source}:`, error);
  }
}

export async function fetchRugcheckData(tokenMint: string): Promise<Record<string, unknown> | null> {
  if (!await checkRateLimit('rugcheck')) {
    console.log(`[SafetyChecker] RugCheck rate limit hit for ${tokenMint}`);
    return null;
  }
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${RUGCHECK_BASE_URL}/tokens/${tokenMint}/report/summary`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      await updateApiHealth('rugcheck', false, responseTime);
      console.error(`[SafetyChecker] RugCheck error ${response.status} for ${tokenMint}`);
      return null;
    }
    
    const data = await response.json();
    await updateApiHealth('rugcheck', true, responseTime);
    
    return {
      mint: data.mint,
      score: data.score,
      scoreNormalised: data.score_normalised,
      risks: data.risks,
      rugged: data.rugged,
      tokenType: data.tokenType,
      freezeAuthority: data.freezeAuthority,
      mintAuthority: data.mintAuthority,
      totalMarketLiquidity: data.totalMarketLiquidity,
      totalHolders: data.totalHolders,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    await updateApiHealth('rugcheck', false, responseTime);
    console.error(`[SafetyChecker] RugCheck fetch failed for ${tokenMint}:`, error);
    return null;
  }
}

export async function fetchGoplusData(tokenMint: string): Promise<Record<string, unknown> | null> {
  if (!await checkRateLimit('goplus')) {
    console.log(`[SafetyChecker] GoPlus rate limit hit for ${tokenMint}`);
    return null;
  }
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${GOPLUS_BASE_URL}/solana/token_security?contract_addresses=${tokenMint}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      await updateApiHealth('goplus', false, responseTime);
      console.error(`[SafetyChecker] GoPlus error ${response.status} for ${tokenMint}`);
      return null;
    }
    
    const data = await response.json();
    await updateApiHealth('goplus', true, responseTime);
    
    const tokenData = data.result?.[tokenMint.toLowerCase()] || data.result?.[tokenMint];
    
    if (!tokenData) {
      return {
        notFound: true,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
    }
    
    return {
      isHoneypot: tokenData.is_honeypot === '1',
      buyTax: parseFloat(tokenData.buy_tax || '0'),
      sellTax: parseFloat(tokenData.sell_tax || '0'),
      holderCount: parseInt(tokenData.holder_count || '0', 10),
      lpHolderCount: parseInt(tokenData.lp_holder_count || '0', 10),
      isMintable: tokenData.is_mintable === '1',
      canTakeBackOwnership: tokenData.can_take_back_ownership === '1',
      ownerChangeBalance: tokenData.owner_change_balance === '1',
      hiddenOwner: tokenData.hidden_owner === '1',
      externalCall: tokenData.external_call === '1',
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    await updateApiHealth('goplus', false, responseTime);
    console.error(`[SafetyChecker] GoPlus fetch failed for ${tokenMint}:`, error);
    return null;
  }
}

export async function checkTokenSafety(tokenMint: string): Promise<{
  rugcheck: Record<string, unknown> | null;
  goplus: Record<string, unknown> | null;
  updated: boolean;
}> {
  const [rugcheckData, goplusData] = await Promise.all([
    fetchRugcheckData(tokenMint),
    fetchGoplusData(tokenMint),
  ]);
  
  if (!rugcheckData && !goplusData) {
    return { rugcheck: null, goplus: null, updated: false };
  }
  
  const source = rugcheckData && goplusData ? 'both' : rugcheckData ? 'rugcheck' : 'goplus';
  
  await updateTokenSafety(tokenMint, {
    rugcheckData: rugcheckData || undefined,
    goplusData: goplusData || undefined,
  }, source);
  
  return { rugcheck: rugcheckData, goplus: goplusData, updated: true };
}

export async function reportSafetyFromFrontend(
  tokenMint: string,
  data: {
    rugcheckData?: Record<string, unknown>;
    goplusData?: Record<string, unknown>;
  },
  userId?: number
): Promise<boolean> {
  if (!data.rugcheckData && !data.goplusData) {
    return false;
  }
  
  const source = data.rugcheckData && data.goplusData ? 'both' : data.rugcheckData ? 'rugcheck' : 'goplus';
  
  await updateTokenSafety(tokenMint, data, source);
  
  console.log(`[SafetyChecker] Frontend reported safety data for ${tokenMint} from user ${userId || 'anonymous'}`);
  return true;
}

let safetyCheckInterval: NodeJS.Timeout | null = null;
let isRunning = false;

export async function processSafetyQueue(batchSize: number = 5): Promise<number> {
  if (isRunning) return 0;
  isRunning = true;
  
  try {
    const tokens = await getTokensNeedingSafetyCheck(batchSize);
    let processed = 0;
    
    for (const token of tokens) {
      const priority = getTokenPriority(token.tokenMint);
      
      if (priority === 'background') {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else if (priority === 'discovery') {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const result = await checkTokenSafety(token.tokenMint);
      if (result.updated) {
        processed++;
      }
    }
    
    return processed;
  } finally {
    isRunning = false;
  }
}

export function startSafetyCheckLoop(intervalMs: number = 30000): void {
  if (safetyCheckInterval) {
    clearInterval(safetyCheckInterval);
  }
  
  safetyCheckInterval = setInterval(async () => {
    try {
      const processed = await processSafetyQueue(3);
      if (processed > 0) {
        console.log(`[SafetyChecker] Processed ${processed} tokens in background loop`);
      }
    } catch (error) {
      console.error('[SafetyChecker] Background loop error:', error);
    }
  }, intervalMs);
  
  console.log('[SafetyChecker] Background safety check loop started');
}

export function stopSafetyCheckLoop(): void {
  if (safetyCheckInterval) {
    clearInterval(safetyCheckInterval);
    safetyCheckInterval = null;
    console.log('[SafetyChecker] Background safety check loop stopped');
  }
}

export async function getApiHealthStats(): Promise<Record<string, unknown>> {
  const metrics = await db.query.apiHealthMetrics.findMany();
  
  const stats: Record<string, unknown> = {};
  for (const m of metrics) {
    stats[m.source] = {
      avgResponseTimeMs: m.avgResponseTimeMs,
      successRate: m.successRate,
      errorCount: m.errorCount,
      requestCount: m.requestCount,
      rateLimitHits: m.rateLimitHits,
      lastSuccessAt: m.lastSuccessAt,
      lastErrorAt: m.lastErrorAt,
    };
  }
  
  return stats;
}
