# Paper Trading Simulation & Validation System

## Overview

The paper trading system now includes a complete simulation and validation pipeline that:

1. **Simulates trades on Jupiter API** before opening positions (validates liquidity, slippage, price impact)
2. **Calculates dynamic exit strategies** based on retrolearner outcomes and historical patterns
3. **Validates strategy theory in real-time** by comparing predicted vs actual outcomes
4. **Provides feedback to retrolearner** to continuously refine exit strategy predictions

This creates a tight feedback loop: **Retrolearner → Exit Strategy Calculation → Paper Trading → Validation → Retrolearner Learning**

## Architecture

```
New Token Discovered
    ↓
Retrolearner Analysis (past 6 hours)
    ├─ Query similar successful tokens
    ├─ Calculate avg peak multiplier, time-to-peak, win rate
    └─ Generate pattern-based exit strategy
    ↓
Paper Trading Validation Workflow
    ├─ 1. Simulate trade on Jupiter (verify liquidity)
    ├─ 2. Calculate dynamic exit strategy (TP, SL, trailing stop)
    ├─ 3. Record prediction (what we expect to happen)
    └─ 4. Open paper position only if simulation passes
    ↓
Position Open → Price Tracking → Exit Conditions
    ├─ Take profit multiplier hit?
    ├─ Stop loss triggered?
    ├─ Trailing stop activated?
    └─ Time-based exit?
    ↓
Position Closes
    ├─ Calculate actual outcome (actual multiplier)
    ├─ Compare: predicted vs actual
    ├─ Mark validation: confirmed (>50% accuracy) or refuted (<10%)
    └─ Feed back to retrolearner: "This strategy works 78% of the time"
    ↓
Retrolearner Uses Validation Rate
    ├─ Adjust exit strategy confidence
    ├─ Refine pattern matching weights
    └─ Update strategy for next cycle
```

## Key Features

### 1. Jupiter Trade Simulation

Before opening a paper position, we simulate the trade on Jupiter's quote API:

```typescript
// Simulates: SOL → Token
const simulation = await simulateTradeOnJupiter(
  tokenMint,           // Token to trade into
  solAmountLamports,   // Amount in lamports
  maxSlippagePercent   // Maximum acceptable slippage (default 5%)
);

// Returns:
{
  success: true,                      // Is this trade executable?
  expectedTokens: 450000,             // How many tokens will we get?
  priceImpactPercent: 2.5,           // Price impact vs market
  slippageLamports: 50000000,        // Actual slippage amount
  executableAtSlippage: true         // Within acceptable slippage?
}
```

**Benefits:**
- ✅ Catches tokens with insufficient liquidity early
- ✅ Detects high price impact before position opens
- ✅ Validates Jupiter is working before committing capital
- ✅ Provides real latency measurement

**Limitations:**
- Simulates SOL→Token (buy), doesn't validate Token→SOL (sell)
- Latency may change between simulation and actual trade
- Price changes between quote and execution still possible

### 2. Dynamic Exit Strategies (Retrolearner-Influenced)

Exit strategies are calculated from historical patterns:

```typescript
const strategy = await calculateDynamicExitStrategy(
  tokenMint,      // Token to analyze
  entrySolAmount  // How much we're investing
);

// Returns:
{
  takeProfitMultiplier: 4.5,        // Exit at 4.5x (80% of historical peak)
  stopLossPercent: 0.2,              // Exit if drops 20%
  trailingStopPercent: 0.2,          // Trail down 20% from highest
  estimatedTimeToPeakMinutes: 45,    // Expected time to reach peak
  confidenceScore: 0.87,             // How confident are we? (0.0-1.0)
  basedOnPatterns: [
    "historical_peak_multiplier",
    "early_buyer_win_rate",
    "trailing_stop_on_high_upside"
  ],
  rationale: "Based on 18 similar successful tokens: avg peak=45.2x, ..."
}
```

**How It Works:**

1. **Query recent successful tokens** from retrolearner (tokens that hit 2x+)
2. **Calculate statistics**:
   - Average peak multiplier: 45.2x
   - Average time-to-peak: 45 minutes
   - Early buyer win rate: 78%
   - Early buyer median multiplier: 8.5x

3. **Derive exit strategy**:
   - Take Profit = 80% of historical peak (early buyers often exit here)
   - Stop Loss = Based on win rate (higher win rate → tighter SL)
   - Trailing Stop = For high-upside tokens (>20x peak)

4. **Confidence Score**:
   - If token has retrolearner outcome data: 0.95 (high confidence)
   - If using pattern matching: 0.50-0.75 (medium confidence)
   - Higher if more similar tokens found

**Example Calculation:**

```
Similar successful tokens: 18 tokens
  Average peak multiplier: 45.2x
  Average time-to-peak: 45 minutes
  Average early buyer win rate: 78%
  Average early buyer median multiplier: 8.5x

Derived strategy:
  Take Profit = 8.5x × 0.8 = 6.8x  (safe exit at 80% of median early buyer gain)
  Stop Loss = 0.15 (15%)             (tight SL because 78% win rate)
  Trailing Stop = 0.2 (20%)          (catch the moon if it goes 45x+)
  Confidence = 0.85                  (medium-high, pattern-based)
```

### 3. Strategy Validation Records

When a position opens, we record our prediction:

```typescript
const validation = await recordStrategyValidation(
  positionId,                    // Paper position ID
  "retrolearner_guided_entry",   // Strategy theory being tested
  4.5,                            // Expected multiplier (take profit target)
  150                             // Latency (time from validation to open, ms)
);

// Stores:
{
  positionId: 42,
  strategyTheory: "retrolearner_guided_entry",
  expectedOutcome: 4.5,
  validationStatus: "pending",   // Will be updated when position closes
  latencyMs: 150,
  createdAt: 1714333200
}
```

When position closes, we update with actual results:

```typescript
await updateValidationWithResult(
  positionId: 42,
  actualOutcome: 12.5,           // Actual multiplier achieved
  exitReason: "trailing_stop"    // How did we exit?
);

// Updates validation record:
{
  actualOutcome: 12.5,
  actualExitReason: "trailing_stop",
  validationStatus: "confirmed"  // 12.5 > (4.5 × 0.5) → confirmed!
}

// Validation status rules:
// - confirmed: actualOutcome > (expectedOutcome × 0.5)    [we predicted conservatively]
// - refuted: actualOutcome < (expectedOutcome × 0.1)      [we were way off]
// - pending: Otherwise                                     [partial success]
```

### 4. Validation Success Rate Tracking

After multiple trades, check how well our exit strategy predictions work:

```typescript
const stats = await getStrategyValidationRate(
  "retrolearner_guided_entry",
  24  // Last 24 hours
);

// Returns:
{
  totalValidations: 47,              // 47 positions we validated
  confirmedCount: 37,                // 37 hit our take profit
  refutedCount: 4,                   // 4 completely failed prediction
  successRate: 0.787,                // 78.7% success rate (37/47)
  avgAccuracy: 1.25                  // On average, achieved 125% of predicted
}
```

**Usage**: If success rate >70%, we're confident in the strategy. If <40%, need to refine retrolearner patterns.

## API Endpoints

### POST /api/paper/validate-position

Simulate trade and calculate exit strategy **before** opening position.

**Request:**
```json
{
  "tokenMint": "ABC123...",
  "entrySol": 1.0,
  "strategyTheory": "retrolearner_guided_entry"  // optional
}
```

**Response:**
```json
{
  "success": true,
  "simulation": {
    "success": true,
    "tokenMint": "ABC123...",
    "expectedTokens": 450000,
    "priceImpactPercent": 2.5,
    "slippageLamports": 50000000,
    "executableAtSlippage": true
  },
  "exitStrategy": {
    "takeProfitMultiplier": 4.5,
    "stopLossPercent": 0.2,
    "trailingStopPercent": 0.2,
    "estimatedTimeToPeakMinutes": 45,
    "confidenceScore": 0.87,
    "basedOnPatterns": ["historical_peak_multiplier", "early_buyer_win_rate"],
    "rationale": "Based on 18 similar successful tokens..."
  },
  "validation": {
    "positionId": 0,
    "simulationPassed": true,
    "strategyTheory": "retrolearner_guided_entry",
    "expectedOutcome": 4.5,
    "validationStatus": "pending",
    "latencyMs": 150,
    "createdAt": 1714333200
  }
}
```

**Usage Example:**
```bash
# Validate before opening position
curl -X POST http://localhost:3000/api/paper/validate-position \
  -H "Content-Type: application/json" \
  -d '{
    "tokenMint": "ABC123...",
    "entrySol": 1.0,
    "strategyTheory": "retrolearner_guided_entry"
  }'

# If simulation passes:
#   - Use exit strategy from response to open position
#   - Validation record will track prediction vs actual outcome

# If simulation fails:
#   - Don't open position (insufficient liquidity or high slippage)
#   - Try next opportunity
```

### GET /api/paper/validation-stats

Get success rate of strategy predictions.

**Query Parameters:**
- `strategyTheory` (optional): Strategy to analyze (default: "retrolearner_guided_entry")
- `lookbackHours` (optional): How far back to analyze (default: 24)

**Response:**
```json
{
  "strategyTheory": "retrolearner_guided_entry",
  "lookbackHours": 24,
  "totalValidations": 47,
  "confirmedCount": 37,
  "refutedCount": 4,
  "successRate": 0.787,
  "avgAccuracy": 1.25
}
```

**Usage Example:**
```bash
# Check success rate of retrolearner-guided strategy (last 24h)
curl "http://localhost:3000/api/paper/validation-stats?strategyTheory=retrolearner_guided_entry&lookbackHours=24"

# If successRate > 0.70, strategy is working well
# If successRate < 0.40, need to refine retrolearner patterns
```

### GET /api/paper/exit-strategies/:tokenMint

Get calculated exit strategy for a specific token.

**Path Parameters:**
- `tokenMint`: Token address

**Response:**
```json
{
  "tokenMint": "ABC123...",
  "exitStrategy": {
    "takeProfitMultiplier": 4.5,
    "stopLossPercent": 0.2,
    "trailingStopPercent": 0.2,
    "estimatedTimeToPeakMinutes": 45,
    "confidenceScore": 0.87,
    "basedOnPatterns": ["historical_peak_multiplier", "early_buyer_win_rate"],
    "rationale": "Based on 18 similar successful tokens..."
  }
}
```

**Usage Example:**
```bash
# See what exit strategy would be used for a token
curl "http://localhost:3000/api/paper/exit-strategies/ABC123"

# Understand the confidence and rationale
# Can override if you disagree with the strategy
```

## Integration with Retrolearner

The validation system feeds back into retrolearner:

**Every 6 hours, retrolearner:**
1. Checks validation success rates for all strategies
2. If `successRate < 0.40`: Reduces confidence in pattern-based exit strategies
3. If `successRate > 0.70`: Increases confidence in pattern-based exit strategies
4. Adjusts weights for similar token patterns
5. Updates next cycle's exit strategy calculations

**Example feedback loop:**
```
Cycle 1: "Based on 18 similar tokens, set TP=4.5x, SL=20%"
         → Paper traders get 78% success rate

Cycle 2: "Last cycle validated 78% accuracy, similar tokens are predictive"
         → Increase confidence to 0.92
         → Use tighter stop loss (15% instead of 20%)
         → Set higher take profit (5x instead of 4.5x)

Cycle 3: Paper traders get 85% success rate
         → Pattern is working, refine further
```

## Real-Time Latency Measurement

The validation system measures latency at every step:

```
Simulation request → Jupiter API call: 45ms
Exit strategy calculation → DB queries: 12ms
Validation record creation → DB insert: 8ms
Total latency: 65ms (recorded as "latencyMs" in validation)
```

**Usage**: Monitor latency to detect:
- API slowdowns (retrolearner patterns may be stale)
- Database bottlenecks
- Network issues

## Best Practices

### 1. Always Validate Before Opening

```typescript
const validation = await validateAndOpenPaperPosition({
  userId,
  tokenMint,
  entrySol,
  strategyTheory: "retrolearner_guided_entry"
});

if (!validation.success) {
  console.log("Validation failed:", validation.error);
  return; // Don't open position
}

if (!validation.simulation.executableAtSlippage) {
  console.log("Slippage too high:", validation.simulation.priceImpactPercent);
  return; // Skip token
}

// Now safe to open position with validated exit strategy
const position = await openPaperPosition({
  userId,
  tokenMint,
  entrySol,
  takeProfitMultiplier: validation.exitStrategy.takeProfitMultiplier,
  stopLossPercent: validation.exitStrategy.stopLossPercent,
  trailingStopPercent: validation.exitStrategy.trailingStopPercent,
  strategyId: null,
  signalWallet: null
});
```

### 2. Monitor Validation Success Rate

```typescript
// Daily check
const stats = await getStrategyValidationRate("retrolearner_guided_entry", 24);

if (stats.successRate < 0.40) {
  console.warn("Strategy success rate dropped below 40%!");
  console.warn(`Only ${stats.confirmedCount} of ${stats.totalValidations} validated`);
  // Consider pausing trading until retrolearner refines
}

if (stats.avgAccuracy > 1.5) {
  console.log("We're beating predictions! Avg accuracy: " + stats.avgAccuracy);
  // Can take more aggressive positions
}
```

### 3. Use Confidence Scores to Adjust Position Size

```typescript
const strategy = await calculateDynamicExitStrategy(tokenMint, 1.0);

// Scale position size by confidence
let positionSize = baseSize; // e.g., 1.0 SOL

if (strategy.confidenceScore > 0.90) {
  positionSize *= 1.5; // High confidence → larger position
} else if (strategy.confidenceScore < 0.60) {
  positionSize *= 0.5; // Low confidence → smaller position
}

await openPaperPosition({
  entrySol: positionSize,
  takeProfitMultiplier: strategy.takeProfitMultiplier,
  // ...
});
```

### 4. Track Different Strategy Theories

```typescript
// Test multiple strategies in parallel
const strategies = [
  "retrolearner_guided_entry",
  "wallet_copy_pattern",
  "whale_movement_tracking"
];

for (const theory of strategies) {
  const stats = await getStrategyValidationRate(theory, 24);
  console.log(`${theory}: ${(stats.successRate * 100).toFixed(1)}% success`);
}

// Use best-performing theory for actual positions
```

## Troubleshooting

### Problem: Simulation always fails with "insufficient liquidity"

**Solution:**
- Token may be too new (needs time to build liquidity)
- Try again in 1-2 minutes
- Or increase max slippage from 5% to 10%

### Problem: Validation success rate is 30%

**Solution:**
- Exit strategy patterns may not apply to current market
- Check if retrolearner has sufficient outcome data
- May need to run retrolearner cycle again
- Consider falling back to manual position management

### Problem: Latency is >500ms

**Solution:**
- Jupiter API may be slow
- Database queries may be bottlenecked
- Check system load and network
- May need to optimize retrolearner pattern queries

## Implementation Checklist

- [x] Jupiter simulation before position open
- [x] Dynamic exit strategy calculation from retrolearner
- [x] Validation record creation (prediction)
- [x] Validation record update (actual outcome)
- [x] Success rate tracking
- [x] API endpoints for validation workflow
- [x] Confidence scoring
- [x] Latency measurement
- [ ] Real trading integration (not yet, paper only)
- [ ] Position size adjustment based on confidence
- [ ] Multiple strategy theory comparison
- [ ] Dashboard for validation metrics

## Next Steps

1. **Monitor validation success rates** - Set up alerts if <40%
2. **Tune exit strategy patterns** - Retrolearner should improve over time
3. **Test confidence score thresholds** - Find optimal position sizing
4. **Compare strategy theories** - See which predictors work best
5. **Integration to real trading** - When confidence is >85%
