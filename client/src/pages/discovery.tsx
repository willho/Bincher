import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Brain,
  ChevronRight,
  Compass,
  Eye,
  Flame,
  Lightbulb,
  Loader2,
  Radio,
  Rocket,
  Search,
  Target,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";

interface RankedToken {
  tokenMint: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  priceUsd: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume24h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
  boostRank: number | null;
  trendingRank: number | null;
  trendingSource: string | null;
  isPumpfun: boolean | null;
  pumpfunGraduated: boolean | null;
  discoveryScore: number;
  heatScore: number | null;
  eventCount: number;
  insightCount: number;
}

interface RankedWallet {
  walletAddress: string;
  walletLabel: string | null;
  strategyType: string | null;
  winRate: number | null;
  totalTrades: number | null;
  avgHoldTimeMinutes: number | null;
  profitFactor: number | null;
  avgBuySize: number | null;
  preferredTokenTypes: string | null;
  walletScore: number;
}

interface PageStats {
  activeTokens: number;
  trackedWallets: number;
  eventsToday: number;
  eventsLastHour: number;
  activeTriggers: number;
  activeInsights: number;
  trendingTokens: number;
  boostedTokens: number;
  busStats: {
    totalEmitted: number;
    combosTriggered: number;
    droppedCooldown: number;
    recentCount: number;
    combosRegistered: number;
  };
}

interface Insight {
  id: number;
  sourceSystem: string;
  insightType: string;
  title: string;
  summary: string | null;
  tokenMint: string | null;
  walletAddress: string | null;
  confidence: number | null;
  status: string;
  createdAt: number;
}

function formatPrice(price: number | null): string {
  if (!price) return "-";
  if (price < 0.00001) return `$${price.toExponential(2)}`;
  if (price < 0.01) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  if (price < 1000) return `$${price.toFixed(2)}`;
  return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatVolume(vol: number | null): string {
  if (!vol) return "-";
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

function formatMint(mint: string): string {
  return mint.slice(0, 4) + "..." + mint.slice(-4);
}

function StatsCards({ stats, isLoading }: { stats?: PageStats; isLoading: boolean }) {
  const statItems = [
    { label: "Active Tokens", value: stats?.activeTokens ?? 0, icon: Target, color: "text-blue-500" },
    { label: "Tracked Wallets", value: stats?.trackedWallets ?? 0, icon: Wallet, color: "text-purple-500" },
    { label: "Events Today", value: stats?.eventsToday ?? 0, icon: Zap, color: "text-yellow-500" },
    { label: "Active Insights", value: stats?.activeInsights ?? 0, icon: Lightbulb, color: "text-green-500" },
    { label: "Trending", value: stats?.trendingTokens ?? 0, icon: TrendingUp, color: "text-orange-500" },
    { label: "Boosted", value: stats?.boostedTokens ?? 0, icon: Rocket, color: "text-pink-500" },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
      {statItems.map((item) => (
        <Card key={item.label}>
          <CardContent className="p-4">
            {isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <item.icon className={`h-4 w-4 ${item.color}`} />
                  <span className="text-xs text-muted-foreground">{item.label}</span>
                </div>
                <span className="text-xl font-bold" data-testid={`text-stat-${item.label.toLowerCase().replace(/\s/g, '-')}`}>
                  {item.value.toLocaleString()}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TokenRow({ token, rank }: { token: RankedToken; rank: number }) {
  const priceChange = token.priceChange24h ?? 0;
  const isPositive = priceChange > 0;

  return (
    <Link href={`/trading/${token.tokenMint}`}>
      <div
        className="flex items-center gap-3 p-3 rounded-md hover-elevate cursor-pointer"
        data-testid={`row-token-${token.tokenMint}`}
      >
        <span className="text-xs text-muted-foreground w-6 text-right font-mono">
          {rank}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">
              {token.tokenSymbol || formatMint(token.tokenMint)}
            </span>
            {token.trendingRank && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                <Flame className="h-3 w-3 mr-0.5 text-orange-500" />
                #{token.trendingRank}
              </Badge>
            )}
            {token.boostRank && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                <Rocket className="h-3 w-3 mr-0.5 text-pink-500" />
                #{token.boostRank}
              </Badge>
            )}
            {token.isPumpfun && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                PF
              </Badge>
            )}
          </div>
          {token.tokenName && (
            <span className="text-xs text-muted-foreground truncate block">
              {token.tokenName}
            </span>
          )}
        </div>

        <div className="text-right flex flex-col items-end gap-0.5">
          <span className="text-sm font-mono">{formatPrice(token.priceUsd)}</span>
          <span className={`text-xs font-mono flex items-center gap-0.5 ${isPositive ? "text-green-500" : "text-red-500"}`}>
            {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {Math.abs(priceChange).toFixed(1)}%
          </span>
        </div>

        <div className="text-right hidden md:block w-20">
          <span className="text-sm font-mono text-muted-foreground">{formatVolume(token.volume24h)}</span>
        </div>

        <div className="text-right w-14">
          <Badge
            variant={(token.heatScore ?? 0) >= 60 ? "default" : "secondary"}
            className="text-xs font-mono"
          >
            <Flame className="h-3 w-3 mr-0.5" />
            {token.heatScore ?? 0}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 w-16 justify-end">
          {token.eventCount > 0 && (
            <span className="text-xs text-muted-foreground flex items-center gap-0.5">
              <Zap className="h-3 w-3 text-yellow-500" />{token.eventCount}
            </span>
          )}
          {token.insightCount > 0 && (
            <span className="text-xs text-muted-foreground flex items-center gap-0.5">
              <Brain className="h-3 w-3 text-purple-500" />{token.insightCount}
            </span>
          )}
        </div>

        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Link>
  );
}

function WalletRow({ wallet, rank }: { wallet: RankedWallet; rank: number }) {
  const winRate = wallet.winRate ? (wallet.winRate * 100).toFixed(0) : "0";

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-md hover-elevate cursor-pointer"
      data-testid={`row-wallet-${wallet.walletAddress}`}
      onClick={() => {
        if (wallet.walletAddress) {
          navigator.clipboard.writeText(wallet.walletAddress);
        }
      }}
    >
        <span className="text-xs text-muted-foreground w-6 text-right font-mono">
          {rank}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">
              {wallet.walletLabel || formatMint(wallet.walletAddress)}
            </span>
            {wallet.strategyType && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                {wallet.strategyType}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
            <span>{wallet.totalTrades ?? 0} trades</span>
            {wallet.avgHoldTimeMinutes && (
              <span>
                hold: {wallet.avgHoldTimeMinutes < 60
                  ? `${Math.round(wallet.avgHoldTimeMinutes)}m`
                  : `${(wallet.avgHoldTimeMinutes / 60).toFixed(1)}h`}
              </span>
            )}
            {wallet.profitFactor && wallet.profitFactor > 0 && (
              <span>PF: {wallet.profitFactor.toFixed(1)}x</span>
            )}
          </div>
        </div>

        <div className="text-right w-16">
          <span className={`text-sm font-bold ${Number(winRate) >= 50 ? "text-green-500" : "text-red-500"}`}>
            {winRate}%
          </span>
          <span className="text-xs text-muted-foreground block">win rate</span>
        </div>

        <div className="text-right w-14">
          <Badge
            variant={wallet.walletScore > 50 ? "default" : "secondary"}
            className="text-xs font-mono"
          >
            {wallet.walletScore}
          </Badge>
        </div>

        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const age = Math.floor((Date.now() / 1000 - insight.createdAt) / 60);
  const ageLabel = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`;

  const iconMap: Record<string, typeof Lightbulb> = {
    recommendation: Lightbulb,
    alert: Zap,
    pattern: Search,
    metric: BarChart3,
    observation: Eye,
  };
  const Icon = iconMap[insight.insightType] || Lightbulb;

  return (
    <div className="flex gap-3 p-3 rounded-md" data-testid={`card-insight-${insight.id}`}>
      <div className="mt-0.5">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{insight.title}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
            {insight.sourceSystem}
          </Badge>
          {insight.confidence && (
            <span className="text-xs text-muted-foreground">{Math.round(insight.confidence * 100)}%</span>
          )}
        </div>
        {insight.summary && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{insight.summary}</p>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className="text-[10px] text-muted-foreground">{ageLabel}</span>
          {insight.tokenMint && (
            <Link href={`/trading/${insight.tokenMint}`}>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 cursor-pointer">
                {formatMint(insight.tokenMint)}
              </Badge>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DiscoveryPage() {
  const [tokenSort, setTokenSort] = useState<string>("heat");
  const [activeTab, setActiveTab] = useState<string>("tokens");

  const { data: stats, isLoading: statsLoading } = useQuery<PageStats>({
    queryKey: ["/api/discovery/page-stats"],
    refetchInterval: 30000,
  });

  const { data: tokens, isLoading: tokensLoading } = useQuery<RankedToken[]>({
    queryKey: ["/api/discovery/ranked-tokens", tokenSort],
    queryFn: async () => {
      const res = await fetch(`/api/discovery/ranked-tokens?sort=${tokenSort}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tokens");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<RankedWallet[]>({
    queryKey: ["/api/discovery/ranked-wallets"],
    refetchInterval: 120000,
  });

  const { data: insights, isLoading: insightsLoading } = useQuery<Insight[]>({
    queryKey: ["/api/discovery/recent-insights"],
    refetchInterval: 60000,
  });

  const sortOptions = [
    { value: "heat", label: "Heat Score" },
    { value: "score", label: "Discovery Score" },
    { value: "volume", label: "Volume" },
    { value: "trending", label: "Trending" },
    { value: "boost", label: "Boosted" },
    { value: "price_change", label: "Price Change" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Discovery</h1>
          <p className="text-muted-foreground">Token and wallet intelligence hub</p>
        </div>
        {stats && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-3 w-3 text-green-500 animate-pulse" />
            <span data-testid="text-events-hour">{stats.eventsLastHour} events/hr</span>
            <span className="text-muted-foreground/50">|</span>
            <span data-testid="text-bus-processed">{stats.busStats.totalEmitted.toLocaleString()} processed</span>
          </div>
        )}
      </div>

      <StatsCards stats={stats} isLoading={statsLoading} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
              <TabsList>
                <TabsTrigger value="tokens" data-testid="tab-tokens">
                  <Target className="h-4 w-4 mr-1.5" />
                  Tokens
                </TabsTrigger>
                <TabsTrigger value="wallets" data-testid="tab-wallets">
                  <Wallet className="h-4 w-4 mr-1.5" />
                  Wallets
                </TabsTrigger>
              </TabsList>

              {activeTab === "tokens" && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {sortOptions.map((opt) => (
                    <Button
                      key={opt.value}
                      variant={tokenSort === opt.value ? "default" : "ghost"}
                      size="sm"
                      onClick={() => setTokenSort(opt.value)}
                      data-testid={`button-sort-${opt.value}`}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            <TabsContent value="tokens">
              <Card>
                <CardContent className="p-0">
                  <div className="flex items-center gap-3 px-3 py-2 border-b text-xs text-muted-foreground">
                    <span className="w-6 text-right">#</span>
                    <span className="flex-1">Token</span>
                    <span className="text-right">Price</span>
                    <span className="text-right hidden md:block w-20">Vol 24h</span>
                    <span className="text-right w-14">{tokenSort === "heat" ? "Heat" : "Score"}</span>
                    <span className="w-16 text-right">Signals</span>
                    <span className="w-4"></span>
                  </div>
                  {tokensLoading ? (
                    <div className="p-6 space-y-3">
                      {Array.from({ length: 10 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : tokens && tokens.length > 0 ? (
                    <div className="divide-y">
                      {tokens.map((token, i) => (
                        <TokenRow key={token.tokenMint} token={token} rank={i + 1} />
                      ))}
                    </div>
                  ) : (
                    <div className="p-12 text-center text-muted-foreground">
                      <Compass className="h-8 w-8 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">No active tokens found</p>
                      <p className="text-xs mt-1">Tokens will appear as the discovery engine scans</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="wallets">
              <Card>
                <CardContent className="p-0">
                  <div className="flex items-center gap-3 px-3 py-2 border-b text-xs text-muted-foreground">
                    <span className="w-6 text-right">#</span>
                    <span className="flex-1">Wallet</span>
                    <span className="text-right w-16">Win Rate</span>
                    <span className="text-right w-14">Score</span>
                    <span className="w-4"></span>
                  </div>
                  {walletsLoading ? (
                    <div className="p-6 space-y-3">
                      {Array.from({ length: 8 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : wallets && wallets.length > 0 ? (
                    <div className="divide-y">
                      {wallets.map((wallet, i) => (
                        <WalletRow key={wallet.walletAddress} wallet={wallet} rank={i + 1} />
                      ))}
                    </div>
                  ) : (
                    <div className="p-12 text-center text-muted-foreground">
                      <Wallet className="h-8 w-8 mx-auto mb-3 opacity-50" />
                      <p className="text-sm">No tracked wallets yet</p>
                      <p className="text-xs mt-1">Add signal wallets to start tracking strategy analysis</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-yellow-500" />
                Recent Insights
              </CardTitle>
              <CardDescription className="text-xs">
                AI-generated observations and signals
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {insightsLoading ? (
                <div className="p-4 space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : insights && insights.length > 0 ? (
                <div className="divide-y max-h-[500px] overflow-auto">
                  {insights.map((insight) => (
                    <InsightCard key={insight.id} insight={insight} />
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  <Brain className="h-6 w-6 mx-auto mb-2 opacity-50" />
                  <p className="text-xs">No insights yet</p>
                </div>
              )}
            </CardContent>
          </Card>

          {stats && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="h-4 w-4 text-blue-500" />
                  Engine Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Events Today</span>
                    <span className="font-mono" data-testid="text-events-today">{stats.eventsToday}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Active Triggers</span>
                    <span className="font-mono" data-testid="text-active-triggers">{stats.activeTriggers}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Combos Fired</span>
                    <span className="font-mono" data-testid="text-combos-fired">{stats.busStats.combosTriggered}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Cooldown Drops</span>
                    <span className="font-mono" data-testid="text-cooldown-drops">{stats.busStats.droppedCooldown}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
