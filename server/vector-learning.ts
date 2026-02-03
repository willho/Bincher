import { db } from "./db";
import { behaviorVectors, globalBaselines, userRelationships } from "@shared/schema";
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
  const levels = (v: number) => v < 30 ? "low" : v < 70 ? "moderate" : "high";
  
  return `[Personality: slang=${levels(vector.slangLevel)}, crab-hints=${levels(vector.crabHintLevel)}, teasing=${levels(vector.teasingLevel)}, proactive=${levels(vector.proactivityLevel)}, cultural=${levels(vector.culturalRefLevel)}, caution=${levels(vector.tradingCautionLevel)}]`;
}

// Signal types for behavior updates
export type BehaviorSignal = 
  | 'user_liked_slang'      // User responded positively to Caribbean expressions
  | 'user_disliked_slang'   // User seemed confused or negative about slang
  | 'crab_joke_landed'      // User laughed at or played along with crab hints
  | 'crab_annoyed'          // User got annoyed by crab references
  | 'teasing_welcomed'      // User enjoyed playful banter
  | 'teasing_rejected'      // User wanted more serious interaction
  | 'advice_followed'       // User took her proactive trading advice
  | 'advice_ignored'        // User ignored her suggestions
  | 'cultural_resonated'    // User connected with Caribbean cultural references
  | 'cultural_missed'       // Cultural reference didn't land
  | 'cautious_appreciated'  // User appreciated conservative advice
  | 'cautious_frustrated';  // User wanted more aggressive suggestions

const SIGNAL_EFFECTS: Record<BehaviorSignal, Partial<Record<keyof PersonalityVector, number>>> = {
  'user_liked_slang': { slangLevel: 3 },
  'user_disliked_slang': { slangLevel: -3 },
  'crab_joke_landed': { crabHintLevel: 4 },
  'crab_annoyed': { crabHintLevel: -5 },
  'teasing_welcomed': { teasingLevel: 3 },
  'teasing_rejected': { teasingLevel: -4 },
  'advice_followed': { proactivityLevel: 3, tradingCautionLevel: 2 },
  'advice_ignored': { proactivityLevel: -2 },
  'cultural_resonated': { culturalRefLevel: 4 },
  'cultural_missed': { culturalRefLevel: -2 },
  'cautious_appreciated': { tradingCautionLevel: 3 },
  'cautious_frustrated': { tradingCautionLevel: -4 },
};

const AXIS_TO_DAMPENING: Record<keyof PersonalityVector, string> = {
  slangLevel: 'slangDampening',
  crabHintLevel: 'crabDampening',
  teasingLevel: 'teasingDampening',
  proactivityLevel: 'proactivityDampening',
  culturalRefLevel: 'culturalDampening',
  tradingCautionLevel: 'tradingDampening',
};

export async function updateBehaviorVector(
  userId: number, 
  signal: BehaviorSignal,
  affinityMultiplier: number = 1.0 // Higher affinity = stronger signal impact
): Promise<PersonalityVector> {
  const now = Math.floor(Date.now() / 1000);
  
  // Ensure user has a vector
  let vector = await getUserBehaviorVector(userId);
  if (!vector) {
    vector = await initializeUserVector(userId);
  }
  
  // Get current dampening factors
  const existing = await db.select().from(behaviorVectors)
    .where(eq(behaviorVectors.userId, userId))
    .limit(1);
  
  if (existing.length === 0) return vector;
  
  const effects = SIGNAL_EFFECTS[signal];
  const updates: Record<string, number | null> = {
    updatedAt: now,
    lastVectorUpdate: now,
    totalUpdates: (existing[0].totalUpdates ?? 0) + 1,
  };
  
  // Apply each effect with dampening
  for (const [axis, delta] of Object.entries(effects)) {
    const axisKey = axis as keyof PersonalityVector;
    const dampeningKey = AXIS_TO_DAMPENING[axisKey] as keyof typeof existing[0];
    const currentDampening = (existing[0][dampeningKey] as number) ?? 1.0;
    
    // Apply dampening: reduce impact when oscillating
    const dampenedDelta = delta * currentDampening * affinityMultiplier;
    const currentValue = vector[axisKey];
    const newValue = Math.max(0, Math.min(100, currentValue + dampenedDelta));
    
    updates[axis] = Math.round(newValue);
    
    // Reduce dampening if direction changed (oscillation detection)
    // Increase dampening recovery if direction consistent
    const wasIncreasing = delta > 0;
    const wouldOscillate = (wasIncreasing && currentValue > 50) || (!wasIncreasing && currentValue < 50);
    
    if (wouldOscillate && Math.abs(delta) > 2) {
      // Reduce dampening for this axis (slower future changes)
      updates[AXIS_TO_DAMPENING[axisKey]] = Math.max(0.3, currentDampening * 0.9);
    } else {
      // Slowly recover dampening
      updates[AXIS_TO_DAMPENING[axisKey]] = Math.min(1.0, currentDampening * 1.02);
    }
  }
  
  await db.update(behaviorVectors)
    .set(updates)
    .where(eq(behaviorVectors.userId, userId));
  
  // Return updated vector
  return getUserBehaviorVector(userId) as Promise<PersonalityVector>;
}

// Batch update for multiple signals at once
export async function applyBehaviorSignals(
  userId: number,
  signals: { signal: BehaviorSignal; weight?: number }[],
  affinityMultiplier: number = 1.0
): Promise<PersonalityVector> {
  let vector: PersonalityVector | null = null;
  
  for (const { signal, weight = 1.0 } of signals) {
    vector = await updateBehaviorVector(userId, signal, affinityMultiplier * weight);
  }
  
  return vector ?? await getEffectivePersonality(userId);
}

// ============================================
// CHAT AFFINITY TRACKING (Phase 2.2)
// ============================================

export interface AffinityUpdate {
  affinityDelta: number;
  dimensionUpdates: Partial<{
    adversarialScore: number;
    friendlyScore: number;
    playfulScore: number;
    professionalScore: number;
  }>;
  memorableEvent?: string;
}

// Affinity scoring for different interaction types
const AFFINITY_SCORES = {
  message_sent: 1,              // Base affinity for any message
  compliment_given: 2,          // User said something nice
  advice_followed: 3,           // User acted on her suggestion
  trade_success_together: 5,    // Shared win
  trade_loss_together: -1,      // Shared loss (small penalty)
  warning_followed: 4,          // User heeded her warning
  warning_ignored: -2,          // User ignored warning (trust penalty)
  crab_joke_accepted: 2,        // User played along with crab mystery
  crab_insult: -3,              // User was mean about crab stuff
  pet_peeve_triggered: -1,      // User triggered annoyance
  secret_shared: 3,             // She revealed backstory
};

export async function updateChatAffinity(
  userId: number,
  interactionType: keyof typeof AFFINITY_SCORES,
  context?: string
): Promise<AffinityUpdate> {
  const now = Math.floor(Date.now() / 1000);
  const affinityDelta = AFFINITY_SCORES[interactionType];
  
  // Get current relationship
  let existing = await db.select().from(userRelationships)
    .where(eq(userRelationships.userId, userId))
    .limit(1);
  
  // Initialize relationship for new users
  if (existing.length === 0) {
    await db.insert(userRelationships).values({
      userId,
      affinityScore: 0,
      relationshipType: 'new',
      nicknameTier: 0,
      trustLevel: 0,
      sassLevel: 3,
      secretsShared: 0,
      totalInteractions: 0,
      crabMentions: 0,
      crabInsults: 0,
      complimentsGiven: 0,
      petPeevesTriggered: 0,
      tradesWonTogether: 0,
      tradesLostTogether: 0,
      warningsIgnored: 0,
      warningsFollowed: 0,
      lastInteraction: now,
      insideJokes: [],
      notes: [],
      memorableEvents: [],
      adversarialScore: 0,
      friendlyScore: 50,
      playfulScore: 50,
      professionalScore: 50,
      createdAt: now,
    });
    existing = await db.select().from(userRelationships)
      .where(eq(userRelationships.userId, userId))
      .limit(1);
  }
  
  const rel = existing[0];
  const currentAffinity = rel.affinityScore ?? 0;
  const newAffinity = Math.max(-100, Math.min(100, currentAffinity + affinityDelta));
  
  // Calculate dimension updates based on interaction type
  const dimensionUpdates: AffinityUpdate['dimensionUpdates'] = {};
  
  switch (interactionType) {
    case 'compliment_given':
    case 'trade_success_together':
      dimensionUpdates.friendlyScore = Math.min(100, (rel.friendlyScore ?? 50) + 2);
      break;
    case 'crab_joke_accepted':
      dimensionUpdates.playfulScore = Math.min(100, (rel.playfulScore ?? 50) + 3);
      break;
    case 'advice_followed':
    case 'warning_followed':
      dimensionUpdates.professionalScore = Math.min(100, (rel.professionalScore ?? 50) + 2);
      break;
    case 'crab_insult':
    case 'warning_ignored':
      dimensionUpdates.adversarialScore = Math.min(100, (rel.adversarialScore ?? 0) + 3);
      break;
    case 'pet_peeve_triggered':
      dimensionUpdates.adversarialScore = Math.min(100, (rel.adversarialScore ?? 0) + 1);
      break;
  }
  
  // Build update object
  const updates: Record<string, any> = {
    affinityScore: newAffinity,
    updatedAt: now,
    ...dimensionUpdates,
  };
  
  // Add memorable event if significant
  let memorableEvent: string | undefined;
  if (Math.abs(affinityDelta) >= 3 && context) {
    memorableEvent = `${new Date(now * 1000).toISOString().split('T')[0]}: ${context}`;
    const currentEvents = (rel.memorableEvents as string[]) ?? [];
    updates.memorableEvents = [...currentEvents.slice(-9), memorableEvent]; // Keep last 10
  }
  
  await db.update(userRelationships)
    .set(updates)
    .where(eq(userRelationships.userId, userId));
  
  return { affinityDelta, dimensionUpdates, memorableEvent };
}

// Get affinity multiplier for behavior updates (higher affinity = stronger learning)
export async function getAffinityMultiplier(userId: number): Promise<number> {
  const existing = await db.select().from(userRelationships)
    .where(eq(userRelationships.userId, userId))
    .limit(1);
  
  if (existing.length === 0) return 1.0;
  
  const affinity = existing[0].affinityScore ?? 0;
  // Map -100 to +100 affinity to 0.5 to 1.5 multiplier
  return 0.5 + ((affinity + 100) / 200);
}

// Detect relationship type changes based on dimension scores
export async function recalculateRelationshipType(userId: number): Promise<string> {
  const existing = await db.select().from(userRelationships)
    .where(eq(userRelationships.userId, userId))
    .limit(1);
  
  if (existing.length === 0) return 'new';
  
  const rel = existing[0];
  const adversarial = rel.adversarialScore ?? 0;
  const friendly = rel.friendlyScore ?? 50;
  const playful = rel.playfulScore ?? 50;
  const professional = rel.professionalScore ?? 50;
  
  // Determine dominant type
  let newType: string = rel.relationshipType ?? 'new';
  
  if (adversarial > 70 && adversarial > friendly) {
    newType = 'adversarial';
  } else if (playful > 70 && playful > professional) {
    newType = 'playful_banter';
  } else if (friendly > 70) {
    newType = 'friendly';
  } else if (professional > 60) {
    newType = 'professional';
  } else if ((rel.totalInteractions ?? 0) < 10) {
    newType = 'new';
  }
  
  // Update if changed
  if (newType !== rel.relationshipType) {
    await db.update(userRelationships)
      .set({ relationshipType: newType, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(userRelationships.userId, userId));
  }
  
  return newType;
}
