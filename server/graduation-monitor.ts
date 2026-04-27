/**
 * Graduation Monitor
 * Periodically checks bonding curve progress for pump.fun tokens
 * Detects and handles graduations in real-time
 */

import { checkBondingCurveProgress } from "./discovery-engine";

const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
let isRunning = false;

/**
 * Start the graduation progress monitor
 */
export async function startGraduationMonitor(): Promise<void> {
  if (isRunning) {
    console.warn("[GraduationMonitor] Already running");
    return;
  }

  isRunning = true;
  console.log("[GraduationMonitor] Started (checking every 10 seconds)");

  // Run checks periodically
  setInterval(async () => {
    try {
      const result = await checkBondingCurveProgress();

      if (result.graduations > 0) {
        console.log(
          `[GraduationMonitor] ✓ Detected ${result.graduations} graduation(s) (checked ${result.checked} tokens)`
        );
      }
    } catch (error) {
      console.error(
        "[GraduationMonitor] Error during progress check:",
        error instanceof Error ? error.message : error
      );
    }
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the graduation monitor
 */
export function stopGraduationMonitor(): void {
  isRunning = false;
  console.log("[GraduationMonitor] Stopped");
}
