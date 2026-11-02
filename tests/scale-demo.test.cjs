// Run with: node --test tests/scale-demo.test.cjs
// Uses aggregate counters only: no provider calls or application storage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { simulateTraffic } = require('../app/scale-demo/simulation.ts');

const defaults = { incomingPerSecond: 20, cacheHitPercent: 0, globalLimitPerMinute: 600, maxQueueSize: 500 };

test('traffic below capacity is served without queueing or rejections', () => {
  const result = simulateTraffic({ ...defaults, incomingPerSecond: 5 });
  assert.equal(result.totalIncoming, 300);
  assert.equal(result.sentToParallel, 300);
  assert.equal(result.queued, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.estimatedQueueWaitSeconds, 0);
  assert.equal(result.utilizationPercent, 50);
});

test('traffic above capacity fills the bounded queue and rejects excess', () => {
  const result = simulateTraffic({ ...defaults, incomingPerSecond: 1000 });
  assert.equal(result.totalIncoming, 60000);
  assert.equal(result.sentToParallel, 600);
  assert.equal(result.queued, 500);
  assert.equal(result.rejected, 58900);
  assert.equal(result.estimatedQueueWaitSeconds, 50);
  assert.equal(result.utilizationPercent, 100);
  assert.ok(result.ticks.every(tick => tick.sent <= 10 && tick.queued <= 500));
});

test('cache hits reduce provider demand and all-cache traffic uses no API capacity', () => {
  const result = simulateTraffic({ ...defaults, incomingPerSecond: 100, cacheHitPercent: 95 });
  assert.equal(result.servedFromCache, 5700);
  assert.equal(result.sentToParallel, 300);
  assert.equal(result.queued + result.rejected, 0);
  const allCache = simulateTraffic({ ...defaults, cacheHitPercent: 100 });
  assert.equal(allCache.servedFromCache, allCache.totalIncoming);
  assert.equal(allCache.sentToParallel + allCache.queued + allCache.rejected, 0);
});

test('a larger queue delays work without increasing provider capacity', () => {
  const small = simulateTraffic({ ...defaults, maxQueueSize: 100 });
  const large = simulateTraffic({ ...defaults, maxQueueSize: 1000 });
  assert.equal(small.sentToParallel, 600);
  assert.equal(large.sentToParallel, 600);
  assert.ok(large.queued > small.queued && large.rejected < small.rejected);
});

test('zero waiting capacity still permits immediate service', () => {
  const result = simulateTraffic({ ...defaults, maxQueueSize: 0 });
  assert.equal(result.sentToParallel, 600);
  assert.equal(result.queued, 0);
  assert.equal(result.rejected, 600);
});

test('zero budget and zero traffic have explicit outcomes', () => {
  const paused = simulateTraffic({ ...defaults, globalLimitPerMinute: 0 });
  assert.equal(paused.sentToParallel, 0);
  assert.equal(paused.queued, 500);
  assert.equal(paused.rejected, 700);
  assert.equal(paused.estimatedQueueWaitSeconds, null);
  assert.equal(paused.utilizationPercent, 0);
  const idle = simulateTraffic({ ...defaults, incomingPerSecond: 0, globalLimitPerMinute: 0 });
  assert.equal(idle.totalIncoming + idle.sentToParallel + idle.queued + idle.rejected, 0);
  assert.equal(idle.estimatedQueueWaitSeconds, 0);
});

test('fractional per-second budgets are paced accurately without exceeding the minute budget', () => {
  for (const budget of [1, 7, 59, 61, 599, 601]) {
    const result = simulateTraffic({ ...defaults, globalLimitPerMinute: budget });
    assert.equal(result.sentToParallel, budget);
    let sent = 0;
    for (const tick of result.ticks) {
      sent += tick.sent;
      assert.ok(sent <= Math.floor(tick.second * budget / 60));
      assert.ok(tick.sent <= Math.ceil(budget / 60));
    }
  }
});

test('simulation is deterministic, conserves requests, and uses only 60 ticks at high volume', () => {
  for (const incomingPerSecond of [0, 5, 20, 1000, 1000000]) {
    for (const cacheHitPercent of [0, 33, 99, 100]) {
      const config = { ...defaults, incomingPerSecond, cacheHitPercent };
      const result = simulateTraffic(config);
      assert.deepEqual(result, simulateTraffic(config));
      assert.equal(result.ticks.length, 60);
      assert.equal(result.servedFromCache, Math.floor(result.totalIncoming * cacheHitPercent / 100));
      assert.equal(result.totalIncoming, result.servedFromCache + result.sentToParallel + result.queued + result.rejected);
      let waiting = 0;
      for (const tick of result.ticks) {
        assert.equal(waiting + tick.incoming, tick.cached + tick.sent + tick.queued + tick.rejected);
        waiting = tick.queued;
      }
    }
  }
});

test('invalid values are rejected instead of producing misleading metrics', () => {
  for (const change of [
    { incomingPerSecond: -1 }, { incomingPerSecond: 1000001 },
    { cacheHitPercent: 101 }, { cacheHitPercent: 0.5 },
    { globalLimitPerMinute: NaN }, { globalLimitPerMinute: Infinity }, { globalLimitPerMinute: 60001 },
    { maxQueueSize: -1 }, { maxQueueSize: 1000001 },
  ]) assert.throws(() => simulateTraffic({ ...defaults, ...change }));
});
