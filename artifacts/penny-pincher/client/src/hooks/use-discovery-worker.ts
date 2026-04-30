import { useEffect, useRef, useCallback, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface DiscoveryTask {
  id: number;
  type: string;
  payload: { mint?: string; walletAddress?: string };
  ttlSeconds: number;
}

interface DiscoveryWorkerState {
  isActive: boolean;
  currentTask: DiscoveryTask | null;
  tasksCompleted: number;
  tasksFailed: number;
  lastError: string | null;
}

const POLL_INTERVAL_MS = 5000;
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";
const HELIUS_DEVNET_URL = "https://devnet.helius-rpc.com";

export function useDiscoveryWorker(
  heliusApiKey: string | null, 
  enabled: boolean = true,
  networkMode: "mainnet" | "devnet" = "mainnet"
) {
  const [state, setState] = useState<DiscoveryWorkerState>({
    isActive: false,
    currentTask: null,
    tasksCompleted: 0,
    tasksFailed: 0,
    lastError: null,
  });
  
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isProcessingRef = useRef(false);

  const fetchTokenMetadata = useCallback(async (mint: string): Promise<{
    name?: string;
    symbol?: string;
    decimals?: number;
    image?: string;
  } | null> => {
    if (!heliusApiKey) {
      throw new Error("No Helius API key");
    }

    const baseUrl = networkMode === "devnet" ? HELIUS_DEVNET_URL : HELIUS_MAINNET_URL;
    const response = await fetch(`${baseUrl}/?api-key=${heliusApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discovery-worker",
        method: "getAsset",
        params: { id: mint },
      }),
    });

    if (!response.ok) {
      throw new Error(`Helius API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message || "Unknown Helius error");
    }

    if (!data.result) {
      return null;
    }

    const asset = data.result;
    return {
      name: asset.content?.metadata?.name,
      symbol: asset.content?.metadata?.symbol,
      decimals: asset.token_info?.decimals,
      image: asset.content?.links?.image,
    };
  }, [heliusApiKey, networkMode]);

  const processTask = useCallback(async (task: DiscoveryTask) => {
    try {
      let result = null;

      if (task.type === "token_metadata" && task.payload.mint) {
        result = await fetchTokenMetadata(task.payload.mint);
      }

      await apiRequest("POST", `/api/discovery/task/${task.id}/complete`, {
        result: result || {},
      });

      setState(prev => ({
        ...prev,
        currentTask: null,
        tasksCompleted: prev.tasksCompleted + 1,
        lastError: null,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      try {
        await apiRequest("POST", `/api/discovery/task/${task.id}/complete`, {
          error: errorMessage,
        });
      } catch {
      }

      setState(prev => ({
        ...prev,
        currentTask: null,
        tasksFailed: prev.tasksFailed + 1,
        lastError: errorMessage,
      }));
    }
  }, [fetchTokenMetadata]);

  const pollForTask = useCallback(async () => {
    if (isProcessingRef.current || !heliusApiKey) return;

    try {
      isProcessingRef.current = true;
      
      const response = await fetch("/api/discovery/task", {
        credentials: "include",
      });
      
      if (!response.ok) return;
      
      const data = await response.json();
      
      if (data.task) {
        setState(prev => ({ ...prev, currentTask: data.task }));
        await processTask(data.task);
      }
    } catch (error) {
      console.error("[DiscoveryWorker] Poll error:", error);
    } finally {
      isProcessingRef.current = false;
    }
  }, [heliusApiKey, processTask]);

  useEffect(() => {
    if (!enabled || !heliusApiKey) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setState(prev => ({ ...prev, isActive: false }));
      return;
    }

    setState(prev => ({ ...prev, isActive: true }));
    
    pollForTask();
    
    pollIntervalRef.current = setInterval(pollForTask, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [enabled, heliusApiKey, pollForTask]);

  return state;
}
