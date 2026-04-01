// Zero-config mode must work. Every setting has a default.

import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────
// Schema: validated at startup, crash-early on bad config
// ─────────────────────────────────────────────────────────────

const configSchema = z.object({
  // GitHub auth (PAT quickstart, App for production)
  githubToken: z.string().optional(),
  githubAppId: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  githubAppInstallationId: z.string().optional(),

  // Data paths
  dataDir: z.string().default(join(homedir(), ".forgemcp")),

  // Rate limits (conservative defaults per Pro research)
  maxConcurrencyRest: z.number().int().min(1).max(50).default(6),
  maxConcurrencyGraphql: z.number().int().min(1).max(10).default(2),
  maxConcurrencyCodeSearch: z.number().int().min(1).max(5).default(1),

  // Features
  semanticLaneEnabled: z.boolean().default(false),  // opt-in, no ML by default
  autoIndexOnView: z.boolean().default(true),
  readOnly: z.boolean().default(true),               // write tools need explicit escalation

  // Performance
  maxResponseTokens: z.number().int().default(8000),
  cacheMaxAge: z.number().int().default(86400),       // 24h default TTL

  blobSoftBudgetMb: z.number().int().default(2048),   // 2 GB soft limit
  blobHardBudgetMb: z.number().int().default(2355),   // soft × 1.15

  // MCP transport
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpPort: z.number().int().default(3847),

  // Debug
  debug: z.boolean().default(false),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  workerPoolSize: z.number().int().min(1).max(8).default(2),
  jobQueuePollMs: z.number().int().min(100).max(10000).default(1000),

  blobGcGraceDays: z.number().int().min(1).max(90).default(7),
  blobScrubSampleRate: z.number().min(0.001).max(1).default(0.01),

  healthCheckIntervalMs: z.number().int().min(5000).max(300000).default(60000),
});

export type AppConfig = z.infer<typeof configSchema>;

// ─────────────────────────────────────────────────────────────
// Load config from environment with prefix FORGEMCP_
// ─────────────────────────────────────────────────────────────

export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const env = process.env;

  const raw = {
    githubToken: env["GITHUB_TOKEN"] ?? env["FORGEMCP_GITHUB_TOKEN"],
    githubAppId: env["FORGEMCP_APP_ID"],
    githubAppPrivateKey: env["FORGEMCP_APP_PRIVATE_KEY"],
    githubAppInstallationId: env["FORGEMCP_APP_INSTALLATION_ID"],
    dataDir: env["FORGEMCP_DATA_DIR"],
    maxConcurrencyRest: env["FORGEMCP_MAX_CONCURRENCY_REST"]
      ? Number(env["FORGEMCP_MAX_CONCURRENCY_REST"])
      : undefined,
    maxConcurrencyGraphql: env["FORGEMCP_MAX_CONCURRENCY_GRAPHQL"]
      ? Number(env["FORGEMCP_MAX_CONCURRENCY_GRAPHQL"])
      : undefined,
    maxConcurrencyCodeSearch: env["FORGEMCP_MAX_CONCURRENCY_CODE_SEARCH"]
      ? Number(env["FORGEMCP_MAX_CONCURRENCY_CODE_SEARCH"])
      : undefined,
    semanticLaneEnabled: env["FORGEMCP_SEMANTIC_LANE"] === "true",
    autoIndexOnView: env["FORGEMCP_AUTO_INDEX"] !== "false",
    readOnly: env["FORGEMCP_READ_ONLY"] !== "false",
    transport: env["FORGEMCP_TRANSPORT"] as "stdio" | "http" | undefined,
    httpPort: env["FORGEMCP_HTTP_PORT"]
      ? Number(env["FORGEMCP_HTTP_PORT"])
      : undefined,
    debug: env["FORGEMCP_DEBUG"] === "true",
    logLevel: env["FORGEMCP_LOG_LEVEL"] as AppConfig["logLevel"] | undefined,
    ...overrides,
  };

  // Strip undefined values before parsing (Zod defaults handle them)
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  );

  return configSchema.parse(cleaned);
}

// ─────────────────────────────────────────────────────────────
// Derived paths: computed from dataDir
// ─────────────────────────────────────────────────────────────

export interface DataPaths {
  readonly root: string;        // ~/.forgemcp
  readonly dbFile: string;      // ~/.forgemcp/forgemcp.db
  readonly blobDir: string;     // ~/.forgemcp/blobs/
  readonly indexDir: string;    // ~/.forgemcp/index/
  readonly lanceDir: string;    // ~/.forgemcp/lance/ (only if semantic enabled)
  readonly cacheDir: string;    // ~/.forgemcp/cache/
}

export function deriveDataPaths(config: AppConfig): DataPaths {
  const root = config.dataDir;
  return {
    root,
    dbFile: join(root, "forgemcp.db"),
    blobDir: join(root, "blobs"),
    indexDir: join(root, "index"),
    lanceDir: join(root, "lance"),
    cacheDir: join(root, "cache"),
  };
}
