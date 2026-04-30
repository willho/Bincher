// @ts-nocheck
/**
 * Creator Reputation System
 *
 * Looks up creator history from PumpPortal or pump.fun API.
 * Used to evaluate new tokens entering the system.
 *
 * Key principle: Unknown creators are risky. We need actual track record.
 */

import axios from "axios";

export interface CreatorHistory {
  totalLaunches: number;
  successRate: number;      // % of tokens that reached 2x (or survived first 5 min)
  rugRate: number;          // % that were rugs/honeypots
  avgMultiplier: number;    // Average peak multiplier across launches
  lastLaunchTime?: number;  // When did they last launch
  totalVolume?: number;     // Total volume across launches
  confidence: number;       // How sure we are about these numbers (0-1)
}

const CREATOR_CACHE = new Map<string, { data: CreatorHistory; cachedAt: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Get creator history from PumpPortal
 *
 * PumpPortal tracks pump.fun token creators and their track records.
 * API: https://api.pumpportal.fun/
 */
async function getCreatorHistoryFromPumpPortal(creatorAddress: string): Promise<CreatorHistory | null> {
  try {
    const response = await axios.get(`https://api.pumpportal.fun/creator/${creatorAddress}/stats`, {
      timeout: 5000,
    });

    if (!response.data) {
      return null;
    }

    const data = response.data;

    return {
      totalLaunches: data.total_launches || 0,
      successRate: (data.successful_launches || 0) / Math.max(1, data.total_launches || 1),
      rugRate: (data.rugged_tokens || 0) / Math.max(1, data.total_launches || 1),
      avgMultiplier: data.avg_peak_multiplier || 1.5,
      lastLaunchTime: data.last_launch_time,
      totalVolume: data.total_volume,
      confidence: Math.min(1.0, (data.total_launches || 0) / 10), // Higher confidence with more launches
    };
  } catch (error) {
    console.error(`[CreatorReputation] PumpPortal lookup failed for ${creatorAddress.slice(0, 8)}...:`);
    return null;
  }
}

/**
 * Alternative: Get creator history from pump.fun API
 * Fallback if PumpPortal is down
 */
async function getCreatorHistoryFromPumpFun(creatorAddress: string): Promise<CreatorHistory | null> {
  try {
    // pump.fun API endpoint for creator tokens
    const response = await axios.get(`https://frontend-api.pump.fun/creator/${creatorAddress}/tokens`, {
      timeout: 5000,
      params: {
        limit: 100,
      },
    });

    if (!response.data?.tokens || response.data.tokens.length === 0) {
      return null;
    }

    const tokens = response.data.tokens;

    // Analyze tokens to compute creator stats
    let successCount = 0;
    let rugCount = 0;
    let totalMultiplier = 0;

    for (const token of tokens) {
      const isRug = token.is_rug || token.total_burned === null || token.is_honeypot;
      const peakMultiplier = token.max_price ? token.max_price / token.initial_price : 1;

      if (isRug) {
        rugCount++;
      } else if (peakMultiplier >= 2.0) {
        successCount++;
      }

      totalMultiplier += peakMultiplier;
    }

    return {
      totalLaunches: tokens.length,
      successRate: successCount / Math.max(1, tokens.length),
      rugRate: rugCount / Math.max(1, tokens.length),
      avgMultiplier: totalMultiplier / Math.max(1, tokens.length),
      lastLaunchTime: tokens[0]?.created_time,
      totalVolume: tokens.reduce((sum, t) => sum + (t.total_volume || 0), 0),
      confidence: Math.min(1.0, tokens.length / 20), // Higher confidence with more data
    };
  } catch (error) {
    console.error(
      `[CreatorReputation] pump.fun lookup failed for ${creatorAddress.slice(0, 8)}...:`
    );
    return null;
  }
}

/**
 * Get creator reputation with caching
 * Tries PumpPortal first, falls back to pump.fun API
 */
export async function getCreatorReputation(creatorAddress: string): Promise<CreatorHistory> {
  // Check cache first
  const cached = CREATOR_CACHE.get(creatorAddress);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  let history: CreatorHistory | null = null;

  // Try PumpPortal first (faster, more reliable)
  if (process.env.PUMPPORTAL_API_KEY) {
    history = await getCreatorHistoryFromPumpPortal(creatorAddress);
  }

  // Fallback to pump.fun API
  if (!history) {
    history = await getCreatorHistoryFromPumpFun(creatorAddress);
  }

  // If both fail, return low-confidence unknown creator
  if (!history) {
    history = {
      totalLaunches: 0,
      successRate: 0.5,      // Neutral: could go either way
      rugRate: 0.2,          // Assume 20% rug risk (unknown creator)
      avgMultiplier: 1.5,    // Assume minimal multiplier
      confidence: 0.0,       // No data = zero confidence
    };
  }

  // Cache the result
  CREATOR_CACHE.set(creatorAddress, { data: history, cachedAt: Date.now() });

  return history;
}

/**
 * Convert creator history to reputation score (0-1)
 *
 * Scoring logic:
 * - Success rate (did they create winners?)
 * - Rug rate (did they scam?)
 * - Launch experience (more launches = more reliable data)
 * - Recent activity (are they active?)
 */
export function scoreCreatorReputation(history: CreatorHistory): number {
  // Base score from success rate (40% weight)
  const successScore = history.successRate * 0.6;

  // Deduct for rug rate (20% weight)
  const rugPenalty = history.rugRate * 0.4;

  // Experience boost: more launches = higher confidence in score
  const experienceBoost = Math.min(0.2, history.totalLaunches / 50);

  // Combine: success - rugs + experience boost
  const baseScore = successScore - rugPenalty + experienceBoost;

  // Confidence-weight the score:
  // If low confidence (unknown creator), pull toward 0.5 (neutral)
  // If high confidence (known creator), trust the score fully
  const minScore = 0.1; // Never go below 0.1
  const maxScore = 1.0;

  const confidenceWeightedScore = 0.5 * (1 - history.confidence) + baseScore * history.confidence;

  return Math.max(minScore, Math.min(maxScore, confidenceWeightedScore));
}

/**
 * Get monitoring tier for a token based on creator reputation
 *
 * Tier strategy (from old price-monitor.ts):
 * - HOT (5 min polling): New tokens from unknown/risky creators
 * - WARM (15 min polling): Tokens from decent creators
 * - COLD (no polling): Tokens with strong creator track record
 *
 * Plus: Webhook monitoring for first 5 minutes of pump.fun tokens
 */
export function getMonitoringTier(creatorReputation: CreatorHistory, tokenAgeMinutes: number): "hot" | "warm" | "cold" {
  // First 5 minutes of any pump.fun token: HOT (webhook monitoring)
  if (tokenAgeMinutes < 5) {
    return "hot";
  }

  const score = scoreCreatorReputation(creatorReputation);

  // Unknown or risky creator (score < 0.4): HOT monitoring
  if (score < 0.4) {
    return "hot"; // 5 min polling
  }

  // Medium creator (score 0.4-0.7): WARM monitoring
  if (score < 0.7) {
    return "warm"; // 15 min polling
  }

  // Trusted creator (score >= 0.7): COLD monitoring
  return "cold"; // No polling (only if manually tracked)
}

/**
 * Determine if we should even trade a token from this creator
 */
export function isCreatorTradeable(history: CreatorHistory): boolean {
  const score = scoreCreatorReputation(history);

  // Known rug artists: don't trade
  if (history.rugRate > 0.5) {
    return false;
  }

  // Complete unknown: require strong cluster match separately
  if (history.confidence < 0.2 && score < 0.4) {
    return false; // Need other signals
  }

  // Otherwise: tradeable (with appropriate risk tier)
  return true;
}

/**
 * Classify creator type for logging/monitoring
 */
export function classifyCreator(history: CreatorHistory): string {
  const score = scoreCreatorReputation(history);

  if (history.totalLaunches === 0) {
    return "unknown";
  }

  if (history.rugRate > 0.5) {
    return "known_scammer";
  }

  if (score >= 0.8) {
    return "trusted_creator";
  }

  if (score >= 0.6) {
    return "decent_creator";
  }

  if (score >= 0.4) {
    return "mixed_record";
  }

  return "risky_creator";
}

export default {
  getCreatorReputation,
  scoreCreatorReputation,
  getMonitoringTier,
  isCreatorTradeable,
  classifyCreator,
};
