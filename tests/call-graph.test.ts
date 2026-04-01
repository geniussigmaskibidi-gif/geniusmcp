import { describe, it, expect } from "vitest";
import { buildCallGraph, buildAdjacency, reachableFrom, tracePath, detectArchitecture } from "@forgemcp/ast-intelligence";
import type { CallGraphSymbol } from "@forgemcp/ast-intelligence";

describe("Call Graph", () => {
  const makeSymbol = (id: number, name: string, code: string, opts?: Partial<CallGraphSymbol>): CallGraphSymbol => ({
    id,
    blobSha: opts?.blobSha ?? "blob1",
    name,
    kind: opts?.kind ?? "function",
    exported: opts?.exported ?? true,
    startLine: opts?.startLine ?? 0,
    endLine: opts?.endLine ?? 10,
    code,
  });

  describe("buildCallGraph", () => {
    it("should detect direct function calls", () => {
      const symbols = [
        makeSymbol(1, "mainEntry", "function mainEntry() { helperFn(); processData(); }"),
        makeSymbol(2, "helperFn", "function helperFn() { return 42; }"),
        makeSymbol(3, "processData", "function processData() { return helperFn(); }"),
      ];

      const { edges } = buildCallGraph(symbols);

      // mainEntry calls helperFn and processData
      const mainEdges = edges.filter(e => e.sourceId === 1 && !e.external);
      expect(mainEdges.length).toBeGreaterThanOrEqual(2);
      expect(mainEdges.some(e => e.targetId === 2)).toBe(true); // mainEntry → helperFn
      expect(mainEdges.some(e => e.targetId === 3)).toBe(true); // mainEntry → processData

      // processData calls helperFn
      const processEdges = edges.filter(e => e.sourceId === 3 && !e.external);
      expect(processEdges.some(e => e.targetId === 2)).toBe(true); // processData → helperFn
    });

    it("should mark unresolved calls as external", () => {
      const symbols = [
        makeSymbol(1, "handler", "function handler() { unknownLib(); }"),
      ];

      const { edges, unresolvedCalls } = buildCallGraph(symbols);
      expect(unresolvedCalls).toContain("unknownLib");
      expect(edges.some(e => e.external && e.targetName === "unknownLib")).toBe(true);
    });

    it("should prioritize same-file resolution", () => {
      const symbols = [
        makeSymbol(1, "caller", "function caller() { shared(); }", { blobSha: "file1" }),
        makeSymbol(2, "shared", "function shared() {}", { blobSha: "file1" }),
        makeSymbol(3, "shared", "function shared() {}", { blobSha: "file2", exported: true }),
      ];

      const { edges } = buildCallGraph(symbols);
      const callerEdges = edges.filter(e => e.sourceId === 1 && !e.external);

      // Should resolve to same-file shared (id=2), not other-file shared (id=3)
      expect(callerEdges.some(e => e.targetId === 2)).toBe(true);
    });
  });

  describe("Graph traversal", () => {
    it("should find reachable symbols via BFS", () => {
      const symbols = [
        makeSymbol(1, "alpha", "function alpha() { beta(); }"),
        makeSymbol(2, "beta", "function beta() { gamma(); }"),
        makeSymbol(3, "gamma", "function gamma() { delta(); }"),
        makeSymbol(4, "delta", "function delta() {}"),
        makeSymbol(5, "isolated", "function isolated() {}"),
      ];

      const { edges } = buildCallGraph(symbols);
      const { outgoing } = buildAdjacency(edges);

      const reachable = reachableFrom(outgoing, 1, 5);
      const reachableIds = reachable.map(r => r.symbolId);

      expect(reachableIds).toContain(2); // beta
      expect(reachableIds).toContain(3); // gamma
      expect(reachableIds).toContain(4); // delta
      expect(reachableIds).not.toContain(5); // isolated
    });

    it("should find shortest call path", () => {
      const symbols = [
        makeSymbol(1, "startFunc", "function startFunc() { middleFunc(); }"),
        makeSymbol(2, "middleFunc", "function middleFunc() { endFunc(); }"),
        makeSymbol(3, "endFunc", "function endFunc() {}"),
      ];

      const { edges } = buildCallGraph(symbols);
      const { outgoing } = buildAdjacency(edges);

      const path = tracePath(outgoing, 1, 3);
      expect(path).not.toBeNull();
      expect(path).toEqual([1, 2, 3]); // startFunc → middleFunc → endFunc
    });

    it("should return null for unreachable target", () => {
      const symbols = [
        makeSymbol(1, "a", "function a() {}"),
        makeSymbol(2, "b", "function b() {}"),
      ];

      const { edges } = buildCallGraph(symbols);
      const { outgoing } = buildAdjacency(edges);

      const path = tracePath(outgoing, 1, 2);
      expect(path).toBeNull(); // no edge between a and b
    });
  });

  describe("Architecture Detection", () => {
    it("should detect MVC pattern", () => {
      const arch = detectArchitecture([
        { path: "src/routes/api.ts", symbolCount: 10 },
        { path: "src/controllers/user.ts", symbolCount: 8 },
        { path: "src/models/user.ts", symbolCount: 5 },
        { path: "src/middleware/auth.ts", symbolCount: 3 },
      ]);

      expect(arch.type).toBe("MVC");
      expect(arch.modules.length).toBeGreaterThan(0);
    });

    it("should detect entry point", () => {
      const arch = detectArchitecture([
        { path: "src/index.ts", symbolCount: 2 },
        { path: "src/utils/helpers.ts", symbolCount: 15 },
      ]);

      expect(arch.entryPoint).toBe("src/index.ts");
    });

    it("should identify module roles", () => {
      const arch = detectArchitecture([
        { path: "src/db/connection.ts", symbolCount: 5 },
        { path: "src/utils/format.ts", symbolCount: 10 },
        { path: "tests/unit.test.ts", symbolCount: 20 },
      ]);

      const dbMod = arch.modules.find(m => m.path.includes("db"));
      expect(dbMod?.role).toContain("Data access");

      const testMod = arch.modules.find(m => m.path.includes("test"));
      expect(testMod?.role).toContain("Test");
    });
  });
});
