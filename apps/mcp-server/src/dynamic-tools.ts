// Instead of registering all 24+ tools (4200+ tokens of schemas),
// registers only 3 meta-tools (200 tokens) that the agent uses
// to discover, describe, and execute tools on demand.
//
// Inspired by Speakeasy's 96.7% token reduction pattern.
// Opt-in via FORGEMCP_DYNAMIC_TOOLS=1 environment variable.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Each entry costs ~10 tokens vs ~200 tokens for full schema
export interface ToolCatalogEntry {
  readonly name: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly category: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  // Search & Discovery
  { name: "genius.hunt", summary: "Cross-source code search with structural ranking", tags: ["search", "code", "github", "grep", "find", "look", "implement"], category: "search" },
  { name: "genius.find_best", summary: "Find single best implementation of a pattern", tags: ["search", "best", "github", "top", "recommend", "pick"], category: "search" },
  { name: "genius.explain", summary: "Score breakdown for a code result", tags: ["search", "explain", "ranking", "why", "score", "reason"], category: "search" },
  // Navigation
  { name: "code.reach", summary: "Find symbol with callers, callees, and deps", tags: ["navigation", "symbol", "callers"], category: "navigation" },
  { name: "code.map", summary: "Repository structure map with architecture detection", tags: ["navigation", "map", "architecture"], category: "navigation" },
  { name: "code.trace", summary: "Trace call chain between two functions", tags: ["navigation", "trace", "callgraph"], category: "navigation" },
  { name: "code.symbols", summary: "List exported symbols in a scope", tags: ["navigation", "symbols", "exports"], category: "navigation" },
  { name: "code.understand", summary: "Compressed module analysis with purpose detection", tags: ["navigation", "understand", "analysis"], category: "navigation" },
  // GitHub
  { name: "github.search_repos", summary: "Search GitHub repositories by topic/stars", tags: ["github", "search", "repos"], category: "github" },
  { name: "github.search_code", summary: "Search code across all of GitHub", tags: ["github", "search", "code"], category: "github" },
  { name: "github.repo_overview", summary: "Repository summary with README and stats", tags: ["github", "overview", "repo"], category: "github" },
  { name: "github.repo_file", summary: "Read specific file from GitHub repo", tags: ["github", "file", "read"], category: "github" },
  { name: "github.repo_tree", summary: "File tree of a GitHub repository", tags: ["github", "tree", "files"], category: "github" },
  { name: "github.compare", summary: "Compare two repos side by side", tags: ["github", "compare"], category: "github" },
  { name: "memory.recall", summary: "Search code memory for patterns from past sessions", tags: ["memory", "recall", "search", "remember", "found", "previous", "history", "past"], category: "memory" },
  { name: "memory.store", summary: "Store code pattern with confidence score", tags: ["memory", "store", "save", "remember", "keep", "bookmark"], category: "memory" },
  { name: "memory.evolve", summary: "Version a pattern while preserving lineage", tags: ["memory", "evolve", "update", "improve", "refine", "version"], category: "memory" },
  { name: "memory.stats", summary: "Memory health and confidence distribution", tags: ["memory", "stats", "health", "count", "size", "how many"], category: "memory" },
  // Research
  { name: "research.start_chain", summary: "Begin multi-step research investigation", tags: ["research", "chain", "start"], category: "research" },
  { name: "research.add_step", summary: "Add evidence to ongoing investigation", tags: ["research", "step", "evidence"], category: "research" },
  { name: "research.conclude", summary: "Conclude research with validated findings", tags: ["research", "conclude", "decision"], category: "research" },
  { name: "research.archaeology", summary: "Trace code evolution via git history", tags: ["research", "history", "archaeology"], category: "research" },
  { name: "research.deep_compare", summary: "Multi-repo quality comparison", tags: ["research", "compare", "quality"], category: "research" },
  // Import
  { name: "import.extract", summary: "Extract code from GitHub with provenance tracking", tags: ["import", "extract", "provenance", "copy", "get", "download", "license"], category: "import" },
] as const;

export function registerDynamicTools(server: McpServer): void {
  // Tool 1: Discover capabilities by intent
  server.tool(
    "forge_discover",
    "Search ForgeMCP capabilities by intent. Returns matching tool names with one-line descriptions. " +
    "Example: forge_discover('find rate limiter code') → genius.hunt, genius.find_best",
    { query: z.string().min(1).describe("What you want to do — natural language") },
    async ({ query }) => {
      const q = query.toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);

      const scored = TOOL_CATALOG.map((tool) => {
        let score = 0;
        for (const term of terms) {
          if (tool.tags.some((tag) => tag.includes(term))) score += 2;
          if (tool.name.toLowerCase().includes(term)) score += 3;
          if (tool.summary.toLowerCase().includes(term)) score += 1;
        }
        return { tool, score };
      });

      const matches = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((s) => s.tool);

      if (matches.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No matching tools for "${query}". Categories: search, navigation, github, memory, research, import.\n\nAll tools:\n` +
              TOOL_CATALOG.map((t) => `  ${t.name} — ${t.summary}`).join("\n"),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: matches.map((t) => `${t.name} — ${t.summary}`).join("\n"),
        }],
      };
    },
  );

  // Tool 2: Get full schema for a specific tool
  server.tool(
    "forge_describe",
    "Get full input schema and usage example for a ForgeMCP tool. Call forge_discover first to find tool names.",
    { tool_name: z.string().describe("Exact tool name from forge_discover") },
    async ({ tool_name }) => {
      const entry = TOOL_CATALOG.find((t) => t.name === tool_name);
      if (!entry) {
        return {
          content: [{
            type: "text" as const,
            text: `Unknown tool: "${tool_name}". Use forge_discover to find available tools.`,
          }],
        };
      }

      // since all tools are registered on the MCP server (dynamic tools coexist with normal ones)
      return {
        content: [{
          type: "text" as const,
          text: `Tool: ${entry.name}\nCategory: ${entry.category}\nDescription: ${entry.summary}\nTags: ${entry.tags.join(", ")}\n\nThis tool is registered as "${entry.name}" on the MCP server. Call it directly with its parameters.`,
        }],
      };
    },
  );
}
