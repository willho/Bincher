import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, CheckCircle, AlertTriangle, Info, Megaphone } from "lucide-react";

interface AdminMessage {
  id: number;
  title: string;
  content: string;
  priority: string;
  targetUserId: number | null;
  createdBy: number;
  createdAt: number;
  expiresAt: number | null;
  read: boolean;
}

export function Alerts() {
  const { data: messages, isLoading } = useQuery<AdminMessage[]>({
    queryKey: ["/api/messages"],
    refetchInterval: 60000,
  });

  const markAsRead = useMutation({
    mutationFn: (messageId: number) => apiRequest("POST", `/api/messages/${messageId}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
    },
  });

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case "urgent":
        return <AlertTriangle className="h-4 w-4 text-destructive" />;
      case "high":
        return <Megaphone className="h-4 w-4 text-orange-500" />;
      default:
        return <Info className="h-4 w-4 text-primary" />;
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case "urgent":
        return <Badge variant="destructive">Urgent</Badge>;
      case "high":
        return <Badge className="bg-orange-500">High</Badge>;
      default:
        return null;
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) {
      return "Just now";
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Alerts & Announcements
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 border rounded-lg space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Alerts & Announcements
        </CardTitle>
        <CardDescription>
          System alerts and admin announcements
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!messages || messages.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Bell className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No alerts or announcements yet</p>
            <p className="text-sm mt-1">Check back later for updates from the admin</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`p-4 border rounded-lg transition-colors ${
                  message.read ? "bg-muted/30" : "bg-primary/5 border-primary/20"
                }`}
                data-testid={`message-card-${message.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="mt-0.5">
                      {getPriorityIcon(message.priority)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-medium text-sm sm:text-base">{message.title}</h4>
                        {getPriorityBadge(message.priority)}
                        {!message.read && (
                          <Badge variant="secondary" className="text-xs">New</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                        {message.content}
                      </p>
                      <p className="text-xs text-muted-foreground mt-2">
                        {formatDate(message.createdAt)}
                      </p>
                    </div>
                  </div>
                  {!message.read && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => markAsRead.mutate(message.id)}
                      disabled={markAsRead.isPending}
                      data-testid={`button-mark-read-${message.id}`}
                    >
                      <CheckCircle className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
