# Contributing to GeniusMCP

Thank you for your interest in GeniusMCP. Here's how to get started.

## Development Setup

```bash
git clone https://github.com/geniussigmaskibidi-gif/geniusmcp
cd geniusmcp
pnpm install
pnpm build
```

## Running Tests

```bash
npx vitest run          # All 252 tests
npx vitest run --watch  # Watch mode
npx tsc --noEmit        # Type check
```

## Project Structure

```
packages/
  core/              — Types, config, errors, token budget, tiered responses
  db/                — SQLite WAL, blob store, search index, job queue
  ast-intelligence/  — Symbol extraction, call graph, signature compression
  repo-memory/       — Bayesian confidence + Ebbinghaus decay engine
  github-gateway/    — Octokit + rate governor + ETag cache + GraphQL batch
  data-sources/      — grep.app + searchcode + orchestrator + circuit breakers
  hunt-engine/       — Winnowing, scoring, classifier, SAC, early terminator
  importer/          — License policy + provenance + style adaptation
apps/
  mcp-server/        — MCP server + skills + auto-indexer + dynamic tools
tests/               — 252 tests across 22 suites
```

## How to Add a New Tool

1. Add tool definition in `apps/mcp-server/src/skills/` or `apps/mcp-server/src/tools/`
2. Register in the appropriate skill file using `server.tool()`
3. Add entry to `TOOL_CATALOG` in `apps/mcp-server/src/dynamic-tools.ts`
4. Write tests in `tests/`
5. Run `pnpm build && npx vitest run`

## How to Add a New Search Source

1. Create client in `packages/data-sources/src/`
2. Add source type to `DataSource` union in `types.ts`
3. Add query compilation in `query-compiler.ts`
4. Wire into `source-orchestrator.ts`
5. Add circuit breaker + bulkhead in `apps/mcp-server/src/index.ts`

## Code Style

- Mark new code with `// [GeniusMCP v2]` comments
- Use `ForgeResult<T>` for all fallible operations
- Never throw across package boundaries
- Prefer explicit over clever
- Tests are required for new functionality

## Pull Request Process

1. Fork and create a feature branch
2. Make changes with tests
3. Ensure `pnpm build && npx vitest run && npx tsc --noEmit` all pass
4. Open a PR with description of what and why

## Areas Where Help Is Needed

- **Language support** — add symbol extraction patterns for Ruby, PHP, C#, Swift
- **Search sources** — integrate new code search APIs
- **Benchmarks** — CodeSearchNet evaluation harness
- **Documentation** — usage guides, video tutorials
- **Performance** — profiling hot paths, cache optimization
