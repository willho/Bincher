import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Send, Trash2, Loader2, AlertTriangle, CheckCircle, TrendingUp, Activity, Brain, RefreshCw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface SystemSummary {
  errors: {
    count: number;
    recent: Array<{ service: string; message: string; timestamp: number }>;
  };
  optimizations: {
    rulesCreated: number;
    rulesTriggered: number;
    insightsPublished: number;
    patternsDetected: number;
  };
  observations: {
    topInsightSources: Array<{ source: string; count: number }>;
    recentPatterns: Array<{ type: string; title: string; confidence: number }>;
    rulePerformance: Array<{ name: string; confidence: number; triggerCount: number }>;
  };
  health: {
    status: "healthy" | "warning" | "critical";
    issues: string[];
  };
}

export function AdminChat() {
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: chatHistory, isLoading: chatLoading, error: chatError, refetch: refetchChat } = useQuery<ChatMessage[]>({
    queryKey: ["/api/admin/chat"],
    refetchInterval: 5000,
  });

  const { data: summary, isLoading: summaryLoading, error: summaryError, refetch: refetchSummary } = useQuery<SystemSummary>({
    queryKey: ["/api/admin/system-summary"],
    refetchInterval: 30000,
  });

  const sendMessage = useMutation({
    mutationFn: (message: string) =>
      apiRequest("POST", "/api/admin/chat", { message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/system-summary"] });
      setInput("");
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to send message",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  const clearChat = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/admin/chat"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/chat"] });
      toast({
        title: "Chat cleared",
        description: "Conversation history has been cleared",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to clear chat",
        description: error.message || "Please try again",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatHistory]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sendMessage.isPending) return;
    sendMessage.mutate(input.trim());
  };

  const hasMessages = chatHistory && chatHistory.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Health</CardTitle>
            {summary?.health.status === "healthy" && <CheckCircle className="h-4 w-4 text-green-500" />}
            {summary?.health.status === "warning" && <AlertTriangle className="h-4 w-4 text-yellow-500" />}
            {summary?.health.status === "critical" && <AlertTriangle className="h-4 w-4 text-red-500" />}
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : summaryError ? (
              <div className="flex flex-col gap-1">
                <Badge variant="destructive">error</Badge>
                <span className="text-xs text-muted-foreground">Failed to load</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <Badge
                  variant={summary?.health.status === "healthy" ? "default" : summary?.health.status === "warning" ? "secondary" : "destructive"}
                  data-testid="badge-health-status"
                >
                  {summary?.health.status || "unknown"}
                </Badge>
                {summary?.health.issues.map((issue, i) => (
                  <span key={i} className="text-xs text-muted-foreground">{issue}</span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Errors (24h)</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : summaryError ? (
              <span className="text-sm text-muted-foreground">-</span>
            ) : (
              <div className="text-2xl font-bold" data-testid="text-error-count">
                {summary?.errors.count || 0}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rules Created (7d)</CardTitle>
            <Brain className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : summaryError ? (
              <span className="text-sm text-muted-foreground">-</span>
            ) : (
              <div className="text-2xl font-bold" data-testid="text-rules-created">
                {summary?.optimizations.rulesCreated || 0}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Patterns Detected</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : summaryError ? (
              <span className="text-sm text-muted-foreground">-</span>
            ) : (
              <div className="text-2xl font-bold" data-testid="text-patterns-detected">
                {summary?.optimizations.patternsDetected || 0}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              System Chat
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => refetchSummary()}
                data-testid="button-refresh-summary"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              {hasMessages && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => clearChat.mutate()}
                  disabled={clearChat.isPending}
                  data-testid="button-clear-admin-chat"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col h-[400px]">
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2"
              data-testid="admin-chat-messages"
            >
              {chatError ? (
                <div className="text-center py-8">
                  <XCircle className="h-12 w-12 mx-auto mb-2 text-destructive opacity-50" />
                  <p className="text-destructive">Failed to load chat history</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchChat()}>
                    Try Again
                  </Button>
                </div>
              ) : chatLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-3/4" />
                  <Skeleton className="h-16 w-2/3 ml-auto" />
                </div>
              ) : !hasMessages ? (
                <div className="text-center text-muted-foreground py-8">
                  <Brain className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>Ask about system health, errors, or self-optimization progress.</p>
                  <p className="text-sm mt-2">Try: "What's the current system status?" or "Show me recent errors"</p>
                </div>
              ) : (
                chatHistory?.map((msg, i) => (
                  <div
                    key={i}
                    className={cn(
                      "p-3 rounded-lg max-w-[85%]",
                      msg.role === "user"
                        ? "ml-auto bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                    data-testid={`chat-message-${msg.role}-${i}`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                ))
              )}
              {sendMessage.isPending && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Analyzing...</span>
                </div>
              )}
            </div>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about system status..."
                disabled={sendMessage.isPending}
                data-testid="input-admin-chat"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || sendMessage.isPending}
                data-testid="button-send-admin-chat"
              >
                {sendMessage.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Observations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {summaryLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : summaryError ? (
              <div className="text-center py-4">
                <XCircle className="h-8 w-8 mx-auto mb-2 text-destructive opacity-50" />
                <p className="text-sm text-muted-foreground">Failed to load observations</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchSummary()}>
                  Retry
                </Button>
              </div>
            ) : (
              <>
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Top Insight Sources</h4>
                  {summary?.observations.topInsightSources.length ? (
                    <div className="space-y-1">
                      {summary.observations.topInsightSources.map((s, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span>{s.source}</span>
                          <Badge variant="outline">{s.count}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No insights yet</p>
                  )}
                </div>

                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Recent Patterns</h4>
                  {summary?.observations.recentPatterns.length ? (
                    <div className="space-y-1">
                      {summary.observations.recentPatterns.map((p, i) => (
                        <div key={i} className="text-sm">
                          <span className="font-medium">{p.type}</span>
                          <span className="text-muted-foreground"> - {p.title}</span>
                          <Badge variant="secondary" className="ml-2 text-xs">
                            {(p.confidence * 100).toFixed(0)}%
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No patterns detected</p>
                  )}
                </div>

                <div>
                  <h4 className="text-xs font-medium text-muted-foreground mb-2">Rule Performance</h4>
                  {summary?.observations.rulePerformance.length ? (
                    <div className="space-y-1">
                      {summary.observations.rulePerformance.map((r, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span className="truncate flex-1">{r.name}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{r.triggerCount}</Badge>
                            <Badge variant={r.confidence >= 0.6 ? "default" : "secondary"}>
                              {(r.confidence * 100).toFixed(0)}%
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No active rules</p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
