// Extracts functions, classes, interfaces, types, consts from source code.
// Handles: TypeScript, JavaScript, Python, Go, Rust (~80% accuracy via regex).
// When @ast-grep/napi is available, switches to precise CST-based extraction.

import { createHash } from "node:crypto";
import type { SymbolKind } from "@forgemcp/core";

export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string | null;
  readonly docComment: string | null;
  readonly code: string;
  readonly astFingerprint: string;
  readonly imports: string[];
}

export interface ExtractionResult {
  readonly symbols: ExtractedSymbol[];
  readonly engine: "ast-grep" | "regex-fallback";
  readonly language: string;
}

// ── AST Fingerprint: normalize then hash ──
// Removes identifiers/literals → structural skeleton → SHA-256
export function computeAstFingerprint(code: string): string {
  let n = code.replace(/\s+/g, " ").trim();
  n = n.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '"_S_"');
  n = n.replace(/\b\d+(\.\d+)?\b/g, "_N_");
  const kw = new Set([
    "function","class","const","let","var","if","else","for","while","return",
    "import","export","from","async","await","try","catch","throw","new","this",
    "super","extends","implements","interface","type","enum","default","switch",
    "case","break","continue","def","self","None","True","False","pass","yield",
    "lambda","func","go","chan","select","defer","range","struct","fn","mut",
    "pub","impl","trait","match","mod","use",
  ]);
  n = n.replace(/\b[a-zA-Z_]\w*\b/g, (m) => kw.has(m) ? m : "_I_");
  return createHash("sha256").update(n).digest("hex").slice(0, 16);
}

// ── Regex patterns per language ──

interface RxPattern {
  rx: RegExp;
  kind: SymbolKind;
  nameIdx: number;
  sigIdx?: number;
  isExported?: (m: RegExpExecArray) => boolean;
}

const TS_PATTERNS: RxPattern[] = [
  { rx: /^(export\s+)?(async\s+)?function\s+(\w+)\s*(\([^)]*\))/gm,
    kind: "function", nameIdx: 3, sigIdx: 4,
    isExported: (m) => m[1] !== undefined },
  { rx: /^(export\s+)?const\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*(?::[^=]*?)?\s*=>/gm,
    kind: "function", nameIdx: 2, isExported: (m) => m[1] !== undefined },
  { rx: /^(export\s+)?(abstract\s+)?class\s+(\w+)/gm,
    kind: "class", nameIdx: 3, isExported: (m) => m[1] !== undefined },
  { rx: /^\s+(async\s+)?(\w+)\s*(\([^)]*\))\s*(?::\s*\S[^{]*)?\s*\{/gm,
    kind: "method", nameIdx: 2, sigIdx: 3,
    isExported: () => true },  // methods inherit class visibility
  // Static and private methods
  { rx: /^\s+(static\s+|private\s+|protected\s+|public\s+)?(async\s+)?(\w+)\s*(\([^)]*\))/gm,
    kind: "method", nameIdx: 3, sigIdx: 4,
    isExported: (m) => m[1]?.includes("private") ? false : true },
  { rx: /^(export\s+)?interface\s+(\w+)/gm,
    kind: "interface", nameIdx: 2, isExported: (m) => m[1] !== undefined },
  { rx: /^(export\s+)?type\s+(\w+)\s*[=<]/gm,
    kind: "type", nameIdx: 2, isExported: (m) => m[1] !== undefined },
  { rx: /^(export\s+)?enum\s+(\w+)/gm,
    kind: "enum", nameIdx: 2, isExported: (m) => m[1] !== undefined },
];

const PY_PATTERNS: RxPattern[] = [
  { rx: /^(async\s+)?def\s+(\w+)\s*(\([^)]*\))/gm, kind: "function", nameIdx: 2, sigIdx: 3 },
  { rx: /^class\s+(\w+)/gm, kind: "class", nameIdx: 1 },
];

const GO_PATTERNS: RxPattern[] = [
  { rx: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*(\([^)]*\))/gm,
    kind: "function", nameIdx: 1, sigIdx: 2,
    isExported: (m) => /^[A-Z]/.test(m[1] ?? "") },
  { rx: /^type\s+(\w+)\s+struct/gm, kind: "class", nameIdx: 1,
    isExported: (m) => /^[A-Z]/.test(m[1] ?? "") },
  { rx: /^type\s+(\w+)\s+interface/gm, kind: "interface", nameIdx: 1,
    isExported: (m) => /^[A-Z]/.test(m[1] ?? "") },
];

const RUST_PATTERNS: RxPattern[] = [
  { rx: /^(pub\s+)?(async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*(\([^)]*\))/gm,
    kind: "function", nameIdx: 3, sigIdx: 4, isExported: (m) => m[1] !== undefined },
  { rx: /^(pub\s+)?struct\s+(\w+)/gm, kind: "class", nameIdx: 2,
    isExported: (m) => m[1] !== undefined },
  { rx: /^(pub\s+)?trait\s+(\w+)/gm, kind: "interface", nameIdx: 2,
    isExported: (m) => m[1] !== undefined },
  { rx: /^(pub\s+)?enum\s+(\w+)/gm, kind: "enum", nameIdx: 2,
    isExported: (m) => m[1] !== undefined },
];

function langPatterns(lang: string): RxPattern[] {
  const l = lang.toLowerCase();
  if (["typescript","javascript","tsx","jsx"].includes(l)) return TS_PATTERNS;
  if (l === "python") return PY_PATTERNS;
  if (l === "go") return GO_PATTERNS;
  if (l === "rust") return RUST_PATTERNS;
  return TS_PATTERNS;
}

// ── Block end finder (brace counting or indentation) ──

function findBlockEnd(lines: string[], start: number, lang: string): number {
  if (lang === "python") {
    const base = (lines[start] ?? "").search(/\S/);
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (line.trim() === "" || line.trim().startsWith("#")) { end++; continue; }
      if (line.search(/\S/) <= base) break;
      end++;
    }
    return Math.min(end - 1, lines.length - 1);
  }
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") { depth++; opened = true; }
      if (ch === "}") depth--;
      if (opened && depth === 0) return i;
    }
  }
  return Math.min(start + 50, lines.length - 1);
}

// ── Doc comment extractor ──

function extractDoc(lines: string[], symLine: number): string | null {
  let end = symLine - 1;
  while (end >= 0 && (lines[end] ?? "").trim() === "") end--;
  if (end < 0) return null;
  const last = (lines[end] ?? "").trim();
  if (last.endsWith("*/")) {
    let s = end;
    while (s >= 0 && !(lines[s] ?? "").trim().startsWith("/**")) s--;
    if (s >= 0) return lines.slice(s, end + 1).map(l => l.trim()).join("\n");
  }
  if (last.startsWith("//") || last.startsWith("#")) {
    let s = end;
    while (s > 0 && ((lines[s-1] ?? "").trim().startsWith("//") || (lines[s-1] ?? "").trim().startsWith("#"))) s--;
    return lines.slice(s, end + 1).map(l => l.replace(/^\/\/\s?|^#\s?/, "").trim()).join("\n");
  }
  return null;
}

// ── Import extractor ──

function extractImports(code: string, lang: string): string[] {
  const out = new Set<string>();
  const l = lang.toLowerCase();
  if (["typescript","javascript","tsx","jsx"].includes(l)) {
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      const p = m[1] ?? "";
      if (!p.startsWith(".") && !p.startsWith("/")) {
        const parts = p.split("/");
        out.add(p.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0] ?? p);
      }
    }
  } else if (l === "python") {
    for (const m of code.matchAll(/^(?:from|import)\s+([\w.]+)/gm))
      out.add((m[1] ?? "").split(".")[0] ?? "");
  } else if (l === "go") {
    for (const m of code.matchAll(/"([^"]+)"/g)) out.add(m[1] ?? "");
  } else if (l === "rust") {
    for (const m of code.matchAll(/^use\s+(\w+)/gm)) out.add(m[1] ?? "");
  }
  out.delete("");
  return [...out];
}

// Falls back to regex if @ast-grep/napi not installed
let astGrepModule: { parse: Function; Lang: Record<string, unknown> } | null = null;
let astGrepChecked = false;

function tryLoadAstGrep(): typeof astGrepModule {
  if (astGrepChecked) return astGrepModule;
  astGrepChecked = true;
  try {
    astGrepModule = require("@ast-grep/napi");
  } catch {
    // Not installed — regex fallback
  }
  return astGrepModule;
}

function resolveAstGrepLang(ag: NonNullable<typeof astGrepModule>, language: string): unknown | null {
  const l = language.toLowerCase();
  const Lang = ag.Lang as Record<string, unknown>;
  if (["typescript", "ts"].includes(l)) return Lang["TypeScript"];
  if (["javascript", "js", "mjs", "cjs"].includes(l)) return Lang["JavaScript"];
  if (["tsx"].includes(l)) return Lang["Tsx"];
  if (["jsx"].includes(l)) return Lang["Jsx"];
  return null;
}

function nodeKindToSymbolKind(kind: string): SymbolKind | null {
  const map: Record<string, SymbolKind> = {
    function_declaration: "function",
    generator_function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
  };
  return map[kind] ?? null;
}

function extractWithAstGrep(
  ag: NonNullable<typeof astGrepModule>,
  code: string,
  language: string,
): ExtractedSymbol[] | null {
  const lang = resolveAstGrepLang(ag, language);
  if (!lang) return null;

  const ast = ag.parse(lang, code);
  const root = ast.root();
  const lines = code.split("\n");
  const imports = extractImports(code, language);
  const symbols: ExtractedSymbol[] = [];

  const targetKinds = [
    "function_declaration", "class_declaration", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "export_statement",
  ];

  for (const kind of targetKinds) {
    const nodes = root.findAll({ rule: { kind } });

    for (const node of nodes) {
      let symKind = nodeKindToSymbolKind(kind);
      let nameNode = node.field("name");
      let exported = false;

      if (kind === "export_statement") {
        const decl = node.children().find(
          (c: { kind: () => string }) => nodeKindToSymbolKind(c.kind()) !== null,
        );
        if (!decl) continue;
        symKind = nodeKindToSymbolKind(decl.kind());
        nameNode = decl.field("name");
        exported = true;
      }

      if (!symKind || !nameNode) continue;
      const name = nameNode.text();
      if (!name || name.length < 2) continue;

      if (!exported) {
        const parent = node.parent();
        exported = parent !== null && parent.kind() === "export_statement";
      }

      const range = node.range();
      const startLine = range.start.line;
      const endLine = range.end.line;
      const symCode = lines.slice(startLine, endLine + 1).join("\n");

      let signature: string | null = null;
      const paramsNode = node.field("parameters");
      if (paramsNode) signature = paramsNode.text();

      symbols.push({
        name,
        kind: symKind,
        exported,
        startLine,
        endLine,
        signature,
        docComment: extractDoc(lines, startLine),
        code: symCode,
        astFingerprint: computeAstFingerprint(symCode),
        imports,
      });
    }
  }

  const seen = new Set<string>();
  const deduped = symbols.filter((s) => {
    const key = `${s.name}:${s.startLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.length > 0 ? deduped : null;
}

// ── Main extraction ──

export function extractSymbols(code: string, language: string): ExtractionResult {
  const ag = tryLoadAstGrep();
  if (ag) {
    try {
      const astSymbols = extractWithAstGrep(ag, code, language);
      if (astSymbols) {
        return { symbols: astSymbols, engine: "ast-grep", language };
      }
    } catch {
      // ast-grep failed on this input — fall through to regex
    }
  }

  // Regex fallback
  const lines = code.split("\n");
  const patterns = langPatterns(language);
  const symbols: ExtractedSymbol[] = [];
  const imports = extractImports(code, language);

  for (const p of patterns) {
    p.rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.rx.exec(code)) !== null) {
      const name = m[p.nameIdx] ?? "";
      if (!name || name.length < 2) continue;
      const startLine = code.slice(0, m.index).split("\n").length - 1;
      const endLine = findBlockEnd(lines, startLine, language);
      const symCode = lines.slice(startLine, endLine + 1).join("\n");
      symbols.push({
        name, kind: p.kind,
        exported: p.isExported ? p.isExported(m) : true,
        startLine, endLine,
        signature: p.sigIdx ? (m[p.sigIdx] ?? null) : null,
        docComment: extractDoc(lines, startLine),
        code: symCode,
        astFingerprint: computeAstFingerprint(symCode),
        imports,
      });
    }
  }

  return { symbols, engine: "regex-fallback", language };
}

// ── Language detection ──

export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp", rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
  };
  return (ext && map[ext]) ?? null;
}
