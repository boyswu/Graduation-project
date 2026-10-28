const STORAGE_KEY = "vton-runtime-trace-v1";
const LIMIT = 2400;
const API = "http://127.0.0.1:8022/api/telemetry";
const SYNC_EVENTS = new Set(["client_start", "client_ready", "client_stop", "client_error", "client_display",
  "client_stall", "client_long_task", "client_loop_delay", "client_output_dropped"]);

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null;

export class LatencyLog {
  constructor() {
    this.events = [];
    this.pending = [];
    this.sequence = 0;
    this.lastDisplay = null;
    this.lastStallAt = 0;
    this.traceId = null;
    this.active = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (Array.isArray(saved?.events)) this.events = saved.events.slice(-600);
    } catch {}
    this.flushTimer = setInterval(() => void this.flush(), 2000);
    let expected = performance.now() + 250;
    this.monitorTimer = setInterval(() => {
      const now = performance.now(), late = Math.max(0, now - expected);
      expected = now + 250;
      if (this.active && late > 100) this.record("client_loop_delay", null, { duration_ms: late, hidden: document.hidden });
      if (this.lastDisplay && now - this.lastDisplay.displayedAt > 1000 && now - this.lastStallAt > 1000) {
        this.lastStallAt = now;
        this.record("client_stall", this.lastDisplay.frameId, { no_output_ms: now - this.lastDisplay.displayedAt,
          visible_age_ms: now - this.lastDisplay.capturedAt, hidden: document.hidden });
      }
      this.onChange?.();
    }, 250);
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
      this.observer = new PerformanceObserver((list) => {
        if (this.active) for (const entry of list.getEntries()) this.record("client_long_task", null, { duration_ms: entry.duration, start_ms: entry.startTime });
      });
      this.observer.observe({ type: "longtask", buffered: false });
    }
  }

  begin(traceId, smooth) {
    this.traceId = traceId;
    this.active = true;
    this.sequence = 0;
    this.lastDisplay = null;
    this.record("client_start", null, { smooth, automated: navigator.webdriver === true,
      viewport_width: innerWidth, viewport_height: innerHeight, device_pixel_ratio: devicePixelRatio });
  }

  record(event, frameId, metrics = {}) {
    if (!this.traceId) return;
    // Numeric/boolean metrics only: images, prompts, file names and URLs cannot enter the journal.
    const safe = Object.fromEntries(Object.entries(metrics).filter(([key, value]) =>
      /^[a-zA-Z_][a-zA-Z0-9_]{0,47}$/.test(key) && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))));
    const row = { trace_id: this.traceId, sequence: ++this.sequence, event, frame_id: frameId,
      at_ms: performance.now(), wall_time_ms: Date.now(), metrics: safe };
    this.events.push(row);
    if (this.events.length > LIMIT) this.events.splice(0, this.events.length - LIMIT);
    if (SYNC_EVENTS.has(event)) this.pending.push(row); // Avoid uploading high-rate capture/paint events on a slow link.
    if (this.pending.length > 512) this.pending.splice(0, this.pending.length - 512);
  }

  displayed(frameId, capturedAt, metrics) {
    this.lastDisplay = { frameId, capturedAt, displayedAt: performance.now() };
    this.record("client_display", frameId, metrics);
    this.onChange?.();
  }

  stop() {
    this.record("client_stop", this.lastDisplay?.frameId ?? null);
    this.lastDisplay = null;
    this.active = false;
    this.persist();
    void this.flush();
  }

  persist() {
    const keep = [...this.events.filter((row) => SYNC_EVENTS.has(row.event)).slice(-240), ...this.events.slice(-360)];
    const unique = [...new Map(keep.map((row) => [`${row.trace_id}:${row.sequence}`, row])).values()].sort((a, b) => a.wall_time_ms - b.wall_time_ms);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ events: unique })); } catch {}
  }

  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const batch = this.pending.slice(0, 128);
    try {
      const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error("telemetry-unavailable");
      const delivered = new Set(batch.map((row) => `${row.trace_id}:${row.sequence}`));
      this.pending = this.pending.filter((row) => !delivered.has(`${row.trace_id}:${row.sequence}`));
      this.remoteAvailable = true;
    } catch { this.remoteAvailable = false; } // Logging never blocks camera generation.
    finally { this.flushing = false; }
  }

  summary() {
    const rows = this.events.filter((row) => row.event === "client_display").slice(-120);
    const values = rows.map((row) => row.metrics.total_ms).filter(Number.isFinite);
    return { count: rows.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95),
      max_ms: values.length ? Math.max(...values) : null, slow_frames: values.filter((n) => n >= 1000).length,
      visible_age_ms: this.lastDisplay ? performance.now() - this.lastDisplay.capturedAt : null,
      last: rows.at(-1) ?? null, remote_available: this.remoteAvailable === true };
  }

  snapshot() {
    return { version: 1, exported_at: new Date().toISOString(), trace_id: this.traceId || this.events.at(-1)?.trace_id || null,
      note: "Runtime numeric telemetry only; no camera/garment pixels. Durations use local monotonic clocks; no cross-machine clock subtraction.",
      summary: this.summary(), events: this.events };
  }

  async download() {
    const report = this.snapshot();
    try {
      const response = await fetch(`http://127.0.0.1:8022/api/diagnostics?trace_id=${encodeURIComponent(report.trace_id || "")}`, { signal: AbortSignal.timeout(3000), cache: "no-store" });
      if (response.ok) report.server = await response.json();
    } catch { report.server_unavailable = true; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `vton-runtime-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  clear() {
    this.events = []; this.pending = [];
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    this.onChange?.();
  }

  destroy() {
    clearInterval(this.flushTimer); clearInterval(this.monitorTimer); this.observer?.disconnect();
    this.persist();
  }
}
