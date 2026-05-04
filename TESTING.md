# Penny-Pincher2 Test Suite

Comprehensive unit and integration tests for core trading system components.

## Quick Start

### Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (re-run on file changes)
npm run test:watch

# Run tests with UI dashboard
npm run test:ui
```

## Test Files

### Phase 1: Token Success ANN

**File**: `server/token-success-ann.test.ts`

Tests the Artificial Neural Network that predicts token success from early dynamics features.

**Test Coverage**:
- **Feature Extraction** (`extractEarlyDynamicsFeatures`)
  - Extracts 50 technical features from first 10 minutes
  - Tests price dynamics (OHLCV), volume trajectory, whale patterns
  - Tests holder distribution and cluster activity
  - Validates graceful handling of missing data
  
- **Model Initialization** (`getOrCreateModel`)
  - Creates valid TensorFlow Sequential model
  - Validates input shape [batch, 50] and output shape [batch, 1]
  - Confirms sigmoid activation for probability output (0-1 range)
  
- **Model Training** (`trainANNModel`)
  - Trains on historical token outcomes
  - Updates model weights during training
  - Completes within reasonable time bounds
  
- **Prediction** (`predictTokenSuccess`)
  - Returns success probability (0.0-1.0)
  - Handles edge cases gracefully
  - Provides consistent predictions for repeated calls
  
- **Integration**: Full pipeline from feature extraction → training → prediction

### Phase 2: Slow-Grower Detection

**File**: `server/slow-grower-detector.test.ts`

Tests identification of profitable wallet patterns on tokens the system missed.

**Test Coverage**:
- **Pattern Detection** (`detectSlowGrowerPatterns`)
  - Identifies profitable trades from last 4 hours
  - Filters out already-known tokens
  - Excludes bot-flagged wallets
  - Extracts ANN confidence scores
  
- **Pattern Filtering** (`filterHighConfidencePatterns`)
  - Filters patterns above confidence threshold
  - Maintains pattern structure in results
  
- **Pattern Storage** (`storeSlowGrowerPatterns`)
  - Persists patterns to database
  - Handles bulk storage without errors
  
- **Pattern Scoring** (`scoreSlowGrowerMatch`)
  - Scores new tokens against learned patterns
  - Returns numeric score (0-1)
  - Enables comparative analysis
  
- **Integration**: Full pipeline from detection → filtering → storage → scoring

### Phase 2: Wallet Discovery

**File**: `server/wallet-discovery.test.ts`

Tests identification and ranking of successful wallets for signal generation.

**Test Coverage**:
- **Backtracking Winners** (`backtrackFromWinners`)
  - Identifies wallets with profitable trades on successful tokens
  - Ranks by profitability multiplier
  - Includes hold duration metrics
  
- **Copy Chain Tracking** (`trackCopyChain`)
  - Identifies copy trading relationships
  - Tracks entry timing across wallets
  - Handles isolated wallets
  
- **Outcome Analysis** (`getWalletOutcomes`)
  - Returns wallet trading history with PnL metrics
  - Includes realized profit/loss and hold times
  
- **Leadership Detection** (`getLeaderWallets`)
  - Identifies wallets with followers
  - Tracks influence metrics
  
- **Signal Scoring** (`scoreWalletForSignal`)
  - Assigns numerical signal strength
  - Higher scores for profitable wallets
  - Consistent scoring for same wallet
  
- **Discovery Cycle** (`runWalletDiscoveryCycle`)
  - Executes complete discovery pipeline
  - Returns cycle statistics
  - Tracks newly discovered wallets
  
- **Integration**: Full discovery pipeline with ranking and copy chain analysis

## Test Configuration

### Vitest Configuration

**File**: `vitest.config.ts`

- **Environment**: Node.js (server-side testing)
- **Test Timeout**: 10 seconds per test
- **Parallel Execution**: Up to 4 threads
- **Coverage**: v8-based coverage reporting
- **Path Aliases**: @shared, @server, @client

### Setup and Teardown

**File**: `vitest.setup.ts`

- Initializes test environment variables
- Mocks external services
- Filters console noise during tests
- Global cleanup after all tests

## Writing New Tests

### Test Structure Template

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { functionToTest } from "./module.ts";

describe("Module Name", () => {
  beforeEach(async () => {
    // Setup test data
  });

  afterEach(async () => {
    // Cleanup
  });

  describe("Feature/Function Name", () => {
    it("should do X when given Y", async () => {
      const result = await functionToTest(input);
      expect(result).toBe(expected);
    });

    it("should handle edge case Z", async () => {
      expect(async () => {
        await functionToTest(edgeCase);
      }).not.toThrow();
    });
  });
});
```

### Test Best Practices

1. **Isolation**: Each test should be independent and use unique test data
2. **Clear Names**: Test names describe the behavior being tested
3. **Arrange-Act-Assert**: Follow the AAA pattern
4. **Mock External Calls**: Use vi.fn() for mocking external dependencies
5. **Async/Await**: Always await async operations
6. **Error Handling**: Test both success and failure paths

### Database Testing

For tests that interact with the database:

```typescript
beforeEach(async () => {
  // Insert test data
  await db.insert(table).values(testData).onConflictDoNothing();
});

afterEach(async () => {
  // Optional: Clean up (depends on test design)
  // Conflicts are ignored, so old data won't cause failures
});
```

## CI/CD Integration

Tests can be integrated into CI/CD pipelines:

```bash
# In GitHub Actions or similar
npm ci
npm test
```

## Coverage Reporting

Generate coverage reports:

```bash
npm test -- --coverage
```

Coverage reports are generated in:
- Text format: Console output
- HTML format: `coverage/index.html`
- JSON format: `coverage/coverage-final.json`

## Troubleshooting

### Test Timeouts

If tests timeout:
1. Increase timeout in vitest.config.ts
2. Check for unresolved promises
3. Verify database connections

### Database Issues

If tests fail due to database:
1. Ensure database is running
2. Check DATABASE_URL environment variable
3. Verify migrations are applied

### Import Errors

If tests fail with import errors:
1. Check path aliases in vitest.config.ts
2. Verify file extensions (.ts vs .tsx)
3. Check for circular dependencies

## Future Test Expansion

Potential areas for additional tests:
- Rate limiter tests (token bucket, circuit breaker)
- API client tests (DexPaprika, Chainstack, Shyft)
- Retrolearner cycle tests (full 4-hour training)
- Token lifecycle tracking tests
- Real-time WebSocket subscription tests

## Test Metrics

Target metrics for healthy test suite:
- **Coverage**: >80% of core server logic
- **Execution Time**: <30 seconds total
- **Flakiness**: <1% (no randomly failing tests)
- **Readability**: Clear test names and documentation

## References

- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [TensorFlow.js Testing](https://www.tensorflow.org/js/guide/testing)
