import { runWalletDiscoveryCycle } from "./wallet-discovery";
import { runWhaleReputationScan } from "./whale-reputation";
import { discoverSocialSourcesFromWinners } from "./social-discovery";
import { runDailyAggregation, runWeeklyReview } from "./timeframe-analysis";
import { runBestTheoryValidationCycle } from "./paper-experiments";

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
};

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
}> {
  console.log("[BackgroundJobs] Starting daily jobs...");
  
  const [dailyResult, socialResult] = await Promise.all([
    runJobWithTracking("dailyAggregation", runDailyAggregation),
    runJobWithTracking("socialDiscovery", () => discoverSocialSourcesFromWinners(72, 20)),
  ]);
  
  return {
    dailyAggregation: dailyResult,
    socialDiscovery: socialResult,
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
  
  hourlyInterval = null;
  dailyInterval = null;
  weeklyInterval = null;
  eightHourInterval = null;
  
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
    default:
      throw new Error(`Unknown job: ${jobName}`);
  }
}
