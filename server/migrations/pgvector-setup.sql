-- =====================
-- pgvector Extension Setup
-- =====================
-- This migration enables pgvector and creates HNSW indexes for fast vector similarity search
-- Run this after deploying schema changes to use vector types

-- Step 1: Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create HNSW index on token_fingerprint_clusters.centroid
-- This enables fast approximate nearest-neighbor search using cosine distance
-- Used by: matchToArchetypes() in fingerprint-matching.ts
-- Query pattern: SELECT ... WHERE centroid <-> query_vector < threshold ORDER BY centroid <-> query_vector LIMIT n
CREATE INDEX IF NOT EXISTS idx_token_fingerprint_clusters_centroid_hnsw
ON token_fingerprint_clusters
USING hnsw (centroid vector_cosine_ops)
WITH (m = 16, ef_construction = 200);

-- Step 3: Create HNSW index on active_token_trajectories.fingerprint_vector
-- This enables fast matching of token fingerprints to previous trajectory patterns
-- Used by: matchToTrajectories() in fingerprint-matching.ts
CREATE INDEX IF NOT EXISTS idx_active_token_trajectories_fingerprint_vector_hnsw
ON active_token_trajectories
USING hnsw (fingerprint_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 200);

-- Step 4: Verify indexes created
-- Run this query to confirm HNSW indexes are in place:
-- SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%hnsw%';

-- =====================
-- Performance Notes
-- =====================
-- HNSW Parameters:
-- - m: 16 (number of bidirectional links created per node; higher = more connections, slower build, faster search)
-- - ef_construction: 200 (size of dynamic list; higher = more accurate, slower build)
--
-- These settings optimize for:
-- - Fast query time (<1ms per search)
-- - Reasonable build time (tens of seconds for 1000s of vectors)
-- - Good accuracy (finding true nearest neighbor most of the time)
--
-- If you experience:
-- - Slow queries: increase m or ef_construction, or check query plan with EXPLAIN ANALYZE
-- - Slow index building: decrease m or ef_construction
-- - Index too large: decrease m (trades query speed for smaller index)

-- =====================
-- Testing Vector Queries
-- =====================
-- After indexes are created, test with:
--
-- 1. Find nearest archetype to a test vector:
--    SELECT id, cluster_id, centroid <-> '[0.1, 0.2, ...]'::vector as distance
--    FROM token_fingerprint_clusters
--    ORDER BY centroid <-> '[0.1, 0.2, ...]'::vector
--    LIMIT 5;
--
-- 2. Find all archetypes within distance 0.5 (cosine distance):
--    SELECT id, cluster_id, centroid <-> '[0.1, 0.2, ...]'::vector as distance
--    FROM token_fingerprint_clusters
--    WHERE centroid <-> '[0.1, 0.2, ...]'::vector < 0.5
--    ORDER BY centroid <-> '[0.1, 0.2, ...]'::vector;
--
-- 3. Verify index is being used (should see "Index Only Scan" or "Bitmap Index Scan"):
--    EXPLAIN ANALYZE
--    SELECT id, cluster_id FROM token_fingerprint_clusters
--    ORDER BY centroid <-> '[0.1, 0.2, ...]'::vector LIMIT 5;
