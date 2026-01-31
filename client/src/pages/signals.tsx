import { useState, useMemo } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { 
  Wallet, 
  TrendingUp, 
  TrendingDown, 
  ExternalLink, 
  ChevronRight,
  ChevronDown,
  Coins,
  Copy,
  Eye,
  Plus,
  Trash2,
  Edit2,
  Check,
  X,
  RefreshCw,
  Activity,
  Clock
} from "lucide-react";
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

export default function SignalsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  // Wallet management state
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  
  // Position detail modal state
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null);

  useDocumentMeta({
    title: "Signal Wallets | Penny Pincher",
    description: "Monitor and copy trades from signal wallets on Solana. View wallet performance, positions, and P&L."
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const { data: holdings } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: swaps } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
  });

  // Mutations for wallet management
  const addWallet = useMutation({
    mutationFn: (data: { walletAddress: string; label?: string }) =>
      apiRequest("POST", "/api/monitored-wallets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      setNewWalletAddress("");
      setNewWalletLabel("");
      setShowAddWallet(false);
      toast({ description: "Wallet added successfully" });
      syncWebhook.mutate();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to add wallet", variant: "destructive" });
    },
  });

  const updateWallet = useMutation({
    mutationFn: ({ id, ...data }: { id: number; label?: string; enabled?: boolean; copyTradeEnabled?: boolean }) =>
      apiRequest("PATCH", `/api/monitored-wallets/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      setEditingId(null);
      toast({ description: "Wallet updated" });
      syncWebhook.mutate();
    },
  });

  const deleteWallet = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/monitored-wallets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      toast({ description: "Wallet removed" });
      syncWebhook.mutate();
    },
  });

  const syncWebhook = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitored-wallets/sync"),
  });

  // Build token name lookup from swaps
  const tokenSymbolLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    if (swaps) {
      swaps.forEach(swap => {
        if (swap.toToken && swap.toTokenSymbol) {
          lookup.set(swap.toToken, swap.toTokenSymbol);
        }
        if (swap.fromToken && swap.fromTokenSymbol) {
          lookup.set(swap.fromToken, swap.fromTokenSymbol);
        }
      });
    }
    return lookup;
  }, [swaps]);

  const getTokenSymbol = (holding: Holding): string => {
    if (holding.tokenSymbol) return holding.tokenSymbol;
    if (holding.tokenMint && tokenSymbolLookup.has(holding.tokenMint)) {
      return tokenSymbolLookup.get(holding.tokenMint)!;
    }
    return holding.tokenMint ? `${holding.tokenMint.slice(0, 4)}...` : "???";
  };

  // Calculate wallet stats
  const walletStats = useMemo(() => {
    const stats = new Map<number, { 
      totalValue: number; 
      totalPnl: number; 
      positionCount: number;
      activeCount: number;
      swapCount: number;
      lastSwapTime: number | null;
    }>();

    if (!holdings || !wallets) return stats;

    wallets.forEach(wallet => {
      const walletHoldings = holdings.filter(h => h.signalWalletId === wallet.id);
      const active = walletHoldings.filter(h => !h.reclaimed && h.currentAmount > 0);
      
      const totalValue = active.reduce((sum, h) => {
        return sum + ((h.lastPrice || h.buyPrice) * h.currentAmount);
      }, 0);

      const totalPnl = active.reduce((sum, h) => {
        const currentVal = (h.lastPrice || h.buyPrice) * h.currentAmount;
        const costBasis = h.buyPrice * h.amountBought;
        return sum + (currentVal - costBasis);
      }, 0);

      const walletSwaps = swaps?.filter(s => s.source === wallet.walletAddress) || [];
      const sortedSwaps = [...walletSwaps].sort((a, b) => b.timestamp - a.timestamp);

      stats.set(wallet.id, {
        totalValue,
        totalPnl,
        positionCount: walletHoldings.length,
        activeCount: active.length,
        swapCount: walletSwaps.length,
        lastSwapTime: sortedSwaps[0]?.timestamp || null,
      });
    });

    return stats;
  }, [holdings, wallets, swaps]);

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
  };

  const formatSol = (val: number) => {
    if (val >= 1000) return `${(val / 1000).toFixed(2)}K`;
    if (val >= 1) return val.toFixed(2);
    return val.toFixed(4);
  };

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const formatTimeAgo = (timestamp: number) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return `${Math.floor(diff / 604800)}w ago`;
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: "Address copied" });
    } catch {
      toast({ description: "Failed to copy", variant: "destructive" });
    }
  };

  const handleAddWallet = () => {
    if (!newWalletAddress.trim()) {
      toast({ description: "Please enter a wallet address", variant: "destructive" });
      return;
    }
    addWallet.mutate({ 
      walletAddress: newWalletAddress.trim(), 
      label: newWalletLabel.trim() || undefined 
    });
  };

  const startEditing = (wallet: MonitoredWallet) => {
    setEditingId(wallet.id);
    setEditLabel(wallet.label || "");
  };

  const activeWallets = wallets?.filter(w => w.enabled) || [];
  const copyEnabledWallets = wallets?.filter(w => w.copyTradeEnabled) || [];

  const totalValue = Array.from(walletStats.values()).reduce((sum, s) => sum + s.totalValue, 0);
  const totalPnl = Array.from(walletStats.values()).reduce((sum, s) => sum + s.totalPnl, 0);

  // Calculate P&L for selected holding
  const getHoldingPnl = (holding: Holding) => {
    const currentPrice = holding.lastPrice || holding.buyPrice;
    const currentValue = currentPrice * holding.currentAmount;
    const costBasis = holding.buyPrice * holding.amountBought;
    const pnlAmount = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0;
    return { currentValue, costBasis, pnlAmount, pnlPercent, currentPrice };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Signal Wallets</h1>
          <p className="text-muted-foreground" data-testid="text-page-subtitle">Manage and monitor signal wallets</p>
        </div>
        <Button 
          onClick={() => setShowAddWallet(!showAddWallet)}
          data-testid="button-toggle-add-wallet"
        >
          {showAddWallet ? <ChevronDown className="h-4 w-4 mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          {showAddWallet ? "Hide" : "Add Wallet"}
        </Button>
      </div>

      {showAddWallet && (
        <Card data-testid="card-add-wallet">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Add Signal Wallet</CardTitle>
            <CardDescription>Enter a Solana wallet address to monitor for trade signals</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wallet-address">Wallet Address</Label>
                <Input
                  id="wallet-address"
                  data-testid="input-wallet-address"
                  placeholder="Enter Solana wallet address"
                  value={newWalletAddress}
                  onChange={(e) => setNewWalletAddress(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wallet-label">Label (optional)</Label>
                <Input
                  id="wallet-label"
                  data-testid="input-wallet-label"
                  placeholder="e.g., Main Trader, Alpha Wallet"
                  value={newWalletLabel}
                  onChange={(e) => setNewWalletLabel(e.target.value)}
                />
              </div>
            </div>
            <Button
              data-testid="button-add-wallet"
              onClick={handleAddWallet}
              disabled={addWallet.isPending}
            >
              {addWallet.isPending ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add Wallet
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card data-testid="card-total-signals">
          <CardHeader className="pb-2">
            <CardDescription>Signal Wallets</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-wallet-count">{wallets?.length || 0}</div>
            <p className="text-xs text-muted-foreground" data-testid="text-wallet-stats">
              {activeWallets.length} active, {copyEnabledWallets.length} copying
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-total-positions">
          <CardHeader className="pb-2">
            <CardDescription>Total Positions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-positions-count">
              {holdings?.filter(h => !h.reclaimed && h.currentAmount > 0).length || 0}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-signals-value">
          <CardHeader className="pb-2">
            <CardDescription>Total Value</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-value">{formatUsd(totalValue)}</div>
          </CardContent>
        </Card>

        <Card data-testid="card-signals-pnl">
          <CardHeader className="pb-2">
            <CardDescription>Total P&L</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalPnl >= 0 ? "text-green-500" : "text-red-500"}`} data-testid="text-total-pnl">
              {totalPnl >= 0 ? "+" : ""}{formatUsd(totalPnl)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-wallets-list">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            All Signal Wallets
          </CardTitle>
        </CardHeader>
        <CardContent>
          {walletsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : !wallets?.length ? (
            <div className="text-center py-12 text-muted-foreground" data-testid="text-empty-signals">
              <Wallet className="h-10 w-10 mx-auto mb-2 opacity-50" />
              <p>No wallets added yet</p>
              <p className="text-sm">Add a wallet address to start monitoring swaps</p>
            </div>
          ) : (
            <div className="space-y-3">
              {wallets.map(wallet => {
                const stats = walletStats.get(wallet.id);
                const walletHoldings = holdings?.filter(h => 
                  h.signalWalletId === wallet.id && !h.reclaimed && h.currentAmount > 0
                ) || [];

                return (
                  <div
                    key={wallet.id}
                    className="border rounded-lg p-4 hover-elevate"
                    data-testid={`card-signal-${wallet.id}`}
                  >
                    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="min-w-0">
                          {editingId === wallet.id ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={editLabel}
                                onChange={(e) => setEditLabel(e.target.value)}
                                placeholder="Enter label"
                                className="h-8 w-40"
                                data-testid={`input-edit-label-${wallet.id}`}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => updateWallet.mutate({ id: wallet.id, label: editLabel })}
                                data-testid={`button-save-label-${wallet.id}`}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setEditingId(null)}
                                data-testid={`button-cancel-edit-${wallet.id}`}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="font-medium flex items-center gap-2 flex-wrap">
                                <span data-testid={`text-label-${wallet.id}`}>{wallet.label || "Unnamed Wallet"}</span>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6"
                                  onClick={() => startEditing(wallet)}
                                  data-testid={`button-edit-wallet-${wallet.id}`}
                                >
                                  <Edit2 className="h-3 w-3" />
                                </Button>
                                <a
                                  href={`https://solscan.io/account/${wallet.walletAddress}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-muted-foreground hover:text-foreground"
                                  data-testid={`link-solscan-${wallet.id}`}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </div>
                              <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                                <a
                                  href={`https://solscan.io/account/${wallet.walletAddress}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="hover:underline hover:text-foreground"
                                  data-testid={`link-address-${wallet.id}`}
                                >
                                  {truncateAddress(wallet.walletAddress)}
                                </a>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5"
                                  onClick={() => copyToClipboard(wallet.walletAddress)}
                                  data-testid={`button-copy-address-${wallet.id}`}
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 text-xs">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1">
                                <Eye className="h-3 w-3 text-muted-foreground" />
                                <Switch
                                  checked={wallet.enabled ?? true}
                                  onCheckedChange={(enabled) =>
                                    updateWallet.mutate({ id: wallet.id, enabled })
                                  }
                                  data-testid={`switch-wallet-enabled-${wallet.id}`}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>Monitor wallet</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1">
                                <Copy className="h-3 w-3 text-muted-foreground" />
                                <Switch
                                  checked={wallet.copyTradeEnabled ?? false}
                                  onCheckedChange={(copyTradeEnabled) =>
                                    updateWallet.mutate({ id: wallet.id, copyTradeEnabled })
                                  }
                                  data-testid={`switch-wallet-copy-${wallet.id}`}
                                  className={wallet.copyTradeEnabled ? "data-[state=checked]:bg-green-500" : ""}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>Copy trades</TooltipContent>
                          </Tooltip>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteWallet.mutate(wallet.id)}
                          disabled={deleteWallet.isPending}
                          data-testid={`button-delete-wallet-${wallet.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                        <Link href={`/signal/${wallet.id}`}>
                          <Button variant="ghost" size="icon" data-testid={`button-view-${wallet.id}`}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>

                    {stats && (
                      <div className="flex items-center gap-4 text-sm mb-3 flex-wrap" data-testid={`stats-${wallet.id}`}>
                        {stats.activeCount > 0 && (
                          <>
                            <div>
                              <span className="text-muted-foreground">Value: </span>
                              <span className="font-mono" data-testid={`text-value-${wallet.id}`}>{formatUsd(stats.totalValue)}</span>
                            </div>
                            <div className={stats.totalPnl >= 0 ? "text-green-500" : "text-red-500"}>
                              <span className="text-muted-foreground">P&L: </span>
                              <span className="font-mono" data-testid={`text-pnl-${wallet.id}`}>
                                {stats.totalPnl >= 0 ? "+" : ""}{formatUsd(stats.totalPnl)}
                              </span>
                            </div>
                          </>
                        )}
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Activity className="h-3 w-3" />
                          <span data-testid={`text-swaps-${wallet.id}`}>{stats.swapCount} swaps</span>
                        </div>
                        {stats.lastSwapTime && (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            <span data-testid={`text-last-${wallet.id}`}>{formatTimeAgo(stats.lastSwapTime)}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {walletHoldings.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {walletHoldings.slice(0, 5).map(holding => {
                          const pnl = holding.lastPrice 
                            ? ((holding.lastPrice - holding.buyPrice) / holding.buyPrice) * 100 
                            : 0;
                          return (
                            <Badge
                              key={holding.id}
                              variant="outline"
                              className="cursor-pointer hover-elevate"
                              onClick={() => setSelectedHolding(holding)}
                              data-testid={`badge-position-${holding.id}`}
                            >
                              <Coins className="h-3 w-3 mr-1" />
                              <span data-testid={`text-badge-symbol-${holding.id}`}>{getTokenSymbol(holding)}</span>
                              <span className={`ml-1 ${pnl >= 0 ? "text-green-500" : "text-red-500"}`} data-testid={`text-badge-pnl-${holding.id}`}>
                                {pnl >= 0 ? "+" : ""}{pnl.toFixed(0)}%
                              </span>
                            </Badge>
                          );
                        })}
                        {walletHoldings.length > 5 && (
                          <Badge variant="outline" className="text-muted-foreground" data-testid={`badge-more-${wallet.id}`}>
                            +{walletHoldings.length - 5} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedHolding} onOpenChange={(open) => !open && setSelectedHolding(null)}>
        <DialogContent data-testid="dialog-position-detail">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Coins className="h-5 w-5" />
              {selectedHolding && getTokenSymbol(selectedHolding)}
            </DialogTitle>
            <DialogDescription>
              Position details
            </DialogDescription>
          </DialogHeader>
          {selectedHolding && (() => {
            const { currentValue, costBasis, pnlAmount, pnlPercent, currentPrice } = getHoldingPnl(selectedHolding);
            const signalWallet = wallets?.find(w => w.id === selectedHolding.signalWalletId);
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Entry Price</p>
                    <p className="font-mono" data-testid="text-detail-entry">{formatSol(selectedHolding.buyPrice)} SOL</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Current Price</p>
                    <p className="font-mono" data-testid="text-detail-current">{formatSol(currentPrice)} SOL</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Amount Bought</p>
                    <p className="font-mono" data-testid="text-detail-amount">{formatSol(selectedHolding.amountBought)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Current Amount</p>
                    <p className="font-mono" data-testid="text-detail-current-amount">{formatSol(selectedHolding.currentAmount)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Cost Basis</p>
                    <p className="font-mono" data-testid="text-detail-cost">{formatUsd(costBasis)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Current Value</p>
                    <p className="font-mono" data-testid="text-detail-value">{formatUsd(currentValue)}</p>
                  </div>
                </div>
                
                <div className="border-t pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">P&L</span>
                    <div className={`text-lg font-bold ${pnlPercent >= 0 ? "text-green-500" : "text-red-500"}`} data-testid="text-detail-pnl">
                      {pnlAmount >= 0 ? "+" : ""}{formatUsd(pnlAmount)} ({pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(1)}%)
                    </div>
                  </div>
                </div>

                {signalWallet && (
                  <div className="border-t pt-4 text-sm">
                    <p className="text-muted-foreground mb-1">Signal Source</p>
                    <a
                      href={`https://solscan.io/account/${signalWallet.walletAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                      data-testid="link-signal-source"
                    >
                      {signalWallet.label || truncateAddress(signalWallet.walletAddress)}
                    </a>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <a
                    href={`https://dexscreener.com/solana/${selectedHolding.tokenMint}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1"
                  >
                    <Button variant="outline" className="w-full" data-testid="button-view-chart">
                      <ExternalLink className="h-4 w-4 mr-2" />
                      View Chart
                    </Button>
                  </a>
                  <Link href={`/trading/${selectedHolding.tokenMint}`} className="flex-1">
                    <Button className="w-full" data-testid="button-trade">
                      Trade
                    </Button>
                  </Link>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
