import OpenAI from "openai";
import { z } from "zod";
import { db } from "./db";
import { tokenSnapshots, aiChatMessages, pendingBuys } from "@shared/schema";
import type { TokenSnapshot, InsertTokenSnapshot } from "@shared/schema";
import { eq, desc, and, isNotNull } from "drizzle-orm";

const scoreResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string(),
  redFlags: z.array(z.string()).default([]),
  greenFlags: z.array(z.string()).default([]),
});

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "dummy-key",
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
});

export interface SnapshotData {
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  priceUsd?: number;
  marketCap?: number;
  fdv?: number;
  liquidity?: number;
  volume24h?: number;
  priceChange24h?: number;
  pairCreatedAt?: number;
  buys24h?: number;
  sells24h?: number;
  buyVolume24h?: number;
  sellVolume24h?: number;
  holders?: number;
  topHolderPercent?: number;
  devWalletPercent?: number;
  lpBurned?: boolean;
  lpLockedPercent?: number;
  sourceWallets?: string[];
  knownWhalesBuying?: number;
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  twitterHandle?: string;
  socialSearchResult?: string;
}

export async function createSnapshot(data: SnapshotData): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const tokenAgeMinutes = data.pairCreatedAt 
    ? Math.floor((now - data.pairCreatedAt) / 60) 
    : undefined;

  const result = await db.insert(tokenSnapshots).values({
    tokenMint: data.tokenMint,
    tokenSymbol: data.tokenSymbol,
    tokenName: data.tokenName,
    capturedAt: now,
    priceUsd: data.priceUsd,
    marketCap: data.marketCap,
    fdv: data.fdv,
    liquidity: data.liquidity,
    volume24h: data.volume24h,
    priceChange24h: data.priceChange24h,
    pairCreatedAt: data.pairCreatedAt,
    tokenAgeMinutes,
    buys24h: data.buys24h,
    sells24h: data.sells24h,
    buyVolume24h: data.buyVolume24h,
    sellVolume24h: data.sellVolume24h,
    holders: data.holders,
    topHolderPercent: data.topHolderPercent,
    devWalletPercent: data.devWalletPercent,
    lpBurned: data.lpBurned,
    lpLockedPercent: data.lpLockedPercent,
    sourceWallets: data.sourceWallets || [],
    knownWhalesBuying: data.knownWhalesBuying || 0,
    hasTwitter: data.hasTwitter || false,
    hasTelegram: data.hasTelegram || false,
    hasWebsite: data.hasWebsite || false,
    twitterHandle: data.twitterHandle,
    socialSearchResult: data.socialSearchResult,
  }).returning();

  return result[0].id;
}

export async function getSnapshot(snapshotId: number): Promise<TokenSnapshot | null> {
  const rows = await db.select().from(tokenSnapshots).where(eq(tokenSnapshots.id, snapshotId)).limit(1);
  return rows.length > 0 ? rows[0] as TokenSnapshot : null;
}

export async function getSnapshotByToken(tokenMint: string): Promise<TokenSnapshot | null> {
  const rows = await db.select()
    .from(tokenSnapshots)
    .where(eq(tokenSnapshots.tokenMint, tokenMint))
    .orderBy(desc(tokenSnapshots.capturedAt))
    .limit(1);
  return rows.length > 0 ? rows[0] as TokenSnapshot : null;
}

export async function getAllSnapshots(): Promise<TokenSnapshot[]> {
  const rows = await db.select().from(tokenSnapshots).orderBy(desc(tokenSnapshots.capturedAt));
  return rows as TokenSnapshot[];
}

export async function getSnapshotsWithOutcomes(): Promise<TokenSnapshot[]> {
  const rows = await db.select()
    .from(tokenSnapshots)
    .where(isNotNull(tokenSnapshots.finalMultiplier))
    .orderBy(desc(tokenSnapshots.capturedAt));
  return rows as TokenSnapshot[];
}

function buildScoringPrompt(snapshot: TokenSnapshot, historicalData?: TokenSnapshot[]): string {
  const data = {
    token: snapshot.tokenSymbol,
    name: snapshot.tokenName,
    price: snapshot.priceUsd,
    marketCap: snapshot.marketCap,
    liquidity: snapshot.liquidity,
    fdv: snapshot.fdv,
    volume24h: snapshot.volume24h,
    priceChange24h: snapshot.priceChange24h,
    tokenAgeMinutes: snapshot.tokenAgeMinutes,
    buys24h: snapshot.buys24h,
    sells24h: snapshot.sells24h,
    buyVolume24h: snapshot.buyVolume24h,
    sellVolume24h: snapshot.sellVolume24h,
    holders: snapshot.holders,
    topHolderPercent: snapshot.topHolderPercent,
    devWalletPercent: snapshot.devWalletPercent,
    lpBurned: snapshot.lpBurned,
    lpLockedPercent: snapshot.lpLockedPercent,
    sourceWalletsCount: snapshot.sourceWallets?.length || 0,
    knownWhalesBuying: snapshot.knownWhalesBuying,
    hasTwitter: snapshot.hasTwitter,
    hasTelegram: snapshot.hasTelegram,
    hasWebsite: snapshot.hasWebsite,
    twitterHandle: snapshot.twitterHandle,
    socialInfo: snapshot.socialSearchResult,
  };

  let prompt = `Analyze this Solana memecoin for copy trading potential. Score from 0-100.

TOKEN DATA:
${JSON.stringify(data, null, 2)}

`;

  if (historicalData && historicalData.length > 0) {
    const patterns = historicalData.slice(0, 20).map(h => ({
      symbol: h.tokenSymbol,
      liquidity: h.liquidity,
      marketCap: h.marketCap,
      holders: h.holders,
      hasTwitter: h.hasTwitter,
      tokenAge: h.tokenAgeMinutes,
      finalMultiplier: h.finalMultiplier,
    }));
    
    prompt += `\nHISTORICAL TRADE OUTCOMES (learn from these):
${JSON.stringify(patterns, null, 2)}

`;
  }

  prompt += `Analyze and return JSON with:
{
  "score": <0-100 integer>,
  "reasoning": "<brief 2-3 sentence explanation>",
  "redFlags": ["<list any concerns>"],
  "greenFlags": ["<list positive indicators>"]
}

Key factors to consider:
- Liquidity vs market cap ratio (healthy is 10-30%)
- Token age (newer can be riskier but higher potential)
- Buy/sell ratio and volume
- Holder distribution (high top holder % is risky)
- Social presence (Twitter = more legitimate)
- Dev wallet concentration
- LP burned/locked status

Return ONLY valid JSON, no markdown or explanation outside the JSON.`;

  return prompt;
}

export interface ScoreResult {
  score: number;
  reasoning: string;
  redFlags: string[];
  greenFlags: string[];
}

export async function scoreToken(snapshotId: number): Promise<ScoreResult | null> {
  const snapshot = await getSnapshot(snapshotId);
  if (!snapshot) return null;

  const historicalData = await getSnapshotsWithOutcomes();
  const prompt = buildScoringPrompt(snapshot, historicalData);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a memecoin analysis expert. Analyze tokens for copy trading potential. Be objective and data-driven. Return only valid JSON."
        },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: 500,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content || "";
    
    let parsed: ScoreResult;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in AI response");
      
      const rawParsed = JSON.parse(jsonMatch[0]);
      const validationResult = scoreResultSchema.safeParse(rawParsed);
      
      if (!validationResult.success) {
        console.error("AI response validation failed:", validationResult.error.errors);
        return null;
      }
      
      parsed = validationResult.data;
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError, "Content:", content);
      return null;
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      await db.update(tokenSnapshots).set({
        aiScore: parsed.score,
        aiAnalysis: JSON.stringify(parsed),
        aiScoredAt: now,
      }).where(eq(tokenSnapshots.id, snapshotId));
    } catch (dbError) {
      console.error("Failed to update snapshot with AI score:", dbError);
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("AI scoring failed:", error);
    return null;
  }
}

export async function refreshScore(snapshotId: number): Promise<ScoreResult | null> {
  return scoreToken(snapshotId);
}

export async function updateSnapshotOutcome(
  snapshotId: number,
  finalMultiplier: number,
  holdTimeMinutes: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.update(tokenSnapshots).set({
    finalMultiplier,
    holdTimeMinutes,
    outcomeUpdatedAt: now,
  }).where(eq(tokenSnapshots.id, snapshotId));
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const chatTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "refresh_token_score",
      description: "Refresh the AI score for a specific token by its symbol or name. Use when the user asks to refresh, rescore, or re-analyze a specific token.",
      parameters: {
        type: "object",
        properties: {
          tokenIdentifier: {
            type: "string",
            description: "The token symbol (e.g., 'PEPE', 'BONK') or partial name to search for"
          }
        },
        required: ["tokenIdentifier"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "refresh_all_scores",
      description: "Refresh AI scores for all tokens or multiple tokens. Use when the user asks to refresh all scores, rescore everything, or update all token analyses.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of tokens to refresh (default 10, max 50)"
          }
        },
        required: []
      }
    }
  }
];

async function executeScoreRefresh(tokenIdentifier: string): Promise<{ success: boolean; message: string; score?: number }> {
  const snapshots = await getAllSnapshots();
  const searchLower = tokenIdentifier.toLowerCase();
  
  const match = snapshots.find(s => 
    s.tokenSymbol.toLowerCase() === searchLower ||
    s.tokenSymbol.toLowerCase().includes(searchLower) ||
    (s.tokenName && s.tokenName.toLowerCase().includes(searchLower))
  );
  
  if (!match) {
    return { success: false, message: `No token found matching "${tokenIdentifier}"` };
  }
  
  const result = await scoreToken(match.id);
  if (!result) {
    return { success: false, message: `Failed to refresh score for ${match.tokenSymbol}` };
  }
  
  return { 
    success: true, 
    message: `Refreshed score for ${match.tokenSymbol}: ${result.score}/100`,
    score: result.score
  };
}

async function executeBatchScoreRefresh(limit: number = 10): Promise<{ success: boolean; message: string; refreshed: number }> {
  const maxLimit = Math.min(limit, 50);
  const snapshots = await getAllSnapshots();
  const toRefresh = snapshots.slice(0, maxLimit);
  
  let refreshed = 0;
  const results: string[] = [];
  
  for (const snapshot of toRefresh) {
    const result = await scoreToken(snapshot.id);
    if (result) {
      refreshed++;
      results.push(`${snapshot.tokenSymbol}: ${result.score}`);
    }
  }
  
  return {
    success: true,
    message: `Refreshed ${refreshed}/${toRefresh.length} token scores. Results: ${results.join(', ')}`,
    refreshed
  };
}

export async function chatWithAI(
  userId: number,
  userMessage: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  await db.insert(aiChatMessages).values({
    userId,
    role: "user",
    content: userMessage,
    createdAt: now,
  });

  const history = await db.select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(desc(aiChatMessages.createdAt))
    .limit(20);
  
  history.reverse();

  const snapshots = await getAllSnapshots();
  const snapshotsWithOutcomes = await getSnapshotsWithOutcomes();
  
  const systemPrompt = `You are an AI assistant for a Solana memecoin copy trading system. You help users understand:
- Token analysis and patterns
- Trading performance insights
- Market trends and signals

You can also TAKE ACTIONS when requested:
- Refresh/rescore a specific token using refresh_token_score
- Refresh all token scores using refresh_all_scores

When the user asks to refresh, rescore, re-analyze, or update scores, USE THE APPROPRIATE FUNCTION.

CURRENT DATABASE STATS:
- Total tokens analyzed: ${snapshots.length}
- Tokens with outcomes: ${snapshotsWithOutcomes.length}

RECENT TOKEN SNAPSHOTS (last 10):
${JSON.stringify(snapshots.slice(0, 10).map(s => ({
  id: s.id,
  symbol: s.tokenSymbol,
  name: s.tokenName,
  score: s.aiScore,
  liquidity: s.liquidity,
  marketCap: s.marketCap,
  hasTwitter: s.hasTwitter,
  outcome: s.finalMultiplier,
})), null, 2)}

${snapshotsWithOutcomes.length > 0 ? `
PERFORMANCE PATTERNS (tokens with outcomes):
${JSON.stringify(snapshotsWithOutcomes.slice(0, 10).map(s => ({
  symbol: s.tokenSymbol,
  score: s.aiScore,
  liquidity: s.liquidity,
  hasTwitter: s.hasTwitter,
  finalMultiplier: s.finalMultiplier,
  holdTime: s.holdTimeMinutes,
})), null, 2)}
` : ''}

Be helpful, concise, and data-driven. When refreshing scores, call the appropriate function and report the results.`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: chatTools,
      tool_choice: "auto",
      max_completion_tokens: 1000,
      temperature: 0.7,
    });

    const message = response.choices[0]?.message;
    
    // Handle function calls
    if (message?.tool_calls && message.tool_calls.length > 0) {
      const toolResults: string[] = [];
      
      for (const toolCall of message.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        
        if (toolCall.function.name === "refresh_token_score") {
          const result = await executeScoreRefresh(args.tokenIdentifier);
          toolResults.push(result.message);
        } else if (toolCall.function.name === "refresh_all_scores") {
          const result = await executeBatchScoreRefresh(args.limit || 10);
          toolResults.push(result.message);
        }
      }
      
      // Get a natural response after executing tools
      const followUpMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...messages,
        message as OpenAI.Chat.ChatCompletionMessageParam,
        ...message.tool_calls.map((tc, i) => ({
          role: "tool" as const,
          tool_call_id: tc.id,
          content: toolResults[i] || "Done"
        }))
      ];
      
      const followUp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: followUpMessages,
        max_completion_tokens: 500,
        temperature: 0.7,
      });
      
      const assistantMessage = followUp.choices[0]?.message?.content || toolResults.join("\n");
      
      await db.insert(aiChatMessages).values({
        userId,
        role: "assistant",
        content: assistantMessage,
        createdAt: Math.floor(Date.now() / 1000),
      });
      
      return assistantMessage;
    }

    const assistantMessage = message?.content || "I couldn't generate a response.";

    await db.insert(aiChatMessages).values({
      userId,
      role: "assistant",
      content: assistantMessage,
      createdAt: Math.floor(Date.now() / 1000),
    });

    return assistantMessage;
  } catch (error) {
    console.error("AI chat failed:", error);
    return "Sorry, I'm having trouble connecting to the AI service right now.";
  }
}

export async function getChatHistory(userId: number): Promise<ChatMessage[]> {
  const messages = await db.select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(aiChatMessages.createdAt);
  
  return messages.map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}

export async function clearChatHistory(userId: number): Promise<void> {
  await db.delete(aiChatMessages).where(eq(aiChatMessages.userId, userId));
}

export async function getAIInsights(): Promise<{
  totalTokens: number;
  tokensWithOutcomes: number;
  averageScore: number;
  topPatterns: string[];
  winRate: number;
}> {
  const snapshots = await getAllSnapshots();
  const withOutcomes = await getSnapshotsWithOutcomes();
  
  const scores = snapshots.filter(s => s.aiScore !== null).map(s => s.aiScore!);
  const averageScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  
  const winners = withOutcomes.filter(s => (s.finalMultiplier || 0) >= 2);
  const winRate = withOutcomes.length > 0 ? (winners.length / withOutcomes.length) * 100 : 0;
  
  const twitterWinners = winners.filter(s => s.hasTwitter).length;
  const twitterTotal = withOutcomes.filter(s => s.hasTwitter).length;
  const noTwitterTotal = withOutcomes.filter(s => !s.hasTwitter).length;
  
  const patterns: string[] = [];
  
  if (twitterTotal > 0 && noTwitterTotal > 0) {
    const twitterWinRate = twitterWinners / twitterTotal;
    const noTwitterWinners = winners.filter(s => !s.hasTwitter).length;
    const noTwitterWinRate = noTwitterWinners / noTwitterTotal;
    
    if (twitterWinRate > noTwitterWinRate * 1.2) {
      patterns.push(`Tokens with Twitter presence have ${((twitterWinRate / noTwitterWinRate - 1) * 100).toFixed(0)}% higher win rate`);
    }
  }
  
  const highScoreWinners = winners.filter(s => (s.aiScore || 0) >= 60).length;
  const highScoreTotal = withOutcomes.filter(s => (s.aiScore || 0) >= 60).length;
  if (highScoreTotal >= 3) {
    const highScoreWinRate = (highScoreWinners / highScoreTotal) * 100;
    patterns.push(`High score (60+) tokens have ${highScoreWinRate.toFixed(0)}% win rate`);
  }
  
  return {
    totalTokens: snapshots.length,
    tokensWithOutcomes: withOutcomes.length,
    averageScore: Math.round(averageScore),
    topPatterns: patterns,
    winRate: Math.round(winRate),
  };
}
