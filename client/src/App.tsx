import { useState, useEffect } from "react";
import { Switch, Route, useLocation, Link } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
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
import WatchlistPage from "@/pages/watchlist";
import TradingPage from "@/pages/trading";
import TokenPage from "@/pages/token";
import SettingsPage from "@/pages/settings";
import Login from "@/pages/login";
import ResetPassword from "@/pages/reset-password";
import NotFound from "@/pages/not-found";
import { Loader2, LayoutDashboard, Eye, TrendingUp, Settings, LogOut, Crab } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

const navItems = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Watchlist", href: "/watchlist", icon: Eye },
  { title: "Trading", href: "/trading", icon: TrendingUp },
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
            <Crab className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg">Penny Pincher</span>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.href || 
                  (item.href === "/trading" && location.startsWith("/trading/"));
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
          </header>
          <main className="flex-1 p-6 overflow-auto">
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/watchlist" component={WatchlistPage} />
              <Route path="/trading" component={TradingPage} />
              <Route path="/trading/:token" component={TokenPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthenticatedApp />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
