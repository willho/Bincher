import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Bot,
  Clock,
  Copy,
  DollarSign,
  ExternalLink, 
  Plus,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { TradeConfig, Holding, PendingBuy } from "@shared/schema";

interface HotWalletInfo {
  exists: boolean;
  publicKey?: string;
  balance?: number;
  createdAt?: number;
}

export function CopyTrading() {
  const { toast } = useToast();

  const copyToClipboard = async (text: string, label: string = "Address") => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: `${label} copied to clipboard` });
    } catch {
      toast({ description: "Failed to copy", variant: "destructive" });
    }
  };

  const { data: hotWallet, isLoading: walletLoading } = useQuery<HotWalletInfo>({
    queryKey: ["/api/copy-trade/wallet"],
  });

  const { data: config, isLoading: configLoading } = useQuery<TradeConfig>({
    queryKey: ["/api/copy-trade/config"],
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: pendingBuys, isLoading: pendingLoading } = useQuery<PendingBuy[]>({
    queryKey: ["/api/copy-trade/pending"],
  });

  const createWallet = useMutation({
    mutationFn: () => apiRequest("POST", "/api/copy-trade/wallet"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/wallet"] });
      toast({ description: "Hot wallet created successfully" });
    },
    onError: () => {
      toast({ description: "Failed to create wallet", variant: "destructive" });
    },
  });

  const refreshBalance = useMutation({
    mutationFn: () => apiRequest("GET", "/api/copy-trade/balance"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/wallet"] });
    },
  });

  const updateConfig = useMutation({
    mutationFn: (data: Partial<TradeConfig>) => 
      apiRequest("PATCH", "/api/copy-trade/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/config"] });
      toast({ description: "Settings saved" });
    },
  });

  const formatTime = (timestamp: number) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = timestamp - now;
    if (diff <= 0) return "Now";
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const formatPrice = (price: number | undefined) => {
    if (!price) return "N/A";
    if (price < 0.0001) return `$${price.toExponential(2)}`;
    if (price < 1) return `$${price.toFixed(6)}`;
    return `$${price.toFixed(4)}`;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Copy Trading
          </CardTitle>
          <CardDescription>
            Automatically copy trades from the monitored wallet
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {walletLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !hotWallet?.exists ? (
            <div className="text-center py-8 border rounded-lg bg-muted/30">
              <div className="p-3 rounded-full bg-muted/50 w-fit mx-auto mb-4">
                <Wallet className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium">No Hot Wallet</h3>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Create a hot wallet to enable automated copy trading
              </p>
              <Button 
                onClick={() => createWallet.mutate()}
                disabled={createWallet.isPending}
                data-testid="button-create-wallet"
              >
                {createWallet.isPending ? (
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                Create Hot Wallet
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Wallet className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Hot Wallet</p>
                    <p className="font-mono text-sm" data-testid="text-hot-wallet-address">
                      {hotWallet.publicKey?.slice(0, 8)}...{hotWallet.publicKey?.slice(-6)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Balance</p>
                    <p className="font-semibold text-lg" data-testid="text-hot-wallet-balance">
                      {hotWallet.balance?.toFixed(4) || "0"} SOL
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => copyToClipboard(hotWallet.publicKey || "", "Wallet address")}
                      data-testid="button-copy-hot-wallet"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => refreshBalance.mutate()}
                      disabled={refreshBalance.isPending}
                      data-testid="button-refresh-balance"
                    >
                      <RefreshCw className={`h-4 w-4 ${refreshBalance.isPending ? "animate-spin" : ""}`} />
                    </Button>
                    <a
                      href={`https://solscan.io/account/${hotWallet.publicKey}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button size="icon" variant="ghost">
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </a>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg border bg-amber-500/10 border-amber-500/20">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Deposit SOL to this wallet to enable copy trading. The bot will use 10% of your balance for each trade.
                </p>
              </div>

              {configLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base">Enable Copy Trading</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically buy tokens when monitored wallet buys
                      </p>
                    </div>
                    <Switch
                      checked={config?.enabled ?? false}
                      onCheckedChange={(enabled) => updateConfig.mutate({ enabled })}
                      data-testid="switch-copy-trading"
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label>Buy Percentage</Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Percent of SOL balance to use per trade
                      </p>
                      <Input
                        type="number"
                        value={config?.buyPercentage || 10}
                        onChange={(e) => updateConfig.mutate({ buyPercentage: parseFloat(e.target.value) })}
                        data-testid="input-buy-percentage"
                      />
                    </div>
                    <div>
                      <Label>Reclaim at Multiplier</Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Auto-sell 2x initial when token hits this multiplier
                      </p>
                      <Input
                        type="number"
                        value={config?.reclaimMultiplier || 4}
                        onChange={(e) => updateConfig.mutate({ reclaimMultiplier: parseFloat(e.target.value) })}
                        data-testid="input-reclaim-multiplier"
                      />
                    </div>
                    <div>
                      <Label>Min Delay (minutes)</Label>
                      <Input
                        type="number"
                        value={config?.minDelayMinutes || 20}
                        onChange={(e) => updateConfig.mutate({ minDelayMinutes: parseInt(e.target.value) })}
                        data-testid="input-min-delay"
                      />
                    </div>
                    <div>
                      <Label>Max Delay (minutes)</Label>
                      <Input
                        type="number"
                        value={config?.maxDelayMinutes || 40}
                        onChange={(e) => updateConfig.mutate({ maxDelayMinutes: parseInt(e.target.value) })}
                        data-testid="input-max-delay"
                      />
                    </div>
                    <div>
                      <Label>High Volume Buy Count</Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Buy immediately if this many buys detected
                      </p>
                      <Input
                        type="number"
                        value={config?.highVolumeBuyCount || 10}
                        onChange={(e) => updateConfig.mutate({ highVolumeBuyCount: parseInt(e.target.value) })}
                        data-testid="input-high-volume-count"
                      />
                    </div>
                    <div>
                      <Label>Price Rise Trigger (%)</Label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Buy immediately if price rises by this %
                      </p>
                      <Input
                        type="number"
                        value={config?.priceRiseTriggerPercent || 15}
                        onChange={(e) => updateConfig.mutate({ priceRiseTriggerPercent: parseFloat(e.target.value) })}
                        data-testid="input-price-rise-trigger"
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {hotWallet?.exists && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Pending Buys
              </CardTitle>
              <CardDescription>
                Tokens queued for purchase
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pendingLoading ? (
                <div className="space-y-2">
                  {[...Array(2)].map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : pendingBuys && pendingBuys.length > 0 ? (
                <div className="space-y-2">
                  {pendingBuys.map((pending) => (
                    <div
                      key={pending.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                      data-testid={`pending-buy-${pending.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-full bg-amber-500/10">
                          <Clock className="h-4 w-4 text-amber-500" />
                        </div>
                        <div>
                          <p className="font-medium">{pending.tokenSymbol}</p>
                          <p className="text-xs text-muted-foreground">
                            Initial: {formatPrice(pending.initialPrice)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge variant="outline">
                          {formatTime(pending.scheduledBuyAt)}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No pending buys</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Holdings
              </CardTitle>
              <CardDescription>
                Tokens bought through copy trading
              </CardDescription>
            </CardHeader>
            <CardContent>
              {holdingsLoading ? (
                <div className="space-y-2">
                  {[...Array(2)].map((_, i) => (
                    <Skeleton key={i} className="h-20 w-full" />
                  ))}
                </div>
              ) : holdings && holdings.length > 0 ? (
                <div className="space-y-2">
                  {holdings.map((holding) => {
                    const multiplier = holding.lastPrice && holding.buyPrice 
                      ? (holding.lastPrice / holding.buyPrice)
                      : 1;
                    const isProfit = multiplier > 1;
                    
                    return (
                      <div
                        key={holding.id}
                        className="flex items-center justify-between p-4 rounded-lg border bg-muted/30"
                        data-testid={`holding-${holding.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isProfit ? "bg-green-500/10" : "bg-red-500/10"}`}>
                            <DollarSign className={`h-4 w-4 ${isProfit ? "text-green-500" : "text-red-500"}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{holding.tokenSymbol}</p>
                              {holding.reclaimed && (
                                <Badge variant="secondary" className="text-xs">
                                  Reclaimed
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Bought: {holding.solSpent.toFixed(4)} SOL @ {formatPrice(holding.buyPrice)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`font-semibold ${isProfit ? "text-green-500" : "text-red-500"}`}>
                            {multiplier.toFixed(2)}x
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatPrice(holding.lastPrice)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No holdings yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
