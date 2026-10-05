import { describe, it, expect, beforeEach } from "vitest";
import { MetricsRegistry, statusClass } from "../src/observability/metrics";
import { sanitizeIncomingCorrelationId, newCorrelationId } from "../src/observability/requestContext";

/**
 * Unit tests for the in-process metrics registry + correlation sanitization
 * (Increment 10). No DB. Verifies counters/histograms, bounded cardinality,
 * Prometheus rendering safety, and correlation-id validation.
 */

describe("MetricsRegistry: counters + histograms", () => {
  let reg: MetricsRegistry;
  beforeEach(() => {
    reg = new MetricsRegistry();
    reg.registerCounter("c_total", "test counter");
    reg.registerHistogram("h_ms", "test histogram");
  });

  it("increments counters by label series", () => {
    reg.incr("c_total", { route: "/a", method: "GET" });
    reg.incr("c_total", { route: "/a", method: "GET" });
    reg.incr("c_total", { route: "/b", method: "POST" });
    expect(reg.counterTotal("c_total")).toBe(3);
    expect(reg.seriesCount("c_total")).toBe(2);
  });

  it("records histogram observations with buckets + sum + count", () => {
    reg.observe("h_ms", 7, { route: "/a" });
    reg.observe("h_ms", 400, { route: "/a" });
    const text = reg.renderProm();
    expect(text).toContain("# TYPE h_ms histogram");
    expect(text).toContain('h_ms_count{route="/a"} 2');
    expect(text).toContain('h_ms_sum{route="/a"} 407');
    // The +Inf bucket equals total count.
    expect(text).toContain('h_ms_bucket{le="+Inf",route="/a"} 2');
  });

  it("caps distinct series per metric (cardinality guard)", () => {
    // Push far more than the cap; series count must stay bounded.
    for (let i = 0; i < 5000; i++) reg.incr("c_total", { id: String(i) });
    expect(reg.seriesCount("c_total")).toBeLessThanOrEqual(2000);
  });

  it("renderProm emits HELP/TYPE and escapes label values safely", () => {
    reg.incr("c_total", { route: 'a"b\nc' });
    const text = reg.renderProm();
    expect(text).toContain("# HELP c_total test counter");
    expect(text).toContain("# TYPE c_total counter");
    // The newline must be stripped and the quote escaped — no raw newline inside
    // the label value breaking the exposition format.
    expect(text).not.toMatch(/route="a"b\nc"/);
    expect(text).toContain('\\"');
  });

  it("renderProm never emits application data — only registered names", () => {
    const text = reg.renderProm();
    // Only our two metric names appear as metric lines.
    expect(text).toContain("c_total");
    expect(text).toContain("h_ms");
    expect(text).not.toContain("password");
    expect(text).not.toContain("token");
  });
});

describe("statusClass", () => {
  it("buckets HTTP status codes into bounded classes", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(301)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(100)).toBe("other");
  });
});

describe("correlation id sanitization", () => {
  it("accepts a safe inbound id", () => {
    expect(sanitizeIncomingCorrelationId("abc-123_DEF.4:5")).toBe("abc-123_DEF.4:5");
  });
  it("rejects oversized ids", () => {
    expect(sanitizeIncomingCorrelationId("x".repeat(500))).toBeNull();
  });
  it("rejects ids with newlines / control chars (log injection)", () => {
    expect(sanitizeIncomingCorrelationId("abc\ndef")).toBeNull();
    expect(sanitizeIncomingCorrelationId("abc def")).toBeNull();
    expect(sanitizeIncomingCorrelationId("a\tb")).toBeNull();
  });
  it("rejects non-strings and empty", () => {
    expect(sanitizeIncomingCorrelationId(123 as unknown)).toBeNull();
    expect(sanitizeIncomingCorrelationId("")).toBeNull();
    expect(sanitizeIncomingCorrelationId("   ")).toBeNull();
  });
  it("generates a random id", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});
