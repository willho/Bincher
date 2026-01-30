import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Lock, User, Mail, ArrowLeft, Key, Wallet, Shield, CheckCircle, Settings, Sparkles, AlertCircle, XCircle, Database, Bot, Send, Cpu, Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface LoginProps {
  onLoginSuccess: () => void;
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [heliusApiKey, setHeliusApiKey] = useState("");
  const [cashoutWallet, setCashoutWallet] = useState("");
  const [adminCodeword, setAdminCodeword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [isSignUpMode, setIsSignUpMode] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [healthChecks, setHealthChecks] = useState<{
    helius: { ok: boolean; message: string };
    database: { ok: boolean; message: string };
    telegram: { ok: boolean; message: string };
    email: { ok: boolean; message: string };
    ai: { ok: boolean; message: string };
  } | null>(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [healthCheckError, setHealthCheckError] = useState(false);
  const [selectedNetwork, setSelectedNetwork] = useState<"mainnet" | "devnet">("devnet");
  // Alert preferences for wizard step 2
  const [alertMethod, setAlertMethod] = useState<"telegram" | "email" | "skip">("telegram");
  const [telegramLinkToken, setTelegramLinkToken] = useState("");
  const [emailProvider, setEmailProvider] = useState<"resend" | "sendgrid" | "mailgun" | "smtp">("resend");
  const [emailApiKey, setEmailApiKey] = useState("");
  const [emailFromAddress, setEmailFromAddress] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");

  const { data: needsSetup, isLoading: checkingSetup } = useQuery<{ needsSetup: boolean }>({
    queryKey: ["/api/auth/check-setup"],
  });

  const requestReset = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/request-reset", { email: resetEmail }),
    onSuccess: () => {
      setResetSent(true);
    },
    onError: () => {
      // Still show success to prevent email enumeration
      setResetSent(true);
    },
  });

  const login = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/login", { username, password, rememberMe }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
      onLoginSuccess();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Login failed", variant: "destructive" });
    },
  });

  const register = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/register", { 
      username, 
      password, 
      recoveryEmail: recoveryEmail || undefined,
      heliusApiKey,
      cashoutWallet: cashoutWallet || undefined,
      adminCodeword: needsSetup?.needsSetup ? adminCodeword : undefined
    }),
    onSuccess: async (data: any) => {
      if (data.showWizard) {
        setShowWizard(true);
        setWizardStep(0); // Step 0 = network selection
      } else {
        login.mutate();
      }
    },
    onError: (error: any) => {
      toast({ description: error.message || "Registration failed", variant: "destructive" });
    },
  });

  const isSetup = needsSetup?.needsSetup || isSignUpMode;
  const isPending = login.isPending || register.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isSetup) {
      if (password !== confirmPassword) {
        toast({ description: "Passwords do not match", variant: "destructive" });
        return;
      }
      if (password.length < 8) {
        toast({ description: "Password must be at least 8 characters", variant: "destructive" });
        return;
      }
      if (!heliusApiKey.trim()) {
        toast({ description: "Helius API key is required", variant: "destructive" });
        return;
      }
      register.mutate();
    } else {
      login.mutate();
    }
  };

  if (checkingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>
            {needsSetup?.needsSetup ? "First-Time Setup" : isSetup ? "Create Account" : "Welcome Back"}
          </CardTitle>
          <CardDescription>
            {needsSetup?.needsSetup
              ? "Set up the admin account to get started with Penny Pincher"
              : isSetup 
                ? "Set up your credentials to secure your wallet monitor"
                : "Sign in to access your wallet monitor"
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete={isSetup ? "off" : "on"}>
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="username"
                  type="text"
                  placeholder="Enter username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="pl-10"
                  required
                  autoComplete={isSetup ? "off" : "username"}
                  data-testid="input-username"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10"
                  required
                  autoComplete={isSetup ? "new-password" : "current-password"}
                  data-testid="input-password"
                />
              </div>
            </div>

            {isSetup && (
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-10"
                    required
                    autoComplete="new-password"
                    data-testid="input-confirm-password"
                  />
                </div>
              </div>
            )}

            {isSetup && (
              <div className="space-y-2">
                <Label htmlFor="recovery-email">Recovery Email (Optional)</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="recovery-email"
                    type="email"
                    placeholder="your@email.com"
                    value={recoveryEmail}
                    onChange={(e) => setRecoveryEmail(e.target.value)}
                    className="pl-10"
                    data-testid="input-recovery-email"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  For password recovery and important alerts
                </p>
              </div>
            )}

            {isSetup && (
              <div className="space-y-2">
                <Label htmlFor="helius-api-key">Helius API Key</Label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="helius-api-key"
                    type="password"
                    placeholder="Enter your Helius API key"
                    value={heliusApiKey}
                    onChange={(e) => setHeliusApiKey(e.target.value)}
                    className="pl-10"
                    required
                    data-testid="input-helius-api-key"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your free API key at{" "}
                  <a 
                    href="https://helius.dev" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    helius.dev
                  </a>
                </p>
              </div>
            )}

            {isSetup && (
              <div className="space-y-2">
                <Label htmlFor="cashout-wallet">Default Cashout Wallet (Optional)</Label>
                <div className="relative">
                  <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="cashout-wallet"
                    type="text"
                    placeholder="Your Solana wallet address"
                    value={cashoutWallet}
                    onChange={(e) => setCashoutWallet(e.target.value)}
                    className="pl-10"
                    data-testid="input-cashout-wallet"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Profits will be sent here when you cash out
                </p>
              </div>
            )}

            {needsSetup?.needsSetup && (
              <div className="space-y-2 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <Label htmlFor="admin-codeword" className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
                  Admin Codeword (First User Setup)
                </Label>
                <Input
                  id="admin-codeword"
                  type="password"
                  placeholder="Enter the admin codeword"
                  value={adminCodeword}
                  onChange={(e) => setAdminCodeword(e.target.value)}
                  required
                  data-testid="input-admin-codeword"
                />
                <p className="text-xs text-muted-foreground">
                  The first user becomes the admin. Enter the codeword provided by the app owner.
                </p>
              </div>
            )}

            {!isSetup && (
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="remember"
                    checked={rememberMe}
                    onCheckedChange={(checked) => setRememberMe(checked === true)}
                    data-testid="checkbox-remember-me"
                  />
                  <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                    Remember this device (30 days)
                  </Label>
                </div>
              </div>
            )}

            <Button 
              type="submit" 
              className="w-full" 
              disabled={isPending}
              data-testid="button-submit-login"
            >
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isSetup ? "Create Account" : "Sign In"}
            </Button>

            {!isSetup && (
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    setForgotPasswordOpen(true);
                    setResetSent(false);
                    setResetEmail("");
                  }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                  data-testid="link-forgot-password"
                >
                  Forgot password?
                </button>
              </div>
            )}

            {!needsSetup?.needsSetup && (
              <div className="text-center pt-2 border-t">
                {isSignUpMode ? (
                  <p className="text-sm text-muted-foreground">
                    Already have an account?{" "}
                    <button
                      type="button"
                      onClick={() => setIsSignUpMode(false)}
                      className="text-primary hover:underline font-medium"
                      data-testid="link-switch-to-login"
                    >
                      Sign in
                    </button>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Don't have an account?{" "}
                    <button
                      type="button"
                      onClick={() => setIsSignUpMode(true)}
                      className="text-primary hover:underline font-medium"
                      data-testid="link-switch-to-signup"
                    >
                      Sign up
                    </button>
                  </p>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <Dialog open={forgotPasswordOpen} onOpenChange={setForgotPasswordOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{resetSent ? "Check Your Email" : "Reset Password"}</DialogTitle>
            <DialogDescription>
              {resetSent 
                ? "If an account with that email exists, we've sent a password reset link."
                : "Enter your recovery email to receive a password reset link."
              }
            </DialogDescription>
          </DialogHeader>
          
          {resetSent ? (
            <div className="space-y-4">
              <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 text-center">
                <Mail className="h-12 w-12 mx-auto text-primary mb-3" />
                <p className="text-sm text-muted-foreground">
                  Check your inbox and spam folder for the reset link. The link expires in 15 minutes.
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setForgotPasswordOpen(false);
                  setResetSent(false);
                }}
                data-testid="button-back-to-login"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Login
              </Button>
            </div>
          ) : (
            <form onSubmit={(e) => {
              e.preventDefault();
              requestReset.mutate();
            }} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-email">Recovery Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="Enter your recovery email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    className="pl-10"
                    required
                    data-testid="input-reset-email"
                  />
                </div>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={requestReset.isPending || !resetEmail}
                data-testid="button-send-reset-link"
              >
                {requestReset.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Send Reset Link
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showWizard} onOpenChange={setShowWizard}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Welcome, Admin!
            </DialogTitle>
            <DialogDescription>
              {wizardStep === 0 ? "Choose your network environment to get started." : wizardStep === 1 ? "System checks complete. Here's your setup status." : "Set up notifications to stay informed."}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            {wizardStep === 0 && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Account Created</p>
                    <p className="text-sm text-muted-foreground">You're now the admin with full access</p>
                  </div>
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-medium">Select Network</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setSelectedNetwork("devnet")}
                      className={`p-4 rounded-lg border-2 text-left transition-all ${
                        selectedNetwork === "devnet"
                          ? "border-primary bg-primary/10"
                          : "border-muted hover-elevate"
                      }`}
                      data-testid="button-select-devnet"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`w-3 h-3 rounded-full ${selectedNetwork === "devnet" ? "bg-primary" : "bg-muted-foreground/30"}`} />
                        <span className="font-medium">Devnet</span>
                      </div>
                      <p className="text-xs text-muted-foreground">Test with fake SOL. Recommended for setup.</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedNetwork("mainnet")}
                      className={`p-4 rounded-lg border-2 text-left transition-all ${
                        selectedNetwork === "mainnet"
                          ? "border-primary bg-primary/10"
                          : "border-muted hover-elevate"
                      }`}
                      data-testid="button-select-mainnet"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`w-3 h-3 rounded-full ${selectedNetwork === "mainnet" ? "bg-primary" : "bg-muted-foreground/30"}`} />
                        <span className="font-medium">Mainnet</span>
                      </div>
                      <p className="text-xs text-muted-foreground">Real trading with real SOL.</p>
                    </button>
                  </div>
                  {selectedNetwork === "devnet" && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      You can switch to mainnet later in Settings.
                    </p>
                  )}
                </div>

                <Button
                  className="w-full"
                  onClick={async () => {
                    setWizardStep(1);
                    setHealthCheckLoading(true);
                    setHealthCheckError(false);
                    try {
                      await fetch('/api/admin/network-mode', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ mode: selectedNetwork })
                      });
                      const response = await fetch('/api/health-check', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ heliusApiKey, networkMode: selectedNetwork })
                      });
                      if (response.ok) {
                        const results = await response.json();
                        setHealthChecks(results);
                      } else {
                        setHealthCheckError(true);
                      }
                    } catch (e) {
                      console.error('Setup failed:', e);
                      setHealthCheckError(true);
                    } finally {
                      setHealthCheckLoading(false);
                    }
                  }}
                  data-testid="button-continue-setup"
                >
                  Continue Setup
                </Button>
              </div>
            )}

            {wizardStep === 1 && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Network: {selectedNetwork === "devnet" ? "Devnet (Testing)" : "Mainnet (Live)"}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedNetwork === "devnet" ? "Using test SOL for development" : "Real trading environment"}
                    </p>
                  </div>
                </div>

                {healthCheckLoading && (
                  <div className="flex items-center justify-center p-6">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <p className="text-sm text-muted-foreground">Running system checks...</p>
                    </div>
                  </div>
                )}

                {!healthCheckLoading && healthCheckError && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                    <AlertCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium text-destructive">Health Check Failed</p>
                      <p className="text-sm text-muted-foreground">
                        Could not verify system status. You can continue anyway or retry.
                      </p>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="mt-2"
                        onClick={async () => {
                          setHealthCheckLoading(true);
                          setHealthCheckError(false);
                          try {
                            const response = await fetch('/api/health-check', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ heliusApiKey })
                            });
                            if (response.ok) {
                              const results = await response.json();
                              setHealthChecks(results);
                            } else {
                              setHealthCheckError(true);
                            }
                          } catch {
                            setHealthCheckError(true);
                          } finally {
                            setHealthCheckLoading(false);
                          }
                        }}
                        data-testid="button-retry-health-check"
                      >
                        Retry Check
                      </Button>
                    </div>
                  </div>
                )}

                {!healthCheckLoading && healthChecks && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">System Status</p>
                    
                    <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                      {healthChecks.helius.ok ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive shrink-0" />
                      )}
                      <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Helius API</p>
                        <p className="text-xs text-muted-foreground">{healthChecks.helius.message}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                      {healthChecks.database.ok ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive shrink-0" />
                      )}
                      <Database className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Database</p>
                        <p className="text-xs text-muted-foreground">{healthChecks.database.message}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                      {healthChecks.ai.ok ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
                      )}
                      <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Miss Pincher AI</p>
                        <p className="text-xs text-muted-foreground">{healthChecks.ai.message}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                      {healthChecks.telegram.ok ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
                      )}
                      <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Telegram Bot</p>
                        <p className="text-xs text-muted-foreground">{healthChecks.telegram.message}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                      {healthChecks.email.ok ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
                      )}
                      <Send className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Email (Resend)</p>
                        <p className="text-xs text-muted-foreground">{healthChecks.email.message}</p>
                      </div>
                    </div>
                  </div>
                )}

                {!healthCheckLoading && healthChecks && (!healthChecks.helius.ok || !healthChecks.database.ok) && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                    <XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-destructive">Critical Issues Detected</p>
                      <p className="text-sm text-muted-foreground">
                        Some required services aren't working. Check your configuration.
                      </p>
                    </div>
                  </div>
                )}

                {!healthCheckLoading && (healthChecks || healthCheckError) && (
                  <div className="flex items-start gap-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
                    <Settings className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium">Next Steps</p>
                      <ul className="text-sm text-muted-foreground mt-1 space-y-1 list-disc list-inside">
                        {healthChecks && !healthChecks.helius.ok && (
                          <li className="text-destructive">Fix <strong>Helius API key</strong> in Settings - required for wallet monitoring</li>
                        )}
                        {healthChecks && !healthChecks.database.ok && (
                          <li className="text-destructive">Check <strong>database connection</strong> - required for app to function</li>
                        )}
                        {healthChecks && !healthChecks.ai.ok && (
                          <li>Configure <strong>AI integration</strong> for Miss Pincher chat features</li>
                        )}
                        {healthChecks && !healthChecks.telegram.ok && (
                          <li>Add <strong>TELEGRAM_BOT_TOKEN</strong> secret for notifications</li>
                        )}
                        {healthChecks && !healthChecks.email.ok && (
                          <li>Add <strong>RESEND_API_KEY</strong> secret for email notifications</li>
                        )}
                        {selectedNetwork === "devnet" && (
                          <li>
                            Get test SOL from <a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">Solana Faucet</a>
                          </li>
                        )}
                        <li>Use <strong>Production Setup</strong> in Admin tab to sync webhooks</li>
                        <li>Add wallets to monitor in the <strong>Watchlist</strong></li>
                      </ul>
                    </div>
                  </div>
                )}

                <Button 
                  className="w-full" 
                  onClick={() => setWizardStep(2)}
                  disabled={healthCheckLoading}
                  data-testid="button-continue-alerts"
                >
                  {healthCheckLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    "Continue to Alerts Setup"
                  )}
                </Button>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <Bell className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Stay Connected</p>
                    <p className="text-sm text-muted-foreground">
                      Get instant alerts when signal wallets swap, price targets hit, or when Penny has insights
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={() => setAlertMethod("telegram")}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                      alertMethod === "telegram"
                        ? "border-primary bg-primary/10"
                        : "border-muted hover-elevate"
                    }`}
                    data-testid="button-select-telegram"
                  >
                    <div className="flex items-center gap-3">
                      <Bot className="h-5 w-5 text-primary" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">Telegram</span>
                          <Badge variant="secondary" className="text-xs">Recommended</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Instant push notifications + chat with Miss Pincher directly
                        </p>
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAlertMethod("email")}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                      alertMethod === "email"
                        ? "border-primary bg-primary/10"
                        : "border-muted hover-elevate"
                    }`}
                    data-testid="button-select-email"
                  >
                    <div className="flex items-center gap-3">
                      <Mail className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1">
                        <span className="font-medium">Email</span>
                        <p className="text-xs text-muted-foreground mt-1">
                          Provide your own email API key (Resend, SendGrid, Mailgun, or SMTP)
                        </p>
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAlertMethod("skip")}
                    className={`w-full p-3 rounded-lg border-2 text-left transition-all ${
                      alertMethod === "skip"
                        ? "border-muted-foreground/50 bg-muted/30"
                        : "border-muted hover-elevate"
                    }`}
                    data-testid="button-select-skip-alerts"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <span className="text-sm text-muted-foreground">Skip for now</span>
                        <p className="text-xs text-muted-foreground">You can set this up later in Settings</p>
                      </div>
                    </div>
                  </button>
                </div>

                {alertMethod === "telegram" && (
                  <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                    <p className="text-sm font-medium">Connect to Telegram</p>
                    <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                      <li>Open Telegram and search for <strong>@PennyPincherBot</strong></li>
                      <li>Send the command <code className="bg-muted px-1 rounded">/start</code></li>
                      <li>You'll receive a verification code - enter it in Settings after login</li>
                    </ol>
                    <div className="flex items-start gap-2 p-2 rounded bg-primary/10 text-xs">
                      <AlertCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <p>You'll complete the connection after signing in. The bot will send you a unique link.</p>
                    </div>
                  </div>
                )}

                {alertMethod === "email" && (
                  <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                    <div className="space-y-2">
                      <Label className="text-sm">Email Provider</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {(["resend", "sendgrid", "mailgun", "smtp"] as const).map((provider) => (
                          <button
                            key={provider}
                            type="button"
                            onClick={() => setEmailProvider(provider)}
                            className={`p-2 rounded border text-sm capitalize ${
                              emailProvider === provider
                                ? "border-primary bg-primary/10"
                                : "border-muted hover-elevate"
                            }`}
                          >
                            {provider === "smtp" ? "SMTP (Custom)" : provider}
                          </button>
                        ))}
                      </div>
                    </div>

                    {emailProvider !== "smtp" && (
                      <div className="space-y-2">
                        <Label htmlFor="email-api-key" className="text-sm">API Key</Label>
                        <Input
                          id="email-api-key"
                          type="password"
                          placeholder={`Your ${emailProvider} API key`}
                          value={emailApiKey}
                          onChange={(e) => setEmailApiKey(e.target.value)}
                          data-testid="input-email-api-key"
                        />
                      </div>
                    )}

                    {emailProvider === "smtp" && (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label htmlFor="smtp-host" className="text-xs">SMTP Host</Label>
                            <Input
                              id="smtp-host"
                              placeholder="smtp.example.com"
                              value={smtpHost}
                              onChange={(e) => setSmtpHost(e.target.value)}
                              className="h-8 text-sm"
                            />
                          </div>
                          <div>
                            <Label htmlFor="smtp-port" className="text-xs">Port</Label>
                            <Input
                              id="smtp-port"
                              placeholder="587"
                              value={smtpPort}
                              onChange={(e) => setSmtpPort(e.target.value)}
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor="smtp-user" className="text-xs">Username</Label>
                          <Input
                            id="smtp-user"
                            placeholder="username"
                            value={smtpUser}
                            onChange={(e) => setSmtpUser(e.target.value)}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <Label htmlFor="smtp-pass" className="text-xs">Password</Label>
                          <Input
                            id="smtp-pass"
                            type="password"
                            placeholder="password"
                            value={smtpPass}
                            onChange={(e) => setSmtpPass(e.target.value)}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="email-from" className="text-sm">From Address</Label>
                      <Input
                        id="email-from"
                        type="email"
                        placeholder="alerts@yourdomain.com"
                        value={emailFromAddress}
                        onChange={(e) => setEmailFromAddress(e.target.value)}
                        data-testid="input-email-from"
                      />
                    </div>
                  </div>
                )}

                <Button 
                  className="w-full" 
                  onClick={async () => {
                    // Save alert preferences if email is selected
                    if (alertMethod === "email" && emailApiKey) {
                      try {
                        await apiRequest("POST", "/api/settings/email-provider", {
                          emailProvider,
                          emailApiKey,
                          emailFromAddress,
                          smtpConfig: emailProvider === "smtp" ? {
                            host: smtpHost,
                            port: parseInt(smtpPort) || 587,
                            user: smtpUser,
                            pass: smtpPass
                          } : undefined
                        });
                      } catch (e) {
                        console.error("Failed to save email settings:", e);
                      }
                    }
                    setShowWizard(false);
                    login.mutate();
                  }}
                  data-testid="button-wizard-done"
                >
                  {alertMethod === "skip" ? "Skip & Enter App" : "Save & Enter App"}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
