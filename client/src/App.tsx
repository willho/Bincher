import { useState, useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import Login from "@/pages/login";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function AuthenticatedApp() {
  const [authKey, setAuthKey] = useState(0);
  
  const { data: session, isLoading, refetch } = useQuery<{ authenticated: boolean; username?: string }>({
    queryKey: ["/api/auth/session"],
    staleTime: 0, // Always refetch session
  });
  
  // Refetch session when authKey changes (after login)
  useEffect(() => {
    if (authKey > 0) {
      refetch();
    }
  }, [authKey, refetch]);

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

  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
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
