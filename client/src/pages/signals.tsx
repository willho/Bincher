import { useState, useMemo } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Wallet, 
  TrendingUp, 
  TrendingDown, 
  ExternalLink, 
  ChevronRight,
  Coins,
  Copy,
  Eye
} from "lucide-react";
import type { Holding } from "@shared/schema";

interface SignalWallet {
  id: number;
  address: string;
  label: string | null;
  isActive: boolean;
  copyEnabled: boolean;
}

export default function SignalsPage() {
  const [, setLocation] = useLocation();

  useDocumentMeta({
    title: "Signal Wallets | Penny Pincher",
    description: "Monitor and copy trades from signal wallets on Solana. View wallet performance, positions, and P&L."
  });

  const { data: signalWallets, isLoading: walletsLoading } = useQuery<SignalWallet[]>({
    queryKey: ["/api/signal-wallets"],
  });

  const { data: holdings } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const walletStats = useMemo(() => {
    const stats = new Map<number, { 
      totalValue: number; 
      totalPnl: number; 
      positionCount: number;
      activeCount: number;
    }>();

    if (!holdings || !signalWallets) return stats;

    signalWallets.forEach(wallet => {
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

      stats.set(wallet.id, {
        totalValue,
        totalPnl,
        positionCount: walletHoldings.length,
        activeCount: active.length,
      });
    });

    return stats;
  }, [holdings, signalWallets]);

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
  };

  const truncateAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const activeWallets = signalWallets?.filter(w => w.isActive) || [];
  const copyEnabledWallets = signalWallets?.filter(w => w.copyEnabled) || [];

  const totalValue = Array.from(walletStats.values()).reduce((sum, s) => sum + s.totalValue, 0);
  const totalPnl = Array.from(walletStats.values()).reduce((sum, s) => sum + s.totalPnl, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Signal Wallets</h1>
          <p className="text-muted-foreground" data-testid="text-page-subtitle">Wallets you're monitoring and copying</p>
        </div>
        <Link href="/watchlist" data-testid="link-manage-wallets">
          <Button variant="outline" data-testid="button-manage-wallets">
            Manage Wallets
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card data-testid="card-total-signals">
          <CardHeader className="pb-2">
            <CardDescription>Signal Wallets</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-wallet-count">{signalWallets?.length || 0}</div>
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
          ) : !signalWallets?.length ? (
            <div className="text-center py-12 text-muted-foreground" data-testid="text-empty-signals">
              No signal wallets configured. Add wallets in the Watchlist to start copying trades.
            </div>
          ) : (
            <div className="space-y-3">
              {signalWallets.map(wallet => {
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
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div>
                          <div className="font-medium flex items-center gap-2">
                            <span data-testid={`text-label-${wallet.id}`}>{wallet.label || truncateAddress(wallet.address)}</span>
                            <a
                              href={`https://solscan.io/account/${wallet.address}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground hover:text-foreground"
                              data-testid={`link-solscan-${wallet.id}`}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                          <div className="text-xs text-muted-foreground font-mono" data-testid={`text-address-${wallet.id}`}>
                            {truncateAddress(wallet.address)}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {wallet.isActive && (
                          <Badge variant="secondary" data-testid={`badge-active-${wallet.id}`}>
                            <Eye className="h-3 w-3 mr-1" />
                            Monitoring
                          </Badge>
                        )}
                        {wallet.copyEnabled && (
                          <Badge variant="default" data-testid={`badge-copying-${wallet.id}`}>
                            <Copy className="h-3 w-3 mr-1" />
                            Copying
                          </Badge>
                        )}
                        <Link href={`/signal/${wallet.id}`}>
                          <Button variant="ghost" size="icon" data-testid={`button-view-${wallet.id}`}>
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>

                    {stats && stats.activeCount > 0 && (
                      <div className="flex items-center gap-4 text-sm mb-3 pl-0" data-testid={`stats-${wallet.id}`}>
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
                        <div>
                          <span className="text-muted-foreground">Positions: </span>
                          <span data-testid={`text-count-${wallet.id}`}>{stats.activeCount}</span>
                        </div>
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
                              onClick={() => setLocation(`/holdings/${holding.tokenMint}`)}
                              data-testid={`badge-position-${holding.id}`}
                            >
                              <Coins className="h-3 w-3 mr-1" />
                              <span data-testid={`text-badge-symbol-${holding.id}`}>{holding.tokenSymbol}</span>
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
    </div>
  );
}
