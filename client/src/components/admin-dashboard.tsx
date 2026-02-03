import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Users, Wallet, Activity, BarChart3, Megaphone, Send, Loader2, CheckCircle, XCircle, Brain, RefreshCw, Target, TrendingUp, Key, Plus, Settings, Power, PowerOff, Globe, AlertTriangle, Server, Webhook, ArrowLeftRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AdminWallet {
  id: number;
  userId: number;
  username: string;
  walletAddress: string;
  label: string | null;
  enabled: boolean;
}

interface AdminStats {
  totalUsers: number;
  totalSwaps: number;
  totalWallets: number;
  activeWallets: number;
}

interface AdminMessage {
  id: number;
  title: string;
  content: string;
  priority: string;
  targetUserId: number | null;
  createdBy: number;
  createdAt: number;
  expiresAt: number | null;
}

interface PendingWallet {
  id: number;
  userId: number;
  username: string;
  walletAddress: string;
  label: string | null;
  aiScore: number | null;
  aiScoreDetails: {
    score: number;
    hitRate: number;
    avgMultiplier: number;
    totalTrades: number;
    realizedPnL: number;
    analysis: string;
  } | null;
  createdAt: number;
}

interface ApiBudgetStatus {
  service: string;
  dailyUsage: number;
  monthlyUsage: number;
  dailyLimit: number;
  monthlyLimit: number;
  dailyPercent: number;
  monthlyPercent: number;
  warningThreshold: number;
  pauseThreshold: number;
  isPaused: boolean;
  isWarning: boolean;
  shouldPause: boolean;
}

interface AdminApiKeyInfo {
  id: number;
  service: string;
  keyLabel: string;
  isActive: boolean | null;
  priority: number | null;
  usageCount: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

interface WalletLimitsConfigInfo {
  id: number;
  baseWalletLimit: number;
  walletsPerApiKey: number;
  maxWalletLimit: number;
  updatedAt: number | null;
}

interface ProductionStatus {
  environment: "development" | "production";
  domain: string | null;
  webhooks: {
    helius: {
      expectedUrl: string;
      activeWebhookId: string | null;
      mismatch: boolean;
      totalWebhooks: number;
    };
    telegram: {
      expectedUrl: string;
      configured: boolean;
    };
  };
  warnings: string[];
  tips: string[];
}

interface SyncWebhooksResult {
  success: boolean;
  results: {
    helius: { success: boolean; message: string };
    telegram: { success: boolean; message: string };
  };
}

interface SystemLog {
  id: number;
  service: string;
  action: string;
  status: string;
  errorMessage: string | null;
  latencyMs: number | null;
  userId: number | null;
  context: {
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    [key: string]: unknown;
  } | null;
  createdAt: number;
}

interface SystemLogsResponse {
  logs: SystemLog[];
  aiSummary: {
    callCount: number;
    totalTokens: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  } | null;
  apiSummary: {
    callCount: number;
    byService: Record<string, number>;
    avgLatencyMs: number;
  };
}

interface TimeSeriesDataPoint {
  timestamp: number;
  aiCalls: number;
  aiTokens: number;
  aiCost: number;
  apiCalls: number;
}

interface UserUsageBreakdown {
  userId: number;
  username: string;
  aiCalls: number;
  aiTokens: number;
  aiCost: number;
  apiCalls: number;
  lastActivity: number;
}

interface UsageProjections {
  hourly: { calls: number; cost: number };
  daily: { calls: number; cost: number };
  weekly: { calls: number; cost: number };
  monthly: { calls: number; cost: number };
}

interface UsageAnalyticsResponse {
  timeSeries: TimeSeriesDataPoint[];
  userBreakdown: UserUsageBreakdown[];
  projections: UsageProjections;
}

export function AdminDashboard() {
  const { toast } = useToast();
  const [messageTitle, setMessageTitle] = useState("");
  const [messageContent, setMessageContent] = useState("");
  const [messagePriority, setMessagePriority] = useState("normal");
  const [targetUser, setTargetUser] = useState<string>("all");
  
  const [showAddApiKey, setShowAddApiKey] = useState(false);
  const [newApiKeyService, setNewApiKeyService] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newApiKeyLabel, setNewApiKeyLabel] = useState("");
  const [newApiKeyPriority, setNewApiKeyPriority] = useState("0");
  
  const [logsFilter, setLogsFilter] = useState<"ai" | "api" | "webhook" | "trade" | "error" | "all">("ai");

  const { data: stats, isLoading: statsLoading } = useQuery<AdminStats>({
    queryKey: ["/api/admin/stats"],
  });

  const { data: users, isLoading: usersLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<AdminWallet[]>({
    queryKey: ["/api/admin/wallets"],
  });

  const { data: adminMessages, isLoading: messagesLoading } = useQuery<AdminMessage[]>({
    queryKey: ["/api/admin/messages"],
  });

  const { data: pendingWallets, isLoading: pendingLoading } = useQuery<PendingWallet[]>({
    queryKey: ["/api/admin/pending-wallets"],
  });

  const { data: apiBudgets, isLoading: budgetsLoading } = useQuery<ApiBudgetStatus[]>({
    queryKey: ["/api/admin/api-budget"],
  });

  const { data: adminApiKeys, isLoading: apiKeysLoading } = useQuery<AdminApiKeyInfo[]>({
    queryKey: ["/api/admin/api-keys"],
  });

  const { data: walletLimitsConfig } = useQuery<WalletLimitsConfigInfo>({
    queryKey: ["/api/admin/wallet-limits"],
  });

  const { data: productionStatus, isLoading: productionStatusLoading, refetch: refetchProductionStatus } = useQuery<ProductionStatus>({
    queryKey: ["/api/admin/production-status"],
  });

  const { data: networkMode, isLoading: networkModeLoading } = useQuery<{ mode: "mainnet" | "devnet"; faucetUrl: string | null }>({
    queryKey: ["/api/network-mode"],
  });

  const systemLogsParams = new URLSearchParams({ limit: "50" });
  if (logsFilter === "ai") systemLogsParams.set("service", "ai");
  if (logsFilter === "error") systemLogsParams.set("status", "error");
  
  const { data: systemLogs, isLoading: systemLogsLoading, refetch: refetchSystemLogs } = useQuery<SystemLogsResponse>({
    queryKey: ["/api/admin/system-logs", logsFilter],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/system-logs?${systemLogsParams}`);
      return res.json();
    },
    refetchInterval: 30000,
    enabled: logsFilter === "all" || logsFilter === "ai" || logsFilter === "error",
  });

  // Dedicated log queries
  const { data: aiLogs, refetch: refetchAiLogs } = useQuery<{ logs: any[] }>({
    queryKey: ["/api/admin/ai-logs"],
    enabled: logsFilter === "ai",
    refetchInterval: 30000,
  });

  const { data: apiLogsData, refetch: refetchApiLogs } = useQuery<{ logs: any[] }>({
    queryKey: ["/api/admin/api-logs"],
    enabled: logsFilter === "api",
    refetchInterval: 30000,
  });

  const { data: webhookLogs, refetch: refetchWebhookLogs } = useQuery<{ logs: any[] }>({
    queryKey: ["/api/admin/webhook-logs"],
    enabled: logsFilter === "webhook",
    refetchInterval: 30000,
  });

  const { data: tradeLogs, refetch: refetchTradeLogs } = useQuery<{ logs: any[] }>({
    queryKey: ["/api/admin/trade-logs"],
    enabled: logsFilter === "trade",
    refetchInterval: 30000,
  });

  const { data: errorLogs, refetch: refetchErrorLogs } = useQuery<{ logs: any[] }>({
    queryKey: ["/api/admin/error-logs"],
    enabled: logsFilter === "error",
    refetchInterval: 30000,
  });

  const { data: logSummary } = useQuery<{ ai: number; api: number; webhook: number; trade: number; error: number }>({
    queryKey: ["/api/admin/log-summary"],
    refetchInterval: 60000,
  });

  const { data: usageAnalytics, isLoading: analyticsLoading } = useQuery<UsageAnalyticsResponse>({
    queryKey: ["/api/admin/usage-analytics"],
    refetchInterval: 60000,
  });

  const setNetworkModeMutation = useMutation({
    mutationFn: async (mode: "mainnet" | "devnet") => {
      const res = await apiRequest("POST", "/api/admin/network-mode", { mode });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/network-mode"] });
      toast({ description: `Switched to ${data.mode === "devnet" ? "Devnet (Testing)" : "Mainnet (Live)"}` });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to change network", variant: "destructive" });
    },
  });

  const syncWebhooksMutation = useMutation({
    mutationFn: async (): Promise<SyncWebhooksResult> => {
      const res = await apiRequest("POST", "/api/admin/sync-webhooks");
      return res.json();
    },
    onSuccess: (data: SyncWebhooksResult) => {
      refetchProductionStatus();
      if (data.success) {
        toast({ description: "All webhooks synced successfully!" });
      } else {
        const failures = [];
        if (!data.results.helius.success) failures.push(`Helius: ${data.results.helius.message}`);
        if (!data.results.telegram.success) failures.push(`Telegram: ${data.results.telegram.message}`);
        toast({ description: `Some webhooks failed: ${failures.join(", ")}`, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to sync webhooks", variant: "destructive" });
    },
  });

  const addAdminApiKeyMutation = useMutation({
    mutationFn: (data: { service: string; apiKey: string; keyLabel: string; priority: number }) =>
      apiRequest("POST", "/api/admin/api-keys", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
      setShowAddApiKey(false);
      setNewApiKeyService("");
      setNewApiKey("");
      setNewApiKeyLabel("");
      setNewApiKeyPriority("0");
      toast({ description: "API key added to pool" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to add API key", variant: "destructive" });
    },
  });

  const deleteAdminApiKeyMutation = useMutation({
    mutationFn: (keyId: number) => apiRequest("DELETE", `/api/admin/api-keys/${keyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
      toast({ description: "API key removed" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to remove API key", variant: "destructive" });
    },
  });

  const toggleAdminApiKeyMutation = useMutation({
    mutationFn: ({ keyId, isActive }: { keyId: number; isActive: boolean }) =>
      apiRequest("PATCH", `/api/admin/api-keys/${keyId}`, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to toggle API key", variant: "destructive" });
    },
  });

  const approveWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet approved for community sharing" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to approve wallet", variant: "destructive" });
    },
  });

  const rejectWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet rejected" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to reject wallet", variant: "destructive" });
    },
  });

  const rescoreWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/rescore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet rescored successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to rescore wallet", variant: "destructive" });
    },
  });

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-500 border-green-500/50";
    if (score >= 40) return "text-yellow-500 border-yellow-500/50";
    return "text-red-500 border-red-500/50";
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 70) return "bg-green-500/10";
    if (score >= 40) return "bg-yellow-500/10";
    return "bg-red-500/10";
  };

  const createMessage = useMutation({
    mutationFn: (data: { title: string; content: string; priority: string; targetUserId: number | null }) =>
      apiRequest("POST", "/api/admin/messages", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/messages"] });
      setMessageTitle("");
      setMessageContent("");
      setMessagePriority("normal");
      setTargetUser("all");
      toast({ description: "Message sent successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to send message", variant: "destructive" });
    },
  });

  const deleteMessage = useMutation({
    mutationFn: (messageId: number) => apiRequest("DELETE", `/api/admin/messages/${messageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/messages"] });
      toast({ description: "Message deleted" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to delete message", variant: "destructive" });
    },
  });

  const deleteUser = useMutation({
    mutationFn: (userId: number) => apiRequest("DELETE", `/api/admin/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/wallets"] });
      toast({ description: "User deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to delete user", variant: "destructive" });
    },
  });

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleDeleteUser = (userId: number, username: string) => {
    if (confirm(`Are you sure you want to delete user "${username}" and all their data?`)) {
      deleteUser.mutate(userId);
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageTitle.trim() || !messageContent.trim()) {
      toast({ description: "Title and content are required", variant: "destructive" });
      return;
    }
    createMessage.mutate({
      title: messageTitle.trim(),
      content: messageContent.trim(),
      priority: messagePriority,
      targetUserId: targetUser === "all" ? null : parseInt(targetUser),
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Total Users
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-users">{stats?.totalUsers ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Total Wallets
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-wallets">{stats?.totalWallets ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Active Wallets
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-active-wallets">{stats?.activeWallets ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Total Swaps
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-swaps">{stats?.totalSwaps ?? 0}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            API Budget
          </CardTitle>
          <CardDescription>Monitor API usage and budget limits</CardDescription>
        </CardHeader>
        <CardContent>
          {budgetsLoading ? (
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : apiBudgets && apiBudgets.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-3">
              {apiBudgets.map((budget) => (
                <div
                  key={budget.service}
                  data-testid={`api-budget-${budget.service}`}
                  className={`p-4 rounded-lg border ${
                    budget.isPaused ? "border-destructive bg-destructive/10" :
                    budget.isWarning ? "border-yellow-500 bg-yellow-500/10" :
                    "bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium capitalize">{budget.service}</span>
                    {budget.isPaused ? (
                      <Badge variant="destructive">Paused</Badge>
                    ) : budget.isWarning ? (
                      <Badge variant="outline" className="border-yellow-500 text-yellow-600">Warning</Badge>
                    ) : (
                      <Badge variant="outline" className="text-green-600">Active</Badge>
                    )}
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Daily</span>
                      <span>{budget.dailyUsage.toLocaleString()} / {budget.dailyLimit.toLocaleString()} ({budget.dailyPercent}%)</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div 
                        className={`h-2 rounded-full ${
                          budget.dailyPercent >= budget.pauseThreshold ? "bg-destructive" :
                          budget.dailyPercent >= budget.warningThreshold ? "bg-yellow-500" :
                          "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(budget.dailyPercent, 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-2">
                      <span className="text-muted-foreground">Monthly</span>
                      <span>{budget.monthlyUsage.toLocaleString()} / {budget.monthlyLimit.toLocaleString()} ({budget.monthlyPercent}%)</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div 
                        className={`h-2 rounded-full ${
                          budget.monthlyPercent >= budget.pauseThreshold ? "bg-destructive" :
                          budget.monthlyPercent >= budget.warningThreshold ? "bg-yellow-500" :
                          "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(budget.monthlyPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No API usage data available yet</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            API Key Pool
          </CardTitle>
          <CardDescription>Manage backend API keys for load balancing and redundancy</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {apiKeysLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : adminApiKeys && adminApiKeys.length > 0 ? (
            <div className="space-y-2">
              {adminApiKeys.map((key) => (
                <div
                  key={key.id}
                  data-testid={`admin-api-key-${key.id}`}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm flex items-center gap-2">
                        {key.keyLabel}
                        <Badge variant="outline" className="text-xs capitalize">{key.service}</Badge>
                        {key.priority !== null && key.priority > 0 && (
                          <Badge variant="secondary" className="text-xs">Priority: {key.priority}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {key.usageCount || 0} uses
                        {key.lastUsedAt && ` · Last used ${new Date(key.lastUsedAt * 1000).toLocaleDateString()}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{key.isActive ? "Active" : "Inactive"}</span>
                      <Switch
                        checked={key.isActive ?? false}
                        onCheckedChange={(checked) => toggleAdminApiKeyMutation.mutate({ keyId: key.id, isActive: checked })}
                        data-testid={`switch-api-key-${key.id}`}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteAdminApiKeyMutation.mutate(key.id)}
                      disabled={deleteAdminApiKeyMutation.isPending}
                      data-testid={`button-delete-admin-key-${key.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No API keys in pool</p>
              <p className="text-xs mt-1">Add keys for load balancing and redundancy</p>
            </div>
          )}

          {showAddApiKey ? (
            <div className="border rounded-lg p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Service</Label>
                  <Select value={newApiKeyService} onValueChange={setNewApiKeyService}>
                    <SelectTrigger data-testid="select-admin-service">
                      <SelectValue placeholder="Select service" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="helius">Helius</SelectItem>
                      <SelectItem value="dexscreener">DexScreener</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Input
                    type="number"
                    value={newApiKeyPriority}
                    onChange={(e) => setNewApiKeyPriority(e.target.value)}
                    placeholder="0"
                    data-testid="input-admin-priority"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Label</Label>
                <Input
                  value={newApiKeyLabel}
                  onChange={(e) => setNewApiKeyLabel(e.target.value)}
                  placeholder="e.g., Helius Key 1"
                  data-testid="input-admin-key-label"
                />
              </div>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Enter API key"
                  data-testid="input-admin-api-key"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (!newApiKeyService || !newApiKey || !newApiKeyLabel) {
                      toast({ description: "Please fill all fields", variant: "destructive" });
                      return;
                    }
                    addAdminApiKeyMutation.mutate({
                      service: newApiKeyService,
                      apiKey: newApiKey,
                      keyLabel: newApiKeyLabel,
                      priority: parseInt(newApiKeyPriority) || 0,
                    });
                  }}
                  disabled={addAdminApiKeyMutation.isPending}
                  data-testid="button-save-admin-key"
                >
                  {addAdminApiKeyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Add Key
                </Button>
                <Button variant="outline" onClick={() => setShowAddApiKey(false)} data-testid="button-cancel-admin-key">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="w-full" onClick={() => setShowAddApiKey(true)} data-testid="button-add-admin-key">
              <Plus className="h-4 w-4 mr-2" />
              Add API Key to Pool
            </Button>
          )}

          {walletLimitsConfig && (
            <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-sm">
              <div className="font-medium flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Wallet Limits Configuration
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="font-medium">{walletLimitsConfig.baseWalletLimit}</div>
                  <div className="text-xs text-muted-foreground">Base Limit</div>
                </div>
                <div>
                  <div className="font-medium">+{walletLimitsConfig.walletsPerApiKey}</div>
                  <div className="text-xs text-muted-foreground">Per API Key</div>
                </div>
                <div>
                  <div className="font-medium">{walletLimitsConfig.maxWalletLimit}</div>
                  <div className="text-xs text-muted-foreground">Max Limit</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Pending Wallet Approvals
            {pendingWallets && pendingWallets.length > 0 && (
              <Badge variant="secondary" className="ml-2">{pendingWallets.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>Review wallet submissions for community sharing</CardDescription>
        </CardHeader>
        <CardContent>
          {pendingLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : pendingWallets && pendingWallets.length > 0 ? (
            <div className="space-y-3">
              {pendingWallets.map((wallet) => (
                <div
                  key={wallet.id}
                  data-testid={`pending-wallet-${wallet.id}`}
                  className={`p-4 rounded-lg border ${wallet.aiScore ? getScoreBgColor(wallet.aiScore) : "bg-muted/50"}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{wallet.label || "Unnamed Wallet"}</span>
                        <Badge variant="outline" className="text-xs">by {wallet.username}</Badge>
                        {wallet.aiScore !== null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className={`gap-1 ${getScoreColor(wallet.aiScore)}`}>
                                <Brain className="h-3 w-3" />
                                {wallet.aiScore}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="space-y-1">
                                <p className="font-medium">AI Trading Score</p>
                                {wallet.aiScoreDetails && (
                                  <div className="text-xs space-y-0.5">
                                    <p>Hit Rate: {(wallet.aiScoreDetails.hitRate * 100).toFixed(0)}%</p>
                                    <p>Avg Multiplier: {wallet.aiScoreDetails.avgMultiplier.toFixed(2)}x</p>
                                    <p>Total Trades: {wallet.aiScoreDetails.totalTrades}</p>
                                    <p>Realized PnL: ${wallet.aiScoreDetails.realizedPnL.toFixed(2)}</p>
                                  </div>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono block">
                        {wallet.walletAddress.slice(0, 8)}...{wallet.walletAddress.slice(-6)}
                      </span>
                      {wallet.aiScoreDetails && (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Target className="h-3 w-3" />
                            {(wallet.aiScoreDetails.hitRate * 100).toFixed(0)}% wins
                          </span>
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {wallet.aiScoreDetails.avgMultiplier.toFixed(1)}x avg
                          </span>
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {wallet.aiScoreDetails.totalTrades} trades
                          </span>
                        </div>
                      )}
                      {wallet.aiScoreDetails?.analysis && (
                        <p className="text-xs text-muted-foreground italic">
                          "{wallet.aiScoreDetails.analysis}"
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => rescoreWallet.mutate(wallet.id)}
                        disabled={rescoreWallet.isPending}
                        title="Rescore"
                        data-testid={`button-rescore-wallet-${wallet.id}`}
                      >
                        <RefreshCw className={`h-4 w-4 ${rescoreWallet.isPending ? "animate-spin" : ""}`} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-green-500 hover:text-green-600"
                        onClick={() => approveWallet.mutate(wallet.id)}
                        disabled={approveWallet.isPending}
                        title="Approve"
                        data-testid={`button-approve-wallet-${wallet.id}`}
                      >
                        <CheckCircle className="h-5 w-5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-500 hover:text-red-600"
                        onClick={() => rejectWallet.mutate(wallet.id)}
                        disabled={rejectWallet.isPending}
                        title="Reject"
                        data-testid={`button-reject-wallet-${wallet.id}`}
                      >
                        <XCircle className="h-5 w-5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-6">
              No pending wallet submissions
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            User Management
          </CardTitle>
          <CardDescription>Manage all registered users</CardDescription>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : users && users.length > 0 ? (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                  data-testid={`user-row-${user.id}`}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium" data-testid={`user-username-${user.id}`}>
                          {user.username}
                        </span>
                        {user.isAdmin && (
                          <Badge variant="default" className="text-xs">Admin</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Joined: {formatDate(user.createdAt)}
                        {user.lastLoginAt && ` | Last login: ${formatDate(user.lastLoginAt)}`}
                      </p>
                    </div>
                  </div>
                  {!user.isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteUser(user.id, user.username)}
                      disabled={deleteUser.isPending}
                      data-testid={`button-delete-user-${user.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No users found</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            Send Announcement
          </CardTitle>
          <CardDescription>Send alerts and announcements to users</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSendMessage} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="message-title">Title</Label>
                <Input
                  id="message-title"
                  placeholder="Announcement title"
                  value={messageTitle}
                  onChange={(e) => setMessageTitle(e.target.value)}
                  data-testid="input-message-title"
                />
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="message-priority">Priority</Label>
                  <Select value={messagePriority} onValueChange={setMessagePriority}>
                    <SelectTrigger data-testid="select-message-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message-target">Send To</Label>
                  <Select value={targetUser} onValueChange={setTargetUser}>
                    <SelectTrigger data-testid="select-message-target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Users</SelectItem>
                      {users?.map((user) => (
                        <SelectItem key={user.id} value={String(user.id)}>
                          {user.username}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="message-content">Message</Label>
              <Textarea
                id="message-content"
                placeholder="Enter your announcement message..."
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                className="min-h-[100px]"
                data-testid="textarea-message-content"
              />
            </div>
            <Button
              type="submit"
              disabled={createMessage.isPending || !messageTitle.trim() || !messageContent.trim()}
              data-testid="button-send-message"
            >
              {createMessage.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Send Announcement
            </Button>
          </form>

          {adminMessages && adminMessages.length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <h4 className="font-medium mb-3">Previous Announcements</h4>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {adminMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="flex items-start justify-between p-3 rounded-lg border text-sm"
                    data-testid={`admin-message-${msg.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{msg.title}</span>
                        {msg.priority !== "normal" && (
                          <Badge variant={msg.priority === "urgent" ? "destructive" : "secondary"} className="text-xs">
                            {msg.priority}
                          </Badge>
                        )}
                        {msg.targetUserId && (
                          <Badge variant="outline" className="text-xs">
                            {users?.find(u => u.id === msg.targetUserId)?.username || `User #${msg.targetUserId}`}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">{msg.content}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(msg.createdAt)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMessage.mutate(msg.id)}
                      disabled={deleteMessage.isPending}
                      data-testid={`button-delete-message-${msg.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            All Signal Wallets
          </CardTitle>
          <CardDescription>View all wallets across all users</CardDescription>
        </CardHeader>
        <CardContent>
          {walletsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : wallets && wallets.length > 0 ? (
            <div className="space-y-2">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                  data-testid={`wallet-row-${wallet.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium" data-testid={`wallet-owner-${wallet.id}`}>
                        {wallet.username}
                      </span>
                      <Badge variant={wallet.enabled ? "default" : "secondary"} className="text-xs">
                        {wallet.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground truncate" data-testid={`wallet-address-${wallet.id}`}>
                      {wallet.label ? `${wallet.label}: ` : ""}{wallet.walletAddress}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No wallets found</p>
          )}
        </CardContent>
      </Card>

      {/* Network Mode (Devnet/Mainnet) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Network Mode
          </CardTitle>
          <CardDescription>Switch between test and live Solana networks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {networkModeLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Current Network</span>
                    <Badge variant={networkMode?.mode === "devnet" ? "secondary" : "default"}>
                      {networkMode?.mode === "devnet" ? "Devnet (Testing)" : "Mainnet (Live)"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {networkMode?.mode === "devnet" 
                      ? "Using test SOL for development and testing" 
                      : "Real trading with real SOL"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Devnet</span>
                  <Switch
                    checked={networkMode?.mode === "mainnet"}
                    onCheckedChange={(checked) => setNetworkModeMutation.mutate(checked ? "mainnet" : "devnet")}
                    disabled={setNetworkModeMutation.isPending}
                    data-testid="switch-network-mode"
                  />
                  <span className="text-sm text-muted-foreground">Mainnet</span>
                </div>
              </div>
              
              {networkMode?.mode === "devnet" && (
                <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Need test SOL?</p>
                    <p className="text-xs text-muted-foreground">Get free devnet SOL for testing</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open("https://faucet.solana.com/", "_blank")}
                    data-testid="button-open-faucet"
                  >
                    Open Faucet
                  </Button>
                </div>
              )}

              {networkMode?.mode === "mainnet" && (
                <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                  <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">
                    Live trading mode. All transactions use real SOL.
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Production Setup / Webhook Management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Production Setup
          </CardTitle>
          <CardDescription>Environment status and webhook management</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {productionStatusLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
            </div>
          ) : productionStatus ? (
            <>
              {/* Environment Badge */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Environment</span>
                <Badge variant={productionStatus.environment === "production" ? "default" : "secondary"}>
                  <Globe className="h-3 w-3 mr-1" />
                  {productionStatus.environment === "production" ? "Production" : "Development"}
                </Badge>
              </div>

              {/* Domain */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Domain</span>
                <span className="text-sm text-muted-foreground font-mono">
                  {productionStatus.domain || "localhost"}
                </span>
              </div>

              {/* Webhooks Status */}
              <div className="border rounded-lg p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Helius Webhook</span>
                  <div className="flex items-center gap-2">
                    {productionStatus.webhooks.helius.mismatch ? (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        URL Mismatch
                      </Badge>
                    ) : productionStatus.webhooks.helius.activeWebhookId ? (
                      <Badge variant="default" className="text-xs">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        Not Active
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground font-mono truncate">
                  {productionStatus.webhooks.helius.expectedUrl.split("?")[0]}
                </p>

                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-sm font-medium">Telegram Webhook</span>
                  <Badge variant={productionStatus.webhooks.telegram.configured ? "default" : "secondary"} className="text-xs">
                    {productionStatus.webhooks.telegram.configured ? (
                      <><CheckCircle className="h-3 w-3 mr-1" />Configured</>
                    ) : (
                      "Not Configured"
                    )}
                  </Badge>
                </div>
                {productionStatus.webhooks.telegram.configured && (
                  <p className="text-xs text-muted-foreground font-mono truncate">
                    {productionStatus.webhooks.telegram.expectedUrl}
                  </p>
                )}
              </div>

              {/* Warnings */}
              {productionStatus.warnings.length > 0 && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 space-y-1">
                  {productionStatus.warnings.map((warning, i) => (
                    <p key={i} className="text-sm text-destructive flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              {/* Tips */}
              <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                <p className="text-xs font-medium text-muted-foreground mb-2">Tips</p>
                {productionStatus.tips.map((tip, i) => (
                  <p key={i} className="text-xs text-muted-foreground">{tip}</p>
                ))}
              </div>

              {/* Sync Button */}
              <Button
                onClick={() => syncWebhooksMutation.mutate()}
                disabled={syncWebhooksMutation.isPending}
                className="w-full"
                data-testid="button-sync-webhooks"
              >
                {syncWebhooksMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" />Sync Webhooks to Current Environment</>
                )}
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-center py-4">Failed to load production status</p>
          )}
        </CardContent>
      </Card>

      {/* System Logs - AI Usage & Errors */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            System Logs
          </CardTitle>
          <CardDescription>AI token usage, API calls, costs, and system events</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Log Summary Counts */}
          {logSummary && (
            <div className="flex gap-4 text-xs text-muted-foreground mb-2">
              <span>AI: {logSummary.ai}</span>
              <span>API: {logSummary.api}</span>
              <span>Webhooks: {logSummary.webhook}</span>
              <span>Trades: {logSummary.trade}</span>
              <span className={logSummary.error > 0 ? "text-destructive font-medium" : ""}>Errors: {logSummary.error}</span>
            </div>
          )}

          {/* Filter Tabs */}
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={logsFilter === "ai" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("ai")}
              data-testid="button-logs-filter-ai"
            >
              <Brain className="h-3 w-3 mr-1" />
              AI
            </Button>
            <Button
              variant={logsFilter === "api" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("api")}
              data-testid="button-logs-filter-api"
            >
              <Activity className="h-3 w-3 mr-1" />
              API
            </Button>
            <Button
              variant={logsFilter === "webhook" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("webhook")}
              data-testid="button-logs-filter-webhook"
            >
              <Webhook className="h-3 w-3 mr-1" />
              Webhooks
            </Button>
            <Button
              variant={logsFilter === "trade" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("trade")}
              data-testid="button-logs-filter-trade"
            >
              <ArrowLeftRight className="h-3 w-3 mr-1" />
              Trades
            </Button>
            <Button
              variant={logsFilter === "error" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("error")}
              data-testid="button-logs-filter-errors"
            >
              <XCircle className="h-3 w-3 mr-1" />
              Errors
            </Button>
            <Button
              variant={logsFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setLogsFilter("all")}
              data-testid="button-logs-filter-all"
            >
              All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                refetchSystemLogs();
                refetchAiLogs();
                refetchApiLogs();
                refetchWebhookLogs();
                refetchTradeLogs();
                refetchErrorLogs();
              }}
              data-testid="button-refresh-logs"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>

          {/* Cost Projections */}
          {analyticsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : usageAnalytics?.projections && (
            <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-xs font-medium text-primary mb-2">Projected AI Costs (based on 24h usage)</p>
              <div className="grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-xs text-muted-foreground">Hour</p>
                  <p className="text-sm font-semibold">${usageAnalytics.projections.hourly.cost.toFixed(4)}</p>
                  <p className="text-xs text-muted-foreground">{usageAnalytics.projections.hourly.calls} calls</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Day</p>
                  <p className="text-sm font-semibold">${usageAnalytics.projections.daily.cost.toFixed(4)}</p>
                  <p className="text-xs text-muted-foreground">{usageAnalytics.projections.daily.calls} calls</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Week</p>
                  <p className="text-sm font-semibold">${usageAnalytics.projections.weekly.cost.toFixed(4)}</p>
                  <p className="text-xs text-muted-foreground">{usageAnalytics.projections.weekly.calls} calls</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Month</p>
                  <p className="text-sm font-semibold text-primary">${usageAnalytics.projections.monthly.cost.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">{usageAnalytics.projections.monthly.calls} calls</p>
                </div>
              </div>
            </div>
          )}

          {/* AI Summary */}
          {systemLogs?.aiSummary && logsFilter === "ai" && (
            <div className="grid grid-cols-2 gap-3 p-3 bg-muted/50 rounded-lg">
              <div>
                <p className="text-xs text-muted-foreground">AI Calls</p>
                <p className="text-lg font-semibold">{systemLogs.aiSummary.callCount}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Tokens</p>
                <p className="text-lg font-semibold">{systemLogs.aiSummary.totalTokens.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Est. Cost (USD)</p>
                <p className="text-lg font-semibold">${systemLogs.aiSummary.estimatedCostUsd.toFixed(6)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg Latency</p>
                <p className="text-lg font-semibold">{systemLogs.aiSummary.avgLatencyMs}ms</p>
              </div>
            </div>
          )}

          {/* API Usage Summary */}
          {systemLogs?.apiSummary && systemLogs.apiSummary.callCount > 0 && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium mb-2">API Usage (last 50 events)</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(systemLogs.apiSummary.byService).map(([service, count]) => 
                  count > 0 && (
                    <Badge key={service} variant="outline" className="text-xs">
                      {service}: {count}
                    </Badge>
                  )
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  avg {systemLogs.apiSummary.avgLatencyMs}ms
                </span>
              </div>
            </div>
          )}

          {/* Usage Graph (Simple Bar Chart) */}
          {usageAnalytics?.timeSeries && usageAnalytics.timeSeries.length > 0 && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium mb-2">24h Usage Timeline (AI calls per hour)</p>
              <div className="flex items-end gap-0.5 h-16">
                {usageAnalytics.timeSeries.map((point, i) => {
                  const maxCalls = Math.max(...usageAnalytics.timeSeries.map(p => p.aiCalls), 1);
                  const height = (point.aiCalls / maxCalls) * 100;
                  const hour = new Date(point.timestamp).getHours();
                  return (
                    <Tooltip key={i}>
                      <TooltipTrigger asChild>
                        <div
                          className="flex-1 bg-primary/60 hover:bg-primary transition-colors rounded-t cursor-pointer min-w-[4px]"
                          style={{ height: `${Math.max(height, 4)}%` }}
                          data-testid={`graph-bar-${i}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          {hour}:00 - {point.aiCalls} AI calls, ${point.aiCost.toFixed(4)}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>24h ago</span>
                <span>Now</span>
              </div>
            </div>
          )}

          {/* User Attribution */}
          {usageAnalytics?.userBreakdown && usageAnalytics.userBreakdown.length > 0 && (
            <div className="p-3 bg-muted/30 rounded-lg">
              <p className="text-xs font-medium mb-2">User Attribution (24h)</p>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {usageAnalytics.userBreakdown.slice(0, 10).map((user) => (
                  <div key={user.userId} className="flex items-center justify-between text-xs" data-testid={`user-usage-${user.userId}`}>
                    <span className="font-medium truncate max-w-[120px]">{user.username}</span>
                    <div className="flex gap-2 text-muted-foreground">
                      <span>{user.aiCalls} AI</span>
                      <span>{user.apiCalls} API</span>
                      <span className="text-primary font-medium">${user.aiCost.toFixed(4)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Logs */}
          {logsFilter === "ai" && aiLogs?.logs && (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {aiLogs.logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No AI logs found</p>
              ) : aiLogs.logs.map((log: any) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border text-sm" data-testid={`ai-log-${log.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-xs"><Brain className="h-2 w-2 mr-1" />AI</Badge>
                      <span className="font-medium truncate">{log.action}</span>
                      {log.latencyMs && <span className="text-xs text-muted-foreground">{log.latencyMs}ms</span>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {log.totalTokens?.toLocaleString()} tokens • ${log.estimatedCostUsd?.toFixed(6)} • {log.model}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* API Logs */}
          {logsFilter === "api" && apiLogsData?.logs && (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {apiLogsData.logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No API logs found</p>
              ) : apiLogsData.logs.map((log: any) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border text-sm" data-testid={`api-log-${log.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={log.success ? "secondary" : "destructive"} className="text-xs">{log.service}</Badge>
                      <span className="font-medium truncate">{log.endpoint}</span>
                      {log.latencyMs && <span className="text-xs text-muted-foreground">{log.latencyMs}ms</span>}
                      {log.statusCode && <span className="text-xs text-muted-foreground">({log.statusCode})</span>}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Webhook Logs */}
          {logsFilter === "webhook" && webhookLogs?.logs && (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {webhookLogs.logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No webhook logs found</p>
              ) : webhookLogs.logs.map((log: any) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border text-sm" data-testid={`webhook-log-${log.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={log.status === "error" ? "destructive" : "secondary"} className="text-xs">{log.source}</Badge>
                      <span className="font-medium truncate">{log.eventType}</span>
                      <Badge variant="outline" className="text-xs">{log.status}</Badge>
                      {log.processingTimeMs && <span className="text-xs text-muted-foreground">{log.processingTimeMs}ms</span>}
                    </div>
                    {log.walletAddress && <p className="text-xs text-muted-foreground mt-1 truncate">Wallet: {log.walletAddress}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Trade Logs */}
          {logsFilter === "trade" && tradeLogs?.logs && (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {tradeLogs.logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No trade logs found</p>
              ) : tradeLogs.logs.map((log: any) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border text-sm" data-testid={`trade-log-${log.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={log.status === "success" ? "secondary" : log.status === "failed" ? "destructive" : "outline"} className="text-xs">
                        {log.action}
                      </Badge>
                      <span className="font-medium truncate">{log.tokenSymbol || log.tokenMint?.slice(0, 8)}</span>
                      <Badge variant="outline" className="text-xs">{log.status}</Badge>
                      {log.amountSol && <span className="text-xs text-muted-foreground">{log.amountSol.toFixed(4)} SOL</span>}
                    </div>
                    {log.failureReason && <p className="text-xs text-destructive mt-1 truncate">{log.failureReason}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error Logs */}
          {logsFilter === "error" && errorLogs?.logs && (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {errorLogs.logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No errors found</p>
              ) : errorLogs.logs.map((log: any) => (
                <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border border-destructive/30 text-sm" data-testid={`error-log-${log.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="destructive" className="text-xs">{log.service}</Badge>
                      <span className="font-medium truncate">{log.action}</span>
                      <Badge variant="outline" className="text-xs">{log.errorType}</Badge>
                    </div>
                    <p className="text-xs text-destructive mt-1">{log.errorMessage}</p>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

          {/* All Logs (Legacy system logs) */}
          {logsFilter === "all" && (
            systemLogsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : systemLogs?.logs.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No logs found</p>
            ) : (
              <div className="max-h-80 overflow-y-auto space-y-2">
                {systemLogs?.logs.map((log) => (
                  <div key={log.id} className="flex items-start justify-between gap-2 p-2 rounded border text-sm" data-testid={`log-entry-${log.id}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={log.status === "error" ? "destructive" : log.status === "warning" ? "outline" : "secondary"} className="text-xs">
                          {log.service}
                        </Badge>
                        <span className="font-medium truncate">{log.action}</span>
                        {log.latencyMs && <span className="text-xs text-muted-foreground">{log.latencyMs}ms</span>}
                      </div>
                      {log.errorMessage && <p className="text-xs text-destructive mt-1 truncate">{log.errorMessage}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
