#!/usr/bin/env node
// Fires after Read/Write/Edit. Sends event to daemon via Unix socket.
// MUST be fast (<20ms). Fire-and-forget: daemon processes async.
//
// Input: JSON on stdin with { tool_name, tool_input, tool_response, session_id }
// Output: none (exit 0 silently)

import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET_PATH = join(tmpdir(), "forgemcp-daemon.sock");
const TIMEOUT_MS = 50; // must be fast

async function main() {
  // Read hook event from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0); // invalid JSON, skip silently
  }

  const toolName = event.tool_name ?? "";
  const sessionId = event.session_id ?? "unknown";

  // Only capture Read, Write, Edit tool uses
  if (!["Read", "Write", "Edit"].includes(toolName)) {
    process.exit(0);
  }

  // Extract file path from tool input
  const filePath = event.tool_input?.file_path ?? event.tool_input?.path ?? null;
  if (!filePath) process.exit(0);

  // Build capture event for daemon
  const captureEvent = {
    type: "capture",
    toolName,
    filePath,
    sessionId,
    timestamp: Date.now(),
  };

  try {
    await sendToDaemon(captureEvent);
  } catch {
    // Daemon unreachable → append to spool for later drain
    try {
      const { mkdirSync, appendFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const spoolDir = join(homedir(), ".forgemcp", "spool");
      mkdirSync(spoolDir, { recursive: true });
      appendFileSync(
        join(spoolDir, "capture.jsonl"),
        JSON.stringify(captureEvent) + "\n",
        "utf-8",
      );
    } catch {
      // Spool write failed too — truly silent skip
    }
  }

  process.exit(0);
}

function sendToDaemon(event) {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(JSON.stringify(event) + "\n");
      clearTimeout(timer);
      socket.end();
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

main().catch(() => process.exit(0));
