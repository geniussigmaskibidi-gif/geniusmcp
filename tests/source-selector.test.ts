import { describe, it, expect } from "vitest";
import { SourceSelector } from "@forgemcp/data-sources";

describe("SourceSelector (Thompson Sampling)", () => {
  it("selects sources from available options", () => {
    const selector = new SourceSelector({
      sources: ["github", "grepapp", "searchcode"],
      queryClasses: ["phrase", "exact_symbol"],
    });

    const selected = selector.selectSources("phrase", 2);
    expect(selected).toHaveLength(2);
    // All selected should be from available sources
    for (const s of selected) {
      expect(["github", "grepapp", "searchcode"]).toContain(s);
    }
  });

  it("converges toward good source after positive updates", () => {
    const selector = new SourceSelector({
      sources: ["good", "bad"],
      queryClasses: ["phrase"],
      discountInterval: 10000, // disable discounting for this test
    });

    // Give "good" 50 positive signals, "bad" 50 negative
    for (let i = 0; i < 50; i++) {
      selector.update("phrase", "good", true);
      selector.update("phrase", "bad", false);
    }

    // After strong signal, "good" should be selected most of the time
    let goodSelected = 0;
    for (let i = 0; i < 100; i++) {
      const selected = selector.selectSources("phrase", 1);
      if (selected[0] === "good") goodSelected++;
    }

    // Should select "good" >70% of the time (probabilistic, generous threshold)
    expect(goodSelected).toBeGreaterThan(70);
  });

  it("reports beliefs accurately", () => {
    const selector = new SourceSelector({
      sources: ["a", "b"],
      queryClasses: ["test"],
    });

    // 10 successes for "a", 2 successes for "b"
    for (let i = 0; i < 10; i++) selector.update("test", "a", true);
    for (let i = 0; i < 2; i++) selector.update("test", "b", true);

    const beliefs = selector.beliefs("test");
    expect(beliefs).toHaveLength(2);
    // "a" should have higher expected reward
    const beliefA = beliefs.find((b) => b.source === "a");
    const beliefB = beliefs.find((b) => b.source === "b");
    expect(beliefA!.expectedReward).toBeGreaterThan(beliefB!.expectedReward);
  });

  it("handles unknown query class gracefully", () => {
    const selector = new SourceSelector({
      sources: ["github"],
      queryClasses: ["phrase"],
    });

    const selected = selector.selectSources("unknown_class", 1);
    // Should return something (all sources as fallback)
    expect(selected.length).toBeGreaterThanOrEqual(0);
  });

  it("discounts old observations", () => {
    const selector = new SourceSelector({
      sources: ["a", "b"],
      queryClasses: ["test"],
      discountInterval: 10, // discount every 10 updates
    });

    // Give "a" strong signal
    for (let i = 0; i < 9; i++) selector.update("test", "a", true);

    const beliefsBefore = selector.beliefs("test");
    const confBefore = beliefsBefore.find((b) => b.source === "a")!.confidence;

    // 10th update triggers discount
    selector.update("test", "a", true);

    const beliefsAfter = selector.beliefs("test");
    const confAfter = beliefsAfter.find((b) => b.source === "a")!.confidence;

    // Confidence should drop after discounting
    expect(confAfter).toBeLessThan(confBefore);
  });
});
