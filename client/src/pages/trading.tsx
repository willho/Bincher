import { useQuery } from "@tanstack/react-query";
import { CopyTrading } from "@/components/copy-trading";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Coins, TrendingUp, TrendingDown, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { Holding } from "@shared/schema";

export default function TradingPage() {
  const { data: holdings, isLoading } = useQuery<Holding[]>({
    queryKey: ["/api/copy-trade/holdings"],
  });

  // Filter holdings with meaningful value (non-reclaimed with tokens remaining)
  const activeHoldings = holdings?.filter(h => !h.reclaimed && h.currentAmount > 0) || [];

  // Calculate current value and PnL for a holding
  const getHoldingMetrics = (holding: Holding) => {
    const currentPrice = holding.lastPrice || holding.buyPrice;
    const currentValue = holding.currentAmount * currentPrice;
    const pnlPercent = holding.solSpent > 0 
      ? ((currentValue - holding.solSpent) / holding.solSpent) * 100 
      : 0;
    return { currentValue, pnlPercent };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Trading</h1>
        <p className="text-muted-foreground">Manage your positions and copy trading</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Your Holdings
          </CardTitle>
          <CardDescription>Active token positions from copy trading</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : activeHoldings.length > 0 ? (
            <div className="space-y-3">
              {activeHoldings.map((holding) => {
                const { currentValue, pnlPercent } = getHoldingMetrics(holding);
                const isProfit = pnlPercent >= 0;
                return (
                  <div
                    key={holding.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border"
                    data-testid={`holding-${holding.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-full ${isProfit ? "bg-green-500/10" : "bg-red-500/10"}`}>
                        {isProfit ? (
                          <TrendingUp className="h-4 w-4 text-green-500" />
                        ) : (
                          <TrendingDown className="h-4 w-4 text-red-500" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{holding.tokenSymbol}</span>
                          <Badge variant={isProfit ? "default" : "destructive"}>
                            {isProfit ? "+" : ""}{pnlPercent.toFixed(1)}%
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {holding.solSpent.toFixed(4)} SOL invested
                        </p>
                      </div>
                    </div>
                    <Link href={`/trading/${holding.tokenMint}`}>
                      <Button variant="ghost" size="sm" data-testid={`button-view-${holding.id}`}>
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Coins className="h-10 w-10 mx-auto mb-2 opacity-50" />
              <p>No active holdings</p>
              <p className="text-sm mt-1">Enable copy trading to start building positions</p>
            </div>
          )}
        </CardContent>
      </Card>

      <CopyTrading />
    </div>
  );
}
