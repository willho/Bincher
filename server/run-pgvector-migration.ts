/**
 * pgvector Migration Runner
 *
 * Enables pgvector extension and creates HNSW indexes for fast vector similarity search
 * Run this after deploying schema changes that use vector types
 *
 * Usage:
 *   - Call setupPgvector() on application startup
 *   - Or run manually: ts-node server/run-pgvector-migration.ts
 */

import { db } from "./db";
import { sql } from "drizzle-orm";

// =====================
// MIGRATION EXECUTION
// =====================

export async function setupPgvector(): Promise<void> {
  console.log("[PgvectorMigration] Starting pgvector setup...");

  try {
    // Step 1: Enable pgvector extension
    console.log("[PgvectorMigration] Enabling pgvector extension...");
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log("[PgvectorMigration] ✓ pgvector extension enabled");

    // Step 2: Create HNSW index on token_fingerprint_clusters.centroid
    console.log("[PgvectorMigration] Creating HNSW index on token_fingerprint_clusters.centroid...");
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_token_fingerprint_clusters_centroid_hnsw
      ON token_fingerprint_clusters
      USING hnsw (centroid vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
    `);
    console.log("[PgvectorMigration] ✓ HNSW index created on token_fingerprint_clusters");

    // Step 3: Create HNSW index on active_token_trajectories.fingerprint_vector
    console.log("[PgvectorMigration] Creating HNSW index on active_token_trajectories.fingerprint_vector...");
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_active_token_trajectories_fingerprint_vector_hnsw
      ON active_token_trajectories
      USING hnsw (fingerprint_vector vector_cosine_ops)
      WITH (m = 16, ef_construction = 200)
    `);
    console.log("[PgvectorMigration] ✓ HNSW index created on active_token_trajectories");

    // Step 4: Verify indexes were created
    const indexes = await db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%hnsw%'
    `);

    console.log(`[PgvectorMigration] ✓ Verified ${indexes.length} HNSW indexes in database`);
    console.log("[PgvectorMigration] pgvector setup complete!");
  } catch (error) {
    console.error("[PgvectorMigration] Error during setup:", error);

    // Provide helpful troubleshooting
    if (error instanceof Error) {
      if (error.message.includes("permission denied")) {
        console.error("[PgvectorMigration] Database user lacks permission to create extension");
        console.error("[PgvectorMigration] Solution: Run as superuser or grant CREATE privilege");
      } else if (error.message.includes("already exists")) {
        console.warn("[PgvectorMigration] Indexes already exist, skipping...");
      } else {
        console.error("[PgvectorMigration] Check database connection and permissions");
      }
    }

    throw error;
  }
}

// =====================
// VERIFICATION FUNCTIONS
// =====================

export async function checkPgvectorStatus(): Promise<{
  extensionExists: boolean;
  centroidIndexExists: boolean;
  fingerprintIndexExists: boolean;
  readyForProduction: boolean;
}> {
  try {
    // Check pgvector extension
    const extensions = await db.execute(sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `);
    const extensionExists = extensions.length > 0;

    // Check indexes
    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
      AND (indexname = 'idx_token_fingerprint_clusters_centroid_hnsw'
           OR indexname = 'idx_active_token_trajectories_fingerprint_vector_hnsw')
    `);

    const centroidIndexExists = indexes.some((idx: any) =>
      idx.indexname === "idx_token_fingerprint_clusters_centroid_hnsw"
    );
    const fingerprintIndexExists = indexes.some((idx: any) =>
      idx.indexname === "idx_active_token_trajectories_fingerprint_vector_hnsw"
    );

    const readyForProduction = extensionExists && centroidIndexExists && fingerprintIndexExists;

    return {
      extensionExists,
      centroidIndexExists,
      fingerprintIndexExists,
      readyForProduction,
    };
  } catch (error) {
    console.error("[PgvectorMigration] Error checking status:", error);
    return {
      extensionExists: false,
      centroidIndexExists: false,
      fingerprintIndexExists: false,
      readyForProduction: false,
    };
  }
}

export async function printMigrationStatus(): Promise<void> {
  const status = await checkPgvectorStatus();

  console.log("[PgvectorMigration] Status Report:");
  console.log(`  pgvector extension: ${status.extensionExists ? "✓" : "✗"}`);
  console.log(`  centroid HNSW index: ${status.centroidIndexExists ? "✓" : "✗"}`);
  console.log(`  fingerprint HNSW index: ${status.fingerprintIndexExists ? "✓" : "✗"}`);
  console.log(`  Ready for production: ${status.readyForProduction ? "✓ YES" : "✗ NO"}`);

  if (!status.readyForProduction) {
    console.log("[PgvectorMigration] Run setupPgvector() to complete migration");
  }
}

// =====================
// CLI EXECUTION
// =====================

// Allow running as CLI: ts-node server/run-pgvector-migration.ts
if (require.main === module) {
  (async () => {
    try {
      console.log("[PgvectorMigration] CLI Mode: Running pgvector setup...");
      await setupPgvector();
      console.log("[PgvectorMigration] Done!");
      process.exit(0);
    } catch (error) {
      console.error("[PgvectorMigration] Migration failed:", error);
      process.exit(1);
    }
  })();
}
