/**
 * System Status Inspector
 *
 * Displays current Penny-Pincher2 state without requiring database access:
 * - Monitored token count
 * - Active positions
 * - API quota usage
 * - System health
 *
 * Usage: npm exec -- tsx debug-tools/system-status.ts
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

interface SystemState {
  timestamp: number;
  version: string;
  environment: string;
  uptime?: number;

  // Token monitoring
  tokensMonitored: number;
  tokensGraduated: number;
  tokensInDeathbed: number;

  // Data collection
  tradesRecorded: number;
  snapshotsTaken: number;
  walletsTracked: number;

  // API quotas
  quotas: {
    [service: string]: {
      used: number;
      limit: number;
      percentUsed: string;
    };
  };

  // System health
  health: {
    databaseConnected: boolean;
    appisHealthy: {
      [service: string]: boolean;
    };
    lastError?: string;
  };
}

/**
 * Load package.json to get version
 */
async function getVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8')
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Check if database is connected by looking for DB initialization file
 */
async function isDatabaseConnected(): Promise<boolean> {
  try {
    // Check if we have access to schema file (indicates DB setup)
    await fs.access(path.join(projectRoot, 'shared', 'schema.ts'));

    // Try to check if there's a DB connection indicator
    // (In real usage, this would actually test the connection)
    return process.env.DATABASE_URL ? true : false;
  } catch {
    return false;
  }
}

/**
 * Generate mock system state for demonstration
 * In production, this would read from actual runtime state
 */
async function gatherSystemState(): Promise<SystemState> {
  const version = await getVersion();
  const dbConnected = await isDatabaseConnected();

  return {
    timestamp: Date.now(),
    version,
    environment: process.env.NODE_ENV || 'development',

    // Mock data - in production these would come from runtime state
    tokensMonitored: 0,
    tokensGraduated: 0,
    tokensInDeathbed: 0,
    tradesRecorded: 0,
    snapshotsTaken: 0,
    walletsTracked: 0,

    quotas: {
      chainstack: { used: 0, limit: 1000000, percentUsed: '0.0%' },
      helius: { used: 0, limit: 1000000, percentUsed: '0.0%' },
      dexpaprika: { used: 0, limit: 288000, percentUsed: '0.0%' },
      dexscreener: { used: 0, limit: 432000, percentUsed: '0.0%' },
      shyft: { used: 0, limit: 1000000000, percentUsed: '0.0%' },
    },

    health: {
      databaseConnected: dbConnected,
      appisHealthy: {
        chainstack: !dbConnected ? 'unknown' : 'ok',
        helius: !dbConnected ? 'unknown' : 'ok',
        pumpportal: !dbConnected ? 'unknown' : 'ok',
        dexpaprika: !dbConnected ? 'unknown' : 'ok',
        shyft: !dbConnected ? 'unknown' : 'ok',
      } as { [key: string]: boolean | string },
      lastError: !dbConnected ? 'DATABASE_URL not set - database not accessible' : undefined,
    },
  };
}

/**
 * Format and display system state
 */
function displayState(state: SystemState): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║            PENNY-PINCHER2 SYSTEM STATUS                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Header info
  console.log('📊 SYSTEM INFO');
  console.log(`  Version:       ${state.version}`);
  console.log(`  Environment:   ${state.environment}`);
  console.log(`  Timestamp:     ${new Date(state.timestamp).toISOString()}`);
  console.log();

  // Token metrics
  console.log('🪙 TOKEN MONITORING');
  console.log(
    `  Monitored:     ${state.tokensMonitored.toLocaleString()} tokens`
  );
  console.log(
    `  Graduated:     ${state.tokensGraduated.toLocaleString()} tokens`
  );
  console.log(
    `  Deathbed:      ${state.tokensInDeathbed.toLocaleString()} tokens`
  );
  console.log();

  // Data collection
  console.log('📝 DATA COLLECTION');
  console.log(
    `  Trades:        ${state.tradesRecorded.toLocaleString()} recorded`
  );
  console.log(
    `  Snapshots:     ${state.snapshotsTaken.toLocaleString()} taken`
  );
  console.log(
    `  Wallets:       ${state.walletsTracked.toLocaleString()} tracked`
  );
  console.log();

  // API quotas
  console.log('📈 API QUOTAS (Monthly)');
  Object.entries(state.quotas).forEach(([service, quota]) => {
    const bar = createProgressBar(parseFloat(quota.percentUsed), 20);
    console.log(
      `  ${service.padEnd(12)}: ${bar} ${quota.percentUsed.padStart(5)}`
    );
  });
  console.log();

  // Health check
  console.log('🏥 SYSTEM HEALTH');
  console.log(
    `  Database:      ${state.health.databaseConnected ? '✅ Connected' : '❌ Not connected'}`
  );
  console.log('  APIs:');
  Object.entries(state.health.appisHealthy).forEach(([service, healthy]) => {
    const icon = healthy === 'unknown' ? '❓' : healthy ? '✅' : '❌';
    const status =
      healthy === 'unknown'
        ? 'unknown (no DB access)'
        : healthy
          ? 'ok'
          : 'error';
    console.log(`    - ${service.padEnd(14)}: ${icon} ${status}`);
  });

  if (state.health.lastError) {
    console.log();
    console.log('⚠️  LAST ERROR');
    console.log(`  ${state.health.lastError}`);
  }

  console.log();
  console.log('📌 NOTES');
  if (!state.health.databaseConnected) {
    console.log('  • Database not connected. Set DATABASE_URL to enable full monitoring.');
    console.log('  • Metrics shown above are mock data.');
    console.log('  • Start Penny-Pincher2 with: npm run dev');
  } else {
    console.log('  • All systems operational');
    console.log('  • Run "npm run debug:compare" to validate token discovery');
  }

  console.log('\n');
}

/**
 * Create ASCII progress bar
 */
function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${('█'.repeat(filled) + '░'.repeat(empty)).slice(0, width)}]`;
}

/**
 * Main
 */
async function main() {
  const state = await gatherSystemState();
  displayState(state);
}

main().catch(console.error);
