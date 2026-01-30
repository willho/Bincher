import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { CopyTrading } from "@/components/copy-trading";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  Coins, 
  TrendingUp, 
  TrendingDown, 
  ExternalLink, 
  Clock, 
  Archive, 
  Plus,
  Pause,
  Play,
  X,
  Wallet
} from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import type { Holding } from "@shared/schema";

interface PendingBuy {
  id: number;
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  solAmount: number;
  sourceWallet: string;
  signalWalletId: number | null;
  status: string;
  createdAt: number;
  scheduledFor: number | null;
  executedAt: number | null;
  error: string | null;
  positionSource: string;
}

export default function TradingPage() {
  const [manualTokenMint, setManualTokenMint] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [showNewPosition, setShowNewPosition] = useState(false);
  const { toast } = useToast();

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: pendingBuys, isLoading: pendingLoading } = useQuery<PendingBuy[]>({
    queryKey: ["/api/copy-trade/pending"],
    refetchInterval: 10000,
  });

  const { data: hotWallet } = useQuery<{ exists: boolean; publicKey?: string; balance?: number }>({
    queryKey: ["/api/copy-trade/wallet"],
  });

  // Filter holdings into categories
  const activeHoldings = holdings?.filter(h => !h.reclaimed && h.currentAmount > 0) || [];
  const inactiveHoldings = holdings?.filter(h => h.reclaimed || h.currentAmount === 0) || [];
  
  // Filter pending buys by status
  const activePending = pendingBuys?.filter(p => p.status === 'pending' || p.status === 'scheduled') || [];
  const pausedPending = pendingBuys?.filter(p => p.status === 'paused') || [];

  const pausePendingBuy = useMutation({
    mutationFn: (pendingId: number) => apiRequest("POST", `/api/copy-trade/pending/${pendingId}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Buy order paused" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to pause", variant: "destructive" });
    },
  });

  const resumePendingBuy = useMutation({
    mutationFn: (pendingId: number) => apiRequest("POST", `/api/copy-trade/pending/${pendingId}/resume`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Buy order resumed" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to resume", variant: "destructive" });
    },
  });

  const cancelPendingBuy = useMutation({
    mutationFn: (pendingId: number) => apiRequest("POST", `/api/copy-trade/pending/${pendingId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Buy order cancelled" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to cancel", variant: "destructive" });
    },
  });

  const manualBuyMutation = useMutation({
    mutationFn: (data: { tokenMint: string; solAmount: number }) => 
      apiRequest("POST", "/api/copy-trade/manual-buy", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      setManualTokenMint("");
      setManualAmount("");
      setShowNewPosition(false);
      toast({ description: "Buy order queued" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to queue buy", variant: "destructive" });
    },
  });

  const getHoldingMetrics = (holding: Holding) => {
    const currentPrice = holding.lastPrice || holding.buyPrice;
    const currentValue = holding.currentAmount * currentPrice;
    const pnlPercent = holding.solSpent > 0 
      ? ((currentValue - holding.solSpent) / holding.solSpent) * 100 
      : 0;
    return { currentValue, pnlPercent };
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleManualBuy = () => {
    if (!manualTokenMint.trim()) {
      toast({ description: "Enter a token mint address", variant: "destructive" });
      return;
    }
    const amount = parseFloat(manualAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ description: "Enter a valid SOL amount", variant: "destructive" });
      return;
    }
    manualBuyMutation.mutate({ tokenMint: manualTokenMint.trim(), solAmount: amount });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Hot Wallet</h1>
          <p className="text-muted-foreground">Manage positions and trading</p>
        </div>
        <div className="flex items-center gap-2">
          {hotWallet?.exists && (
            <Badge variant="outline" className="flex items-center gap-1">
              <Wallet className="h-3 w-3" />
              {(hotWallet.balance || 0).toFixed(3)} SOL
            </Badge>
          )}
          <Button 
            onClick={() => setShowNewPosition(!showNewPosition)}
            size="sm"
            data-testid="button-new-position"
          >
            <Plus className="h-4 w-4 mr-1" />
            New Position
          </Button>
        </div>
      </div>

      {showNewPosition && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Plus className="h-5 w-5" />
              New Manual Position
            </CardTitle>
            <CardDescription>Queue a manual buy order</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Label htmlFor="token-mint">Token Mint Address</Label>
                <Input
                  id="token-mint"
                  placeholder="Enter token mint address..."
                  value={manualTokenMint}
                  onChange={(e) => setManualTokenMint(e.target.value)}
                  data-testid="input-token-mint"
                />
              </div>
              <div>
                <Label htmlFor="sol-amount">SOL Amount</Label>
                <Input
                  id="sol-amount"
                  type="number"
                  step="0.01"
                  placeholder="0.1"
                  value={manualAmount}
                  onChange={(e) => setManualAmount(e.target.value)}
                  data-testid="input-sol-amount"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <Button 
                onClick={handleManualBuy}
                disabled={manualBuyMutation.isPending}
                data-testid="button-submit-buy"
              >
                {manualBuyMutation.isPending ? "Queuing..." : "Queue Buy"}
              </Button>
              <Button 
                variant="outline" 
                onClick={() => setShowNewPosition(false)}
                data-testid="button-cancel-new"
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="active" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="active" data-testid="tab-active">
            Active ({activeHoldings.length})
          </TabsTrigger>
          <TabsTrigger value="pending" data-testid="tab-pending">
            Pending ({activePending.length + pausedPending.length})
          </TabsTrigger>
          <TabsTrigger value="inactive" data-testid="tab-inactive">
            Inactive ({inactiveHoldings.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Active Positions
              </CardTitle>
              <CardDescription>Currently held token positions</CardDescription>
            </CardHeader>
            <CardContent>
              {holdingsLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : activeHoldings.length > 0 ? (
                <div className="space-y-3">
                  {activeHoldings.map((holding) => {
                    const { pnlPercent } = getHoldingMetrics(holding);
                    const isProfit = pnlPercent >= 0;
                    return (
                      <div
                        key={holding.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                        data-testid={`holding-${holding.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isProfit ? "bg-green-500/10" : "bg-red-500/10"}`}>
                            {isProfit ? (
                              <TrendingUp className="h-4 w-4 text-green-500" />
                            ) : (
                              <TrendingDown className="h-4 w-4 text-red-500" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{holding.tokenSymbol}</span>
                              <Badge variant={isProfit ? "default" : "destructive"}>
                                {isProfit ? "+" : ""}{pnlPercent.toFixed(1)}%
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {holding.solSpent.toFixed(4)} SOL invested
                            </p>
                          </div>
                        </div>
                        <Link href={`/trading/${holding.tokenMint}`}>
                          <Button variant="ghost" size="sm" data-testid={`button-view-${holding.id}`}>
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Coins className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No active positions</p>
                  <p className="text-sm mt-1">Create a new position or enable copy trading</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Pending Orders
              </CardTitle>
              <CardDescription>Buy orders waiting to execute</CardDescription>
            </CardHeader>
            <CardContent>
              {pendingLoading ? (
                <div className="space-y-3">
                  {[1, 2].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : (activePending.length + pausedPending.length) > 0 ? (
                <div className="space-y-3">
                  {[...activePending, ...pausedPending].map((pending) => {
                    const isPaused = pending.status === 'paused';
                    return (
                      <div
                        key={pending.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                        data-testid={`pending-${pending.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isPaused ? "bg-yellow-500/10" : "bg-blue-500/10"}`}>
                            {isPaused ? (
                              <Pause className="h-4 w-4 text-yellow-500" />
                            ) : (
                              <Clock className="h-4 w-4 text-blue-500" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{pending.tokenSymbol}</span>
                              <Badge variant={isPaused ? "secondary" : "outline"}>
                                {isPaused ? "Paused" : "Scheduled"}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {pending.solAmount.toFixed(4)} SOL • {pending.positionSource}
                              {pending.scheduledFor && ` • ${formatTime(pending.scheduledFor)}`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {isPaused ? (
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => resumePendingBuy.mutate(pending.id)}
                              disabled={resumePendingBuy.isPending}
                              data-testid={`button-resume-${pending.id}`}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => pausePendingBuy.mutate(pending.id)}
                              disabled={pausePendingBuy.isPending}
                              data-testid={`button-pause-${pending.id}`}
                            >
                              <Pause className="h-4 w-4" />
                            </Button>
                          )}
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => cancelPendingBuy.mutate(pending.id)}
                            disabled={cancelPendingBuy.isPending}
                            data-testid={`button-cancel-${pending.id}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No pending orders</p>
                  <p className="text-sm mt-1">Copy trades or manual buys will appear here</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inactive" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Archive className="h-5 w-5" />
                Inactive Positions
              </CardTitle>
              <CardDescription>Closed or reclaimed positions</CardDescription>
            </CardHeader>
            <CardContent>
              {holdingsLoading ? (
                <div className="space-y-3">
                  {[1, 2].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : inactiveHoldings.length > 0 ? (
                <div className="space-y-3">
                  {inactiveHoldings.slice(0, 10).map((holding) => {
                    const pnlPercent = holding.solSpent > 0 && holding.solReclaimed
                      ? ((holding.solReclaimed - holding.solSpent) / holding.solSpent) * 100
                      : 0;
                    const wasProfit = pnlPercent >= 0;
                    return (
                      <div
                        key={holding.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border opacity-75"
                        data-testid={`inactive-${holding.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${wasProfit ? "bg-green-500/5" : "bg-red-500/5"}`}>
                            <Archive className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-muted-foreground">{holding.tokenSymbol}</span>
                              {holding.solReclaimed ? (
                                <Badge variant="secondary">
                                  {wasProfit ? "+" : ""}{pnlPercent.toFixed(1)}%
                                </Badge>
                              ) : (
                                <Badge variant="outline">Sold</Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {holding.solSpent.toFixed(4)} SOL spent
                              {holding.solReclaimed ? ` → ${holding.solReclaimed.toFixed(4)} SOL returned` : ''}
                            </p>
                          </div>
                        </div>
                        <Link href={`/trading/${holding.tokenMint}`}>
                          <Button variant="ghost" size="sm" data-testid={`button-view-inactive-${holding.id}`}>
                            <ExternalLink className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    );
                  })}
                  {inactiveHoldings.length > 10 && (
                    <p className="text-center text-sm text-muted-foreground pt-2">
                      + {inactiveHoldings.length - 10} more positions
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Archive className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p>No inactive positions</p>
                  <p className="text-sm mt-1">Closed positions will appear here</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <CopyTrading />
    </div>
  );
}
