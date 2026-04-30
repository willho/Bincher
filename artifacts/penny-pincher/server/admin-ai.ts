import OpenAI from "openai";
import { db } from "./db";
import { systemInsights, systemLogs, emergentRules, adminChatMessages } from "@shared/schema";
import { desc, gte, eq, sql, and } from "drizzle-orm";

const openai = new OpenAI();

export interface SystemSummary {
  errors: {
    count: number;
    recent: Array<{ service: string; message: string; timestamp: number }>;
  };
  optimizations: {
    rulesCreated: number;
    rulesTriggered: number;
    insightsPublished: number;
    patternsDetected: number;
  };
  observations: {
    topInsightSources: Array<{ source: string; count: number }>;
    recentPatterns: Array<{ type: string; title: string; confidence: number }>;
    rulePerformance: Array<{ name: string; confidence: number; triggerCount: number }>;
  };
  health: {
    status: "healthy" | "warning" | "critical";
    issues: string[];
  };
}

export async function getSystemSummaryForAdmin(): Promise<SystemSummary> {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 604800;

  const [errorLogs, recentInsights, activeRules, insightSources] = await Promise.all([
    db.select({
      id: systemLogs.id,
      service: systemLogs.service,
      errorMessage: systemLogs.errorMessage,
      createdAt: systemLogs.createdAt,
    })
      .from(systemLogs)
      .where(and(
        eq(systemLogs.status, "error"),
        gte(systemLogs.createdAt, dayAgo)
      ))
      .orderBy(desc(systemLogs.createdAt))
      .limit(10),

    db.select()
      .from(systemInsights)
      .where(gte(systemInsights.createdAt, dayAgo))
      .orderBy(desc(systemInsights.createdAt))
      .limit(20),

    db.select()
      .from(emergentRules)
      .where(eq(emergentRules.status, "active"))
      .orderBy(desc(emergentRules.sampleCount))
      .limit(10),

    db.select({
      source: systemInsights.sourceSystem,
      count: sql<number>`count(*)::int`,
    })
      .from(systemInsights)
      .where(gte(systemInsights.createdAt, weekAgo))
      .groupBy(systemInsights.sourceSystem)
      .orderBy(desc(sql`count(*)`))
      .limit(5),
  ]);

  const rulesCreatedCount = await db.select({ count: sql<number>`count(*)::int` })
    .from(emergentRules)
    .where(gte(emergentRules.createdAt, weekAgo))
    .then(r => r[0]?.count || 0);

  const totalTriggers = activeRules.reduce((sum, r) => sum + (r.sampleCount || 0), 0);

  const issues: string[] = [];
  if (errorLogs.length > 5) {
    issues.push(`${errorLogs.length} errors in last 24h`);
  }
  const lowConfidenceRules = activeRules.filter(r => (r.confidence ?? 0) < 0.4);
  if (lowConfidenceRules.length > 0) {
    issues.push(`${lowConfidenceRules.length} rules with low confidence need attention`);
  }

  let healthStatus: "healthy" | "warning" | "critical" = "healthy";
  if (issues.length > 0) healthStatus = "warning";
  if (errorLogs.length > 10) healthStatus = "critical";

  return {
    errors: {
      count: errorLogs.length,
      recent: errorLogs.map(e => ({
        service: e.service,
        message: e.errorMessage || "Unknown error",
        timestamp: e.createdAt,
      })),
    },
    optimizations: {
      rulesCreated: rulesCreatedCount,
      rulesTriggered: totalTriggers,
      insightsPublished: recentInsights.length,
      patternsDetected: recentInsights.filter(i => i.insightType === "pattern").length,
    },
    observations: {
      topInsightSources: insightSources.map(s => ({ source: s.source, count: s.count })),
      recentPatterns: recentInsights
        .filter(i => i.insightType === "pattern")
        .slice(0, 5)
        .map(i => ({
          type: (i.payload as Record<string, unknown>)?.pattern as string || "unknown",
          title: i.title,
          confidence: i.confidence ?? 0,
        })),
      rulePerformance: activeRules.map(r => ({
        name: r.name,
        confidence: r.confidence ?? 0,
        triggerCount: r.sampleCount ?? 0,
      })),
    },
    health: {
      status: healthStatus,
      issues,
    },
  };
}

export async function chatWithAdminAI(message: string, systemContext: SystemSummary): Promise<string> {
  const chatHistory = await db.select()
    .from(adminChatMessages)
    .orderBy(adminChatMessages.createdAt)
    .limit(20);

  const systemPrompt = `You are the Penny Pincher System Administrator AI. You help the admin understand system health, errors, self-optimization progress, and observations.

CURRENT SYSTEM STATE:
- Health: ${systemContext.health.status}
- Issues: ${systemContext.health.issues.length > 0 ? systemContext.health.issues.join(", ") : "None"}
- Errors (24h): ${systemContext.errors.count}
- Rules created (7d): ${systemContext.optimizations.rulesCreated}
- Rules triggered: ${systemContext.optimizations.rulesTriggered}
- Insights published (24h): ${systemContext.optimizations.insightsPublished}
- Patterns detected: ${systemContext.optimizations.patternsDetected}

TOP INSIGHT SOURCES:
${systemContext.observations.topInsightSources.map(s => `- ${s.source}: ${s.count} insights`).join("\n") || "No insights yet"}

RECENT PATTERNS:
${systemContext.observations.recentPatterns.map(p => `- ${p.type}: ${p.title} (${(p.confidence * 100).toFixed(0)}% confidence)`).join("\n") || "No patterns detected"}

RULE PERFORMANCE:
${systemContext.observations.rulePerformance.map(r => `- ${r.name}: ${r.triggerCount} triggers, ${(r.confidence * 100).toFixed(0)}% confidence`).join("\n") || "No active rules"}

RECENT ERRORS:
${systemContext.errors.recent.slice(0, 3).map(e => `- [${e.service}] ${e.message}`).join("\n") || "No recent errors"}

Your role:
1. Summarize system health when asked
2. Explain self-optimization progress (rules auto-created from patterns)
3. Highlight issues that need attention
4. Suggest improvements based on patterns
5. Answer questions about system behavior

Be concise and technical. Use bullet points for clarity.`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...chatHistory.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: message },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || "I couldn't process that request.";
  } catch (error) {
    console.error("[AdminAI] Chat error:", error);
    return "System error processing your request. Please try again.";
  }
}
