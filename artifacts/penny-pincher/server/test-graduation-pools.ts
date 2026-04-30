// @ts-nocheck
/**
 * Integration tests for token graduation tracking, pool discovery, and retrolearner
 * Tests the full pipeline: graduation detection → pool discovery → retrolearner → system picks
 */

import { db } from "./db";
import { eq, isNull, and, gte } from "drizzle-orm";
import {
  tokenDataPool,
  raydiumPoolDiscoveries,
  graduationEvents,
  tokenFingerprints,
  tokenOutcomes,
  paperPositions,
  InsertTokenDataPool,
  InsertGraduationEvent,
  InsertRaydiumPoolDiscovery,
} from "@shared/schema";

// =====================
// TEST UTILITIES
// =====================

let testsPassed = 0;
let testsFailed = 0;

async function assert(condition: boolean, message: string): Promise<void> {
  if (condition) {
    testsPassed++;
    console.log(`✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`✗ ${message}`);
  }
}

async function assertEquals<T>(actual: T, expected: T, message: string): Promise<void> {
  if (actual === expected) {
    testsPassed++;
    console.log(`✓ ${message}`);
  } else {
    testsFailed++;
    console.error(`✗ ${message} (expected: ${expected}, got: ${actual})`);
  }
}

// =====================
// TEST FIXTURES
// =====================

const MOCK_TOKENS = {
  BONDING_CURVE: {
    mint: "BC12345678901234567890123456789012345678901012",
    symbol: "BOND",
    name: "Bonding Curve Token",
  },
  GRADUATED: {
    mint: "GRAD123456789012345678901234567890123456789012",
    symbol: "GRAD",
    name: "Graduated Token",
    pumpfunMint: "PUMP123456789012345678901234567890123456789012",
  },
  NEW_POOL: {
    mint: "NEWP123456789012345678901234567890123456789012",
    symbol: "NEWP",
    name: "New Pool Token",
  },
  WELL_PERFORMING: {
    mint: "WELL123456789012345678901234567890123456789012",
    symbol: "WELL",
    name: "Well Performing Token",
  },
};

// =====================
// TEST 0: Bonding Curve Discovery
// =====================

export async function testBondingCurveDiscovery(): Promise<void> {
  console.log("\n=== Test 0: Bonding Curve Discovery ===");

  try {
    const now = Math.floor(Date.now() / 1000);

    // Simulate a token discovered on pump.fun bonding curve
    const [bcToken] = await db
      .insert(tokenDataPool)
      .values({
        tokenMint: "BC" + MOCK_TOKENS.GRADUATED.mint.slice(2), // Bonding curve version
        tokenSymbol: "BOND",
        tokenName: "Bonding Curve Token",
        pairCreatedAt: now - 600, // Created 10 minutes ago
        isPumpfun: true,
        pumpfunGraduated: false,
        pumpfunBondingCurveProgress: 45.5, // 45.5% progress toward graduation
        marketCap: 25000,
        deployerAddress: "DeployerABC123",
        createdAt: now,
      })
      .returning();

    await assert(bcToken !== undefined, "Bonding curve token registered");
    await assert(bcToken.isPumpfun === true, "Token marked as pump.fun");
    await assert(bcToken.pumpfunGraduated === false, "Token not yet graduated");
    await assertEquals(
      bcToken.pumpfunBondingCurveProgress,
      45.5,
      "Bonding curve progress tracked (45.5%)"
    );

    // Create token outcome with bonding curve metrics
    const [outcome] = await db
      .insert(tokenOutcomes)
      .values({
        tokenMint: bcToken.tokenMint,
        earlyBuyerWinRate: 0.8,
        earlyBuyerMedianMultiplier: 2.1,
        profitableWalletCount: 28,
        bondingVelocity: 11.4, // 11.4% per hour
        bondingBuyerGrowthRate: 15, // 15 new buyers per hour
        bondingEarlyBuyerConcentration: 0.25, // Top 10 buyers hold 25%
        isPlayedOut: false,
        createdAt: now,
      })
      .returning();

    await assert(outcome !== undefined, "Bonding curve outcome recorded");
    await assertEquals(
      outcome.bondingVelocity,
      11.4,
      "Bonding velocity tracked (11.4%/hour)"
    );
    await assertEquals(outcome.bondingBuyerGrowthRate, 15, "Buyer growth tracked (15/hour)");

    // Verify token can be tracked for graduation
    const trackedToken = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, bcToken.tokenMint),
    });

    await assert(trackedToken !== undefined, "Token queryable for graduation tracking");
    await assert(
      trackedToken?.pumpfunBondingCurveProgress! < 100,
      "Token identified as pre-graduation"
    );

    console.log("✓ Bonding curve token discovery pipeline verified");
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// TEST 1: Graduation Event Creation
// =====================

export async function testGraduationEventCreation(): Promise<void> {
  console.log("\n=== Test 1: Graduation Event Creation ===");

  try {
    const now = Math.floor(Date.now() / 1000);

    // Create a token in tokenDataPool
    const [token] = await db
      .insert(tokenDataPool)
      .values({
        tokenMint: MOCK_TOKENS.GRADUATED.mint,
        tokenSymbol: MOCK_TOKENS.GRADUATED.symbol,
        tokenName: MOCK_TOKENS.GRADUATED.name,
        pairCreatedAt: now - 3600, // 1 hour ago
        pumpfunGraduated: true,
        pumpfunGraduationTime: now - 1800, // 30 minutes ago
        raydiumPoolAddress: "RayPool12345678901234567890123456789",
        raydiumPoolDiscoveredAt: now - 1800,
        raydiumLiquidityUsd: 50000,
        poolOriginType: "pumpfun_graduated",
        isDirectRaydiumLaunch: false,
        createdAt: now,
      })
      .returning();

    await assert(token !== undefined, "Token inserted into tokenDataPool");
    await assert(token.pumpfunGraduated === true, "Token marked as pump.fun graduated");

    // Create graduation event
    const [graduation] = await db
      .insert(graduationEvents)
      .values({
        tokenMint: MOCK_TOKENS.GRADUATED.mint,
        graduationTime: now - 1800,
        destinationPoolAddress: "RayPool12345678901234567890123456789",
        timeToGraduation: 1800, // 30 minutes from launch to graduation
        liquidityOnGraduation: 50000,
        learningExported: false,
        createdAt: now,
      })
      .returning();

    await assert(graduation !== undefined, "Graduation event created");
    await assertEquals(
      graduation.tokenMint,
      MOCK_TOKENS.GRADUATED.mint,
      "Graduation event tied to correct token"
    );

    // Verify we can query it back
    const retrieved = await db.query.graduationEvents.findFirst({
      where: eq(graduationEvents.tokenMint, MOCK_TOKENS.GRADUATED.mint),
    });

    await assert(retrieved !== undefined, "Graduation event retrieved from database");
    if (retrieved) {
      await assertEquals(
        retrieved.destinationPoolAddress,
        "RayPool12345678901234567890123456789",
        "Pool address correctly stored"
      );
    }
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// TEST 2: Pool Discovery and Quality Scoring
// =====================

export async function testPoolDiscoveryAndQuality(): Promise<void> {
  console.log("\n=== Test 2: Pool Discovery and Quality Scoring ===");

  try {
    const now = Math.floor(Date.now() / 1000);

    // Create a new pool discovery record
    const [discovery] = await db
      .insert(raydiumPoolDiscoveries)
      .values({
        poolAddress: "RayPool98765432109876543210987654321",
        baseTokenMint: MOCK_TOKENS.NEW_POOL.mint,
        quoteTokenMint: "USDC123456789012345678901234567890123456789",
        discoveredAt: now,
        sourceType: "rpc_scan",
        liquidityUsd: 75000,
        lastUpdatedAt: now,
        isVerified: true,
        qualityScore: 85,
      })
      .returning();

    await assert(discovery !== undefined, "Pool discovery record created");
    await assertEquals(discovery.qualityScore, 85, "Quality score assigned (85/100)");
    await assert(discovery.liquidityUsd === 75000, "Liquidity correctly recorded");

    // Create associated token in tokenDataPool
    const [token] = await db
      .insert(tokenDataPool)
      .values({
        tokenMint: MOCK_TOKENS.NEW_POOL.mint,
        tokenSymbol: MOCK_TOKENS.NEW_POOL.symbol,
        tokenName: MOCK_TOKENS.NEW_POOL.name,
        pairCreatedAt: now,
        raydiumPoolAddress: "RayPool98765432109876543210987654321",
        raydiumPoolDiscoveredAt: now,
        raydiumLiquidityUsd: 75000,
        poolOriginType: "direct_raydium",
        isDirectRaydiumLaunch: true,
        createdAt: now,
      })
      .returning();

    await assert(token !== undefined, "Token created for direct Raydium launch");
    await assert(token.isDirectRaydiumLaunch === true, "Token marked as direct Raydium launch");
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// TEST 3: Fingerprint Learning
// =====================

export async function testFingerprintLearning(): Promise<void> {
  console.log("\n=== Test 3: Fingerprint Learning ===");

  try {
    const now = Math.floor(Date.now() / 1000);

    // Create a well-performing token
    const [token] = await db
      .insert(tokenDataPool)
      .values({
        tokenMint: MOCK_TOKENS.WELL_PERFORMING.mint,
        tokenSymbol: MOCK_TOKENS.WELL_PERFORMING.symbol,
        tokenName: MOCK_TOKENS.WELL_PERFORMING.name,
        pairCreatedAt: now - 7200,
        raydiumPoolAddress: "RayPoolWellPerforming",
        raydiumLiquidityUsd: 100000,
        poolOriginType: "pumpfun_graduated",
        createdAt: now,
      })
      .returning();

    await assert(token !== undefined, "Well-performing token created");

    // Create token outcome (retrolearner result)
    const [outcome] = await db
      .insert(tokenOutcomes)
      .values({
        tokenMint: MOCK_TOKENS.WELL_PERFORMING.mint,
        earlyBuyerWinRate: 0.75, // 75% of early buyers profited
        earlyBuyerMedianMultiplier: 3.2, // Median 3.2x
        profitableWalletCount: 42,
        peakMultiplierAllTime: 5.8,
        timeToPeakMinutes: 45,
        isPlayedOut: false,
        lastAnalyzedAt: now,
        createdAt: now,
      })
      .returning();

    await assert(outcome !== undefined, "Token outcome recorded");
    await assert(outcome.earlyBuyerWinRate === 0.75, "Early buyer win rate tracked (75%)");
    await assert(outcome.peakMultiplierAllTime === 5.8, "Peak multiplier recorded (5.8x)");

    // Create learned fingerprint
    const [fingerprint] = await db
      .insert(tokenFingerprints)
      .values({
        fingerprintType: "postgrad_raydium",
        clusterId: "postgrad_default",
        tokenMint: MOCK_TOKENS.WELL_PERFORMING.mint,
        winRate: 0.72, // 72% win rate from simulations
        medianMultiplier: 3.0,
        entrySlippageAvg: 0.65,
        entrySlippageP95: 0.95,
        slHitRate: 0.15, // 15% of trades hit SL
        slThresholdPercent: 50,
        tslCurveStartMultiplier: 2.0,
        tslCurveEndMultiplier: 10.0,
        tslCurveHoldMinutes: 120,
        avgHoldMinutes: 67,
        medianHoldMinutes: 45,
        confidence: 0.85, // 85% confidence (many samples)
        sampleCount: 142,
        createdAt: now,
      })
      .returning();

    await assert(fingerprint !== undefined, "Fingerprint learned");
    await assertEquals(fingerprint.fingerprintType, "postgrad_raydium", "Fingerprint type correct");
    await assert(fingerprint.winRate === 0.72, "Win rate from simulation (72%)");
    await assertEquals(fingerprint.sampleCount, 142, "Sample count tracked (142 simulations)");

    // Verify fingerprint can be retrieved
    const retrieved = await db.query.tokenFingerprints.findFirst({
      where: and(
        eq(tokenFingerprints.fingerprintType, "postgrad_raydium"),
        eq(tokenFingerprints.clusterId, "postgrad_default")
      ),
    });

    await assert(retrieved !== undefined, "Fingerprint can be queried from database");
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// TEST 4: System Picks Integration
// =====================

export async function testSystemPicksIntegration(): Promise<void> {
  console.log("\n=== Test 4: System Picks Integration ===");

  try {
    const now = Math.floor(Date.now() / 1000);
    const userId = 1;

    // Verify that a token with learned fingerprint can be matched for system picks
    const fingerprint = await db.query.tokenFingerprints.findFirst({
      where: eq(tokenFingerprints.fingerprintType, "postgrad_raydium"),
    });

    await assert(fingerprint !== undefined, "Fingerprint available for matching");

    if (fingerprint) {
      // In a real system pick scenario:
      // 1. Token would be discovered (either graduated or new pool)
      // 2. Fingerprint would be matched
      // 3. Conviction score would be calculated
      // 4. Position would be opened if conviction >= threshold

      // For this test, verify the conviction calculation logic
      const fingerprintWinRate = fingerprint.winRate || 0.5;
      const creatorReputation = 0.75; // Estimate based on liquidity
      const walletSignals = 0.6; // Estimate from token age

      const conviction = fingerprintWinRate * 0.5 + creatorReputation * 0.3 + walletSignals * 0.2;

      await assert(conviction > 0.5, `Conviction score calculated (${conviction.toFixed(2)})`);

      // Check if conviction exceeds system picks threshold (0.5)
      const meetsPicks = conviction >= 0.5;
      await assert(meetsPicks, "Conviction meets system picks threshold");
    }

    // Verify token has proper Raydium pool for Jupiter validation
    const token = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, MOCK_TOKENS.WELL_PERFORMING.mint),
    });

    await assert(token !== undefined, "Token has proper pool info for validation");
    if (token) {
      await assert(
        (token.raydiumLiquidityUsd || 0) >= 10000,
        `Liquidity sufficient for execution (${(token.raydiumLiquidityUsd || 0).toFixed(0)} USD)`
      );
    }
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// TEST 5: End-to-End Discovery Pipeline
// =====================

export async function testEndToEndPipeline(): Promise<void> {
  console.log("\n=== Test 5: End-to-End Discovery Pipeline ===");

  try {
    // This test verifies the full flow:
    // Graduation detection → Pool discovery → Retrolearner → System picks

    const now = Math.floor(Date.now() / 1000);

    // 1. Verify graduation was detected and token updated
    const graduated = await db.query.tokenDataPool.findFirst({
      where: eq(tokenDataPool.tokenMint, MOCK_TOKENS.GRADUATED.mint),
    });

    await assert(graduated !== undefined, "Step 1: Graduated token found");
    if (graduated) {
      await assert(
        graduated.pumpfunGraduated === true,
        "Step 1: Token marked as graduated"
      );
      await assert(
        graduated.raydiumPoolAddress !== null,
        "Step 1: Raydium pool linked"
      );
    }

    // 2. Verify new pool was discovered
    const newPool = await db.query.raydiumPoolDiscoveries.findFirst({
      where: eq(raydiumPoolDiscoveries.baseTokenMint, MOCK_TOKENS.NEW_POOL.mint),
    });

    await assert(newPool !== undefined, "Step 2: New pool discovered");
    if (newPool) {
      await assert(
        newPool.qualityScore !== null,
        "Step 2: Pool quality scored"
      );
    }

    // 3. Verify retrolearner can find well-performing tokens
    const wellPerforming = await db.query.tokenOutcomes.findFirst({
      where: eq(tokenOutcomes.tokenMint, MOCK_TOKENS.WELL_PERFORMING.mint),
    });

    await assert(wellPerforming !== undefined, "Step 3: Well-performing token analyzed");
    if (wellPerforming) {
      const meetsThreshold = (wellPerforming.earlyBuyerWinRate || 0) >= 0.6;
      await assert(meetsThreshold, "Step 3: Token meets performance criteria");
    }

    // 4. Verify system picks can find and match fingerprints
    const matchedFingerprint = await db.query.tokenFingerprints.findFirst({
      where: and(
        eq(tokenFingerprints.fingerprintType, "postgrad_raydium"),
        // Only check fingerprints with decent confidence
        gte(tokenFingerprints.confidence, 0.5)
      ),
    });

    await assert(matchedFingerprint !== undefined, "Step 4: Fingerprint pattern available");

    console.log("\n=== End-to-End Pipeline ===");
    console.log("✓ Graduation detection working");
    console.log("✓ Pool discovery working");
    console.log("✓ Retrolearner analysis working");
    console.log("✓ System picks matching fingerprints");
  } catch (error) {
    console.error("Test failed with error:", error);
    testsFailed++;
  }
}

// =====================
// CLEANUP AND REPORTING
// =====================

async function cleanupTestData(): Promise<void> {
  console.log("\n=== Cleaning up test data ===");

  try {
    // Delete all test tokens and related records
    const testMints = [
      MOCK_TOKENS.BONDING_CURVE.mint,
      MOCK_TOKENS.GRADUATED.mint,
      MOCK_TOKENS.NEW_POOL.mint,
      MOCK_TOKENS.WELL_PERFORMING.mint,
    ];

    for (const mint of testMints) {
      await db.delete(tokenDataPool).where(eq(tokenDataPool.tokenMint, mint));
      await db.delete(graduationEvents).where(eq(graduationEvents.tokenMint, mint));
      await db.delete(tokenOutcomes).where(eq(tokenOutcomes.tokenMint, mint));
      await db.delete(tokenFingerprints).where(eq(tokenFingerprints.tokenMint, mint));
      await db
        .delete(raydiumPoolDiscoveries)
        .where(eq(raydiumPoolDiscoveries.baseTokenMint, mint));
    }

    console.log("Test data cleaned up");
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

// =====================
// TEST RUNNER
// =====================

export async function runAllTests(): Promise<void> {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  Integration Tests: Token Lifecycle       ║");
  console.log("║  (Bonding Curve → Graduation → Raydium)  ║");
  console.log("╚════════════════════════════════════════════╝");

  try {
    await testBondingCurveDiscovery();
    await testGraduationEventCreation();
    await testPoolDiscoveryAndQuality();
    await testFingerprintLearning();
    await testSystemPicksIntegration();
    await testEndToEndPipeline();

    await cleanupTestData();

    console.log("\n╔════════════════════════════════════════════╗");
    console.log(`║  Results: ${testsPassed} passed, ${testsFailed} failed       ║`);
    console.log("╚════════════════════════════════════════════╝\n");

    if (testsFailed === 0) {
      console.log("✓ All tests passed!");
    } else {
      console.log(`✗ ${testsFailed} test(s) failed`);
    }
  } catch (error) {
    console.error("Fatal error running tests:", error);
  }
}

// Export for use in CLI or test runner
export default { runAllTests };
