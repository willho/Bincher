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
    
    const { startCleanupScheduler } = await import("./discovery-worker");
    startCleanupScheduler();
    
    const { startComputeScheduler } = await import("./compute-manager");
    startComputeScheduler();
    
    const { memoryCache } = await import("./memory-cache");
    await memoryCache.warmUp(500);
    memoryCache.start();
    
    const { startBatchedDexScreenerRefresh } = await import("./data-pool");
    startBatchedDexScreenerRefresh();
    
    const { startCompressionScheduler } = await import("./storage-bucketing");
    startCompressionScheduler();
    
    const { initEventBus } = await import("./discovery-event-bus");
    initEventBus();
    
    const { startGeckoScheduler } = await import("./gecko-terminal");
    startGeckoScheduler();
    
    const { startBoostFetcher, startDailySnapshotJob } = await import("./dex-boosts");
    startBoostFetcher();
    startDailySnapshotJob();
    
    const { startSummaryJobs } = await import("./summary-jobs");
    startSummaryJobs();
    
    const { startOptimizer } = await import("./discovery-optimizer");
    startOptimizer();
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
})();
