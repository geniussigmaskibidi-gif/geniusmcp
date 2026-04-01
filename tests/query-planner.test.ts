import { describe, it, expect } from "vitest";
import { classifyQuery, planQuery, extractLiterals } from "@forgemcp/db/query-planner";

describe("Query Classification", () => {
  it("classifies short tokens (<= 2 chars)", () => {
    expect(classifyQuery("id")).toBe("short_token");
    expect(classifyQuery("fn")).toBe("short_token");
    expect(classifyQuery("db")).toBe("short_token");
    expect(classifyQuery("x")).toBe("short_token");
  });

  it("classifies exact symbols (single lowercase identifier)", () => {
    expect(classifyQuery("map")).toBe("exact_symbol");
    expect(classifyQuery("push")).toBe("exact_symbol");
    expect(classifyQuery("log")).toBe("exact_symbol");
    // CamelCase is classified as substring (more effective search strategy)
    expect(classifyQuery("useState")).toBe("substring");
    expect(classifyQuery("createHash")).toBe("substring");
  });

  it("classifies phrases (multi-word)", () => {
    expect(classifyQuery("rate limiter")).toBe("phrase");
    expect(classifyQuery("retry with backoff")).toBe("phrase");
    expect(classifyQuery("error handling")).toBe("phrase");
  });

  it("classifies substrings (camelCase/snake_case)", () => {
    expect(classifyQuery("retryWith")).toBe("substring");
    expect(classifyQuery("handleAuth")).toBe("substring");
    expect(classifyQuery("handle_auth")).toBe("substring");
  });

  it("classifies regex-like patterns", () => {
    expect(classifyQuery("retry.*backoff")).toBe("regex_like");
    expect(classifyQuery("handle[A-Z]")).toBe("regex_like");
    expect(classifyQuery("^function")).toBe("regex_like");
  });

  it("classifies path-like queries", () => {
    expect(classifyQuery("src/utils/")).toBe("path");
    expect(classifyQuery("*.test.ts")).toBe("path");
  });
});

describe("Query Planning", () => {
  it("short tokens get short_identifier + bm25 lanes", () => {
    const plan = planQuery("id");
    expect(plan.queryClass).toBe("short_token");
    expect(plan.lanes.length).toBeGreaterThanOrEqual(1);
    expect(plan.lanes[0]!.lane).toBe("short_identifier");
  });

  it("phrases get bm25 + trigram lanes", () => {
    const plan = planQuery("rate limiter");
    expect(plan.queryClass).toBe("phrase");
    const laneNames = plan.lanes.map(l => l.lane);
    expect(laneNames).toContain("bm25");
    expect(laneNames).toContain("trigram");
  });

  it("regex queries get trigram prefilter + regex_verify", () => {
    const plan = planQuery("retry.*backoff");
    expect(plan.queryClass).toBe("regex_like");
    const laneNames = plan.lanes.map(l => l.lane);
    expect(laneNames).toContain("regex_verify");
  });

  it("all plans have estimated cost", () => {
    expect(planQuery("id").estimatedCostMs).toBeGreaterThan(0);
    expect(planQuery("rate limiter").estimatedCostMs).toBeGreaterThan(0);
    expect(planQuery("src/utils/").estimatedCostMs).toBeGreaterThan(0);
  });

  it("preserves original query", () => {
    const plan = planQuery("  hello world  ");
    expect(plan.originalQuery).toBe("hello world");
  });
});

describe("extractLiterals", () => {
  it("extracts literal fragments from regex", () => {
    const lits = extractLiterals("retry.*backoff");
    expect(lits).toContain("retry");
    expect(lits).toContain("backoff");
  });

  it("filters out fragments shorter than 3 chars", () => {
    const lits = extractLiterals("a.*bc.*def");
    expect(lits).toEqual(["def"]);
  });

  it("returns empty for pure regex", () => {
    const lits = extractLiterals(".*");
    expect(lits).toEqual([]);
  });
});
