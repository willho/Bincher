import { db } from "./db";
import { 
  paperPositions, metaExperiments, vectorUpdates,
  PaperPosition
} from "@shared/schema";
import { eq, and, desc, gte } from "drizzle-orm";
import { openPaperPosition } from "./paper-trading";
import { getCurrentBucketId } from "./vector-aggregation";

export type PaperTradeType = "manual" | "experiment" | "best_theory";

interface ExperimentTrade {
  tokenMint: string;
  tokenSymbol?: string;
  entrySol: number;
  signalWallet?: string;
  takeProfitMultiplier?: number;
  stopLossPercent?: number;
}

export async function openExperimentTrade(
  userId: number,
  experimentId: string,
  trade: ExperimentTrade,
  isVariant: boolean = false
): Promise<PaperPosition> {
  const position = await openPaperPosition({
    userId,
    tokenMint: trade.tokenMint,
    tokenSymbol: trade.tokenSymbol,
    entrySol: trade.entrySol,
    signalWallet: trade.signalWallet,
    takeProfitMultiplier: trade.takeProfitMultiplier,
    stopLossPercent: trade.stopLossPercent,
  });
  
  const variantType = isVariant ? "variant" : "control";
  
  await db.update(paperPositions)
    .set({
      paperTradeType: "experiment",
      metaExperimentId: experimentId,
      experimentVariant: variantType,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(paperPositions.id, position.id));
  
  console.log(`[PaperExperiments] Opened experiment trade: ${position.id} for experiment ${experimentId} (${variantType})`);
  
  const [updated] = await db.select().from(paperPositions)
    .where(eq(paperPositions.id, position.id));
  
  return updated;
}

export async function openBestTheoryTrade(
  userId: number,
  theoryId: string,
  trade: ExperimentTrade
): Promise<PaperPosition> {
  const position = await openPaperPosition({
    userId,
    tokenMint: trade.tokenMint,
    tokenSymbol: trade.tokenSymbol,
    entrySol: trade.entrySol,
    signalWallet: trade.signalWallet,
    takeProfitMultiplier: trade.takeProfitMultiplier,
    stopLossPercent: trade.stopLossPercent,
  });
  
  await db.update(paperPositions)
    .set({
      paperTradeType: "best_theory",
      theoryId,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(paperPositions.id, position.id));
  
  console.log(`[PaperExperiments] Opened best_theory trade: ${position.id} for theory ${theoryId}`);
  
  const [updated] = await db.select().from(paperPositions)
    .where(eq(paperPositions.id, position.id));
  
  return updated;
}

export async function recordPaperTradeOutcome(position: PaperPosition): Promise<void> {
  if (position.status !== "closed" || position.realizedPnl === null) return;
  
  const bucketId = getCurrentBucketId();
  const now = Math.floor(Date.now() / 1000);
  const isWin = position.realizedPnl > 0;
  
  let signalType: string;
  switch (position.paperTradeType) {
    case "experiment":
      signalType = isWin ? "paper_experiment_win" : "paper_experiment_loss";
      break;
    case "best_theory":
      signalType = isWin ? "paper_best_theory_win" : "paper_best_theory_loss";
      break;
    default:
      signalType = isWin ? "paper_trade_win" : "paper_trade_loss";
  }
  
  await db.insert(vectorUpdates).values({
    vectorType: "strategy",
    targetId: position.signalWallet || `user_${position.userId}`,
    signalType,
    signalData: {
      positionId: position.id,
      tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol,
      pnlSol: position.realizedPnl,
      pnlPercent: position.realizedPnlPercent,
      paperTradeType: position.paperTradeType,
      experimentId: position.metaExperimentId,
      theoryId: position.theoryId,
      holdDuration: position.exitTimestamp && position.entryTimestamp 
        ? position.exitTimestamp - position.entryTimestamp 
        : null,
    },
    bucketId,
    processed: false,
    createdAt: now,
  });
  
  await db.insert(vectorUpdates).values({
    vectorType: "behavior",
    targetId: String(position.userId),
    signalType,
    signalData: {
      positionId: position.id,
      pnlSol: position.realizedPnl,
      paperTradeType: position.paperTradeType,
    },
    bucketId,
    processed: false,
    createdAt: now,
  });
  
  if (position.metaExperimentId) {
    await updateMetaExperimentFromPaperTrade(position);
  }
  
  console.log(`[PaperExperiments] Recorded outcome for position ${position.id}: ${signalType}`);
}

async function updateMetaExperimentFromPaperTrade(position: PaperPosition): Promise<void> {
  if (!position.metaExperimentId) return;
  
  const [experiment] = await db.select().from(metaExperiments)
    .where(eq(metaExperiments.experimentId, position.metaExperimentId));
  
  if (!experiment || experiment.status !== "active") return;
  
  const isWin = (position.realizedPnl || 0) > 0;
  const pnl = position.realizedPnl || 0;
  
  const isVariant = position.experimentVariant === "variant";
  
  if (isVariant) {
    const newTrades = (experiment.variantTrades || 0) + 1;
    const prevWins = Math.round((experiment.variantWinRate || 0) * (experiment.variantTrades || 0));
    const newWins = prevWins + (isWin ? 1 : 0);
    
    await db.update(metaExperiments)
      .set({
        variantTrades: newTrades,
        variantWinRate: newTrades > 0 ? newWins / newTrades : 0,
        variantPnl: (experiment.variantPnl || 0) + pnl,
      })
      .where(eq(metaExperiments.experimentId, position.metaExperimentId));
  } else {
    const newTrades = (experiment.controlTrades || 0) + 1;
    const prevWins = Math.round((experiment.controlWinRate || 0) * (experiment.controlTrades || 0));
    const newWins = prevWins + (isWin ? 1 : 0);
    
    await db.update(metaExperiments)
      .set({
        controlTrades: newTrades,
        controlWinRate: newTrades > 0 ? newWins / newTrades : 0,
        controlPnl: (experiment.controlPnl || 0) + pnl,
      })
      .where(eq(metaExperiments.experimentId, position.metaExperimentId));
  }
}

export interface BestTheory {
  id: string;
  name: string;
  config: Record<string, any>;
  winRate: number;
  avgPnlPercent: number;
  sampleSize: number;
  promotedAt: number;
  lastValidated: number;
  validationStreak: number;
}

export async function getActiveTheories(): Promise<BestTheory[]> {
  const promoted = await db.select().from(metaExperiments)
    .where(and(
      eq(metaExperiments.status, "completed"),
      eq(metaExperiments.winner, "variant")
    ))
    .orderBy(desc(metaExperiments.completedAt))
    .limit(10);
  
  return promoted.map(exp => ({
    id: exp.experimentId,
    name: exp.name || exp.experimentId,
    config: exp.promotedConfig as Record<string, any> || {},
    winRate: exp.variantWinRate || 0,
    avgPnlPercent: exp.variantPnl ? (exp.variantPnl / Math.max(1, exp.variantTrades || 1)) * 100 : 0,
    sampleSize: exp.variantTrades || 0,
    promotedAt: exp.completedAt || 0,
    lastValidated: exp.completedAt || 0,
    validationStreak: 0,
  }));
}

export async function getBestTheory(): Promise<BestTheory | null> {
  const theories = await getActiveTheories();
  if (theories.length === 0) return null;
  
  const sorted = theories.sort((a, b) => {
    const scoreA = a.winRate * 0.6 + (a.avgPnlPercent / 100) * 0.4;
    const scoreB = b.winRate * 0.6 + (b.avgPnlPercent / 100) * 0.4;
    return scoreB - scoreA;
  });
  
  return sorted[0];
}

export interface TheoryValidationResult {
  theoryId: string;
  isValid: boolean;
  recentWinRate: number;
  recentSampleSize: number;
  message: string;
}

export async function validateTheory(theoryId: string): Promise<TheoryValidationResult> {
  const now = Math.floor(Date.now() / 1000);
  const validationWindow = 7 * 24 * 3600;
  
  const recentPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.theoryId, theoryId),
      eq(paperPositions.status, "closed"),
      gte(paperPositions.exitTimestamp, now - validationWindow)
    ));
  
  if (recentPositions.length < 5) {
    return {
      theoryId,
      isValid: true,
      recentWinRate: 0,
      recentSampleSize: recentPositions.length,
      message: "Insufficient sample size for validation",
    };
  }
  
  const wins = recentPositions.filter(p => (p.realizedPnl || 0) > 0);
  const winRate = wins.length / recentPositions.length;
  
  const isValid = winRate >= 0.4;
  
  return {
    theoryId,
    isValid,
    recentWinRate: winRate,
    recentSampleSize: recentPositions.length,
    message: isValid 
      ? `Theory maintaining ${(winRate * 100).toFixed(1)}% win rate`
      : `Theory underperforming at ${(winRate * 100).toFixed(1)}% win rate`,
  };
}

export interface RealTradingGate {
  approved: boolean;
  reasons: string[];
  requiredPaperTrades: number;
  completedPaperTrades: number;
  requiredWinRate: number;
  currentWinRate: number;
  theoryValidation: TheoryValidationResult | null;
}

export async function checkRealTradingGate(
  userId: number,
  signalWallet?: string
): Promise<RealTradingGate> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 3600;
  
  const query = signalWallet
    ? and(
        eq(paperPositions.userId, userId),
        eq(paperPositions.signalWallet, signalWallet),
        eq(paperPositions.status, "closed"),
        gte(paperPositions.exitTimestamp, thirtyDaysAgo)
      )
    : and(
        eq(paperPositions.userId, userId),
        eq(paperPositions.status, "closed"),
        gte(paperPositions.exitTimestamp, thirtyDaysAgo)
      );
  
  const recentPaperTrades = await db.select().from(paperPositions).where(query);
  
  const wins = recentPaperTrades.filter(p => (p.realizedPnl || 0) > 0);
  const winRate = recentPaperTrades.length > 0 ? wins.length / recentPaperTrades.length : 0;
  
  const requiredPaperTrades = 10;
  const requiredWinRate = 0.45;
  
  const reasons: string[] = [];
  let approved = true;
  
  if (recentPaperTrades.length < requiredPaperTrades) {
    approved = false;
    reasons.push(`Need ${requiredPaperTrades - recentPaperTrades.length} more paper trades`);
  }
  
  if (recentPaperTrades.length >= 5 && winRate < requiredWinRate) {
    approved = false;
    reasons.push(`Win rate ${(winRate * 100).toFixed(1)}% below ${(requiredWinRate * 100)}% threshold`);
  }
  
  let theoryValidation: TheoryValidationResult | null = null;
  const bestTheory = await getBestTheory();
  
  if (bestTheory) {
    theoryValidation = await validateTheory(bestTheory.id);
    if (!theoryValidation.isValid) {
      approved = false;
      reasons.push(`Best theory failing validation: ${theoryValidation.message}`);
    }
  }
  
  if (approved && reasons.length === 0) {
    reasons.push("All validation gates passed");
  }
  
  return {
    approved,
    reasons,
    requiredPaperTrades,
    completedPaperTrades: recentPaperTrades.length,
    requiredWinRate,
    currentWinRate: winRate,
    theoryValidation,
  };
}

export async function runBestTheoryValidationCycle(): Promise<{
  theoriesChecked: number;
  theoriesPassing: number;
  theoriesFailing: number;
}> {
  const theories = await getActiveTheories();
  let passing = 0;
  let failing = 0;
  
  for (const theory of theories) {
    const validation = await validateTheory(theory.id);
    if (validation.isValid) {
      passing++;
    } else {
      failing++;
      console.log(`[PaperExperiments] Theory ${theory.id} failing: ${validation.message}`);
    }
  }
  
  return {
    theoriesChecked: theories.length,
    theoriesPassing: passing,
    theoriesFailing: failing,
  };
}

export async function getPaperExperimentStats(userId: number): Promise<{
  totalExperimentTrades: number;
  totalBestTheoryTrades: number;
  experimentWinRate: number;
  bestTheoryWinRate: number;
  activeExperiments: number;
  activeTheories: number;
  gateStatus: RealTradingGate;
}> {
  const experimentPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.userId, userId),
      eq(paperPositions.paperTradeType, "experiment"),
      eq(paperPositions.status, "closed")
    ));
  
  const bestTheoryPositions = await db.select().from(paperPositions)
    .where(and(
      eq(paperPositions.userId, userId),
      eq(paperPositions.paperTradeType, "best_theory"),
      eq(paperPositions.status, "closed")
    ));
  
  const experimentWins = experimentPositions.filter(p => (p.realizedPnl || 0) > 0);
  const theoryWins = bestTheoryPositions.filter(p => (p.realizedPnl || 0) > 0);
  
  const activeExperiments = await db.select().from(metaExperiments)
    .where(eq(metaExperiments.status, "active"));
  
  const theories = await getActiveTheories();
  const gateStatus = await checkRealTradingGate(userId);
  
  return {
    totalExperimentTrades: experimentPositions.length,
    totalBestTheoryTrades: bestTheoryPositions.length,
    experimentWinRate: experimentPositions.length > 0 
      ? experimentWins.length / experimentPositions.length 
      : 0,
    bestTheoryWinRate: bestTheoryPositions.length > 0 
      ? theoryWins.length / bestTheoryPositions.length 
      : 0,
    activeExperiments: activeExperiments.length,
    activeTheories: theories.length,
    gateStatus,
  };
}
