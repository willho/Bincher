import { useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, TrendingUp, DollarSign, Users, Activity, Shell, Flame, Droplets, BarChart3, Wallet, Clock, Target, Shield, Zap, CircleDot, CirclePause, CircleOff, ExternalLink, Loader2, RefreshCw, FlaskConical } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState, useRef, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useSolPrice } from "@/hooks/use-sol-price";
import { RuleBuilder, RuleValues, RuleSummary } from "@/components/rule-builder";
import { RuleConfirmDialog } from "@/components/rule-confirm-dialog";
import { useWalletNavigation, touchToken } from "@/hooks/use-wallet-navigation";
import type { TokenSnapshot, Holding } from "@shared/schema";

interface SignalSource {
  walletAddress: string | null;
  walletLabel: string | null;
  firstSignal: number;
  totalBuys: number;
  totalSolSpent: number;
}

interface TokenTrade {
  id: number;
  signature: string;
  timestamp: number;
  type: "buy" | "sell";
  amount: number;
  tokenSymbol: string;
  solAmount: number;
  source: string;
  isSignal: boolean;
  signalLabel: string | null;
}

interface TopHolder {
  rank: number;
  address: string;
  percent: number;
  amount: number;
  isTracked?: boolean;
  signalId?: number | null;
}

interface TopHoldersData {
  holders: TopHolder[];
  totalCount: number;
  isEstimate?: boolean;
  lastFetchedAt: number | null;
  top10Concentration: number;
}

export default function TokenPage() {
  const [, params] = useRoute("/trading/:token");
  const tokenMint = params?.token;
  const { toast } = useToast();
  const { solToUsd, formatUsd } = useSolPrice();
  const [, navigate] = useLocation();
  const { navigateToWallet, isNavigating } = useWalletNavigation();

  const lastRefreshRef = useRef<number>(0);
  const REFRESH_COOLDOWN_MS = 60000;
  const [tradeTab, setTradeTab] = useState<"yours" | "signal">("yours");

  // Touch token on mount to record user view for discovery signals
  useEffect(() => {
    if (tokenMint) {
      touchToken(tokenMint);
    }
  }, [tokenMint]);

  const handleWalletClick = (holder: TopHolder) => {
    if (holder.isTracked && holder.signalId) {
      navigate(`/signal/${holder.signalId}`);
    } else {
      // Create temporary wallet and navigate in-app
      navigateToWallet(holder.address);
    }
  };

  const { data: snapshot, isLoading } = useQuery<TokenSnapshot>({
    queryKey: [`/api/snapshots/token/${tokenMint}`],
    enabled: !!tokenMint,
  });

  const { data: signalSources, isLoading: isLoadingSources } = useQuery<SignalSource[]>({
    queryKey: [`/api/token/${tokenMint}/signal-sources`],
    enabled: !!tokenMint,
  });

  const { data: positions, isLoading: isLoadingPositions } = useQuery<Holding[]>({
    queryKey: [`/api/positions/${tokenMint}`],
    enabled: !!tokenMint,
  });

  const { data: tradeHistory, isLoading: isLoadingTrades } = useQuery<TokenTrade[]>({
    queryKey: [`/api/token/${tokenMint}/trades`],
    enabled: !!tokenMint,
  });

  const { data: topHolders, isLoading: isLoadingHolders } = useQuery<TopHoldersData>({
    queryKey: [`/api/token/${tokenMint}/top-holders`],
    enabled: !!tokenMint,
  });

  const [editingPosition, setEditingPosition] = useState<number | null>(null);
  const [editingRuleValues, setEditingRuleValues] = useState<RuleValues>({
    takeProfitThresholds: [4, 10, 25, 100],
    takeProfitPercentages: [25, 25, 25, 25],
    stopLossPercent: 50,
    stopLossMode: "auto",
  });
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingPositionId, setPendingPositionId] = useState<number | null>(null);
  const previousRuleValues = useRef<RuleValues | null>(null);

  const updateRiskMutation = useMutation({
    mutationFn: async ({ positionId, data }: { positionId: number; data: any }) => {
      return apiRequest("PATCH", `/api/positions/${positionId}/risk`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/positions/${tokenMint}`] });
      toast({ title: "Risk settings updated" });
      setEditingPosition(null);
    },
    onError: () => {
      toast({ title: "Failed to update settings", variant: "destructive" });
    }
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ holdingId, data }: { holdingId: number; data: { positionStatus?: string; autonomyEnabled?: boolean } }) => {
      return apiRequest("PATCH", `/api/holdings/${holdingId}/status`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/positions/${tokenMint}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/copy-trade/holdings"] });
      toast({ title: "Position updated" });
    },
    onError: () => {
      toast({ title: "Failed to update position", variant: "destructive" });
    }
  });

  const updateRuleSourceMutation = useMutation({
    mutationFn: async ({ positionId, ruleSource }: { positionId: number; ruleSource: string }) => {
      return apiRequest("PATCH", `/api/positions/${positionId}/rule-source`, { ruleSource });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/positions/${tokenMint}`] });
    },
    onError: () => {
      toast({ title: "Failed to update rule source", variant: "destructive" });
    }
  });

  const startEditing = (position: Holding) => {
    setEditingPosition(position.id);
    const thresholds = (position.takeProfitThresholds as number[]) || [4, 10, 25, 100];
    const loadedValues: RuleValues = {
      takeProfitThresholds: thresholds,
      takeProfitPercentages: (position.takeProfitPercentages as number[]) || [25, 25, 25, 25],
      takeProfitEnabled: (position.takeProfitEnabled as boolean[]) || thresholds.map(() => true),
      stopLossPercent: position.stopLossPercent ?? 50,
      stopLossMode: (position.stopLossMode as "auto" | "alert") || "auto",
    };
    setEditingRuleValues(loadedValues);
    previousRuleValues.current = loadedValues;
  };

  const handleSaveClick = (positionId: number) => {
    setPendingPositionId(positionId);
    setShowConfirmDialog(true);
  };

  const confirmSaveRules = () => {
    if (pendingPositionId === null) return;
    updateRiskMutation.mutate({
      positionId: pendingPositionId,
      data: {
        takeProfitThresholds: editingRuleValues.takeProfitThresholds,
        takeProfitPercentages: editingRuleValues.takeProfitPercentages,
        takeProfitEnabled: editingRuleValues.takeProfitEnabled,
        stopLossPercent: editingRuleValues.stopLossPercent,
        stopLossMode: editingRuleValues.stopLossMode,
      }
    });
    setShowConfirmDialog(false);
    setPendingPositionId(null);
  };

  const analyzeTokenMutation = useMutation({
    mutationFn: async () => {
      if (!tokenMint) throw new Error("No token to analyze");
      return apiRequest("POST", `/api/ai/score-token/${tokenMint}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/snapshots/token/${tokenMint}`] });
      toast({ description: "Analysis complete!" });
    },
    onError: (error: any) => {
      const msg = error?.message?.includes("404") 
        ? "No token data available yet. Try pressing Refresh first." 
        : "Analysis failed. Try again in a moment.";
      toast({ description: msg, variant: "destructive" });
    }
  });

  function parseAiAnalysis(raw: string): { reasoning: string; summary: string; redFlags: string[]; greenFlags: string[] } | null {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.reasoning === "string") {
        return {
          reasoning: parsed.reasoning,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags : [],
          greenFlags: Array.isArray(parsed.greenFlags) ? parsed.greenFlags : [],
        };
      }
    } catch {}
    return null;
  }

  function formatTimeAgo(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
  }

  if (!tokenMint) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No token specified</p>
        <Link href="/trading">
          <Button variant="ghost">Back to Trading</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link href="/trading">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-token-symbol">
              {isLoading ? <Skeleton className="h-8 w-24" /> : snapshot?.tokenSymbol || "Unknown"}
            </h1>
            <p className="text-muted-foreground text-sm font-mono">
              {tokenMint.slice(0, 8)}...{tokenMint.slice(-6)}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const now = Date.now();
            const elapsed = now - lastRefreshRef.current;
            if (elapsed < REFRESH_COOLDOWN_MS) {
              const secsLeft = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
              toast({ description: `Data is up to date. Try again in ${secsLeft}s.` });
              return;
            }
            lastRefreshRef.current = now;
            toast({ description: "Fetching latest token data..." });
            try {
              await apiRequest("POST", `/api/token/${tokenMint}/refresh`);
            } catch (e) {
              // Non-critical: data may still be in cache
            }
            queryClient.invalidateQueries({ queryKey: [`/api/snapshots/token/${tokenMint}`] });
            queryClient.invalidateQueries({ queryKey: [`/api/token/${tokenMint}/trades`] });
            queryClient.invalidateQueries({ queryKey: [`/api/token/${tokenMint}/signal-sources`] });
            queryClient.invalidateQueries({ queryKey: [`/api/token/${tokenMint}/top-holders`] });
            toast({ description: "Token data refreshed!" });
          }}
          data-testid="button-refresh-token"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Price
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-2xl font-bold" data-testid="text-price">
                ${snapshot?.priceUsd?.toFixed(6) || "N/A"}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Market Cap
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-2xl font-bold" data-testid="text-mcap">
                ${snapshot?.marketCap?.toLocaleString() || "N/A"}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Holders
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="text-holders">
                {topHolders?.totalCount
                  ? (topHolders.isEstimate ? `${topHolders.totalCount.toLocaleString()}+` : topHolders.totalCount.toLocaleString())
                  : snapshot?.holders?.toLocaleString() || "N/A"}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              AI Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : snapshot?.aiScore ? (
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold" data-testid="text-ai-score">
                  {snapshot.aiScore}
                </p>
                <Badge variant={snapshot.aiScore >= 70 ? "default" : snapshot.aiScore >= 40 ? "secondary" : "destructive"}>
                  /100
                </Badge>
              </div>
            ) : (
              <p className="text-muted-foreground">Not scored</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Trading Options
            </CardTitle>
            <CardDescription>Execute real or paper trades on this token</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-3 flex-wrap">
              <Button data-testid="button-swap">
                <Zap className="h-4 w-4 mr-2" />
                Swap
              </Button>
              <Button variant="outline" data-testid="button-send">
                <Wallet className="h-4 w-4 mr-2" />
                Send
              </Button>
            </div>
            <div className="pt-3 border-t">
              <p className="text-xs text-muted-foreground mb-2">Paper Trading (risk-free simulation)</p>
              <div className="flex gap-2 flex-wrap">
                <Link href={`/holdings?paperToken=${tokenMint}`}>
                  <Button variant="secondary" size="sm" data-testid="button-paper-buy">
                    <FlaskConical className="h-4 w-4 mr-2" />
                    Paper Buy
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shell className="h-5 w-5 text-primary" />
              Miss Pincher's Take
            </CardTitle>
            <CardDescription>AI-powered token analysis</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : snapshot?.aiAnalysis ? (() => {
              const analysis = parseAiAnalysis(snapshot.aiAnalysis);
              return (
                <div className="space-y-4">
                  {analysis?.reasoning ? (
                    <p className="text-sm" data-testid="text-ai-reasoning">{analysis.reasoning}</p>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{snapshot.aiAnalysis}</p>
                  )}
                  {analysis?.greenFlags && analysis.greenFlags.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-green-500">Positive Signals</p>
                      <div className="flex flex-wrap gap-1">
                        {analysis.greenFlags.map((flag: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs" data-testid={`badge-green-flag-${i}`}>
                            {flag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {analysis?.redFlags && analysis.redFlags.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-red-500">Risk Factors</p>
                      <div className="flex flex-wrap gap-1">
                        {analysis.redFlags.map((flag: string, i: number) => (
                          <Badge key={i} variant="destructive" className="text-xs" data-testid={`badge-red-flag-${i}`}>
                            {flag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {snapshot.aiScore != null && (
                    <div className="flex items-center gap-4 pt-2 border-t flex-wrap">
                      <div className="flex items-center gap-2">
                        <Flame className="h-4 w-4 text-orange-500" />
                        <span className="text-sm text-muted-foreground">Heat Score:</span>
                        <Badge variant={snapshot.aiScore >= 70 ? "default" : snapshot.aiScore >= 40 ? "secondary" : "destructive"}>
                          {snapshot.aiScore}/100
                        </Badge>
                      </div>
                      {snapshot.aiScoredAt ? (
                        <span className="text-xs text-muted-foreground">
                          Scored {formatTimeAgo(snapshot.aiScoredAt)}
                        </span>
                      ) : null}
                    </div>
                  )}
                  {analysis?.summary && (
                    <div className="pt-3 mt-3 border-t" data-testid="section-ai-summary">
                      <p className="text-xs font-medium text-muted-foreground mb-1">Data Summary</p>
                      <p className="text-sm" data-testid="text-ai-summary">{analysis.summary}</p>
                    </div>
                  )}
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => analyzeTokenMutation.mutate()}
                    disabled={analyzeTokenMutation.isPending}
                    data-testid="button-reanalyze-token"
                  >
                    {analyzeTokenMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Shell className="h-4 w-4 mr-2" />}
                    {analyzeTokenMutation.isPending ? "Analyzing..." : "Re-analyze"}
                  </Button>
                </div>
              );
            })() : (
              <div className="text-center py-4 text-muted-foreground space-y-3">
                <Shell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No analysis available yet.</p>
                <Button 
                  variant="default" 
                  size="sm"
                  onClick={() => analyzeTokenMutation.mutate()}
                  disabled={analyzeTokenMutation.isPending}
                  data-testid="button-analyze-token"
                >
                  {analyzeTokenMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Shell className="h-4 w-4 mr-2" />}
                  {analyzeTokenMutation.isPending ? "Analyzing..." : "Run Analysis"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Signal Sources
          </CardTitle>
          <CardDescription>Wallets that signaled this token</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingSources ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : signalSources && signalSources.length > 0 ? (
            <div className="space-y-3">
              {signalSources.map((source, index) => (
                <div key={index} className="flex items-center justify-between p-3 rounded-lg bg-muted/50" data-testid={`signal-source-${index}`}>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Wallet className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">
                        {source.walletLabel || (source.walletAddress ? `${source.walletAddress.slice(0, 6)}...${source.walletAddress.slice(-4)}` : "Unknown")}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>First signal: {formatTimeAgo(source.firstSignal)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">{source.totalSolSpent.toFixed(3)} SOL <span className="text-muted-foreground">({formatUsd(solToUsd(source.totalSolSpent))})</span></p>
                    <p className="text-xs text-muted-foreground">{source.totalBuys} buy{source.totalBuys !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Wallet className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No signal sources found</p>
              <p className="text-xs mt-1">This token wasn't copy-traded from a signal wallet</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-top-holders">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Top Holders
          </CardTitle>
          <CardDescription className="flex items-center justify-between">
            <span>Largest token holders from on-chain data</span>
            {topHolders?.top10Concentration !== undefined && topHolders.top10Concentration > 0 && (
              <Badge variant={topHolders.top10Concentration > 50 ? "destructive" : topHolders.top10Concentration > 30 ? "secondary" : "outline"}>
                Top 10: {topHolders.top10Concentration.toFixed(1)}%
              </Badge>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingHolders ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : topHolders && topHolders.holders.length > 0 ? (
            <div className="space-y-2">
              {topHolders.holders.map((holder) => (
                <div 
                  key={holder.address}
                  onClick={() => handleWalletClick(holder)}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover-elevate cursor-pointer"
                  data-testid={`holder-${holder.rank}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                      holder.rank <= 3 ? "bg-yellow-500/10" : holder.rank <= 10 ? "bg-primary/10" : "bg-muted"
                    }`}>
                      <span className={`text-sm font-bold ${
                        holder.rank <= 3 ? "text-yellow-500" : holder.rank <= 10 ? "text-primary" : "text-muted-foreground"
                      }`}>
                        #{holder.rank}
                      </span>
                    </div>
                    <div>
                      <p className="font-mono text-sm flex items-center gap-1">
                        {holder.address.slice(0, 6)}...{holder.address.slice(-4)}
                        {holder.isTracked ? (
                          <Wallet className="h-3 w-3 text-primary" />
                        ) : (
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {holder.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens
                        {holder.isTracked && <span className="text-primary ml-1">(tracked)</span>}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge variant={holder.percent > 10 ? "destructive" : holder.percent > 5 ? "secondary" : "outline"}>
                      {holder.percent.toFixed(2)}%
                    </Badge>
                  </div>
                </div>
              ))}
              {topHolders.lastFetchedAt && (
                <p className="text-xs text-muted-foreground text-center pt-2">
                  Last updated: {formatTimeAgo(Math.floor(topHolders.lastFetchedAt / 1000))}
                </p>
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No holder data available</p>
              <p className="text-xs mt-1">Holder data may take time to cache</p>
            </div>
          )}
        </CardContent>
      </Card>

      {snapshot && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Token Metrics
            </CardTitle>
            <CardDescription>Additional market data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Droplets className="h-3 w-3" />
                  Liquidity
                </p>
                <p className="font-medium" data-testid="text-liquidity">
                  ${snapshot.liquidity?.toLocaleString() || "N/A"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">24h Volume</p>
                <p className="font-medium" data-testid="text-volume">
                  ${snapshot.volume24h?.toLocaleString() || "N/A"}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">FDV</p>
                <p className="font-medium" data-testid="text-fdv">
                  ${snapshot.fdv?.toLocaleString() || "N/A"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* External Links & Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="card-external-links">
          <CardHeader>
            <CardTitle className="text-base">External Resources</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <a 
                href={`https://solscan.io/token/${tokenMint}`} 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" data-testid="link-solscan">
                  <Shell className="h-4 w-4 mr-2" />
                  Solscan
                </Button>
              </a>
              <a 
                href={`https://dexscreener.com/solana/${tokenMint}`} 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" data-testid="link-dexscreener">
                  <BarChart3 className="h-4 w-4 mr-2" />
                  DexScreener
                </Button>
              </a>
              <a 
                href={`https://birdeye.so/token/${tokenMint}?chain=solana`} 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm" data-testid="link-birdeye">
                  <Activity className="h-4 w-4 mr-2" />
                  Birdeye
                </Button>
              </a>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-price-chart">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Price Chart
              <Badge variant="outline" className="text-xs ml-auto">
                {snapshot?.pairAddress ? "DEXTools" : "DexScreener"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-hidden rounded-b-lg">
            <iframe
              src={snapshot?.pairAddress
                ? `https://www.dextools.io/widget-chart/en/solana/pe-light/${snapshot.pairAddress}?theme=dark&chartType=1&chartResolution=15&drawingToolbars=false`
                : `https://dexscreener.com/solana/${tokenMint}?embed=1&theme=dark&trades=0&info=0`
              }
              className="w-full h-[300px] border-0"
              title="Price Chart"
              data-testid="iframe-price-chart"
            />
          </CardContent>
        </Card>
      </div>

      {/* Trade History - Split into Your Trades and Signal Activity */}
      <Card data-testid="card-trade-history">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Trade History
          </CardTitle>
          <div className="flex items-center gap-2 mt-2">
            <Button
              variant={tradeTab === "yours" ? "default" : "outline"}
              size="sm"
              onClick={() => setTradeTab("yours")}
              data-testid="button-tab-your-trades"
              className="toggle-elevate"
            >
              Your Trades
              {tradeHistory && <Badge variant="secondary" className="ml-1">{tradeHistory.filter(t => !t.isSignal).length}</Badge>}
            </Button>
            <Button
              variant={tradeTab === "signal" ? "default" : "outline"}
              size="sm"
              onClick={() => setTradeTab("signal")}
              data-testid="button-tab-signal-trades"
              className="toggle-elevate"
            >
              Signal Activity
              {tradeHistory && <Badge variant="secondary" className="ml-1">{tradeHistory.filter(t => t.isSignal).length}</Badge>}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingTrades ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (() => {
            const filteredTrades = tradeHistory?.filter(t => tradeTab === "yours" ? !t.isSignal : t.isSignal) || [];
            return filteredTrades.length > 0 ? (
              <div className="space-y-2">
                {filteredTrades.map((trade) => (
                  <div 
                    key={trade.id} 
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                    data-testid={`trade-${trade.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-8 w-8 rounded-full flex items-center justify-center ${trade.type === "buy" ? "bg-green-500/10" : "bg-red-500/10"}`}>
                        <TrendingUp className={`h-4 w-4 ${trade.type === "buy" ? "text-green-500" : "text-red-500 rotate-180"}`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium text-sm ${trade.type === "buy" ? "text-green-500" : "text-red-500"}`}>
                            {trade.type === "buy" ? "Bought" : "Sold"}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {trade.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} {trade.tokenSymbol}
                          </span>
                          {trade.isSignal && trade.signalLabel && (
                            <Badge variant="outline" className="text-xs">
                              <Wallet className="h-3 w-3 mr-1" />
                              {trade.signalLabel}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatTimeAgo(trade.timestamp)}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium">{trade.solAmount.toFixed(4)} SOL</p>
                      <p className="text-xs text-muted-foreground">{formatUsd(solToUsd(trade.solAmount))}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">{tradeTab === "yours" ? "No trades from you yet" : "No signal wallet trades found"}</p>
                <p className="text-xs mt-1">{tradeTab === "yours" ? "Your trades will appear here" : "Signal wallet activity for this token will show here"}</p>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Position Risk Settings */}
      {positions && positions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Position Settings
            </CardTitle>
            <CardDescription>Configure status, autonomy, and risk parameters for your positions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {positions.map((position) => {
                const positionStatus = position.positionStatus || (position.currentAmount > 0 ? "active" : "inactive");
                const statusIcon = {
                  active: <CircleDot className="h-3 w-3 text-green-500" />,
                  pending: <CirclePause className="h-3 w-3 text-yellow-500" />,
                  inactive: <CircleOff className="h-3 w-3 text-muted-foreground" />,
                }[positionStatus];
                
                return (
                <div key={position.id} className="p-4 rounded-lg border bg-muted/30">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{position.tokenSymbol}</p>
                        <Badge 
                          variant={positionStatus === "active" ? "default" : positionStatus === "pending" ? "secondary" : "outline"}
                          className="text-xs"
                        >
                          {statusIcon}
                          <span className="ml-1 capitalize">{positionStatus}</span>
                        </Badge>
                        {position.autonomyEnabled && (
                          <Badge variant="outline" className="text-xs text-primary border-primary/30">
                            <Zap className="h-3 w-3 mr-1" />
                            Auto
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {position.positionSource === "copy" ? `From: ${position.sourceWalletLabel || position.sourceWalletAddress?.slice(0, 8) || "Unknown"}` : position.positionSource}
                      </p>
                    </div>
                    <Badge variant="outline">{position.solSpent?.toFixed(4)} SOL invested ({formatUsd(solToUsd(position.solSpent || 0))})</Badge>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-4 mb-3 p-2 rounded bg-muted/50">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">Status:</Label>
                      <Select 
                        value={positionStatus} 
                        onValueChange={(value) => updateStatusMutation.mutate({ 
                          holdingId: position.id, 
                          data: { positionStatus: value } 
                        })}
                      >
                        <SelectTrigger className="w-[110px] h-7 text-xs" data-testid={`select-status-${position.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">Rules:</Label>
                      <Select 
                        value={(position as Holding & { ruleSource?: string }).ruleSource || "inherited"}
                        onValueChange={(value) => {
                          updateRuleSourceMutation.mutate({ positionId: position.id, ruleSource: value });
                          toast({ 
                            title: value === "inherited" ? "Using wallet defaults" : "Using custom rules",
                            description: value === "inherited" 
                              ? "Take-profit and stop-loss settings inherited from wallet" 
                              : "Edit rules below to customize this position"
                          });
                        }}
                      >
                        <SelectTrigger className="w-[120px] h-7 text-xs" data-testid={`select-rules-${position.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherited">From Wallet</SelectItem>
                          <SelectItem value="override">Override</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`autonomy-${position.id}`} className="text-xs text-muted-foreground">
                        Autonomy:
                      </Label>
                      <Switch
                        id={`autonomy-${position.id}`}
                        checked={position.autonomyEnabled ?? false}
                        onCheckedChange={(checked) => updateStatusMutation.mutate({
                          holdingId: position.id,
                          data: { autonomyEnabled: checked }
                        })}
                        data-testid={`switch-autonomy-${position.id}`}
                      />
                    </div>
                  </div>

                  {editingPosition === position.id ? (
                    <div className="space-y-3">
                      <RuleBuilder
                        values={editingRuleValues}
                        onChange={setEditingRuleValues}
                        showSaveButton={false}
                        compact={true}
                        testIdPrefix={`position-${position.id}`}
                      />
                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          onClick={() => handleSaveClick(position.id)}
                          disabled={updateRiskMutation.isPending}
                          data-testid={`button-save-risk-${position.id}`}
                        >
                          Save
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => setEditingPosition(null)}
                          data-testid={`button-cancel-risk-${position.id}`}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <RuleSummary 
                        values={{
                          takeProfitThresholds: (position.takeProfitThresholds as number[]) || [4, 10, 25, 100],
                          takeProfitPercentages: (position.takeProfitPercentages as number[]) || [25, 25, 25, 25],
                          takeProfitEnabled: (position.takeProfitEnabled as boolean[]),
                          stopLossPercent: position.stopLossPercent ?? 50,
                          stopLossMode: (position.stopLossMode as "auto" | "alert") || "auto",
                        }}
                        testIdPrefix={`position-${position.id}`}
                      />
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => startEditing(position)}
                        data-testid={`button-edit-risk-${position.id}`}
                      >
                        Edit
                      </Button>
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <RuleConfirmDialog
        open={showConfirmDialog}
        onOpenChange={(open) => {
          setShowConfirmDialog(open);
          if (!open) {
            setPendingPositionId(null);
          }
        }}
        ruleValues={editingRuleValues}
        previousValues={previousRuleValues.current}
        onConfirm={confirmSaveRules}
        isPending={updateRiskMutation.isPending}
        tokenSymbol={snapshot?.tokenSymbol || tokenMint?.slice(0, 6)}
      />
    </div>
  );
}
