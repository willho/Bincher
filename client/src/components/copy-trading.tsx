import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  ArrowUpRight,
  Bot,
  ChevronDown,
  Clock,
  Copy,
  DollarSign,
  ExternalLink, 
  Eye,
  EyeOff,
  Filter,
  Key,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  TrendingUp,
  Wallet,
  XCircle,
  Zap,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import type { TradeConfig, Holding, PendingBuy, MonitoredWallet } from "@shared/schema";

interface HotWalletInfo {
  exists: boolean;
  publicKey?: string;
  balance?: number;
  createdAt?: number;
}

export function CopyTrading() {
  const { toast } = useToast();
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showManualBuy, setShowManualBuy] = useState(false);
  const [manualBuyMint, setManualBuyMint] = useState("");
  const [manualBuyAmount, setManualBuyAmount] = useState("");
  const [showExportKey, setShowExportKey] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [exportingHoldingId, setExportingHoldingId] = useState<number | null>(null);
  const [hideDeadDust, setHideDeadDust] = useState(true);
  const [activeOpen, setActiveOpen] = useState(true);
  const [pendingOpen, setPendingOpen] = useState(true);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [signalWalletFilter, setSignalWalletFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("recent");

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

  const { data: monitoredWallets } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const uniqueSignalWallets = useMemo(() => {
    if (!holdings) return [];
    const walletMap = new Map<string, { address: string; label: string }>();
    holdings.forEach(h => {
      if (h.sourceWalletAddress) {
        walletMap.set(h.sourceWalletAddress, {
          address: h.sourceWalletAddress,
          label: h.sourceWalletLabel || `${h.sourceWalletAddress.slice(0, 6)}...${h.sourceWalletAddress.slice(-4)}`
        });
      }
    });
    return Array.from(walletMap.values());
  }, [holdings]);

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

  const manualBuy = useMutation({
    mutationFn: (data: { tokenMint: string; solAmount: number }) => 
      apiRequest("POST", "/api/copy-trade/manual-buy", data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/holdings"] });
      setManualBuyMint("");
      setManualBuyAmount("");
      setShowManualBuy(false);
      toast({ description: `Bought ${data.tokenSymbol} for ${data.solSpent?.toFixed(4)} SOL` });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to execute buy", variant: "destructive" });
    },
  });

  const exportHotWalletKey = useMutation({
    mutationFn: (password: string) => 
      apiRequest("POST", "/api/copy-trade/wallet/export-key", { password }),
    onSuccess: (data: any) => {
      setExportedKey(data.privateKey);
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to export key", variant: "destructive" });
    },
  });

  const exportTokenWalletKey = useMutation({
    mutationFn: (data: { holdingId: number; password: string }) => 
      apiRequest("POST", `/api/copy-trade/holdings/${data.holdingId}/export-key`, { password: data.password }),
    onSuccess: (data: any) => {
      setExportedKey(data.privateKey);
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to export key", variant: "destructive" });
    },
  });

  const handleExportKey = () => {
    if (exportingHoldingId !== null) {
      exportTokenWalletKey.mutate({ holdingId: exportingHoldingId, password: exportPassword });
    } else {
      exportHotWalletKey.mutate(exportPassword);
    }
  };

  const openExportDialog = (holdingId: number | null = null) => {
    setExportingHoldingId(holdingId);
    setExportPassword("");
    setExportedKey(null);
    setShowExportKey(true);
  };

  const withdrawSol = useMutation({
    mutationFn: (data: { destination: string; amount: number }) => 
      apiRequest("POST", "/api/copy-trade/withdraw", data),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/wallet"] });
      setWithdrawAddress("");
      setWithdrawAmount("");
      setShowWithdraw(false);
      toast({ description: `Withdrew ${data.amount} SOL successfully` });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Withdrawal failed", variant: "destructive" });
    },
  });

  const sellHolding = useMutation({
    mutationFn: ({ holdingId, percentage }: { holdingId: number; percentage?: number }) => 
      apiRequest("POST", `/api/copy-trade/sell/${holdingId}`, { percentage }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/holdings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/wallet"] });
      toast({ description: `Sold tokens for ${data.solReceived?.toFixed(4) || "?"} SOL` });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Sell failed", variant: "destructive" });
    },
  });

  const pausePendingBuy = useMutation({
    mutationFn: (pendingId: number) => 
      apiRequest("POST", `/api/copy-trade/pending/${pendingId}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Pending buy paused" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to pause", variant: "destructive" });
    },
  });

  const resumePendingBuy = useMutation({
    mutationFn: (pendingId: number) => 
      apiRequest("POST", `/api/copy-trade/pending/${pendingId}/resume`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Pending buy resumed" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to resume", variant: "destructive" });
    },
  });

  const cancelPendingBuy = useMutation({
    mutationFn: (pendingId: number) => 
      apiRequest("POST", `/api/copy-trade/pending/${pendingId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/pending"] });
      toast({ description: "Pending buy cancelled" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to cancel", variant: "destructive" });
    },
  });

  const updateHoldingStatus = useMutation({
    mutationFn: (data: { holdingId: number; positionStatus?: string; autonomyEnabled?: boolean }) => 
      apiRequest("PATCH", `/api/holdings/${data.holdingId}/status`, {
        positionStatus: data.positionStatus,
        autonomyEnabled: data.autonomyEnabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/holdings"] });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to update", variant: "destructive" });
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
            Automatically copy trades from your signal wallets
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
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openExportDialog(null)}
                      data-testid="button-export-hot-wallet-key"
                      title="Export private key"
                    >
                      <Key className="h-4 w-4" />
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

              <div className="border rounded-lg overflow-hidden">
                <button
                  className="w-full p-4 flex items-center justify-between hover-elevate"
                  onClick={() => setShowWithdraw(!showWithdraw)}
                  data-testid="button-toggle-withdraw"
                >
                  <div className="flex items-center gap-2">
                    <ArrowUpRight className="h-4 w-4" />
                    <span className="font-medium">Withdraw SOL</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {showWithdraw ? "Hide" : "Show"}
                  </span>
                </button>
                
                {showWithdraw && (
                  <div className="p-4 border-t space-y-4 bg-muted/30">
                    <div className="space-y-2">
                      <Label htmlFor="withdraw-address">Destination Address</Label>
                      <Input
                        id="withdraw-address"
                        placeholder="Solana wallet address"
                        value={withdrawAddress}
                        onChange={(e) => setWithdrawAddress(e.target.value)}
                        data-testid="input-withdraw-address"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="withdraw-amount">Amount (SOL)</Label>
                      <div className="flex gap-2">
                        <Input
                          id="withdraw-amount"
                          type="number"
                          step="0.001"
                          min="0"
                          placeholder="0.0"
                          value={withdrawAmount}
                          onChange={(e) => setWithdrawAmount(e.target.value)}
                          data-testid="input-withdraw-amount"
                        />
                        <Button
                          variant="outline"
                          onClick={() => setWithdrawAmount(((hotWallet?.balance || 0) - 0.005).toFixed(4))}
                          data-testid="button-withdraw-max"
                        >
                          Max
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Available: {((hotWallet?.balance || 0) - 0.005).toFixed(4)} SOL (0.005 reserved for fees)
                      </p>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => withdrawSol.mutate({ 
                        destination: withdrawAddress, 
                        amount: parseFloat(withdrawAmount) 
                      })}
                      disabled={withdrawSol.isPending || !withdrawAddress || !withdrawAmount}
                      data-testid="button-withdraw-sol"
                    >
                      {withdrawSol.isPending ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4 mr-2" />
                      )}
                      Withdraw
                    </Button>
                  </div>
                )}
              </div>

              <div className="border rounded-lg overflow-hidden">
                <button
                  className="w-full p-4 flex items-center justify-between hover-elevate"
                  onClick={() => setShowManualBuy(!showManualBuy)}
                  data-testid="button-toggle-manual-buy"
                >
                  <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    <span className="font-medium">Manual Buy</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {showManualBuy ? "Hide" : "Show"}
                  </span>
                </button>
                
                {showManualBuy && (
                  <div className="p-4 border-t space-y-4 bg-muted/30">
                    <div className="space-y-2">
                      <Label htmlFor="manual-buy-mint">Token Mint Address</Label>
                      <Input
                        id="manual-buy-mint"
                        placeholder="Token contract address"
                        value={manualBuyMint}
                        onChange={(e) => setManualBuyMint(e.target.value)}
                        data-testid="input-manual-buy-mint"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="manual-buy-amount">Amount (SOL)</Label>
                      <div className="flex gap-2">
                        <Input
                          id="manual-buy-amount"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.0"
                          value={manualBuyAmount}
                          onChange={(e) => setManualBuyAmount(e.target.value)}
                          data-testid="input-manual-buy-amount"
                        />
                        <Button
                          variant="outline"
                          onClick={() => setManualBuyAmount(((hotWallet?.balance || 0) * 0.1).toFixed(4))}
                          data-testid="button-manual-buy-10pct"
                        >
                          10%
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Available: {(hotWallet?.balance || 0).toFixed(4)} SOL
                      </p>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => manualBuy.mutate({ 
                        tokenMint: manualBuyMint, 
                        solAmount: parseFloat(manualBuyAmount) 
                      })}
                      disabled={manualBuy.isPending || !manualBuyMint || !manualBuyAmount}
                      data-testid="button-manual-buy-execute"
                    >
                      {manualBuy.isPending ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4 mr-2" />
                      )}
                      Buy Token
                    </Button>
                  </div>
                )}
              </div>

              {configLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-base">Enable Copy Trading</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically buy tokens when signal wallet buys
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
                  
                  <div className="border-t pt-4 mt-4">
                    <h4 className="font-medium mb-3">Trading Budget Limits</h4>
                    <p className="text-xs text-muted-foreground mb-4">
                      Protect your wallet with spending limits and reserve requirements
                    </p>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <Label>Max Per Trade ($)</Label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Cap single trade to this USD value
                        </p>
                        <Input
                          type="number"
                          placeholder="No limit"
                          value={config?.maxTradeUsd || ""}
                          onChange={(e) => updateConfig.mutate({ maxTradeUsd: e.target.value ? parseFloat(e.target.value) : undefined })}
                          data-testid="input-max-trade-usd"
                        />
                      </div>
                      <div>
                        <Label>Max Daily Spend ($)</Label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Stop trading after this daily spend
                        </p>
                        <Input
                          type="number"
                          placeholder="No limit"
                          value={config?.maxDailySpendUsd || ""}
                          onChange={(e) => updateConfig.mutate({ maxDailySpendUsd: e.target.value ? parseFloat(e.target.value) : undefined })}
                          data-testid="input-max-daily-spend"
                        />
                        {config?.dailySpentUsd ? (
                          <p className="text-xs text-muted-foreground mt-1">
                            Spent today: ${config.dailySpentUsd.toFixed(2)}
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <Label>Min Reserve (SOL)</Label>
                        <p className="text-xs text-muted-foreground mb-2">
                          Keep at least this SOL in wallet
                        </p>
                        <Input
                          type="number"
                          placeholder="No reserve"
                          value={config?.minReserveSol || ""}
                          onChange={(e) => updateConfig.mutate({ minReserveSol: e.target.value ? parseFloat(e.target.value) : undefined })}
                          data-testid="input-min-reserve-sol"
                        />
                      </div>
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
                  {pendingBuys.map((pending) => {
                    const isPaused = pending.status === "paused";
                    const isActive = pending.status === "active";
                    const isSegmented = (pending.totalSegments ?? 1) > 1;
                    
                    return (
                      <div
                        key={pending.id}
                        className={`flex items-center justify-between p-3 rounded-lg border ${isPaused ? "bg-amber-500/5 border-amber-500/20" : "bg-muted/30"}`}
                        data-testid={`pending-buy-${pending.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isPaused ? "bg-amber-500/20" : "bg-amber-500/10"}`}>
                            {isPaused ? (
                              <Pause className="h-4 w-4 text-amber-500" />
                            ) : (
                              <Clock className="h-4 w-4 text-amber-500" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium">{pending.tokenSymbol}</p>
                              {isSegmented && (
                                <Badge variant="secondary" className="text-xs">
                                  {pending.segmentIndex}/{pending.totalSegments}
                                </Badge>
                              )}
                              {isPaused && (
                                <Badge variant="outline" className="text-amber-500 border-amber-500/30 text-xs">
                                  Paused
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {pending.solAmount ? `${pending.solAmount.toFixed(3)} SOL` : `Initial: ${formatPrice(pending.initialPrice)}`}
                              {isPaused && pending.pauseReason && (
                                <span className="text-amber-500 ml-2">
                                  ({pending.pauseReason === "insufficient_funds" ? "Low balance" : pending.pauseReason})
                                </span>
                              )}
                            </p>
                            {pending.sourceWalletAddress && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Wallet className="h-3 w-3" />
                                <span>
                                  Copied from: {pending.sourceWalletLabel || `${pending.sourceWalletAddress.slice(0, 6)}...${pending.sourceWalletAddress.slice(-4)}`}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">
                            {formatTime(pending.scheduledBuyAt)}
                          </Badge>
                          <div className="flex items-center gap-1">
                            {isActive ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => pausePendingBuy.mutate(pending.id)}
                                disabled={pausePendingBuy.isPending}
                                title="Pause"
                                data-testid={`button-pause-pending-${pending.id}`}
                              >
                                <Pause className="h-4 w-4" />
                              </Button>
                            ) : isPaused ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => resumePendingBuy.mutate(pending.id)}
                                disabled={resumePendingBuy.isPending}
                                title="Resume"
                                data-testid={`button-resume-pending-${pending.id}`}
                              >
                                <Play className="h-4 w-4 text-green-500" />
                              </Button>
                            ) : null}
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => cancelPendingBuy.mutate(pending.id)}
                              disabled={cancelPendingBuy.isPending}
                              title="Cancel"
                              data-testid={`button-cancel-pending-${pending.id}`}
                            >
                              <XCircle className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <CardTitle className="text-lg flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Positions
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Label htmlFor="hide-dead-dust" className="text-xs text-muted-foreground cursor-pointer">
                    Hide dead/dust
                  </Label>
                  <Switch
                    id="hide-dead-dust"
                    checked={hideDeadDust}
                    onCheckedChange={setHideDeadDust}
                    data-testid="switch-hide-dead-dust"
                  />
                </div>
              </div>
              <CardDescription>
                Tokens bought through copy trading - organized by status
              </CardDescription>
            </CardHeader>

            <div className="px-6 pb-2">
              <div className="flex flex-wrap gap-3 items-end p-3 rounded-lg bg-muted/30 border">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Filter className="h-4 w-4" />
                  <span>Filters:</span>
                </div>
                
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Signal Wallet</Label>
                  <Select value={signalWalletFilter} onValueChange={setSignalWalletFilter}>
                    <SelectTrigger className="w-[180px] h-8" data-testid="select-signal-wallet-filter">
                      <SelectValue placeholder="All wallets" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All wallets</SelectItem>
                      <SelectItem value="manual">Manual buys</SelectItem>
                      {uniqueSignalWallets.map(w => (
                        <SelectItem key={w.address} value={w.address}>
                          {w.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Sort by</Label>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger className="w-[140px] h-8" data-testid="select-sort-by">
                      <SelectValue placeholder="Recent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="recent">Most Recent</SelectItem>
                      <SelectItem value="value">Highest Value</SelectItem>
                      <SelectItem value="profit">Best Profit</SelectItem>
                      <SelectItem value="loss">Worst Loss</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {(signalWalletFilter !== "all" || sortBy !== "recent") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setSignalWalletFilter("all");
                      setSortBy("recent");
                    }}
                    data-testid="button-clear-filters"
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            </div>
            <CardContent>
              {holdingsLoading ? (
                <div className="space-y-2">
                  {[...Array(2)].map((_, i) => (
                    <Skeleton key={i} className="h-20 w-full" />
                  ))}
                </div>
              ) : (() => {
                const allHoldings = holdings ?? [];
                
                let visibleHoldings = allHoldings.filter((h) => !hideDeadDust || (!h.isDead && !h.isDust));
                
                if (signalWalletFilter === "manual") {
                  visibleHoldings = visibleHoldings.filter((h) => !h.sourceWalletAddress);
                } else if (signalWalletFilter !== "all") {
                  visibleHoldings = visibleHoldings.filter((h) => h.sourceWalletAddress === signalWalletFilter);
                }
                
                const sortHoldings = (list: Holding[]) => {
                  return [...list].sort((a, b) => {
                    const aMultiplier = a.lastPrice && a.buyPrice ? (a.lastPrice / a.buyPrice) : 1;
                    const bMultiplier = b.lastPrice && b.buyPrice ? (b.lastPrice / b.buyPrice) : 1;
                    const aValue = a.currentAmount * (a.lastPrice || 0);
                    const bValue = b.currentAmount * (b.lastPrice || 0);
                    
                    switch (sortBy) {
                      case "value":
                        return bValue - aValue;
                      case "profit":
                        return bMultiplier - aMultiplier;
                      case "loss":
                        return aMultiplier - bMultiplier;
                      case "recent":
                      default:
                        return new Date(b.boughtAt).getTime() - new Date(a.boughtAt).getTime();
                    }
                  });
                };
                
                const hiddenCount = allHoldings.length - visibleHoldings.length;
                
                const activeHoldings = sortHoldings(visibleHoldings.filter((h) => 
                  h.positionStatus === "active" || (!h.positionStatus && h.currentAmount > 0)
                ));
                const pendingHoldings = sortHoldings(visibleHoldings.filter((h) => h.positionStatus === "pending"));
                const inactiveHoldings = sortHoldings(visibleHoldings.filter((h) => 
                  h.positionStatus === "inactive" || (!h.positionStatus && h.currentAmount <= 0)
                ));

                const renderHolding = (holding: Holding) => {
                  const multiplier = holding.lastPrice && holding.buyPrice 
                    ? (holding.lastPrice / holding.buyPrice)
                    : 1;
                  const isProfit = multiplier > 1;
                  const reclaimedMilestones = holding.reclaimedMilestones || [];
                  const isAutonomyEnabled = holding.autonomyEnabled ?? false;
                  
                  return (
                    <div
                      key={holding.id}
                      className="p-4 rounded-lg border bg-muted/30 space-y-3"
                      data-testid={`holding-${holding.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${isProfit ? "bg-green-500/10" : "bg-red-500/10"}`}>
                            <DollarSign className={`h-4 w-4 ${isProfit ? "text-green-500" : "text-red-500"}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium">{holding.tokenSymbol}</p>
                              {holding.isDead && (
                                <Badge variant="destructive" className="text-xs">Dead</Badge>
                              )}
                              {holding.isDust && !holding.isDead && (
                                <Badge variant="secondary" className="text-xs">Dust</Badge>
                              )}
                              {reclaimedMilestones.length > 0 && reclaimedMilestones.map((m) => (
                                <Badge key={m} variant={m === 4 ? "secondary" : "outline"} className="text-xs">
                                  {m}x
                                </Badge>
                              ))}
                              {isAutonomyEnabled && (
                                <Badge variant="outline" className="text-xs text-primary border-primary/30">
                                  <Zap className="h-3 w-3 mr-1" />
                                  Auto
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Bought: {holding.solSpent.toFixed(4)} SOL @ {formatPrice(holding.buyPrice)}
                            </p>
                            {holding.sourceWalletAddress && (
                              <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                                <Wallet className="h-3 w-3" />
                                <span>
                                  Copied from: {holding.sourceWalletLabel || `${holding.sourceWalletAddress.slice(0, 6)}...${holding.sourceWalletAddress.slice(-4)}`}
                                </span>
                              </div>
                            )}
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
                      
                      <div className="flex items-center gap-2 pt-2 border-t flex-wrap">
                        {holding.currentAmount > 0 && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => sellHolding.mutate({ holdingId: holding.id, percentage: 25 })}
                              disabled={sellHolding.isPending}
                              data-testid={`button-sell-25-${holding.id}`}
                            >
                              Sell 25%
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => sellHolding.mutate({ holdingId: holding.id, percentage: 50 })}
                              disabled={sellHolding.isPending}
                              data-testid={`button-sell-50-${holding.id}`}
                            >
                              Sell 50%
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => sellHolding.mutate({ holdingId: holding.id, percentage: 100 })}
                              disabled={sellHolding.isPending}
                              data-testid={`button-sell-all-${holding.id}`}
                            >
                              {sellHolding.isPending ? (
                                <RefreshCw className="h-3 w-3 animate-spin" />
                              ) : (
                                <>
                                  <Trash2 className="h-3 w-3 mr-1" />
                                  Sell All
                                </>
                              )}
                            </Button>
                          </>
                        )}
                        <div className="flex items-center gap-1 ml-auto">
                          <Button
                            size="icon"
                            variant={isAutonomyEnabled ? "default" : "ghost"}
                            onClick={() => updateHoldingStatus.mutate({ 
                              holdingId: holding.id, 
                              autonomyEnabled: !isAutonomyEnabled 
                            })}
                            title={isAutonomyEnabled ? "Disable auto-trading" : "Enable auto-trading"}
                            data-testid={`button-autonomy-${holding.id}`}
                          >
                            <Zap className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openExportDialog(holding.id)}
                            title="Export token wallet key"
                            data-testid={`button-export-token-key-${holding.id}`}
                          >
                            <Key className="h-4 w-4" />
                          </Button>
                          <a
                            href={`https://dexscreener.com/solana/${holding.tokenMint}`}
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
                  );
                };
                
                if (visibleHoldings.length === 0 && allHoldings.length === 0) {
                  return (
                    <div className="text-center py-8 text-muted-foreground">
                      <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No positions yet</p>
                    </div>
                  );
                }
                
                if (visibleHoldings.length === 0 && hideDeadDust) {
                  return (
                    <div className="text-center py-8 text-muted-foreground">
                      <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>All {allHoldings.length} positions are dead or dust</p>
                      <p className="text-xs mt-1">Toggle "Hide dead/dust" to view</p>
                    </div>
                  );
                }
                
                return (
                  <div className="space-y-4">
                    {hiddenCount > 0 && (
                      <p className="text-xs text-muted-foreground text-center">
                        {hiddenCount} dead/dust position{hiddenCount > 1 ? 's' : ''} hidden
                      </p>
                    )}
                    
                    {activeHoldings.length > 0 && (
                      <Collapsible open={activeOpen} onOpenChange={setActiveOpen}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 rounded-lg bg-green-500/10 border border-green-500/20 hover-elevate">
                          <div className="flex items-center gap-2">
                            <TrendingUp className="h-4 w-4 text-green-500" />
                            <span className="font-medium text-green-700 dark:text-green-300">Active Positions</span>
                            <Badge variant="outline" className="text-green-500 border-green-500/30">
                              {activeHoldings.length}
                            </Badge>
                          </div>
                          <ChevronDown className={`h-4 w-4 text-green-500 transition-transform ${activeOpen ? "rotate-180" : ""}`} />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-2 space-y-2">
                          {activeHoldings.map(renderHolding)}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                    
                    {pendingHoldings.length > 0 && (
                      <Collapsible open={pendingOpen} onOpenChange={setPendingOpen}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 hover-elevate">
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-amber-500" />
                            <span className="font-medium text-amber-700 dark:text-amber-300">Pending Positions</span>
                            <Badge variant="outline" className="text-amber-500 border-amber-500/30">
                              {pendingHoldings.length}
                            </Badge>
                          </div>
                          <ChevronDown className={`h-4 w-4 text-amber-500 transition-transform ${pendingOpen ? "rotate-180" : ""}`} />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-2 space-y-2">
                          {pendingHoldings.map(renderHolding)}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                    
                    {inactiveHoldings.length > 0 && (
                      <Collapsible open={inactiveOpen} onOpenChange={setInactiveOpen}>
                        <CollapsibleTrigger className="flex items-center justify-between w-full p-3 rounded-lg bg-muted/50 border hover-elevate">
                          <div className="flex items-center gap-2">
                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium text-muted-foreground">Inactive / Watching</span>
                            <Badge variant="secondary">
                              {inactiveHoldings.length}
                            </Badge>
                          </div>
                          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${inactiveOpen ? "rotate-180" : ""}`} />
                        </CollapsibleTrigger>
                        <CollapsibleContent className="pt-2 space-y-2">
                          {inactiveHoldings.map(renderHolding)}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={showExportKey} onOpenChange={(open) => {
        setShowExportKey(open);
        if (!open) {
          setExportPassword("");
          setExportedKey(null);
          setExportingHoldingId(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              Export Private Key
            </DialogTitle>
            <DialogDescription>
              {exportingHoldingId !== null 
                ? "Export the private key for this token wallet. Use it to import into Phantom or Solflare."
                : "Export your hot wallet private key. Use it to import into Phantom or Solflare."
              }
            </DialogDescription>
          </DialogHeader>
          
          {!exportedKey ? (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Never share your private key with anyone. Anyone with your private key can access your funds.
                </p>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="export-password">Enter your password to confirm</Label>
                <Input
                  id="export-password"
                  type="password"
                  placeholder="Your account password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  data-testid="input-export-password"
                />
              </div>
              
              <Button
                onClick={handleExportKey}
                disabled={!exportPassword || exportHotWalletKey.isPending || exportTokenWalletKey.isPending}
                className="w-full"
                data-testid="button-confirm-export"
              >
                {(exportHotWalletKey.isPending || exportTokenWalletKey.isPending) ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Show Private Key"
                )}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive">
                  Keep this private key secure. Do not share it with anyone.
                </p>
              </div>
              
              <div className="space-y-2">
                <Label>Private Key (Base58)</Label>
                <div className="relative">
                  <Input
                    readOnly
                    value={exportedKey}
                    className="font-mono text-xs pr-10"
                    data-testid="input-exported-key"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => copyToClipboard(exportedKey, "Private key")}
                    data-testid="button-copy-exported-key"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              
              <Button
                variant="outline"
                onClick={() => setShowExportKey(false)}
                className="w-full"
                data-testid="button-close-export"
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
