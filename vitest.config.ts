import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@forgemcp/core": resolve(__dirname, "packages/core/src"),
      "@forgemcp/db": resolve(__dirname, "packages/db/src"),
      "@forgemcp/ast-intelligence": resolve(__dirname, "packages/ast-intelligence/src"),
      "@forgemcp/repo-memory": resolve(__dirname, "packages/repo-memory/src"),
      "@forgemcp/github-gateway": resolve(__dirname, "packages/github-gateway/src"),
      "@forgemcp/importer": resolve(__dirname, "packages/importer/src"),
      "@forgemcp/data-sources": resolve(__dirname, "packages/data-sources/src"),
      "@forgemcp/hunt-engine": resolve(__dirname, "packages/hunt-engine/src"),
    },
  },
});
