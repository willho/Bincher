import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Copy, Plus, Trash2, Wallet, RefreshCw, Edit2, Check, X, Share2, Users, Clock, CheckCircle, XCircle, Brain, Activity, TrendingUp, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Swap } from "@shared/schema";

interface MonitoredWallet {
  id: number;
  userId: number;
  walletAddress: string;
  label: string | null;
  enabled: boolean | null;
  copyTradeEnabled: boolean | null;
  createdAt: number;
  isShared: boolean | null;
  shareStatus: string | null;
  aiScore: number | null;
  aiScoreDetails: string | null;
}

interface WalletStats {
  totalSwaps: number;
  last7Days: number;
  lastSwapTime: number | null;
}

export function MonitoredWallets() {
  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: wallets, isLoading } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const { data: swaps } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
  });

  const walletStats = useMemo(() => {
    if (!wallets || !swaps) return {};
    
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 604800;
    
    const stats: Record<string, WalletStats> = {};
    
    for (const wallet of wallets) {
      const walletSwaps = swaps.filter(s => s.source === wallet.walletAddress);
      const recent7d = walletSwaps.filter(s => s.timestamp > weekAgo);
      const sortedByTime = [...walletSwaps].sort((a, b) => b.timestamp - a.timestamp);
      
      stats[wallet.walletAddress] = {
        totalSwaps: walletSwaps.length,
        last7Days: recent7d.length,
        lastSwapTime: sortedByTime[0]?.timestamp || null,
      };
    }
    
    return stats;
  }, [wallets, swaps]);

  const addWallet = useMutation({
    mutationFn: (data: { walletAddress: string; label?: string }) =>
      apiRequest("POST", "/api/monitored-wallets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      setNewWalletAddress("");
      setNewWalletLabel("");
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

  const shareWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/monitored-wallets/${id}/share`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      toast({ description: "Wallet submitted for community sharing approval" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to submit wallet", variant: "destructive" });
    },
  });

  const unshareWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/monitored-wallets/${id}/unshare`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      toast({ description: "Wallet sharing cancelled" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to cancel sharing", variant: "destructive" });
    },
  });

  const getShareStatusBadge = (wallet: MonitoredWallet) => {
    if (!wallet.isShared || wallet.shareStatus === "none") return null;
    switch (wallet.shareStatus) {
      case "pending":
        return (
          <Badge variant="outline" className="text-yellow-500 border-yellow-500/50 gap-1">
            <Clock className="h-3 w-3" /> Pending
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="text-green-500 border-green-500/50 gap-1">
            <CheckCircle className="h-3 w-3" /> Shared
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="outline" className="text-red-500 border-red-500/50 gap-1">
            <XCircle className="h-3 w-3" /> Rejected
          </Badge>
        );
      default:
        return null;
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-500";
    if (score >= 40) return "text-yellow-500";
    return "text-red-500";
  };

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

  const saveEdit = (id: number) => {
    updateWallet.mutate({ id, label: editLabel });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Signal Wallets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Signal Wallets
        </CardTitle>
        <CardDescription>
          Add Solana wallet addresses to follow for trade signals. All your signal wallets are monitored for copy trading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
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
          <Button
            data-testid="button-add-wallet"
            onClick={handleAddWallet}
            disabled={addWallet.isPending}
            className="w-full"
          >
            {addWallet.isPending ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add Wallet
          </Button>
        </div>

        {wallets && wallets.length > 0 && (
          <div className="space-y-2 pt-4 border-t">
            <Label>Your Signal Wallets</Label>
            {wallets.map((wallet) => {
              const stats = walletStats[wallet.walletAddress];
              return (
                <div
                  key={wallet.id}
                  data-testid={`wallet-item-${wallet.id}`}
                  className="flex flex-col gap-2 p-3 bg-muted/50 rounded-lg hover-elevate cursor-pointer group"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, input, [role="switch"]')) return;
                    setLocation(`/signal/${wallet.id}`);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      {editingId === wallet.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            placeholder="Enter label"
                            className="h-8"
                            data-testid={`input-edit-label-${wallet.id}`}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => saveEdit(wallet.id)}
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
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">
                              {wallet.label || "Unnamed Wallet"}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => startEditing(wallet)}
                              data-testid={`button-edit-wallet-${wallet.id}`}
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                            {wallet.aiScore !== null && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className={`gap-1 ${getScoreColor(wallet.aiScore)}`}>
                                    <Brain className="h-3 w-3" />
                                    {wallet.aiScore}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>AI Trading Score based on historical performance</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {getShareStatusBadge(wallet)}
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground font-mono truncate">
                              {wallet.walletAddress.slice(0, 8)}...{wallet.walletAddress.slice(-6)}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => copyToClipboard(wallet.walletAddress)}
                              data-testid={`button-copy-address-${wallet.id}`}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1">
                          <Switch
                            checked={wallet.enabled ?? true}
                            onCheckedChange={(enabled) =>
                              updateWallet.mutate({ id: wallet.id, enabled })
                            }
                            data-testid={`switch-wallet-enabled-${wallet.id}`}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>Monitor wallet swaps</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1">
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
                      <TooltipContent>Copy trades from this wallet</TooltipContent>
                    </Tooltip>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteWallet.mutate(wallet.id)}
                      disabled={deleteWallet.isPending}
                      data-testid={`button-delete-wallet-${wallet.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>

                  {stats && (
                    <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1 border-t border-muted/50">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1" data-testid={`stat-total-${wallet.id}`}>
                            <Activity className="h-3 w-3" />
                            <span>{stats.totalSwaps} total</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>Total swaps detected</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1" data-testid={`stat-7d-${wallet.id}`}>
                            <TrendingUp className="h-3 w-3" />
                            <span>{stats.last7Days} / 7d</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>Swaps in last 7 days</TooltipContent>
                      </Tooltip>
                      {stats.lastSwapTime && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1" data-testid={`stat-last-${wallet.id}`}>
                              <Clock className="h-3 w-3" />
                              <span>{formatTimeAgo(stats.lastSwapTime)}</span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>Last activity</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1 border-t border-muted">
                    {!wallet.isShared || wallet.shareStatus === "none" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs"
                        onClick={() => shareWallet.mutate(wallet.id)}
                        disabled={shareWallet.isPending}
                        data-testid={`button-share-wallet-${wallet.id}`}
                      >
                        <Share2 className="h-3 w-3" />
                        Share with Community
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-xs text-muted-foreground"
                        onClick={() => unshareWallet.mutate(wallet.id)}
                        disabled={unshareWallet.isPending}
                        data-testid={`button-unshare-wallet-${wallet.id}`}
                      >
                        <X className="h-3 w-3" />
                        Cancel Sharing
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(!wallets || wallets.length === 0) && (
          <div className="text-center py-6 text-muted-foreground">
            <Wallet className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p>No wallets added yet</p>
            <p className="text-sm">Add a wallet address to start monitoring swaps</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
