import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, TrendingUp, Zap, Wallet, Compass, BarChart3, Flame } from "lucide-react";

interface FundStats {
  solAllocated: number;
  currentValue: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  profitFactor: number;
  activePosition?: {
    tokenMint: string;
    entryPrice: number;
    currentPrice: number;
    tokenCount: number;
  };
}

interface ClusterSummary {
  clusterId: string;
  pattern: string;
  successRate: number;
  medianMultiplier: number;
  tokenCount: number;
  topHolders: number;
  rugRate: number;
}

interface WhaleSummary {
  walletAddress: string;
  rank: number;
  winRate: number;
  sharpeRatio: number;
  totalPnl7d: number;
  discoveryConfidence: number;
}

interface TokenLaunch {
  mint: string;
  symbol: string;
  name: string;
  bondingProgress: number;
  clusterMatch?: {
    clusterId: string;
    confidence: number;
  };
  whaleSignals: string[];
  annPrediction: number;
  age: number;
}

interface TokenLeaderboardEntry {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  projectedGain: number;
  confidence: number;
  bondingProgress: number;
  clusterMatch: number;
  annScore: number;
  whaleCount: number;
  riskScore: number;
}

interface WalletLeaderboardEntry {
  walletAddress: string;
  rank: number;
  winRate: number;
  sharpeRatio: number;
  pnl7d: number;
  confidence: number;
  totalTrades: number;
  lastActive: Date;
}

export default function DashboardConsolidated() {
  const [activeTab, setActiveTab] = useState("overview");

  // Fetch fund stats
  const { data: fundStats, isLoading: fundLoading } = useQuery({
    queryKey: ["/api/system/fund-stats"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/system/fund-stats");
      return response as FundStats;
    },
    staleTime: 30000,
  });

  // Fetch clusters
  const { data: clusters, isLoading: clustersLoading } = useQuery({
    queryKey: ["/api/clusters/summary"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/clusters/summary");
      return response as ClusterSummary[];
    },
    staleTime: 60000,
  });

  // Fetch whales
  const { data: whales, isLoading: whalesLoading } = useQuery({
    queryKey: ["/api/whales/top"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/whales/top");
      return response as WhaleSummary[];
    },
    staleTime: 60000,
  });

  // Fetch active tokens
  const { data: tokens, isLoading: tokensLoading } = useQuery({
    queryKey: ["/api/tokens/active"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/tokens/active");
      return response as TokenLaunch[];
    },
    staleTime: 30000,
  });

  // Fetch token leaderboard
  const { data: leaderboard, isLoading: leaderboardLoading } = useQuery({
    queryKey: ["/api/tokens/leaderboard"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/tokens/leaderboard");
      return response as TokenLeaderboardEntry[];
    },
    staleTime: 30000,
  });

  // Fetch wallet leaderboard
  const { data: walletLeaderboard, isLoading: walletLeaderboardLoading } = useQuery({
    queryKey: ["/api/wallets/leaderboard"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/wallets/leaderboard");
      return response as WalletLeaderboardEntry[];
    },
    staleTime: 60000,
  });

  const isLoading = fundLoading || clustersLoading || whalesLoading || tokensLoading || leaderboardLoading || walletLeaderboardLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full h-screen overflow-auto bg-background">
      <div className="p-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Penny Pincher System</h1>
          <p className="text-muted-foreground">Real-time token clustering and whale signal monitoring</p>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-7 mb-8 gap-1">
            <TabsTrigger value="overview" className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">Overview</span>
            </TabsTrigger>
            <TabsTrigger value="clusters" className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              <span className="hidden sm:inline">Clusters</span>
            </TabsTrigger>
            <TabsTrigger value="whales" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              <span className="hidden sm:inline">Whales</span>
            </TabsTrigger>
            <TabsTrigger value="fund" className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              <span className="hidden sm:inline">Fund</span>
            </TabsTrigger>
            <TabsTrigger value="tokens" className="flex items-center gap-2">
              <Compass className="h-4 w-4" />
              <span className="hidden sm:inline">Tokens</span>
            </TabsTrigger>
            <TabsTrigger value="leaderboard" className="flex items-center gap-2">
              <Flame className="h-4 w-4" />
              <span className="hidden sm:inline">Leaderboard</span>
            </TabsTrigger>
            <TabsTrigger value="wallets" className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              <span className="hidden sm:inline">Wallets</span>
            </TabsTrigger>
          </TabsList>

          {/* OVERVIEW TAB */}
          <TabsContent value="overview" className="space-y-6">
            {/* Fund Stats Grid */}
            <div className="grid grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Fund Value</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">${fundStats?.currentValue.toFixed(2) || "0.00"}</div>
                  <p className={`text-xs mt-1 ${fundStats?.totalPnl && fundStats.totalPnl > 0 ? "text-green-600" : "text-red-600"}`}>
                    {fundStats?.totalPnl && fundStats.totalPnl > 0 ? "+" : ""}{fundStats?.totalPnl.toFixed(2) || "0.00"}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{((fundStats?.winRate || 0) * 100).toFixed(0)}%</div>
                  <p className="text-xs text-muted-foreground mt-1">{fundStats?.totalTrades || 0} trades</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Profit Factor</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{fundStats?.profitFactor.toFixed(2) || "0.00"}x</div>
                  <p className="text-xs text-muted-foreground mt-1">Gross profit / loss</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Active Position</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {fundStats?.activePosition ? `${fundStats.activePosition.currentPrice.toFixed(8)}` : "None"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {fundStats?.activePosition ? `${fundStats.activePosition.tokenCount.toLocaleString()} tokens` : "No active trade"}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Clusters & Whales Grid */}
            <div className="grid grid-cols-2 gap-6">
              {/* Clusters Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Active Clusters ({clusters?.length || 0})</CardTitle>
                  <CardDescription>Top performing patterns</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {clusters?.slice(0, 3).map((cluster) => (
                    <div key={cluster.clusterId} className="border rounded p-3">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-semibold">{cluster.pattern}</p>
                          <p className="text-xs text-muted-foreground">{cluster.tokenCount} tokens</p>
                        </div>
                        <Badge variant={cluster.successRate > 0.7 ? "default" : "secondary"}>
                          {(cluster.successRate * 100).toFixed(0)}%
                        </Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <p className="text-muted-foreground">Multiplier</p>
                          <p className="font-semibold">{cluster.medianMultiplier.toFixed(1)}x</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Rug Rate</p>
                          <p className="font-semibold text-red-600">{(cluster.rugRate * 100).toFixed(0)}%</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Holders</p>
                          <p className="font-semibold">{cluster.topHolders}</p>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="w-full mt-3">
                        View Details
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Whales Summary */}
              <Card>
                <CardHeader>
                  <CardTitle>Top Whales ({whales?.length || 0})</CardTitle>
                  <CardDescription>Discovered high-quality traders</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {whales?.slice(0, 3).map((whale) => (
                    <div key={whale.walletAddress} className="border rounded p-3">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-semibold">#{whale.rank}</p>
                          <p className="text-xs font-mono text-muted-foreground">
                            {whale.walletAddress.slice(0, 8)}...{whale.walletAddress.slice(-6)}
                          </p>
                        </div>
                        <Badge>{(whale.winRate * 100).toFixed(0)}% W/R</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <p className="text-muted-foreground">Sharpe</p>
                          <p className="font-semibold">{whale.sharpeRatio.toFixed(2)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">PnL 7d</p>
                          <p className={`font-semibold ${whale.totalPnl7d > 0 ? "text-green-600" : "text-red-600"}`}>
                            ${whale.totalPnl7d.toFixed(2)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Confidence</p>
                          <p className="font-semibold">{(whale.discoveryConfidence * 100).toFixed(0)}%</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* CLUSTERS TAB */}
          <TabsContent value="clusters">
            <Card>
              <CardHeader>
                <CardTitle>All Clusters</CardTitle>
                <CardDescription>Token pattern archetypes and their performance</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {clusters?.map((cluster) => (
                    <div key={cluster.clusterId} className="border rounded p-4">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <p className="font-bold text-lg">{cluster.pattern}</p>
                          <p className="text-sm text-muted-foreground">ID: {cluster.clusterId}</p>
                        </div>
                        <Badge variant={cluster.successRate > 0.7 ? "default" : "secondary"} className="text-lg px-4 py-2">
                          {(cluster.successRate * 100).toFixed(0)}% Success
                        </Badge>
                      </div>
                      <div className="grid grid-cols-5 gap-4 text-sm mb-4">
                        <div>
                          <p className="text-muted-foreground">Median Multiplier</p>
                          <p className="font-bold text-lg">{cluster.medianMultiplier.toFixed(1)}x</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Tokens</p>
                          <p className="font-bold text-lg">{cluster.tokenCount}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Top Holders</p>
                          <p className="font-bold text-lg">{cluster.topHolders}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Rug Rate</p>
                          <p className="font-bold text-lg text-red-600">{(cluster.rugRate * 100).toFixed(0)}%</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Status</p>
                          <Badge variant="outline" className="mt-2">Active</Badge>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline">View Details</Button>
                        <Button size="sm" variant="outline">Token List</Button>
                        <Button size="sm" variant="outline">Backtest</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* WHALES TAB */}
          <TabsContent value="whales">
            <Card>
              <CardHeader>
                <CardTitle>Discovered Whales</CardTitle>
                <CardDescription>High-quality wallets ranked by trading performance</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {whales?.map((whale) => (
                    <div key={whale.walletAddress} className="border rounded p-4 flex justify-between items-center">
                      <div className="flex-1">
                        <p className="font-bold">Rank #{whale.rank}</p>
                        <p className="text-sm font-mono text-muted-foreground">{whale.walletAddress}</p>
                        <div className="flex gap-4 mt-2 text-sm">
                          <span>Win Rate: <span className="font-semibold">{(whale.winRate * 100).toFixed(0)}%</span></span>
                          <span>Sharpe: <span className="font-semibold">{whale.sharpeRatio.toFixed(2)}</span></span>
                          <span>PnL 7d: <span className={`font-semibold ${whale.totalPnl7d > 0 ? "text-green-600" : "text-red-600"}`}>${whale.totalPnl7d.toFixed(2)}</span></span>
                          <span>Confidence: <span className="font-semibold">{(whale.discoveryConfidence * 100).toFixed(0)}%</span></span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline">Profile</Button>
                        <Button size="sm" variant="outline">Signals</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* FUND TAB */}
          <TabsContent value="fund">
            <Card>
              <CardHeader>
                <CardTitle>System-Picks Fund (1 SOL)</CardTitle>
                <CardDescription>Paper trading validation for real-money trading</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {fundStats?.activePosition ? (
                  <div className="border rounded p-6">
                    <h3 className="font-bold text-lg mb-4">Current Position</h3>
                    <div className="grid grid-cols-3 gap-6 mb-6">
                      <div>
                        <p className="text-sm text-muted-foreground">Entry Price</p>
                        <p className="text-2xl font-bold">${fundStats.activePosition.entryPrice.toFixed(8)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Current Price</p>
                        <p className="text-2xl font-bold">${fundStats.activePosition.currentPrice.toFixed(8)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Multiplier</p>
                        <p className={`text-2xl font-bold ${fundStats.activePosition.currentPrice >= fundStats.activePosition.entryPrice ? "text-green-600" : "text-red-600"}`}>
                          {(fundStats.activePosition.currentPrice / fundStats.activePosition.entryPrice).toFixed(2)}x
                        </p>
                      </div>
                    </div>
                    <div className="mb-6">
                      <p className="text-sm text-muted-foreground">Tokens Held</p>
                      <p className="text-lg font-semibold">{fundStats.activePosition.tokenCount.toLocaleString()}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button>Close Position</Button>
                      <Button variant="outline">Adjust Stops</Button>
                      <Button variant="outline">View History</Button>
                    </div>
                  </div>
                ) : (
                  <div className="border rounded p-6 text-center py-12">
                    <p className="text-muted-foreground mb-4">No active position</p>
                    <Button>Enter Next Trade</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TOKENS TAB */}
          <TabsContent value="tokens">
            <Card>
              <CardHeader>
                <CardTitle>Active Token Launches</CardTitle>
                <CardDescription>New tokens with cluster matches and whale signals</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {tokens?.map((token) => (
                    <div key={token.mint} className="border rounded p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <p className="font-bold">{token.symbol} - {token.name}</p>
                          <p className="text-xs font-mono text-muted-foreground">{token.mint.slice(0, 12)}...</p>
                        </div>
                        <Badge variant="outline">{token.bondingProgress.toFixed(0)}% bonding</Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-sm mb-4">
                        <div>
                          <p className="text-muted-foreground">Cluster Match</p>
                          <p className="font-semibold">
                            {token.clusterMatch ? `${token.clusterMatch.confidence * 100 | 0}% confidence` : "No match"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Whale Signals</p>
                          <p className="font-semibold">{token.whaleSignals.length} detected</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">ANN Score</p>
                          <p className="font-semibold">{token.annPrediction.toFixed(1)}/10</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm">Enter Trade</Button>
                        <Button size="sm" variant="outline">Monitor</Button>
                        <Button size="sm" variant="ghost">Details</Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* LEADERBOARD TAB */}
          <TabsContent value="leaderboard">
            <Card>
              <CardHeader>
                <CardTitle>Token Leaderboard</CardTitle>
                <CardDescription>Ranked by projected potential gains</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {leaderboard?.map((token) => (
                    <div
                      key={token.mint}
                      className="border rounded p-4 hover:bg-accent transition-colors"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-4 flex-1">
                          <div className="text-center min-w-[60px]">
                            <p className="text-2xl font-bold text-primary">#{token.rank}</p>
                            <p className="text-xs text-muted-foreground">Rank</p>
                          </div>
                          <div className="flex-1">
                            <p className="font-bold text-lg">{token.symbol}</p>
                            <p className="text-xs font-mono text-muted-foreground">
                              {token.mint.slice(0, 16)}...
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-green-600">
                            {token.projectedGain.toFixed(1)}x
                          </p>
                          <p className="text-xs text-muted-foreground">Projected Gain</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-6 gap-3 text-sm">
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Confidence</p>
                          <p className="font-semibold">{(token.confidence * 100).toFixed(0)}%</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Bonding</p>
                          <p className="font-semibold">{token.bondingProgress.toFixed(0)}%</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Cluster Match</p>
                          <p className="font-semibold">{(token.clusterMatch * 100).toFixed(0)}%</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">ANN Score</p>
                          <p className="font-semibold">{token.annScore.toFixed(1)}/10</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Whales</p>
                          <p className="font-semibold">{token.whaleCount}</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Risk</p>
                          <p className={`font-semibold ${token.riskScore < 0.3 ? "text-green-600" : token.riskScore < 0.7 ? "text-yellow-600" : "text-red-600"}`}>
                            {token.riskScore.toFixed(2)}
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-2 mt-3">
                        <Button size="sm" className="flex-1">
                          Enter Trade
                        </Button>
                        <Button size="sm" variant="outline">
                          Details
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* WALLETS LEADERBOARD TAB */}
          <TabsContent value="wallets">
            <Card>
              <CardHeader>
                <CardTitle>Wallet Leaderboard</CardTitle>
                <CardDescription>Discovered wallets ranked by trading quality</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {walletLeaderboard?.map((wallet) => (
                    <div
                      key={wallet.walletAddress}
                      className="border rounded p-4 hover:bg-accent transition-colors"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-4 flex-1">
                          <div className="text-center min-w-[60px]">
                            <p className="text-2xl font-bold text-primary">#{wallet.rank}</p>
                            <p className="text-xs text-muted-foreground">Rank</p>
                          </div>
                          <div className="flex-1">
                            <p className="font-bold text-lg font-mono">
                              {wallet.walletAddress.slice(0, 12)}...{wallet.walletAddress.slice(-6)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {wallet.totalTrades} trades • Active {new Date(wallet.lastActive).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-2xl font-bold text-green-600">
                            {wallet.sharpeRatio.toFixed(2)}
                          </p>
                          <p className="text-xs text-muted-foreground">Sharpe Ratio</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-3 text-sm">
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Win Rate</p>
                          <p className="font-semibold">{(wallet.winRate * 100).toFixed(0)}%</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">PnL 7d</p>
                          <p className={`font-semibold ${wallet.pnl7d > 0 ? "text-green-600" : "text-red-600"}`}>
                            ${wallet.pnl7d.toFixed(2)}
                          </p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Confidence</p>
                          <p className="font-semibold">{(wallet.confidence * 100).toFixed(0)}%</p>
                        </div>
                        <div className="bg-muted rounded p-2">
                          <p className="text-muted-foreground text-xs">Trades</p>
                          <p className="font-semibold">{wallet.totalTrades}</p>
                        </div>
                      </div>

                      <div className="flex gap-2 mt-3">
                        <Button size="sm" className="flex-1">
                          Copy Trades
                        </Button>
                        <Button size="sm" variant="outline">
                          History
                        </Button>
                        <Button size="sm" variant="ghost">
                          Profile
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
