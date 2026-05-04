import { useEffect, useRef, useCallback, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface ComputeTask {
  id: number;
  taskType: string;
  payload: Record<string, unknown>;
  ttlSeconds: number;
  priority: number;
}

interface ComputeWorkerState {
  isActive: boolean;
  currentTask: ComputeTask | null;
  tasksCompleted: number;
  tasksFailed: number;
  trustScore: number;
  lastError: string | null;
  supportedTypes: string[];
}

const POLL_INTERVAL_MS = 5000;
const CONFIG_REFRESH_MS = 300000;

export function useComputeWorker(enabled: boolean = true) {
  const [state, setState] = useState<ComputeWorkerState>({
    isActive: false,
    currentTask: null,
    tasksCompleted: 0,
    tasksFailed: 0,
    trustScore: 0.5,
    lastError: null,
    supportedTypes: [],
  });

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const configIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isProcessingRef = useRef(false);
  const supportedTypesRef = useRef<string[]>([]);

  const fetchWorkerConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/compute/worker-config", {
        credentials: "include",
      });
      if (!response.ok) return;
      const config = await response.json();
      supportedTypesRef.current = config.supportedTaskTypes || ["price_slope"];
      setState(prev => ({ ...prev, supportedTypes: supportedTypesRef.current }));
    } catch {
    }
  }, []);

  const executeTask = useCallback(async (task: ComputeTask): Promise<Record<string, unknown>> => {
    const startTime = Date.now();

    switch (task.taskType) {
      case "price_slope": {
        const mint = task.payload.tokenMint as string;
        if (!mint) return { error: "No tokenMint in payload" };

        const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`, {
          headers: { "Accept": "application/json" },
        });

        if (!response.ok) {
          return { error: `GeckoTerminal error: ${response.status}`, computeTimeMs: Date.now() - startTime };
        }

        const data = await response.json();
        const attrs = data?.data?.attributes;

        return {
          tokenMint: mint,
          priceUsd: parseFloat(attrs?.price_usd || "0"),
          volume24h: parseFloat(attrs?.volume_usd?.h24 || "0"),
          priceChange24h: parseFloat(attrs?.price_change_percentage?.h24 || "0"),
          marketCap: parseFloat(attrs?.market_cap_usd || "0"),
          fdv: parseFloat(attrs?.fdv_usd || "0"),
          computeTimeMs: Date.now() - startTime,
        };
      }

      default:
        return { error: `Unsupported task type: ${task.taskType}`, computeTimeMs: Date.now() - startTime };
    }
  }, []);

  const processTask = useCallback(async (task: ComputeTask) => {
    const startTime = Date.now();
    try {
      const result = await executeTask(task);
      const computeTimeMs = Date.now() - startTime;

      await apiRequest("POST", `/api/compute/task/${task.id}/complete`, {
        result,
        computeTimeMs,
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
        await apiRequest("POST", `/api/compute/task/${task.id}/fail`, {
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
  }, [executeTask]);

  const pollForTask = useCallback(async () => {
    if (isProcessingRef.current) return;

    try {
      isProcessingRef.current = true;

      const types = supportedTypesRef.current;
      const typesParam = types.length > 0 ? `?types=${types.join(",")}` : "";
      const response = await fetch(`/api/compute/task${typesParam}`, {
        credentials: "include",
      });

      if (!response.ok) return;

      const data = await response.json();

      if (data.trustScore !== undefined) {
        setState(prev => ({ ...prev, trustScore: data.trustScore }));
      }

      if (data.task) {
        setState(prev => ({ ...prev, currentTask: data.task }));
        await processTask(data.task);
      }
    } catch {
    } finally {
      isProcessingRef.current = false;
    }
  }, [processTask]);

  useEffect(() => {
    if (!enabled) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (configIntervalRef.current) {
        clearInterval(configIntervalRef.current);
        configIntervalRef.current = null;
      }
      setState(prev => ({ ...prev, isActive: false }));
      return;
    }

    setState(prev => ({ ...prev, isActive: true }));

    fetchWorkerConfig();
    configIntervalRef.current = setInterval(fetchWorkerConfig, CONFIG_REFRESH_MS);

    const startPolling = setTimeout(() => {
      pollForTask();
      pollIntervalRef.current = setInterval(pollForTask, POLL_INTERVAL_MS);
    }, 2000);

    return () => {
      clearTimeout(startPolling);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (configIntervalRef.current) {
        clearInterval(configIntervalRef.current);
        configIntervalRef.current = null;
      }
    };
  }, [enabled, pollForTask, fetchWorkerConfig]);

  return state;
}
