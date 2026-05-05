import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ApiKeysSettings } from "@/components/api-keys-settings";
import { AdminDashboard } from "@/components/admin-dashboard";
import { SecuritySettings } from "@/components/security-settings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Key, Bell, User, Shield, Bot, Mail, CheckCircle, ExternalLink, Loader2, Lock, Ban, Plus, Trash2, TrendingUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface SessionData {
  authenticated: boolean;
  username?: string;
  userId?: number;
  isAdmin?: boolean;
}

interface BlacklistEntry {
  id: number;
  tokenMint: string;
  tokenSymbol: string | null;
  reason: string | null;
  createdAt: string;
}

interface TelegramStatus {
  linked: boolean;
  chatId?: string;
  linkedAt?: number;
  linkToken?: string;
}

interface UserSettings {
  emailProvider?: string;
  emailFromAddress?: string;
  telegramLinked?: boolean;
}

export default function SettingsPage() {
  const { toast } = useToast();
  const { data: session } = useQuery<SessionData>({
    queryKey: ["/api/auth/session"],
  });

  const { data: telegramStatus } = useQuery<TelegramStatus>({
    queryKey: ["/api/telegram/status"],
  });

  const { data: emailSettings } = useQuery<{
    emailProvider: string | null;
    emailFromAddress: string | null;
    hasApiKey: boolean;
  }>({
    queryKey: ["/api/settings/email-provider"],
  });

  // Email provider state
  const [emailProvider, setEmailProvider] = useState<"resend" | "sendgrid" | "mailgun" | "smtp">("resend");
  const [emailApiKey, setEmailApiKey] = useState("");
  const [emailFromAddress, setEmailFromAddress] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");

  // Prefill form with existing settings
  useEffect(() => {
    if (emailSettings) {
      if (emailSettings.emailProvider) {
        setEmailProvider(emailSettings.emailProvider as typeof emailProvider);
      }
      if (emailSettings.emailFromAddress) {
        setEmailFromAddress(emailSettings.emailFromAddress);
      }
    }
  }, [emailSettings]);

  const saveEmailMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/settings/email-provider", {
      emailProvider,
      emailApiKey,
      emailFromAddress,
      smtpConfig: emailProvider === "smtp" ? {
        host: smtpHost,
        port: parseInt(smtpPort) || 587,
        user: smtpUser,
        pass: smtpPass
      } : undefined
    }),
    onSuccess: () => {
      toast({ title: "Email settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/email-provider"] });
    },
    onError: () => {
      toast({ title: "Failed to save email settings", variant: "destructive" });
    }
  });

  // Token Blacklist state and queries
  const [newBlacklistToken, setNewBlacklistToken] = useState("");
  const [newBlacklistReason, setNewBlacklistReason] = useState("");

  const { data: blacklist = [], isLoading: isLoadingBlacklist } = useQuery<BlacklistEntry[]>({
    queryKey: ["/api/blacklist"],
  });

  const addToBlacklistMutation = useMutation({
    mutationFn: (data: { tokenMint: string; reason?: string }) =>
      apiRequest("POST", "/api/blacklist", data),
    onSuccess: () => {
      toast({ title: "Token added to blacklist" });
      queryClient.invalidateQueries({ queryKey: ["/api/blacklist"] });
      setNewBlacklistToken("");
      setNewBlacklistReason("");
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to add to blacklist", variant: "destructive" });
    },
  });

  const removeFromBlacklistMutation = useMutation({
    mutationFn: (tokenMint: string) =>
      apiRequest("DELETE", `/api/blacklist/${encodeURIComponent(tokenMint)}`),
    onSuccess: () => {
      toast({ title: "Token removed from blacklist" });
      queryClient.invalidateQueries({ queryKey: ["/api/blacklist"] });
    },
    onError: () => {
      toast({ title: "Failed to remove from blacklist", variant: "destructive" });
    },
  });

  const isAdmin = session?.isAdmin ?? false;
  const totalTabs = 5 + (isAdmin ? 1 : 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="api-keys" className="w-full">
        {/* Tabs scroll horizontally on narrow shells (480px) */}
        <div className="overflow-x-auto -mx-0.5 px-0.5 pb-0.5">
          <TabsList className="flex w-max min-w-full" data-testid="tabs-list-settings">
            <TabsTrigger value="api-keys" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-api-keys">
              <Key className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Keys</span>
            </TabsTrigger>
            <TabsTrigger value="notifications" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-notifications">
              <Bell className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Alerts</span>
            </TabsTrigger>
            <TabsTrigger value="account" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-account">
              <User className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Account</span>
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-security">
              <Lock className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Security</span>
            </TabsTrigger>
            <TabsTrigger value="trading" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-trading">
              <TrendingUp className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Trading</span>
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="admin" className="flex items-center gap-1.5 flex-1 min-w-[60px]" data-testid="tab-admin">
                <Shield className="h-4 w-4 flex-shrink-0" />
                <span className="text-xs">Admin</span>
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="api-keys" className="mt-6">
          <ApiKeysSettings />
        </TabsContent>

        <TabsContent value="notifications" className="mt-6">
          <div className="space-y-6">
            {/* Telegram Section */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Bot className="h-5 w-5" />
                      Telegram
                      <Badge variant="secondary" className="text-xs">Recommended</Badge>
                    </CardTitle>
                    <CardDescription>Get instant push alerts and chat with Miss Pincher</CardDescription>
                  </div>
                  {telegramStatus?.linked && (
                    <Badge variant="default" className="flex items-center gap-1">
                      <CheckCircle className="h-3 w-3" />
                      Connected
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {telegramStatus?.linked ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Connected since {new Date((telegramStatus.linkedAt || 0) * 1000).toLocaleDateString()}
                    </p>
                    <p className="text-sm">
                      You'll receive alerts for swaps, price targets, and can chat with Penny directly in Telegram.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Click the button below to open Telegram and connect your account automatically.
                    </p>
                    {telegramStatus?.linkToken ? (
                      <Button variant="outline" size="sm" asChild data-testid="button-connect-telegram">
                        <a href={`https://t.me/MissPincherBot?start=${telegramStatus.linkToken}`} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4 mr-2" />
                          Connect via Telegram
                        </a>
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled data-testid="button-connect-telegram-loading">
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading link...
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Or manually send <code className="bg-muted px-1 rounded">/start {telegramStatus?.linkToken || "..."}</code> to @MissPincherBot
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Email Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5" />
                  Email Alerts
                </CardTitle>
                <CardDescription>Provide your own email service credentials for email notifications</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-sm">Email Provider</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(["resend", "sendgrid", "mailgun", "smtp"] as const).map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => setEmailProvider(provider)}
                        className={`p-2 rounded border text-sm capitalize transition-all ${
                          emailProvider === provider
                            ? "border-primary bg-primary/10"
                            : "border-muted hover-elevate"
                        }`}
                        data-testid={`button-provider-${provider}`}
                      >
                        {provider === "smtp" ? "SMTP" : provider}
                      </button>
                    ))}
                  </div>
                </div>

                {emailProvider !== "smtp" ? (
                  <div className="space-y-2">
                    <Label htmlFor="email-api-key">API Key</Label>
                    <Input
                      id="email-api-key"
                      type="password"
                      placeholder={`Your ${emailProvider} API key`}
                      value={emailApiKey}
                      onChange={(e) => setEmailApiKey(e.target.value)}
                      data-testid="input-email-api-key"
                    />
                    <p className="text-xs text-muted-foreground">
                      Get a free API key at{" "}
                      <a 
                        href={emailProvider === "resend" ? "https://resend.com" : emailProvider === "sendgrid" ? "https://sendgrid.com" : "https://mailgun.com"} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {emailProvider}.com
                      </a>
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="smtp-host" className="text-xs">SMTP Host</Label>
                        <Input
                          id="smtp-host"
                          placeholder="smtp.example.com"
                          value={smtpHost}
                          onChange={(e) => setSmtpHost(e.target.value)}
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="smtp-port" className="text-xs">Port</Label>
                        <Input
                          id="smtp-port"
                          placeholder="587"
                          value={smtpPort}
                          onChange={(e) => setSmtpPort(e.target.value)}
                          className="h-8"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="smtp-user" className="text-xs">Username</Label>
                      <Input
                        id="smtp-user"
                        placeholder="username"
                        value={smtpUser}
                        onChange={(e) => setSmtpUser(e.target.value)}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="smtp-pass" className="text-xs">Password</Label>
                      <Input
                        id="smtp-pass"
                        type="password"
                        placeholder="password"
                        value={smtpPass}
                        onChange={(e) => setSmtpPass(e.target.value)}
                        className="h-8"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="email-from">From Address</Label>
                  <Input
                    id="email-from"
                    type="email"
                    placeholder="alerts@yourdomain.com"
                    value={emailFromAddress}
                    onChange={(e) => setEmailFromAddress(e.target.value)}
                    data-testid="input-email-from"
                  />
                </div>

                <Button 
                  onClick={() => saveEmailMutation.mutate()}
                  disabled={saveEmailMutation.isPending || (!emailApiKey && emailProvider !== "smtp")}
                  data-testid="button-save-email"
                >
                  {saveEmailMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Email Settings
                </Button>
              </CardContent>
            </Card>
          </div>
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

        <TabsContent value="security" className="mt-6">
          <SecuritySettings />
        </TabsContent>

        <TabsContent value="trading" className="mt-6">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Ban className="h-5 w-5" />
                  Token Blacklist
                </CardTitle>
                <CardDescription>
                  Blacklisted tokens will be skipped during copy trading. Use this to block scams or tokens you don't want to buy.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2 items-end">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="blacklist-token" className="text-xs">Token Mint Address</Label>
                    <Input
                      id="blacklist-token"
                      placeholder="Token mint address..."
                      value={newBlacklistToken}
                      onChange={(e) => setNewBlacklistToken(e.target.value)}
                      data-testid="input-blacklist-token"
                    />
                  </div>
                  <div className="w-32 space-y-1">
                    <Label htmlFor="blacklist-reason" className="text-xs">Reason (optional)</Label>
                    <Input
                      id="blacklist-reason"
                      placeholder="Scam, rug..."
                      value={newBlacklistReason}
                      onChange={(e) => setNewBlacklistReason(e.target.value)}
                      data-testid="input-blacklist-reason"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => addToBlacklistMutation.mutate({ 
                      tokenMint: newBlacklistToken.trim(), 
                      reason: newBlacklistReason.trim() || undefined 
                    })}
                    disabled={!newBlacklistToken.trim() || addToBlacklistMutation.isPending}
                    data-testid="button-add-blacklist"
                  >
                    {addToBlacklistMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                  </Button>
                </div>

                {isLoadingBlacklist ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : blacklist.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No tokens blacklisted yet
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {blacklist.map((entry) => (
                      <div 
                        key={entry.id}
                        className="flex items-center justify-between p-2 rounded-lg border bg-muted/50"
                        data-testid={`blacklist-entry-${entry.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-mono truncate">
                            {entry.tokenSymbol ? (
                              <span className="font-medium">{entry.tokenSymbol}</span>
                            ) : null}
                            <span className="text-muted-foreground ml-2">
                              {entry.tokenMint.slice(0, 8)}...{entry.tokenMint.slice(-8)}
                            </span>
                          </p>
                          {entry.reason && (
                            <p className="text-xs text-muted-foreground">{entry.reason}</p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeFromBlacklistMutation.mutate(entry.tokenMint)}
                          disabled={removeFromBlacklistMutation.isPending}
                          data-testid={`button-remove-blacklist-${entry.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
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
