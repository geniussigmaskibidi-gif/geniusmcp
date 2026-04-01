
export class ForgeMcpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = "ForgeMcpError";
  }
}

/** GitHub API rate limit exhausted. */
export class RateLimitError extends ForgeMcpError {
  constructor(
    public readonly bucket: string,
    public readonly resetAt: number,
  ) {
    super(
      `Rate limit exhausted for ${bucket}. Resets at ${new Date(resetAt).toISOString()}`,
      "RATE_LIMIT",
      true,
    );
    this.name = "RateLimitError";
  }
}

/** GitHub API returned 404 or resource not accessible. */
export class NotFoundError extends ForgeMcpError {
  constructor(resource: string) {
    super(`Not found: ${resource}`, "NOT_FOUND", false);
    this.name = "NotFoundError";
  }
}

/** License incompatible with user's policy. Hard stop. */
export class LicenseBlockedError extends ForgeMcpError {
  constructor(
    public readonly spdx: string,
    public readonly repo: string,
  ) {
    super(
      `License ${spdx} in ${repo} is blocked by your policy`,
      "LICENSE_BLOCKED",
      false,
    );
    this.name = "LicenseBlockedError";
  }
}

/** AST parser not available for this language. Fallback to regex. */
export class ParserUnavailableError extends ForgeMcpError {
  constructor(language: string) {
    super(
      `No AST parser available for ${language}. Using regex fallback.`,
      "PARSER_UNAVAILABLE",
      true,
    );
    this.name = "ParserUnavailableError";
  }
}

/** Blob too large to process. */
export class BlobTooLargeError extends ForgeMcpError {
  constructor(sha: string, sizeBytes: number) {
    super(
      `Blob ${sha.slice(0, 12)} is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB, exceeds limit`,
      "BLOB_TOO_LARGE",
      false,
    );
    this.name = "BlobTooLargeError";
  }
}

/** Auth not configured. */
export class AuthRequiredError extends ForgeMcpError {
  constructor() {
    super(
      "GitHub authentication required. Set GITHUB_TOKEN or configure GitHub App.",
      "AUTH_REQUIRED",
      false,
    );
    this.name = "AuthRequiredError";
  }
}
