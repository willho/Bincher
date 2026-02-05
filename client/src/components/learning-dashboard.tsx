import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, FlaskConical, Wallet, Users, AlertTriangle, TrendingUp, CheckCircle, XCircle, Target, Flame, RefreshCw } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface ExperimentStats {
  totalExperimentTrades: number;
  totalBestTheoryTrades: number;
  experimentWinRate: number;
  bestTheoryWinRate: number;
  activeExperiments: number;
  activeTheories: number;
  bestTheory: {
    id: string;
    name: string;
    takeProfitMultiplier: number;
    stopLossPercent: number;
    sampleSize: number;
    winRate: number;
    avgPnlPercent: number;
  } | null;
  gateStatus: {
    approved: boolean;
    reasons: string[];
    completedPaperTrades: number;
    requiredPaperTrades: number;
    currentWinRate: number;
    requiredWinRate: number;
  };
}

interface DiscoveredWallet {
  address: string;
  discoveryMethod: string;
  score: number;
  winRate: number;
  behaviorType: string;
  leadsFollowers: string[];
}

interface DiscoveryStats {
  wallets: DiscoveredWallet[];
  stats: {
    totalDiscovered: number;
    avgScore: number;
    leaderCount: number;
    followerCount: number;
  };
}

interface SocialSource {
  handle: string;
  platform: string;
  callCount: number;
  successRate: number;
  score: number;
}

interface SocialStats {
  sources: SocialSource[];
  stats: {
    totalSources: number;
    activeSources: number;
    totalCalls: number;
    avgSuccessRate: number;
  };
}

interface WhaleReputation {
  walletAddress: string;
  winRate: number;
  totalTrades: number;
  reputationScore: number;
  flags: Array<{
    type: string;
    reason: string;
  }>;
}

interface BackgroundJobStatus {
  jobs: Record<string, {
    lastRun: number | null;
    isRunning: boolean;
    errorCount: number;
  }>;
}

export function LearningDashboard() {
  const { toast } = useToast();

  const { data: experimentData, isLoading: experimentsLoading } = useQuery<ExperimentStats>({
    queryKey: ["/api/paper/experiment-stats"],
  });

  const { data: discoveryData, isLoading: discoveryLoading } = useQuery<DiscoveryStats>({
    queryKey: ["/api/wallet-discovery/discovered"],
  });

  const { data: socialData, isLoading: socialLoading } = useQuery<SocialStats>({
    queryKey: ["/api/social/sources"],
  });

  const { data: whaleFlags, isLoading: whalesLoading } = useQuery<{ whales: WhaleReputation[] }>({
    queryKey: ["/api/whale-reputation/red-flags"],
  });

  const { data: jobStatus } = useQuery<BackgroundJobStatus>({
    queryKey: ["/api/background-jobs/status"],
  });

  const runJobMutation = useMutation({
    mutationFn: async (jobName: string) => {
      const response = await apiRequest("POST", `/api/background-jobs/run/${jobName}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallet-discovery/discovered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/social/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/whale-reputation/red-flags"] });
      toast({ title: "Job completed" });
    },
    onError: () => {
      toast({ title: "Job failed", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6" data-testid="learning-dashboard">
      <div className="grid gap-4 md:grid-cols-4">
        <Card data-testid="card-theory-status">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-lg ${experimentData?.gateStatus?.approved ? "bg-green-500/10" : "bg-yellow-500/10"}`}>
                <Brain className={`h-6 w-6 ${experimentData?.gateStatus?.approved ? "text-green-600" : "text-yellow-600"}`} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Trading Gate</p>
                <p className="text-2xl font-bold">
                  {experimentData?.gateStatus?.approved ? "Approved" : "Pending"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-experiment-count">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-lg bg-primary/10">
                <FlaskConical className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Active Experiments</p>
                <p className="text-2xl font-bold">
                  {experimentsLoading ? <Skeleton className="h-8 w-12" /> : experimentData?.activeExperiments ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-discovered-wallets">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-lg bg-blue-500/10">
                <Wallet className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Discovered Wallets</p>
                <p className="text-2xl font-bold">
                  {discoveryLoading ? <Skeleton className="h-8 w-12" /> : discoveryData?.stats?.totalDiscovered ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-social-sources">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-lg bg-purple-500/10">
                <Users className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Social Sources</p>
                <p className="text-2xl font-bold">
                  {socialLoading ? <Skeleton className="h-8 w-12" /> : socialData?.stats?.totalSources ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card data-testid="card-best-theory">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Best Theory Status
            </CardTitle>
            <CardDescription>Current winning strategy from experiments</CardDescription>
          </CardHeader>
          <CardContent>
            {experimentsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : experimentData?.bestTheory ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Theory</span>
                  <Badge variant="outline">{experimentData.bestTheory.name}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Win Rate</span>
                  <span className="font-medium">
                    {(experimentData.bestTheory.winRate * 100).toFixed(1)}% ({experimentData.bestTheory.sampleSize} trades)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Avg PnL</span>
                  <span className={`font-medium ${experimentData.bestTheory.avgPnlPercent >= 0 ? "text-green-600" : "text-destructive"}`}>
                    {experimentData.bestTheory.avgPnlPercent >= 0 ? "+" : ""}{experimentData.bestTheory.avgPnlPercent.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Settings</span>
                  <span className="text-sm">
                    TP: {experimentData.bestTheory.takeProfitMultiplier}x / SL: {experimentData.bestTheory.stopLossPercent}%
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Gate Status</span>
                  {experimentData.gateStatus?.approved ? (
                    <Badge className="bg-green-600"><CheckCircle className="h-3 w-3 mr-1" /> Ready for Real</Badge>
                  ) : (
                    <Badge variant="secondary"><XCircle className="h-3 w-3 mr-1" /> Validating</Badge>
                  )}
                </div>
              </div>
            ) : experimentData?.activeTheories && experimentData.activeTheories > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Active Theories</span>
                  <Badge variant="outline">{experimentData.activeTheories}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Win Rate</span>
                  <span className="font-medium">{(experimentData.bestTheoryWinRate * 100).toFixed(1)}%</span>
                </div>
                <p className="text-xs text-muted-foreground">Building winning theory from experiments...</p>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">No theories generated yet</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-whale-flags">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Whale Red Flags
            </CardTitle>
            <CardDescription>Underperforming whales flagged for review</CardDescription>
          </CardHeader>
          <CardContent>
            {whalesLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : whaleFlags?.whales && whaleFlags.whales.length > 0 ? (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {whaleFlags.whales.slice(0, 5).map((whale) => (
                  <div key={whale.walletAddress} className="flex items-center justify-between p-2 bg-destructive/5 rounded-lg border border-destructive/20">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{whale.walletAddress.slice(0, 8)}...</span>
                      <Badge variant="destructive" className="text-xs">
                        {(whale.winRate * 100).toFixed(0)}% win
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{whale.totalTrades} trades</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">No flagged whales</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-social-leaderboard">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Social Source Leaderboard
            </CardTitle>
            <CardDescription>Top performing Twitter/Telegram sources</CardDescription>
          </CardHeader>
          <CardContent>
            {socialLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : socialData?.sources && socialData.sources.length > 0 ? (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {socialData.sources.slice(0, 5).map((source, idx) => (
                  <div key={source.handle} className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-muted-foreground">#{idx + 1}</span>
                      <span className="font-medium">@{source.handle}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {(source.successRate * 100).toFixed(0)}% success
                      </Badge>
                      <span className="text-xs text-muted-foreground">{source.callCount} calls</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">No social sources discovered yet</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-discovered-queue">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Flame className="h-5 w-5 text-orange-500" />
                Discovered Wallets Queue
              </CardTitle>
              <CardDescription>High-potential wallets awaiting review</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runJobMutation.mutate("walletDiscovery")}
              disabled={runJobMutation.isPending}
              data-testid="button-run-discovery"
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${runJobMutation.isPending ? "animate-spin" : ""}`} />
              Discover
            </Button>
          </CardHeader>
          <CardContent>
            {discoveryLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : discoveryData?.wallets && discoveryData.wallets.length > 0 ? (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {discoveryData.wallets.slice(0, 5).map((wallet) => (
                  <div key={wallet.address} className="flex items-center justify-between p-2 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{wallet.address.slice(0, 8)}...</span>
                      <Badge variant={wallet.behaviorType === "leader" ? "default" : "secondary"} className="text-xs">
                        {wallet.behaviorType}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{wallet.score.toFixed(0)}</span>
                      {wallet.leadsFollowers.length > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {wallet.leadsFollowers.length} followers
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">No wallets discovered yet</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
