#!/usr/bin/env node
// Fires when Claude Code is about to compress context. Save what matters.

import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET_PATH = join(tmpdir(), "forgemcp-daemon.sock");

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let event;
  try { event = JSON.parse(raw); } catch { process.exit(0); }

  try {
    const socket = connect(SOCKET_PATH);
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        type: "save_context",
        sessionId: event.session_id ?? "unknown",
        timestamp: Date.now(),
      }) + "\n");
      socket.end();
    });
    socket.on("error", () => {});
    // Give 100ms for send, then exit
    setTimeout(() => process.exit(0), 100);
  } catch {
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
