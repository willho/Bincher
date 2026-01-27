import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useWebSocket } from "@/hooks/use-websocket";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyTrading } from "@/components/copy-trading";
import { MonitoredWallets } from "@/components/monitored-wallets";
import { CommunityWallets } from "@/components/community-wallets";
import { AdminDashboard } from "@/components/admin-dashboard";
import { AIInsights } from "@/components/ai-insights";
import { Alerts } from "@/components/alerts";
import { 
  Activity, 
  ArrowRightLeft, 
  Bell, 
  Bot,
  Brain,
  Copy,
  ExternalLink, 
  Mail, 
  Play, 
  Plus,
  Power, 
  RefreshCw, 
  Settings,
  Wallet,
  X,
  Zap
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Swap, MonitoringStatus, NotificationSettings } from "@shared/schema";

interface SessionData {
  authenticated: boolean;
  username?: string;
  userId?: number;
  isAdmin?: boolean;
}

export default function Dashboard() {
  const [newEmail, setNewEmail] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const { toast } = useToast();

  const { data: session } = useQuery<SessionData>({
    queryKey: ["/api/auth/session"],
  });

  const isAdmin = session?.isAdmin ?? false;

  const copyToClipboard = async (text: string, label: string = "Address") => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: `${label} copied to clipboard` });
    } catch {
      toast({ description: "Failed to copy", variant: "destructive" });
    }
  };

  // WebSocket for real-time updates
  const handleWebSocketMessage = useCallback((message: any) => {
    if (message.type === "NEW_SWAP") {
      queryClient.setQueryData<Swap[]>(["/api/swaps"], (old) => {
        if (!old) return [message.swap];
        return [message.swap, ...old];
      });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
    } else if (message.type === "STATUS_UPDATE") {
      queryClient.setQueryData(["/api/status"], message.status);
    }
  }, []);

  useWebSocket(handleWebSocketMessage);

  // Queries
  const { data: status, isLoading: statusLoading } = useQuery<MonitoringStatus>({
    queryKey: ["/api/status"],
    refetchInterval: 30000,
  });

  const { data: swaps, isLoading: swapsLoading } = useQuery<Swap[]>({
    queryKey: ["/api/swaps"],
  });

  const { data: settings, isLoading: settingsLoading } = useQuery<NotificationSettings>({
    queryKey: ["/api/settings"],
  });


  const { data: wallet } = useQuery<{ address: string }>({
    queryKey: ["/api/wallet"],
  });

  const { data: unreadCount } = useQuery<{ count: number }>({
    queryKey: ["/api/messages/unread-count"],
    refetchInterval: 60000,
  });

  // Mutations
  const startMonitoring = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitoring/start"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
    },
  });

  const stopMonitoring = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitoring/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
    },
  });

  const updateSettings = useMutation({
    mutationFn: (data: Partial<NotificationSettings>) => 
      apiRequest("PATCH", "/api/settings", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ description: "Settings saved successfully" });
    },
  });

  const handleAddEmail = () => {
    if (!newEmail || !newEmail.includes("@")) {
      toast({ description: "Please enter a valid email", variant: "destructive" });
      return;
    }
    const currentEmails = settings?.emails || [];
    if (currentEmails.includes(newEmail)) {
      toast({ description: "Email already added", variant: "destructive" });
      return;
    }
    updateSettings.mutate({ emails: [...currentEmails, newEmail] });
    setNewEmail("");
  };

  const handleRemoveEmail = (emailToRemove: string) => {
    const currentEmails = settings?.emails || [];
    if (currentEmails.length <= 1) {
      toast({ description: "At least one email is required", variant: "destructive" });
      return;
    }
    updateSettings.mutate({ emails: currentEmails.filter(e => e !== emailToRemove) });
  };

  const handleSaveMinAmount = () => {
    if (minAmount) {
      updateSettings.mutate({ minSwapAmount: parseFloat(minAmount) });
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatAmount = (amount: number) => {
    if (amount >= 1000000) return (amount / 1000000).toFixed(2) + "M";
    if (amount >= 1000) return (amount / 1000).toFixed(2) + "K";
    return amount.toLocaleString(undefined, { maximumFractionDigits: 6 });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Swap Monitor</h1>
              <p className="text-xs text-muted-foreground">Solana Wallet Tracker</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        <Tabs defaultValue="monitor" className="w-full">
          <TabsList className={`grid w-full mb-6 gap-1 ${isAdmin ? 'grid-cols-5' : 'grid-cols-4'}`}>
            <TabsTrigger value="monitor" className="flex items-center gap-1 px-2 text-xs sm:text-sm sm:gap-2 sm:px-3" data-testid="tab-monitor">
              <Activity className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
              <span className="truncate">Monitor</span>
            </TabsTrigger>
            <TabsTrigger value="copy-trade" className="flex items-center gap-1 px-2 text-xs sm:text-sm sm:gap-2 sm:px-3" data-testid="tab-copy-trade">
              <Bot className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
              <span className="truncate">Copy</span>
            </TabsTrigger>
            <TabsTrigger value="insights" className="flex items-center gap-1 px-2 text-xs sm:text-sm sm:gap-2 sm:px-3" data-testid="tab-insights">
              <Brain className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
              <span className="truncate">Insights</span>
            </TabsTrigger>
            <TabsTrigger value="alerts" className="flex items-center gap-1 px-2 text-xs sm:text-sm sm:gap-2 sm:px-3 relative" data-testid="tab-alerts">
              <Bell className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
              <span className="truncate">Alerts</span>
              {unreadCount && unreadCount.count > 0 && (
                <span className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground text-xs rounded-full h-4 w-4 flex items-center justify-center font-medium">
                  {unreadCount.count > 9 ? "9+" : unreadCount.count}
                </span>
              )}
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="admin" className="flex items-center gap-1 px-2 text-xs sm:text-sm sm:gap-2 sm:px-3" data-testid="tab-admin">
                <Settings className="h-3 w-3 sm:h-4 sm:w-4 flex-shrink-0" />
                <span className="truncate">Admin</span>
              </TabsTrigger>
            )}
          </TabsList>
          
          <TabsContent value="monitor" className="space-y-6">
        {/* Wallet Card */}
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Wallet className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Monitoring Wallet</p>
                  <p className="font-mono text-sm break-all" data-testid="text-wallet-address">
                    {wallet?.address || "Loading..."}
                  </p>
                </div>
              </div>
              <a
                href={`https://solscan.io/account/${wallet?.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary text-sm flex items-center gap-1 hover:underline"
                data-testid="link-solscan"
              >
                View on Solscan <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </CardContent>
        </Card>

        {/* Status Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          {/* Monitoring Status */}
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Status
              </CardDescription>
            </CardHeader>
            <CardContent>
              {statusLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <Badge 
                    variant={status?.isActive ? "default" : "secondary"}
                    className="text-sm"
                    data-testid="badge-monitoring-status"
                  >
                    {status?.isActive ? "Active" : "Inactive"}
                  </Badge>
                  <Button
                    size="sm"
                    variant={status?.isActive ? "destructive" : "default"}
                    onClick={() => status?.isActive ? stopMonitoring.mutate() : startMonitoring.mutate()}
                    disabled={startMonitoring.isPending || stopMonitoring.isPending}
                    data-testid="button-toggle-monitoring"
                  >
                    {startMonitoring.isPending || stopMonitoring.isPending ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : status?.isActive ? (
                      <>
                        <Power className="h-4 w-4 mr-1" />
                        Stop
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-1" />
                        Start
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Total Swaps */}
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4" />
                Total Swaps
              </CardDescription>
            </CardHeader>
            <CardContent>
              {statusLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-2xl font-bold" data-testid="text-total-swaps">
                  {status?.totalSwapsDetected || 0}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Notifications */}
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Bell className="h-4 w-4" />
                Notifications
              </CardDescription>
            </CardHeader>
            <CardContent>
              {settingsLoading ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <Badge 
                    variant={settings?.enabled ? "default" : "secondary"}
                    data-testid="badge-notifications-status"
                  >
                    {settings?.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Switch
                    checked={settings?.enabled ?? true}
                    onCheckedChange={(enabled) => updateSettings.mutate({ enabled })}
                    data-testid="switch-notifications"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Settings Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Notification Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <Label>Email Recipients</Label>
              <div className="flex flex-wrap gap-2">
                {settings?.emails?.map((emailAddr) => (
                  <Badge 
                    key={emailAddr} 
                    variant="secondary" 
                    className="pl-3 pr-1 py-1 text-sm flex items-center gap-1"
                  >
                    {emailAddr}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 hover:bg-destructive/20"
                      onClick={() => handleRemoveEmail(emailAddr)}
                      data-testid={`button-remove-email-${emailAddr}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="Add email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
                  data-testid="input-new-email"
                  className="flex-1"
                />
                <Button 
                  onClick={handleAddEmail}
                  disabled={updateSettings.isPending || !newEmail}
                  data-testid="button-add-email"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>
            </div>
            <div className="space-y-2 pt-2">
              <Label htmlFor="minAmount">Min Swap Amount (optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="minAmount"
                  type="number"
                  placeholder={settings?.minSwapAmount?.toString() || "0"}
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value)}
                  data-testid="input-min-amount"
                  className="flex-1"
                />
                <Button 
                  onClick={handleSaveMinAmount}
                  disabled={updateSettings.isPending || !minAmount}
                  variant="outline"
                  data-testid="button-save-min-amount"
                >
                  Save
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Monitored Wallets */}
        <MonitoredWallets />

        {/* Community Wallets */}
        <CommunityWallets />

        {/* Swap History */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Swap History
            </CardTitle>
            <CardDescription>
              Real-time swap transactions from the monitored wallet
            </CardDescription>
          </CardHeader>
          <CardContent>
            {swapsLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : swaps && swaps.length > 0 ? (
              <div className="space-y-3">
                {swaps.map((swap) => (
                  <div
                    key={swap.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-muted/50 border"
                    data-testid={`swap-item-${swap.id}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="p-2 rounded-full bg-primary/10">
                        <ArrowRightLeft className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{formatAmount(swap.fromAmount)}</span>
                          <Badge variant="outline" className="font-mono text-xs">
                            {swap.fromTokenSymbol}
                          </Badge>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-medium">{formatAmount(swap.toAmount)}</span>
                          <Badge variant="outline" className="font-mono text-xs">
                            {swap.toTokenSymbol}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <span>{formatDate(swap.timestamp)}</span>
                          <span>•</span>
                          <span>{swap.source}</span>
                          {swap.notificationSent && (
                            <>
                              <span>•</span>
                              <span className="flex items-center gap-1 text-primary">
                                <Bell className="h-3 w-3" />
                                Notified
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyToClipboard(swap.toToken, "Token address")}
                        data-testid={`button-copy-token-${swap.id}`}
                        title="Copy token address"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <a
                        href={`https://solscan.io/tx/${swap.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary text-sm flex items-center gap-1 hover:underline"
                        data-testid={`link-tx-${swap.id}`}
                      >
                        View TX <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="p-4 rounded-full bg-muted/50 w-fit mx-auto mb-4">
                  <ArrowRightLeft className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="font-medium text-lg">No swaps detected yet</h3>
                <p className="text-muted-foreground text-sm mt-1">
                  {status?.isActive 
                    ? "Waiting for swap transactions..."
                    : "Start monitoring to detect swaps"}
                </p>
                {!status?.isActive && (
                  <Button 
                    className="mt-4" 
                    onClick={() => startMonitoring.mutate()}
                    disabled={startMonitoring.isPending}
                    data-testid="button-start-monitoring-empty"
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Start Monitoring
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
          </TabsContent>
          
          <TabsContent value="copy-trade">
            <CopyTrading />
          </TabsContent>

          <TabsContent value="insights">
            <AIInsights />
          </TabsContent>

          <TabsContent value="alerts">
            <Alerts />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="admin">
              <AdminDashboard />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
}
