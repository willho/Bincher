import { useQuery, useMutation } from "@tanstack/react-query";
import { ApiKeysSettings } from "@/components/api-keys-settings";
import { AdminDashboard } from "@/components/admin-dashboard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Key, Bell, User, Shield, TrendingUp, Bot, AlertTriangle, CheckCircle } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface SessionData {
  authenticated: boolean;
  username?: string;
  userId?: number;
  isAdmin?: boolean;
}

interface SwingSettings {
  enabled: boolean;
  detectSupportResistance: boolean;
  detectVolumeSpikes: boolean;
  detectOhlcPatterns: boolean;
  autoEntry: boolean;
  minTokenScore: number;
  swingPositionSizeUsd: number;
  maxSwingPositions: number;
}

interface AutonomousSettings {
  enabled: boolean;
  riskProfile: string;
  dailyLossLimitUsd: number;
  maxDrawdownPercent: number;
  maxLossStreak: number;
  maxTradesPerDay: number;
  minBalanceSol: number;
}

interface AutonomousStatus {
  enabled: boolean;
  riskProfile: string;
  todayLossUsd: number;
  todayWinUsd: number;
  todayTradeCount: number;
  stoppedReason: string | null;
  canTrade: { allowed: boolean; reason?: string };
}

export default function SettingsPage() {
  const { toast } = useToast();
  
  const { data: session } = useQuery<SessionData>({
    queryKey: ["/api/auth/session"],
  });
  
  const { data: swingData } = useQuery<{ settings: SwingSettings | null }>({
    queryKey: ["/api/swing/settings"],
  });
  
  const { data: autonomousStatus } = useQuery<AutonomousStatus>({
    queryKey: ["/api/autonomous/status"],
    refetchInterval: 30000,
  });
  
  const { data: riskProfiles } = useQuery<{ profiles: { name: string; description: string }[] }>({
    queryKey: ["/api/autonomous/profiles"],
  });

  const updateSwingMutation = useMutation({
    mutationFn: async (settings: Partial<SwingSettings>) => {
      return await apiRequest("POST", "/api/swing/settings", settings);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/swing/settings"] });
      toast({ title: "Swing settings updated" });
    },
  });
  
  const applyProfileMutation = useMutation({
    mutationFn: async (profile: string) => {
      return await apiRequest("POST", "/api/autonomous/apply-profile", { profile });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/autonomous/status"] });
      toast({ title: "Risk profile applied" });
    },
  });
  
  const toggleAutonomousMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      const endpoint = enable ? "/api/autonomous/enable" : "/api/autonomous/disable";
      return await apiRequest("POST", endpoint, { acknowledged: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/autonomous/status"] });
      toast({ title: "Autonomous mode updated" });
    },
  });

  const isAdmin = session?.isAdmin ?? false;
  const swingSettings = swingData?.settings;
  const totalTabs = 5 + (isAdmin ? 1 : 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="api-keys" className="w-full">
        <TabsList className={`grid w-full`} style={{ gridTemplateColumns: `repeat(${totalTabs}, minmax(0, 1fr))` }}>
          <TabsTrigger value="api-keys" className="flex items-center gap-2" data-testid="tab-api-keys">
            <Key className="h-4 w-4" />
            <span className="hidden sm:inline">API Keys</span>
          </TabsTrigger>
          <TabsTrigger value="swing" className="flex items-center gap-2" data-testid="tab-swing">
            <TrendingUp className="h-4 w-4" />
            <span className="hidden sm:inline">Swing</span>
          </TabsTrigger>
          <TabsTrigger value="autonomous" className="flex items-center gap-2" data-testid="tab-autonomous">
            <Bot className="h-4 w-4" />
            <span className="hidden sm:inline">Auto</span>
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex items-center gap-2" data-testid="tab-notifications">
            <Bell className="h-4 w-4" />
            <span className="hidden sm:inline">Alerts</span>
          </TabsTrigger>
          <TabsTrigger value="account" className="flex items-center gap-2" data-testid="tab-account">
            <User className="h-4 w-4" />
            <span className="hidden sm:inline">Account</span>
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="admin" className="flex items-center gap-2" data-testid="tab-admin">
              <Shield className="h-4 w-4" />
              <span className="hidden sm:inline">Admin</span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="api-keys" className="mt-6">
          <ApiKeysSettings />
        </TabsContent>

        <TabsContent value="swing" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Swing Trading
              </CardTitle>
              <CardDescription>Configure pattern detection and automated swing trades</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>Enable Swing Trading</Label>
                  <p className="text-sm text-muted-foreground">Detect patterns and trading opportunities</p>
                </div>
                <Switch
                  checked={swingSettings?.enabled ?? false}
                  onCheckedChange={(checked) => updateSwingMutation.mutate({ enabled: checked })}
                  data-testid="switch-swing-enabled"
                />
              </div>
              
              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium">Detection Settings</h4>
                <div className="flex items-center justify-between gap-4">
                  <Label>Support/Resistance Detection</Label>
                  <Switch
                    checked={swingSettings?.detectSupportResistance ?? true}
                    onCheckedChange={(checked) => updateSwingMutation.mutate({ detectSupportResistance: checked })}
                    disabled={!swingSettings?.enabled}
                    data-testid="switch-detect-support-resistance"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Label>Volume Spike Detection</Label>
                  <Switch
                    checked={swingSettings?.detectVolumeSpikes ?? true}
                    onCheckedChange={(checked) => updateSwingMutation.mutate({ detectVolumeSpikes: checked })}
                    disabled={!swingSettings?.enabled}
                    data-testid="switch-detect-volume-spikes"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Label>OHLC Pattern Detection</Label>
                  <Switch
                    checked={swingSettings?.detectOhlcPatterns ?? true}
                    onCheckedChange={(checked) => updateSwingMutation.mutate({ detectOhlcPatterns: checked })}
                    disabled={!swingSettings?.enabled}
                    data-testid="switch-detect-ohlc-patterns"
                  />
                </div>
              </div>
              
              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium">Auto-Entry (Advanced)</h4>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label>Automatic Entry</Label>
                    <p className="text-sm text-muted-foreground">Automatically enter swing positions</p>
                  </div>
                  <Switch
                    checked={swingSettings?.autoEntry ?? false}
                    onCheckedChange={(checked) => updateSwingMutation.mutate({ autoEntry: checked })}
                    disabled={!swingSettings?.enabled}
                    data-testid="switch-auto-entry"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="autonomous" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                Autonomous Mode
                {autonomousStatus?.enabled ? (
                  <Badge variant="default" className="ml-2" data-testid="badge-autonomous-active">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Active
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="ml-2" data-testid="badge-autonomous-disabled">Disabled</Badge>
                )}
              </CardTitle>
              <CardDescription>Let Miss Pincher trade with defined risk limits</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {autonomousStatus?.stoppedReason && (
                <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span className="text-sm">Trading stopped: {autonomousStatus.stoppedReason}</span>
                </div>
              )}
              
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>Enable Autonomous Trading</Label>
                  <p className="text-sm text-muted-foreground">Allow Miss Pincher to execute trades automatically</p>
                </div>
                <Switch
                  checked={autonomousStatus?.enabled ?? false}
                  onCheckedChange={(checked) => toggleAutonomousMutation.mutate(checked)}
                  data-testid="switch-autonomous-enabled"
                />
              </div>
              
              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-medium">Risk Profile</h4>
                <Select
                  value={autonomousStatus?.riskProfile || "balanced"}
                  onValueChange={(value) => applyProfileMutation.mutate(value)}
                >
                  <SelectTrigger data-testid="select-risk-profile">
                    <SelectValue placeholder="Select risk profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {riskProfiles?.profiles?.map((profile) => (
                      <SelectItem key={profile.name} value={profile.name} data-testid={`select-item-profile-${profile.name}`}>
                        <div className="flex flex-col">
                          <span className="capitalize">{profile.name}</span>
                          <span className="text-xs text-muted-foreground">{profile.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {autonomousStatus && (
                <div className="space-y-2 pt-4 border-t">
                  <h4 className="font-medium">Today's Activity</h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-lg font-bold text-green-500">${autonomousStatus.todayWinUsd?.toFixed(2) || "0.00"}</p>
                      <p className="text-xs text-muted-foreground">Wins</p>
                    </div>
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-lg font-bold text-red-500">${autonomousStatus.todayLossUsd?.toFixed(2) || "0.00"}</p>
                      <p className="text-xs text-muted-foreground">Losses</p>
                    </div>
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-lg font-bold">{autonomousStatus.todayTradeCount || 0}</p>
                      <p className="text-xs text-muted-foreground">Trades</p>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Notification Preferences</CardTitle>
              <CardDescription>Configure how you receive alerts</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">Notification settings coming soon...</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="account" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Account Settings</CardTitle>
              <CardDescription>Manage your account details</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Username</p>
                  <p className="font-medium" data-testid="text-username">{session?.username || "Unknown"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="admin" className="mt-6">
            <AdminDashboard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
