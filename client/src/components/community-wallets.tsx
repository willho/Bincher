import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Users, Plus, Brain, TrendingUp, Target, DollarSign, Activity } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CommunityWallet {
  walletAddress: string;
  label: string;
  aiScore: number | null;
  aiScoreDetails: string | null;
  monitoredByCount: number;
  isMonitoredByUser: boolean;
}

interface AIScoreDetails {
  score: number;
  hitRate: number;
  avgMultiplier: number;
  totalTrades: number;
  realizedPnL: number;
  analysis: string;
}

export function CommunityWallets() {
  const { toast } = useToast();

  const { data: communityWallets, isLoading } = useQuery<CommunityWallet[]>({
    queryKey: ["/api/community-wallets"],
  });

  const addWallet = useMutation({
    mutationFn: (data: { walletAddress: string; label: string }) =>
      apiRequest("POST", "/api/community-wallets/add", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/community-wallets"] });
      toast({ description: "Wallet added to your monitoring list" });
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to add wallet", variant: "destructive" });
    },
  });

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-500 border-green-500/50";
    if (score >= 40) return "text-yellow-500 border-yellow-500/50";
    return "text-red-500 border-red-500/50";
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 70) return "bg-green-500/10";
    if (score >= 40) return "bg-yellow-500/10";
    return "bg-red-500/10";
  };

  const parseScoreDetails = (details: string | null): AIScoreDetails | null => {
    if (!details) return null;
    try {
      return JSON.parse(details);
    } catch {
      return null;
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Community Wallets
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
          <Users className="h-5 w-5" />
          Community Wallets
        </CardTitle>
        <CardDescription>
          Browse wallets shared by other traders. AI scores are based on historical trading performance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {communityWallets && communityWallets.length > 0 ? (
          <div className="space-y-3">
            {communityWallets.map((wallet) => {
              const details = parseScoreDetails(wallet.aiScoreDetails);
              return (
                <div
                  key={wallet.walletAddress}
                  data-testid={`community-wallet-${wallet.walletAddress}`}
                  className={`p-4 rounded-lg border ${wallet.aiScore ? getScoreBgColor(wallet.aiScore) : "bg-muted/50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{wallet.label}</span>
                        {wallet.aiScore !== null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className={`gap-1 ${getScoreColor(wallet.aiScore)}`}>
                                <Brain className="h-3 w-3" />
                                {wallet.aiScore}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="space-y-1">
                                <p className="font-medium">AI Trading Score</p>
                                {details && (
                                  <div className="text-xs space-y-0.5">
                                    <p>Hit Rate: {(details.hitRate * 100).toFixed(0)}%</p>
                                    <p>Avg Multiplier: {details.avgMultiplier.toFixed(2)}x</p>
                                    <p>Total Trades: {details.totalTrades}</p>
                                    <p>Realized PnL: ${details.realizedPnL.toFixed(2)}</p>
                                  </div>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Users className="h-3 w-3" />
                          {wallet.monitoredByCount}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground font-mono block mt-1">
                        {wallet.walletAddress.slice(0, 8)}...{wallet.walletAddress.slice(-6)}
                      </span>
                      {details && (
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Target className="h-3 w-3" />
                            {(details.hitRate * 100).toFixed(0)}% wins
                          </span>
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {details.avgMultiplier.toFixed(1)}x avg
                          </span>
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {details.totalTrades} trades
                          </span>
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => addWallet.mutate({ 
                        walletAddress: wallet.walletAddress, 
                        label: wallet.label 
                      })}
                      disabled={addWallet.isPending}
                      data-testid={`button-add-community-wallet-${wallet.walletAddress}`}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p>No community wallets available</p>
            <p className="text-sm">Share your wallets to help others discover good traders</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
