import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { Loader2 } from "lucide-react";
import type { Holding, Swap } from "@shared/schema";

// ── Types ──────────────────────────────────────────────────────────────────

interface MonitoringStatus {
  isActive: boolean;
  webhookId?: string | null;
  lastActivity?: number | null;
}

interface FundStats {
  solAllocated: number;
  currentValue: number;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  profitFactor: number;
  activePosition?: {
    tokenMint: string;
    entryPrice: number;
    currentPrice: number;
    tokenCount: number;
  };
}

interface TradeConfig {
  baseAllocation?: number;
  apeBudget?: number;
  maxPositions?: number;
  [key: string]: unknown;
}

interface PortfolioSnapshot {
  timestamp: number;
  totalValueSol: number;
  totalValueUsd?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtSol(v: number): string {
  if (v === 0) return "0.000";
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtTimeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function tickerBadgeColor(symbol: string): string {
  const colors = [
    "#34d399", "#f59e0b", "#8b5cf6", "#f43f5e",
    "#3b82f6", "#ec4899", "#14b8a6", "#f97316",
  ];
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = symbol.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function truncate(addr: string, n = 4): string {
  return `${addr.slice(0, n)}…${addr.slice(-4)}`;
}

// ── Sparkline ─────────────────────────────────────────────────────────────

function Sparkline({
  data,
  width = 80,
  height = 28,
  color = "var(--mint)",
  strokeWidth = 1.5,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}) {
  if (data.length < 2) return <svg width={width} height={height} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height * 0.85 - height * 0.075;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const path = `M ${pts.join(" L ")}`;

  const fillPts = [
    `0,${height}`,
    ...pts,
    `${width},${height}`,
  ];
  const fillPath = `M ${fillPts.join(" L ")} Z`;

  return (
    <svg
      width={width}
      height={height}
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={`sg-${color.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#sg-${color.replace(/[^a-z0-9]/gi, "")})`} />
      <path d={path} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Auto-Trading Row ───────────────────────────────────────────────────────

function AutoTradingRow({
  status,
  balance,
}: {
  status: MonitoringStatus | undefined;
  balance: number | undefined;
}) {
  const { toast } = useToast();

  const startMon = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitoring/start"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/status"] }),
    onError: (e: Error) => toast({ description: e.message || "Failed to start", variant: "destructive" }),
  });
  const stopMon = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitoring/stop"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/status"] }),
    onError: (e: Error) => toast({ description: e.message || "Failed to stop", variant: "destructive" }),
  });

  const isActive = status?.isActive ?? false;
  const isPending = startMon.isPending || stopMon.isPending;

  return (
    <div
      className="pincher-card mx-4 mt-3 px-4 py-3 flex items-center gap-3"
      data-testid="card-auto-trading"
    >
      {/* Pulse indicator */}
      <div className="flex-shrink-0 relative w-5 h-5 flex items-center justify-center">
        {isActive ? (
          <span className="pulse-dot" />
        ) : (
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--shell-muted)", display: "inline-block" }}
          />
        )}
      </div>

      {/* Labels */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-white">Auto-Trading</span>
          <span
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{
              background: isActive ? "var(--mint-dim)" : "var(--shell-border)",
              color: isActive ? "var(--mint)" : "var(--shell-muted)",
              fontSize: "0.65rem",
            }}
            data-testid="badge-monitoring-status"
          >
            {isActive ? "LIVE" : "OFF"}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {balance !== undefined && (
            <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }} data-testid="text-sol-balance">
              {fmtSol(balance)} SOL
            </span>
          )}
        </div>
      </div>

      {/* Toggle */}
      <button
        className="flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all"
        style={{
          background: isActive ? "var(--rose-dim)" : "var(--mint-dim)",
          color: isActive ? "var(--rose)" : "var(--mint)",
          border: `1px solid ${isActive ? "var(--rose)" : "var(--mint)"}20`,
          opacity: isPending ? 0.6 : 1,
          cursor: isPending ? "not-allowed" : "pointer",
        }}
        onClick={() => (isActive ? stopMon.mutate() : startMon.mutate())}
        disabled={isPending}
        data-testid="button-monitoring-toggle"
      >
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isActive ? (
          "Stop"
        ) : (
          "Start"
        )}
      </button>
    </div>
  );
}

// ── Hero P&L ──────────────────────────────────────────────────────────────

function HeroPnl({
  stats,
  snapshots,
}: {
  stats: FundStats | undefined;
  snapshots: PortfolioSnapshot[];
}) {
  const pnl = stats?.totalPnl ?? 0;
  const pnlPct =
    stats && stats.solAllocated > 0 ? (pnl / stats.solAllocated) * 100 : 0;
  const isPositive = pnl >= 0;

  const sparkData = snapshots.map((s) => s.totalValueSol);

  return (
    <div className="pincher-card mx-4 mt-3 px-5 py-4" data-testid="card-hero-pnl">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className="text-xs mb-1"
            style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
          >
            Session P&amp;L
          </div>
          <div
            className="text-4xl font-bold leading-none"
            style={{
              color: isPositive ? "var(--mint)" : "var(--rose)",
              fontFamily: "var(--font-display)",
            }}
            data-testid="text-hero-pnl"
          >
            {isPositive ? "+" : ""}
            {fmtSol(pnl)}
            <span className="text-base ml-1" style={{ opacity: 0.7 }}>
              SOL
            </span>
          </div>
          <div
            className="text-sm mt-1 font-mono"
            style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }}
            data-testid="text-hero-pnl-pct"
          >
            {fmtPct(pnlPct)}
          </div>
        </div>

        {/* Sparkline */}
        <div className="flex-shrink-0 mt-1">
          <Sparkline
            data={sparkData.length >= 2 ? sparkData : [0, 0.2, 0.1, 0.3, 0.4, 0.35, 0.5]}
            width={100}
            height={36}
            color={isPositive ? "#34d399" : "#f43f5e"}
          />
        </div>
      </div>

      {/* Stats row */}
      <div
        className="flex items-center gap-4 mt-3 pt-3"
        style={{ borderTop: "1px solid var(--shell-border)" }}
      >
        <div className="text-center">
          <div
            className="text-xs"
            style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
          >
            Trades
          </div>
          <div className="text-sm font-bold text-white" data-testid="text-trade-count">
            {stats?.totalTrades ?? 0}
          </div>
        </div>
        <div className="text-center">
          <div
            className="text-xs"
            style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
          >
            Win Rate
          </div>
          <div
            className="text-sm font-bold"
            style={{ color: "var(--mint)" }}
            data-testid="text-win-rate"
          >
            {((stats?.winRate ?? 0) * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div
            className="text-xs"
            style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
          >
            Profit Factor
          </div>
          <div className="text-sm font-bold text-white" data-testid="text-profit-factor">
            {(stats?.profitFactor ?? 0).toFixed(2)}x
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 4-up Portfolio Grid ────────────────────────────────────────────────────

type ClosedPeriod = "1H" | "24H" | "7D";

function PortfolioGrid({
  holdings,
  swaps,
  config,
  balance,
}: {
  holdings: Holding[] | undefined;
  swaps: Swap[] | undefined;
  config: TradeConfig | undefined;
  balance: number | undefined;
}) {
  const [closedPeriod, setClosedPeriod] = useState<ClosedPeriod>("24H");

  const openPositions = useMemo(
    () => (holdings ?? []).filter((h) => !h.reclaimed && h.currentAmount > 0),
    [holdings]
  );

  const deployedSol = useMemo(
    () => openPositions.reduce((sum, h) => sum + h.buyPrice * h.amountBought, 0),
    [openPositions]
  );

  const closedStats = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const cutoffs: Record<ClosedPeriod, number> = {
      "1H": now - 3600,
      "24H": now - 86400,
      "7D": now - 604800,
    };
    const cutoff = cutoffs[closedPeriod];
    const periodSwaps = (swaps ?? []).filter(
      (s) => s.timestamp >= cutoff && s.toToken === "So11111111111111111111111111111111111111112"
    );
    const wins = periodSwaps.filter((s) => {
      const matching = (swaps ?? []).find(
        (b) => b.toToken === s.fromToken && b.timestamp < s.timestamp
      );
      if (!matching) return false;
      return s.toAmount > matching.fromAmount;
    });
    return { total: periodSwaps.length, wins: wins.length, losses: periodSwaps.length - wins.length };
  }, [swaps, closedPeriod]);

  const tiles: { label: React.ReactNode; value: string; sub: string; color: string; testId: string }[] = [
    {
      label: "Open Positions",
      value: openPositions.length.toString(),
      sub: `${fmtSol(deployedSol)} SOL deployed`,
      color: "var(--mint)",
      testId: "tile-open-positions",
    },
    {
      label: (
        <div className="flex items-center gap-1">
          <span>Closed</span>
          <div className="flex" style={{ fontSize: "0.55rem" }}>
            {(["1H", "24H", "7D"] as ClosedPeriod[]).map((p) => (
              <button
                key={p}
                onClick={(e) => { e.stopPropagation(); setClosedPeriod(p); }}
                className="px-1 rounded"
                style={{
                  background: closedPeriod === p ? "var(--violet-dim)" : "transparent",
                  color: closedPeriod === p ? "var(--violet)" : "var(--shell-muted)",
                  fontFamily: "var(--font-mono)",
                }}
                data-testid={`button-closed-period-${p}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ),
      value: closedStats.total.toString(),
      sub: `${closedStats.wins}W / ${closedStats.losses}L`,
      color: "var(--violet)",
      testId: "tile-closed-trades",
    },
    {
      label: "Base Allocation",
      value: config?.baseAllocation !== undefined ? `${config.baseAllocation} SOL` : "--",
      sub: "per trade",
      color: "var(--amber)",
      testId: "tile-base-allocation",
    },
    {
      label: "Ape Budget",
      value: config?.apeBudget !== undefined ? `${config.apeBudget} SOL` : "--",
      sub: "high-conviction",
      color: "var(--rose)",
      testId: "tile-ape-budget",
    },
  ];

  return (
    <div className="mx-4 mt-3 grid grid-cols-2 gap-2" data-testid="grid-portfolio">
      {tiles.map((tile, i) => (
        <div
          key={i}
          className="pincher-card px-3 py-3"
          data-testid={tile.testId}
        >
          <div
            className="text-xs mb-1"
            style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
          >
            {tile.label}
          </div>
          <div
            className="text-xl font-bold leading-tight"
            style={{ color: tile.color, fontFamily: "var(--font-mono)" }}
          >
            {tile.value}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--shell-muted)" }}>
            {tile.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Open Positions List ────────────────────────────────────────────────────

function PositionCard({ holding }: { holding: Holding }) {
  const symbol = holding.tokenSymbol || truncate(holding.tokenMint, 4);
  const badgeChar = symbol.slice(0, 2).toUpperCase();
  const badgeColor = tickerBadgeColor(symbol);

  const currentPrice = holding.lastPrice || holding.buyPrice;
  const currentValue = currentPrice * holding.currentAmount;
  const costBasis = holding.buyPrice * holding.amountBought;
  const pnlSol = currentValue - costBasis;
  const pnlPct = costBasis > 0 ? (pnlSol / costBasis) * 100 : 0;
  const isPositive = pnlSol >= 0;

  const dummySparkline = [costBasis, (costBasis + currentValue) / 2, currentValue];

  return (
    <div
      className="pincher-card px-4 py-3 flex items-start gap-3"
      data-testid={`card-position-${holding.tokenMint.slice(0, 8)}`}
    >
      {/* Badge */}
      <div
        className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
        style={{ background: `${badgeColor}22`, color: badgeColor, fontFamily: "var(--font-mono)" }}
      >
        {badgeChar}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-white truncate">{symbol}</span>
          <span
            className="text-sm font-bold font-mono flex-shrink-0"
            style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }}
          >
            {isPositive ? "+" : ""}
            {fmtSol(pnlSol)} SOL
          </span>
        </div>

        <div
          className="flex items-center justify-between gap-2 mt-0.5"
          style={{ color: "var(--shell-muted)" }}
        >
          <span className="text-xs font-mono">
            {fmtSol(costBasis)} → {fmtSol(currentValue)} SOL
          </span>
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-mono"
              style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }}
            >
              {fmtPct(pnlPct)}
            </span>
            <Sparkline
              data={dummySparkline}
              width={48}
              height={20}
              color={isPositive ? "#34d399" : "#f43f5e"}
              strokeWidth={1.2}
            />
          </div>
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {Boolean((holding as Record<string, unknown>).trailingStopEnabled) && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--amber-dim)", color: "var(--amber)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}
            >
              TSL
            </span>
          )}
          {Boolean((holding as Record<string, unknown>).whaleConfirmed) && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--mint-dim)", color: "var(--mint)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}
            >
              WHALE
            </span>
          )}
          {Boolean((holding as Record<string, unknown>).clusterId) && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--violet-dim)", color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}
            >
              CLUSTER
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenPositionsList({ holdings }: { holdings: Holding[] | undefined }) {
  const open = useMemo(
    () => (holdings ?? []).filter((h) => !h.reclaimed && h.currentAmount > 0),
    [holdings]
  );

  if (open.length === 0) {
    return (
      <div
        className="mx-4 mt-3 pincher-card px-4 py-8 text-center"
        style={{ color: "var(--shell-muted)" }}
        data-testid="text-no-positions"
      >
        <div className="text-2xl mb-2">🔍</div>
        <div className="text-sm">No open positions</div>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-3 space-y-2" data-testid="list-open-positions">
      <div
        className="text-xs font-semibold px-1 mb-1"
        style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
      >
        OPEN POSITIONS ({open.length})
      </div>
      {open.map((h) => (
        <PositionCard key={h.tokenMint} holding={h} />
      ))}
    </div>
  );
}

// ── Transaction Timeline ───────────────────────────────────────────────────

const SOL_MINT = "So11111111111111111111111111111111111111112";

function TimelineRow({ swap }: { swap: Swap }) {
  const isBuy = swap.fromToken === SOL_MINT;
  const isSell = swap.toToken === SOL_MINT;

  let dotColor = "var(--violet)";
  let label = "Swap";
  let detail = "";

  if (isBuy) {
    dotColor = "var(--mint)";
    label = `Buy ${swap.toTokenSymbol || truncate(swap.toToken || "", 4)}`;
    detail = `${fmtSol(swap.fromAmount)} SOL`;
  } else if (isSell) {
    const pnl = swap.toAmount - swap.fromAmount;
    dotColor = pnl >= 0 ? "var(--mint)" : "var(--rose)";
    label = `Sell ${swap.fromTokenSymbol || truncate(swap.fromToken || "", 4)}`;
    detail = `+${fmtSol(swap.toAmount)} SOL`;
  }

  return (
    <div className="flex items-start gap-3" data-testid={`timeline-row-${swap.signature?.slice(0, 8) ?? swap.id}`}>
      {/* Dot + line */}
      <div className="flex flex-col items-center flex-shrink-0 mt-0.5">
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isBuy ? "transparent" : dotColor,
            border: isBuy ? `2px solid ${dotColor}` : "none",
            flexShrink: 0,
          }}
        />
        <div style={{ width: 1, flex: 1, minHeight: 16, background: "var(--shell-border)" }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white">{label}</span>
          <span className="text-xs font-mono flex-shrink-0" style={{ color: "var(--shell-muted)" }}>
            {fmtTimeAgo(swap.timestamp)}
          </span>
        </div>
        {detail && (
          <span
            className="text-xs font-mono"
            style={{ color: isBuy ? "var(--mint)" : dotColor }}
          >
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

function TransactionTimeline({ swaps }: { swaps: Swap[] | undefined }) {
  const recent = useMemo(
    () => [...(swaps ?? [])].sort((a, b) => b.timestamp - a.timestamp).slice(0, 15),
    [swaps]
  );

  return (
    <div className="mx-4 mt-3 mb-2" data-testid="section-timeline">
      <div
        className="text-xs font-semibold px-1 mb-2"
        style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}
      >
        RECENT ACTIVITY
      </div>
      {recent.length === 0 ? (
        <div
          className="pincher-card px-4 py-6 text-center text-xs"
          style={{ color: "var(--shell-muted)" }}
          data-testid="text-no-activity"
        >
          No recent activity
        </div>
      ) : (
        <div className="pincher-card px-4 pt-4 pb-1">
          {recent.map((s) => (
            <TimelineRow key={s.id} swap={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  useDocumentMeta({
    title: "Portfolio | Penny Pincher",
    description: "Your Solana copy-trading portfolio overview.",
  });

  const { data: status } = useQuery<MonitoringStatus>({
    queryKey: ["/api/status"],
    refetchInterval: 10000,
  });

  const { data: balanceData } = useQuery<{ balance: number }>({
    queryKey: ["/api/copy-trade/balance"],
    refetchInterval: 30000,
  });

  const { data: fundStats } = useQuery<FundStats>({
    queryKey: ["/api/system/fund-stats"],
    staleTime: 30000,
  });

  const { data: snapshotsData } = useQuery<{ snapshots: PortfolioSnapshot[] }>({
    queryKey: ["/api/portfolio/snapshots"],
    staleTime: 60000,
  });

  const { data: holdings } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
    refetchInterval: 15000,
  });

  const { data: swaps } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
    staleTime: 15000,
  });

  const { data: config } = useQuery<TradeConfig>({
    queryKey: ["/api/copy-trade/config"],
    staleTime: 60000,
  });

  return (
    <div className="page-scroll" data-testid="page-portfolio">
      <AutoTradingRow
        status={status}
        balance={balanceData?.balance}
      />

      <HeroPnl
        stats={fundStats}
        snapshots={snapshotsData?.snapshots ?? []}
      />

      <PortfolioGrid
        holdings={holdings}
        swaps={swaps}
        config={config}
        balance={balanceData?.balance}
      />

      <OpenPositionsList holdings={holdings} />

      <TransactionTimeline swaps={swaps} />
    </div>
  );
}
