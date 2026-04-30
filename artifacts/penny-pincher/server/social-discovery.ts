import { db } from "./db";
import { paperPositions, discoveryEvents } from "@shared/schema";
import { eq, and, gte, desc, sql, lte } from "drizzle-orm";

export interface SocialSource {
  handle: string;
  platform: "twitter" | "telegram";
  callCount: number;
  successfulCalls: number;
  successRate: number;
  avgLeadTimeMinutes: number;
  lastCallAt: number;
  score: number;
  isActive: boolean;
}

export interface SocialCall {
  sourceHandle: string;
  platform: string;
  tokenMint: string;
  tokenSymbol: string;
  callTimestamp: number;
  priceAtCall: number | null;
  peakPriceAfter: number | null;
  pnlPercent: number | null;
  leadTimeMinutes: number;
  isSuccessful: boolean;
}

const NITTER_INSTANCES = [
  "nitter.net",
  "nitter.privacydev.net", 
  "nitter.poast.org",
  "nitter.unixfox.eu",
];

const SOCIAL_SOURCE_CACHE: Map<string, SocialSource> = new Map();
const SOCIAL_CALLS_CACHE: SocialCall[] = [];
let currentNitterIndex = 0;
let lastNitterRotation = 0;
const NITTER_ROTATION_INTERVAL = 300000;

function getNextNitterInstance(): string {
  const now = Date.now();
  if (now - lastNitterRotation > NITTER_ROTATION_INTERVAL) {
    currentNitterIndex = (currentNitterIndex + 1) % NITTER_INSTANCES.length;
    lastNitterRotation = now;
  }
  return NITTER_INSTANCES[currentNitterIndex];
}

export async function searchNitterForToken(
  tokenSymbol: string,
  hoursBack: number = 48
): Promise<Array<{
  handle: string;
  text: string;
  timestamp: number;
  url: string;
}>> {
  const results: Array<{
    handle: string;
    text: string;
    timestamp: number;
    url: string;
  }> = [];
  
  const nitterHost = getNextNitterInstance();
  const searchTerm = `$${tokenSymbol}`;
  
  try {
    const searchUrl = `https://${nitterHost}/search?f=tweets&q=${encodeURIComponent(searchTerm)}`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.log(`[SocialDiscovery] Nitter ${nitterHost} returned ${response.status}, rotating...`);
      currentNitterIndex = (currentNitterIndex + 1) % NITTER_INSTANCES.length;
      return results;
    }
    
    const html = await response.text();
    
    const tweetPattern = /<div class="tweet-content[^"]*"[^>]*>([^<]*)<\/div>/gi;
    const handlePattern = /@(\w+)/g;
    
    let match;
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - (hoursBack * 3600);
    
    const timePattern = /<span class="tweet-date"[^>]*title="([^"]+)"[^>]*>/gi;
    const timeMatches: number[] = [];
    let timeMatch;
    while ((timeMatch = timePattern.exec(html)) !== null) {
      const dateStr = timeMatch[1];
      const parsedTime = Date.parse(dateStr);
      if (!isNaN(parsedTime)) {
        timeMatches.push(Math.floor(parsedTime / 1000));
      } else {
        timeMatches.push(now);
      }
    }
    
    let resultIndex = 0;
    while ((match = tweetPattern.exec(html)) !== null) {
      const text = match[1];
      const handleMatch = handlePattern.exec(text);
      
      if (handleMatch && text.toLowerCase().includes(tokenSymbol.toLowerCase())) {
        const tweetTime = timeMatches[resultIndex] || now;
        results.push({
          handle: handleMatch[1],
          text: text.substring(0, 280),
          timestamp: tweetTime,
          url: `https://twitter.com/${handleMatch[1]}`,
        });
      }
      resultIndex++;
    }
    
    console.log(`[SocialDiscovery] Found ${results.length} mentions of $${tokenSymbol} on Nitter`);
    
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.log(`[SocialDiscovery] Nitter ${nitterHost} timeout, rotating...`);
    } else {
      console.error(`[SocialDiscovery] Nitter search error:`, error.message);
    }
    currentNitterIndex = (currentNitterIndex + 1) % NITTER_INSTANCES.length;
  }
  
  return results;
}

export async function creditSocialSource(
  handle: string,
  platform: "twitter" | "telegram",
  tokenMint: string,
  tokenSymbol: string,
  callTimestamp: number,
  pumpTimestamp: number,
  pnlPercent: number
): Promise<SocialSource> {
  const now = Math.floor(Date.now() / 1000);
  const leadTimeMinutes = Math.max(0, (pumpTimestamp - callTimestamp) / 60);
  const isSuccessful = pnlPercent > 10;
  
  const call: SocialCall = {
    sourceHandle: handle,
    platform,
    tokenMint,
    tokenSymbol,
    callTimestamp,
    priceAtCall: null,
    peakPriceAfter: null,
    pnlPercent,
    leadTimeMinutes,
    isSuccessful,
  };
  
  SOCIAL_CALLS_CACHE.push(call);
  
  const existing = SOCIAL_SOURCE_CACHE.get(handle);
  
  if (existing) {
    existing.callCount++;
    if (isSuccessful) existing.successfulCalls++;
    existing.successRate = existing.callCount > 0 
      ? existing.successfulCalls / existing.callCount 
      : 0;
    existing.avgLeadTimeMinutes = (
      (existing.avgLeadTimeMinutes * (existing.callCount - 1)) + leadTimeMinutes
    ) / existing.callCount;
    existing.lastCallAt = now;
    existing.score = calculateSourceScore(existing);
    SOCIAL_SOURCE_CACHE.set(handle, existing);
    return existing;
  }
  
  const newSource: SocialSource = {
    handle,
    platform,
    callCount: 1,
    successfulCalls: isSuccessful ? 1 : 0,
    successRate: isSuccessful ? 1 : 0,
    avgLeadTimeMinutes: leadTimeMinutes,
    lastCallAt: now,
    score: 50,
    isActive: true,
  };
  
  newSource.score = calculateSourceScore(newSource);
  SOCIAL_SOURCE_CACHE.set(handle, newSource);
  
  console.log(`[SocialDiscovery] Credited @${handle} for $${tokenSymbol} call (${leadTimeMinutes.toFixed(0)}min lead, ${pnlPercent.toFixed(1)}% gain)`);
  
  return newSource;
}

function calculateSourceScore(source: SocialSource): number {
  let score = 50;
  
  if (source.successRate >= 0.5) {
    score += (source.successRate - 0.5) * 60;
  } else if (source.successRate < 0.3) {
    score -= (0.3 - source.successRate) * 40;
  }
  
  if (source.avgLeadTimeMinutes >= 60) {
    score += Math.min((source.avgLeadTimeMinutes - 60) / 10, 15);
  } else if (source.avgLeadTimeMinutes < 15) {
    score -= 10;
  }
  
  if (source.callCount >= 10) {
    score += 10;
  } else if (source.callCount < 3) {
    score -= 15;
  }
  
  return Math.max(0, Math.min(100, score));
}

export async function discoverSocialSourcesFromWinners(
  windowHours: number = 72,
  minPnlPercent: number = 20
): Promise<{
  tokensScanned: number;
  sourcesFound: number;
  sourcesCredited: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (windowHours * 3600);
  
  const winners = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.status, "closed"),
      gte(paperPositions.exitTimestamp, windowStart),
      gte(paperPositions.realizedPnlPercent, minPnlPercent)
    ))
    .orderBy(desc(paperPositions.realizedPnlPercent))
    .limit(20);
  
  let sourcesFound = 0;
  let sourcesCredited = 0;
  
  for (const winner of winners) {
    if (!winner.tokenSymbol) continue;
    
    const mentions = await searchNitterForToken(winner.tokenSymbol, 72);
    sourcesFound += mentions.length;
    
    for (const mention of mentions) {
      if (mention.timestamp < winner.entryTimestamp) {
        await creditSocialSource(
          mention.handle,
          "twitter",
          winner.tokenMint,
          winner.tokenSymbol,
          mention.timestamp,
          winner.entryTimestamp,
          winner.realizedPnlPercent || 0
        );
        sourcesCredited++;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log(`[SocialDiscovery] Scanned ${winners.length} winners, found ${sourcesFound} mentions, credited ${sourcesCredited} sources`);
  
  return {
    tokensScanned: winners.length,
    sourcesFound,
    sourcesCredited,
  };
}

export function getSocialBoostForToken(tokenSymbol: string): number {
  const MAX_SOCIAL_BOOST = 15;
  
  const relevantCalls = SOCIAL_CALLS_CACHE.filter(
    c => c.tokenSymbol.toLowerCase() === tokenSymbol.toLowerCase() && c.isSuccessful
  );
  
  if (relevantCalls.length === 0) return 0;
  
  const uniqueSources = new Set(relevantCalls.map(c => c.sourceHandle));
  const avgSourceScore = Array.from(uniqueSources).reduce((sum, handle) => {
    const source = SOCIAL_SOURCE_CACHE.get(handle);
    return sum + (source?.score || 50);
  }, 0) / uniqueSources.size;
  
  const boost = Math.min(
    (uniqueSources.size * 3) + (avgSourceScore / 20),
    MAX_SOCIAL_BOOST
  );
  
  return boost;
}

export async function getTopSocialSources(
  limit: number = 20,
  minCalls: number = 2
): Promise<SocialSource[]> {
  return Array.from(SOCIAL_SOURCE_CACHE.values())
    .filter(s => s.callCount >= minCalls)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function getSocialSourceStats(): Promise<{
  totalSources: number;
  activeSources: number;
  totalCalls: number;
  avgSuccessRate: number;
  topPerformers: SocialSource[];
}> {
  const sources = Array.from(SOCIAL_SOURCE_CACHE.values());
  const activeSources = sources.filter(s => s.isActive);
  
  const avgSuccessRate = sources.length > 0
    ? sources.reduce((sum, s) => sum + s.successRate, 0) / sources.length
    : 0;
  
  const topPerformers = sources
    .filter(s => s.callCount >= 3)
    .sort((a, b) => b.successRate - a.successRate)
    .slice(0, 5);
  
  return {
    totalSources: sources.length,
    activeSources: activeSources.length,
    totalCalls: SOCIAL_CALLS_CACHE.length,
    avgSuccessRate,
    topPerformers,
  };
}

export function getRecentSocialCalls(limit: number = 20): SocialCall[] {
  return SOCIAL_CALLS_CACHE
    .sort((a, b) => b.callTimestamp - a.callTimestamp)
    .slice(0, limit);
}

export function clearSocialCaches(): void {
  SOCIAL_SOURCE_CACHE.clear();
  SOCIAL_CALLS_CACHE.length = 0;
}
