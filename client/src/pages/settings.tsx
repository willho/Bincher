import { useQuery } from "@tanstack/react-query";
import { ApiKeysSettings } from "@/components/api-keys-settings";
import { AdminDashboard } from "@/components/admin-dashboard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Key, Bell, User, Shield } from "lucide-react";

interface SessionData {
  authenticated: boolean;
  username?: string;
  userId?: number;
  isAdmin?: boolean;
}

export default function SettingsPage() {
  const { data: session } = useQuery<SessionData>({
    queryKey: ["/api/auth/session"],
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
