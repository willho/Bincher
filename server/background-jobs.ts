import { runWalletDiscoveryCycle } from "./wallet-discovery";
import { runWhaleReputationScan } from "./whale-reputation";
import { discoverSocialSourcesFromWinners } from "./social-discovery";
import { runDailyAggregation, runWeeklyReview } from "./timeframe-analysis";
import { runBestTheoryValidationCycle } from "./paper-experiments";
import { runFundingRelationshipDetection } from "./funding-relationship-detector";
import { mergeFundingLinksIntoClusters } from "./cluster-detection";
import { checkAndManageCapacity } from "./monitoring-capacity-manager";
import { db } from "./db";
import { monitoredWallets, userTokenViews } from "@shared/schema";
import { eq, and, lt } from "drizzle-orm";

interface JobStatus {
  lastRun: number | null;
  nextRun: number;
  isRunning: boolean;
  lastResult: any;
  errorCount: number;
  lastError: string | null;
}

const JOB_STATUS: Map<string, JobStatus> = new Map();

const JOB_INTERVALS = {
  walletDiscovery: 4 * 3600 * 1000,
  whaleReputation: 2 * 3600 * 1000,
  socialDiscovery: 6 * 3600 * 1000,
  dailyAggregation: 24 * 3600 * 1000,
  weeklyReview: 7 * 24 * 3600 * 1000,
  theoryValidation: 8 * 3600 * 1000,
  vectorAggregation: 8 * 3600 * 1000,
  fundingRelationshipDetection: 24 * 3600 * 1000, // Daily
  viewCleanup: 10 * 60 * 1000, // 10 minutes
  capacityManagement: 10 * 60 * 1000, // 10 minutes - monitor and manage monitoring capacity
};

// Cleanup constants
const TEMP_WALLET_TTL_MINUTES = 30;
const VIEW_SIGNAL_TTL_HOURS = 48;

/**
 * Clean up temporary wallets that haven't been viewed in 30 minutes
 */
export async function cleanupTemporaryWallets(): Promise<{ deleted: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - (TEMP_WALLET_TTL_MINUTES * 60);
  
  const result = await db.delete(monitoredWallets)
    .where(and(
      eq(monitoredWallets.temporary, true),
      lt(monitoredWallets.lastViewedAt, cutoff)
    ))
    .returning({ id: monitoredWallets.id });
  
  if (result.length > 0) {
    console.log(`[Cleanup] Removed ${result.length} stale temporary wallets`);
  }
  
  return { deleted: result.length };
}

/**
 * Clean up old token view records that have fully decayed (>48h)
 */
export async function cleanupOldTokenViews(): Promise<{ deleted: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - (VIEW_SIGNAL_TTL_HOURS * 3600);
  
  const result = await db.delete(userTokenViews)
    .where(lt(userTokenViews.viewedAt, cutoff))
    .returning({ id: userTokenViews.id });
  
  if (result.length > 0) {
    console.log(`[Cleanup] Removed ${result.length} old token view records`);
  }
  
  return { deleted: result.length };
}

/**
 * Run all view-related cleanup tasks
 */
export async function runViewCleanup(): Promise<{
  tempWallets: number;
  oldViews: number;
}> {
  const [walletResult, viewResult] = await Promise.all([
    cleanupTemporaryWallets(),
    cleanupOldTokenViews(),
  ]);
  
  return {
    tempWallets: walletResult.deleted,
    oldViews: viewResult.deleted,
  };
}

function initJobStatus(jobName: string, intervalMs: number): void {
  const now = Date.now();
  JOB_STATUS.set(jobName, {
    lastRun: null,
    nextRun: now + intervalMs,
    isRunning: false,
    lastResult: null,
    errorCount: 0,
    lastError: null,
  });
}

async function runJobWithTracking<T>(
  jobName: string,
  jobFn: () => Promise<T>
): Promise<T | null> {
  const status = JOB_STATUS.get(jobName);
  if (!status) return null;
  
  if (status.isRunning) {
    console.log(`[BackgroundJobs] ${jobName} already running, skipping`);
    return null;
  }
  
  status.isRunning = true;
  const startTime = Date.now();
  
  try {
    const result = await jobFn();
    status.lastRun = startTime;
    status.lastResult = result;
    status.errorCount = 0;
    status.lastError = null;
    console.log(`[BackgroundJobs] ${jobName} completed in ${Date.now() - startTime}ms`);
    return result;
  } catch (error: any) {
    status.errorCount++;
    status.lastError = error.message || String(error);
    console.error(`[BackgroundJobs] ${jobName} failed:`, error);
    return null;
  } finally {
    status.isRunning = false;
  }
}

export async function runHourlyJobs(): Promise<{
  walletDiscovery: any;
  whaleReputation: any;
}> {
  console.log("[BackgroundJobs] Starting hourly jobs...");
  
  const [walletResult, whaleResult] = await Promise.all([
    runJobWithTracking("walletDiscovery", runWalletDiscoveryCycle),
    runJobWithTracking("whaleReputation", () => runWhaleReputationScan(14)),
  ]);
  
  return {
    walletDiscovery: walletResult,
    whaleReputation: whaleResult,
  };
}

export async function runDailyJobs(): Promise<{
  dailyAggregation: any;
  socialDiscovery: any;
  fundingRelationshipDetection: any;
  fundingClusterMerge?: any;
}> {
  console.log("[BackgroundJobs] Starting daily jobs...");

  const [dailyResult, socialResult, fundingResult] = await Promise.all([
    runJobWithTracking("dailyAggregation", runDailyAggregation),
    runJobWithTracking("socialDiscovery", () => discoverSocialSourcesFromWinners(72, 20)),
    runJobWithTracking("fundingRelationshipDetection", runFundingRelationshipDetection),
  ]);

  // After funding detection, merge verified links into clusters
  const mergeResult = await runJobWithTracking("fundingClusterMerge", mergeFundingLinksIntoClusters);

  return {
    dailyAggregation: dailyResult,
    socialDiscovery: socialResult,
    fundingRelationshipDetection: fundingResult,
    fundingClusterMerge: mergeResult,
  };
}

export async function runWeeklyJobs(): Promise<{
  weeklyReview: any;
}> {
  console.log("[BackgroundJobs] Starting weekly jobs...");
  
  const weeklyResult = await runJobWithTracking("weeklyReview", runWeeklyReview);
  
  return {
    weeklyReview: weeklyResult,
  };
}

export async function run8HourJobs(): Promise<{
  theoryValidation: any;
}> {
  console.log("[BackgroundJobs] Starting 8-hour cycle jobs...");
  
  const theoryResult = await runJobWithTracking("theoryValidation", runBestTheoryValidationCycle);
  
  return {
    theoryValidation: theoryResult,
  };
}

let hourlyInterval: NodeJS.Timeout | null = null;
let dailyInterval: NodeJS.Timeout | null = null;
let weeklyInterval: NodeJS.Timeout | null = null;
let eightHourInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

export function startBackgroundJobs(): void {
  console.log("[BackgroundJobs] Initializing background job scheduler...");
  
  Object.entries(JOB_INTERVALS).forEach(([name, interval]) => {
    initJobStatus(name, interval);
  });
  
  hourlyInterval = setInterval(() => {
    runHourlyJobs().catch(console.error);
  }, 4 * 3600 * 1000);
  
  dailyInterval = setInterval(() => {
    runDailyJobs().catch(console.error);
  }, 24 * 3600 * 1000);
  
  weeklyInterval = setInterval(() => {
    runWeeklyJobs().catch(console.error);
  }, 7 * 24 * 3600 * 1000);
  
  eightHourInterval = setInterval(() => {
    run8HourJobs().catch(console.error);
  }, 8 * 3600 * 1000);
  
  // Cleanup and capacity check run every 10 minutes
  cleanupInterval = setInterval(async () => {
    try {
      await runJobWithTracking("viewCleanup", runViewCleanup);
      await runJobWithTracking("capacityManagement", () => checkAndManageCapacity());
    } catch (error) {
      console.error("[BackgroundJobs] Error in cleanup/capacity check:", error);
    }
  }, JOB_INTERVALS.viewCleanup);
  
  setTimeout(() => {
    runHourlyJobs().catch(console.error);
  }, 60 * 1000);
  
  console.log("[BackgroundJobs] Scheduler started");
}

export function stopBackgroundJobs(): void {
  if (hourlyInterval) clearInterval(hourlyInterval);
  if (dailyInterval) clearInterval(dailyInterval);
  if (weeklyInterval) clearInterval(weeklyInterval);
  if (eightHourInterval) clearInterval(eightHourInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  
  hourlyInterval = null;
  dailyInterval = null;
  weeklyInterval = null;
  eightHourInterval = null;
  cleanupInterval = null;
  
  console.log("[BackgroundJobs] Scheduler stopped");
}

export function getJobStatuses(): Record<string, JobStatus> {
  const result: Record<string, JobStatus> = {};
  JOB_STATUS.forEach((status, name) => {
    result[name] = { ...status };
  });
  return result;
}

export async function runJobManually(jobName: string): Promise<any> {
  switch (jobName) {
    case "walletDiscovery":
      return runJobWithTracking("walletDiscovery", runWalletDiscoveryCycle);
    case "whaleReputation":
      return runJobWithTracking("whaleReputation", () => runWhaleReputationScan(14));
    case "socialDiscovery":
      return runJobWithTracking("socialDiscovery", () => discoverSocialSourcesFromWinners(72, 20));
    case "dailyAggregation":
      return runJobWithTracking("dailyAggregation", runDailyAggregation);
    case "weeklyReview":
      return runJobWithTracking("weeklyReview", runWeeklyReview);
    case "theoryValidation":
      return runJobWithTracking("theoryValidation", runBestTheoryValidationCycle);
    case "fundingRelationshipDetection":
      return runJobWithTracking("fundingRelationshipDetection", runFundingRelationshipDetection);
    case "fundingClusterMerge":
      return runJobWithTracking("fundingClusterMerge", mergeFundingLinksIntoClusters);
    case "viewCleanup":
      return runJobWithTracking("viewCleanup", runViewCleanup);
    default:
      throw new Error(`Unknown job: ${jobName}`);
  }
}
