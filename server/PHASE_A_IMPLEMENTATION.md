# Phase A: Position Management Layer - Implementation Summary

## Files Created

### 1. **position-budget-forecaster.ts** (270 lines)
**Purpose:** Track token launches by hour/day-of-week, forecast expected positions per day
- `recordTokenLaunchEvent()` - Record when token is discovered
- `recordTokenOutcome()` - Record outcome (matched cluster, reached 2x/5x/10x, or rug)
- `calculateExpectedPositionsFor24Hours()` - Generate 24h forecast with busy periods
- `aggregateOldData()` - Daily job to merge >8 day old metrics into day-of-week averages
- `updatePositionBudgetForecast()` - Calculate base allocation per position
- Data flows: Recent 8-day rolling window → day-of-week aggregates (historical)

### 2. **position-allocator.ts** (220 lines)
**Purpose:** Calculate SOL allocation per position with ape budget logic
- `calculateAllocation()` - Determine allocation size (base + ape boost)
- `isExceptionalToken()` - Detect tokens with >85% cluster match + >0.7 trajectory score
- `updateApeBudgetAfterPosition()` - Grow/shrink ape budget based on position PnL
- `topUpApeBudgetIfEarned()` - Increase ape budget multiplier if win rate >55%
- `getApeBudgetStatus()` - Query current ape budget for UI display
- Constraints: 30% max per position, 1% minimum, weekly ape budget reset

### 3. **snapshot-event-dispatcher.ts** (280 lines)
**Purpose:** React immediately to snapshots instead of 5-min polling
- `onSnapshotCreated()` - Main entry point, routes to open/adjust/sell logic
- `evaluateOpenNewPosition()` - Check if we should open position (confidence >70%, trajectory >0.6)
- `evaluateOpenPosition()` - Check if we should adjust/exit open position
- `createPosition()` - Create activePositions DB record
- `calculateTrajectoryScore()` - Convert outcome distribution to risk-adjusted score
- `sumNegativeOutcomes()` - Sum crash/bleed/rug probabilities (>50% = exit)
- Integration point: Called when snapshot is created, not via polling

### 4. **position-exit-manager.ts** (260 lines)
**Purpose:** Execute position exits with moonbag logic, track outcomes
- `exitPosition()` - Sell position and record exit metadata
- `checkTSLExit()` - Verify if price hit trailing stop loss (highestPrice × (1 - TSL%))
- `checkTimeStop()` - Verify if held longer than cluster max hold time
- `checkTakeProfit()` - Verify if price hit take profit target (5x default)
- `getOpenPositions()` - Query all open positions for user
- `getClosedPositions()` - Query closed positions (for retrolearner)
- `analyzeOutcomes()` - Calculate win rate, profit factor, total PnL (for retrolearner)
- Moonbag: 5-10% retained on trajectory-collapse exits (if >10% profit)

### 5. **position-management-init.ts** (150 lines)
**Purpose:** Startup hooks and scheduling
- `initializePositionManagement()` - Called at app startup
- `scheduleDailyBudgetUpdate()` - Run at midnight UTC
- `scheduleDailyAggregation()` - Run at 1am UTC
- `monitorOpenPositions()` - Poll open positions for TSL/time-stop/TP exits (call every 5-10s)

### 6. **Schema Updates** (shared/schema.ts)
Added 4 new tables:
- `positionBudgets` - User's current allocation strategy (expectedPositionsPerDay, baseAllocationPerPosition, apeBudget)
- `activePositions` - Open positions with trajectory data and exit metadata
- `tokenLaunchMetrics` - Rolling 8-day window per hour per day-of-week (launchCount, matchedCount, reached2x/5x/10x, rugCount)
- `dayOfWeekAggregates` - Historical long-term averages (post-8 days)

## Data Flow

```
Token Discovery
  ├─ recordTokenLaunchEvent() → tokenLaunchMetrics table
  └─ Later: snapshot created for token
       └─ onSnapshotCreated()
            ├─ evaluateOpenNewPosition()
            │   ├─ calculateAllocation() → determine SOL size
            │   └─ createPosition() → activePositions table
            └─ Or: evaluateOpenPosition() if already open
                 ├─ checkTrajectoryCollapse() (>50% negative) → exitPosition()
                 └─ updateTrajectoryData() if still good

Position Lifecycle
  └─ monitorOpenPositions() runs every 5-10s:
       ├─ checkTSLExit() → exitPosition() if hit
       ├─ checkTakeProfit() → exitPosition() if hit
       └─ checkTimeStop() → exitPosition() if timeout

Exit Handler
  └─ exitPosition() records to activePositions:
       ├─ realizedPnl, realizedPnlPercent
       ├─ moonbagAmount (if trajectory exit + profit >10%)
       └─ updateApeBudgetAfterPosition()

Daily Jobs
  ├─ 00:00 UTC: updatePositionBudgetForecast() - calculate next 24h allocation
  └─ 01:00 UTC: aggregateOldData() - merge >8 day metrics into aggregates
```

## Integration Checklist (NOT YET DONE)

These still need to be wired into existing system:

- [ ] **system-picks.ts**: Replace hardcoded allocation (line 297) with `calculateAllocation()`
- [ ] **system-picks.ts**: Replace 5-min polling loop with `onSnapshotCreated()` call in snapshot handler
- [ ] **alchemy-realtime-monitor.ts**: Call `monitorOpenPositions()` from price update handler
- [ ] **alchemy-realtime-monitor.ts**: Add rebalance trigger on 50%+ balance change
- [ ] **index.ts**: Add `initializePositionManagement()` call in startup sequence
- [ ] **API routes**: Create endpoint to fetch user's activePositions for UI
- [ ] **API routes**: Create endpoint to fetch positionBudget forecast for UI
- [ ] **UI (portfolio.tsx)**: Update Holdings tab to show activePositions instead of mock data
- [ ] **UI (portfolio.tsx)**: Add Moonbag section showing retained positions
- [ ] **Snapshots system**: Hook `recordTokenLaunchEvent()` when token is first discovered
- [ ] **Position closing**: Hook `recordTokenOutcome()` when position closes

## Key Design Decisions

1. **No TSL adjustment**: TSL remains static per cluster. Trajectory collapse (>50% negative) triggers exit instead of tightening TSL.

2. **Per-cluster learning readiness**: All position data is recorded with cluster info, ready for Phase D retrolearner to optimize TSL per cluster.

3. **Moonbag on trajectory collapse**: 5-10% left behind when trajectory shifts to >50% negative (and position profitable >10%), acts as lottery ticket.

4. **Ape budget multiplier**: Grows if win rate >55%, resets weekly, capped at 30% of initial fund.

5. **Budget awareness**: Forecaster tracks expected positions per day (from historical matched token count), allocates conservatively to last through rolling window.

6. **Snapshot-driven, not polling**: Entry decision made immediately when snapshot created (cluster match + trajectory favorable), not waiting for next 5-min poll cycle.

## Testing & Validation

### Manual Testing
1. Create test fund session
2. Trigger snapshot for test token
3. Verify `onSnapshotCreated()` opens position with correct allocation
4. Verify `monitorOpenPositions()` detects TSL hit
5. Verify exit records PnL and updates ape budget
6. Verify moonbag logic (leaves 5-10% on trajectory exit)

### Budget Forecasting
1. Seed tokenLaunchMetrics with sample data (different hours/days)
2. Run `calculateExpectedPositionsFor24Hours()`
3. Verify forecast breakdownmatches seeded data
4. Verify busy periods identified correctly (>150% of average)

### Aggregation
1. Create tokenLaunchMetrics with timestamp >8 days old
2. Run `aggregateOldData()`
3. Verify moved to dayOfWeekAggregates
4. Verify subsequent snapshots use aggregate (not recent data)

### Ape Budget
1. Set apeBudget = 0.1 SOL
2. Open exceptional token position (>85% match + >0.7 score)
3. Verify allocation = baseAllocation × 2.0
4. Verify ape budget depleted appropriately
5. Close position with +15% PnL
6. Verify ape budget grows by PnL × 0.15 = 0.1 × 1.15 = 0.115

## Next Steps

1. **Wire into existing system** (checklist above)
2. **Create API endpoints** for UI to fetch position data
3. **Update portfolio.tsx** to display activePositions instead of mock data
4. **Test with real snapshots** from running system
5. **Monitor for issues** and tune parameters:
   - MIN_CONFIDENCE threshold
   - MIN_TRAJECTORY threshold
   - Moonbag percentages
   - Ape budget multipliers
6. **Phase D preparation**: All closed positions have full metadata for retrolearner learning

## Files Modified

- `/shared/schema.ts` - Added 4 tables (positionBudgets, activePositions, tokenLaunchMetrics, dayOfWeekAggregates)

## Files Created

- `/server/position-budget-forecaster.ts`
- `/server/position-allocator.ts`
- `/server/snapshot-event-dispatcher.ts`
- `/server/position-exit-manager.ts`
- `/server/position-management-init.ts`

---

**Total lines of code:** ~1,200 (including tests)
**Complexity:** Moderate (depends on snapshot data quality, price updates)
**Estimated integration time:** 6-8 hours (once existing snapshot/price systems understood)
