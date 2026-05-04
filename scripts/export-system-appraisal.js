#!/usr/bin/env node
/**
 * System Appraisal Data Export
 *
 * Usage: DATABASE_URL="postgres://..." node scripts/export-system-appraisal.js
 *
 * Pulls all learning data from database and outputs JSON for LLM analysis
 */

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function exportData() {
  try {
    const systemUserId = parseInt(process.env.SYSTEM_PICKS_USER_ID || "1", 10);

    console.error(`[Export] Querying system data for user ${systemUserId}...`);

    // ===== TOKEN LAUNCH METRICS =====
    const tokenLaunches = await pool.query(
      `SELECT hour, day_of_week, launch_count, matched_count,
              reached_2x_count, reached_5x_count, reached_10x_count, rug_count
       FROM token_launch_metrics
       WHERE user_id = $1
       ORDER BY day_of_week, hour`,
      [systemUserId]
    );

    // ===== CLUSTER LEARNINGS =====
    const clusterLearnings = await pool.query(
      `SELECT cluster_type, learned_tsl_percent, trajectory_threshold,
              ape_multiplier_learned, sample_count,
              recent_win_rate, recent_profit_factor, recent_avg_pnl_percent
       FROM cluster_learnings
       WHERE user_id = $1
       ORDER BY cluster_type`,
      [systemUserId]
    );

    // ===== POSITION BUDGETS =====
    const budgets = await pool.query(
      `SELECT expected_positions_per_day, base_allocation_per_position,
              ape_budget, last_calculated_at
       FROM position_budgets
       WHERE user_id = $1`,
      [systemUserId]
    );

    // ===== ACTIVE POSITIONS (for testing) =====
    const positions = await pool.query(
      `SELECT id, token_mint, token_symbol, entry_sol, entry_price,
              opened_at, closed_at, exit_reason,
              current_trajectory_score, tsl_current_percent
       FROM active_positions
       WHERE user_id = $1
       ORDER BY opened_at DESC`,
      [systemUserId]
    );

    // ===== SNAPSHOT STATS =====
    const snapshots = await pool.query(
      `SELECT COUNT(*) as total_snapshots,
              COUNT(CASE WHEN fingerprint_vector IS NOT NULL THEN 1 END) as with_fingerprints,
              COUNT(DISTINCT token_mint) as unique_tokens,
              MIN(captured_at) as earliest_snapshot,
              MAX(captured_at) as latest_snapshot
       FROM token_snapshots`
    );

    // ===== WARM-UP STATUS =====
    const warmup = await pool.query(
      `SELECT warmup_started_at, warmup_enabled_at, auto_trading_enabled
       FROM users
       WHERE id = $1`,
      [systemUserId]
    );

    // ===== SUBSCRIPTION TELEMETRY (if stored) =====
    let subscriptionData = { pump_fun: [], dex_paprika: [] };
    try {
      const subs = await pool.query(
        `SELECT source, active_subscriptions, max_capacity,
                utilization_percent, rotations_last_hour
         FROM server_subscriptions
         ORDER BY timestamp DESC
         LIMIT 100`
      );
      subscriptionData = subs.rows;
    } catch (e) {
      console.error("[Export] Subscription table not found, skipping");
    }

    // ===== COMPILE EXPORT =====
    const exportData = {
      meta: {
        exportedAt: new Date().toISOString(),
        systemUserId,
        environment: process.env.NODE_ENV || "unknown",
      },
      warmup: {
        started_at: warmup.rows[0]?.warmup_started_at,
        enabled_at: warmup.rows[0]?.warmup_enabled_at,
        auto_trading_enabled: warmup.rows[0]?.auto_trading_enabled,
        days_elapsed: warmup.rows[0]?.warmup_started_at
          ? Math.floor((Date.now() / 1000 - warmup.rows[0].warmup_started_at) / 86400)
          : 0,
      },
      discovery: {
        token_launch_metrics: tokenLaunches.rows,
        total_launches: tokenLaunches.rows.reduce((sum, row) => sum + (row.launch_count || 0), 0),
        total_matches: tokenLaunches.rows.reduce((sum, row) => sum + (row.matched_count || 0), 0),
        total_rugs: tokenLaunches.rows.reduce((sum, row) => sum + (row.rug_count || 0), 0),
      },
      learning: {
        cluster_learnings: clusterLearnings.rows,
        clusters_learned: clusterLearnings.rows.length,
        clusters_converged: clusterLearnings.rows.filter((c) => c.sample_count >= 15).length,
      },
      budget: {
        forecast: budgets.rows[0] || {},
      },
      snapshots: {
        stats: snapshots.rows[0],
        fingerprint_coverage_percent: snapshots.rows[0]
          ? Math.round((snapshots.rows[0].with_fingerprints / snapshots.rows[0].total_snapshots) * 100)
          : 0,
      },
      positions: {
        test_positions: positions.rows,
        total_opened: positions.rows.length,
        still_open: positions.rows.filter((p) => !p.closed_at).length,
        closed: positions.rows.filter((p) => p.closed_at).length,
      },
      subscriptions: subscriptionData,
    };

    // Output as JSON
    console.log(JSON.stringify(exportData, null, 2));
    await pool.end();
  } catch (error) {
    console.error("[Export] Error:", error.message);
    process.exit(1);
  }
}

exportData();
