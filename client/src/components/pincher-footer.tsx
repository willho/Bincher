import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Shell, Send, X, Minus, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function getPageContext(pathname: string): string {
  if (pathname === "/" || pathname === "/dashboard") return "dashboard";
  if (pathname === "/watchlist") return "watchlist";
  if (pathname.startsWith("/trading/")) return `token:${pathname.split("/")[2]}`;
  if (pathname === "/trading") return "trading";
  if (pathname === "/settings") return "settings";
  return "unknown";
}

function getPageLabel(context: string): string {
  if (context === "dashboard") return "Dashboard";
  if (context === "watchlist") return "Watchlist";
  if (context === "trading") return "Trading";
  if (context === "settings") return "Settings";
  if (context.startsWith("token:")) return "Token";
  return context;
}

export function PincherFooter() {
  const [location] = useLocation();
  const [isExpanded, setIsExpanded] = useState(true);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pageContext = getPageContext(location);

  const { data: chatHistory, isLoading } = useQuery<ChatMessage[]>({
    queryKey: ["/api/ai/chat"],
    refetchInterval: isExpanded ? 5000 : false,
  });

  const { data: welcomeMessage } = useQuery<{ message: string }>({
    queryKey: ["/api/ai/welcome"],
    enabled: !isLoading && (!chatHistory || chatHistory.length === 0),
    staleTime: Infinity,
  });

  const sendMessage = useMutation({
    mutationFn: (message: string) => 
      apiRequest("POST", "/api/ai/chat", { message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat"] });
      setInput("");
    },
  });

  const clearChat = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/ai/chat"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/welcome"] });
    },
  });

  useEffect(() => {
    if (isExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatHistory, isExpanded]);

  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sendMessage.isPending) return;
    sendMessage.mutate(input.trim());
  };

  const hasMessages = chatHistory && chatHistory.length > 0;

  if (!isExpanded) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Button
          size="lg"
          onClick={() => setIsExpanded(true)}
          className="rounded-full shadow-lg"
          data-testid="button-pincher-open"
        >
          <Shell className="h-5 w-5" />
        </Button>
      </div>
    );
  }

  return (
    <div 
      className="fixed bottom-4 right-4 z-50 w-80 sm:w-96 bg-card border rounded-lg shadow-2xl flex flex-col"
      style={{ height: "min(500px, 60vh)" }}
      data-testid="pincher-chat-container"
    >
      <div className="flex items-center justify-between gap-2 p-3 border-b bg-muted/30 rounded-t-lg">
        <div className="flex items-center gap-2">
          <Shell className="h-5 w-5 text-primary" />
          <span className="font-semibold">Miss Pincher</span>
          <Badge variant="outline" className="text-xs">
            {getPageLabel(pageContext)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {hasMessages && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => clearChat.mutate()}
              disabled={clearChat.isPending}
              data-testid="button-clear-chat"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(false)}
            data-testid="button-pincher-minimize"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(false)}
            data-testid="button-pincher-close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div 
        ref={scrollRef}
        className="flex-1 p-3 overflow-auto"
      >
        <div className="space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !hasMessages && welcomeMessage ? (
            <div className="flex gap-2" data-testid="message-welcome">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Shell className="h-4 w-4 text-primary" />
              </div>
              <div className="bg-muted rounded-lg p-3 max-w-[85%]">
                <p className="text-sm whitespace-pre-wrap">{welcomeMessage.message}</p>
              </div>
            </div>
          ) : !hasMessages ? (
            <div className="flex gap-2" data-testid="message-default">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Shell className="h-4 w-4 text-primary" />
              </div>
              <div className="bg-muted rounded-lg p-3 max-w-[85%]">
                <p className="text-sm">
                  Hey. What do you need? I'm watching the {pageContext === "dashboard" ? "charts" : pageContext}.
                </p>
              </div>
            </div>
          ) : (
            chatHistory?.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-2",
                  msg.role === "user" && "flex-row-reverse"
                )}
                data-testid={`message-${msg.role}-${i}`}
              >
                {msg.role === "assistant" && (
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Shell className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div
                  className={cn(
                    "rounded-lg p-3 max-w-[85%]",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
              </div>
            ))
          )}
          {sendMessage.isPending && (
            <div className="flex gap-2" data-testid="message-loading">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Shell className="h-4 w-4 text-primary" />
              </div>
              <div className="bg-muted rounded-lg p-3">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-3 border-t">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Miss Pincher..."
            disabled={sendMessage.isPending}
            data-testid="input-pincher-message"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!input.trim() || sendMessage.isPending}
            data-testid="button-pincher-send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}
