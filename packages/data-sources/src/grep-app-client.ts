
import type { CompiledQuery, SourceHit } from "./types.js";

export interface GrepAppClient {
  search(queries: CompiledQuery[]): Promise<SourceHit[]>;
  getFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
  ping(): Promise<boolean>;
}

const GREP_APP_ENDPOINT = "https://mcp.grep.app";
const CALL_TIMEOUT_MS = 8000;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
} as const;

type JsonRpcEnvelope = Record<string, unknown>;

export function createGrepAppClient(): GrepAppClient {
  let sessionId: string | null = null;
  let initialized = false;

  async function ensureInitialized(): Promise<boolean> {
    if (initialized) return true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    try {
      const response = await fetch(GREP_APP_ENDPOINT, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "forgemcp", version: "1.0.0" },
          },
          id: "init-1",
        }),
        signal: controller.signal,
      });

      updateSessionId(response);
      await consumeResponse(response);

      if (!response.ok) {
        process.stderr.write(
          `grep.app initialize failed: ${response.status} ${response.statusText}\n`,
        );
        return false;
      }

      initialized = true;

      try {
        const notifyResponse = await fetch(GREP_APP_ENDPOINT, {
          method: "POST",
          headers: {
            ...MCP_HEADERS,
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        });

        updateSessionId(notifyResponse);
        await consumeResponse(notifyResponse);

        if (!notifyResponse.ok) {
          process.stderr.write(
            `grep.app notifications/initialized failed: ` +
            `${notifyResponse.status} ${notifyResponse.statusText}\n`,
          );
        }
      } catch (error: unknown) {
        logError("grep.app initialized notification failed", error);
      }

      return true;
    } catch (error: unknown) {
      logError("grep.app initialize failed", error);
      initialized = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callTool(tool: string, args: Record<string, unknown>): Promise<string | null> {
    if (!(await ensureInitialized())) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    try {
      const response = await fetch(GREP_APP_ENDPOINT, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: tool, arguments: args },
          id: Date.now(),
        }),
        signal: controller.signal,
      });

      updateSessionId(response);
      const text = await extractTextFromResponse(response);

      if (!response.ok) {
        if (response.status === 429) {
          process.stderr.write("grep.app rate limited\n");
        } else {
          process.stderr.write(
            `grep.app tool call failed (${tool}): ` +
            `${response.status} ${response.statusText}\n`,
          );
        }
        return null;
      }

      return text;
    } catch (error: unknown) {
      logError(`grep.app tool call failed (${tool})`, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function updateSessionId(response: Response): void {
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) {
      sessionId = nextSessionId;
    }
  }

  return {
    async search(queries) {
      const relevantQueries = queries.filter((query) => query.source === "grep_app");
      const settled = await Promise.allSettled(
        relevantQueries.map(async (query) => {
          const langFilter = asOptionalString(query.parameters["langFilter"]);
          const args: Record<string, unknown> = {
            query: query.queryText,
          };

          if (langFilter) {
            args.language = [capitalizeLanguage(langFilter)];
          }
          if (query.parameters["wholeWords"] === true) {
            args.matchWholeWords = true;
          }

          const result = await callTool("searchGitHub", args);
          if (typeof result !== "string" || result.trim().length === 0) {
            return [] as SourceHit[];
          }

          return parseGrepAppResponse(result, query.queryText, langFilter ?? null);
        }),
      );

      const hits: SourceHit[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") {
          hits.push(...result.value);
        } else {
          logError("grep.app search promise rejected", result.reason);
        }
      }

      return hits;
    },

    async getFile(owner, repo, path, ref) {
      const result = await callTool("github_file", {
        owner,
        repo,
        path,
        ...(ref ? { ref } : {}),
      });
      return typeof result === "string" && result.length > 0 ? result : null;
    },

    async ping() {
      return ensureInitialized();
    },
  };
}

async function consumeResponse(response: Response): Promise<void> {
  try {
    await extractTextFromResponse(response);
  } catch (error: unknown) {
    logError("grep.app response consumption failed", error);
  }
}

async function extractTextFromResponse(response: Response): Promise<string | null> {
  const body = await response.text();
  if (!body) return null;

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const payloads = parseSsePayloads(body);
    const texts = payloads.flatMap((payload) => extractTextBlocksFromEnvelope(payload));
    return texts.length > 0 ? texts.join("\n") : null;
  }

  try {
    const parsed = JSON.parse(body) as JsonRpcEnvelope;
    const texts = extractTextBlocksFromEnvelope(parsed);
    if (texts.length > 0) return texts.join("\n");
  } catch (error: unknown) {
    logError("grep.app JSON response parse failed", error);
  }

  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSsePayloads(body: string): unknown[] {
  const normalizedBody = body.replace(/\r\n/g, "\n");
  const blocks = normalizedBody.split(/\n\n+/);
  const payloads: unknown[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;

    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) continue;

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") continue;

    try {
      payloads.push(JSON.parse(data));
    } catch (error: unknown) {
      logError("grep.app SSE payload parse failed", error);
      payloads.push(data);
    }
  }

  return payloads;
}

function extractTextBlocksFromEnvelope(value: unknown): string[] {
  if (value == null) return [];

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextBlocksFromEnvelope(item));
  }

  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const texts: string[] = [];

  if (record.type === "text" && typeof record.text === "string") {
    const trimmed = record.text.trim();
    if (trimmed) texts.push(trimmed);
  }

  if (Array.isArray(record.content)) {
    texts.push(...record.content.flatMap((item) => extractTextBlocksFromEnvelope(item)));
  }

  if (record.result !== undefined) {
    texts.push(...extractTextBlocksFromEnvelope(record.result));
  }

  if (record.params !== undefined) {
    texts.push(...extractTextBlocksFromEnvelope(record.params));
  }

  if (texts.length === 0 && typeof record.text === "string") {
    const trimmed = record.text.trim();
    if (trimmed) texts.push(trimmed);
  }

  return texts;
}

function parseGrepAppResponse(text: string, queryVariant: string, language: string | null): SourceHit[] {
  const hits: SourceHit[] = [];
  const blocks = text.split(/(?=^Repository:\s)/m);

  for (const block of blocks) {
    if (!block.includes("Repository:")) continue;

    const repo = matchLine(block, "Repository");
    const path = matchLine(block, "Path");
    if (!repo || !path) continue;

    const url = matchLine(block, "URL") ?? `https://github.com/${repo}/blob/HEAD/${path}`;
    const snippet = extractSnippet(block);
    const detectedLanguage = language ?? detectFenceLanguage(block) ?? inferLanguageFromPath(path);

    hits.push({
      source: "grep_app",
      queryVariant,
      repo,
      path,
      snippet,
      lineStart: null,
      url,
      language: detectedLanguage,
      discoveredAt: new Date().toISOString(),
    });
  }

  return hits;
}

function matchLine(block: string, label: string): string | null {
  const match = block.match(new RegExp(`^${label}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function extractSnippet(block: string): string {
  const snippets: string[] = [];
  const fencePattern = /```(?:[^\n]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;

  while ((match = fencePattern.exec(block)) !== null) {
    const snippet = match[1]?.trim();
    if (snippet) snippets.push(snippet);
  }

  if (snippets.length > 0) {
    return snippets.slice(0, 3).join("\n---\n");
  }

  const snippetsIndex = block.indexOf("Snippets:");
  if (snippetsIndex >= 0) {
    const remainder = block.slice(snippetsIndex + "Snippets:".length).trim();
    return remainder;
  }

  return "";
}

function detectFenceLanguage(block: string): string | null {
  const match = block.match(/```([^\n]*)\n/);
  const candidate = match?.[1]?.trim();
  return candidate ? candidate : null;
}

function inferLanguageFromPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
      return "java";
    default:
      return null;
  }
}

function capitalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();

  switch (normalized) {
    case "ts":
    case "typescript":
      return "TypeScript";
    case "js":
    case "javascript":
      return "JavaScript";
    case "py":
    case "python":
      return "Python";
    case "go":
      return "Go";
    case "rs":
    case "rust":
      return "Rust";
    case "csharp":
    case "cs":
      return "C#";
    case "cpp":
    case "c++":
      return "C++";
    default:
      return language.trim();
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function logError(message: string, error: unknown): void {
  process.stderr.write(`${message}: ${formatError(error)}\n`);
}

