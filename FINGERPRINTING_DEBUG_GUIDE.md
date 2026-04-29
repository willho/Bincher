# Fingerprinting & Clustering Diagnostic Endpoints

Complete API documentation for debugging token fingerprints, archetypes (strategy clusters), and the clustering pipeline.

## Overview

These endpoints provide insight into the entire fingerprinting and clustering pipeline:
- **Fingerprints**: Feature vectors captured at token snapshots
- **Archetypes**: Strategy clusters that group similar tokens
- **Outcomes**: Success/failure labels used for quality assessment

All endpoints return structured JSON with detailed metadata for inspection and debugging.

## Endpoints

### 1. GET /api/debug/fingerprints

Query token fingerprints with filtering and pagination.

**Query Parameters:**
- `tokenMint` (string): Exact match on token mint
- `tokenPattern` (string): Pattern matching (ILIKE)
- `status` (string): active, archived, deathbed
- `minSnapshots` (number): Filter by minimum snapshot count
- `hasOutcome` (boolean): Only tokens with recorded outcomes
- `limit` (number): Results per page, default 50, max 500
- `offset` (number): Pagination offset

**Examples:**

```bash
# Get active tokens with at least 5 snapshots
curl "http://localhost:3000/api/debug/fingerprints?status=active&minSnapshots=5&limit=20"

# Get specific token's fingerprints
curl "http://localhost:3000/api/debug/fingerprints?tokenMint=ABC123def456"

# Get tokens with outcomes (that we're learning from)
curl "http://localhost:3000/api/debug/fingerprints?hasOutcome=true&limit=100"
```

**Response:**

```json
{
  "success": true,
  "count": 3,
  "total": 8452,
  "limit": 20,
  "offset": 0,
  "fingerprints": [
    {
      "id": 1,
      "tokenMint": "ABC123...",
      "snapshotIndex": 0,
      "earlyDynamicsFeatures": {
        "dimensions": 50,
        "sample": {
          "priceVolatility": 0.45,
          "volumeAcceleration": 1.2,
          "whaleEntryCount": 3
        }
      },
      "milestones": ["2x"],
      "trajectory": "pump_100x",
      "archetypeId": "arch_42",
      "archetypeConfidence": 0.87,
      "createdAt": "2026-04-28T10:30:45.123Z"
    }
  ],
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

### 2. GET /api/debug/fingerprints/:tokenMint

Get detailed view of a specific token's entire fingerprinting journey.

**Parameters:**
- `tokenMint` (string, required): The token mint to inspect

**Example:**

```bash
curl "http://localhost:3000/api/debug/fingerprints/ABC123def456"
```

**Response:**

```json
{
  "success": true,
  "token": {
    "mint": "ABC123def456",
    "name": "SuperToken",
    "symbol": "SUPER",
    "isDeathbed": false,
    "status": "pre-grad"
  },
  "outcome": {
    "success": true,
    "multiplier": 45.2,
    "pnlPercent": 4420,
    "holdDurationSeconds": 3600
  },
  "fingerprintTimeline": {
    "totalSnapshots": 8,
    "snapshots": [
      {
        "snapshotIndex": 0,
        "featureDimensions": 50,
        "hasArchetype": true,
        "archetypeId": "arch_42",
        "archetypeConfidence": 0.87,
        "trajectory": "pump_100x",
        "milestones": ["2x", "10x"],
        "createdAt": "2026-04-28T10:30:45.123Z"
      },
      {
        "snapshotIndex": 1,
        "featureDimensions": 50,
        "hasArchetype": true,
        "archetypeId": "arch_42",
        "archetypeConfidence": 0.91,
        "trajectory": "pump_100x",
        "milestones": ["2x", "10x", "100x"],
        "createdAt": "2026-04-28T11:45:22.456Z"
      }
    ]
  },
  "archetypeAssignments": {
    "firstAssignment": "arch_42",
    "lastAssignment": "arch_42",
    "assignmentHistory": [
      {
        "snapshotIndex": 0,
        "archetypeId": "arch_42",
        "confidence": 0.87
      },
      {
        "snapshotIndex": 1,
        "archetypeId": "arch_42",
        "confidence": 0.91
      }
    ]
  },
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Insights:**
- **What changed**: Confidence increased from 0.87 to 0.91 (better match)
- **Archetype consistency**: Same archetype assigned throughout (good signal)
- **Outcome validation**: Success=true confirms this archetype is predictive

### 3. GET /api/debug/archetypes

List all archetypes (strategy clusters) with statistics.

**Query Parameters:**
- `limit` (number): Results per page, default 50, max 500
- `offset` (number): Pagination offset
- `minMembers` (number): Only clusters with N+ members

**Examples:**

```bash
# Get all archetypes with at least 10 members
curl "http://localhost:3000/api/debug/archetypes?minMembers=10&limit=20"

# Get largest archetypes (most members)
curl "http://localhost:3000/api/debug/archetypes?minMembers=50"

# Get all archetypes (including singleton clusters)
curl "http://localhost:3000/api/debug/archetypes?limit=500"
```

**Response:**

```json
{
  "success": true,
  "count": 42,
  "limit": 20,
  "offset": 0,
  "archetypes": [
    {
      "id": "arch_42",
      "name": "Early Whale Entry Pattern",
      "description": "Tokens with coordinated whale entries in first 5min",
      "memberCount": 127,
      "centerDimensions": 50,
      "radiusThreshold": 0.35,
      "createdAt": "2026-03-15T08:00:00.000Z",
      "updatedAt": "2026-04-28T12:30:00.000Z",
      "sampleMembers": [
        {
          "tokenMint": "ABC123...",
          "confidence": 0.95
        },
        {
          "tokenMint": "DEF456...",
          "confidence": 0.88
        }
      ]
    },
    {
      "id": "arch_51",
      "name": "Slow Bleed Pattern",
      "description": "High initial volume but declining holder interest",
      "memberCount": 43,
      "centerDimensions": 50,
      "radiusThreshold": 0.42,
      "createdAt": "2026-03-20T09:15:00.000Z",
      "updatedAt": "2026-04-27T18:45:00.000Z",
      "sampleMembers": [
        {
          "tokenMint": "GHI789...",
          "confidence": 0.82
        }
      ]
    }
  ],
  "statistics": {
    "totalArchetypes": 42,
    "averageMembersPerArchetype": "32.5",
    "largestArchetype": {
      "id": "arch_42",
      "name": "Early Whale Entry Pattern",
      "memberCount": 127
    }
  },
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Insights:**
- **Archetype 42** is most common (127 members) - strong pattern
- **Average size** of 32.5 suggests good distribution
- **Sample members** help validate archetype definition

### 4. GET /api/debug/archetypes/:archetypeId

Deep dive into a specific archetype and its members.

**Parameters:**
- `archetypeId` (string, required): The archetype to inspect

**Example:**

```bash
curl "http://localhost:3000/api/debug/archetypes/arch_42"
```

**Response:**

```json
{
  "success": true,
  "archetype": {
    "id": "arch_42",
    "name": "Early Whale Entry Pattern",
    "description": "Tokens with coordinated whale entries in first 5min",
    "centerDimensions": 50,
    "radiusThreshold": 0.35,
    "createdAt": "2026-03-15T08:00:00.000Z",
    "updatedAt": "2026-04-28T12:30:00.000Z"
  },
  "members": {
    "total": 127,
    "list": [
      {
        "tokenMint": "ABC123...",
        "confidence": 0.95,
        "snapshotIndex": 0,
        "trajectory": "pump_100x",
        "outcome": {
          "success": true,
          "multiplier": 45.2,
          "pnlPercent": 4420
        }
      },
      {
        "tokenMint": "DEF456...",
        "confidence": 0.88,
        "snapshotIndex": 1,
        "trajectory": "pump_1000x",
        "outcome": {
          "success": true,
          "multiplier": 523.1,
          "pnlPercent": 52210
        }
      },
      {
        "tokenMint": "JKL012...",
        "confidence": 0.72,
        "snapshotIndex": 0,
        "trajectory": "crash_fast",
        "outcome": {
          "success": false,
          "multiplier": 0.2,
          "pnlPercent": -80
        }
      }
    ]
  },
  "clusterQuality": {
    "memberCount": 127,
    "outcomeDataPoints": 89,
    "successRate": "78.7%",
    "averageMultiplier": "52.3",
    "successfulMembers": 70,
    "failedMembers": 19
  },
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Insights:**
- **78.7% success rate** - This archetype is highly predictive!
- **Average 52.3x multiplier** on successful trades
- **70 successful out of 89** tokens with outcomes
- **Confidence spread** (0.72-0.95) shows some variation but still successful
- **Mixed trajectories** (pump_100x, pump_1000x, crash_fast) - shape evolves

### 5. GET /api/debug/clustering-stats

Overall clustering pipeline statistics and health metrics.

**Example:**

```bash
curl "http://localhost:3000/api/debug/clustering-stats"
```

**Response:**

```json
{
  "success": true,
  "overview": {
    "totalFingerprints": 8452,
    "totalArchetypes": 42,
    "clusteredFingerprints": 6234,
    "unclusteredFingerprints": 2218,
    "clusteringCoverage": "73.8%"
  },
  "clusterSizeDistribution": {
    "totalArchetypes": 42,
    "averageMembersPerArchetype": "32.5",
    "minClusterSize": 1,
    "maxClusterSize": 127,
    "distribution": {
      "singleton": 3,
      "small": 12,
      "medium": 18,
      "large": 9
    }
  },
  "problemAreas": {
    "unclusteredTokens": 2218,
    "singletonClusters": 3,
    "largestCluster": 127
  },
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Insights:**
- **73.8% coverage** - Good clustering, but 26% need assignment
- **Unclustereded fingerprints** likely from: recent tokens, outliers, or insufficient similarity
- **Singleton clusters** (3 archetypes with 1 member each) - consider merging
- **Distribution is healthy**: More medium-sized than tiny clusters

### 6. GET /api/debug/fingerprint-features/:tokenMint

Get the raw feature vectors for a token's fingerprints.

**Parameters:**
- `tokenMint` (string, required): The token to inspect

**Example:**

```bash
curl "http://localhost:3000/api/debug/fingerprint-features/ABC123def456"
```

**Response:**

```json
{
  "success": true,
  "tokenMint": "ABC123def456",
  "fingerprints": [
    {
      "snapshotIndex": 0,
      "createdAt": "2026-04-28T10:30:45.123Z",
      "featureCount": 50,
      "features": {
        "priceOpen": 0.000001,
        "priceHigh": 0.000045,
        "priceLow": 0.000001,
        "priceClose": 0.000035,
        "volumeTotal": 450000,
        "volatility": 0.45,
        "priceSlope": 0.82,
        "volumeAcceleration": 1.2,
        "volumeInFirstMin": 50000,
        "volumeInFirst5Min": 150000,
        "whaleEntryCount": 3,
        "whaleEntryTiming": 45,
        "whaleClusteringScore": 0.92,
        "holderCount": 250,
        "holderConcentration": 0.35,
        "uniqueBuyerCount": 180,
        "buyerDiversityScore": 0.88,
        "clusterActivityCount": 5,
        "clusterActivityTiming": 22,
        "clusterCoordinationScore": 0.78
      },
      "trajectory": "pump_100x",
      "archetypeId": "arch_42",
      "archetypeConfidence": 0.87
    },
    {
      "snapshotIndex": 1,
      "createdAt": "2026-04-28T11:45:22.456Z",
      "featureCount": 50,
      "features": {
        "priceOpen": 0.000035,
        "priceHigh": 0.000150,
        "priceLow": 0.000030,
        "priceClose": 0.000120,
        "volumeTotal": 1200000,
        "volatility": 0.52,
        "priceSlope": 0.95,
        "volumeAcceleration": 1.5,
        "volumeInFirstMin": 80000,
        "volumeInFirst5Min": 400000
      },
      "trajectory": "pump_100x",
      "archetypeId": "arch_42",
      "archetypeConfidence": 0.91
    }
  ],
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Insights:**
- **Price progression**: 0.000001 → 0.000035 → 0.000120 (good momentum)
- **Volume increase**: 450K → 1.2M (acceleration confirms momentum)
- **Feature stability**: Most features follow consistent pattern
- **Archetype confidence increases**: 0.87 → 0.91 (stronger match over time)

### 7. GET /api/debug/fingerprinting-health

Overall fingerprinting pipeline health and operational status.

**Example:**

```bash
curl "http://localhost:3000/api/debug/fingerprinting-health"
```

**Response:**

```json
{
  "success": true,
  "health": {
    "status": "operational",
    "issues": []
  },
  "tokenMetrics": {
    "activeTokens": 234,
    "deathbedTokens": 156,
    "tokensWithFingerprints": 89,
    "averageFingerprintsPerToken": "95.1"
  },
  "fingerprintingMetrics": {
    "totalFingerprints": 8452,
    "withArchetype": 6234,
    "withoutArchetype": 2218,
    "archetypeAssignmentRate": "73.8%"
  },
  "recommendations": [],
  "timestamp": "2026-04-28T15:22:10.456Z"
}
```

**Health Status Values:**
- **operational**: All systems working, >50% archetype assignment
- **degraded**: Issues detected (low assignment rate, missing tokens)
- **critical**: Major problems (no fingerprints, no archetype assignments)

**Recommendations** (shown only if issues detected):
- "Run snapshots and fingerprinting on active tokens"
- "Run clustering algorithm to assign more fingerprints"
- "Monitor new tokens to generate fingerprints"

## Common Debugging Workflows

### Workflow 1: Validate a Token's Fingerprinting

```bash
# Get token details
curl "http://localhost:3000/api/debug/fingerprints/ABC123"

# Check if it has outcome (success/failure ground truth)
# Look for: outcome.success, outcome.multiplier

# Get detailed features
curl "http://localhost:3000/api/debug/fingerprint-features/ABC123"

# Check if archetype is consistent across snapshots
# If archetypeId changes: fingerprinting unstable
# If archetypeConfidence increases: good learning signal
```

### Workflow 2: Evaluate Archetype Quality

```bash
# List all archetypes
curl "http://localhost:3000/api/debug/archetypes?minMembers=10"

# Pick top archetype by member count
# Get detailed member outcomes
curl "http://localhost:3000/api/debug/archetypes/arch_42"

# Check successRate and averageMultiplier
# If >60% success rate: archetype is predictive
# If <40% success rate: archetype needs refinement
```

### Workflow 3: Find Clustering Issues

```bash
# Get overall stats
curl "http://localhost:3000/api/debug/clustering-stats"

# Check clustering coverage percentage
# If <50%: many unclusteredFingerprints (run clustering)
# If >80%: good coverage, archetype assignments stable

# Check for singleton clusters
# If many singletons: consider merging similar archetypes
```

### Workflow 4: Debug a Failed Token

```bash
# Get token's fingerprints
curl "http://localhost:3000/api/debug/fingerprints/FAILED_MINT"

# Look for:
# - outcome.success: false
# - trajectory: crash_fast or slow_bleed
# - archetypeId: NULL or low confidence

# Get raw features to understand why it failed
curl "http://localhost:3000/api/debug/fingerprint-features/FAILED_MINT"

# Check if archetype itself is failing
curl "http://localhost:3000/api/debug/archetypes/arch_XX"
# Look at successRate and failed members
```

## Integration with Retrolearner

These endpoints are useful for monitoring retrolearner effectiveness:

```bash
# After retrolearner cycle runs:
1. Check health: GET /api/debug/fingerprinting-health
2. Verify archetype updates: GET /api/debug/clustering-stats
3. Validate new assignments: GET /api/debug/archetypes?limit=5
4. Check outcome quality: GET /api/debug/archetypes/arch_42
```

## Performance Notes

- **Large archetype queries** (many members) may be slow - use `minMembers` filter
- **Feature queries** return full JSON vectors - limit token queries to a few at a time
- **All queries are read-only** - safe to run in production

## Error Handling

All endpoints return 404 if resource not found:

```json
{
  "error": "Token not found" | "Archetype not found" | "No fingerprints found"
}
```

And 500 for database errors:

```json
{
  "error": "Failed to query fingerprints",
  "details": "connection timeout"
}
```
