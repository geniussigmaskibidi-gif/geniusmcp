#!/usr/bin/env node
// Fires on EVERY user prompt. Searches memory, injects compact context.
// MUST be fast (<100ms). Returns JSON with additionalContext.
//
// Input: JSON on stdin with { session_id, ... }
// Output: JSON on stdout with { hookSpecificOutput: { additionalContext } }
//         OR empty (if no relevant memory found)

import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET_PATH = join(tmpdir(), "forgemcp-daemon.sock");
const TIMEOUT_MS = 200; // injection must be fast

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
    process.exit(0);
  }

  const sessionId = event.session_id ?? "unknown";

  // Extract the user's prompt text
  // UserPromptSubmit provides the prompt in different possible locations
  const prompt = event.user_prompt ?? event.prompt ?? event.tool_input?.prompt ?? "";
  if (!prompt || prompt.length < 10) process.exit(0); // too short to search

  // Ask daemon for memory injection
  try {
    const response = await queryDaemon({
      type: "inject",
      prompt,
      sessionId,
      timestamp: Date.now(),
    });

    if (response && response.context) {
      // Return injection via hookSpecificOutput.additionalContext
      const output = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: response.context,
        },
      };
      process.stdout.write(JSON.stringify(output));
    }
  } catch {
    // Daemon not running — skip silently
  }

  process.exit(0);
}

function queryDaemon(event) {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null); // timeout = no injection (don't block Claude)
    }, TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(JSON.stringify(event) + "\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
    });

    socket.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

main().catch(() => process.exit(0));
