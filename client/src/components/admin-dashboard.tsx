import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Users, Wallet, Activity, BarChart3, Megaphone, Send, Loader2, CheckCircle, XCircle, Brain, RefreshCw, Target, TrendingUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AdminWallet {
  id: number;
  userId: number;
  username: string;
  walletAddress: string;
  label: string | null;
  enabled: boolean;
}

interface AdminStats {
  totalUsers: number;
  totalSwaps: number;
  totalWallets: number;
  activeWallets: number;
}

interface AdminMessage {
  id: number;
  title: string;
  content: string;
  priority: string;
  targetUserId: number | null;
  createdBy: number;
  createdAt: number;
  expiresAt: number | null;
}

interface PendingWallet {
  id: number;
  userId: number;
  username: string;
  walletAddress: string;
  label: string | null;
  aiScore: number | null;
  aiScoreDetails: {
    score: number;
    hitRate: number;
    avgMultiplier: number;
    totalTrades: number;
    realizedPnL: number;
    analysis: string;
  } | null;
  createdAt: number;
}

export function AdminDashboard() {
  const { toast } = useToast();
  const [messageTitle, setMessageTitle] = useState("");
  const [messageContent, setMessageContent] = useState("");
  const [messagePriority, setMessagePriority] = useState("normal");
  const [targetUser, setTargetUser] = useState<string>("all");

  const { data: stats, isLoading: statsLoading } = useQuery<AdminStats>({
    queryKey: ["/api/admin/stats"],
  });

  const { data: users, isLoading: usersLoading } = useQuery<AdminUser[]>({
    queryKey: ["/api/admin/users"],
  });

  const { data: wallets, isLoading: walletsLoading } = useQuery<AdminWallet[]>({
    queryKey: ["/api/admin/wallets"],
  });

  const { data: adminMessages, isLoading: messagesLoading } = useQuery<AdminMessage[]>({
    queryKey: ["/api/admin/messages"],
  });

  const { data: pendingWallets, isLoading: pendingLoading } = useQuery<PendingWallet[]>({
    queryKey: ["/api/admin/pending-wallets"],
  });

  const approveWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet approved for community sharing" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to approve wallet", variant: "destructive" });
    },
  });

  const rejectWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet rejected" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to reject wallet", variant: "destructive" });
    },
  });

  const rescoreWallet = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/wallets/${id}/rescore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/pending-wallets"] });
      toast({ description: "Wallet rescored successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to rescore wallet", variant: "destructive" });
    },
  });

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-500 border-green-500/50";
    if (score >= 40) return "text-yellow-500 border-yellow-500/50";
    return "text-red-500 border-red-500/50";
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 70) return "bg-green-500/10";
    if (score >= 40) return "bg-yellow-500/10";
    return "bg-red-500/10";
  };

  const createMessage = useMutation({
    mutationFn: (data: { title: string; content: string; priority: string; targetUserId: number | null }) =>
      apiRequest("POST", "/api/admin/messages", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/messages"] });
      setMessageTitle("");
      setMessageContent("");
      setMessagePriority("normal");
      setTargetUser("all");
      toast({ description: "Message sent successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to send message", variant: "destructive" });
    },
  });

  const deleteMessage = useMutation({
    mutationFn: (messageId: number) => apiRequest("DELETE", `/api/admin/messages/${messageId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/messages"] });
      toast({ description: "Message deleted" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to delete message", variant: "destructive" });
    },
  });

  const deleteUser = useMutation({
    mutationFn: (userId: number) => apiRequest("DELETE", `/api/admin/users/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/wallets"] });
      toast({ description: "User deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ description: error.message || "Failed to delete user", variant: "destructive" });
    },
  });

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleDeleteUser = (userId: number, username: string) => {
    if (confirm(`Are you sure you want to delete user "${username}" and all their data?`)) {
      deleteUser.mutate(userId);
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageTitle.trim() || !messageContent.trim()) {
      toast({ description: "Title and content are required", variant: "destructive" });
      return;
    }
    createMessage.mutate({
      title: messageTitle.trim(),
      content: messageContent.trim(),
      priority: messagePriority,
      targetUserId: targetUser === "all" ? null : parseInt(targetUser),
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Total Users
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-users">{stats?.totalUsers ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Wallet className="h-4 w-4" />
              Total Wallets
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-wallets">{stats?.totalWallets ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Active Wallets
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-active-wallets">{stats?.activeWallets ?? 0}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Total Swaps
            </CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-bold" data-testid="stat-total-swaps">{stats?.totalSwaps ?? 0}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Pending Wallet Approvals
            {pendingWallets && pendingWallets.length > 0 && (
              <Badge variant="secondary" className="ml-2">{pendingWallets.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>Review wallet submissions for community sharing</CardDescription>
        </CardHeader>
        <CardContent>
          {pendingLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : pendingWallets && pendingWallets.length > 0 ? (
            <div className="space-y-3">
              {pendingWallets.map((wallet) => (
                <div
                  key={wallet.id}
                  data-testid={`pending-wallet-${wallet.id}`}
                  className={`p-4 rounded-lg border ${wallet.aiScore ? getScoreBgColor(wallet.aiScore) : "bg-muted/50"}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{wallet.label || "Unnamed Wallet"}</span>
                        <Badge variant="outline" className="text-xs">by {wallet.username}</Badge>
                        {wallet.aiScore !== null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className={`gap-1 ${getScoreColor(wallet.aiScore)}`}>
                                <Brain className="h-3 w-3" />
                                {wallet.aiScore}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <div className="space-y-1">
                                <p className="font-medium">AI Trading Score</p>
                                {wallet.aiScoreDetails && (
                                  <div className="text-xs space-y-0.5">
                                    <p>Hit Rate: {(wallet.aiScoreDetails.hitRate * 100).toFixed(0)}%</p>
                                    <p>Avg Multiplier: {wallet.aiScoreDetails.avgMultiplier.toFixed(2)}x</p>
                                    <p>Total Trades: {wallet.aiScoreDetails.totalTrades}</p>
                                    <p>Realized PnL: ${wallet.aiScoreDetails.realizedPnL.toFixed(2)}</p>
                                  </div>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono block">
                        {wallet.walletAddress.slice(0, 8)}...{wallet.walletAddress.slice(-6)}
                      </span>
                      {wallet.aiScoreDetails && (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Target className="h-3 w-3" />
                            {(wallet.aiScoreDetails.hitRate * 100).toFixed(0)}% wins
                          </span>
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {wallet.aiScoreDetails.avgMultiplier.toFixed(1)}x avg
                          </span>
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {wallet.aiScoreDetails.totalTrades} trades
                          </span>
                        </div>
                      )}
                      {wallet.aiScoreDetails?.analysis && (
                        <p className="text-xs text-muted-foreground italic">
                          "{wallet.aiScoreDetails.analysis}"
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => rescoreWallet.mutate(wallet.id)}
                        disabled={rescoreWallet.isPending}
                        title="Rescore"
                        data-testid={`button-rescore-wallet-${wallet.id}`}
                      >
                        <RefreshCw className={`h-4 w-4 ${rescoreWallet.isPending ? "animate-spin" : ""}`} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-green-500 hover:text-green-600"
                        onClick={() => approveWallet.mutate(wallet.id)}
                        disabled={approveWallet.isPending}
                        title="Approve"
                        data-testid={`button-approve-wallet-${wallet.id}`}
                      >
                        <CheckCircle className="h-5 w-5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-500 hover:text-red-600"
                        onClick={() => rejectWallet.mutate(wallet.id)}
                        disabled={rejectWallet.isPending}
                        title="Reject"
                        data-testid={`button-reject-wallet-${wallet.id}`}
                      >
                        <XCircle className="h-5 w-5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-center text-muted-foreground py-6">
              No pending wallet submissions
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            User Management
          </CardTitle>
          <CardDescription>Manage all registered users</CardDescription>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : users && users.length > 0 ? (
            <div className="space-y-2">
              {users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                  data-testid={`user-row-${user.id}`}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium" data-testid={`user-username-${user.id}`}>
                          {user.username}
                        </span>
                        {user.isAdmin && (
                          <Badge variant="default" className="text-xs">Admin</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Joined: {formatDate(user.createdAt)}
                        {user.lastLoginAt && ` | Last login: ${formatDate(user.lastLoginAt)}`}
                      </p>
                    </div>
                  </div>
                  {!user.isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteUser(user.id, user.username)}
                      disabled={deleteUser.isPending}
                      data-testid={`button-delete-user-${user.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No users found</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            Send Announcement
          </CardTitle>
          <CardDescription>Send alerts and announcements to users</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSendMessage} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="message-title">Title</Label>
                <Input
                  id="message-title"
                  placeholder="Announcement title"
                  value={messageTitle}
                  onChange={(e) => setMessageTitle(e.target.value)}
                  data-testid="input-message-title"
                />
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="message-priority">Priority</Label>
                  <Select value={messagePriority} onValueChange={setMessagePriority}>
                    <SelectTrigger data-testid="select-message-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message-target">Send To</Label>
                  <Select value={targetUser} onValueChange={setTargetUser}>
                    <SelectTrigger data-testid="select-message-target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Users</SelectItem>
                      {users?.map((user) => (
                        <SelectItem key={user.id} value={String(user.id)}>
                          {user.username}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="message-content">Message</Label>
              <Textarea
                id="message-content"
                placeholder="Enter your announcement message..."
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                className="min-h-[100px]"
                data-testid="textarea-message-content"
              />
            </div>
            <Button
              type="submit"
              disabled={createMessage.isPending || !messageTitle.trim() || !messageContent.trim()}
              data-testid="button-send-message"
            >
              {createMessage.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Send Announcement
            </Button>
          </form>

          {adminMessages && adminMessages.length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <h4 className="font-medium mb-3">Previous Announcements</h4>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {adminMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="flex items-start justify-between p-3 rounded-lg border text-sm"
                    data-testid={`admin-message-${msg.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{msg.title}</span>
                        {msg.priority !== "normal" && (
                          <Badge variant={msg.priority === "urgent" ? "destructive" : "secondary"} className="text-xs">
                            {msg.priority}
                          </Badge>
                        )}
                        {msg.targetUserId && (
                          <Badge variant="outline" className="text-xs">
                            {users?.find(u => u.id === msg.targetUserId)?.username || `User #${msg.targetUserId}`}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 truncate">{msg.content}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(msg.createdAt)}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMessage.mutate(msg.id)}
                      disabled={deleteMessage.isPending}
                      data-testid={`button-delete-message-${msg.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            All Monitored Wallets
          </CardTitle>
          <CardDescription>View all wallets across all users</CardDescription>
        </CardHeader>
        <CardContent>
          {walletsLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : wallets && wallets.length > 0 ? (
            <div className="space-y-2">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                  data-testid={`wallet-row-${wallet.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium" data-testid={`wallet-owner-${wallet.id}`}>
                        {wallet.username}
                      </span>
                      <Badge variant={wallet.enabled ? "default" : "secondary"} className="text-xs">
                        {wallet.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground truncate" data-testid={`wallet-address-${wallet.id}`}>
                      {wallet.label ? `${wallet.label}: ` : ""}{wallet.walletAddress}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">No wallets found</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
