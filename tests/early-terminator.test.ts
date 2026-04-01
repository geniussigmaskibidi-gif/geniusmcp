import { describe, it, expect } from "vitest";
import { EarlyTerminator } from "@forgemcp/hunt-engine";

describe("EarlyTerminator", () => {
  it("does not terminate during warmup", () => {
    const et = new EarlyTerminator({ patience: 2, warmupCount: 5 });
    // Even zero discovery rate shouldn't trigger during warmup
    for (let i = 0; i < 4; i++) {
      expect(et.observe(0)).toBe(false);
    }
  });

  it("terminates on flat discovery rate after warmup", () => {
    const et = new EarlyTerminator({ patience: 2, warmupCount: 3 });

    // Warmup with high discovery
    et.observe(10);
    et.observe(8);
    et.observe(12);

    // Mean is ~10, stddev is ~2
    // Threshold = mean - stddev ≈ 8
    // Rates below 8 should count as "below threshold"
    expect(et.observe(2)).toBe(false);  // 1st consecutive below
    expect(et.observe(1)).toBe(true);   // 2nd consecutive → terminate!
  });

  it("resets consecutive counter on good observation", () => {
    const et = new EarlyTerminator({ patience: 3, warmupCount: 3 });

    // Warmup with consistent high values
    et.observe(10);
    et.observe(10);
    et.observe(10);

    // Below threshold
    et.observe(0);
    expect(et.stats.consecutiveBelow).toBe(1);

    // Good observation resets counter
    et.observe(15);
    expect(et.stats.consecutiveBelow).toBe(0);
  });

  it("reports statistics", () => {
    const et = new EarlyTerminator();
    et.observe(10);
    et.observe(20);
    et.observe(30);

    const stats = et.stats;
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(20);
    expect(stats.stddev).toBeGreaterThan(0);
  });

  it("reset() clears all state", () => {
    const et = new EarlyTerminator({ warmupCount: 2, patience: 1 });
    et.observe(10);
    et.observe(10);
    et.observe(0); // would trigger after warmup

    et.reset();
    expect(et.stats.count).toBe(0);
    expect(et.stats.mean).toBe(0);
    expect(et.observe(0)).toBe(false); // warmup again
  });

  it("handles constant stream without false termination", () => {
    const et = new EarlyTerminator({ patience: 3, warmupCount: 5 });

    // Constant discovery rate should NOT trigger termination
    for (let i = 0; i < 50; i++) {
      expect(et.observe(5)).toBe(false);
    }
  });
});
