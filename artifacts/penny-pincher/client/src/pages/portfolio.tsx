import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { Loader2 } from "lucide-react";
import type { Holding, Swap } from "@shared/schema";

// ── Extended Holding type ─────────────────────────────────────────────────
// The API returns fields that exist in the DB holdings table but are not
// included in the base holdingSchema zod type (they were added in later
// phases). Declaring them explicitly here avoids any type-escape casts.

interface ExtendedHolding extends Holding {
  trailingStop?: boolean;
  trailingStopPercent?: number;
  clusterId?: number | null;
  whaleConfirmed?: boolean;
  stopLossTriggered?: boolean;
}

// ── Other types ────────────────────────────────────────────────────────────

interface MonitoringStatus {
  isActive: boolean;
  webhookId?: string | null;
  lastUpdated?: number;
  totalSwapsDetected?: number;
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

interface AiEvent {
  id: number;
  eventType: string;
  title?: string;
  description?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  createdAt?: number;
  timestamp?: number;
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
  const fillPts = [`0,${height}`, ...pts, `${width},${height}`];
  const fillPath = `M ${fillPts.join(" L ")} Z`;
  const gradId = `sg${Math.abs(color.split("").reduce((a, c) => a + c.charCodeAt(0), 0))}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradId})`} />
      <path d={path} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Win-rate Donut ─────────────────────────────────────────────────────────

function WinRateDonut({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(1, rate));
  const r = 16;
  const circ = 2 * Math.PI * r;
  const filled = circ * pct;
  const gap = circ - filled;

  return (
    <svg width={42} height={42} viewBox="0 0 42 42">
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--shell-border)" strokeWidth="4" />
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="var(--mint)"
        strokeWidth="4"
        strokeDasharray={`${filled} ${gap}`}
        strokeDashoffset={circ * 0.25}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
      <text x="21" y="21" textAnchor="middle" dominantBaseline="central" fill="var(--mint)" fontSize="9" fontFamily="var(--font-mono)" fontWeight="bold">
        {Math.round(pct * 100)}%
      </text>
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
  const swapCount = status?.totalSwapsDetected ?? 0;

  return (
    <div
      className="pincher-card mx-4 mt-3 px-4 py-3 flex items-center gap-3"
      data-testid="card-auto-trading"
    >
      <div className="flex-shrink-0 relative w-5 h-5 flex items-center justify-center">
        {isActive ? (
          <span className="pulse-dot" />
        ) : (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--shell-muted)", display: "inline-block" }} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-white" style={{ fontFamily: "var(--font-prose)" }}>Auto-Trading</span>
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
        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
          {balance !== undefined && (
            <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }} data-testid="text-sol-balance">
              {fmtSol(balance)} SOL
            </span>
          )}
          <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }} data-testid="text-scan-rate">
            {swapCount.toLocaleString()} swaps detected
          </span>
        </div>
      </div>

      <button
        className="flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all"
        style={{
          fontFamily: "var(--font-prose)",
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
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : isActive ? "Stop" : "Start"}
      </button>
    </div>
  );
}

// ── Hero P&L ──────────────────────────────────────────────────────────────

function HeroPnl({
  stats,
  snapshots,
  bestMultiplier,
}: {
  stats: FundStats | undefined;
  snapshots: PortfolioSnapshot[];
  bestMultiplier: number;
}) {
  const pnl = stats?.totalPnl ?? 0;
  const pnlPct = stats && stats.solAllocated > 0 ? (pnl / stats.solAllocated) * 100 : 0;
  const isPositive = pnl >= 0;
  const sparkData = snapshots.slice(-48).map((s) => s.totalValueSol);
  const tradeCount = stats?.totalTrades ?? 0;
  const winRate = stats?.winRate ?? 0;

  return (
    <div className="pincher-card mx-4 mt-3 px-5 py-4" data-testid="card-hero-pnl">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs mb-1" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}>
            Session P&amp;L
          </div>
          <div
            className="text-4xl font-bold leading-none"
            style={{ color: isPositive ? "var(--mint)" : "var(--rose)", fontFamily: "var(--font-display)" }}
            data-testid="text-hero-pnl"
          >
            {isPositive ? "+" : ""}{fmtSol(pnl)}
            <span className="text-base ml-1" style={{ opacity: 0.7 }}>SOL</span>
          </div>
          <div className="text-sm mt-1 font-mono" style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }} data-testid="text-hero-pnl-pct">
            {fmtPct(pnlPct)}
          </div>

          {/* Trade stats row */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }} data-testid="text-hero-trade-count">
              {tradeCount} trades
            </span>
            <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }}>·</span>
            <span className="text-xs font-mono" style={{ color: winRate >= 0.5 ? "var(--mint)" : "var(--rose)" }} data-testid="text-hero-win-rate">
              {Math.round(winRate * 100)}% win
            </span>
            {bestMultiplier > 1 && (
              <>
                <span className="text-xs font-mono" style={{ color: "var(--shell-muted)" }}>·</span>
                <span
                  className="text-xs font-mono px-1 rounded"
                  style={{ background: "var(--violet-dim)", color: "var(--violet)" }}
                  data-testid="text-hero-best-run"
                >
                  best {bestMultiplier.toFixed(1)}x
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 mt-1">
          <Sparkline
            data={sparkData.length >= 2 ? sparkData : [0, 0.2, 0.1, 0.3, 0.4, 0.35, 0.5]}
            width={100}
            height={36}
            color={isPositive ? "#34d399" : "#f43f5e"}
          />
        </div>
      </div>
    </div>
  );
}

// ── Performance Stats Row ─────────────────────────────────────────────────

function PerformanceStatsRow({ stats }: { stats: FundStats | undefined }) {
  const winRate = stats?.winRate ?? 0;
  const profitFactor = stats?.profitFactor ?? 0;
  const netPnl = stats?.totalPnl ?? 0;
  const isNetPositive = netPnl >= 0;

  return (
    <div className="pincher-card mx-4 mt-3 px-4 py-3 flex items-center justify-around" data-testid="card-perf-stats">
      <div className="flex flex-col items-center gap-1">
        <WinRateDonut rate={winRate} />
        <span className="text-xs" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>WIN RATE</span>
      </div>

      <div style={{ width: 1, height: 40, background: "var(--shell-border)" }} />

      <div className="flex flex-col items-center gap-1">
        <div className="text-xl font-bold font-mono" style={{ color: profitFactor >= 1 ? "var(--mint)" : "var(--rose)" }} data-testid="text-stat-profit-factor">
          {profitFactor.toFixed(2)}x
        </div>
        <span className="text-xs" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>PROFIT FACTOR</span>
      </div>

      <div style={{ width: 1, height: 40, background: "var(--shell-border)" }} />

      <div className="flex flex-col items-center gap-1">
        <div
          className="text-xl font-bold font-mono"
          style={{ color: isNetPositive ? "var(--mint)" : "var(--rose)" }}
          data-testid="text-stat-net-pnl"
        >
          {isNetPositive ? "+" : ""}{fmtSol(netPnl)}
        </div>
        <span className="text-xs" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>NET P&amp;L</span>
      </div>
    </div>
  );
}

// ── 4-up Portfolio Grid ────────────────────────────────────────────────────

type ClosedPeriod = "1H" | "24H" | "7D";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function PortfolioGrid({
  holdings,
  swaps,
  config,
}: {
  holdings: ExtendedHolding[] | undefined;
  swaps: Swap[] | undefined;
  config: TradeConfig | undefined;
}) {
  const [closedPeriod, setClosedPeriod] = React.useState<ClosedPeriod>("24H");

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
    const cutoffs: Record<ClosedPeriod, number> = { "1H": now - 3600, "24H": now - 86400, "7D": now - 604800 };
    const cutoff = cutoffs[closedPeriod];
    const sellSwaps = (swaps ?? []).filter(
      (s) => s.timestamp >= cutoff && s.toToken === SOL_MINT
    );
    const wins = sellSwaps.filter((s) => {
      const buy = (swaps ?? []).find(
        (b) => b.toToken === s.fromToken && b.fromToken === SOL_MINT && b.timestamp < s.timestamp
      );
      return buy ? s.toAmount > buy.fromAmount : false;
    });
    return { total: sellSwaps.length, wins: wins.length, losses: sellSwaps.length - wins.length };
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
          <div className="flex">
            {(["1H", "24H", "7D"] as ClosedPeriod[]).map((p) => (
              <button
                key={p}
                onClick={(e) => { e.stopPropagation(); setClosedPeriod(p); }}
                className="px-1 rounded"
                style={{
                  fontSize: "0.55rem",
                  background: closedPeriod === p ? "var(--violet-dim)" : "transparent",
                  color: closedPeriod === p ? "var(--violet)" : "var(--shell-muted)",
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
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
        <div key={i} className="pincher-card px-3 py-3" data-testid={tile.testId}>
          <div className="text-xs mb-1" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}>
            {tile.label}
          </div>
          <div className="text-xl font-bold leading-tight" style={{ color: tile.color, fontFamily: "var(--font-mono)" }}>
            {tile.value}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-prose)" }}>
            {tile.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Open Positions List ────────────────────────────────────────────────────

function PositionCard({
  holding,
  positionSnapshots,
}: {
  holding: ExtendedHolding;
  positionSnapshots: number[];
}) {
  const symbol = holding.tokenSymbol || truncate(holding.tokenMint, 4);
  const badgeChar = symbol.slice(0, 2).toUpperCase();
  const badgeColor = tickerBadgeColor(symbol);

  const currentPrice = holding.lastPrice || holding.buyPrice;
  const currentValue = currentPrice * holding.currentAmount;
  const costBasis = holding.buyPrice * holding.amountBought;
  const pnlSol = currentValue - costBasis;
  const pnlPct = costBasis > 0 ? (pnlSol / costBasis) * 100 : 0;
  const isPositive = pnlSol >= 0;

  // Per-position sparkline: global snapshots filtered to only those after this
  // position's buy timestamp, giving each card a distinct timeline.
  const sparkData: number[] = positionSnapshots.length >= 2
    ? positionSnapshots
    : [costBasis, (costBasis + currentValue) / 2, currentValue];

  const highestMult = holding.highestMultiplier ?? 1;
  const isDrawdown = currentValue > 0 && costBasis > 0 && pnlPct < -15;
  const isHighMult = highestMult >= 2;
  const hasTrailingStop = Boolean(holding.trailingStop) || Boolean(holding.trailingStopPercent);
  const hasStopLoss = holding.stopLossTriggered === true;
  const hasCluster = holding.clusterId !== undefined && holding.clusterId !== null;
  const hasWhale = Boolean(holding.whaleConfirmed);

  return (
    <div
      className="pincher-card px-4 py-3 flex items-start gap-3"
      data-testid={`card-position-${holding.tokenMint.slice(0, 8)}`}
    >
      <div
        className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
        style={{ background: `${badgeColor}22`, color: badgeColor, fontFamily: "var(--font-mono)" }}
      >
        {badgeChar}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-white truncate" style={{ fontFamily: "var(--font-prose)" }}>
            {symbol}
          </span>
          <span
            className="text-sm font-bold font-mono flex-shrink-0"
            style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }}
          >
            {isPositive ? "+" : ""}{fmtSol(pnlSol)} SOL
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5" style={{ color: "var(--shell-muted)" }}>
          <span className="text-xs font-mono">
            {fmtSol(costBasis)} → {fmtSol(currentValue)}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono" style={{ color: isPositive ? "var(--mint)" : "var(--rose)" }}>
              {fmtPct(pnlPct)}
            </span>
            <Sparkline
              data={sparkData}
              width={48}
              height={20}
              color={isPositive ? "#34d399" : "#f43f5e"}
              strokeWidth={1.2}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-1 mt-1.5">
          {hasTrailingStop && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--amber-dim)", color: "var(--amber)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              TSL
            </span>
          )}
          {hasWhale && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--mint-dim)", color: "var(--mint)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              WHALE
            </span>
          )}
          {hasCluster && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--violet-dim)", color: "var(--violet)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              CLUSTER
            </span>
          )}
          {isHighMult && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--mint-dim)", color: "var(--mint)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              {highestMult.toFixed(1)}x
            </span>
          )}
          {hasStopLoss && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--amber-dim)", color: "var(--amber)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              SL HIT
            </span>
          )}
          {isDrawdown && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--rose-dim)", color: "var(--rose)", fontFamily: "var(--font-mono)", fontSize: "0.6rem" }}>
              DRAWDOWN
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenPositionsList({
  holdings,
  allSnapshots,
}: {
  holdings: ExtendedHolding[] | undefined;
  allSnapshots: PortfolioSnapshot[];
}) {
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
        <div className="text-sm" style={{ fontFamily: "var(--font-prose)" }}>No open positions</div>
      </div>
    );
  }

  return (
    <div className="mx-4 mt-3 space-y-2" data-testid="list-open-positions">
      <div className="text-xs font-semibold px-1 mb-1" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}>
        OPEN POSITIONS ({open.length})
      </div>
      {open.map((h) => {
        // Per-position sparkline: filter global snapshots to those at or after
        // this position's buy timestamp, giving each card a unique timeline.
        const positionSnapshots = allSnapshots
          .filter((s) => s.timestamp >= h.buyTimestamp)
          .slice(-12)
          .map((s) => s.totalValueSol);

        return <PositionCard key={h.tokenMint} holding={h} positionSnapshots={positionSnapshots} />;
      })}
    </div>
  );
}

// ── Transaction Timeline ───────────────────────────────────────────────────

interface TimelineEvent {
  id: string;
  ts: number;
  type: "buy" | "sell-profit" | "sell-loss" | "system" | "toggle";
  label: string;
  detail?: string;
}

function buildTimeline(
  swaps: Swap[] | undefined,
  aiEvents: AiEvent[] | undefined,
  monStatus: MonitoringStatus | undefined
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Swap events (buys and sells)
  (swaps ?? []).forEach((s) => {
    const isBuy = s.fromToken === SOL_MINT;
    const isSell = s.toToken === SOL_MINT;
    if (isBuy) {
      events.push({
        id: `swap-${s.id}`,
        ts: s.timestamp,
        type: "buy",
        label: `Buy ${s.toTokenSymbol || truncate(s.toToken || "", 4)}`,
        detail: `${fmtSol(s.fromAmount)} SOL`,
      });
    } else if (isSell) {
      const fromBuy = (swaps ?? []).find(
        (b) => b.toToken === s.fromToken && b.fromToken === SOL_MINT && b.timestamp < s.timestamp
      );
      const isProfit = fromBuy ? s.toAmount > fromBuy.fromAmount : true;
      events.push({
        id: `swap-${s.id}`,
        ts: s.timestamp,
        type: isProfit ? "sell-profit" : "sell-loss",
        label: `Sell ${s.fromTokenSymbol || truncate(s.fromToken || "", 4)}`,
        detail: `${fmtSol(s.toAmount)} SOL`,
      });
    }
  });

  // System events from /api/ai/events
  (aiEvents ?? []).forEach((e) => {
    const ts = e.createdAt ?? e.timestamp ?? 0;
    if (ts === 0) return;
    const isToggle =
      e.eventType === "monitoring_started" ||
      e.eventType === "monitoring_stopped" ||
      e.eventType === "auto_trading_toggle";

    events.push({
      id: `ai-${e.id}`,
      ts,
      type: isToggle ? "toggle" : "system",
      label: e.title || e.eventType.replace(/_/g, " "),
      detail: e.description,
    });
  });

  // Synthetic toggle event from monitoring status lastUpdated
  if (monStatus?.lastUpdated && monStatus.lastUpdated > 0) {
    events.push({
      id: "toggle-latest",
      ts: monStatus.lastUpdated,
      type: "toggle",
      label: `Auto-trading ${monStatus.isActive ? "started" : "stopped"}`,
      detail: undefined,
    });
  }

  return events.sort((a, b) => b.ts - a.ts).slice(0, 15);
}

const DOT_STYLES: Record<TimelineEvent["type"], { bg: string; border?: string }> = {
  buy: { bg: "transparent", border: "var(--mint)" },
  "sell-profit": { bg: "var(--mint)" },
  "sell-loss": { bg: "var(--rose)" },
  system: { bg: "var(--violet)" },
  toggle: { bg: "var(--amber)" },
};

const LABEL_COLORS: Record<TimelineEvent["type"], string> = {
  buy: "var(--mint)",
  "sell-profit": "var(--mint)",
  "sell-loss": "var(--rose)",
  system: "var(--violet)",
  toggle: "var(--amber)",
};

function TimelineRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const dot = DOT_STYLES[event.type];

  return (
    <div className="flex items-start gap-3" data-testid={`timeline-row-${event.id}`}>
      <div className="flex flex-col items-center flex-shrink-0 mt-0.5">
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dot.bg,
            border: dot.border ? `2px solid ${dot.border}` : "none",
            flexShrink: 0,
          }}
        />
        {!isLast && (
          <div style={{ width: 1, flex: 1, minHeight: 16, background: "var(--shell-border)" }} />
        )}
      </div>
      <div className="flex-1 min-w-0 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white" style={{ fontFamily: "var(--font-prose)" }}>
            {event.label}
          </span>
          <span className="text-xs font-mono flex-shrink-0" style={{ color: "var(--shell-muted)" }}>
            {fmtTimeAgo(event.ts)}
          </span>
        </div>
        {event.detail && (
          <span className="text-xs font-mono" style={{ color: LABEL_COLORS[event.type] }}>
            {event.detail}
          </span>
        )}
      </div>
    </div>
  );
}

function TransactionTimeline({
  swaps,
  aiEvents,
  monStatus,
}: {
  swaps: Swap[] | undefined;
  aiEvents: AiEvent[] | undefined;
  monStatus: MonitoringStatus | undefined;
}) {
  const events = useMemo(() => buildTimeline(swaps, aiEvents, monStatus), [swaps, aiEvents, monStatus]);

  return (
    <div className="mx-4 mt-3 mb-2" data-testid="section-timeline">
      <div className="text-xs font-semibold px-1 mb-2" style={{ color: "var(--shell-muted)", fontFamily: "var(--font-mono)" }}>
        RECENT ACTIVITY
      </div>
      {events.length === 0 ? (
        <div
          className="pincher-card px-4 py-6 text-center text-xs"
          style={{ color: "var(--shell-muted)", fontFamily: "var(--font-prose)" }}
          data-testid="text-no-activity"
        >
          No recent activity
        </div>
      ) : (
        <div className="pincher-card px-4 pt-4 pb-1">
          {events.map((e, i) => (
            <TimelineRow key={e.id} event={e} isLast={i === events.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

import React from "react";

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

  const { data: holdings } = useQuery<ExtendedHolding[]>({
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

  const { data: aiEvents } = useQuery<AiEvent[]>({
    queryKey: ["/api/ai/events"],
    staleTime: 30000,
  });

  const snapshots = snapshotsData?.snapshots ?? [];

  // Best multiplier across all open positions for hero card "best run" label
  const bestMultiplier = useMemo(() => {
    return (holdings ?? []).reduce((best, h) => Math.max(best, h.highestMultiplier ?? 1), 1);
  }, [holdings]);

  return (
    <div className="page-scroll" data-testid="page-portfolio">
      <AutoTradingRow status={status} balance={balanceData?.balance} />
      <HeroPnl stats={fundStats} snapshots={snapshots} bestMultiplier={bestMultiplier} />
      <PortfolioGrid holdings={holdings} swaps={swaps} config={config} />
      <PerformanceStatsRow stats={fundStats} />
      <OpenPositionsList holdings={holdings} allSnapshots={snapshots} />
      <TransactionTimeline swaps={swaps} aiEvents={aiEvents} monStatus={status} />
    </div>
  );
}
