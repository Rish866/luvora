/**
 * Lightweight in-process metrics registry (Increment 10).
 *
 * No external dependency (no Prometheus client lib). Supports counters and
 * simple histograms with BOUNDED label sets, and renders Prometheus text
 * format. Metrics are PROCESS-LOCAL: with multiple server/worker processes the
 * values are per-process and are NOT aggregated across them (documented).
 *
 * Cardinality safety: callers must pass only bounded, server-controlled label
 * values (route templates, method, status class, channel, job type, result).
 * The registry additionally caps the number of distinct series per metric and
 * drops new series beyond the cap, so a bug/attacker can never cause unbounded
 * memory growth.
 */

type Labels = Record<string, string>;

/** Hard cap on distinct label-series per metric name (cardinality guard). */
const MAX_SERIES_PER_METRIC = 2000;

/** Fixed histogram buckets (ms) for request/job durations. */
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface HistogramSeries {
  buckets: number[]; // cumulative counts aligned to DURATION_BUCKETS_MS
  sum: number;
  count: number;
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const inner = keys
    .map((k) => `${k}="${escapeLabelValue(labels[k])}"`)
    .join(",");
  return `{${inner}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, " ").replace(/"/g, '\\"');
}

export class MetricsRegistry {
  private counters = new Map<string, Map<string, number>>();
  private counterHelp = new Map<string, string>();
  private histograms = new Map<string, Map<string, HistogramSeries>>();
  private histogramHelp = new Map<string, string>();

  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    this.counterHelp.set(name, help);
  }

  registerHistogram(name: string, help: string): void {
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
    this.histogramHelp.set(name, help);
  }

  incr(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    if (!this.counters.has(name)) {
      this.counters.set(name, series);
      this.counterHelp.set(name, name);
    }
    const key = labelKey(labels);
    if (!series.has(key) && series.size >= MAX_SERIES_PER_METRIC) return; // cardinality guard
    series.set(key, (series.get(key) ?? 0) + by);
  }

  observe(name: string, valueMs: number, labels: Labels = {}): void {
    const series = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    if (!this.histograms.has(name)) {
      this.histograms.set(name, series);
      this.histogramHelp.set(name, name);
    }
    const key = labelKey(labels);
    let h = series.get(key);
    if (!h) {
      if (series.size >= MAX_SERIES_PER_METRIC) return; // cardinality guard
      h = { buckets: new Array(DURATION_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      series.set(key, h);
    }
    h.sum += valueMs;
    h.count += 1;
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      if (valueMs <= DURATION_BUCKETS_MS[i]) h.buckets[i] += 1;
    }
  }

  /** Snapshot a single counter total across all its series (diagnostics/tests). */
  counterTotal(name: string): number {
    const series = this.counters.get(name);
    if (!series) return 0;
    let total = 0;
    for (const v of series.values()) total += v;
    return total;
  }

  /** Number of distinct label-series for a metric (cardinality tests). */
  seriesCount(name: string): number {
    return this.counters.get(name)?.size ?? this.histograms.get(name)?.size ?? 0;
  }

  /** Render Prometheus text exposition format. Safe: only registered metric
   *  names + bounded labels are emitted; no application data. */
  renderProm(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# HELP ${name} ${this.counterHelp.get(name) ?? name}`);
      lines.push(`# TYPE ${name} counter`);
      if (series.size === 0) {
        lines.push(`${name} 0`);
      }
      for (const [key, value] of series) {
        const labels = keyToLabels(key);
        lines.push(`${name}${renderLabels(labels)} ${value}`);
      }
    }
    for (const [name, series] of this.histograms) {
      lines.push(`# HELP ${name} ${this.histogramHelp.get(name) ?? name}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, h] of series) {
        const labels = keyToLabels(key);
        for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
          const le = { ...labels, le: String(DURATION_BUCKETS_MS[i]) };
          lines.push(`${name}_bucket${renderLabels(le)} ${h.buckets[i]}`);
        }
        lines.push(`${name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${h.count}`);
        lines.push(`${name}_sum${renderLabels(labels)} ${h.sum}`);
        lines.push(`${name}_count${renderLabels(labels)} ${h.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  reset(): void {
    for (const s of this.counters.values()) s.clear();
    for (const s of this.histograms.values()) s.clear();
  }
}

function keyToLabels(key: string): Labels {
  if (!key) return {};
  const out: Labels = {};
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Classify an HTTP status code into a bounded status class label. */
export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "other";
}

/** The shared process-wide registry. */
export const metrics = new MetricsRegistry();

// Register all known metrics up front so /metrics shows them even at zero.
metrics.registerCounter("http_requests_total", "Total HTTP requests by route/method/status class");
metrics.registerCounter("http_errors_total", "Total HTTP responses with a 4xx/5xx status");
metrics.registerHistogram("http_request_duration_ms", "HTTP request duration in ms");

metrics.registerCounter("db_queries_total", "Total database queries executed");
metrics.registerCounter("db_query_errors_total", "Total database queries that errored");
metrics.registerHistogram("db_query_duration_ms", "Database query duration in ms");

metrics.registerCounter("websocket_connections_total", "Total WebSocket connections opened by channel");
metrics.registerCounter("websocket_disconnects_total", "Total WebSocket disconnects by channel");
metrics.registerCounter("websocket_messages_total", "Total inbound WebSocket messages by channel");
metrics.registerCounter("websocket_errors_total", "Total WebSocket errors by channel");

metrics.registerCounter("notifications_created_total", "Notifications persisted by category");
metrics.registerCounter("notifications_deduplicated_total", "Notification creates collapsed by dedupe");
metrics.registerCounter("notification_push_jobs_enqueued_total", "Push delivery jobs enqueued");
metrics.registerCounter("notification_push_sent_total", "Push deliveries sent (delivered) by provider");
metrics.registerCounter("notification_push_failed_total", "Push deliveries that failed (temporary)");
metrics.registerCounter("notification_push_revoked_total", "Push deliveries that permanently failed / revoked");

metrics.registerCounter("jobs_enqueued_total", "Background jobs enqueued by type");
metrics.registerCounter("jobs_claimed_total", "Background jobs claimed by type");
metrics.registerCounter("jobs_succeeded_total", "Background jobs succeeded by type");
metrics.registerCounter("jobs_retried_total", "Background jobs retried by type");
metrics.registerCounter("jobs_dead_total", "Background jobs dead-lettered by type");
metrics.registerCounter("jobs_cancelled_total", "Background jobs cancelled by type");
metrics.registerCounter("jobs_reclaimed_total", "Background jobs reclaimed from expired leases");
metrics.registerHistogram("jobs_execution_duration_ms", "Job handler execution duration in ms");
metrics.registerHistogram("jobs_queue_wait_duration_ms", "Time a job waited before first claim in ms");
