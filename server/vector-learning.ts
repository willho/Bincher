import { db } from "./db";
import { behaviorVectors, globalBaselines } from "@shared/schema";
import { eq } from "drizzle-orm";

// Default baseline values for personality axes
const DEFAULT_BASELINE = {
  slangLevel: 50,
  crabHintLevel: 30,
  teasingLevel: 40,
  proactivityLevel: 50,
  culturalRefLevel: 40,
  tradingCautionLevel: 60,
};

export interface PersonalityVector {
  slangLevel: number;
  crabHintLevel: number;
  teasingLevel: number;
  proactivityLevel: number;
  culturalRefLevel: number;
  tradingCautionLevel: number;
}

export async function getOrCreateGlobalBaseline(): Promise<PersonalityVector> {
  const existing = await db.select().from(globalBaselines)
    .where(eq(globalBaselines.baselineType, "personality"))
    .limit(1);
  
  if (existing.length > 0) {
    return {
      slangLevel: existing[0].slangLevel ?? DEFAULT_BASELINE.slangLevel,
      crabHintLevel: existing[0].crabHintLevel ?? DEFAULT_BASELINE.crabHintLevel,
      teasingLevel: existing[0].teasingLevel ?? DEFAULT_BASELINE.teasingLevel,
      proactivityLevel: existing[0].proactivityLevel ?? DEFAULT_BASELINE.proactivityLevel,
      culturalRefLevel: existing[0].culturalRefLevel ?? DEFAULT_BASELINE.culturalRefLevel,
      tradingCautionLevel: existing[0].tradingCautionLevel ?? DEFAULT_BASELINE.tradingCautionLevel,
    };
  }
  
  // Create default baseline
  const now = Math.floor(Date.now() / 1000);
  await db.insert(globalBaselines).values({
    baselineType: "personality",
    ...DEFAULT_BASELINE,
    sampleCount: 0,
    createdAt: now,
  });
  
  return { ...DEFAULT_BASELINE };
}

export async function getUserBehaviorVector(userId: number): Promise<PersonalityVector | null> {
  const existing = await db.select().from(behaviorVectors)
    .where(eq(behaviorVectors.userId, userId))
    .limit(1);
  
  if (existing.length === 0) return null;
  
  return {
    slangLevel: existing[0].slangLevel ?? DEFAULT_BASELINE.slangLevel,
    crabHintLevel: existing[0].crabHintLevel ?? DEFAULT_BASELINE.crabHintLevel,
    teasingLevel: existing[0].teasingLevel ?? DEFAULT_BASELINE.teasingLevel,
    proactivityLevel: existing[0].proactivityLevel ?? DEFAULT_BASELINE.proactivityLevel,
    culturalRefLevel: existing[0].culturalRefLevel ?? DEFAULT_BASELINE.culturalRefLevel,
    tradingCautionLevel: existing[0].tradingCautionLevel ?? DEFAULT_BASELINE.tradingCautionLevel,
  };
}

export async function initializeUserVector(userId: number): Promise<PersonalityVector> {
  const baseline = await getOrCreateGlobalBaseline();
  const now = Math.floor(Date.now() / 1000);
  
  // Check if already exists
  const existing = await getUserBehaviorVector(userId);
  if (existing) return existing;
  
  // Create from baseline
  await db.insert(behaviorVectors).values({
    userId,
    ...baseline,
    slangDampening: 1.0,
    crabDampening: 1.0,
    teasingDampening: 1.0,
    proactivityDampening: 1.0,
    culturalDampening: 1.0,
    tradingDampening: 1.0,
    totalUpdates: 0,
    createdAt: now,
  });
  
  return baseline;
}

export async function getEffectivePersonality(userId: number): Promise<PersonalityVector> {
  const baseline = await getOrCreateGlobalBaseline();
  const userVector = await getUserBehaviorVector(userId);
  
  if (!userVector) {
    // No user vector yet, return baseline
    return baseline;
  }
  
  // Blend: user vector takes precedence, baseline fills gaps
  // Future: Could implement weighted blending based on user's totalUpdates
  return {
    slangLevel: userVector.slangLevel,
    crabHintLevel: userVector.crabHintLevel,
    teasingLevel: userVector.teasingLevel,
    proactivityLevel: userVector.proactivityLevel,
    culturalRefLevel: userVector.culturalRefLevel,
    tradingCautionLevel: userVector.tradingCautionLevel,
  };
}

export function vectorToPromptContext(vector: PersonalityVector): string {
  // Convert numeric vectors to compact personality context for AI
  const levels = (v: number) => v < 30 ? "low" : v < 70 ? "moderate" : "high";
  
  return `[Personality: slang=${levels(vector.slangLevel)}, crab-hints=${levels(vector.crabHintLevel)}, teasing=${levels(vector.teasingLevel)}, proactive=${levels(vector.proactivityLevel)}, cultural=${levels(vector.culturalRefLevel)}, caution=${levels(vector.tradingCautionLevel)}]`;
}
