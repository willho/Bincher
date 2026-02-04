import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { 
  FlaskConical, Play, Pause, TrendingUp, TrendingDown, Coins, 
  Target, Timer, RefreshCw, X, DollarSign, Wallet, Activity
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PaperPosition {
  id: number;
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  tokenName?: string;
  entrySol: number;
  entryPrice: number;
  entryTimestamp: number;
  currentPrice?: number;
  tokenAmount: number;
  signalWallet?: string;
  strategyId?: number;
  experimentId?: number;
  takeProfitMultiplier?: number;
  stopLossPercent?: number;
  status: string;
  exitSol?: number;
  exitPrice?: number;
  exitTimestamp?: number;
  pnlSol?: number;
  pnlPercent?: number;
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

interface SignalWallet {
  id: number;
  address: string;
  label?: string;
  enabled: boolean;
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
  if (!address) return "";
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export default function PaperTradingPage() {
  const [selectedWallet, setSelectedWallet] = useState<string>("");
  const [solAmount, setSolAmount] = useState<string>("0.1");
  const [takeProfit, setTakeProfit] = useState<string>("50");
  const [stopLoss, setStopLoss] = useState<string>("20");
  const [tab, setTab] = useState<string>("positions");
  const { toast } = useToast();

  const { data: positions, isLoading: positionsLoading, refetch: refetchPositions } = useQuery<PaperPosition[]>({
    queryKey: ["/api/paper/positions"],
    queryFn: async () => {
      const response = await fetch("/api/paper/positions", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch positions");
      return response.json();
    },
  });

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<PaperStats>({
    queryKey: ["/api/paper/stats"],
    queryFn: async () => {
      const response = await fetch("/api/paper/stats", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch stats");
      return response.json();
    },
  });

  const { data: wallets } = useQuery<SignalWallet[]>({
    queryKey: ["/api/signal-wallets"],
    queryFn: async () => {
      const response = await fetch("/api/signal-wallets", { credentials: "include" });
      if (!response.ok) return [];
      return response.json();
    },
  });

  const openPositions = useMemo(() => 
    (positions || []).filter(p => p.status === "open"),
    [positions]
  );

  const closedPositions = useMemo(() => 
    (positions || []).filter(p => p.status === "closed"),
    [positions]
  );

  const totalUnrealizedPnl = useMemo(() => {
    return openPositions.reduce((sum, pos) => {
      if (!pos.currentPrice || !pos.entryPrice) return sum;
      const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * pos.entrySol;
      return sum + pnl;
    }, 0);
  }, [openPositions]);

  const closePositionMutation = useMutation({
    mutationFn: async (positionId: number) => {
      return apiRequest("POST", `/api/paper/positions/${positionId}/close`);
    },
    onSuccess: () => {
      toast({ description: "Position closed" });
      refetchPositions();
      refetchStats();
    },
    onError: (error: any) => {
      toast({ 
        description: error.message || "Failed to close position", 
        variant: "destructive" 
      });
    },
  });

  const openPositionMutation = useMutation({
    mutationFn: async (params: { tokenMint: string; entrySol: number; signalWallet?: string; takeProfit?: number; stopLoss?: number }) => {
      return apiRequest("POST", "/api/paper/positions", params);
    },
    onSuccess: () => {
      toast({ description: "Paper position opened" });
      refetchPositions();
      refetchStats();
    },
    onError: (error: any) => {
      toast({ 
        description: error.message || "Failed to open position", 
        variant: "destructive" 
      });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <FlaskConical className="h-6 w-6" />
            Paper Trading
          </h1>
          <p className="text-sm text-muted-foreground">
            Practice strategies risk-free with simulated trades
          </p>
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => { refetchPositions(); refetchStats(); }}
          data-testid="button-refresh"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card data-testid="card-open-positions">
          <CardHeader className="pb-2">
            <CardDescription>Open Positions</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold">{stats?.openPositions || 0}</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-total-trades">
          <CardHeader className="pb-2">
            <CardDescription>Total Trades</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold">{stats?.totalTrades || 0}</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-win-rate">
          <CardHeader className="pb-2">
            <CardDescription>Win Rate</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold">
                {((stats?.winRate || 0) * 100).toFixed(1)}%
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-total-pnl">
          <CardHeader className="pb-2">
            <CardDescription>Total P&L</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className={`text-2xl font-bold ${(stats?.totalPnl || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {(stats?.totalPnl || 0) >= 0 ? "+" : ""}{(stats?.totalPnl || 0).toFixed(4)} SOL
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-unrealized-pnl">
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
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

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="positions" data-testid="tab-positions">
            Open Positions ({openPositions.length})
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">
            History ({closedPositions.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="mt-4 space-y-4">
          {positionsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : openPositions.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FlaskConical className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground mb-2">No open paper positions</p>
                <p className="text-sm text-muted-foreground">
                  Paper trades will appear here when signal wallets trade
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {openPositions.map((pos) => {
                const pnlPercent = pos.currentPrice && pos.entryPrice
                  ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                  : 0;
                const pnlSol = pos.currentPrice && pos.entryPrice
                  ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * pos.entrySol
                  : 0;
                  
                return (
                  <Card key={pos.id} data-testid={`card-position-${pos.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-lg">{pos.tokenSymbol || "UNKNOWN"}</span>
                            <Badge variant="outline" className="text-xs">
                              {pos.entrySol} SOL
                            </Badge>
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
                          data-testid={`button-close-${pos.id}`}
                        >
                          <X className="h-4 w-4 mr-1" />
                          Close
                        </Button>
                      </div>
                      
                      {(pos.takeProfitMultiplier || pos.stopLossPercent) && (
                        <div className="mt-3 pt-3 border-t flex gap-4 text-xs text-muted-foreground">
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
          {positionsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : closedPositions.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Timer className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">No closed positions yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {closedPositions.map((pos) => (
                <Card key={pos.id} data-testid={`card-history-${pos.id}`}>
                  <CardContent className="py-3">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${(pos.pnlSol || 0) >= 0 ? "bg-green-500/10" : "bg-red-500/10"}`}>
                          {(pos.pnlSol || 0) >= 0 ? (
                            <TrendingUp className="h-4 w-4 text-green-500" />
                          ) : (
                            <TrendingDown className="h-4 w-4 text-red-500" />
                          )}
                        </div>
                        <div>
                          <span className="font-medium">{pos.tokenSymbol || "UNKNOWN"}</span>
                          <p className="text-xs text-muted-foreground">
                            {pos.entrySol} SOL · {pos.exitTimestamp ? formatRelativeTime(pos.exitTimestamp) : ""}
                          </p>
                        </div>
                      </div>
                      
                      <div className="text-right">
                        <span className={`font-bold ${(pos.pnlSol || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {(pos.pnlSol || 0) >= 0 ? "+" : ""}{(pos.pnlSol || 0).toFixed(4)} SOL
                        </span>
                        <p className={`text-xs ${(pos.pnlPercent || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                          {(pos.pnlPercent || 0) >= 0 ? "+" : ""}{(pos.pnlPercent || 0).toFixed(2)}%
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
