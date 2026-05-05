import { useState } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Briefcase, TrendingUp, TrendingDown, Zap, BarChart3, Moon } from "lucide-react";
import type { Holding, Swap } from "@shared/schema";

interface MonitoredWallet {
  id: number;
  userId: number;
  walletAddress: string;
  label: string | null;
  enabled: boolean | null;
  copyTradeEnabled: boolean | null;
  createdAt: number;
}

interface ActivePosition {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  entrySol: number;
  entryPrice: number;
  currentTrajectoryScore: number;
  currentConfidence: number;
  highestPrice: number;
  openedAt: number;
  realizedPnl?: number;
  realizedPnlPercent?: number;
  moonbagAmount?: number;
}

interface PositionBudget {
  expectedPositionsPerDay: number;
  baseAllocationPerPosition: number;
  apeBudget: number;
  forecastBreakdown: Array<{ hour: number; dayOfWeek: string; expectedPositions: number }>;
}

interface PositionAnalytics {
  totalPositions: number;
  winningPositions: number;
  losingPositions: number;
  averageHoldMinutes: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
}

export default function PortfolioPage() {
  const [activeTab, setActiveTab] = useState("holdings");

  useDocumentMeta({
    title: "Portfolio | Penny Pincher",
    description: "Your positions, autotrading status, and system picks performance."
  });

  // Old API queries (holdings, wallets, swaps)
  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const { data: swaps, isLoading: swapsLoading } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
  });

  // New Phase A API queries
  const { data: activePositions, isLoading: positionsLoading } = useQuery<ActivePosition[]>({
    queryKey: ["/api/positions"],
  });

  const { data: positionBudget, isLoading: budgetLoading } = useQuery<PositionBudget>({
    queryKey: ["/api/position-budget"],
  });

  const { data: positionAnalytics, isLoading: analyticsLoading } = useQuery<PositionAnalytics>({
    queryKey: ["/api/position-analytics"],
  });

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
  };

  const formatSol = (val: number) => val.toFixed(4);

  const activeHoldings = holdings?.filter(h => !h.reclaimed && h.currentAmount > 0) || [];
  const totalValue = activeHoldings.reduce((sum, h) => sum + (h.lastPrice ? h.currentAmount * h.lastPrice : 0), 0);
  const totalCost = activeHoldings.reduce((sum, h) => sum + h.costBasis, 0);
  const totalPnl = totalValue - totalCost;
  const winCount = activeHoldings.filter(h => {
    const currentVal = h.lastPrice ? h.currentAmount * h.lastPrice : 0;
    return currentVal > h.costBasis;
  }).length;

  const activeWallets = wallets?.filter(w => w.enabled) || [];
  const copyEnabledWallets = wallets?.filter(w => w.copyTradeEnabled) || [];

  // Phase A position analysis
  const openPositions = activePositions?.filter(p => !p.realizedPnl) || [];
  const moonbags = activePositions?.filter(p => (p.moonbagAmount || 0) > 0) || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Portfolio</h1>
          <p className="text-muted-foreground" data-testid="text-page-subtitle">Positions, autotrading, and system performance</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="holdings" className="flex items-center gap-2">
            <Briefcase className="h-4 w-4" />
            Holdings
          </TabsTrigger>
          <TabsTrigger value="autotrading" className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Autotrading
          </TabsTrigger>
          <TabsTrigger value="system-picks" className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            System Picks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="holdings" className="space-y-4">
          {analyticsLoading ? (
            <div className="grid gap-4 md:grid-cols-4">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Total P&L</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${(positionAnalytics?.totalPnl || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {(positionAnalytics?.totalPnl || 0) >= 0 ? "+" : ""}{formatUsd(positionAnalytics?.totalPnl || 0)}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Win Rate</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {positionAnalytics?.totalPositions ? ((positionAnalytics.winningPositions / positionAnalytics.totalPositions) * 100).toFixed(0) : 0}%
                  </div>
                  <p className="text-xs text-muted-foreground">{positionAnalytics?.winningPositions || 0}/{positionAnalytics?.totalPositions || 0} won</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Profit Factor</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{(positionAnalytics?.profitFactor || 0).toFixed(2)}x</div>
                  <p className="text-xs text-muted-foreground">Wins / Losses ratio</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Avg Hold Time</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{positionAnalytics?.averageHoldMinutes ? (positionAnalytics.averageHoldMinutes / 60).toFixed(1) : 0}h</div>
                  <p className="text-xs text-muted-foreground">Minutes to resolution</p>
                </CardContent>
              </Card>
            </div>
          )}

          {budgetLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Position Budget Forecast</CardTitle>
                <CardDescription>Daily allocation strategy</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Expected Positions/Day</p>
                    <p className="text-2xl font-bold">{positionBudget?.expectedPositionsPerDay.toFixed(1) || "—"}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Base Allocation/Position</p>
                    <p className="text-2xl font-bold">{formatSol(positionBudget?.baseAllocationPerPosition || 0)} SOL</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Ape Budget Available</p>
                    <p className="text-2xl font-bold">{formatSol(positionBudget?.apeBudget || 0)} SOL</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {positionsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : openPositions.length === 0 && moonbags.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Briefcase className="h-10 w-10 mb-2 opacity-50" />
                <p>No active positions</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {openPositions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm">Open Positions ({openPositions.length})</h3>
                  {openPositions.map((position) => {
                    const currentValue = position.entryPrice * position.highestPrice;
                    const pnl = currentValue - position.entrySol;
                    const pnlPercent = (pnl / position.entrySol) * 100;
                    const holdMinutes = (Date.now() - position.openedAt) / 60000;

                    return (
                      <Card key={position.id}>
                        <CardContent className="p-4">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex-1">
                                <div className="font-semibold">{position.tokenSymbol || "Unknown"}</div>
                                <div className="text-sm text-muted-foreground">
                                  Entry: {formatSol(position.entrySol)} SOL @ {position.entryPrice.toFixed(6)} SOL
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="font-semibold">{formatUsd(currentValue)}</div>
                                <div className={`text-sm ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                                  {pnl >= 0 ? "+" : ""}{formatUsd(pnl)} ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <div>
                                Trajectory Score: <Badge variant="outline" className="ml-1">{position.currentTrajectoryScore.toFixed(2)}</Badge>
                              </div>
                              <div>
                                Confidence: <Badge variant="outline" className="ml-1">{(position.currentConfidence * 100).toFixed(0)}%</Badge>
                              </div>
                              <div>
                                Held: {holdMinutes < 60 ? `${Math.round(holdMinutes)}m` : `${(holdMinutes / 60).toFixed(1)}h`}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}

              {moonbags.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <Moon className="h-4 w-4" />
                    Moonbags ({moonbags.length})
                  </h3>
                  {moonbags.map((position) => (
                    <Card key={`moonbag-${position.id}`} className="opacity-75">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="font-semibold text-sm">{position.tokenSymbol || "Unknown"}</div>
                            <div className="text-xs text-muted-foreground">
                              Bag: {formatSol(position.moonbagAmount || 0)} SOL (retained from exit)
                            </div>
                          </div>
                          <Badge variant="secondary" className="ml-2">🌙 Moonbag</Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="autotrading" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Autotrading Status
              </CardTitle>
              <CardDescription>Monitor and control automated copy trading</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Signal Wallets Active</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{copyEnabledWallets.length}</div>
                    <p className="text-xs text-muted-foreground">{activeWallets.length} monitored</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>System Positions Open</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{openPositions.length}</div>
                    <p className="text-xs text-muted-foreground">{moonbags.length} moonbags</p>
                  </CardContent>
                </Card>
              </div>

              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground mb-3">Copy trade settings are configured per signal wallet.</p>
                <Button variant="outline">Go to Signal Wallets</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="system-picks" className="space-y-4">
          {/* Warm-up Status & Auto-Trading Toggle */}
          <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                System Picks Fund - Auto-Trading Control
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {/* Warm-up Status */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Warm-up Status</p>
                  <div className="space-y-1">
                    <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">7 Days Initialization</p>
                    <p className="text-xs text-muted-foreground">System collecting data before live trading</p>
                  </div>
                </div>

                {/* Auto-Trading Toggle */}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Auto-Trading Status</p>
                  <div className="flex items-center gap-3 rounded-lg border p-3">
                    <div className="flex-1">
                      <p className="text-sm">Real SOL Trading</p>
                      <p className="text-xs text-muted-foreground">Live positions with actual funds</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={true}
                      className="cursor-not-allowed"
                      title="Enable after warm-up completes"
                    >
                      Disabled
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Portfolio Overview */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Briefcase className="h-5 w-5" />
                Portfolio Overview
              </CardTitle>
              <CardDescription>System picks performance and allocation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-4">
                {/* Expected Positions Today */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Expected Today</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{positionBudget?.expectedPositionsPerDay.toFixed(1) || "—"}</div>
                    <p className="text-xs text-muted-foreground">Positions this period</p>
                  </CardContent>
                </Card>

                {/* Base Allocation */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Base Allocation</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatSol(positionBudget?.baseAllocationPerPosition || 0)} SOL</div>
                    <p className="text-xs text-muted-foreground">Per position</p>
                  </CardContent>
                </Card>

                {/* Current Positions */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Open Positions</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{openPositions.length || "0"}</div>
                    <p className="text-xs text-muted-foreground">Active trades</p>
                  </CardContent>
                </Card>

                {/* Ape Budget */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Ape Budget</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatSol(positionBudget?.apeBudget || 0)} SOL</div>
                    <p className="text-xs text-muted-foreground">Bonus allocation</p>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>

          {/* Performance Analytics */}
          {positionAnalytics && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Performance Analytics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-4">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Total Positions</p>
                    <p className="text-2xl font-bold">{positionAnalytics.totalPositions}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Win Rate</p>
                    <p className={`text-2xl font-bold ${positionAnalytics.totalPositions > 0 && (positionAnalytics.winningPositions / positionAnalytics.totalPositions) > 0.5 ? "text-green-500" : "text-red-500"}`}>
                      {positionAnalytics.totalPositions > 0 ? ((positionAnalytics.winningPositions / positionAnalytics.totalPositions) * 100).toFixed(0) : 0}%
                    </p>
                    <p className="text-xs text-muted-foreground">{positionAnalytics.winningPositions}/{positionAnalytics.totalPositions} won</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Profit Factor</p>
                    <p className={`text-2xl font-bold ${positionAnalytics.profitFactor >= 1 ? "text-green-500" : "text-red-500"}`}>
                      {positionAnalytics.profitFactor.toFixed(2)}x
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Total P&L</p>
                    <p className={`text-2xl font-bold ${positionAnalytics.totalPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                      {positionAnalytics.totalPnl >= 0 ? "+" : ""}{formatUsd(positionAnalytics.totalPnl)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Open Positions */}
          {openPositions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Open Positions ({openPositions.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {openPositions.map((position) => {
                    const currentValue = position.entryPrice * position.highestPrice;
                    const pnl = currentValue - position.entrySol;
                    const pnlPercent = (pnl / position.entrySol) * 100;
                    const holdMinutes = (Date.now() - position.openedAt) / 60000;

                    return (
                      <div key={position.id} className="flex items-center justify-between rounded-lg border p-3">
                        <div className="flex-1">
                          <div className="font-semibold">{position.tokenSymbol}</div>
                          <div className="text-sm text-muted-foreground">
                            {formatSol(position.entrySol)} SOL @ {position.entryPrice.toFixed(6)} • Held {holdMinutes < 60 ? `${Math.round(holdMinutes)}m` : `${(holdMinutes / 60).toFixed(1)}h`}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">{formatUsd(currentValue)}</div>
                          <div className={`text-sm ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {pnl >= 0 ? "+" : ""}{formatUsd(pnl)} ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">System Status</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-2">
              <p>✓ Collecting 7-day warm-up data before enabling real SOL trading</p>
              <p>✓ Expected daily positions: {positionBudget?.expectedPositionsPerDay.toFixed(1) || "—"}</p>
              <p>✓ Base allocation per position: {formatSol(positionBudget?.baseAllocationPerPosition || 0)} SOL</p>
              <p>✓ Check /api/system-appraisal?passkey=debug for detailed learning metrics</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
