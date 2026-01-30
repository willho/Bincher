import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, ArrowRight, Bell, Coins, DollarSign, Eye, Settings, TrendingUp, Wallet, Zap } from "lucide-react";
import { Alerts } from "@/components/alerts";
import type { Swap, Holding } from "@shared/schema";

interface ExtendedStatus {
  walletAddress: string;
  isActive: boolean;
  lastUpdated: number;
  totalSwapsDetected: number;
  webhookId?: string;
  monitoredWalletsCount?: number;
}

interface HotWalletInfo {
  exists: boolean;
  publicKey?: string;
  balance?: number;
  createdAt?: number;
}

export default function DashboardPage() {
  const { data: status, isLoading: statusLoading } = useQuery<ExtendedStatus>({
    queryKey: ["/api/status"],
    refetchInterval: 30000,
  });

  const { data: swaps, isLoading: swapsLoading } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
  });

  const { data: unreadCount } = useQuery<{ count: number }>({
    queryKey: ["/api/messages/unread-count"],
    refetchInterval: 60000,
  });

  const { data: hotWallet, isLoading: walletLoading } = useQuery<HotWalletInfo>({
    queryKey: ["/api/copy-trade/wallet"],
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  const { data: solPriceData } = useQuery<{ price: number }>({
    queryKey: ["/api/sol-price"],
    refetchInterval: 60000,
  });

  const solPrice = solPriceData?.price || 180;
  const solBalance = hotWallet?.balance || 0;
  const solValueUsd = solBalance * solPrice;
  
  const activeHoldings = holdings?.filter(h => 
    h.currentAmount > 0 && !h.isDead && !h.isDust && h.lastPrice
  ) || [];
  
  const holdingsValueUsd = activeHoldings.reduce((total, h) => {
    const tokenValue = (h.currentAmount * (h.lastPrice || 0));
    return total + tokenValue;
  }, 0);
  
  const totalValueUsd = solValueUsd + holdingsValueUsd;
  const autonomyEnabledCount = holdings?.filter(h => h.autonomyEnabled).length || 0;

  const formatUsd = (value: number) => {
    if (value < 0.01) return "$0.00";
    if (value < 1) return `$${value.toFixed(2)}`;
    if (value < 1000) return `$${value.toFixed(2)}`;
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Dashboard</h1>
          <p className="text-muted-foreground">Portfolio overview and recent activity</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-500/20">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2 text-green-700 dark:text-green-300">
              <DollarSign className="h-4 w-4" />
              Total Value
            </CardDescription>
          </CardHeader>
          <CardContent>
            {walletLoading || holdingsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div>
                <p className="text-2xl font-bold text-green-700 dark:text-green-300" data-testid="text-total-value">
                  {formatUsd(totalValueUsd)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {solBalance.toFixed(3)} SOL + {activeHoldings.length} tokens
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              SOL Balance
            </CardDescription>
          </CardHeader>
          <CardContent>
            {walletLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : hotWallet?.exists ? (
              <div>
                <p className="text-2xl font-bold" data-testid="text-sol-balance">
                  {solBalance.toFixed(3)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatUsd(solValueUsd)}
                </p>
              </div>
            ) : (
              <Badge variant="secondary" data-testid="badge-no-wallet">No Wallet</Badge>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Coins className="h-4 w-4" />
              Token Holdings
            </CardDescription>
          </CardHeader>
          <CardContent>
            {holdingsLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div>
                <p className="text-2xl font-bold" data-testid="text-holdings-value">
                  {formatUsd(holdingsValueUsd)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {activeHoldings.length} active position{activeHoldings.length !== 1 ? "s" : ""}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Auto-Trading
            </CardDescription>
          </CardHeader>
          <CardContent>
            {holdingsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold" data-testid="text-autonomy-count">
                  {autonomyEnabledCount}
                </p>
                {autonomyEnabledCount > 0 && (
                  <Badge variant="default" className="text-xs">Active</Badge>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              positions with autonomy
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Status
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <Badge 
                variant={status?.isActive ? "default" : "secondary"}
                data-testid="badge-monitoring-status"
              >
                {status?.isActive ? "Active" : "Inactive"}
              </Badge>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Total Swaps
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="text-total-swaps">
                {status?.totalSwapsDetected || 0}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Signal Wallets
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="text-wallet-count">
                {status?.monitoredWalletsCount || 0}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Bell className="h-4 w-4" />
              Alerts
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <p className="text-2xl font-bold" data-testid="text-alert-count">
                {unreadCount?.count || 0}
              </p>
              {unreadCount && unreadCount.count > 0 && (
                <Badge variant="destructive">New</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Link href="/trading">
              <Button variant="outline" size="sm" data-testid="link-quick-trading">
                <TrendingUp className="h-4 w-4 mr-2" />
                Hot Wallet & Positions
                <ArrowRight className="h-3 w-3 ml-2" />
              </Button>
            </Link>
            <Link href="/watchlist">
              <Button variant="outline" size="sm" data-testid="link-quick-watchlist">
                <Eye className="h-4 w-4 mr-2" />
                Signal Wallets
                <ArrowRight className="h-3 w-3 ml-2" />
              </Button>
            </Link>
            <Link href="/settings">
              <Button variant="outline" size="sm" data-testid="link-quick-settings">
                <Settings className="h-4 w-4 mr-2" />
                Settings
                <ArrowRight className="h-3 w-3 ml-2" />
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest swap transactions from signal wallets</CardDescription>
          </CardHeader>
          <CardContent>
            {swapsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : swaps && swaps.length > 0 ? (
              <div className="space-y-3">
                {swaps.slice(0, 5).map((swap) => (
                  <div
                    key={swap.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                    data-testid={`swap-item-${swap.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-full bg-primary/10">
                        <TrendingUp className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{swap.fromTokenSymbol}</Badge>
                          <span className="text-muted-foreground">→</span>
                          <Badge variant="outline">{swap.toTokenSymbol}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(swap.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Activity className="h-10 w-10 mx-auto mb-2 opacity-50" />
                <p>No recent activity</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Alerts />
      </div>
    </div>
  );
}
