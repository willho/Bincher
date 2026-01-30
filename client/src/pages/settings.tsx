import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ApiKeysSettings } from "@/components/api-keys-settings";
import { AdminDashboard } from "@/components/admin-dashboard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Key, Bell, User, Shield, Bot, Mail, CheckCircle, ExternalLink, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface SessionData {
  authenticated: boolean;
  username?: string;
  userId?: number;
  isAdmin?: boolean;
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

  const isAdmin = session?.isAdmin ?? false;
  const totalTabs = 3 + (isAdmin ? 1 : 0);

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
                    <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                      <li>Open Telegram and search for <strong>@MissPincherBot</strong></li>
                      <li>Send the command <code className="bg-muted px-1 rounded">/start</code></li>
                      <li>Send the verification code: <code className="bg-muted px-2 py-1 rounded font-mono">{telegramStatus?.linkToken || "Loading..."}</code></li>
                    </ol>
                    <Button variant="outline" size="sm" asChild>
                      <a href="https://t.me/MissPincherBot" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open Telegram
                      </a>
                    </Button>
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

        {isAdmin && (
          <TabsContent value="admin" className="mt-6">
            <AdminDashboard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
