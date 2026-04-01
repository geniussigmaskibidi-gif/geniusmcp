#!/usr/bin/env node
// Wires together: database → blob store → memory engine → hook daemon → MCP skills
// Design: stdio transport default, hook daemon for auto-capture, graceful shutdown

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, deriveDataPaths } from "@forgemcp/core";
import {
  openDatabase, migrateDatabase, closeDatabase, warmupDatabase, runOptimize,
  createBlobStore, createFileRefStore, createDerivationStore,
  createSearchIndex,
} from "@forgemcp/db";
import { createMemoryEngine } from "@forgemcp/repo-memory";
import { createHookDaemon } from "./hook-daemon.js";
import { registerMemorySkill } from "./skills/memory-skill.js";
import { registerCodeNavSkill } from "./skills/code-nav-skill.js";
import { registerGitHubSkill } from "./skills/github-skill.js";
import { registerResearchSkill } from "./skills/research-skill.js";
import { registerHuntSkill } from "./skills/hunt-skill.js";
import { createGitHubGateway } from "@forgemcp/github-gateway";
import {
  createGrepAppClient, createSearchCodeClient, createSourceOrchestrator,
  CircuitBreaker, Bulkhead, SourceSelector,
} from "@forgemcp/data-sources";
import { registerDynamicTools } from "./dynamic-tools.js";
import { startAutoIndex } from "./auto-indexer.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const paths = deriveDataPaths(config);

  // ── Database with WAL + optimal PRAGMAs ──
  const db = openDatabase(paths.dbFile);
  migrateDatabase(db);
  warmupDatabase(db);  // v1.0: PRAGMA optimize=0x10002 for fresh connections

  // Periodic optimize (every hour)
  const optimizeInterval = setInterval(() => runOptimize(db), 3600_000);

  // ── Core stores ──
  const blobStore = createBlobStore(db, paths.blobDir);
  const fileRefStore = createFileRefStore(db);
  const derivationStore = createDerivationStore(db);
  const searchIndex = createSearchIndex(db);

  // ── Memory Engine (the heart of ForgeMCP) ──
  const memory = createMemoryEngine(db);

  // ── Hook Daemon (Unix socket for auto-capture hooks) ──
  const daemon = createHookDaemon(memory);
  daemon.start();

  // ── MCP Server ──
  const server = new McpServer({
    name: "geniusmcp",
    version: "0.1.0",
  });

  // ── GitHub Gateway ──
  const github = createGitHubGateway(config.githubToken);

  // ── Register skills ──
  registerMemorySkill(server, db, blobStore);
  registerCodeNavSkill(server, db);
  registerGitHubSkill(server, github);
  registerResearchSkill(server, db, github);

  // ── Hunt Engine (multi-source code intelligence) ──
  const grepApp = createGrepAppClient();
  const searchCode = createSearchCodeClient();
  const orchestrator = createSourceOrchestrator(grepApp, searchCode, github);

  const breakers = {
    github: new CircuitBreaker({ name: "github_code", failureThreshold: 3, recoveryMs: 15_000 }),
    grepApp: new CircuitBreaker({ name: "grep_app", failureThreshold: 3, recoveryMs: 10_000 }),
    searchcode: new CircuitBreaker({ name: "searchcode", failureThreshold: 5, recoveryMs: 20_000 }),
  };
  const bulkheads = {
    github: new Bulkhead({ name: "github_code", maxConcurrent: 5 }),
    grepApp: new Bulkhead({ name: "grep_app", maxConcurrent: 3 }),
    searchcode: new Bulkhead({ name: "searchcode", maxConcurrent: 3 }),
  };

  const sourceSelector = new SourceSelector({
    sources: ["github_code", "grep_app", "searchcode"],
    queryClasses: ["exact_symbol", "short_token", "phrase", "substring", "regex_like", "path", "mixed"],
  });

  registerHuntSkill(server, orchestrator, {
    breakers, bulkheads, sourceSelector,
    githubToken: config.githubToken,
    memory,
  });

  registerDynamicTools(server);

  // Makes code.reach, code.map, code.trace work immediately
  const cwd = process.cwd();
  const autoIndex = startAutoIndex(db, cwd);

  // ── Transport ──
  if (config.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  // ── Graceful shutdown ──
  const cleanup = (): void => {
    autoIndex.abort();
    clearInterval(optimizeInterval);
    daemon.stop();
    closeDatabase(db);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stderr.write(
    `Server running. Memory: ${memory.stats().totalPatterns} patterns. ` +
    `Hook daemon: ${daemon.socketPath}\n`,
  );
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
