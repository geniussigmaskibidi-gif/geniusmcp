// Strips function/method bodies, keeps signatures + doccomments + exports.
// The agent sees the full structural skeleton without implementation noise.
//
// Example:
//   BEFORE (100 tokens):
//     /** Validates config. */
//     export function validate(cfg: Config): Result {
//       const schema = z.object({ ... });
//       const parsed = schema.parse(cfg);
//       if (!parsed.ok) throw new Error(parsed.error);
//       return { ok: true, value: parsed.data };
//     }
//
//   AFTER (25 tokens):
//     /** Validates config. */
//     export function validate(cfg: Config): Result

import { extractSymbols } from "./symbol-extractor.js";

export function compressToSignatures(
  source: string,
  language: string,
): string {
  let symbols: ReturnType<typeof extractSymbols>["symbols"];
  try {
    ({ symbols } = extractSymbols(source, language));
  } catch {
    return source.split("\n").slice(0, 20).join("\n") + "\n// ... (parsing failed, truncated)";
  }

  if (symbols.length === 0) {
    // No symbols found — return imports + first few lines
    const lines = source.split("\n");
    const importLines = lines.filter((l) =>
      /^\s*(import|from|require|export)\b/.test(l),
    );
    if (importLines.length > 0) {
      return importLines.join("\n") + "\n// ... (no extractable symbols)";
    }
    return lines.slice(0, 10).join("\n") + "\n// ... (no extractable symbols)";
  }

  const parts: string[] = [];

  const lines = source.split("\n");
  const importBlock = lines.filter((l) =>
    /^\s*(import\s|from\s|require\()/.test(l),
  );
  if (importBlock.length > 0) {
    parts.push(importBlock.join("\n"));
    parts.push("");
  }

  for (const sym of symbols) {
    // Skip non-exported internals in large files
    if (!sym.exported && symbols.length > 10) continue;

    const entry: string[] = [];

    // Doccomment
    if (sym.docComment) {
      entry.push(sym.docComment);
    }

    // extractSymbols returns signature as "(params)" without name, so we prepend it
    const exportPrefix = sym.exported ? "export " : "";
    const kindPrefix = sym.kind === "function" ? "function " :
                       sym.kind === "class" ? "class " :
                       sym.kind === "interface" ? "interface " :
                       sym.kind === "type" ? "type " :
                       sym.kind === "enum" ? "enum " :
                       sym.kind === "const" ? "const " : "";
    if (sym.signature) {
      // Signature may or may not include name — ensure it does
      const sigHasName = sym.signature.startsWith(sym.name);
      const sigText = sigHasName ? sym.signature : `${sym.name}${sym.signature}`;
      entry.push(`${exportPrefix}${kindPrefix}${sigText}`);
    } else {
      entry.push(`${exportPrefix}${kindPrefix}${sym.name}`);
    }

    parts.push(entry.join("\n"));
  }

  return parts.join("\n\n");
}
