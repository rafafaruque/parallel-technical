"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { simulateTraffic } from "./simulation";
import type { SimulationResult } from "./simulation";
import styles from "./scale-demo.module.css";

const steps = [
  { label: "Users", detail: "Users submit research jobs. A million accounts does not mean a million simultaneous requests; active traffic determines demand." },
  { label: "Per-user Rate Limiter", detail: "Prevents one user from consuming the entire quota. This is an architectural component only: the simulation does not model individual users or enforce per-user limits." },
  { label: "Cache", detail: "Serves reusable, sufficiently fresh results without another provider request. Cache hits bypass the queue and go straight to Results." },
  { label: "Queue", detail: "Holds cache misses awaiting capacity. Backpressure rejects excess work when the waiting queue reaches its cap, keeping memory and wait times bounded." },
  { label: "Global Rate Limiter", detail: "Shares one request budget across every worker. The hypothetical 600 requests/minute limit is paced at an average of 10 requests/second in this demo." },
  { label: "Worker Pool", detail: "Workers process queued jobs only within available global slots. The model assumes enough workers and instant completion within each tick; adding workers cannot increase the provider quota." },
  { label: "Parallel API", detail: "Represents one simulated provider call per cache miss processed. This page makes no real Parallel API calls. The limit is hypothetical, not a statement of your account quota." },
  { label: "Results", detail: "Results come from cache or completed provider work. Requests still waiting or rejected have no result in this run." },
];
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export default function ScaleDemo() {
  const [selectedStep, setSelectedStep] = useState(1);
  const [incoming, setIncoming] = useState("20");
  const [cache, setCache] = useState("25");
  const [limit, setLimit] = useState("600");
  const [queue, setQueue] = useState("500");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      // Run locally and synchronously: no fetch, API key, timers, or job objects.
      setResult(simulateTraffic({
        incomingPerSecond: Number(incoming),
        cacheHitPercent: Number(cache),
        globalLimitPerMinute: Number(limit),
        maxQueueSize: Number(queue),
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check your simulation settings.");
    }
  }

  return (
    <main className={styles.demo}>
      <header>
        <a href="/">← Search Evaluation Playground</a>
        <p className={styles.badge}>Simulation · No real API traffic</p>
        <h1>API Rate Limiting &amp; Scaling Demo</h1>
        <p>Explore how cache, queueing, and a shared budget shape a research application serving one million users.</p>
      </header>

      <section className="results" aria-labelledby="architecture-heading">
        <h2 id="architecture-heading">Follow a research request</h2>
        <p>Choose a step to see its role. Cache hits skip directly to Results.</p>
        <ol className={styles.flow} aria-label="Research request architecture">
          {steps.map((step, index) => (
            <li key={step.label}>
              <button type="button" aria-pressed={selectedStep === index} onClick={() => setSelectedStep(index)}>
                <span>{index + 1}</span> {step.label}
              </button>
              {index < steps.length - 1 && <span className={styles.arrow} aria-hidden="true">→</span>}
            </li>
          ))}
        </ol>
        <div className={styles.explanation} aria-live="polite">
          <h3>{steps[selectedStep].label}</h3>
          <p>{steps[selectedStep].detail}</p>
        </div>
      </section>

      <section className="results" aria-labelledby="simulation-heading">
        <h2 id="simulation-heading">Simulate one minute</h2>
        <form onSubmit={handleSubmit}>
          <div className={styles.controls}>
            <div>
              <label htmlFor="incoming">Incoming requests per second</label>
              <select id="incoming" value={incoming} onChange={(event) => setIncoming(event.target.value)}>
                {[5, 20, 100, 1000].map((value) => <option key={value} value={value}>{number(value)} requests / second</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cache">Cache hit percentage</label>
              <input id="cache" type="number" min="0" max="100" step="1" required value={cache} onChange={(event) => setCache(event.target.value)} />
            </div>
            <div>
              <label htmlFor="limit">Global API limit (requests / minute)</label>
              <input id="limit" type="number" min="0" max="60000" step="1" required value={limit} onChange={(event) => setLimit(event.target.value)} />
            </div>
            <div>
              <label htmlFor="queue">Maximum queue size (waiting jobs)</label>
              <input id="queue" type="number" min="0" max="1000000" step="1" required value={queue} onChange={(event) => setQueue(event.target.value)} />
            </div>
          </div>
          <button type="submit">Simulate 60 seconds</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}

        <div className={styles.assumptions}>
          <h3>Simplified assumptions</h3>
          <p>Every run starts with an empty queue and uses 60 aggregate one-second ticks. Traffic and the cache-hit percentage stay constant. Each completed cache miss uses one API request; cache hits do not.</p>
          <p>The minute budget is paced across seconds; unused slots expire. Workers serve older jobs first, then new arrivals, assuming enough workers and no processing delay. Only waiting jobs count toward queue capacity; overflow is rejected immediately.</p>
          <p>Per-user limits are architecture only. Individual users, cache freshness, retries, network failures, and worker concurrency are not simulated. This is a deterministic teaching model, not a production limiter.</p>
        </div>
      </section>

      <section className="results" aria-labelledby="metrics-heading">
        <h2 id="metrics-heading">Results after 60 seconds</h2>
        {!result && <p className="placeholder">Choose your settings and run the simulation.</p>}
        {result && <div aria-live="polite" role="status">
          <p className="query">Last run: {number(result.config.incomingPerSecond)} requests/sec · {result.config.cacheHitPercent}% cache hits · {number(result.config.globalLimitPerMinute)} API requests/min · queue cap {number(result.config.maxQueueSize)}</p>
          <dl className={styles.metrics}>
            {[
              ["Total incoming requests", number(result.totalIncoming)],
              ["Requests served from cache", number(result.servedFromCache)],
              ["Requests sent to Parallel", number(result.sentToParallel)],
              ["Requests waiting in the queue", number(result.queued)],
              ["Requests rejected due to queue capacity", number(result.rejected)],
              ["Estimated queue wait time", result.estimatedQueueWaitSeconds === null ? "No API capacity" : `${number(result.estimatedQueueWaitSeconds)} seconds`],
              ["Global API utilization", `${number(result.utilizationPercent)}%`],
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p className={styles.accounting}>Incoming = cache hits + API requests + waiting + rejected.<br />{number(result.totalIncoming)} = {number(result.servedFromCache)} + {number(result.sentToParallel)} + {number(result.queued)} + {number(result.rejected)}</p>
          <p className={styles.note}>Estimated wait is the time to drain the final backlog if new requests stop, using the average API rate. It excludes provider latency. A zero quota cannot drain waiting jobs.</p>
          <p className={styles.note}>Queueing absorbs bursts; it does not add provider capacity. Sustained cache misses above {number(result.config.globalLimitPerMinute / 60)} requests/second grow the queue until backpressure rejects excess work.</p>
        </div>}
        {result && <details>
          <summary>Inspect the 60 simulation ticks</summary>
          <div className={styles.tableScroll}>
            <table>
              <caption>Per-second counts; waiting is the queue at the end of each tick.</caption>
              <thead><tr>{["Second", "Incoming", "Cache", "API", "Waiting", "Rejected"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{result.ticks.map((tick) => <tr key={tick.second}>{[tick.second, tick.incoming, tick.cached, tick.sent, tick.queued, tick.rejected].map((value, index) => <td key={index}>{number(value)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>}
      </section>

      <section className="results" aria-labelledby="production-heading">
        <h2 id="production-heading">How this would work in production</h2>
        <ul className={styles.production}>
          <li><strong>Distributed limits:</strong> use Redis-backed atomic per-user and global rate limiters. All servers and workers must share the same provider budget.</li>
          <li><strong>Fresh cache and durable queue:</strong> reuse results only when identity, query, mode, and freshness rules allow it. Put misses in a shared durable job queue. Bound queue depth and job age; reject overload with a clear retry policy.</li>
          <li><strong>Bounded workers:</strong> acquire shared API capacity before each provider call, with a separate concurrency cap for in-flight work. More workers cannot override the provider limit.</li>
          <li><strong>HTTP 429 handling:</strong> honor Retry-After and retry with exponential backoff and jitter. Bound retries and count every retry attempt against the shared outbound budget.</li>
          <li><strong>Durable status and idempotency:</strong> persist job state and deduplicate submissions using idempotency keys. Recover jobs safely after worker restarts and avoid repeating completed work.</li>
          <li><strong>Monitoring:</strong> track queue depth and age, end-to-end latency, failures, cache hits, rejections, and API usage. Alert before the shared budget or queue is exhausted.</li>
        </ul>
        <p className={styles.explanation}><strong>Why one in-memory limiter fails:</strong> each Next.js server has its own counters, and restarts clear them. Two servers each allowing 600 requests/minute could send 1,200 in total. A global limit needs shared, atomic coordination.</p>
        <p className={styles.note}>A million users each making one request per minute would generate one million requests/minute. A 600-call budget requires a major reduction in provider calls through reusable fresh results and admission control, or a larger provider quota. A larger queue alone cannot solve sustained overload.</p>
      </section>
    </main>
  );
}
