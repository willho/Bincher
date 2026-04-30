import { useParams, useRouter } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, Wallet, TrendingUp } from "lucide-react";

interface HolderWallet {
  walletAddress: string;
  rank: number;
  winRate: number;
  loss: number;
  riskAdjustedPnl: number;
  sharpeRatio: number;
  pnl7d: number;
  totalTrades: number;
}

interface WalletDetail {
  walletAddress: string;
  winRate: number;
  sharpeRatio: number;
  pnl7d: number;
  confidence: number;
  totalTrades: number;
  lastActive: string;
  topHolders: HolderWallet[];
}

export default function WalletDetailPage() {
  const params = useParams();
  const [, navigate] = useRouter();
  const address = params.address || "";

  const { data: wallet, isLoading } = useQuery({
    queryKey: [`/api/wallets/${address}/detail`],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/wallets/${address}/detail`);
      return response as WalletDetail;
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
          <div className="grid grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Win Rate</p>
              <p className="text-2xl font-bold text-green-600">{(wallet.winRate * 100).toFixed(0)}%</p>
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
              <p className="text-sm text-muted-foreground">Trades</p>
              <p className="text-2xl font-bold">{wallet.totalTrades}</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Last active: {new Date(wallet.lastActive).toLocaleDateString()}
          </p>
        </CardContent>
      </Card>

      {/* Top Holders */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Top 10 Ranked Holder Wallets
          </CardTitle>
          <CardDescription>Wallets holding this token ranked by trading quality</CardDescription>
        </CardHeader>
        <CardContent>
          {wallet.topHolders.length === 0 ? (
            <p className="text-muted-foreground">No holder data available</p>
          ) : (
            <div className="space-y-3">
              {wallet.topHolders.map((holder) => (
                <div
                  key={holder.walletAddress}
                  className="border rounded p-4 hover:bg-accent transition-colors"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="text-center min-w-[50px]">
                        <p className="text-xl font-bold text-primary">#{holder.rank}</p>
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-sm font-mono">
                          {holder.walletAddress.slice(0, 12)}...{holder.walletAddress.slice(-6)}
                        </p>
                        <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                          <span>{holder.totalTrades} trades</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-bold ${holder.riskAdjustedPnl > 0 ? "text-green-600" : "text-red-600"}`}>
                        ${holder.riskAdjustedPnl.toFixed(2)}
                      </p>
                      <p className="text-xs text-muted-foreground">Risk-Adjusted PnL</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-muted rounded p-2">
                      <p className="text-muted-foreground text-xs">Win Rate</p>
                      <p className="font-semibold text-green-600">{(holder.winRate * 100).toFixed(0)}%</p>
                    </div>
                    <div className="bg-muted rounded p-2">
                      <p className="text-muted-foreground text-xs">Loss</p>
                      <p className="font-semibold text-red-600">{(holder.loss * 100).toFixed(0)}%</p>
                    </div>
                    <div className="bg-muted rounded p-2">
                      <p className="text-muted-foreground text-xs">Sharpe</p>
                      <p className="font-semibold">{holder.sharpeRatio.toFixed(2)}</p>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-3">
                    <Button size="sm" variant="outline" className="flex-1">
                      View Trades
                    </Button>
                    <Button size="sm" variant="ghost">
                      Profile
                    </Button>
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
