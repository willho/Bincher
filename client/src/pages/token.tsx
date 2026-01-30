import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, TrendingUp, DollarSign, Users, Activity, Shell, Flame, Droplets, BarChart3, Wallet, Clock } from "lucide-react";
import { Link } from "wouter";
import type { TokenSnapshot } from "@shared/schema";

interface SignalSource {
  walletAddress: string | null;
  walletLabel: string | null;
  firstSignal: number;
  totalBuys: number;
  totalSolSpent: number;
}

export default function TokenPage() {
  const [, params] = useRoute("/trading/:token");
  const tokenMint = params?.token;

  const { data: snapshot, isLoading } = useQuery<TokenSnapshot>({
    queryKey: [`/api/snapshots/token/${tokenMint}`],
    enabled: !!tokenMint,
  });

  const { data: signalSources, isLoading: isLoadingSources } = useQuery<SignalSource[]>({
    queryKey: [`/api/token/${tokenMint}/signal-sources`],
    enabled: !!tokenMint,
  });

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
                {snapshot?.holders?.toLocaleString() || "N/A"}
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
            <CardTitle>Trading Options</CardTitle>
            <CardDescription>Execute trades on this token</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <Button data-testid="button-swap">Swap</Button>
              <Button variant="outline" data-testid="button-send">Send</Button>
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
            ) : snapshot?.aiAnalysis ? (
              <div className="space-y-4">
                <p className="text-sm whitespace-pre-wrap">{snapshot.aiAnalysis}</p>
                {snapshot.aiScore && (
                  <div className="flex items-center gap-4 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <Flame className="h-4 w-4 text-orange-500" />
                      <span className="text-sm text-muted-foreground">Heat Score:</span>
                      <Badge variant={snapshot.aiScore >= 70 ? "default" : snapshot.aiScore >= 40 ? "secondary" : "destructive"}>
                        {snapshot.aiScore}/100
                      </Badge>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4 text-muted-foreground">
                <Shell className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No analysis available yet.</p>
                <p className="text-xs mt-1">Ask me about this token in the chat!</p>
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
                    <p className="text-sm font-medium">{source.totalSolSpent.toFixed(3)} SOL</p>
                    <p className="text-xs text-muted-foreground">{source.totalBuys} buy{source.totalBuys !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Wallet className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No signal sources found</p>
              <p className="text-xs mt-1">This token wasn't copy-traded from a monitored wallet</p>
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
    </div>
  );
}
