import { useState } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Briefcase, TrendingUp, TrendingDown, Zap, BarChart3 } from "lucide-react";
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

export default function PortfolioPage() {
  const [activeTab, setActiveTab] = useState("holdings");

  useDocumentMeta({
    title: "Portfolio | Penny Pincher",
    description: "Your positions, autotrading status, and system picks performance."
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const { data: swaps, isLoading: swapsLoading } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
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
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Value</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatUsd(totalValue)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Cost Basis</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatUsd(totalCost)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total P&L</CardDescription>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${totalPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {totalPnl >= 0 ? "+" : ""}{formatUsd(totalPnl)}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Win Rate</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {activeHoldings.length > 0 ? ((winCount / activeHoldings.length) * 100).toFixed(0) : 0}%
                </div>
                <p className="text-xs text-muted-foreground">{winCount}/{activeHoldings.length} positions</p>
              </CardContent>
            </Card>
          </div>

          {holdingsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : activeHoldings.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Briefcase className="h-10 w-10 mb-2 opacity-50" />
                <p>No active positions</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {activeHoldings.map((holding) => {
                const currentVal = holding.lastPrice ? holding.currentAmount * holding.lastPrice : 0;
                const pnl = currentVal - holding.costBasis;
                const pnlPercent = (pnl / holding.costBasis) * 100;

                return (
                  <Card key={holding.id}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <div className="font-semibold">{holding.tokenSymbol || "Unknown"}</div>
                          <div className="text-sm text-muted-foreground">
                            {formatSol(holding.currentAmount)} @ {holding.lastPrice?.toFixed(6) || "?"} SOL
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">{formatUsd(currentVal)}</div>
                          <div className={`text-sm ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {pnl >= 0 ? "+" : ""}{formatUsd(pnl)} ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
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
                    <CardDescription>Active Positions</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{activeHoldings.length}</div>
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                System Picks Fund
              </CardTitle>
              <CardDescription>1 SOL simulated trading performance</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Fund Value</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">1.00 SOL</div>
                    <p className="text-xs text-muted-foreground">Starting capital</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Total Picks</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">—</div>
                    <p className="text-xs text-muted-foreground">System enabled trades</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Win Rate</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">—</div>
                    <p className="text-xs text-muted-foreground">Successful picks</p>
                  </CardContent>
                </Card>
              </div>

              <div className="border-t pt-4">
                <p className="text-sm text-muted-foreground">System picks are disabled until validation gates are met (30%+ gain, 50+ trades, 65%+ win rate).</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
