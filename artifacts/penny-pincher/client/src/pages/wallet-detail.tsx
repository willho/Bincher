import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, Wallet, TrendingUp, Zap } from "lucide-react";

interface AssociatedCluster {
  clusterId: string;
  pattern: string;
  successRate: number;
  medianMultiplier: number;
  alignmentScore: number;
  tradesInCluster: number;
}

interface WalletDetail {
  walletAddress: string;
  winRate: number;
  sharpeRatio: number;
  pnl7d: number;
  totalPnl: number;
  confidence: number;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  lastActive: string;
  associatedClusters: AssociatedCluster[];
}

export default function WalletDetailPage() {
  const params = useParams();
  const [, navigate] = useLocation();
  const address = params.address || "";

  const { data: wallet, isLoading } = useQuery({
    queryKey: [`/api/wallets/${address}/detail`],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/wallets/${address}/detail`);
      return (await response.json()) as WalletDetail;
    },
    enabled: !!address,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Wallet not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/dashboard?tab=wallets")}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>

      {/* Wallet Info */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-6 w-6" />
                Wallet Profile
              </CardTitle>
              <p className="text-sm font-mono text-muted-foreground mt-2">{wallet.walletAddress}</p>
            </div>
            <Badge variant="outline" className="text-base px-3 py-2">
              {(wallet.confidence * 100).toFixed(0)}% Confidence
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-5 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Win Rate</p>
              <p className="text-2xl font-bold text-green-600">{(wallet.winRate * 100).toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground">{wallet.winTrades}W / {wallet.lossTrades}L</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Sharpe Ratio</p>
              <p className="text-2xl font-bold">{wallet.sharpeRatio.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">PnL 7d</p>
              <p className={`text-2xl font-bold ${wallet.pnl7d > 0 ? "text-green-600" : "text-red-600"}`}>
                ${wallet.pnl7d.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total PnL</p>
              <p className={`text-2xl font-bold ${wallet.totalPnl > 0 ? "text-green-600" : "text-red-600"}`}>
                ${wallet.totalPnl.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Trades</p>
              <p className="text-2xl font-bold">{wallet.totalTrades}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Last active: {new Date(wallet.lastActive).toLocaleDateString()}
          </p>
        </CardContent>
      </Card>

      {/* Associated Clusters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Associated Clusters
          </CardTitle>
          <CardDescription>Token patterns this wallet trades</CardDescription>
        </CardHeader>
        <CardContent>
          {wallet.associatedClusters.length === 0 ? (
            <p className="text-muted-foreground">No cluster associations</p>
          ) : (
            <div className="space-y-4">
              {wallet.associatedClusters.map((cluster) => (
                <div key={cluster.clusterId} className="border rounded p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="font-bold text-lg">{cluster.pattern}</p>
                      <p className="text-xs text-muted-foreground">ID: {cluster.clusterId}</p>
                    </div>
                    <Badge variant={cluster.alignmentScore > 0.7 ? "default" : "secondary"}>
                      {(cluster.alignmentScore * 100).toFixed(0)}% Alignment
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Success Rate</p>
                      <p className="font-semibold">{(cluster.successRate * 100).toFixed(0)}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Median Multiplier</p>
                      <p className="font-semibold text-green-600">{cluster.medianMultiplier.toFixed(1)}x</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Trades in Cluster</p>
                      <p className="font-semibold">{cluster.tradesInCluster}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
