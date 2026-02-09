import { useState, useMemo, useEffect, useCallback } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { 
  Coins, 
  TrendingUp, 
  TrendingDown, 
  ExternalLink, 
  ArrowUpDown,
  Filter,
  Wallet,
  Archive,
  ChevronRight,
  FlaskConical,
  X,
  Target,
  Activity,
  RefreshCw,
  Plus,
  Search,
  Timer
} from "lucide-react";
import { PortfolioValueChart, AllocationChart, PortfolioPnlChart } from "@/components/portfolio-charts";
import { useToast } from "@/hooks/use-toast";
import type { Holding } from "@shared/schema";

interface PaperPosition {
  id: number;
  userId: number;
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  entrySol: number;
  entryPrice: number;
  entryTokens: number;
  entryTimestamp: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  unrealizedPnlPercent?: number;
  signalWallet?: string;
  takeProfitMultiplier?: number;
  stopLossPercent?: number;
  status: string;
  exitSol?: number;
  exitPrice?: number;
  exitTimestamp?: number;
  exitReason?: string;
  realizedPnl?: number;
  realizedPnlPercent?: number;
  paperTradeType?: string;
  triggerType?: string;
}

interface PaperStats {
  openPositions: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnlPercent: number;
}

interface TokenLookup {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume24h: number | null;
}

interface SignalWallet {
  id: number;
  address: string;
  label: string | null;
  enabled?: boolean;
}

type SortOption = "value" | "pnl" | "recent" | "name";

const HOLDINGS_TAB_KEY = "holdings_active_tab";

function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncateAddress(address: string): string {
  if (!address) return "";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatUsd(val: number): string {
  if (val >= 1000000) return `$${(val / 1000000).toFixed(2)}M`;
  if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
  if (val < 0.01 && val > 0) return `$${val.toFixed(6)}`;
  return `$${val.toFixed(2)}`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function PaperTradeTypeLabel({ type, triggerType }: { type?: string; triggerType?: string }) {
  if (type === "discovery") {
    return <Badge variant="outline" className="text-xs">{triggerType === "event_bus" ? "Event" : "Discovery"}</Badge>;
  }
  if (type === "experiment") return <Badge variant="outline" className="text-xs">Experiment</Badge>;
  if (type === "best_theory") return <Badge variant="outline" className="text-xs">Theory</Badge>;
  return null;
}

export default function HoldingsPage() {
  const [, params] = useRoute("/holdings/:token");
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const urlToken = searchParams.get("paperToken");
  const selectedToken = params?.token;
  const { toast } = useToast();

  const savedTab = typeof window !== "undefined" ? localStorage.getItem(HOLDINGS_TAB_KEY) : null;
  const [mainTab, setMainTab] = useState<string>(savedTab || "holdings");
  const [paperSubTab, setPaperSubTab] = useState<string>("positions");
  const [signalFilter, setSignalFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortOption>("value");
  const [showClosed, setShowClosed] = useState(false);

  const [tokenMint, setTokenMint] = useState<string>("");
  const [solAmount, setSolAmount] = useState<string>("0.1");
  const [takeProfit, setTakeProfit] = useState<string>("100");
  const [stopLoss, setStopLoss] = useState<string>("30");
  const [selectedWallet, setSelectedWallet] = useState<string>("");
  const [lookupDebounce, setLookupDebounce] = useState<string>("");

  useEffect(() => {
    if (urlToken) {
      setTokenMint(urlToken);
      setMainTab("paper");
      setPaperSubTab("new-trade");
    }
  }, [urlToken]);

  const handleTabChange = useCallback((tab: string) => {
    setMainTab(tab);
    localStorage.setItem(HOLDINGS_TAB_KEY, tab);
  }, []);

  useDocumentMeta({
    title: selectedToken ? "Position Details | Penny Pincher" : "Holdings | Penny Pincher",
    description: "View and manage your positions and paper trades."
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setLookupDebounce(tokenMint);
    }, 500);
    return () => clearTimeout(timer);
  }, [tokenMint]);

  const { data: tokenPreview, isLoading: tokenPreviewLoading } = useQuery<TokenLookup>({
    queryKey: ["/api/paper/token-lookup", lookupDebounce],
    queryFn: async () => {
      if (!lookupDebounce || lookupDebounce.length < 32) return null;
      const response = await fetch(`/api/paper/token-lookup/${lookupDebounce}`, { credentials: "include" });
      if (!response.ok) return null;
      return response.json();
    },
    enabled: lookupDebounce.length >= 32,
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: signalWallets } = useQuery<SignalWallet[]>({
    queryKey: ["/api/signal-wallets"],
  });

  const { data: paperPositions, isLoading: paperLoading, refetch: refetchPaper } = useQuery<PaperPosition[]>({
    queryKey: ["/api/paper/positions"],
    queryFn: async () => {
      const response = await fetch("/api/paper/positions", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
  });

  const { data: paperHistory, isLoading: historyLoading, refetch: refetchHistory } = useQuery<PaperPosition[]>({
    queryKey: ["/api/paper/positions/history"],
    queryFn: async () => {
      const response = await fetch("/api/paper/positions/history?limit=50", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
  });

  const { data: paperStats, refetch: refetchStats } = useQuery<PaperStats>({
    queryKey: ["/api/paper/stats"],
    queryFn: async () => {
      const response = await fetch("/api/paper/stats", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
  });

  const closedPaperPositions = useMemo(() =>
    (paperHistory || []).filter(p => p.status === "closed"),
    [paperHistory]
  );

  const openPaperPositions = paperPositions || [];

  const totalUnrealizedPnl = useMemo(() => {
    return openPaperPositions.reduce((sum, pos) => sum + (pos.unrealizedPnl || 0), 0);
  }, [openPaperPositions]);

  const closePositionMutation = useMutation({
    mutationFn: async (positionId: number) => {
      return apiRequest("POST", `/api/paper/positions/${positionId}/close`, { reason: "manual" });
    },
    onSuccess: () => {
      toast({ description: "Position closed" });
      refetchPaper();
      refetchHistory();
      refetchStats();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to close position", variant: "destructive" });
    },
  });

  const openPositionMutation = useMutation({
    mutationFn: async (params: { tokenMint: string; entrySol: number; signalWallet?: string; takeProfitMultiplier?: number; stopLossPercent?: number }) => {
      return apiRequest("POST", "/api/paper/positions", params);
    },
    onSuccess: () => {
      toast({ description: "Paper position opened" });
      setTokenMint("");
      setSolAmount("0.1");
      setTakeProfit("100");
      setStopLoss("30");
      setSelectedWallet("");
      setPaperSubTab("positions");
      refetchPaper();
      refetchStats();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to open position", variant: "destructive" });
    },
  });

  const activeHoldings = holdings?.filter(h => !h.reclaimed && h.currentAmount > 0) || [];
  const closedHoldings = holdings?.filter(h => h.reclaimed || h.currentAmount === 0) || [];
  const displayHoldings = showClosed ? closedHoldings : activeHoldings;

  const filteredHoldings = useMemo(() => {
    let filtered = displayHoldings;
    if (signalFilter !== "all") {
      filtered = filtered.filter(h =>
        h.signalWalletId?.toString() === signalFilter ||
        h.sourceWalletAddress === signalFilter
      );
    }
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "value": {
          const aValue = (a.lastPrice || a.buyPrice) * a.currentAmount;
          const bValue = (b.lastPrice || b.buyPrice) * b.currentAmount;
          return bValue - aValue;
        }
        case "pnl": {
          const aPnl = a.lastPrice ? ((a.lastPrice - a.buyPrice) / a.buyPrice) * 100 : 0;
          const bPnl = b.lastPrice ? ((b.lastPrice - b.buyPrice) / b.buyPrice) * 100 : 0;
          return bPnl - aPnl;
        }
        case "recent":
          return b.buyTimestamp - a.buyTimestamp;
        case "name":
          return (a.tokenSymbol || "").localeCompare(b.tokenSymbol || "");
        default:
          return 0;
      }
    });
  }, [displayHoldings, signalFilter, sortBy]);

  const selectedHolding = selectedToken
    ? holdings?.find(h => h.tokenMint === selectedToken)
    : null;

  const totalValue = useMemo(() => {
    return activeHoldings.reduce((sum, h) => sum + ((h.lastPrice || h.buyPrice) * h.currentAmount), 0);
  }, [activeHoldings]);

  const totalPnl = useMemo(() => {
    return activeHoldings.reduce((sum, h) => {
      const currentVal = (h.lastPrice || h.buyPrice) * h.currentAmount;
      const costBasis = h.buyPrice * h.amountBought;
      return sum + (currentVal - costBasis);
    }, 0);
  }, [activeHoldings]);

  if (selectedHolding) {
    const pnlPercent = selectedHolding.lastPrice
      ? ((selectedHolding.lastPrice - selectedHolding.buyPrice) / selectedHolding.buyPrice) * 100
      : 0;
    const currentValue = (selectedHolding.lastPrice || selectedHolding.buyPrice) * selectedHolding.currentAmount;

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/holdings" data-testid="link-back-holdings">
            <span className="hover:text-foreground cursor-pointer">Holdings</span>
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground" data-testid="text-breadcrumb-token">{selectedHolding.tokenSymbol}</span>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-token-symbol">{selectedHolding.tokenSymbol}</h1>
            <p className="text-muted-foreground text-sm" data-testid="text-token-name">{selectedHolding.tokenName}</p>
          </div>
          <a
            href={`https://solscan.io/token/${selectedHolding.tokenMint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
            data-testid="link-solscan"
          >
            <ExternalLink className="h-5 w-5" />
          </a>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <Card data-testid="card-current-value">
            <CardHeader className="pb-2">
              <CardDescription>Current Value</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-detail-value">{formatUsd(currentValue)}</div>
            </CardContent>
          </Card>
          <Card data-testid="card-pnl">
            <CardHeader className="pb-2">
              <CardDescription>P&L</CardDescription>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold flex items-center gap-1 ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`} data-testid="text-detail-pnl">
                {pnlPercent >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
              </div>
            </CardContent>
          </Card>
          <Card data-testid="card-amount">
            <CardHeader className="pb-2">
              <CardDescription>Amount Held</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-detail-amount">{selectedHolding.currentAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
            </CardContent>
          </Card>
          <Card data-testid="card-highest">
            <CardHeader className="pb-2">
              <CardDescription>Highest Multiple</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid="text-detail-highest">{(selectedHolding.highestMultiplier || 1).toFixed(2)}x</div>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="card-position-details">
          <CardHeader>
            <CardTitle>Position Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Buy Price</p>
                <p className="font-mono" data-testid="text-buy-price">${selectedHolding.buyPrice.toFixed(8)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Current Price</p>
                <p className="font-mono" data-testid="text-current-price">${(selectedHolding.lastPrice || selectedHolding.buyPrice).toFixed(8)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">SOL Spent</p>
                <p className="font-mono" data-testid="text-sol-spent">{selectedHolding.solSpent.toFixed(4)} SOL</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Bought</p>
                <p className="font-mono" data-testid="text-buy-time">{formatTime(selectedHolding.buyTimestamp)}</p>
              </div>
            </div>
            {selectedHolding.sourceWalletLabel && (
              <div className="pt-4 border-t">
                <p className="text-sm text-muted-foreground mb-2">Signal Source</p>
                <Link href={`/signal/${selectedHolding.signalWalletId}`}>
                  <Badge variant="secondary" className="cursor-pointer hover-elevate" data-testid="badge-signal-source">
                    <Wallet className="h-3 w-3 mr-1" />
                    {selectedHolding.sourceWalletLabel}
                  </Badge>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Coins className="h-6 w-6" />
            Positions
          </h1>
          <p className="text-muted-foreground text-sm" data-testid="text-page-subtitle">
            Manage your real and paper trading positions
          </p>
        </div>
      </div>

      <Tabs value={mainTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="holdings" data-testid="tab-holdings">
            <Coins className="h-4 w-4 mr-2" />
            Holdings ({activeHoldings.length})
          </TabsTrigger>
          <TabsTrigger value="paper" data-testid="tab-paper">
            <FlaskConical className="h-4 w-4 mr-2" />
            Paper ({openPaperPositions.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="holdings" className="mt-4 space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card data-testid="card-total-value">
              <CardHeader className="pb-2">
                <CardDescription>Total Value</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-total-value">{formatUsd(totalValue)}</div>
              </CardContent>
            </Card>
            <Card data-testid="card-total-pnl">
              <CardHeader className="pb-2">
                <CardDescription>Unrealized P&L</CardDescription>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${totalPnl >= 0 ? "text-green-500" : "text-red-500"}`} data-testid="text-total-pnl">
                  {totalPnl >= 0 ? "+" : ""}{formatUsd(totalPnl)}
                </div>
              </CardContent>
            </Card>
            <Card data-testid="card-positions-count">
              <CardHeader className="pb-2">
                <CardDescription>Active Positions</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold" data-testid="text-positions-count">{activeHoldings.length}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <PortfolioValueChart />
            <PortfolioPnlChart />
            <AllocationChart holdings={activeHoldings} />
          </div>

          <Card data-testid="card-holdings-list">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-4">
                <CardTitle className="flex items-center gap-2">
                  <Coins className="h-5 w-5" />
                  {showClosed ? "Closed Positions" : "Active Positions"}
                </CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <Select value={signalFilter} onValueChange={setSignalFilter}>
                    <SelectTrigger className="w-40" data-testid="select-signal-filter">
                      <Filter className="h-3 w-3 mr-1" />
                      <SelectValue placeholder="All Signals" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all" data-testid="select-filter-all">All Signals</SelectItem>
                      {signalWallets?.map(wallet => (
                        <SelectItem
                          key={wallet.id}
                          value={wallet.id.toString()}
                          data-testid={`select-filter-${wallet.id}`}
                        >
                          {wallet.label || wallet.address.slice(0, 8)}...
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                    <SelectTrigger className="w-32" data-testid="select-sort">
                      <ArrowUpDown className="h-3 w-3 mr-1" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="value" data-testid="select-sort-value">By Value</SelectItem>
                      <SelectItem value="pnl" data-testid="select-sort-pnl">By P&L</SelectItem>
                      <SelectItem value="recent" data-testid="select-sort-recent">Most Recent</SelectItem>
                      <SelectItem value="name" data-testid="select-sort-name">By Name</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant={showClosed ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setShowClosed(!showClosed)}
                    data-testid="button-toggle-closed"
                  >
                    <Archive className="h-4 w-4 mr-1" />
                    {showClosed ? "Show Active" : "Show Closed"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {holdingsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </div>
              ) : filteredHoldings.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground" data-testid="text-empty-state">
                  {showClosed ? "No closed positions found." : "No active positions. Copy trades from signal wallets to get started."}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredHoldings.map(holding => {
                    const pnlPercent = holding.lastPrice
                      ? ((holding.lastPrice - holding.buyPrice) / holding.buyPrice) * 100
                      : 0;
                    const currentValue = (holding.lastPrice || holding.buyPrice) * holding.currentAmount;
                    return (
                      <div
                        key={holding.id}
                        onClick={() => setLocation(`/trading/${holding.tokenMint}`)}
                        className="flex items-center justify-between p-4 rounded-lg border hover-elevate cursor-pointer"
                        data-testid={`row-holding-${holding.id}`}
                      >
                        <div className="flex items-center gap-4">
                          <div>
                            <div className="font-medium" data-testid={`text-symbol-${holding.id}`}>{holding.tokenSymbol}</div>
                            <div className="text-xs text-muted-foreground">
                              {holding.sourceWalletLabel && (
                                <span className="flex items-center gap-1" data-testid={`text-source-${holding.id}`}>
                                  <Wallet className="h-3 w-3" />
                                  {holding.sourceWalletLabel}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-right">
                            <div className="font-mono text-sm" data-testid={`text-value-${holding.id}`}>{formatUsd(currentValue)}</div>
                            <div className="text-xs text-muted-foreground" data-testid={`text-amount-${holding.id}`}>
                              {holding.currentAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens
                            </div>
                          </div>
                          <div className={`text-right min-w-20 ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`}>
                            <div className="flex items-center justify-end gap-1 font-medium" data-testid={`text-pnl-${holding.id}`}>
                              {pnlPercent >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                              {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%
                            </div>
                            <div className="text-xs" data-testid={`text-peak-${holding.id}`}>
                              {(holding.highestMultiplier || 1).toFixed(2)}x peak
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="paper" className="mt-4 space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <Card data-testid="card-paper-open">
              <CardHeader className="pb-2">
                <CardDescription>Open Positions</CardDescription>
              </CardHeader>
              <CardContent>
                {!paperStats ? <Skeleton className="h-8 w-16" /> : (
                  <p className="text-2xl font-bold">{paperStats.openPositions}</p>
                )}
              </CardContent>
            </Card>
            <Card data-testid="card-paper-trades">
              <CardHeader className="pb-2">
                <CardDescription>Total Trades</CardDescription>
              </CardHeader>
              <CardContent>
                {!paperStats ? <Skeleton className="h-8 w-16" /> : (
                  <p className="text-2xl font-bold">{paperStats.totalTrades}</p>
                )}
              </CardContent>
            </Card>
            <Card data-testid="card-paper-winrate">
              <CardHeader className="pb-2">
                <CardDescription>Win Rate</CardDescription>
              </CardHeader>
              <CardContent>
                {!paperStats ? <Skeleton className="h-8 w-16" /> : (
                  <p className="text-2xl font-bold">{((paperStats.winRate) * 100).toFixed(1)}%</p>
                )}
              </CardContent>
            </Card>
            <Card data-testid="card-paper-pnl">
              <CardHeader className="pb-2">
                <CardDescription>Total P&L</CardDescription>
              </CardHeader>
              <CardContent>
                {!paperStats ? <Skeleton className="h-8 w-16" /> : (
                  <p className={`text-2xl font-bold ${paperStats.totalPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {paperStats.totalPnl >= 0 ? "+" : ""}{paperStats.totalPnl.toFixed(4)} SOL
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {openPaperPositions.length > 0 && (
            <Card data-testid="card-unrealized-pnl">
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Activity className="h-5 w-5 text-primary" />
                    <span className="font-medium">Unrealized P&L</span>
                  </div>
                  <span className={`text-xl font-bold ${totalUnrealizedPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {totalUnrealizedPnl >= 0 ? "+" : ""}{totalUnrealizedPnl.toFixed(4)} SOL
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          <Tabs value={paperSubTab} onValueChange={setPaperSubTab}>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <TabsList>
                <TabsTrigger value="positions" data-testid="tab-paper-positions">
                  Open ({openPaperPositions.length})
                </TabsTrigger>
                <TabsTrigger value="history" data-testid="tab-paper-history">
                  History ({closedPaperPositions.length})
                </TabsTrigger>
                <TabsTrigger value="new-trade" data-testid="tab-paper-new">
                  <Plus className="h-4 w-4 mr-1" />
                  New Trade
                </TabsTrigger>
              </TabsList>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { refetchPaper(); refetchHistory(); refetchStats(); }}
                data-testid="button-refresh-paper"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>

            <TabsContent value="positions" className="mt-4 space-y-4">
              {paperLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : openPaperPositions.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <FlaskConical className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground mb-2">No open paper positions</p>
                    <p className="text-sm text-muted-foreground mb-4">
                      Create a paper trade to practice strategies risk-free
                    </p>
                    <Button variant="outline" size="sm" onClick={() => setPaperSubTab("new-trade")} data-testid="button-start-paper">
                      <Plus className="h-4 w-4 mr-2" />
                      New Paper Trade
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {openPaperPositions.map((pos) => {
                    const pnlPercent = pos.unrealizedPnlPercent || 0;
                    const pnlSol = pos.unrealizedPnl || 0;

                    return (
                      <Card key={pos.id} data-testid={`card-paper-position-${pos.id}`}>
                        <CardContent className="py-4">
                          <div className="flex items-start justify-between gap-4 flex-wrap">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-lg">{pos.tokenSymbol || truncateAddress(pos.tokenMint)}</span>
                                <Badge variant="outline" className="text-xs">{pos.entrySol} SOL</Badge>
                                <PaperTradeTypeLabel type={pos.paperTradeType} triggerType={pos.triggerType} />
                              </div>
                              {pos.signalWallet && (
                                <p className="text-xs text-muted-foreground">
                                  Via: {truncateAddress(pos.signalWallet)}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                Opened {formatRelativeTime(pos.entryTimestamp)}
                              </p>
                            </div>

                            <div className="text-right space-y-1">
                              <div className={`text-xl font-bold ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`}>
                                {pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%
                              </div>
                              <p className={`text-sm ${pnlSol >= 0 ? "text-green-500" : "text-red-500"}`}>
                                {pnlSol >= 0 ? "+" : ""}{pnlSol.toFixed(4)} SOL
                              </p>
                            </div>

                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => closePositionMutation.mutate(pos.id)}
                              disabled={closePositionMutation.isPending}
                              data-testid={`button-close-paper-${pos.id}`}
                            >
                              <X className="h-4 w-4 mr-1" />
                              Close
                            </Button>
                          </div>

                          {(pos.takeProfitMultiplier || pos.stopLossPercent) && (
                            <div className="mt-3 pt-3 border-t flex gap-4 text-xs text-muted-foreground flex-wrap">
                              {pos.takeProfitMultiplier && (
                                <div className="flex items-center gap-1">
                                  <TrendingUp className="h-3 w-3 text-green-500" />
                                  <span>TP: {((pos.takeProfitMultiplier - 1) * 100).toFixed(0)}%</span>
                                </div>
                              )}
                              {pos.stopLossPercent && (
                                <div className="flex items-center gap-1">
                                  <TrendingDown className="h-3 w-3 text-red-500" />
                                  <span>SL: -{(pos.stopLossPercent * 100).toFixed(0)}%</span>
                                </div>
                              )}
                              {pos.currentPrice && (
                                <div className="flex items-center gap-1">
                                  <Target className="h-3 w-3" />
                                  <span>Price: ${pos.currentPrice < 0.01 ? pos.currentPrice.toFixed(8) : pos.currentPrice.toFixed(4)}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-4">
              {historyLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : closedPaperPositions.length === 0 ? (
                <Card>
                  <CardContent className="py-12 text-center">
                    <Timer className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <p className="text-muted-foreground">No closed positions yet</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {closedPaperPositions.map((pos) => (
                    <Card key={pos.id} data-testid={`card-paper-history-${pos.id}`}>
                      <CardContent className="py-3">
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-full ${(pos.realizedPnl || 0) >= 0 ? "bg-green-500/10" : "bg-red-500/10"}`}>
                              {(pos.realizedPnl || 0) >= 0 ? (
                                <TrendingUp className="h-4 w-4 text-green-500" />
                              ) : (
                                <TrendingDown className="h-4 w-4 text-red-500" />
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium">{pos.tokenSymbol || truncateAddress(pos.tokenMint)}</span>
                                <PaperTradeTypeLabel type={pos.paperTradeType} triggerType={pos.triggerType} />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {pos.entrySol} SOL
                                {pos.exitReason && <span> · {pos.exitReason}</span>}
                                {pos.exitTimestamp && <span> · {formatRelativeTime(pos.exitTimestamp)}</span>}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`font-bold ${(pos.realizedPnl || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                              {(pos.realizedPnl || 0) >= 0 ? "+" : ""}{(pos.realizedPnl || 0).toFixed(4)} SOL
                            </span>
                            <p className={`text-xs ${(pos.realizedPnlPercent || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                              {(pos.realizedPnlPercent || 0) >= 0 ? "+" : ""}{(pos.realizedPnlPercent || 0).toFixed(2)}%
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="new-trade" className="mt-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FlaskConical className="h-5 w-5 text-primary" />
                    Open Paper Trade
                  </CardTitle>
                  <CardDescription>
                    Create a simulated buy to test strategies without risking real funds. Close the position when you want to sell.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Token Mint Address</Label>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Paste token mint address..."
                        value={tokenMint}
                        onChange={(e) => setTokenMint(e.target.value)}
                        className="pl-10"
                        data-testid="input-token-mint"
                      />
                    </div>
                    {tokenPreviewLoading && tokenMint.length >= 32 && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        Looking up token...
                      </div>
                    )}
                    {tokenPreview && tokenPreview.tokenSymbol && (
                      <Card className="bg-muted/50">
                        <CardContent className="py-3">
                          <div className="flex items-center justify-between gap-4 flex-wrap">
                            <div>
                              <span className="font-bold text-lg">{tokenPreview.tokenSymbol}</span>
                              {tokenPreview.tokenName && (
                                <span className="text-sm text-muted-foreground ml-2">{tokenPreview.tokenName}</span>
                              )}
                            </div>
                            <div className="text-right text-sm space-y-1">
                              {tokenPreview.priceUsd != null && (
                                <p className="font-mono">
                                  ${tokenPreview.priceUsd < 0.01 ? tokenPreview.priceUsd.toFixed(8) : tokenPreview.priceUsd.toFixed(4)}
                                </p>
                              )}
                              <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
                                {tokenPreview.marketCap != null && <span>MCap: {formatUsd(tokenPreview.marketCap)}</span>}
                                {tokenPreview.liquidity != null && <span>Liq: {formatUsd(tokenPreview.liquidity)}</span>}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {tokenMint.length >= 32 && !tokenPreviewLoading && !tokenPreview?.tokenSymbol && lookupDebounce === tokenMint && (
                      <p className="text-xs text-destructive">Token not found or no price data available</p>
                    )}
                  </div>

                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label>Amount (SOL)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={solAmount}
                        onChange={(e) => setSolAmount(e.target.value)}
                        data-testid="input-amount"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Take Profit (%)</Label>
                      <Input
                        type="number"
                        step="5"
                        min="0"
                        value={takeProfit}
                        onChange={(e) => setTakeProfit(e.target.value)}
                        data-testid="input-take-profit"
                      />
                      <p className="text-xs text-muted-foreground">Sell when price rises this much</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Stop Loss (%)</Label>
                      <Input
                        type="number"
                        step="5"
                        min="0"
                        value={stopLoss}
                        onChange={(e) => setStopLoss(e.target.value)}
                        data-testid="input-stop-loss"
                      />
                      <p className="text-xs text-muted-foreground">Sell when price drops this much</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Copy from Signal Wallet (optional)</Label>
                    <Select value={selectedWallet} onValueChange={setSelectedWallet}>
                      <SelectTrigger data-testid="select-wallet">
                        <SelectValue placeholder="No wallet (manual trade)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No wallet (manual trade)</SelectItem>
                        {signalWallets?.map((w) => (
                          <SelectItem key={w.id} value={w.address}>
                            {w.label || truncateAddress(w.address)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <Button
                      onClick={() => {
                        if (!tokenMint || tokenMint.length < 32) {
                          toast({ description: "Please enter a valid token mint address", variant: "destructive" });
                          return;
                        }
                        const tpPercent = parseFloat(takeProfit) || 100;
                        const slPercent = parseFloat(stopLoss) || 30;
                        const takeProfitMultiplier = 1 + (tpPercent / 100);
                        const stopLossDecimal = slPercent / 100;

                        openPositionMutation.mutate({
                          tokenMint,
                          entrySol: parseFloat(solAmount) || 0.1,
                          takeProfitMultiplier,
                          stopLossPercent: stopLossDecimal,
                          signalWallet: selectedWallet && selectedWallet !== "none" ? selectedWallet : undefined,
                        });
                      }}
                      disabled={openPositionMutation.isPending}
                      data-testid="button-open-trade"
                    >
                      {openPositionMutation.isPending ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <TrendingUp className="h-4 w-4 mr-2" />
                      )}
                      {openPositionMutation.isPending ? "Opening..." : "Paper Buy"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setTokenMint("");
                        setSolAmount("0.1");
                        setTakeProfit("100");
                        setStopLoss("30");
                        setSelectedWallet("");
                      }}
                      data-testid="button-reset"
                    >
                      Reset
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}
