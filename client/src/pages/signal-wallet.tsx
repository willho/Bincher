import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { touchSignalWallet } from "@/hooks/use-wallet-navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { ArrowLeft, RefreshCw, TrendingUp, TrendingDown, Clock, Target, Wallet, Activity, ExternalLink, Copy, Coins, ArrowUpDown, Trophy, Timer, Settings, ChevronDown, ChevronUp, Sparkles, Brain, Zap, Shield, AlertTriangle, FileText, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSolPrice } from "@/hooks/use-sol-price";
import { SignalWalletActivityChart } from "@/components/portfolio-charts";

interface AiRecommendation {
  category: "strength" | "weakness" | "copy_setting" | "risk_warning" | "optimization";
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
}

interface DiscoveryContext {
  behaviorType: string;
  behaviorConfidence: number;
  followsLeaders: string[];
  leadsFollowers: string[];
  recentInsights: Array<{
    title: string;
    type: string;
    source: string;
    confidence: number;
  }>;
}

interface StrategyAnalysis {
  strategyType: string;
  tradingStyle: string;
  avgHoldDuration: number;
  avgPositionSize: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  preferredEntryTime: string;
  entryTokenAge: string;
  entryMarketCap: string;
  takeProfitMultiplier: number;
  stopLossPercent: number;
  riskLevel: number;
  maxConcurrentPositions: number;
  confidenceScore: number;
  sampleSize: number;
  insights: string[];
  lastUpdatedAt?: number;
  aiRecommendations?: AiRecommendation[];
  discoveryContext?: DiscoveryContext;
  fromCache?: boolean;
}

interface Trade {
  id: number;
  signature: string;
  timestamp: number;
  type: string;
  fromToken: string;
  fromTokenSymbol: string;
  fromAmount: number;
  toToken: string;
  toTokenSymbol: string;
  toAmount: number;
  isBuy: boolean;
  solPriceAtTrade?: number;
  toTokenMetadata?: {
    name?: string;
    symbol?: string;
    marketCap?: number;
  };
}

interface MostTradedToken {
  mint: string;
  symbol: string;
  tradeCount: number;
}

interface TokenHolding {
  mint: string;
  symbol?: string;
  name?: string;
  amount: number;
  decimals: number;
  priceUsd?: number;
  valueUsd?: number;
  marketCap?: number;
  priceChange24h?: number;
}

type HoldingsSortOption = "value" | "name" | "change" | "age";
type HoldingsTab = "signal" | "copied";

interface CopiedHolding {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  amountBought: number;
  currentAmount: number;
  solSpent: number;
  buyPrice: number;
  buyTimestamp: number;
  lastPrice?: number;
  signalWalletId?: number;
  sourceWalletLabel?: string;
}

interface WalletActivity {
  wallet: {
    id: number;
    address: string;
    label: string | null;
    copyTradeEnabled: boolean;
    enabled: boolean;
  };
  timeframe: string;
  trades: Trade[];
  stats: {
    totalTrades: number;
    buys: number;
    sells: number;
    closedPositions: number;
    profitableTrades: number;
    hitRate: number;
    totalSolSpent: number;
    totalSolReceived: number;
    realizedPnl: number;
    mostTradedTokens: MostTradedToken[];
  };
  profile: {
    tradingStyle: string | null;
    winRate: number | null;
    avgExitMultiplier: number | null;
    totalTrades: number | null;
    lastTradeAt: number | null;
  } | null;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function getRiskColor(level: number): string {
  if (level <= 3) return "text-green-500";
  if (level <= 6) return "text-yellow-500";
  return "text-red-500";
}

function getStyleBadgeVariant(style: string): "default" | "secondary" | "outline" {
  switch (style) {
    case "aggressive": return "default";
    case "conservative": return "secondary";
    default: return "outline";
  }
}

export default function SignalWalletPage() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const walletId = params.id;
  const [timeframe, setTimeframe] = useState("24h");
  const [holdingsSort, setHoldingsSort] = useState<HoldingsSortOption>("value");
  const [holdingsTab, setHoldingsTab] = useState<HoldingsTab>("signal");
  const [showStrategyPanel, setShowStrategyPanel] = useState(false);
  const { toast } = useToast();
  const { solToUsd, formatUsd } = useSolPrice();
  const wsRef = useRef<WebSocket | null>(null);

  // Touch wallet on mount to refresh lastViewedAt (resets decay timer)
  useEffect(() => {
    if (walletId) {
      touchSignalWallet(parseInt(walletId));
    }
  }, [walletId]);

  const { data: holdingsData, isLoading: holdingsLoading, refetch: refetchHoldings } = useQuery<{ holdings: TokenHolding[] }>({
    queryKey: ["/api/signal-wallets", walletId, "holdings"],
    queryFn: async () => {
      const response = await fetch(`/api/signal-wallets/${walletId}/holdings`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load holdings");
      return response.json();
    },
    enabled: !!walletId,
    staleTime: 60000, // Cache for 1 minute
  });

  const { data: activity, isLoading, refetch } = useQuery<WalletActivity>({
    queryKey: ["/api/signal-wallets", walletId, "activity", timeframe],
    queryFn: async () => {
      const response = await fetch(`/api/signal-wallets/${walletId}/activity?timeframe=${timeframe}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load activity");
      return response.json();
    },
    enabled: !!walletId,
    refetchInterval: 30000,
  });

  // Fetch user's copied holdings from this signal wallet
  const { data: userHoldings } = useQuery<CopiedHolding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  // Filter user holdings to only those from this signal wallet
  const myCopiedHoldings = useMemo(() => {
    if (!userHoldings || !walletId) return [];
    const id = parseInt(walletId);
    return userHoldings.filter((h) => h.signalWalletId === id && h.currentAmount > 0);
  }, [userHoldings, walletId]);

  const backfillMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/signal-wallets/${walletId}/backfill`),
    onSuccess: (data: any) => {
      const parts = [];
      if (data.swapsStored > 0) parts.push(`${data.swapsStored} new`);
      if (data.swapsUpdated > 0) parts.push(`${data.swapsUpdated} updated`);
      const summary = parts.length > 0 ? parts.join(", ") : "no changes";
      toast({ 
        description: `Refreshed! Found ${data.swapsFound} swaps (${summary}).` 
      });
      refetch();
    },
    onError: (error: any) => {
      toast({ 
        description: error.message || "Failed to refresh history", 
        variant: "destructive" 
      });
    },
  });

  const hasAutoBackfilled = useRef(false);
  useEffect(() => {
    if (walletId && !hasAutoBackfilled.current) {
      hasAutoBackfilled.current = true;
      backfillMutation.mutate();
    }
  }, [walletId]);

  const walletAddress = activity?.wallet?.address;

  const { data: strategyData, isLoading: strategyLoading, refetch: refetchStrategy } = useQuery<{ analysis: StrategyAnalysis } | null>({
    queryKey: ["/api/paper/strategies", walletAddress, "analysis"],
    queryFn: async () => {
      if (!walletAddress) return null;
      const response = await fetch(`/api/paper/strategies/${walletAddress}`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (data.sampleSize && data.sampleSize > 0) {
        // Parse aiRecommendations if stored as JSON string
        let aiRecommendations = data.aiRecommendations;
        if (typeof aiRecommendations === 'string') {
          try {
            aiRecommendations = JSON.parse(aiRecommendations);
          } catch {
            aiRecommendations = undefined;
          }
        }
        return { analysis: { ...data, aiRecommendations } as StrategyAnalysis };
      }
      return null;
    },
    enabled: !!walletAddress, // Auto-fetch when wallet is available
    staleTime: 300000,
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      if (!walletAddress) throw new Error("No wallet address");
      return apiRequest("POST", `/api/paper/strategies/${walletAddress}/analyze`);
    },
    onSuccess: () => {
      toast({ description: "Strategy analysis complete" });
      refetchStrategy();
    },
    onError: (error: any) => {
      toast({ 
        description: error.message || "Failed to analyze strategy", 
        variant: "destructive" 
      });
    },
  });

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "NEW_SWAP" && activity?.wallet) {
          if (data.swap.source === activity.wallet.address) {
            refetch();
          }
        }
      } catch (e) {
        console.error("WS parse error:", e);
      }
    };

    return () => {
      ws.close();
    };
  }, [activity?.wallet?.address, refetch]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: "Copied to clipboard" });
  };

  // Build a map of token mint -> first buy timestamp from trades
  const tokenFirstBuyMap = useMemo(() => {
    const map = new Map<string, number>();
    const trades = activity?.trades || [];
    // Process trades in reverse (oldest first) to get the first buy
    [...trades].reverse().forEach((trade) => {
      if (trade.isBuy && !map.has(trade.toToken)) {
        map.set(trade.toToken, trade.timestamp);
      }
    });
    return map;
  }, [activity?.trades]);

  // Sort holdings based on selected option
  const sortedHoldings = useMemo(() => {
    const holdings = holdingsData?.holdings || [];
    return [...holdings].sort((a, b) => {
      switch (holdingsSort) {
        case "value":
          return (b.valueUsd || 0) - (a.valueUsd || 0);
        case "name":
          return (a.symbol || a.mint).localeCompare(b.symbol || b.mint);
        case "change":
          return (b.priceChange24h || 0) - (a.priceChange24h || 0);
        case "age":
          // Oldest first (smallest timestamp = oldest)
          const aTime = tokenFirstBuyMap.get(a.mint) || Date.now();
          const bTime = tokenFirstBuyMap.get(b.mint) || Date.now();
          return aTime - bTime;
        default:
          return 0;
      }
    });
  }, [holdingsData?.holdings, holdingsSort, tokenFirstBuyMap]);

  // Calculate unrealized PnL from current holdings
  const unrealizedPnl = useMemo(() => {
    const holdings = holdingsData?.holdings || [];
    const trades = activity?.trades || [];
    
    let totalCost = 0;
    let totalValue = 0;
    
    holdings.forEach((holding) => {
      // Find buy trades for this token to calculate cost basis
      const buyTrades = trades.filter((t) => t.isBuy && t.toToken === holding.mint);
      const totalBought = buyTrades.reduce((sum, t) => sum + t.toAmount, 0);
      const totalSpent = buyTrades.reduce((sum, t) => sum + (t.fromAmount * (t.solPriceAtTrade || 0)), 0);
      
      if (totalBought > 0 && holding.amount > 0) {
        const avgCostPerToken = totalSpent / totalBought;
        totalCost += avgCostPerToken * Math.min(holding.amount, totalBought);
      }
      totalValue += holding.valueUsd || 0;
    });
    
    return { cost: totalCost, value: totalValue, pnl: totalValue - totalCost };
  }, [holdingsData?.holdings, activity?.trades]);

  // Calculate best performing token
  const bestToken = useMemo((): { mint: string; symbol: string; pnl: number; pnlPercent: number } | null => {
    const trades = activity?.trades || [];
    const tokenPnL = new Map<string, { symbol: string; pnl: number; spent: number; received: number }>();
    
    trades.forEach((trade) => {
      const tokenMint = trade.isBuy ? trade.toToken : trade.fromToken;
      const symbol = trade.isBuy ? trade.toTokenSymbol : trade.fromTokenSymbol;
      
      if (!tokenPnL.has(tokenMint)) {
        tokenPnL.set(tokenMint, { symbol, pnl: 0, spent: 0, received: 0 });
      }
      
      const data = tokenPnL.get(tokenMint)!;
      const usdValue = trade.isBuy 
        ? trade.fromAmount * (trade.solPriceAtTrade || 0)
        : trade.toAmount * (trade.solPriceAtTrade || 0);
      
      if (trade.isBuy) {
        data.spent += usdValue;
      } else {
        data.received += usdValue;
      }
      data.pnl = data.received - data.spent;
    });
    
    let best: { mint: string; symbol: string; pnl: number; pnlPercent: number } | null = null;
    tokenPnL.forEach((data, mint) => {
      if (data.received > 0 && data.spent > 0) {
        const pnlPercent = ((data.received - data.spent) / data.spent) * 100;
        if (!best || pnlPercent > best.pnlPercent) {
          best = { mint, symbol: data.symbol, pnl: data.pnl, pnlPercent };
        }
      }
    });
    
    return best;
  }, [activity?.trades]);

  // Calculate average hold time for closed positions
  const avgHoldTime = useMemo(() => {
    const trades = activity?.trades || [];
    const tokenBuyTimes = new Map<string, number[]>();
    const holdTimes: number[] = [];
    
    // First pass: collect buy timestamps
    trades.forEach((trade) => {
      if (trade.isBuy) {
        const times = tokenBuyTimes.get(trade.toToken) || [];
        times.push(trade.timestamp);
        tokenBuyTimes.set(trade.toToken, times);
      }
    });
    
    // Second pass: calculate hold times for sells
    trades.forEach((trade) => {
      if (!trade.isBuy) {
        const buyTimes = tokenBuyTimes.get(trade.fromToken);
        if (buyTimes && buyTimes.length > 0) {
          const firstBuy = Math.min(...buyTimes);
          holdTimes.push(trade.timestamp - firstBuy);
        }
      }
    });
    
    if (holdTimes.length === 0) return null;
    const avgSeconds = holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
    
    // Format as human readable
    if (avgSeconds < 3600) return `${Math.round(avgSeconds / 60)}m`;
    if (avgSeconds < 86400) return `${Math.round(avgSeconds / 3600)}h`;
    return `${Math.round(avgSeconds / 86400)}d`;
  }, [activity?.trades]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="space-y-6">
        <Link href="/signals">
          <Button variant="ghost" size="sm" data-testid="button-back">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Signal Wallets
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            Wallet not found or you don't have access.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { wallet, trades, stats, profile } = activity;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <Link href="/signals">
            <Button variant="ghost" size="sm" data-testid="button-back">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-wallet-title">
              <Wallet className="h-6 w-6" />
              {wallet.label || "Signal Wallet"}
            </h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span data-testid="text-wallet-address">{truncateAddress(wallet.address)}</span>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-6 w-6"
                onClick={() => copyToClipboard(wallet.address)}
                data-testid="button-copy-address"
              >
                <Copy className="h-3 w-3" />
              </Button>
              <a 
                href={`https://solscan.io/account/${wallet.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
                data-testid="link-solscan"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant={wallet.copyTradeEnabled ? "default" : "outline"}
            size="sm"
            onClick={() => navigate(`/signal/${wallet.id}/copy-settings`)}
            data-testid="button-copy-settings"
          >
            <Copy className="h-4 w-4 mr-2" />
            {wallet.copyTradeEnabled ? "Copy Trading Active" : "Configure Copy Trading"}
          </Button>
          <Link href={`/paper?wallet=${wallet.address}&mode=copy`}>
            <Button 
              variant="secondary"
              size="sm"
              data-testid="button-paper-copy"
            >
              <FileText className="h-4 w-4 mr-2" />
              Paper Copy
            </Button>
          </Link>
          <Button 
            variant="ghost" 
            size="icon"
            onClick={() => navigate(`/signal/${wallet.id}/copy-settings`)}
            data-testid="button-settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${backfillMutation.isPending ? "animate-spin" : ""}`} />
            {backfillMutation.isPending ? "Refreshing..." : "Refresh History"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Timeframe:</span>
        <Tabs value={timeframe} onValueChange={setTimeframe}>
          <TabsList>
            <TabsTrigger value="24h" data-testid="tab-24h">24h</TabsTrigger>
            <TabsTrigger value="7d" data-testid="tab-7d">7d</TabsTrigger>
            <TabsTrigger value="30d" data-testid="tab-30d">30d</TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {/* Combined P&L Card */}
        <Card data-testid="card-pnl-combined">
          <CardHeader className="pb-2">
            <CardDescription>Profit & Loss</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Realized</span>
                <span className={`text-lg font-bold ${stats.realizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {stats.realizedPnl >= 0 ? "+" : ""}{stats.realizedPnl} SOL
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {stats.totalSolSpent} spent → {stats.totalSolReceived} received
              </p>
            </div>
            <div className="border-t pt-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Unrealized</span>
                <span className={`text-lg font-bold ${unrealizedPnl.pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {unrealizedPnl.pnl >= 0 ? "+" : ""}{formatUsd(unrealizedPnl.pnl)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Holdings worth {formatUsd(unrealizedPnl.value)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Combined Performance Card */}
        <Card data-testid="card-performance">
          <CardHeader className="pb-2">
            <CardDescription>Performance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" />
                <span className="text-sm">Hit Rate</span>
              </div>
              <span className="font-bold">{stats.hitRate}%</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <span className="text-sm">Trades</span>
              </div>
              <span className="font-bold">{stats.totalTrades}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-primary" />
                <span className="text-sm">Avg Hold</span>
              </div>
              <span className="font-bold">{avgHoldTime || "-"}</span>
            </div>
            <div className="border-t pt-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Style</span>
              <Badge variant="secondary" className="capitalize">
                {profile?.tradingStyle || "Unknown"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Best Token Card */}
        <Card data-testid="card-best-token">
          <CardHeader className="pb-2">
            <CardDescription>Best Token</CardDescription>
          </CardHeader>
          <CardContent>
            {bestToken ? (
              <Link
                href={`/trading/${bestToken.mint}`}
                className="hover:underline"
                data-testid="link-best-token"
              >
                <div className="flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-yellow-500" />
                  <span className="text-2xl font-bold">
                    {bestToken.symbol}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="text-green-500">+{bestToken.pnlPercent.toFixed(0)}%</span> return
                </p>
              </Link>
            ) : (
              <div className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-yellow-500" />
                <span className="text-2xl font-bold">-</span>
              </div>
            )}
            <div className="mt-3 pt-2 border-t text-xs text-muted-foreground">
              {stats.profitableTrades}/{stats.closedPositions} profitable · {stats.buys} buys, {stats.sells} sells
            </div>
          </CardContent>
        </Card>
      </div>

      <SignalWalletActivityChart trades={trades} />

      {/* Pincher's Strategy Panel */}
      <Card data-testid="card-pincher-strategy">
        <CardHeader 
          className="cursor-pointer hover-elevate"
          onClick={() => setShowStrategyPanel(!showStrategyPanel)}
          data-testid="button-toggle-strategy"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">Pincher's Strategy Analysis</CardTitle>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              {showStrategyPanel ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
          <CardDescription>
            AI-analyzed trading patterns and strategy recommendations
          </CardDescription>
        </CardHeader>
        
        {showStrategyPanel && (
          <CardContent className="space-y-4">
            {strategyLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : !strategyData ? (
              <div className="text-center py-6">
                <Brain className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground mb-4">
                  No strategy analysis yet. Analyze trading history to see patterns.
                </p>
                <Button 
                  onClick={() => analyzeMutation.mutate()}
                  disabled={analyzeMutation.isPending}
                  data-testid="button-analyze-strategy"
                >
                  {analyzeMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4 mr-2" />
                      Analyze Strategy
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={getStyleBadgeVariant(strategyData.analysis.tradingStyle)} className="capitalize">
                      {strategyData.analysis.tradingStyle}
                    </Badge>
                    <Badge variant="outline" className="capitalize">
                      {strategyData.analysis.strategyType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                    <span>Based on {strategyData.analysis.sampleSize} trades</span>
                    {strategyData.analysis.lastUpdatedAt && (
                      <span className="text-xs">
                        (analyzed {formatRelativeTime(strategyData.analysis.lastUpdatedAt)})
                      </span>
                    )}
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7"
                      onClick={() => analyzeMutation.mutate()}
                      disabled={analyzeMutation.isPending}
                      data-testid="button-refresh-strategy"
                    >
                      <RefreshCw className={`h-3 w-3 ${analyzeMutation.isPending ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Confidence</span>
                    <span>{Math.round(strategyData.analysis.confidenceScore * 100)}%</span>
                  </div>
                  <Progress value={strategyData.analysis.confidenceScore * 100} className="h-2" />
                </div>

                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Trophy className="h-4 w-4" />
                      <span>Win Rate</span>
                    </div>
                    <p className="text-xl font-bold">
                      {(strategyData.analysis.winRate * 100).toFixed(1)}%
                    </p>
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Timer className="h-4 w-4" />
                      <span>Avg Hold</span>
                    </div>
                    <p className="text-xl font-bold">
                      {formatDuration(strategyData.analysis.avgHoldDuration)}
                    </p>
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Coins className="h-4 w-4" />
                      <span>Avg Size</span>
                    </div>
                    <p className="text-xl font-bold">
                      {strategyData.analysis.avgPositionSize.toFixed(2)} SOL
                    </p>
                  </div>
                  
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Shield className="h-4 w-4" />
                      <span>Risk Level</span>
                    </div>
                    <p className={`text-xl font-bold ${getRiskColor(strategyData.analysis.riskLevel)}`}>
                      {strategyData.analysis.riskLevel}/10
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="p-3 rounded-md bg-secondary/30">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-green-500" />
                      Entry Patterns
                    </h4>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Preferred Time</span>
                        <span>{strategyData.analysis.preferredEntryTime}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Token Age</span>
                        <span className="capitalize">{strategyData.analysis.entryTokenAge}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Market Cap</span>
                        <span className="capitalize">{strategyData.analysis.entryMarketCap}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="p-3 rounded-md bg-secondary/30">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <TrendingDown className="h-4 w-4 text-red-500" />
                      Exit Patterns
                    </h4>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Take Profit</span>
                        <span className="text-green-500">
                          {((strategyData.analysis.takeProfitMultiplier - 1) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Stop Loss</span>
                        <span className="text-red-500">
                          -{(strategyData.analysis.stopLossPercent * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Profit Factor</span>
                        <span>{strategyData.analysis.profitFactor.toFixed(2)}x</span>
                      </div>
                    </div>
                  </div>
                </div>

                {strategyData.analysis.discoveryContext && (
                  <div className="p-3 rounded-md border border-muted bg-muted/30">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Activity className="h-4 w-4" />
                      Discovery Classification
                    </h4>
                    <div className="flex flex-wrap gap-2 items-center">
                      <Badge 
                        variant={
                          strategyData.analysis.discoveryContext.behaviorType === 'leader' ? 'default' :
                          strategyData.analysis.discoveryContext.behaviorType === 'bot' ? 'destructive' :
                          strategyData.analysis.discoveryContext.behaviorType === 'follower' ? 'secondary' :
                          'outline'
                        }
                        className="capitalize"
                      >
                        {strategyData.analysis.discoveryContext.behaviorType}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        ({Math.round(strategyData.analysis.discoveryContext.behaviorConfidence * 100)}% confidence)
                      </span>
                      {strategyData.analysis.discoveryContext.leadsFollowers.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          • {strategyData.analysis.discoveryContext.leadsFollowers.length} followers
                        </span>
                      )}
                      {strategyData.analysis.discoveryContext.followsLeaders.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          • follows {strategyData.analysis.discoveryContext.followsLeaders.length} wallets
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {strategyData.analysis.insights && strategyData.analysis.insights.length > 0 && (
                  <div className="p-3 rounded-md border border-primary/30 bg-primary/5">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-primary" />
                      Pincher's Insights
                    </h4>
                    <ul className="space-y-1">
                      {strategyData.analysis.insights.map((insight, idx) => (
                        <li key={idx} className="text-sm flex items-start gap-2">
                          <span className="text-primary">•</span>
                          <span>{insight}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {strategyData.analysis.aiRecommendations && strategyData.analysis.aiRecommendations.length > 0 && (
                  <div className="p-4 rounded-md border border-accent/30 bg-accent/5 space-y-3">
                    <h4 className="text-sm font-medium flex items-center gap-2">
                      <Brain className="h-4 w-4 text-accent-foreground" />
                      Miss Pincher's Recommendations
                    </h4>
                    <div className="grid gap-3 md:grid-cols-2">
                      {strategyData.analysis.aiRecommendations.map((rec, idx) => {
                        const categoryIcons: Record<string, typeof Trophy> = {
                          strength: Trophy,
                          weakness: AlertTriangle,
                          copy_setting: Settings,
                          risk_warning: Shield,
                          optimization: TrendingUp,
                        };
                        const categoryColors: Record<string, string> = {
                          strength: "text-green-500",
                          weakness: "text-orange-500",
                          copy_setting: "text-blue-500",
                          risk_warning: "text-red-500",
                          optimization: "text-purple-500",
                        };
                        const priorityBadgeVariant = rec.priority === "high" ? "destructive" : rec.priority === "medium" ? "default" : "secondary";
                        const Icon = categoryIcons[rec.category] || Brain;
                        const iconColor = categoryColors[rec.category] || "text-muted-foreground";
                        
                        return (
                          <div key={idx} className="p-3 rounded-md border bg-card">
                            <div className="flex items-start gap-2">
                              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
                              <div className="space-y-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium text-sm">{rec.title}</span>
                                  <Badge variant={priorityBadgeVariant} className="text-xs capitalize">
                                    {rec.priority}
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground">{rec.description}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {stats.mostTradedTokens.length > 0 && (
        <Card data-testid="card-most-traded">
          <CardHeader>
            <CardTitle className="text-base">Most Traded Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {stats.mostTradedTokens.map((token) => (
                <Link 
                  key={token.mint}
                  href={`/trading/${token.mint}`}
                  data-testid={`link-token-${token.symbol}`}
                >
                  <Badge variant="secondary" className="hover:bg-secondary/80 cursor-pointer">
                    {token.symbol} ({token.tradeCount})
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-trades-list">
        <CardHeader>
          <CardTitle>Trade History</CardTitle>
        </CardHeader>
        <CardContent>
          {trades.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No trades found for this timeframe.
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => backfillMutation.mutate()}
                disabled={backfillMutation.isPending}
              >
                Refresh from blockchain
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Token</th>
                    <th className="pb-3 font-medium text-right">SOL Value</th>
                    <th className="pb-3 font-medium text-right">USD Value</th>
                    <th className="pb-3 font-medium text-right">Performance</th>
                    <th className="pb-3 font-medium text-right">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr 
                      key={trade.id} 
                      className="border-b last:border-0 hover-elevate"
                      data-testid={`row-trade-${trade.id}`}
                    >
                      <td className="py-3">
                        <div className="flex items-center gap-1 text-sm">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <span title={formatTime(trade.timestamp)}>
                            {formatRelativeTime(trade.timestamp)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatTime(trade.timestamp)}
                        </div>
                      </td>
                      <td className="py-3">
                        <Badge 
                          variant={trade.isBuy ? "default" : "secondary"}
                          className={trade.isBuy ? "bg-green-500/10 text-green-600 border-green-500/30" : "bg-red-500/10 text-red-600 border-red-500/30"}
                        >
                          {trade.isBuy ? "BUY" : "SELL"}
                        </Badge>
                      </td>
                      <td className="py-3">
                        <Link
                          href={`/trading/${trade.isBuy ? trade.toToken : trade.fromToken}`}
                          className="hover:underline"
                          data-testid={`link-trade-token-${trade.id}`}
                        >
                          <div className="font-medium">
                            {trade.isBuy 
                              ? (trade.toTokenMetadata?.name || trade.toTokenSymbol)
                              : (trade.fromTokenSymbol)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {trade.isBuy ? trade.toTokenSymbol : trade.fromTokenSymbol}
                            {trade.isBuy && trade.toAmount > 0 && ` · ${trade.toAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                            {!trade.isBuy && trade.fromAmount > 0 && ` · ${trade.fromAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                          </div>
                        </Link>
                      </td>
                      <td className="py-3 text-right">
                        <div className="font-medium">
                          {trade.isBuy 
                            ? trade.fromAmount.toFixed(4)
                            : trade.toAmount.toFixed(4)} SOL
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        {(() => {
                          const solAmount = trade.isBuy ? trade.fromAmount : trade.toAmount;
                          if (trade.solPriceAtTrade) {
                            return (
                              <div className="font-medium text-muted-foreground">
                                ${(solAmount * trade.solPriceAtTrade).toFixed(2)}
                              </div>
                            );
                          }
                          // Fallback to current SOL price
                          const usdValue = solToUsd(solAmount);
                          return usdValue > 0 ? (
                            <div className="font-medium text-muted-foreground" title="Using current SOL price">
                              ~{formatUsd(usdValue)}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">-</div>
                          );
                        })()}
                      </td>
                      <td className="py-3 text-right">
                        {(() => {
                          // For BUY trades, calculate performance based on current price
                          if (trade.isBuy) {
                            const tokenHolding = sortedHoldings.find(h => h.mint === trade.toToken);
                            if (tokenHolding?.priceUsd && trade.solPriceAtTrade) {
                              // Entry cost in USD
                              const entryCostUsd = trade.fromAmount * trade.solPriceAtTrade;
                              // Current value in USD
                              const currentValueUsd = trade.toAmount * tokenHolding.priceUsd;
                              if (entryCostUsd > 0) {
                                const pnlPercent = ((currentValueUsd - entryCostUsd) / entryCostUsd) * 100;
                                return (
                                  <div className={`font-medium ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`} data-testid={`text-perf-${trade.id}`}>
                                    {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                                  </div>
                                );
                              }
                            }
                            return <div className="text-xs text-muted-foreground" data-testid={`text-perf-${trade.id}`}>-</div>;
                          } else {
                            // SELL trade - calculate realized P&L
                            // Find buy trades for the same token to get entry cost
                            const tokenMint = trade.fromToken;
                            const buyTrades = activity?.trades?.filter(t => 
                              t.isBuy && t.toToken === tokenMint && t.timestamp < trade.timestamp
                            ) || [];
                            
                            if (buyTrades.length > 0 && trade.solPriceAtTrade) {
                              // Calculate average entry cost per token
                              let totalTokensBought = 0;
                              let totalCostUsd = 0;
                              
                              buyTrades.forEach(buyTrade => {
                                totalTokensBought += buyTrade.toAmount;
                                totalCostUsd += buyTrade.fromAmount * (buyTrade.solPriceAtTrade || 0);
                              });
                              
                              const avgEntryCostPerToken = totalTokensBought > 0 ? totalCostUsd / totalTokensBought : 0;
                              const sellValuePerToken = (trade.toAmount * trade.solPriceAtTrade) / trade.fromAmount;
                              
                              if (avgEntryCostPerToken > 0) {
                                const pnlPercent = ((sellValuePerToken - avgEntryCostPerToken) / avgEntryCostPerToken) * 100;
                                return (
                                  <div className={`font-medium ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`} data-testid={`text-perf-${trade.id}`}>
                                    {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                                    <div className="text-xs text-muted-foreground">Realized</div>
                                  </div>
                                );
                              }
                            }
                            
                            return (
                              <Badge variant="outline" className="text-xs" data-testid={`text-perf-${trade.id}`}>
                                Sold
                              </Badge>
                            );
                          }
                        })()}
                      </td>
                      <td className="py-3 text-right">
                        <a
                          href={`https://solscan.io/tx/${trade.signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-sm"
                          data-testid={`link-tx-${trade.id}`}
                        >
                          <ExternalLink className="h-4 w-4 inline" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-holdings">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              <CardTitle>Holdings</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Tabs value={holdingsTab} onValueChange={(v) => setHoldingsTab(v as HoldingsTab)}>
                <TabsList>
                  <TabsTrigger value="signal" data-testid="tab-signal-holdings">
                    Signal Wallet
                  </TabsTrigger>
                  <TabsTrigger value="copied" data-testid="tab-copied-holdings">
                    My Copies ({myCopiedHoldings.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {holdingsTab === "signal" && (
                <>
                  <Select value={holdingsSort} onValueChange={(v) => setHoldingsSort(v as HoldingsSortOption)}>
                    <SelectTrigger className="w-32" data-testid="select-holdings-sort">
                      <ArrowUpDown className="h-3 w-3 mr-1" />
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value" data-testid="select-sort-value">By Value</SelectItem>
                      <SelectItem value="name" data-testid="select-sort-name">By Name</SelectItem>
                      <SelectItem value="change" data-testid="select-sort-change">By 24h %</SelectItem>
                      <SelectItem value="age" data-testid="select-sort-age">By Age</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    onClick={() => refetchHoldings()}
                    disabled={holdingsLoading}
                    data-testid="button-refresh-holdings"
                  >
                    <RefreshCw className={`h-4 w-4 ${holdingsLoading ? "animate-spin" : ""}`} />
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {holdingsTab === "signal" ? (
            holdingsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : sortedHoldings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No token holdings found for this wallet.
              </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">Token</th>
                    <th className="pb-3 font-medium text-right">Amount</th>
                    <th className="pb-3 font-medium text-right">Price</th>
                    <th className="pb-3 font-medium text-right">Value</th>
                    <th className="pb-3 font-medium text-right">24h</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedHoldings.map((holding) => (
                    <tr 
                      key={holding.mint} 
                      className="border-b last:border-0 hover-elevate"
                      data-testid={`row-holding-${holding.mint.slice(0, 8)}`}
                    >
                      <td className="py-3">
                        <Link 
                          href={`/trading/${holding.mint}`}
                          className="hover:underline"
                          data-testid={`link-holding-${holding.mint.slice(0, 8)}`}
                        >
                          <div className="font-medium">{holding.symbol || "Unknown"}</div>
                          <div className="text-xs text-muted-foreground">{holding.name || truncateAddress(holding.mint)}</div>
                        </Link>
                      </td>
                      <td className="py-3 text-right font-mono text-sm">
                        {holding.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </td>
                      <td className="py-3 text-right font-mono text-sm">
                        {holding.priceUsd ? `$${holding.priceUsd.toFixed(6)}` : "-"}
                      </td>
                      <td className="py-3 text-right font-mono text-sm font-medium">
                        {holding.valueUsd ? formatUsd(holding.valueUsd) : "-"}
                      </td>
                      <td className="py-3 text-right">
                        {holding.priceChange24h !== undefined ? (
                          <span className={holding.priceChange24h >= 0 ? "text-green-500" : "text-red-500"}>
                            {holding.priceChange24h >= 0 ? "+" : ""}{holding.priceChange24h.toFixed(1)}%
                          </span>
                        ) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          ) : (
            // My Copied Holdings tab
            myCopiedHoldings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                You haven't copied any positions from this wallet yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="pb-3 font-medium">Token</th>
                      <th className="pb-3 font-medium text-right">Amount</th>
                      <th className="pb-3 font-medium text-right">Entry</th>
                      <th className="pb-3 font-medium text-right">Current</th>
                      <th className="pb-3 font-medium text-right">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myCopiedHoldings.map((holding) => {
                      // Entry value: SOL spent converted to USD using solToUsd
                      const entryValueUsd = solToUsd(holding.solSpent);
                      // Current value: current token price * amount
                      const currentValueUsd = (holding.lastPrice || 0) * holding.currentAmount;
                      // Calculate P&L percentage
                      const pnlPercent = entryValueUsd > 0 ? ((currentValueUsd - entryValueUsd) / entryValueUsd) * 100 : 0;
                      
                      return (
                        <tr 
                          key={holding.id} 
                          className="border-b last:border-0 hover-elevate"
                          data-testid={`row-copied-${holding.id}`}
                        >
                          <td className="py-3">
                            <Link 
                              href={`/trading/${holding.tokenMint}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">{holding.tokenSymbol}</div>
                              <div className="text-xs text-muted-foreground">{holding.tokenName || truncateAddress(holding.tokenMint)}</div>
                            </Link>
                          </td>
                          <td className="py-3 text-right font-mono text-sm">
                            {holding.currentAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                          </td>
                          <td className="py-3 text-right font-mono text-sm">
                            {entryValueUsd > 0 ? formatUsd(entryValueUsd) : `${holding.solSpent.toFixed(4)} SOL`}
                          </td>
                          <td className="py-3 text-right font-mono text-sm">
                            {currentValueUsd > 0 ? formatUsd(currentValueUsd) : "-"}
                          </td>
                          <td className="py-3 text-right">
                            {entryValueUsd > 0 && currentValueUsd > 0 ? (
                              <span className={pnlPercent >= 0 ? "text-green-500" : "text-red-500"}>
                                {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                              </span>
                            ) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
