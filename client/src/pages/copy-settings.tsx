import { useState } from "react";
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
import { ArrowLeft, Copy, DollarSign, Percent, Clock, Shield, Filter, Zap } from "lucide-react";

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
  dedupSkipIfHolding: boolean | null;
  dedupSkipIfEverHeld: boolean | null;
  dedupSkipIfPending: boolean | null;
}

export default function CopySettingsPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  
  const { data: wallet, isLoading } = useQuery<MonitoredWallet>({
    queryKey: ["/api/monitored-wallets", id],
    queryFn: () => fetch(`/api/monitored-wallets/${id}`).then(r => r.json()),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Partial<MonitoredWallet>) =>
      apiRequest("PATCH", `/api/monitored-wallets/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
    },
  });

  const handleUpdate = (field: string, value: any) => {
    updateMutation.mutate({ [field]: value });
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
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Auto-Mirror</Label>
              <p className="text-xs text-muted-foreground">Also mirror additional buys and sells</p>
            </div>
            <Switch
              checked={wallet.copyAutoMirror ?? false}
              onCheckedChange={(v) => handleUpdate("copyAutoMirror", v)}
              data-testid="switch-auto-mirror"
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
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Skip if Already Holding</Label>
              <p className="text-xs text-muted-foreground">Don't buy tokens you already own</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfHolding ?? true}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfHolding", v)}
              data-testid="switch-skip-holding"
            />
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Skip if Ever Held</Label>
              <p className="text-xs text-muted-foreground">Don't re-buy tokens you've sold</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfEverHeld ?? false}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfEverHeld", v)}
              data-testid="switch-skip-ever-held"
            />
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg border">
            <div>
              <Label>Skip if Pending</Label>
              <p className="text-xs text-muted-foreground">Don't buy if a buy is already in progress</p>
            </div>
            <Switch
              checked={wallet.dedupSkipIfPending ?? true}
              onCheckedChange={(v) => handleUpdate("dedupSkipIfPending", v)}
              data-testid="switch-skip-pending"
            />
          </div>
        </CardContent>
      </Card>

      {/* Position Rules - Placeholder for now */}
      <Card data-testid="card-position-rules">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Default Position Rules</CardTitle>
              <CardDescription>Auto-sell/buy rules applied to all copied positions</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <p>Position rules coming soon</p>
            <p className="text-xs mt-1">Set take-profit, stop-loss, and other automatic actions</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
