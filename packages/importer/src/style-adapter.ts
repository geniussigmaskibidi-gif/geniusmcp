// Detect project style conventions and suggest adaptations for imported code.
// Research: EditorConfig, ESLint/Prettier config detection.

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ProjectStyle {
  readonly indentation: "tabs" | "spaces";
  readonly indentWidth: number;        // 2 or 4
  readonly quoteStyle: "single" | "double";
  readonly semicolons: boolean;
  readonly trailingComma: boolean;
  readonly namingConvention: "camelCase" | "snake_case" | "mixed";
}

export interface StyleAdaptation {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly description: string;
}

// ─────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────

/**
 * Detect project style from a sample of source files.
 *
 * Heuristic-based: counts occurrences of each convention.
 * Input: array of file contents (3-5 files recommended).
 */
export function detectProjectStyle(samples: string[]): ProjectStyle {
  let tabs = 0;
  let spaces2 = 0;
  let spaces4 = 0;
  let singleQuotes = 0;
  let doubleQuotes = 0;
  let withSemicolons = 0;
  let withoutSemicolons = 0;
  let camelCase = 0;
  let snakeCase = 0;

  for (const content of samples) {
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.startsWith("\t")) tabs++;
      else if (line.startsWith("  ") && !line.startsWith("    ")) spaces2++;
      else if (line.startsWith("    ")) spaces4++;

      const singleCount = (line.match(/'/g) ?? []).length;
      const doubleCount = (line.match(/"/g) ?? []).length;
      singleQuotes += singleCount;
      doubleQuotes += doubleCount;

      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        if (trimmed.endsWith(";")) withSemicolons++;
        else if (trimmed.endsWith("}") || trimmed.endsWith(",") || trimmed.endsWith("{")) {
          // structural — skip
        } else {
          withoutSemicolons++;
        }
      }

      const funcNames = line.match(/(?:function|const|let|var)\s+([a-zA-Z_]\w*)/g) ?? [];
      for (const match of funcNames) {
        const name = match.split(/\s+/)[1];
        if (name && name.includes("_") && name !== name.toUpperCase()) snakeCase++;
        else if (name && /[a-z][A-Z]/.test(name)) camelCase++;
      }
    }
  }

  return {
    indentation: tabs > spaces2 + spaces4 ? "tabs" : "spaces",
    indentWidth: spaces4 > spaces2 ? 4 : 2,
    quoteStyle: doubleQuotes > singleQuotes ? "double" : "single",
    semicolons: withSemicolons > withoutSemicolons,
    trailingComma: false, // hard to detect reliably
    namingConvention: snakeCase > camelCase ? "snake_case" : camelCase > snakeCase ? "camelCase" : "mixed",
  };
}

/**
 * Compare source style with target style and generate adaptations.
 */
export function suggestAdaptations(
  sourceCode: string,
  sourceStyle: ProjectStyle,
  targetStyle: ProjectStyle,
): StyleAdaptation[] {
  const adaptations: StyleAdaptation[] = [];

  if (sourceStyle.indentation !== targetStyle.indentation ||
      (sourceStyle.indentation === "spaces" && sourceStyle.indentWidth !== targetStyle.indentWidth)) {
    adaptations.push({
      field: "indentation",
      from: sourceStyle.indentation === "tabs" ? "tabs" : `${sourceStyle.indentWidth} spaces`,
      to: targetStyle.indentation === "tabs" ? "tabs" : `${targetStyle.indentWidth} spaces`,
      description: "Re-indent to match project style",
    });
  }

  if (sourceStyle.quoteStyle !== targetStyle.quoteStyle) {
    adaptations.push({
      field: "quoteStyle",
      from: sourceStyle.quoteStyle,
      to: targetStyle.quoteStyle,
      description: `Convert ${sourceStyle.quoteStyle} quotes to ${targetStyle.quoteStyle}`,
    });
  }

  if (sourceStyle.semicolons !== targetStyle.semicolons) {
    adaptations.push({
      field: "semicolons",
      from: sourceStyle.semicolons ? "with semicolons" : "no semicolons",
      to: targetStyle.semicolons ? "with semicolons" : "no semicolons",
      description: targetStyle.semicolons ? "Add semicolons" : "Remove semicolons",
    });
  }

  if (sourceStyle.namingConvention !== targetStyle.namingConvention &&
      sourceStyle.namingConvention !== "mixed" && targetStyle.namingConvention !== "mixed") {
    adaptations.push({
      field: "namingConvention",
      from: sourceStyle.namingConvention,
      to: targetStyle.namingConvention,
      description: `Convert names from ${sourceStyle.namingConvention} to ${targetStyle.namingConvention}`,
    });
  }

  return adaptations;
}
