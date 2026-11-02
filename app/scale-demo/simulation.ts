export type SimulationConfig = {
  incomingPerSecond: number;
  cacheHitPercent: number;
  globalLimitPerMinute: number;
  maxQueueSize: number;
};

export type SimulationTick = {
  second: number;
  incoming: number;
  cached: number;
  sent: number;
  queued: number;
  rejected: number;
};

export type SimulationResult = {
  config: SimulationConfig;
  totalIncoming: number;
  servedFromCache: number;
  sentToParallel: number;
  queued: number;
  rejected: number;
  estimatedQueueWaitSeconds: number | null;
  utilizationPercent: number;
  ticks: SimulationTick[];
};

export function simulateTraffic(config: SimulationConfig): SimulationResult {
  const { incomingPerSecond, cacheHitPercent, globalLimitPerMinute, maxQueueSize } = config;
  for (const [label, value, maximum] of [
    ["Incoming requests per second", incomingPerSecond, 1_000_000],
    ["Cache hit percentage", cacheHitPercent, 100],
    ["Global API limit", globalLimitPerMinute, 60_000],
    ["Maximum queue size", maxQueueSize, 1_000_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
      throw new Error(`${label} must be a whole number between 0 and ${maximum.toLocaleString("en-US")}.`);
    }
  }

  let servedFromCache = 0;
  let sentToParallel = 0;
  let queued = 0;
  let rejected = 0;
  const ticks: SimulationTick[] = [];

  // Use 60 aggregate ticks, regardless of traffic volume. Fractional cache hits
  // carry across ticks so the minute's total is deterministic and rounded down.
  for (let second = 1; second <= 60; second += 1) {
    const cachedSoFar = Math.floor(second * incomingPerSecond * cacheHitPercent / 100);
    const cached = cachedSoFar - servedFromCache;
    servedFromCache = cachedSoFar;
    const misses = incomingPerSecond - cached;

    // Pace the shared minute budget across seconds (600/min = 10/sec).
    // Integer differences support limits below 60/min without rounding to zero.
    // Unused slots expire; workers cannot bank them for a later burst.
    const slots = Math.floor(second * globalLimitPerMinute / 60) -
      Math.floor((second - 1) * globalLimitPerMinute / 60);
    const sent = Math.min(queued + misses, slots);
    sentToParallel += sent;

    // Serve old queued work first, then new misses. The cap counts WAITING
    // jobs, excluding work served this tick; overflow is rejected immediately.
    const remaining = queued + misses - sent;
    const rejectedThisTick = Math.max(0, remaining - maxQueueSize);
    queued = Math.min(remaining, maxQueueSize);
    rejected += rejectedThisTick;
    ticks.push({ second, incoming: incomingPerSecond, cached, sent, queued, rejected: rejectedThisTick });
  }

  return {
    config: { ...config },
    totalIncoming: incomingPerSecond * 60,
    servedFromCache,
    sentToParallel,
    queued,
    rejected,
    // Estimated drain time for the final backlog if new requests stop.
    // null means work is waiting but no provider capacity is available.
    estimatedQueueWaitSeconds: queued === 0 ? 0 : globalLimitPerMinute === 0 ? null : Math.ceil(queued * 60 / globalLimitPerMinute),
    utilizationPercent: globalLimitPerMinute === 0 ? 0 : sentToParallel / globalLimitPerMinute * 100,
    ticks,
  };
}
