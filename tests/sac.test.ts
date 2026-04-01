import { describe, it, expect } from "vitest";
import { sacSimilarity, splitIdentifier, shapeSignature } from "@forgemcp/hunt-engine";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("getUserSession")).toEqual(["get", "user", "session"]);
  });

  it("splits PascalCase", () => {
    expect(splitIdentifier("UserSessionManager")).toEqual(["user", "session", "manager"]);
  });

  it("splits snake_case", () => {
    expect(splitIdentifier("get_user_session")).toEqual(["get", "user", "session"]);
  });

  it("splits kebab-case", () => {
    expect(splitIdentifier("get-user-session")).toEqual(["get", "user", "session"]);
  });

  it("splits SCREAMING_SNAKE", () => {
    expect(splitIdentifier("GET_USER_SESSION")).toEqual(["get", "user", "session"]);
  });

  it("handles mixed conventions", () => {
    expect(splitIdentifier("get_userSession")).toEqual(["get", "user", "session"]);
  });

  it("handles acronyms", () => {
    const result = splitIdentifier("parseHTMLDocument");
    expect(result).toContain("parse");
    expect(result).toContain("document");
  });

  it("returns empty for empty string", () => {
    expect(splitIdentifier("")).toEqual([]);
  });
});

describe("shapeSignature", () => {
  it("captures case patterns", () => {
    expect(shapeSignature("getUserSession")).toBe("aAaAa");
    expect(shapeSignature("get_user_session")).toBe("a_a_a");
    expect(shapeSignature("GET_USER_SESSION")).toBe("A_A_A");
  });

  it("captures numeric patterns", () => {
    expect(shapeSignature("item42")).toBe("a9");
  });
});

describe("sacSimilarity", () => {
  it("returns 1.0 for identical identifiers", () => {
    expect(sacSimilarity("getUserSession", "getUserSession")).toBe(1.0);
  });

  it("returns 0 for empty input", () => {
    expect(sacSimilarity("", "foo")).toBe(0);
    expect(sacSimilarity("foo", "")).toBe(0);
  });

  it("scores high for cross-convention equivalents", () => {
    // Different naming conventions, same semantic meaning → high similarity
    const score1 = sacSimilarity("getUserSession", "get_user_session");
    expect(score1).toBeGreaterThan(0.7);

    const score2 = sacSimilarity("getUserSession", "fetch_user_session");
    expect(score2).toBeGreaterThan(0.5);

    const score3 = sacSimilarity("parseConfig", "parse_config");
    expect(score3).toBeGreaterThan(0.7);
  });

  it("scores low for semantically different identifiers", () => {
    const score = sacSimilarity("getUserSession", "deleteAllRecords");
    expect(score).toBeLessThan(0.3);
  });

  it("recognizes partial overlap", () => {
    // "handleAuth" and "handleAuthentication" share "handle" + "auth" prefix
    const score = sacSimilarity("handleAuth", "handleAuthentication");
    expect(score).toBeGreaterThan(0.4);
  });

  it("is symmetric", () => {
    const ab = sacSimilarity("getUserSession", "fetch_user_session");
    const ba = sacSimilarity("fetch_user_session", "getUserSession");
    expect(Math.abs(ab - ba)).toBeLessThan(0.01);
  });

  it("handles single-word identifiers", () => {
    const score = sacSimilarity("parse", "parse");
    expect(score).toBe(1.0);

    const score2 = sacSimilarity("parse", "format");
    expect(score2).toBeLessThan(0.3);
  });
});
