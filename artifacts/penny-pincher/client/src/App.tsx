import { useState, useEffect } from "react";
import { Switch, Route, useLocation, Link } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SecurityProvider } from "@/contexts/security-context";
import { Loader2, Shell, PieChart, Compass, Radio } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import PortfolioPage from "@/pages/portfolio";
import SignalsPage from "@/pages/signals";
import DiscoveryPage from "@/pages/discovery";
import TokenPage from "@/pages/token";
import TokenDetailPage from "@/pages/token-detail";
import WalletDetailPage from "@/pages/wallet-detail";
import SignalWalletPage from "@/pages/signal-wallet";
import CopySettingsPage from "@/pages/copy-settings";
import HoldingsPage from "@/pages/holdings";
import SettingsPage from "@/pages/settings";
import TradingPage from "@/pages/trading";
import Login from "@/pages/login";
import ResetPassword from "@/pages/reset-password";
import NotFound from "@/pages/not-found";
import { Redirect } from "wouter";

// ── Bottom Nav ────────────────────────────────────────────────────────────

const NAV_TABS = [
  { label: "Portfolio", href: "/", icon: PieChart },
  { label: "Discovery", href: "/discovery", icon: Compass },
  { label: "Appraisal", href: "/signals", icon: Radio },
] as const;

function BottomNav() {
  const [location] = useLocation();

  const activeTab: string = (() => {
    if (location === "/" || location === "/portfolio") return "/";
    if (location.startsWith("/discovery")) return "/discovery";
    if (location.startsWith("/signals") || location.startsWith("/signal/")) return "/signals";
    return "/";
  })();

  return (
    <nav className="bottom-nav" data-testid="bottom-nav">
      <div className="flex items-center justify-around px-2 py-2">
        {NAV_TABS.map(({ label, href, icon: Icon }) => {
          const isActive = activeTab === href;
          return (
            <Link key={href} href={href}>
              <div
                className="flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-all cursor-pointer"
                style={{ background: isActive ? "var(--mint-dim)" : "transparent" }}
                data-testid={`nav-tab-${label.toLowerCase()}`}
              >
                <Icon
                  size={20}
                  style={{ color: isActive ? "var(--mint)" : "var(--shell-muted)" }}
                />
                <span
                  className="text-xs font-semibold"
                  style={{
                    color: isActive ? "var(--mint)" : "var(--shell-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    letterSpacing: "0.05em",
                  }}
                >
                  {label.toUpperCase()}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// ── Status Bar ─────────────────────────────────────────────────────────────

function StatusBar({ username }: { username?: string }) {
  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
  };

  return (
    <header
      className="flex items-center justify-between px-4 py-3 flex-shrink-0"
      style={{ borderBottom: "1px solid var(--shell-border)", background: "var(--shell-bg)" }}
      data-testid="status-bar"
    >
      <div className="flex items-center gap-2">
        <Shell size={18} style={{ color: "var(--mint)" }} />
        <span
          className="font-bold text-sm text-white"
          style={{ letterSpacing: "0.02em" }}
          data-testid="link-logo"
        >
          Penny Pincher
        </span>
      </div>

      {username && (
        <button
          onClick={handleLogout}
          className="text-xs px-2 py-1 rounded"
          style={{
            color: "var(--shell-muted)",
            fontFamily: "var(--font-mono)",
            background: "transparent",
            border: "1px solid var(--shell-border)",
            cursor: "pointer",
          }}
          data-testid="button-logout"
        >
          {username}&nbsp;·&nbsp;out
        </button>
      )}
    </header>
  );
}

// ── Scrollable wrapper for pages that need padding ────────────────────────

function PageWrap({ children }: { children: React.ReactNode }) {
  return <div className="page-scroll p-4">{children}</div>;
}

// ── Authenticated Shell ───────────────────────────────────────────────────

function AuthenticatedApp() {
  const [authKey, setAuthKey] = useState(0);
  const [location] = useLocation();

  const { data: session, isLoading, refetch } = useQuery<{
    authenticated: boolean;
    username?: string;
  }>({
    queryKey: ["/api/auth/session"],
    staleTime: 0,
  });

  useEffect(() => {
    if (authKey > 0) refetch();
  }, [authKey, refetch]);

  if (location.startsWith("/reset-password")) {
    return <ResetPassword />;
  }

  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: "var(--shell-bg)" }}
      >
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: "var(--mint)" }} />
      </div>
    );
  }

  if (!session?.authenticated) {
    return <Login onLoginSuccess={() => setAuthKey((k) => k + 1)} />;
  }

  return (
    <div style={{ background: "#070c17", minHeight: "100dvh", display: "flex", justifyContent: "center" }}>
      <div className="pincher-shell">
        <StatusBar username={session.username} />

        <Switch>
          <Route path="/" component={PortfolioPage} />
          <Route path="/portfolio" component={PortfolioPage} />
          <Route path="/discovery" component={() => <PageWrap><DiscoveryPage /></PageWrap>} />
          <Route path="/signals" component={() => <PageWrap><SignalsPage /></PageWrap>} />
          <Route path="/signal/:id" component={SignalWalletPage} />
          <Route path="/signal/:id/copy-settings" component={CopySettingsPage} />
          <Route path="/holdings" component={() => <PageWrap><HoldingsPage /></PageWrap>} />
          <Route path="/holdings/:token" component={() => <PageWrap><HoldingsPage /></PageWrap>} />
          <Route path="/trading" component={() => <PageWrap><TradingPage /></PageWrap>} />
          <Route path="/trading/:token" component={TokenPage} />
          <Route path="/token/:mint" component={TokenDetailPage} />
          <Route path="/wallet/:address" component={WalletDetailPage} />
          <Route path="/settings" component={() => <PageWrap><SettingsPage /></PageWrap>} />
          <Route path="/paper"><Redirect to="/" /></Route>
          <Route path="/dashboard"><Redirect to="/" /></Route>
          <Route component={NotFound} />
        </Switch>

        <BottomNav />
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SecurityProvider>
          <Toaster />
          <AuthenticatedApp />
        </SecurityProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
