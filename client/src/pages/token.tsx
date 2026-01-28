import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, TrendingUp, DollarSign, Users, Activity } from "lucide-react";
import { Link } from "wouter";
import type { TokenSnapshot } from "@shared/schema";

export default function TokenPage() {
  const [, params] = useRoute("/trading/:token");
  const tokenMint = params?.token;

  const { data: snapshot, isLoading } = useQuery<TokenSnapshot>({
    queryKey: ["/api/snapshots/token", tokenMint],
    enabled: !!tokenMint,
  });

  if (!tokenMint) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No token specified</p>
        <Link href="/trading">
          <Button variant="link">Back to Trading</Button>
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

      <Card>
        <CardHeader>
          <CardTitle>Token Details</CardTitle>
          <CardDescription>Analysis and trading options</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Button data-testid="button-swap">Swap</Button>
            <Button variant="outline" data-testid="button-send">Send</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
