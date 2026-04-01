// Runs inside MCP server process. Handles capture/inject events async.
// Pattern: fire-and-forget capture, synchronous inject response.
//
// Protocol:
//   Hook script → Unix socket → JSON line → daemon processes → optional response
//   capture: async (no response needed, hook already exited)
//   inject: sync response with { context: "..." }
//   save_context / session_end: async (fire-and-forget)

import { createServer, type Server, type Socket } from "node:net";
import {
  existsSync, unlinkSync, chmodSync, readFileSync, writeFileSync, mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { MemoryEngine } from "@forgemcp/repo-memory";

const SOCKET_PATH = join(tmpdir(), "forgemcp-daemon.sock");

export interface HookDaemon {
  start(): void;
  stop(): void;
  readonly socketPath: string;
}

export function createHookDaemon(memory: MemoryEngine): HookDaemon {
  let server: Server | null = null;
  let spoolInterval: ReturnType<typeof setInterval> | null = null;
  const SPOOL_DIR = join(homedir(), ".forgemcp", "spool");
  const SPOOL_FILE = join(SPOOL_DIR, "capture.jsonl");

  function drainSpool(): void {
    if (!existsSync(SPOOL_FILE)) return;
    try {
      const content = readFileSync(SPOOL_FILE, "utf-8").trim();
      if (!content) return;
      const lines = content.split("\n");
      let drained = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          handleCapture(event);
          drained++;
        } catch { /* skip malformed line */ }
      }
      // Clear spool after successful drain
      writeFileSync(SPOOL_FILE, "", "utf-8");
      if (drained > 0) {
        process.stderr.write(`Drained ${drained} spooled capture events\n`);
      }
    } catch {
      // Spool read failed — will retry next interval
    }
  }

  function handleConnection(socket: Socket): void {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleEvent(event, socket);
        } catch {
          // Invalid JSON — skip
        }
      }
    });

    socket.on("error", () => { /* client disconnected, expected */ });
  }

  function handleEvent(event: Record<string, unknown>, socket: Socket): void {
    const type = event["type"] as string;

    switch (type) {
      case "capture":
        handleCapture(event);
        // No response needed — hook already exited
        break;

      case "inject":
        handleInject(event, socket);
        // Synchronous response with context
        break;

      case "save_context":
        handleSaveContext(event);
        break;

      case "session_end":
        handleSessionEnd(event);
        break;

      default:
        // Unknown event type — ignore
        break;
    }
  }

  function handleCapture(event: Record<string, unknown>): void {
    const filePath = event["filePath"] as string;
    const toolName = event["toolName"] as string;
    const sessionId = event["sessionId"] as string;

    if (!filePath) return;

    // Read file content (hook doesn't send it to keep stdin small)
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return; // file not readable
    }

    const sourceType = toolName === "Read" ? "file_read" as const : "code_write" as const;

    // Capture async — don't block
    try {
      const result = memory.captureFromFile(filePath, content, sourceType, sessionId);
      if (result.symbolsCaptured > 0) {
        // Log for debugging (stderr, not stdout)
        process.stderr.write(
          `Captured ${result.symbolsCaptured} symbols from ${filePath}\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`Capture error: ${err}\n`);
    }
  }

  function handleInject(event: Record<string, unknown>, socket: Socket): void {
    const prompt = event["prompt"] as string;
    const sessionId = event["sessionId"] as string;

    if (!prompt) {
      socket.end(JSON.stringify({ context: null }));
      return;
    }

    try {
      const context = memory.buildInjection(prompt, sessionId);
      socket.end(JSON.stringify({ context }));
    } catch {
      socket.end(JSON.stringify({ context: null }));
    }
  }

  function handleSaveContext(event: Record<string, unknown>): void {
    // Run memory decay as a save-context action
    try {
      const decayed = memory.runDecay();
      if (decayed > 0) {
        process.stderr.write(`Decayed ${decayed} old patterns\n`);
      }
    } catch {
      // Non-critical
    }
  }

  function handleSessionEnd(event: Record<string, unknown>): void {
    // Run decay + compile session stats
    try {
      memory.runDecay();
      const stats = memory.stats();
      process.stderr.write(
        `Session ended. Memory: ${stats.totalPatterns} patterns, ` +
        `${stats.sessionsTracked} sessions tracked\n`,
      );
    } catch {
      // Non-critical
    }
  }

  return {
    start() {
      // Clean up stale socket
      if (existsSync(SOCKET_PATH)) {
        try { unlinkSync(SOCKET_PATH); } catch { /* ok */ }
      }

      server = createServer(handleConnection);
      server.listen(SOCKET_PATH, () => {
        try { chmodSync(SOCKET_PATH, 0o600); } catch { /* best-effort */ }
        process.stderr.write(`Hook daemon listening on ${SOCKET_PATH}\n`);
      });

      server.on("error", (err) => {
        process.stderr.write(`Daemon error: ${err}\n`);
      });

      drainSpool();
      spoolInterval = setInterval(drainSpool, 30_000);
    },

    stop() {
      if (spoolInterval) { clearInterval(spoolInterval); spoolInterval = null; }
      if (server) { server.close(); server = null; }
      if (existsSync(SOCKET_PATH)) {
        try { unlinkSync(SOCKET_PATH); } catch { /* ok */ }
      }
    },

    socketPath: SOCKET_PATH,
  };
}
