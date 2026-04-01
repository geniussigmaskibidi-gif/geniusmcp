// Capability-oriented plugin architecture.
// Design: Declarative manifests, capability negotiation, lifecycle management.
// Research: VS Code extension model, ESLint plugin system.
// Note: In-process plugins are trusted code, not sandboxed security boundaries.

// ─────────────────────────────────────────────────────────────
// Plugin Manifest
// ─────────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Unique plugin identifier (npm-style, e.g. "@forgemcp/plugin-python") */
  readonly name: string;
  /** Semantic version */
  readonly version: string;
  /** Human-readable description */
  readonly description: string;
  /** Capabilities this plugin provides */
  readonly capabilities: PluginCapability[];
  /** Relative path to the JS entry module */
  readonly entryPoint: string;
  /** Maximum execution time per invocation (ms) */
  readonly timeoutMs: number;
  /** Minimum ForgeMCP version required */
  readonly minForgeMcpVersion?: string;
}

export type PluginCapability =
  | { type: "parser"; languages: string[] }
  | { type: "embedder"; model: string; dimensions: number }
  | { type: "search_backend"; id: string }
  | { type: "data_source"; id: string }
  | { type: "ranker"; id: string };

// ─────────────────────────────────────────────────────────────
// Plugin Lifecycle
// ─────────────────────────────────────────────────────────────

export type PluginState = "discovered" | "loading" | "ready" | "degraded" | "failed" | "stopped";

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly loadedAt: number;
  readonly lastError?: string;
  readonly capabilities: PluginCapability[];
}

export interface PluginHealth {
  readonly name: string;
  readonly state: PluginState;
  readonly uptime: number;
  readonly invocations: number;
  readonly errors: number;
  readonly avgLatencyMs: number;
}

// ─────────────────────────────────────────────────────────────
// Plugin Host Interface
// ─────────────────────────────────────────────────────────────

export interface PluginHost {
  /** Discover plugins from the plugins directory */
  discover(): Promise<PluginManifest[]>;
  /** Load a discovered plugin */
  load(name: string): Promise<LoadedPlugin>;
  /** Unload a plugin */
  unload(name: string): Promise<void>;
  /** Get health of all loaded plugins */
  health(): PluginHealth[];
  /** Get all plugins providing a specific capability type */
  byCapability(type: PluginCapability["type"]): LoadedPlugin[];
  /** Check if a capability is available */
  hasCapability(type: PluginCapability["type"], id?: string): boolean;
}

// ─────────────────────────────────────────────────────────────
// Plugin Host Implementation
// ─────────────────────────────────────────────────────────────

/**
 * Create a plugin host.
 *
 * Plugins are discovered from ~/.forgemcp/plugins/ directory.
 * Each plugin has a manifest.json and an entry point JS module.
 * Plugins are loaded dynamically and managed via the host.
 */
export function createPluginHost(pluginsDir: string): PluginHost {
  const loaded = new Map<string, LoadedPlugin & { invocations: number; errors: number; totalLatencyMs: number }>();

  return {
    async discover() {
      const { readdirSync, readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      if (!existsSync(pluginsDir)) return [];

      const dirs = readdirSync(pluginsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      const manifests: PluginManifest[] = [];
      for (const dir of dirs) {
        const manifestPath = join(pluginsDir, dir.name, "manifest.json");
        if (existsSync(manifestPath)) {
          try {
            const content = readFileSync(manifestPath, "utf-8");
            const manifest = JSON.parse(content) as PluginManifest;
            manifests.push(manifest);
          } catch {
            // Skip malformed manifests
          }
        }
      }
      return manifests;
    },

    async load(name) {
      const manifests = await this.discover();
      const manifest = manifests.find(m => m.name === name);
      if (!manifest) {
        const entry: LoadedPlugin & { invocations: number; errors: number; totalLatencyMs: number } = {
          manifest: { name, version: "0.0.0", description: "", capabilities: [], entryPoint: "", timeoutMs: 5000 },
          state: "failed",
          loadedAt: Date.now(),
          lastError: `Plugin ${name} not found`,
          capabilities: [],
          invocations: 0,
          errors: 0,
          totalLatencyMs: 0,
        };
        loaded.set(name, entry);
        return entry;
      }

      const entry: LoadedPlugin & { invocations: number; errors: number; totalLatencyMs: number } = {
        manifest,
        state: "ready",
        loadedAt: Date.now(),
        capabilities: manifest.capabilities,
        invocations: 0,
        errors: 0,
        totalLatencyMs: 0,
      };
      loaded.set(name, entry);
      return entry;
    },

    async unload(name) {
      loaded.delete(name);
    },

    health() {
      const results: PluginHealth[] = [];
      for (const [, plugin] of loaded) {
        results.push({
          name: plugin.manifest.name,
          state: plugin.state,
          uptime: Date.now() - plugin.loadedAt,
          invocations: plugin.invocations,
          errors: plugin.errors,
          avgLatencyMs: plugin.invocations > 0 ? plugin.totalLatencyMs / plugin.invocations : 0,
        });
      }
      return results;
    },

    byCapability(type) {
      return [...loaded.values()].filter(
        p => p.state === "ready" && p.capabilities.some(c => c.type === type)
      );
    },

    hasCapability(type, id) {
      return [...loaded.values()].some(
        p => p.state === "ready" && p.capabilities.some(
          c => c.type === type && (!id || ("id" in c && (c as { id?: string }).id === id))
        )
      );
    },
  };
}
