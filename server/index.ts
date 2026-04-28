import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  let dbAvailable = false;
  try {
    await storage.initialize();
    console.log("Database initialized");
    dbAvailable = true;

    // Run startup wizard - verify proxies and APIs
    const { runStartupWizard } = await import("./startup-wizard");
    const wizardSuccess = await runStartupWizard();

    if (!wizardSuccess) {
      console.error("Startup wizard failed - proxies not connected or verification failed");
      console.error("Blocking application startup. Please verify proxy connections.");
      process.exit(1);
    }

    // Initialize Phase 1: 3-Server Mesh Infrastructure
    const { initializePhase1Infrastructure, phase1MaintenanceTask } = await import("./phase1-infrastructure");
    const shyftApiKey = process.env.SHYFT_API_KEY || "";

    if (shyftApiKey) {
      try {
        await initializePhase1Infrastructure(shyftApiKey);

        // Schedule periodic maintenance
        setInterval(phase1MaintenanceTask, 5 * 60 * 1000); // Every 5 minutes
      } catch (error) {
        console.warn("Phase 1 infrastructure initialization failed, continuing without it:", error);
      }
    } else {
      console.warn("SHYFT_API_KEY not set, Phase 1 infrastructure will not be initialized");
    }

    const { startCleanupScheduler } = await import("./discovery-worker");
    startCleanupScheduler();
    
    const { startComputeScheduler } = await import("./compute-manager");
    startComputeScheduler();
    
    const { memoryCache } = await import("./memory-cache");
    await memoryCache.warmUp(500);
    memoryCache.start();
    
    const { startBatchedDexScreenerRefresh } = await import("./data-pool");
    startBatchedDexScreenerRefresh();
    
    const { startIconScheduler } = await import("./icon-resolver");
    startIconScheduler();
    
    const { startCompressionScheduler } = await import("./storage-bucketing");
    startCompressionScheduler();
    
    const { initEventBus } = await import("./discovery-event-bus");
    initEventBus();
    
    const { registerDiscoveryPaperTradingHandlers } = await import("./discovery-paper-trading");
    registerDiscoveryPaperTradingHandlers();
    
    const { startGeckoScheduler } = await import("./gecko-terminal");
    startGeckoScheduler();
    
    const { startBoostFetcher, startDailySnapshotJob } = await import("./dex-boosts");
    startBoostFetcher();
    startDailySnapshotJob();
    
    const { startSummaryJobs } = await import("./summary-jobs");
    startSummaryJobs();
    
    const { startOptimizer } = await import("./discovery-optimizer");
    startOptimizer();
    
    const { startSocialEvaluationJob } = await import("./social-signals");
    startSocialEvaluationJob();
    
    const { startPincherScoringJob } = await import("./pincher-scoring");
    startPincherScoringJob();
    
    const { startPositionMonitorJob } = await import("./paper-trading");
    startPositionMonitorJob();
    
    const { startPaperAutoClose } = await import("./paper-autoclose");
    startPaperAutoClose();
    
    const { initializeWhaleTracker } = await import("./whale-tracker");
    initializeWhaleTracker();

    // Start log maintenance (hourly bucket compaction and pruning)
    const { startLogMaintenance } = await import("./log-buckets");
    startLogMaintenance(60 * 60 * 1000); // Run every hour

    // Initialize Pump SDK for graduation detection
    const { initializePumpSdk } = await import("./pump-sdk-client");
    await initializePumpSdk();

    const { startPumpFunMonitoring } = await import("./pumpfun-bonding-curve");
    startPumpFunMonitoring();

    const { startGraduationTracking } = await import("./graduation-tracker");
    startGraduationTracking();

    // Start real-time graduation progress monitoring
    const { startGraduationMonitor } = await import("./graduation-monitor");
    startGraduationMonitor();

    const { startRaydiumPoolDiscovery } = await import("./raydium-pool-discovery");
    startRaydiumPoolDiscovery();

    const { startRetrolearner } = await import("./retrolearner");
    startRetrolearner();

    const { startSystemPicks } = await import("./system-picks");
    startSystemPicks();

    const { startRetrolearnerV2 } = await import("./retrolearner-v2");
    startRetrolearnerV2();

    const { startSystemPicksV2 } = await import("./system-picks-v2");
    startSystemPicksV2();

    const { startTokenLifecycleLearning } = await import("./token-lifecycle-learning");
    startTokenLifecycleLearning();
  } catch (error) {
    console.error("Database connection failed:", error instanceof Error ? error.message : error);
    console.log("Application starting in limited mode - database features unavailable");
    console.log("To fix: Enable your Neon database endpoint at https://console.neon.tech");
  }
  
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  // Graceful shutdown handler for Phase 1 infrastructure
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down gracefully...");
    try {
      const { shutdownPhase1Infrastructure } = await import("./phase1-infrastructure");
      await shutdownPhase1Infrastructure();
    } catch (error) {
      console.error("Error during Phase 1 shutdown:", error);
    }
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("SIGINT received, shutting down gracefully...");
    try {
      const { shutdownPhase1Infrastructure } = await import("./phase1-infrastructure");
      await shutdownPhase1Infrastructure();
    } catch (error) {
      console.error("Error during Phase 1 shutdown:", error);
    }
    process.exit(0);
  });
})();
