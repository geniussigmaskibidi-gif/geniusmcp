
/** Standard JSON tool response wrapper. */
export function toolJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Error response with suggestion for recovery. */
export function toolError(error: string, suggestion?: string) {
  return {
    isError: true as const,
    ...toolJson({ error, suggestion: suggestion ?? null }),
  };
}

/** Parse "owner/repo" format. Returns null on invalid. */
export function parseRepo(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0].length > 100 || parts[1].length > 100) return null;
  if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
  return { owner: parts[0], name: parts[1] };
}

/** Validate repo format and return error response if invalid. */
export function validateRepo(repo: string) {
  const parsed = parseRepo(repo);
  if (!parsed) {
    return toolError(
      `Invalid repo format: "${repo}"`,
      "Use owner/repo format, e.g. 'facebook/react'",
    );
  }
  return parsed;
}
