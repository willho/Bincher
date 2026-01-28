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
import { Loader2, Lock, User, Mail, ArrowLeft } from "lucide-react";

interface LoginProps {
  onLoginSuccess: () => void;
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [isSignUpMode, setIsSignUpMode] = useState(false);

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
    mutationFn: () => apiRequest("POST", "/api/auth/register", { username, password }),
    onSuccess: () => {
      login.mutate();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Registration failed", variant: "destructive" });
    },
  });

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

  const isSetup = needsSetup?.needsSetup || isSignUpMode;
  const isPending = login.isPending || register.isPending;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>{isSetup ? "Create Account" : "Welcome Back"}</CardTitle>
          <CardDescription>
            {isSetup 
              ? "Set up your credentials to secure your wallet monitor"
              : "Sign in to access your wallet monitor"
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
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
                    data-testid="input-confirm-password"
                  />
                </div>
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
    </div>
  );
}
