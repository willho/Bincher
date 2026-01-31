import { useState, useMemo } from "react";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Coins, 
  TrendingUp, 
  TrendingDown, 
  ExternalLink, 
  Clock, 
  ArrowUpDown,
  Filter,
  Wallet,
  Archive,
  ChevronRight
} from "lucide-react";
import type { Holding } from "@shared/schema";

interface SignalWallet {
  id: number;
  address: string;
  label: string | null;
}

type SortOption = "value" | "pnl" | "recent" | "name";

export default function HoldingsPage() {
  const [, params] = useRoute("/holdings/:token");
  const [, setLocation] = useLocation();
  const selectedToken = params?.token;

  const [signalFilter, setSignalFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortOption>("value");
  const [showClosed, setShowClosed] = useState(false);

  useDocumentMeta({
    title: selectedToken ? "Position Details | Penny Pincher" : "Holdings | Penny Pincher",
    description: selectedToken 
      ? "View detailed position information including P&L, buy price, and signal source."
      : "View and manage your copy-traded positions on Solana. Track value, P&L, and signal sources."
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: signalWallets } = useQuery<SignalWallet[]>({
    queryKey: ["/api/signal-wallets"],
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
    return activeHoldings.reduce((sum, h) => {
      return sum + ((h.lastPrice || h.buyPrice) * h.currentAmount);
    }, 0);
  }, [activeHoldings]);

  const totalPnl = useMemo(() => {
    return activeHoldings.reduce((sum, h) => {
      const currentVal = (h.lastPrice || h.buyPrice) * h.currentAmount;
      const costBasis = h.buyPrice * h.amountBought;
      return sum + (currentVal - costBasis);
    }, 0);
  }, [activeHoldings]);

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(2)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(2)}K`;
    return `$${val.toFixed(2)}`;
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

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

        <div className="flex items-center justify-between">
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
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Holdings</h1>
          <p className="text-muted-foreground" data-testid="text-page-subtitle">Your copy-traded token positions</p>
        </div>
      </div>

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
    </div>
  );
}
