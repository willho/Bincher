import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import { TrendingUp, PieChartIcon, BarChart3 } from "lucide-react";

interface PortfolioSnapshot {
  id: number;
  userId: number;
  tier: string;
  bucketStart: number;
  totalValueUsd: number;
  totalCostBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPercent: number;
  positionCount: number;
  profitableCount: number;
  losingCount: number;
  topPositions: { tokenMint: string; tokenSymbol: string; valueUsd: number; percentOfPortfolio: number }[] | null;
  createdAt: number;
}

interface ChartHolding {
  id: number;
  tokenMint: string;
  tokenSymbol: string | null;
  currentAmount: number;
  lastPrice?: number | null;
  buyPrice: number;
}

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(160, 60%, 45%)",
  "hsl(200, 60%, 50%)",
  "hsl(280, 60%, 55%)",
];

const valueChartConfig: ChartConfig = {
  value: {
    label: "Portfolio Value",
    color: "hsl(var(--chart-1))",
  },
};

const pnlChartConfig: ChartConfig = {
  pnl: {
    label: "P&L %",
    color: "hsl(var(--chart-2))",
  },
};

export function PortfolioValueChart() {
  const { data: snapshots, isLoading } = useQuery<PortfolioSnapshot[]>({
    queryKey: ["/api/portfolio/snapshots", { tier: "hourly", limit: 168 }],
  });

  const chartData = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return [];
    
    return snapshots
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((s) => ({
        time: new Date(s.bucketStart * 1000).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
        }),
        value: s.totalValueUsd,
        timestamp: s.bucketStart,
      }));
  }, [snapshots]);

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
    return `$${val.toFixed(0)}`;
  };

  if (isLoading) {
    return (
      <Card data-testid="card-portfolio-value-chart">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4" />
            Portfolio Value
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!chartData || chartData.length < 2) {
    return (
      <Card data-testid="card-portfolio-value-chart">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4" />
            Portfolio Value
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 flex items-center justify-center text-muted-foreground text-sm" data-testid="text-chart-empty">
            Not enough data yet. Chart will appear after a few hours of tracking.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-portfolio-value-chart">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4" />
          Portfolio Value (7d)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={valueChartConfig} className="h-48 w-full">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="valueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="time"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => value.split(",")[0]}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatUsd}
              fontSize={10}
              width={50}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatUsd(value as number)}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--chart-1))"
              strokeWidth={2}
              fill="url(#valueGradient)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function PortfolioPnlChart() {
  const { data: snapshots, isLoading } = useQuery<PortfolioSnapshot[]>({
    queryKey: ["/api/portfolio/snapshots", { tier: "daily", limit: 30 }],
  });

  const chartData = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return [];
    
    return snapshots
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((s) => ({
        date: new Date(s.bucketStart * 1000).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        pnl: s.unrealizedPnlUsd,
        pnlPercent: s.unrealizedPnlPercent,
        timestamp: s.bucketStart,
      }));
  }, [snapshots]);

  const formatUsd = (val: number) => {
    if (Math.abs(val) >= 1000) return `${val >= 0 ? "+" : ""}$${(val / 1000).toFixed(1)}K`;
    return `${val >= 0 ? "+" : ""}$${val.toFixed(0)}`;
  };

  if (isLoading) {
    return (
      <Card data-testid="card-portfolio-pnl-chart">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Daily P&L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!chartData || chartData.length < 2) {
    return (
      <Card data-testid="card-portfolio-pnl-chart">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" />
            Daily P&L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 flex items-center justify-center text-muted-foreground text-sm" data-testid="text-pnl-chart-empty">
            Not enough data yet. Daily P&L will appear after a few days.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-portfolio-pnl-chart">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4" />
          Daily P&L (30d)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={pnlChartConfig} className="h-48 w-full">
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatUsd}
              fontSize={10}
              width={50}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatUsd(value as number)}
                />
              }
            />
            <Bar
              dataKey="pnl"
              radius={[4, 4, 0, 0]}
              fill="hsl(var(--chart-2))"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

interface AllocationChartProps {
  holdings: ChartHolding[];
}

export function AllocationChart({ holdings }: AllocationChartProps) {
  const chartData = useMemo(() => {
    if (!holdings || holdings.length === 0) return [];

    const positionsWithValue = holdings
      .filter((h) => h.currentAmount > 0)
      .map((h) => ({
        name: h.tokenSymbol || h.tokenMint.slice(0, 6),
        value: h.currentAmount * (h.lastPrice ?? h.buyPrice),
        tokenMint: h.tokenMint,
      }))
      .sort((a, b) => b.value - a.value);

    const totalValue = positionsWithValue.reduce((sum, p) => sum + p.value, 0);

    if (positionsWithValue.length <= 6) {
      return positionsWithValue.map((p, i) => ({
        ...p,
        percent: totalValue > 0 ? (p.value / totalValue) * 100 : 0,
        fill: CHART_COLORS[i % CHART_COLORS.length],
      }));
    }

    const top5 = positionsWithValue.slice(0, 5);
    const others = positionsWithValue.slice(5);
    const othersValue = others.reduce((sum, p) => sum + p.value, 0);

    return [
      ...top5.map((p, i) => ({
        ...p,
        percent: totalValue > 0 ? (p.value / totalValue) * 100 : 0,
        fill: CHART_COLORS[i % CHART_COLORS.length],
      })),
      {
        name: `Others (${others.length})`,
        value: othersValue,
        tokenMint: "others",
        percent: totalValue > 0 ? (othersValue / totalValue) * 100 : 0,
        fill: CHART_COLORS[5],
      },
    ];
  }, [holdings]);

  const allocationConfig = useMemo(() => {
    const config: ChartConfig = {};
    chartData.forEach((item, i) => {
      config[item.name] = {
        label: item.name,
        color: CHART_COLORS[i % CHART_COLORS.length],
      };
    });
    return config;
  }, [chartData]);

  const formatUsd = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
    return `$${val.toFixed(0)}`;
  };

  if (!holdings || holdings.length === 0) {
    return (
      <Card data-testid="card-allocation-chart">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <PieChartIcon className="h-4 w-4" />
            Allocation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 flex items-center justify-center text-muted-foreground text-sm" data-testid="text-allocation-empty">
            No positions to display.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-allocation-chart">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <PieChartIcon className="h-4 w-4" />
          Allocation
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <ChartContainer config={allocationConfig} className="h-40 w-40 flex-shrink-0">
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) => (
                    <span>
                      {name}: {formatUsd(value as number)}
                    </span>
                  )}
                />
              }
            />
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={35}
              outerRadius={60}
              paddingAngle={2}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <div className="flex-1 space-y-1 text-sm overflow-hidden">
          {chartData.slice(0, 6).map((item, i) => (
            <div key={item.tokenMint} className="flex items-center gap-2" data-testid={`allocation-item-${i}`}>
              <div
                className="w-3 h-3 rounded-sm flex-shrink-0"
                style={{ backgroundColor: item.fill }}
              />
              <span className="truncate flex-1">{item.name}</span>
              <span className="text-muted-foreground flex-shrink-0">
                {item.percent.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface Trade {
  id: number;
  timestamp: number;
  isBuy: boolean;
  fromAmount: number;
  toAmount: number;
  solPriceAtTrade?: number;
}

interface SignalWalletActivityChartProps {
  trades: Trade[];
  embedded?: boolean;
}

const activityChartConfig: ChartConfig = {
  buys: {
    label: "Buys",
    color: "hsl(var(--chart-1))",
  },
  sells: {
    label: "Sells",
    color: "hsl(var(--chart-2))",
  },
};

export function SignalWalletActivityChart({ trades, embedded = false }: SignalWalletActivityChartProps) {
  const chartData = useMemo(() => {
    if (!trades || trades.length === 0) return [];

    const dailyData = new Map<string, { date: string; buys: number; sells: number; timestamp: number }>();

    trades.forEach((trade) => {
      const date = new Date(trade.timestamp * 1000);
      const dateKey = date.toISOString().split("T")[0];
      
      if (!dailyData.has(dateKey)) {
        dailyData.set(dateKey, {
          date: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          buys: 0,
          sells: 0,
          timestamp: trade.timestamp,
        });
      }

      const data = dailyData.get(dateKey)!;
      if (trade.isBuy) {
        data.buys++;
      } else {
        data.sells++;
      }
    });

    return Array.from(dailyData.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-14); // Last 14 days
  }, [trades]);

  const chartContent = (() => {
    if (!trades || trades.length === 0) {
      return (
        <div className="h-32 flex items-center justify-center text-muted-foreground text-sm" data-testid="text-activity-empty">
          No trade data available.
        </div>
      );
    }

    if (chartData.length < 2) {
      return (
        <div className="h-32 flex items-center justify-center text-muted-foreground text-sm" data-testid="text-activity-insufficient">
          Not enough data for chart. Need trades over multiple days.
        </div>
      );
    }

    return (
      <ChartContainer config={activityChartConfig} className="h-40 w-full">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            fontSize={10}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            fontSize={10}
            width={25}
            allowDecimals={false}
          />
          <ChartTooltip
            content={<ChartTooltipContent />}
          />
          <Bar dataKey="buys" fill="hsl(142, 76%, 36%)" stackId="stack" radius={[0, 0, 0, 0]} />
          <Bar dataKey="sells" fill="hsl(0, 84%, 60%)" stackId="stack" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    );
  })();

  if (embedded) {
    return (
      <div data-testid="chart-activity-embedded" className="mb-4">
        <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Activity (14d)
        </p>
        {chartContent}
      </div>
    );
  }

  return (
    <Card data-testid="card-activity-chart">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4" />
          Trading Activity {chartData.length >= 2 ? "(14d)" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartContent}
      </CardContent>
    </Card>
  );
}
