import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Filter,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trash2,
  Waves,
  Zap,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface TokenEvent {
  id: number;
  tokenMint: string;
  tokenSymbol: string;
  eventType: string;
  priority: string;
  title: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: number;
  priceAtEvent?: number;
  valueUsd?: number;
  relatedWallet?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface UserPreferences {
  minValueThreshold: number;
  mutedTokens: string[];
  focusWallets: string[];
  summaryFocus: string | null;
  pinchEmailsEnabled: boolean;
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function getEventIcon(eventType: string) {
  switch (eventType) {
    case "price_swing":
      return <Waves className="h-4 w-4" />;
    case "milestone":
      return <Sparkles className="h-4 w-4" />;
    case "lp_change":
      return <TrendingDown className="h-4 w-4" />;
    case "whale_move":
      return <Zap className="h-4 w-4" />;
    case "holder_change":
      return <TrendingUp className="h-4 w-4" />;
    default:
      return <AlertTriangle className="h-4 w-4" />;
  }
}

function getPriorityColor(priority: string): string {
  switch (priority) {
    case "critical":
      return "bg-red-500 text-white";
    case "high":
      return "bg-orange-500 text-white";
    case "normal":
      return "bg-blue-500 text-white";
    case "low":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted";
  }
}

const SUMMARY_COOLDOWN_MS = 60000;

export function AIInsights() {
  const { toast } = useToast();
  const [chatInput, setChatInput] = useState("");
  const [timeFilter, setTimeFilter] = useState("all");
  const [tokenFilter, setTokenFilter] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [hasAutoSummarized, setHasAutoSummarized] = useState(false);
  const [lastAutoSummarizeFilters, setLastAutoSummarizeFilters] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (cooldownUntil > Date.now()) {
      const interval = setInterval(() => {
        setNow(Date.now());
        if (Date.now() >= cooldownUntil) {
          clearInterval(interval);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [cooldownUntil]);

  const buildEventsUrl = () => {
    const params = new URLSearchParams();
    if (timeFilter !== "all") {
      params.set("sinceMinutes", timeFilter);
    }
    if (tokenFilter.trim()) {
      params.set("token", tokenFilter.trim());
    }
    const queryString = params.toString();
    return queryString ? `/api/ai/events?${queryString}` : "/api/ai/events";
  };

  const { data: events, isLoading: eventsLoading, refetch: refetchEvents } = useQuery<TokenEvent[]>({
    queryKey: ["/api/ai/events", timeFilter, tokenFilter],
    queryFn: async () => {
      const response = await fetch(buildEventsUrl(), { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch events");
      return response.json();
    },
    refetchInterval: 30000,
  });

  const { data: chatHistory, isLoading: chatLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/ai/chat"],
  });

  const { data: welcomeMessage } = useQuery<{ message: string }>({
    queryKey: ["/api/ai/welcome"],
    enabled: !chatLoading && (!chatHistory || chatHistory.length === 0),
    staleTime: Infinity,
  });

  const { data: preferences } = useQuery<UserPreferences>({
    queryKey: ["/api/ai/preferences"],
  });

  const canSummarize = now >= cooldownUntil;
  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

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
      queryClient.invalidateQueries({ queryKey: ["/api/ai/welcome"] });
      toast({ description: "Chat history cleared" });
    },
  });

  const summarizeEvents = useMutation({
    mutationFn: (customPrompt?: string) => {
      const eventCount = events?.length ?? 0;
      const filterDesc = tokenFilter 
        ? `filtered for "${tokenFilter}"` 
        : timeFilter !== "all" 
          ? `from the last ${timeFilter === "60" ? "hour" : timeFilter === "360" ? "6 hours" : "24 hours"}`
          : "all";
      const prompt = customPrompt || `Summarize the ${eventCount} events I'm seeing (${filterDesc}). What patterns do you notice? Any concerns or opportunities?`;
      return apiRequest("POST", "/api/ai/chat", { message: prompt });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat"] });
      setCooldownUntil(Date.now() + SUMMARY_COOLDOWN_MS);
      toast({ description: "Pincher is analyzing..." });
    },
    onError: () => {
      toast({ description: "Failed to summarize", variant: "destructive" });
    },
  });

  const currentFilters = `${timeFilter}:${tokenFilter}`;
  
  useEffect(() => {
    if (lastAutoSummarizeFilters !== currentFilters) {
      setHasAutoSummarized(false);
      setLastAutoSummarizeFilters(currentFilters);
    }
  }, [currentFilters, lastAutoSummarizeFilters]);

  useEffect(() => {
    if (
      !hasAutoSummarized &&
      !eventsLoading &&
      !chatLoading &&
      !summarizeEvents.isPending &&
      canSummarize &&
      events &&
      chatHistory &&
      chatHistory.length === 0
    ) {
      const highPriorityCount = events.filter(e => e.priority === "high" || e.priority === "critical").length;
      const shouldSummarize = highPriorityCount > 0 || events.length >= 5;
      
      if (shouldSummarize) {
        setHasAutoSummarized(true);
        setLastAutoSummarizeFilters(currentFilters);
        const prompt = `I just opened AI Insights and see ${events.length} events (${highPriorityCount} high priority). Give me a quick rundown of what's happening.`;
        summarizeEvents.mutate(prompt);
      }
    }
  }, [events, eventsLoading, chatHistory, chatLoading, canSummarize, hasAutoSummarized, summarizeEvents.isPending, currentFilters]);

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

  const displayEvents = events || [];

  return (
    <div className="h-[calc(100vh-180px)] flex flex-col lg:flex-row gap-4">
      <Card className="flex-1 flex flex-col min-h-0 lg:max-w-md" data-testid="card-events-panel">
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4" />
              Activity Feed
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => summarizeEvents.mutate(undefined)}
                disabled={summarizeEvents.isPending || !canSummarize || eventsLoading || !events?.length}
                title={!canSummarize ? `Wait ${cooldownRemaining}s` : "Ask Pincher to summarize"}
                data-testid="button-summarize-events"
              >
                {summarizeEvents.isPending ? (
                  <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Summarize
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => refetchEvents()}
                data-testid="button-refresh-events"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Select value={timeFilter} onValueChange={setTimeFilter}>
              <SelectTrigger className="h-8 text-xs w-24" data-testid="select-time-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="360">6 hours</SelectItem>
                <SelectItem value="1440">24 hours</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Filter token..."
              value={tokenFilter}
              onChange={(e) => setTokenFilter(e.target.value)}
              className="h-8 text-xs flex-1"
              data-testid="input-token-filter"
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 pb-3">
          <ScrollArea className="h-full pr-2">
            {eventsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : displayEvents.length === 0 ? (
              <div className="text-center text-muted-foreground py-12" data-testid="text-events-empty">
                <Zap className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">No events yet</p>
                <p className="text-xs mt-1">Activity will appear here as tokens move</p>
              </div>
            ) : (
              <div className="space-y-2">
                {displayEvents.map((event) => (
                  <div
                    key={event.id}
                    className="border rounded-lg p-3 hover-elevate cursor-pointer"
                    data-testid={`event-item-${event.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className={`p-1.5 rounded ${getPriorityColor(event.priority)}`}>
                          {getEventIcon(event.eventType)}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-xs font-mono px-1.5">
                              {event.tokenSymbol}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatTimeAgo(event.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm font-medium mt-0.5">{event.title}</p>
                        </div>
                      </div>
                      {event.valueUsd && (
                        <span className="text-xs font-medium text-muted-foreground">
                          {formatValue(event.valueUsd)}
                        </span>
                      )}
                    </div>
                    {event.description && (
                      <p className="text-xs text-muted-foreground mt-2 pl-9">
                        {event.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="flex-[1.5] flex flex-col min-h-0" data-testid="card-chat-panel">
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="h-4 w-4" />
                Miss Pincher
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Your jaded trading advisor
              </CardDescription>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => clearChat.mutate()}
              disabled={clearChat.isPending || !chatHistory?.length}
              data-testid="button-clear-chat"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col gap-3 min-h-0 pb-3">
          <ScrollArea className="flex-1 pr-3">
            <div className="space-y-3">
              {chatLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-3/4" />
                  <Skeleton className="h-12 w-2/3 ml-auto" />
                </div>
              ) : chatHistory?.length === 0 && welcomeMessage ? (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted" data-testid="text-welcome-message">
                    {welcomeMessage.message}
                  </div>
                </div>
              ) : chatHistory?.length === 0 ? (
                <div className="text-center text-muted-foreground py-8" data-testid="text-chat-empty-state">
                  <Bot className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">Loading Pincher...</p>
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
              {sendMessage.isPending && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="flex gap-2 flex-shrink-0">
            <Input
              placeholder="Ask Pincher about your tokens..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={sendMessage.isPending}
              className="flex-1"
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

          {preferences && (preferences.mutedTokens?.length > 0 || preferences.summaryFocus) && (
            <div className="flex flex-wrap gap-1 text-xs text-muted-foreground flex-shrink-0">
              {preferences.summaryFocus && (
                <Badge variant="outline" className="text-xs">
                  Focus: {preferences.summaryFocus}
                </Badge>
              )}
              {preferences.mutedTokens?.map(token => (
                <Badge key={token} variant="secondary" className="text-xs">
                  Muted: {token}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
