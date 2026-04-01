import { describe, it, expect } from "vitest";
import { extractSymbols, detectLanguage, computeAstFingerprint } from "@forgemcp/ast-intelligence";

describe("Symbol Extractor", () => {
  describe("TypeScript extraction", () => {
    it("should extract exported function", () => {
      const code = `
export function retryWithBackoff(fn: () => Promise<void>, maxRetries: number): Promise<void> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      await new Promise(r => setTimeout(r, 2 ** attempt * 100));
    }
  }
  throw new Error("Max retries exceeded");
}`;
      const result = extractSymbols(code, "typescript");

      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      const sym = result.symbols.find(s => s.name === "retryWithBackoff");
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe("function");
      expect(sym!.exported).toBe(true);
      expect(sym!.code).toContain("retryWithBackoff");
    });

    it("should extract class", () => {
      const code = `
export class TokenBucket {
  private tokens: number;
  constructor(private capacity: number) {
    this.tokens = capacity;
  }
  consume(): boolean {
    if (this.tokens > 0) { this.tokens--; return true; }
    return false;
  }
}`;
      const result = extractSymbols(code, "typescript");
      const cls = result.symbols.find(s => s.name === "TokenBucket");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
      expect(cls!.exported).toBe(true);
    });

    it("should extract interface", () => {
      const code = `export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}`;
      const result = extractSymbols(code, "typescript");
      const iface = result.symbols.find(s => s.name === "RateLimitConfig");
      expect(iface).toBeDefined();
      expect(iface!.kind).toBe("interface");
    });

    it("should extract arrow function", () => {
      const code = `export const multiply = (a: number, b: number) => a * b;`;
      const result = extractSymbols(code, "typescript");
      expect(result.symbols.some(s => s.name === "multiply")).toBe(true);
    });

    it("should detect imports", () => {
      const code = `
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { myHelper } from "./utils";

export function createClient() {
  return new Octokit();
}`;
      const result = extractSymbols(code, "typescript");
      const fn = result.symbols.find(s => s.name === "createClient");
      expect(fn).toBeDefined();
      // imports should include external packages but not local
      expect(fn!.imports).toContain("@octokit/rest");
      expect(fn!.imports).toContain("zod");
      expect(fn!.imports).not.toContain("./utils");
    });
  });

  describe("Python extraction", () => {
    it("should extract function with docstring", () => {
      const code = `
def fibonacci(n):
    """Calculate the nth Fibonacci number."""
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
`;
      const result = extractSymbols(code, "python");
      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
      const fn = result.symbols.find(s => s.name === "fibonacci");
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe("function");
    });

    it("should extract class", () => {
      const code = `
class RateLimiter:
    def __init__(self, max_calls, period):
        self.max_calls = max_calls
        self.period = period

    def allow(self):
        return True
`;
      const result = extractSymbols(code, "python");
      const cls = result.symbols.find(s => s.name === "RateLimiter");
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe("class");
    });
  });

  describe("Go extraction", () => {
    it("should extract exported function", () => {
      const code = `
func NewRateLimiter(rate int, burst int) *RateLimiter {
	return &RateLimiter{rate: rate, burst: burst}
}
`;
      const result = extractSymbols(code, "go");
      const fn = result.symbols.find(s => s.name === "NewRateLimiter");
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true); // Go: capitalized = exported
    });

    it("should detect unexported function", () => {
      const code = `
func newHelper() error {
	return nil
}
`;
      const result = extractSymbols(code, "go");
      const fn = result.symbols.find(s => s.name === "newHelper");
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(false); // lowercase = unexported
    });
  });

  describe("AST Fingerprint", () => {
    it("should produce same fingerprint for renamed identifiers", () => {
      const code1 = `function add(a, b) { return a + b; }`;
      const code2 = `function sum(x, y) { return x + y; }`;

      const fp1 = computeAstFingerprint(code1);
      const fp2 = computeAstFingerprint(code2);

      expect(fp1).toBe(fp2); // same structure, different names → same fingerprint
    });

    it("should produce different fingerprints for different structures", () => {
      const code1 = `function add(a, b) { return a + b; }`;
      const code2 = `function greet(name) { if (name) { console.log(name); } }`;

      const fp1 = computeAstFingerprint(code1);
      const fp2 = computeAstFingerprint(code2);

      expect(fp1).not.toBe(fp2); // different structure
    });
  });

  describe("Language Detection", () => {
    it("should detect common languages from file extension", () => {
      expect(detectLanguage("src/index.ts")).toBe("typescript");
      expect(detectLanguage("main.py")).toBe("python");
      expect(detectLanguage("server.go")).toBe("go");
      expect(detectLanguage("lib.rs")).toBe("rust");
      expect(detectLanguage("App.tsx")).toBe("tsx");
    });

    it("should return null for unknown extensions", () => {
      expect(detectLanguage("Makefile")).toBeNull();
      expect(detectLanguage("readme.md")).toBeNull();
    });
  });
});
