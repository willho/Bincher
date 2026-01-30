import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Bell, TrendingUp, Wallet } from "lucide-react";
import { Alerts } from "@/components/alerts";
import type { Swap } from "@shared/schema";

interface ExtendedStatus {
  walletAddress: string;
  isActive: boolean;
  lastUpdated: number;
  totalSwapsDetected: number;
  webhookId?: string;
  monitoredWalletsCount?: number;
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Dashboard</h1>
          <p className="text-muted-foreground">Portfolio overview and recent activity</p>
        </div>
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
              Wallets
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest swap transactions from monitored wallets</CardDescription>
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
