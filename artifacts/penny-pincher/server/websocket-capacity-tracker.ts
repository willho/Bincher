/**
 * WebSocket Capacity & Load Balancing Tracker
 *
 * Monitors provider overhead metrics (latency, lag, responsiveness) and
 * dynamically balances load between PumpPortal and PumpDev by rotating
 * subscriptions based on quality scores.
 */

interface ProviderMetricsSnapshot {
  provider: string;
  messageLatency: number; // ms, estimated from timestamp lag
  messageBacklog: number; // number of pending messages
  responsiveness: number; // 0-100, inverse of lag
  messageRate: number; // msg/sec
  maxMessageRate: number; // peak observed msg/sec
  overheadPercent: number; // 0-100, utilization level
  healthScore: number; // 0-100, composite health
}

interface SubscriptionScore {
  id: string; // mint or wallet
  type: "token" | "wallet";
  quality: number; // 0-100
  age: number; // ms since subscribed
  lastActivity: number; // ms since last message
  provider: string; // current provider
}

interface LoadBalanceEvent {
  timestamp: number;
  action: "rebalance" | "rotate" | "rebalance_rotate";
  fromProvider: string;
  toProvider: string;
  itemsMoving: string[];
  reason: string;
}

class ProviderMetrics {
  provider: string;
  messageTimestamps: number[] = [];
  lastMessageTime = 0;
  maxMessageRate = 0;
  subscriptionTime: Map<string, number> = new Map(); // subscription -> request time
  firstMessageTime: Map<string, number> = new Map(); // subscription -> first message time

  constructor(provider: string) {
    this.provider = provider;
  }

  recordMessage(timestamp: number): void {
    const now = Date.now();
    this.messageTimestamps.push(now);

    // Keep last 60 seconds of messages
    if (this.messageTimestamps.length > 1000) {
      this.messageTimestamps = this.messageTimestamps.slice(-1000);
    }

    this.lastMessageTime = now;
  }

  recordSubscription(key: string): void {
    this.subscriptionTime.set(key, Date.now());
  }

  recordFirstMessage(key: string, timestamp: number): void {
    const subTime = this.subscriptionTime.get(key);
    if (subTime) {
      this.firstMessageTime.set(key, timestamp - subTime);
    }
  }

  getMetrics(): ProviderMetricsSnapshot {
    const now = Date.now();
    const recentMs = this.messageTimestamps.filter(t => t > now - 60000);

    // Calculate message rate (msg/sec over last 60s)
    const messageRate = recentMs.length > 1
      ? (recentMs.length / 60)
      : 0;

    // Update max seen
    if (messageRate > this.maxMessageRate) {
      this.maxMessageRate = messageRate;
    }

    // Estimate latency from message timestamp spread
    let latency = 0;
    if (recentMs.length > 10) {
      const spread = recentMs[recentMs.length - 1] - recentMs[0];
      latency = spread > 0 ? spread / recentMs.length : 0;
    }

    // Responsiveness (inverse of latency, 0-100 scale)
    const responsiveness = Math.max(0, Math.min(100, 100 - (latency / 100)));

    // Overhead percent (utilization relative to max seen)
    const overheadPercent = this.maxMessageRate > 0
      ? Math.min(100, (messageRate / this.maxMessageRate) * 100)
      : 0;

    // Health score (weighted composite)
    const healthScore = (responsiveness * 0.6) + ((100 - overheadPercent) * 0.4);

    // Message backlog (estimated pending)
    const timeSinceLastMsg = now - this.lastMessageTime;
    const backlog = timeSinceLastMsg > 5000 ? 1 : 0; // Flag if no message for 5s

    return {
      provider: this.provider,
      messageLatency: Math.round(latency),
      messageBacklog: backlog,
      responsiveness: Math.round(responsiveness),
      messageRate: Math.round(messageRate * 10) / 10,
      maxMessageRate: Math.round(this.maxMessageRate * 10) / 10,
      overheadPercent: Math.round(overheadPercent),
      healthScore: Math.round(healthScore),
    };
  }
}

class SubscriptionRotator {
  subscriptions: Map<string, SubscriptionScore> = new Map();
  rotationLog: LoadBalanceEvent[] = [];
  maxRotationLog = 100;

  addSubscription(
    id: string,
    type: "token" | "wallet",
    quality: number,
    provider: string
  ): void {
    this.subscriptions.set(id, {
      id,
      type,
      quality,
      age: 0,
      lastActivity: Date.now(),
      provider,
    });
  }

  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
  }

  updateLastActivity(id: string): void {
    const sub = this.subscriptions.get(id);
    if (sub) {
      sub.lastActivity = Date.now();
    }
  }

  /**
   * Rank subscriptions by quality score
   * Top 70% (highest quality + newest) stay, bottom 30% eligible for rotation
   */
  getRankings(): SubscriptionScore[] {
    const now = Date.now();

    // Update age
    for (const sub of this.subscriptions.values()) {
      sub.age = now - sub.lastActivity;
    }

    // Sort by quality (descending) then age (ascending)
    return Array.from(this.subscriptions.values()).sort((a, b) => {
      if (b.quality !== a.quality) {
        return b.quality - a.quality;
      }
      return a.age - b.age;
    });
  }

  /**
   * Get subscriptions to rotate out (bottom 30%)
   */
  getRotationCandidates(percentToRotate = 30): SubscriptionScore[] {
    const rankings = this.getRankings();
    const rotateCount = Math.ceil((rankings.length * percentToRotate) / 100);
    return rankings.slice(-rotateCount);
  }

  /**
   * Get subscriptions that should move based on provider balance
   */
  getRebalanceCandidates(
    fromProvider: string,
    toProvider: string,
    maxToMove = 20
  ): SubscriptionScore[] {
    const candidates = Array.from(this.subscriptions.values())
      .filter(s => s.provider === fromProvider)
      .sort((a, b) => a.quality - b.quality) // Move lowest quality first
      .slice(0, maxToMove);

    return candidates;
  }

  /**
   * Record a load balancing event
   */
  recordEvent(event: LoadBalanceEvent): void {
    this.rotationLog.push(event);
    if (this.rotationLog.length > this.maxRotationLog) {
      this.rotationLog.shift();
    }
  }

  /**
   * Get recent rotation log for dashboard
   */
  getRecentEvents(count = 20): LoadBalanceEvent[] {
    return this.rotationLog.slice(-count);
  }
}

class LoadBalancer {
  ppMetrics: ProviderMetrics;
  pdMetrics: ProviderMetrics;
  rotator: SubscriptionRotator;
  thresholds = {
    overloadThreshold: 80, // Provider is overloaded at 80% overhead
    capacityThreshold: 40, // Provider has capacity below 40% overhead
    rebalanceCheckIntervalMs: 30000, // Check every 30 seconds
    rotationIntervalMs: 60000, // Rotate every 60 seconds
  };

  private rebalanceTimer: ReturnType<typeof setInterval> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.ppMetrics = new ProviderMetrics("PumpPortal");
    this.pdMetrics = new ProviderMetrics("PumpDev");
    this.rotator = new SubscriptionRotator();
  }

  /**
   * Start load balancing monitoring
   */
  start(): void {
    // Check for rebalancing needs every 30 seconds
    this.rebalanceTimer = setInterval(() => {
      this.checkAndRebalance();
    }, this.thresholds.rebalanceCheckIntervalMs);

    // Rotate subscriptions every 60 seconds
    this.rotationTimer = setInterval(() => {
      this.rotateSubscriptions();
    }, this.thresholds.rotationIntervalMs);

    console.log("[LoadBalancer] Started with rebalance check every 30s, rotation every 60s");
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.rebalanceTimer) clearInterval(this.rebalanceTimer);
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rebalanceTimer = null;
    this.rotationTimer = null;
  }

  /**
   * Check if rebalancing is needed based on provider overhead
   */
  private checkAndRebalance(): void {
    const ppMetrics = this.ppMetrics.getMetrics();
    const pdMetrics = this.pdMetrics.getMetrics();

    const ppOverloaded = ppMetrics.overheadPercent > this.thresholds.overloadThreshold;
    const ppHasCapacity = ppMetrics.overheadPercent < this.thresholds.capacityThreshold;
    const pdOverloaded = pdMetrics.overheadPercent > this.thresholds.overloadThreshold;
    const pdHasCapacity = pdMetrics.overheadPercent < this.thresholds.capacityThreshold;

    // Rebalance if one is overloaded and other has capacity
    if (ppOverloaded && pdHasCapacity) {
      this.rebalanceToProvider("PumpPortal", "PumpDev");
    } else if (pdOverloaded && ppHasCapacity) {
      this.rebalanceToProvider("PumpDev", "PumpPortal");
    }
  }

  /**
   * Move subscriptions from overloaded to capacity provider
   */
  private rebalanceToProvider(fromProvider: string, toProvider: string): void {
    const candidates = this.rotator.getRebalanceCandidates(fromProvider, toProvider, 20);

    if (candidates.length === 0) return;

    const itemsMoving = candidates.map(c => c.id);

    // Update rotator
    for (const sub of candidates) {
      sub.provider = toProvider;
    }

    // Record event
    this.rotator.recordEvent({
      timestamp: Date.now(),
      action: "rebalance",
      fromProvider,
      toProvider,
      itemsMoving,
      reason: `${fromProvider} overloaded, ${toProvider} has capacity`,
    });

    console.log(
      `[LoadBalancer] Rebalanced ${itemsMoving.length} subscriptions from ${fromProvider} to ${toProvider}`
    );

    // Emit rebalance event
    this.onRebalance?.({
      fromProvider,
      toProvider,
      items: itemsMoving,
    });
  }

  /**
   * Rotate out low-quality subscriptions to make room for new discoveries
   */
  private rotateSubscriptions(): void {
    const candidates = this.rotator.getRotationCandidates(30); // Rotate bottom 30%

    if (candidates.length === 0) return;

    const itemsToRemove = candidates.map(c => c.id);

    // Remove from rotator
    for (const id of itemsToRemove) {
      this.rotator.removeSubscription(id);
    }

    // Record event
    this.rotator.recordEvent({
      timestamp: Date.now(),
      action: "rotate",
      fromProvider: "",
      toProvider: "",
      itemsMoving: itemsToRemove,
      reason: "Rotation cycle: removing low-quality/old subscriptions",
    });

    console.log(`[LoadBalancer] Rotated out ${itemsToRemove.length} low-quality subscriptions`);

    // Emit rotation event
    this.onRotation?.({
      removed: itemsToRemove,
    });
  }

  /**
   * Get current load balance status
   */
  getStatus() {
    const ppMetrics = this.ppMetrics.getMetrics();
    const pdMetrics = this.pdMetrics.getMetrics();

    const subscriptionsByProvider = {
      pumpportal: Array.from(this.rotator.subscriptions.values())
        .filter(s => s.provider === "PumpPortal")
        .length,
      pumpdev: Array.from(this.rotator.subscriptions.values())
        .filter(s => s.provider === "PumpDev")
        .length,
    };

    return {
      timestamp: Date.now(),
      providers: {
        pumpportal: ppMetrics,
        pumpdev: pdMetrics,
      },
      subscriptions: subscriptionsByProvider,
      totalSubscriptions: this.rotator.subscriptions.size,
      recentEvents: this.rotator.getRecentEvents(5),
    };
  }

  // Event emitters
  onRebalance?: (data: { fromProvider: string; toProvider: string; items: string[] }) => void;
  onRotation?: (data: { removed: string[] }) => void;
}

// Singleton
let instance: LoadBalancer | null = null;

export function getLoadBalancer(): LoadBalancer {
  if (!instance) {
    instance = new LoadBalancer();
  }
  return instance;
}

export function startLoadBalancing(): void {
  const lb = getLoadBalancer();
  lb.start();
}

export function stopLoadBalancing(): void {
  if (instance) {
    instance.stop();
  }
}

export { ProviderMetrics, SubscriptionRotator, LoadBalancer };
