import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, AlertTriangle, TrendingUp, TrendingDown, Shield, Sparkles, MessageSquare } from "lucide-react";
import type { RuleValues } from "@/components/rule-builder";

interface RuleConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ruleValues: RuleValues;
  previousValues?: RuleValues | null;
  onConfirm: () => void;
  isPending?: boolean;
  walletName?: string;
  tokenSymbol?: string;
}

interface RiskWarning {
  level: "low" | "medium" | "high";
  message: string;
}

function generateRiskWarnings(values: RuleValues, previous?: RuleValues | null): RiskWarning[] {
  const warnings: RiskWarning[] = [];
  const enabledThresholds = values.takeProfitThresholds.filter(
    (_, i) => !values.takeProfitEnabled || values.takeProfitEnabled[i]
  );
  const enabledPercentages = values.takeProfitPercentages.filter(
    (_, i) => !values.takeProfitEnabled || values.takeProfitEnabled[i]
  );

  // Guard against zero enabled tiers
  if (enabledThresholds.length === 0) {
    warnings.push({
      level: "high",
      message: "No take-profit tiers enabled. Positions won't auto-sell on gains.",
    });
  }

  if (values.stopLossPercent === 0) {
    warnings.push({
      level: "high",
      message: "No stop-loss protection. Positions can go to zero without automatic exit.",
    });
  } else if (values.stopLossPercent < 20) {
    warnings.push({
      level: "medium",
      message: `Tight ${values.stopLossPercent}% stop-loss may trigger from normal volatility.`,
    });
  } else if (values.stopLossPercent >= 80) {
    warnings.push({
      level: "medium",
      message: `Wide ${values.stopLossPercent}% stop-loss provides minimal downside protection.`,
    });
  }

  // Only check thresholds if there are enabled tiers
  if (enabledThresholds.length > 0) {
    const minThreshold = Math.min(...enabledThresholds);
    if (minThreshold >= 50) {
      warnings.push({
        level: "medium",
        message: `First take-profit at ${minThreshold}x is ambitious - most trades don't reach this.`,
      });
    }

    const maxThreshold = Math.max(...enabledThresholds);
    if (maxThreshold >= 100) {
      warnings.push({
        level: "low",
        message: `Targeting ${maxThreshold}x moonshot requires patience and luck.`,
      });
    }

    const totalPercent = enabledPercentages.reduce((a, b) => a + b, 0);
    if (totalPercent < 50) {
      warnings.push({
        level: "low",
        message: `Only selling ${totalPercent}% across all tiers leaves significant exposure to price drops.`,
      });
    }

    if (enabledThresholds.length === 1) {
      warnings.push({
        level: "low",
        message: "Single take-profit tier is all-or-nothing. Consider tiered exits.",
      });
    }
  }

  if (values.stopLossMode === "alert" && values.stopLossPercent > 0) {
    warnings.push({
      level: "low",
      message: "Alert-only stop-loss requires manual action - you might miss the window.",
    });
  }

  if (previous) {
    if (previous.stopLossPercent > 0 && values.stopLossPercent === 0) {
      warnings.push({
        level: "high",
        message: "Removing stop-loss protection from your previous configuration.",
      });
    }
    if (values.stopLossPercent < previous.stopLossPercent && values.stopLossPercent > 0) {
      warnings.push({
        level: "medium",
        message: `Tightening stop-loss from ${previous.stopLossPercent}% to ${values.stopLossPercent}%.`,
      });
    }
  }

  return warnings.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.level] - order[b.level];
  });
}

function RuleSummaryCard({ values }: { values: RuleValues }) {
  const enabledThresholds = values.takeProfitThresholds.filter(
    (_, i) => !values.takeProfitEnabled || values.takeProfitEnabled[i]
  );
  const enabledPercentages = values.takeProfitPercentages.filter(
    (_, i) => !values.takeProfitEnabled || values.takeProfitEnabled[i]
  );
  const totalPercent = enabledPercentages.reduce((a, b) => a + b, 0);

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-500" />
          Take-Profit Tiers ({enabledThresholds.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {enabledThresholds.length === 0 ? (
          <div className="text-xs text-destructive">No take-profit tiers enabled</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {enabledThresholds.map((threshold, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {threshold}x → sell {enabledPercentages[i]}%
                </Badge>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              Total: {totalPercent}% sold across all tiers
            </div>
          </>
        )}
      </CardContent>
      <CardHeader className="pb-2 pt-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Shield className="h-4 w-4 text-amber-500" />
          Stop-Loss Protection
        </CardTitle>
      </CardHeader>
      <CardContent>
        {values.stopLossPercent === 0 ? (
          <Badge variant="destructive" className="text-xs">Disabled</Badge>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              -{values.stopLossPercent}%
            </Badge>
            <span className="text-xs text-muted-foreground">
              {values.stopLossMode === "auto" ? "Auto-sell" : "Alert only"}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WarningsList({ warnings }: { warnings: RiskWarning[] }) {
  if (warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm">
        <Shield className="h-4 w-4" />
        No significant risk warnings for this configuration.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {warnings.map((warning, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 text-sm p-2 rounded-md ${
            warning.level === "high"
              ? "bg-destructive/10 text-destructive"
              : warning.level === "medium"
              ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {warning.level === "high" ? (
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : warning.level === "medium" ? (
            <TrendingDown className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : (
            <MessageSquare className="h-4 w-4 flex-shrink-0 mt-0.5" />
          )}
          {warning.message}
        </div>
      ))}
    </div>
  );
}

function PincherReview({ ruleValues }: { ruleValues: RuleValues }) {
  const enabledThresholds = ruleValues.takeProfitThresholds.filter(
    (_, i) => !ruleValues.takeProfitEnabled || ruleValues.takeProfitEnabled[i]
  );

  const { data: review, isLoading, error } = useQuery<{ review: string; sentiment: string }>({
    queryKey: ["/api/ai/review-rules", JSON.stringify(ruleValues)],
    queryFn: async () => {
      const res = await fetch("/api/ai/review-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: ruleValues }),
      });
      if (!res.ok) throw new Error("Failed to get AI review");
      return res.json();
    },
    staleTime: 60000,
    retry: false,
    enabled: enabledThresholds.length > 0,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 bg-muted rounded-md">
        <Loader2 className="h-4 w-4 animate-spin" />
        Miss Pincher is reviewing your strategy...
      </div>
    );
  }

  // Client-side fallback if AI review fails or returns empty
  const fallbackReview = error || !review ? {
    review: enabledThresholds.length === 0 
      ? "No take-profit tiers? That's risky - you'll be holding bags forever. Consider enabling at least one exit point."
      : "I couldn't get a full analysis right now, but your strategy looks set. Just keep an eye on those stop-losses.",
    sentiment: enabledThresholds.length === 0 ? "cautious" : "neutral"
  } : review;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="pt-4">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-primary/10 p-2 flex-shrink-0">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div className="space-y-1 flex-1">
            <div className="text-sm font-medium flex items-center gap-2">
              Miss Pincher's Take
              {fallbackReview.sentiment && (
                <Badge
                  variant={
                    fallbackReview.sentiment === "bullish"
                      ? "default"
                      : fallbackReview.sentiment === "cautious"
                      ? "secondary"
                      : "outline"
                  }
                  className="text-xs"
                >
                  {fallbackReview.sentiment}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{fallbackReview.review}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RuleConfirmDialog({
  open,
  onOpenChange,
  ruleValues,
  previousValues,
  onConfirm,
  isPending,
  walletName,
  tokenSymbol,
}: RuleConfirmDialogProps) {
  const warnings = generateRiskWarnings(ruleValues, previousValues);
  const hasHighRisk = warnings.some((w) => w.level === "high");
  const [showAiReview, setShowAiReview] = useState(false);

  useEffect(() => {
    if (open) {
      setShowAiReview(false);
    }
  }, [open]);

  const contextLabel = tokenSymbol
    ? `${tokenSymbol} position`
    : walletName
    ? `${walletName} default rules`
    : "trading rules";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Confirm Rule Changes
          </AlertDialogTitle>
          <AlertDialogDescription>
            You're about to update {contextLabel}. Review the summary and warnings below.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <RuleSummaryCard values={ruleValues} />

          {warnings.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Risk Warnings ({warnings.length})
              </h4>
              <WarningsList warnings={warnings} />
            </div>
          )}

          {!showAiReview && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setShowAiReview(true)}
              data-testid="button-get-ai-review"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              Get Miss Pincher's Opinion
            </Button>
          )}

          {showAiReview && <PincherReview ruleValues={ruleValues} />}
        </div>

        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel data-testid="button-cancel-rules">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className={hasHighRisk ? "bg-destructive hover:bg-destructive/90" : ""}
            data-testid="button-confirm-rules"
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : hasHighRisk ? (
              "Save Anyway"
            ) : (
              "Confirm & Save"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
