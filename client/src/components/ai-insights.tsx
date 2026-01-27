import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Bot,
  Brain,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Twitter,
  AlertCircle,
  CheckCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { TokenSnapshot } from "@shared/schema";

interface AIInsights {
  totalTokens: number;
  tokensWithOutcomes: number;
  averageScore: number;
  topPatterns: string[];
  winRate: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ScoreResult {
  score: number;
  reasoning: string;
  redFlags: string[];
  greenFlags: string[];
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return "N/A";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function formatTimeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return "N/A";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getScoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "bg-muted";
  if (score >= 70) return "bg-green-500";
  if (score >= 50) return "bg-yellow-500";
  if (score >= 30) return "bg-orange-500";
  return "bg-red-500";
}

export function AIInsights() {
  const { toast } = useToast();
  const [chatInput, setChatInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: insights, isLoading: insightsLoading } = useQuery<AIInsights>({
    queryKey: ["/api/ai/insights"],
    refetchInterval: 60000,
  });

  const { data: snapshots, isLoading: snapshotsLoading } = useQuery<TokenSnapshot[]>({
    queryKey: ["/api/ai/snapshots"],
    refetchInterval: 30000,
  });

  const { data: chatHistory, isLoading: chatLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/ai/chat"],
  });

  const sendMessage = useMutation({
    mutationFn: (message: string) => apiRequest("POST", "/api/ai/chat", { message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat"] });
      setChatInput("");
    },
    onError: () => {
      toast({ description: "Failed to send message", variant: "destructive" });
    },
  });

  const clearChat = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/ai/chat"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat"] });
      toast({ description: "Chat history cleared" });
    },
  });

  const refreshScore = useMutation({
    mutationFn: (snapshotId: number) => 
      apiRequest("POST", `/api/ai/snapshots/${snapshotId}/score`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/snapshots"] });
      toast({ description: "Score refreshed" });
    },
    onError: () => {
      toast({ description: "Failed to refresh score", variant: "destructive" });
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  const handleSendMessage = () => {
    const message = chatInput.trim();
    if (!message) return;
    sendMessage.mutate(message);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card data-testid="card-stat-tokens-analyzed">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Tokens Analyzed</CardTitle>
            <Brain className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {insightsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-total-tokens">{insights?.totalTokens ?? 0}</div>
            )}
            <p className="text-xs text-muted-foreground" data-testid="text-tokens-with-outcomes">
              {insights?.tokensWithOutcomes ?? 0} with outcomes
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-average-score">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Average Score</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {insightsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-average-score">{insights?.averageScore ?? 0}/100</div>
            )}
            <p className="text-xs text-muted-foreground">AI confidence score</p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-win-rate">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Win Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {insightsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-win-rate">{insights?.winRate ?? 0}%</div>
            )}
            <p className="text-xs text-muted-foreground">Trades at 2x+</p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-patterns">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Patterns</CardTitle>
            <Sparkles className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {insightsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <div className="text-2xl font-bold" data-testid="text-patterns-count">{insights?.topPatterns?.length ?? 0}</div>
            )}
            <p className="text-xs text-muted-foreground">Discovered insights</p>
          </CardContent>
        </Card>
      </div>

      {insights?.topPatterns && insights.topPatterns.length > 0 && (
        <Card data-testid="card-discovered-patterns">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Discovered Patterns
            </CardTitle>
            <CardDescription>AI-detected correlations from trading data</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2" data-testid="list-patterns">
              {insights.topPatterns.map((pattern, index) => (
                <li key={index} className="flex items-start gap-2 text-sm" data-testid={`text-pattern-${index}`}>
                  <CheckCircle className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                  {pattern}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                AI Chat
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearChat.mutate()}
                disabled={clearChat.isPending || !chatHistory?.length}
                data-testid="button-clear-chat"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <CardDescription>Ask questions about token analysis and patterns</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-4">
            <ScrollArea className="flex-1 h-[300px] pr-4">
              <div className="space-y-4">
                {chatLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-12 w-3/4" />
                    <Skeleton className="h-12 w-2/3 ml-auto" />
                  </div>
                ) : chatHistory?.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8" data-testid="text-chat-empty-state">
                    <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>Start a conversation with the AI</p>
                    <p className="text-xs mt-2">
                      Try: "What patterns do you see?" or "Which tokens performed best?"
                    </p>
                  </div>
                ) : (
                  <>
                    {chatHistory?.map((msg, index) => (
                      <div
                        key={index}
                        className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                            msg.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          }`}
                          data-testid={`text-chat-message-${index}`}
                        >
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    <div ref={chatEndRef} />
                  </>
                )}
              </div>
            </ScrollArea>

            <div className="flex gap-2">
              <Input
                placeholder="Ask about token patterns..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyPress={handleKeyPress}
                disabled={sendMessage.isPending}
                data-testid="input-chat-message"
              />
              <Button 
                onClick={handleSendMessage} 
                disabled={sendMessage.isPending || !chatInput.trim()}
                data-testid="button-send-chat"
              >
                {sendMessage.isPending ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Recent Token Analysis
            </CardTitle>
            <CardDescription>Latest analyzed tokens with AI scores</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[380px]">
              {snapshotsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-20 w-full" />
                  ))}
                </div>
              ) : !snapshots?.length ? (
                <div className="text-center text-muted-foreground py-8" data-testid="text-snapshots-empty-state">
                  <Brain className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No tokens analyzed yet</p>
                  <p className="text-xs mt-2">Token data will appear when swaps are detected</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {snapshots.slice(0, 10).map((snapshot) => {
                    let analysis: ScoreResult | null = null;
                    try {
                      if (snapshot.aiAnalysis) {
                        analysis = JSON.parse(snapshot.aiAnalysis);
                      }
                    } catch {}

                    return (
                      <div
                        key={snapshot.id}
                        className="border rounded-lg p-3 space-y-2"
                        data-testid={`card-token-snapshot-${snapshot.id}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{snapshot.tokenSymbol}</span>
                            {snapshot.hasTwitter && (
                              <Twitter className="h-3 w-3 text-blue-400" />
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {snapshot.aiScore !== null && snapshot.aiScore !== undefined ? (
                              <Badge className={`${getScoreColor(snapshot.aiScore)} text-white`} data-testid={`badge-score-${snapshot.id}`}>
                                {snapshot.aiScore}/100
                              </Badge>
                            ) : (
                              <Badge variant="secondary" data-testid={`badge-no-score-${snapshot.id}`}>No score</Badge>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => refreshScore.mutate(snapshot.id)}
                              disabled={refreshScore.isPending}
                              data-testid={`button-refresh-score-${snapshot.id}`}
                            >
                              <RefreshCw className={`h-3 w-3 ${refreshScore.isPending ? 'animate-spin' : ''}`} />
                            </Button>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>MC: {formatNumber(snapshot.marketCap)}</span>
                          <span>Liq: {formatNumber(snapshot.liquidity)}</span>
                          {snapshot.tokenAgeMinutes && (
                            <span>Age: {snapshot.tokenAgeMinutes}m</span>
                          )}
                          <span>{formatTimeAgo(snapshot.capturedAt)}</span>
                        </div>

                        {analysis && (
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground" data-testid={`text-reasoning-${snapshot.id}`}>{analysis.reasoning}</p>
                            <div className="flex flex-wrap gap-1">
                              {analysis.greenFlags?.slice(0, 2).map((flag, i) => (
                                <Badge key={i} variant="outline" className="text-xs text-green-500 border-green-500/30" data-testid={`badge-green-flag-${snapshot.id}-${i}`}>
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  {flag}
                                </Badge>
                              ))}
                              {analysis.redFlags?.slice(0, 2).map((flag, i) => (
                                <Badge key={i} variant="outline" className="text-xs text-red-500 border-red-500/30" data-testid={`badge-red-flag-${snapshot.id}-${i}`}>
                                  <AlertCircle className="h-3 w-3 mr-1" />
                                  {flag}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {snapshot.finalMultiplier !== null && snapshot.finalMultiplier !== undefined && (
                          <div className="flex items-center gap-1 text-xs" data-testid={`text-outcome-${snapshot.id}`}>
                            <TrendingUp className="h-3 w-3" />
                            <span className={snapshot.finalMultiplier >= 2 ? "text-green-500" : "text-red-500"}>
                              {snapshot.finalMultiplier.toFixed(2)}x outcome
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
