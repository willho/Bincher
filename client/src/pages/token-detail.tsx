import { useParams, useRouter } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, TrendingUp, Zap } from "lucide-react";

interface TokenDetail {
  mint: string;
  symbol: string;
  name: string;
  bondingProgress: number;
  currentPrice: number;
  marketCap: number;
  createdAt: string;
  associatedClusters: Array<{
    clusterId: string;
    pattern: string;
    confidence: number;
    successRate: number;
    medianMultiplier: number;
  }>;
  trajectory: {
    momentum: number;
    acceleration: number;
    projectedPrice24h: number;
    projectedPrice7d: number;
    confidence: number;
  };
}

export default function TokenDetailPage() {
  const params = useParams();
  const [, navigate] = useRouter();
  const mint = params.mint || "";

  const { data: token, isLoading } = useQuery({
    queryKey: [`/api/tokens/${mint}/details`],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/tokens/${mint}/details`);
      return response as TokenDetail;
    },
    enabled: !!mint,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!token) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Token not found</p>
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
          onClick={() => navigate("/dashboard?tab=leaderboard")}
          className="gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </div>

      {/* Token Info */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="text-3xl">{token.symbol}</CardTitle>
              <CardDescription className="text-base mt-2">{token.name}</CardDescription>
              <p className="text-xs font-mono text-muted-foreground mt-2">{token.mint}</p>
            </div>
            <Badge variant="outline" className="text-lg px-4 py-2">
              {token.bondingProgress.toFixed(1)}% Bonding
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Current Price</p>
              <p className="text-2xl font-bold">${token.currentPrice.toFixed(8)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Market Cap</p>
              <p className="text-2xl font-bold">${(token.marketCap / 1000).toFixed(1)}K</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Created</p>
              <p className="text-2xl font-bold">{new Date(token.createdAt).toLocaleDateString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Associated Clusters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Associated Clusters
          </CardTitle>
          <CardDescription>Token pattern matches</CardDescription>
        </CardHeader>
        <CardContent>
          {token.associatedClusters.length === 0 ? (
            <p className="text-muted-foreground">No cluster matches</p>
          ) : (
            <div className="space-y-4">
              {token.associatedClusters.map((cluster) => (
                <div key={cluster.clusterId} className="border rounded p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="font-bold text-lg">{cluster.pattern}</p>
                      <p className="text-xs text-muted-foreground">ID: {cluster.clusterId}</p>
                    </div>
                    <Badge variant={cluster.confidence > 0.75 ? "default" : "secondary"}>
                      {(cluster.confidence * 100).toFixed(0)}% Match
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
                      <p className="text-muted-foreground">Historical Confidence</p>
                      <Badge variant="outline">{(cluster.successRate * 100 * 0.9).toFixed(0)}%</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trajectory Projection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Trajectory Projection
          </CardTitle>
          <CardDescription>AI-based price momentum analysis</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div>
              <p className="text-sm text-muted-foreground">Momentum</p>
              <p className={`text-2xl font-bold ${token.trajectory.momentum > 0 ? "text-green-600" : "text-red-600"}`}>
                {token.trajectory.momentum.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Acceleration</p>
              <p className={`text-2xl font-bold ${token.trajectory.acceleration > 0 ? "text-green-600" : "text-red-600"}`}>
                {token.trajectory.acceleration.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">24h Projection</p>
              <p className="text-2xl font-bold">${token.trajectory.projectedPrice24h.toFixed(8)}</p>
              <p className="text-xs text-muted-foreground">
                {((token.trajectory.projectedPrice24h / token.currentPrice - 1) * 100).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">7d Projection</p>
              <p className="text-2xl font-bold">${token.trajectory.projectedPrice7d.toFixed(8)}</p>
              <p className="text-xs text-muted-foreground">
                {((token.trajectory.projectedPrice7d / token.currentPrice - 1) * 100).toFixed(1)}%
              </p>
            </div>
          </div>

          <div className="bg-muted rounded p-4">
            <p className="text-sm text-muted-foreground mb-2">Projection Confidence</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-background rounded-full h-2">
                <div
                  className="bg-green-600 h-2 rounded-full"
                  style={{ width: `${token.trajectory.confidence * 100}%` }}
                />
              </div>
              <span className="text-sm font-semibold">{(token.trajectory.confidence * 100).toFixed(0)}%</span>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <Button className="flex-1">Enter Trade</Button>
            <Button variant="outline">Add to Watchlist</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
