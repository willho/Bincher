import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Copy, DollarSign, Percent, Clock, Shield, Filter, Zap } from "lucide-react";
import { RuleBuilder, RuleValues } from "@/components/rule-builder";
import { RuleConfirmDialog } from "@/components/rule-confirm-dialog";

interface WalletRuleDefaults {
  id: number;
  walletId: number;
  userId: number;
  takeProfitThresholds: number[];
  takeProfitPercentages: number[];
  takeProfitEnabled?: boolean[];
  stopLossPercent: number;
  stopLossFloorUsd: number | null;
  stopLossMode: string;
  autoMirrorSells: boolean;
  autonomyEnabled: boolean;
}

interface MonitoredWallet {
  id: number;
  userId: number;
  walletAddress: string;
  label: string | null;
  enabled: boolean | null;
  copyTradeEnabled: boolean | null;
  copyBuyType: string | null;
  copyBuyAmount: number | null;
  copyMinBalance: number | null;
  copyMinTradeUsd: number | null;
  copyScoreThreshold: number | null;
  copyTiming: string | null;
  copyDelayMinutes: number | null;
  copyAutoMirror: boolean | null;
  copyMirrorBuys: boolean | null;
  copyMirrorSells: boolean | null;
  dedupSkipIfHolding: boolean | null;
  dedupSkipIfEverHeld: boolean | null;
  dedupSkipIfPending: boolean | null;
}

export default function CopySettingsPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  
  const [ruleValues, setRuleValues] = useState<RuleValues>({
    takeProfitThresholds: [4, 10, 25, 100],
    takeProfitPercentages: [25, 25, 25, 25],
    takeProfitEnabled: [true, true, true, true],
    stopLossPercent: 50,
    stopLossMode: "auto",
  });
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const previousRuleValues = useRef<RuleValues | null>(null);
  
  const { data: wallet, isLoading } = useQuery<MonitoredWallet>({
    queryKey: ["/api/monitored-wallets", id],
    queryFn: () => fetch(`/api/monitored-wallets/${id}`).then(r => r.json()),
  });

  const { data: ruleDefaults, isLoading: isLoadingRules } = useQuery<WalletRuleDefaults | null>({
    queryKey: ["/api/signal-wallets", id, "rule-defaults"],
    queryFn: () => fetch(`/api/signal-wallets/${id}/rule-defaults`).then(r => r.json()),
    enabled: !!id,
  });

  useEffect(() => {
    if (ruleDefaults) {
      const thresholds = ruleDefaults.takeProfitThresholds || [4, 10, 25, 100];
      const loadedValues: RuleValues = {
        takeProfitThresholds: thresholds,
        takeProfitPercentages: ruleDefaults.takeProfitPercentages || [25, 25, 25, 25],
        takeProfitEnabled: ruleDefaults.takeProfitEnabled || thresholds.map(() => true),
        stopLossPercent: ruleDefaults.stopLossPercent ?? 50,
        stopLossMode: (ruleDefaults.stopLossMode as "auto" | "alert") || "auto",
      };
      setRuleValues(loadedValues);
      previousRuleValues.current = loadedValues;
    }
  }, [ruleDefaults]);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<MonitoredWallet>) =>
      apiRequest("PATCH", `/api/monitored-wallets/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
    },
  });

  const updateRuleDefaultsMutation = useMutation({
    mutationFn: (data: Partial<WalletRuleDefaults>) =>
      apiRequest("PUT", `/api/signal-wallets/${id}/rule-defaults`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signal-wallets", id, "rule-defaults"] });
      toast({ title: "Rule defaults saved" });
    },
    onError: () => {
      toast({ title: "Failed to save rule defaults", variant: "destructive" });
    },
  });

  const handleUpdate = (field: string, value: any) => {
    updateMutation.mutate({ [field]: value });
  };

  const handleSaveClick = () => {
    setShowConfirmDialog(true);
  };

  const confirmSaveRules = () => {
    updateRuleDefaultsMutation.mutate({
      takeProfitThresholds: ruleValues.takeProfitThresholds,
      takeProfitPercentages: ruleValues.takeProfitPercentages,
      takeProfitEnabled: ruleValues.takeProfitEnabled,
      stopLossPercent: ruleValues.stopLossPercent,
      stopLossMode: ruleValues.stopLossMode,
    });
    setShowConfirmDialog(false);
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Wallet not found</p>
      </div>
    );
  }

  const truncateAddress = (addr: string) => `${addr.slice(0, 4)}...${addr.slice(-4)}`;

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4">
        <Button 
          variant="ghost" 
          size="icon"
          onClick={() => navigate(`/signal/${id}`)}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Copy Trading Settings</h1>
          <p className="text-muted-foreground">
            {wallet.label || truncateAddress(wallet.walletAddress)}
          </p>
        </div>
      </div>

      {/* Master Toggle */}
      <Card data-testid="card-master-toggle">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Copy className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Copy Trading</CardTitle>
                <CardDescription>Automatically copy trades from this wallet</CardDescription>
              </div>
            </div>
            <Switch
              checked={wallet.copyTradeEnabled ?? false}
              onCheckedChange={(enabled) => handleUpdate("copyTradeEnabled", enabled)}
              data-testid="switch-copy-enabled"
              className={wallet.copyTradeEnabled ? "data-[state=checked]:bg-green-500" : ""}
            />
          </div>
        </CardHeader>
        {wallet.copyTradeEnabled && (
          <CardContent>
            <Badge variant="default" className="bg-green-500">Active</Badge>
          </CardContent>
        )}
      </Card>

      {/* Buy Amount Settings */}
      <Card data-testid="card-buy-settings">
        <CardHeader>
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Buy Amount</CardTitle>
              <CardDescription>How much to spend when copying a buy</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Amount Type</Label>
              <Select
                value={wallet.copyBuyType || "percentage"}
                onValueChange={(v) => handleUpdate("copyBuyType", v)}
                data-testid="select-buy-type"
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed_sol">Fixed SOL</SelectItem>
                  <SelectItem value="fixed_usd">Fixed USD</SelectItem>
                  <SelectItem value="percentage">% of Balance</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                value={wallet.copyBuyAmount || 10}
                onChange={(e) => handleUpdate("copyBuyAmount", parseFloat(e.target.value))}
                data-testid="input-buy-amount"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Minimum Hot Wallet Balance (SOL)</Label>
            <Input
              type="number"
              placeholder="Skip if balance below this"
              value={wallet.copyMinBalance || ""}
              onChange={(e) => handleUpdate("copyMinBalance", e.target.value ? parseFloat(e.target.value) : null)}
              data-testid="input-min-balance"
            />
            <p className="text-xs text-muted-foreground">Leave empty for no minimum</p>
          </div>
        </CardContent>
      </Card>

      {/* Entry Filters */}
      <Card data-testid="card-filters">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Filter className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Entry Filters</CardTitle>
              <CardDescription>Only copy trades that meet these criteria</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Minimum Trade Value (USD)</Label>
              <Input
                type="number"
                placeholder="e.g., 50"
                value={wallet.copyMinTradeUsd || ""}
                onChange={(e) => handleUpdate("copyMinTradeUsd", e.target.value ? parseFloat(e.target.value) : null)}
                data-testid="input-min-trade"
              />
            </div>
            <div className="space-y-2">
              <Label>Minimum AI Score (0-100)</Label>
              <Input
                type="number"
                placeholder="e.g., 60"
                min={0}
                max={100}
                value={wallet.copyScoreThreshold || ""}
                onChange={(e) => handleUpdate("copyScoreThreshold", e.target.value ? parseInt(e.target.value) : null)}
                data-testid="input-score-threshold"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Timing Settings */}
      <Card data-testid="card-timing">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Timing</CardTitle>
              <CardDescription>When to execute the copy trade</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Execution Timing</Label>
              <Select
                value={wallet.copyTiming || "immediate"}
                onValueChange={(v) => handleUpdate("copyTiming", v)}
                data-testid="select-timing"
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="immediate">Immediate</SelectItem>
                  <SelectItem value="delayed">Delayed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {wallet.copyTiming === "delayed" && (
              <div className="space-y-2">
                <Label>Delay (minutes)</Label>
                <Input
                  type="number"
                  value={wallet.copyDelayMinutes || 5}
                  onChange={(e) => handleUpdate("copyDelayMinutes", parseInt(e.target.value))}
                  data-testid="input-delay"
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
            <div className="min-w-0">
              <Label>Mirror Buys</Label>
              <p className="text-xs text-muted-foreground">Also copy when signal wallet buys more of a token you hold</p>
            </div>
            <Switch
              checked={wallet.copyMirrorBuys ?? wallet.copyAutoMirror ?? false}
              onCheckedChange={(v) => handleUpdate("copyMirrorBuys", v)}
              data-testid="switch-mirror-buys"
              className="shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
            <div className="min-w-0">
              <Label>Mirror Sells</Label>
              <p className="text-xs text-muted-foreground">Also sell when signal wallet sells a token you hold</p>
            </div>
            <Switch
              checked={wallet.copyMirrorSells ?? wallet.copyAutoMirror ?? false}
              onCheckedChange={(v) => handleUpdate("copyMirrorSells", v)}
              data-testid="switch-mirror-sells"
              className="shrink-0"
            />
          </div>
        </CardContent>
      </Card>

      {/* Deduplication */}
      <Card data-testid="card-dedup">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Duplicate Protection</CardTitle>
              <CardDescription>Avoid buying the same token multiple times</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
            <div className="min-w-0">
              <Label>Skip if Already Holding</Label>
              <p className="text-xs text-muted-foreground">Don't buy tokens you already own</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfHolding ?? true}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfHolding", v)}
              data-testid="switch-skip-holding"
              className="shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
            <div className="min-w-0">
              <Label>Skip if Ever Held</Label>
              <p className="text-xs text-muted-foreground">Don't re-buy tokens you've sold</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfEverHeld ?? false}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfEverHeld", v)}
              data-testid="switch-skip-ever-held"
              className="shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg border">
            <div className="min-w-0">
              <Label>Skip if Pending</Label>
              <p className="text-xs text-muted-foreground">Don't buy if a buy is already in progress</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfPending ?? true}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfPending", v)}
              data-testid="switch-skip-pending"
              className="shrink-0"
            />
          </div>
        </CardContent>
      </Card>

      {/* Default Position Rules */}
      <Card data-testid="card-position-rules">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Default Position Rules</CardTitle>
              <CardDescription>Auto-sell rules applied to all copied positions from this wallet</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoadingRules ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <RuleBuilder
                values={ruleValues}
                onChange={setRuleValues}
                onSave={handleSaveClick}
                isSaving={updateRuleDefaultsMutation.isPending}
                showSaveButton={true}
                testIdPrefix={`wallet-${id}`}
                showPresets={true}
              />
              <p className="text-xs text-center text-muted-foreground">
                New positions will inherit these rules. Override on individual tokens as needed.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <RuleConfirmDialog
        open={showConfirmDialog}
        onOpenChange={setShowConfirmDialog}
        ruleValues={ruleValues}
        previousValues={previousRuleValues.current}
        onConfirm={confirmSaveRules}
        isPending={updateRuleDefaultsMutation.isPending}
        walletName={wallet?.label || truncateAddress(wallet?.walletAddress || "")}
      />
    </div>
  );
}
