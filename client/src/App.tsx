import { useState, useEffect } from "react";
import { Switch, Route, useLocation, Link } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SecurityProvider } from "@/contexts/security-context";
import {
  SidebarProvider,
  SidebarTrigger,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import DashboardPage from "@/pages/dashboard-new";
import TradingPage from "@/pages/trading";
import TokenPage from "@/pages/token";
import SignalWalletPage from "@/pages/signal-wallet";
import CopySettingsPage from "@/pages/copy-settings";
import HoldingsPage from "@/pages/holdings";
import SignalsPage from "@/pages/signals";
import PaperTradingPage from "@/pages/paper-trading";
import SettingsPage from "@/pages/settings";
import Login from "@/pages/login";
import ResetPassword from "@/pages/reset-password";
import DiscoveryPage from "@/pages/discovery";
import NotFound from "@/pages/not-found";
import { PincherFooter } from "@/components/pincher-footer";
import { Loader2, LayoutDashboard, Eye, TrendingUp, Settings, LogOut, Shell, TestTube, Droplet, Wallet, Coins, Radio, FlaskConical, Compass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SidebarGroupLabel } from "@/components/ui/sidebar";
import { apiRequest } from "@/lib/queryClient";

const overviewItems = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Discovery", href: "/discovery", icon: Compass },
];

const tradingItems = [
  { title: "Holdings", href: "/holdings", icon: Coins, description: "Your Positions" },
  { title: "Signals", href: "/signals", icon: Radio, description: "Signal Wallets" },
  { title: "Trading", href: "/trading", icon: TrendingUp, description: "Hot Wallet" },
  { title: "Paper Trading", href: "/paper", icon: FlaskConical, description: "Practice Mode" },
];

const systemItems = [
  { title: "Settings", href: "/settings", icon: Settings },
];

function AppSidebar() {
  const [location] = useLocation();

  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.invalidateQueries({ queryKey: ["/api/auth/session"] });
  };

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b">
        <Link href="/dashboard">
          <div className="flex items-center gap-2 cursor-pointer" data-testid="link-logo">
            <Shell className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg">Penny Pincher</span>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {overviewItems.map((item) => {
                const isActive = location === item.href || location === "/";
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton 
                      asChild 
                      data-active={isActive}
                      className="data-[active=true]:bg-sidebar-accent"
                    >
                      <Link href={item.href} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Trading</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {tradingItems.map((item) => {
                const isActive = location === item.href || 
                  (item.href === "/trading" && location.startsWith("/trading/")) ||
                  (item.href === "/holdings" && location.startsWith("/holdings/"));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton 
                      asChild 
                      data-active={isActive}
                      className="data-[active=true]:bg-sidebar-accent"
                    >
                      <Link href={item.href} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {systemItems.map((item) => {
                const isActive = location === item.href;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton 
                      asChild 
                      data-active={isActive}
                      className="data-[active=true]:bg-sidebar-accent"
                    >
                      <Link href={item.href} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t">
        <Button 
          variant="ghost" 
          className="w-full justify-start gap-2"
          onClick={handleLogout}
          data-testid="button-logout"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

function AuthenticatedApp() {
  const [authKey, setAuthKey] = useState(0);
  const [location] = useLocation();
  
  const { data: session, isLoading, refetch } = useQuery<{ authenticated: boolean; username?: string }>({
    queryKey: ["/api/auth/session"],
    staleTime: 0,
  });

  const { data: networkMode } = useQuery<{ mode: "mainnet" | "devnet"; faucetUrl: string | null }>({
    queryKey: ["/api/network-mode"],
    enabled: !!session?.authenticated,
  });
  
  useEffect(() => {
    if (authKey > 0) {
      refetch();
    }
  }, [authKey, refetch]);

  if (location.startsWith("/reset-password")) {
    return <ResetPassword />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session?.authenticated) {
    return <Login onLoginSuccess={() => setAuthKey(k => k + 1)} />;
  }

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center gap-4 p-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            {networkMode?.mode === "devnet" && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/30" data-testid="badge-devnet">
                  <TestTube className="h-3 w-3 mr-1" />
                  Devnet
                </Badge>
                {networkMode.faucetUrl && (
                  <a 
                    href={networkMode.faucetUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-xs text-yellow-600 hover:underline flex items-center gap-1"
                    data-testid="link-faucet"
                  >
                    <Droplet className="h-3 w-3" />
                    Get Test SOL
                  </a>
                )}
              </div>
            )}
          </header>
          <main className="flex-1 p-6 overflow-auto pb-20">
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/discovery" component={DiscoveryPage} />
              <Route path="/holdings" component={HoldingsPage} />
              <Route path="/holdings/:token" component={HoldingsPage} />
              <Route path="/signals" component={SignalsPage} />
              <Route path="/signal/:id" component={SignalWalletPage} />
              <Route path="/signal/:id/copy-settings" component={CopySettingsPage} />
              <Route path="/trading" component={TradingPage} />
              <Route path="/trading/:token" component={TokenPage} />
              <Route path="/paper" component={PaperTradingPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
        <PincherFooter />
      </div>
    </SidebarProvider>
  );
}

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
