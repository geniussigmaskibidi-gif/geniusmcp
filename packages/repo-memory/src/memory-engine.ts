// This is THE differentiator. No other code tool uses Claude Code hooks for
// auto-capture + pre-prompt injection of relevant past code patterns.
//
// Architecture (from claude-mem research + 10 Pro rounds):
//   - Fire-and-forget capture: hooks enqueue, daemon processes async
//   - Progressive disclosure: index → timeline → details (26x token savings)
//   - Bayesian confidence: (successes + prior) / (total + prior_weight)
//   - Ebbinghaus decay: R(t) = e^(-t/S), S grows with recalls
//   - RRF fusion: combine FTS5 BM25 + trigram + structural results

import type { Database } from "@forgemcp/db";
import type { Pattern, PatternKind, PatternSource, Session } from "@forgemcp/core";
import { extractSymbols, detectLanguage } from "@forgemcp/ast-intelligence";
import { hashContent } from "@forgemcp/db";

// ─────────────────────────────────────────────────────────────
// Confidence: Bayesian smoothed (avoids zero-division, calibrated)
// ─────────────────────────────────────────────────────────────

/** Bayesian smoothed confidence. Prior: α=1, β=1 (uniform). */
/** Human-readable time since a date. */
function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function bayesianConfidence(recalled: number, successful: number): number {
  return (successful + 1) / (recalled + 2); // (s + α) / (n + α + β)
}

// ─────────────────────────────────────────────────────────────
// Decay: Ebbinghaus forgetting curve R(t) = e^(-t/S)
// S (strength) grows logarithmically with recall count
// ─────────────────────────────────────────────────────────────

/** Memory strength: grows with each successful recall. */
export function memoryStrength(timesRecalled: number): number {
  // S starts at 7 days, grows logarithmically
  return 7 * (1 + Math.log2(1 + timesRecalled));
}

/** Retention at time t (days since last recall). 0-1 scale. */
export function retention(daysSinceRecall: number, timesRecalled: number): number {
  const S = memoryStrength(timesRecalled);
  return Math.exp(-daysSinceRecall / S);
}

/** Should this pattern be decayed? (retention < threshold) */
export function shouldDecay(lastRecalledAt: string | null, timesRecalled: number, now: Date = new Date()): boolean {
  if (!lastRecalledAt) return false;
  const days = (now.getTime() - new Date(lastRecalledAt).getTime()) / (1000 * 60 * 60 * 24);
  return retention(days, timesRecalled) < 0.3; // decay at 30% retention
}

/** Apply decay: reduce confidence by retention factor. Floor at 0.1. */
export function applyDecay(confidence: number, daysSinceRecall: number, timesRecalled: number): number {
  const r = retention(daysSinceRecall, timesRecalled);
  return Math.max(0.1, confidence * r);
}

// ─────────────────────────────────────────────────────────────
// Memory Engine: store, recall, capture, inject
// ─────────────────────────────────────────────────────────────

export interface MemoryEngine {
  /** Store a pattern explicitly. Returns pattern ID. */
  store(opts: StoreOptions): number;

  /** Recall relevant patterns for a query. Updates recall stats. */
  recall(query: string, opts?: RecallOptions): RecallResult;

  /** Auto-capture from a file read/write (hook-driven). */
  captureFromFile(filePath: string, content: string, sourceType: PatternSource, sessionId: string): CaptureResult;

  /** Build injection context for UserPromptSubmit hook. */
  buildInjection(prompt: string, sessionId: string): string | null;

  /** Mark a pattern as successfully used (e.g., tests passed). */
  markSuccess(patternId: number): void;

  /** Apply Ebbinghaus decay to old patterns. Call periodically. */
  runDecay(): number;

  /** Get memory statistics. */
  stats(): MemoryStats;
}

export interface StoreOptions {
  name: string;
  kind: PatternKind;
  code?: string;
  language?: string;
  signature?: string;
  description?: string;
  sourceType?: PatternSource;
  sourceRepo?: string;
  sourcePath?: string;
  sourceCommitSha?: string;
  tags?: string[];
  sessionId?: string;
}

export interface RecallOptions {
  limit?: number;
  language?: string;
  minConfidence?: number;
}

export interface RecallResult {
  patterns: Array<Pattern & { relevanceScore: number }>;
  total: number;
  searchTimeMs: number;
}

export interface CaptureResult {
  symbolsCaptured: number;
  skipped: boolean;
  reason?: string;
}

export interface MemoryStats {
  totalPatterns: number;
  byKind: Record<string, number>;
  byLanguage: Record<string, number>;
  topConfident: Array<{ id: number; name: string; confidence: number }>;
  mostRecalled: Array<{ id: number; name: string; timesRecalled: number }>;
  sessionsTracked: number;
  reposIndexed: number;
}

// ─────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────

export function createMemoryEngine(db: Database.Database): MemoryEngine {

  // ── Prepared statements ──

  const insertPattern = db.prepare(`
    INSERT INTO patterns (name, kind, language, code, signature, description,
      source_type, source_repo, source_path, source_commit_sha,
      source_session_id, quality_score, confidence, ast_fingerprint)
    VALUES (@name, @kind, @language, @code, @signature, @description,
      @sourceType, @sourceRepo, @sourcePath, @sourceCommitSha,
      @sessionId, @qualityScore, @confidence, @fingerprint)
  `);

  const insertTag = db.prepare(
    `INSERT OR IGNORE INTO pattern_tags (pattern_id, tag) VALUES (?, ?)`,
  );

  const searchFts = db.prepare(`
    SELECT p.*, bm25(patterns_fts) as rank
    FROM patterns_fts f
    JOIN patterns p ON p.id = f.rowid
    WHERE patterns_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const searchAll = db.prepare(`
    SELECT * FROM patterns
    ORDER BY confidence DESC, times_recalled DESC
    LIMIT ?
  `);

  const updateRecalled = db.prepare(`
    UPDATE patterns
    SET times_recalled = times_recalled + 1,
        last_recalled_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateSuccess = db.prepare(`
    UPDATE patterns
    SET times_used_successfully = times_used_successfully + 1,
        confidence = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const getPattern = db.prepare(`SELECT * FROM patterns WHERE id = ?`);

  const findByFingerprint = db.prepare(
    `SELECT id FROM patterns WHERE ast_fingerprint = ? LIMIT 1`,
  );

  const decayCandidates = db.prepare(`
    SELECT id, confidence, last_recalled_at, times_recalled
    FROM patterns
    WHERE last_recalled_at IS NOT NULL
      AND last_recalled_at < datetime('now', '-7 days')
  `);

  const updateDecay = db.prepare(
    `UPDATE patterns SET confidence = ?, updated_at = datetime('now') WHERE id = ?`,
  );

  // Stats queries
  const countPatterns = db.prepare(`SELECT COUNT(*) as cnt FROM patterns`);
  const countByKind = db.prepare(`SELECT kind, COUNT(*) as cnt FROM patterns GROUP BY kind`);
  const countByLang = db.prepare(`SELECT language, COUNT(*) as cnt FROM patterns WHERE language IS NOT NULL GROUP BY language`);
  const topConfident = db.prepare(`SELECT id, name, confidence FROM patterns ORDER BY confidence DESC LIMIT 5`);
  const mostRecalled = db.prepare(`SELECT id, name, times_recalled FROM patterns ORDER BY times_recalled DESC LIMIT 5`);
  const countSessions = db.prepare(`SELECT COUNT(*) as cnt FROM sessions`);
  const countRepos = db.prepare(`SELECT COUNT(*) as cnt FROM repos WHERE indexed_at IS NOT NULL`);

  const updateSessionCapture = db.prepare(`
    UPDATE sessions SET patterns_captured = patterns_captured + ? WHERE id = ?
  `);
  const updateSessionRecall = db.prepare(`
    UPDATE sessions SET patterns_recalled = patterns_recalled + ? WHERE id = ?
  `);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, project_path) VALUES (?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  // ── Capture: skip trivial files ──

  const SKIP_PATTERNS = [
    /node_modules/,
    /\.git\//,
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /\.min\.(js|css)$/,
    /dist\//,
    /build\//,
    /\.map$/,
    /\.d\.ts$/, // skip declaration files for capture (too noisy)
  ];

  const MIN_LINES = 5;
  const MAX_BYTES = 500_000; // 500KB

  function shouldSkipFile(path: string, content: string): string | null {
    for (const rx of SKIP_PATTERNS) {
      if (rx.test(path)) return `matched skip pattern: ${rx.source}`;
    }
    const lines = content.split("\n").length;
    if (lines < MIN_LINES) return `too short: ${lines} lines`;
    if (content.length > MAX_BYTES) return `too large: ${(content.length / 1024).toFixed(0)}KB`;
    return null;
  }

  // ── Engine ──

  return {
    store(opts) {
      let fingerprint: string | null = null;
      if (opts.code) {
        fingerprint = hashContent(opts.code).slice(0, 16);
        // Dedup: skip if same fingerprint exists
        const existing = findByFingerprint.get(fingerprint) as { id: number } | undefined;
        if (existing) return existing.id;
      }

      const result = insertPattern.run({
        name: opts.name,
        kind: opts.kind,
        language: opts.language ?? null,
        code: opts.code ?? null,
        signature: opts.signature ?? null,
        description: opts.description ?? null,
        sourceType: opts.sourceType ?? "manual",
        sourceRepo: opts.sourceRepo ?? null,
        sourcePath: opts.sourcePath ?? null,
        sourceCommitSha: opts.sourceCommitSha ?? null,
        sessionId: opts.sessionId ?? null,
        qualityScore: 0.5,
        confidence: 0.5,
        fingerprint,
      });

      const patternId = Number(result.lastInsertRowid);

      if (opts.tags?.length) {
        const tagTx = db.transaction(() => {
          for (const tag of opts.tags!) insertTag.run(patternId, tag);
        });
        tagTx();
      }

      return patternId;
    },

    recall(query, opts = {}) {
      const start = performance.now();
      const limit = opts.limit ?? 10;
      const minConf = opts.minConfidence ?? 0.2;

      let rows: Array<Record<string, unknown>>;
      try {
        rows = searchFts.all(query, limit * 3) as Array<Record<string, unknown>>;
      } catch {
        // FTS query syntax error → fall back
        rows = searchAll.all(limit * 3) as Array<Record<string, unknown>>;
      }

      // Filter by language and confidence
      const filtered = rows.filter((r) => {
        if (opts.language && r["language"] !== opts.language) return false;
        const conf = r["confidence"] as number;
        return conf >= minConf;
      }).slice(0, limit);

      // Update recall stats
      const recallTx = db.transaction(() => {
        for (const r of filtered) updateRecalled.run(r["id"]);
      });
      recallTx();

      const elapsed = performance.now() - start;

      return {
        patterns: filtered.map((r, i) => ({
          ...(r as unknown as Pattern),
          relevanceScore: 1 / (60 + i), // RRF-style score by position
        })),
        total: filtered.length,
        searchTimeMs: Math.round(elapsed),
      };
    },

    captureFromFile(filePath, content, sourceType, sessionId) {
      const skipReason = shouldSkipFile(filePath, content);
      if (skipReason) return { symbolsCaptured: 0, skipped: true, reason: skipReason };

      const language = detectLanguage(filePath);
      if (!language) return { symbolsCaptured: 0, skipped: true, reason: "unknown language" };

      // Ensure session exists
      upsertSession.run(sessionId, process.cwd());

      // Extract symbols via AST/regex
      const { symbols } = extractSymbols(content, language);
      if (symbols.length === 0) return { symbolsCaptured: 0, skipped: true, reason: "no symbols found" };

      // Store each symbol as a pattern (deduplicated by fingerprint)
      let captured = 0;
      const captureTx = db.transaction(() => {
        for (const sym of symbols) {
          // Only capture exported symbols (avoid internal noise)
          if (!sym.exported) continue;

          const fingerprint = sym.astFingerprint;
          const existing = findByFingerprint.get(fingerprint) as { id: number } | undefined;
          if (existing) continue; // already in memory

          insertPattern.run({
            name: sym.name,
            kind: sym.kind,
            language,
            code: sym.code.slice(0, 10000), // cap at 10KB
            signature: sym.signature,
            description: sym.docComment,
            sourceType,
            sourceRepo: null, // filled later if from GitHub
            sourcePath: filePath,
            sourceCommitSha: null,
            sessionId,
            qualityScore: 0.5,
            confidence: 0.5,
            fingerprint,
          });
          captured++;
        }
      });
      captureTx();

      // Update session stats
      if (captured > 0) {
        updateSessionCapture.run(captured, sessionId);
      }

      return { symbolsCaptured: captured, skipped: false };
    },

    buildInjection(prompt, sessionId) {
      // Layer 1 (card, 40-60 tokens): title + why + scope + confidence + caution
      // Layer 2 (capsule, 120-220 tokens): summary + signature + deps + freshness
      // Injection uses ONLY Layer 1/2. Layer 3 (full) via explicit memory.recall.
      //
      // Dynamic token budget: floor 250, normal 400-900, hard max 1500 tokens
      // Never exceed ~18% of estimated remaining context

      const { patterns } = this.recall(prompt, { limit: 5, minConfidence: 0.3 });

      if (patterns.length === 0) return null;

      // Inject only if: top score >= 0.62 AND top-second gap >= 0.07
      // OR: combined top-2 same-scope >= 1.10
      const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);
      const top = sorted[0]!.confidence;
      const second = sorted[1]?.confidence ?? 0;
      const topGap = top - second;

      const shouldInject = (top >= 0.62 && topGap >= 0.07) || (top + second >= 1.10);
      if (!shouldInject && top < 0.50) return null; // hard floor for any injection

      const injectable = sorted.filter((p) => p.confidence >= 0.35);
      if (injectable.length === 0) return null;

      // Short prompt (<400 tokens ~1600 chars): max 700 tokens injection
      // Medium (400-1200 tokens): max 500 tokens
      // Long (>1200 tokens): max 300 tokens
      // Hard cap: 800 tokens on hook path
      const promptLen = prompt.length;
      const CHAR_BUDGET = promptLen < 1600 ? 2800  // ~700 tokens
        : promptLen < 4800 ? 2000                   // ~500 tokens
        : 1200;                                      // ~300 tokens

      const cards: string[] = [];
      let totalChars = 0;

      for (const p of injectable) {
        // ── Layer 1: Card (40-60 tokens, ~160-240 chars) ──
        const conf = (p.confidence * 100).toFixed(0);
        const scope = p.sourceRepo ? `repo:${p.sourceRepo}` : "local";
        const freshness = p.lastRecalledAt
          ? `last used ${timeSince(p.lastRecalledAt)}`
          : "never recalled";
        const caution = p.confidence < 0.5 ? " ⚠️ low confidence" : "";

        let card = `- **${p.name}** [${p.kind}] — ${conf}% confidence${caution}\n`;
        card += `  Why: matches "${prompt.slice(0, 30)}..." | ${scope} | ${freshness}\n`;

        // ── Layer 2: Capsule (120-220 tokens, ~500-900 chars) ── only if budget allows
        if (totalChars + card.length + 500 < CHAR_BUDGET) {
          if (p.signature) card += `  Signature: \`${p.signature}\`\n`;
          if (p.description) card += `  Summary: ${p.description.slice(0, 200)}\n`;
          const deps = p.sourcePath ? `  Source: ${p.sourcePath}\n` : "";
          card += deps;
          if (p.timesRecalled > 0) {
            card += `  Recalled ${p.timesRecalled}x, ${p.timesUsedSuccessfully}x successful\n`;
          }
        }

        totalChars += card.length;
        if (totalChars > CHAR_BUDGET) break;
        cards.push(card);
      }

      if (cards.length === 0) return null;

      const header = "### Relevant memory\n";
      const footer = "\nUse `memory.recall(\"...\")` for full code (Layer 3).\n";
      const injection = header + cards.join("\n") + footer;

      // Update session recall stats
      upsertSession.run(sessionId, process.cwd());
      updateSessionRecall.run(cards.length, sessionId);

      return injection;
    },

    markSuccess(patternId) {
      const p = getPattern.get(patternId) as Record<string, unknown> | undefined;
      if (!p) return;
      const recalled = (p["times_recalled"] as number) + 1;
      const successful = (p["times_used_successfully"] as number) + 1;
      const newConf = bayesianConfidence(recalled, successful);
      updateSuccess.run(newConf, patternId);
    },

    runDecay() {
      const candidates = decayCandidates.all() as Array<{
        id: number; confidence: number; last_recalled_at: string; times_recalled: number;
      }>;

      let decayed = 0;
      const now = new Date();
      const decayTx = db.transaction(() => {
        for (const c of candidates) {
          const days = (now.getTime() - new Date(c.last_recalled_at).getTime()) / (1000 * 60 * 60 * 24);
          const newConf = applyDecay(c.confidence, days, c.times_recalled);
          if (newConf < c.confidence) {
            updateDecay.run(newConf, c.id);
            decayed++;
          }
        }
      });
      decayTx();

      return decayed;
    },

    stats() {
      return {
        totalPatterns: (countPatterns.get() as { cnt: number }).cnt,
        byKind: Object.fromEntries(
          (countByKind.all() as Array<{ kind: string; cnt: number }>).map(r => [r.kind, r.cnt]),
        ),
        byLanguage: Object.fromEntries(
          (countByLang.all() as Array<{ language: string; cnt: number }>).map(r => [r.language, r.cnt]),
        ),
        topConfident: topConfident.all() as Array<{ id: number; name: string; confidence: number }>,
        mostRecalled: mostRecalled.all() as Array<{ id: number; name: string; timesRecalled: number }>,
        sessionsTracked: (countSessions.get() as { cnt: number }).cnt,
        reposIndexed: (countRepos.get() as { cnt: number }).cnt,
      };
    },
  };
}
