import { describe, expect, it } from "vitest";
import {
  Config,
  ZERO_WIDTH_SPACE,
  escapeForPrompt,
  loadConfig,
  validateConfig,
} from "../src/config.js";

const ZWSP = ZERO_WIDTH_SPACE;

describe("escapeForPrompt", () => {
  it("escapes a single {{ once", () => {
    expect(escapeForPrompt("hello {{name}}", ["{{"])).toBe(
      `hello {${ZWSP}{name}}`,
    );
  });

  it("handles nested {{{{ as two non-overlapping hits", () => {
    expect(escapeForPrompt("{{{{", ["{{"])).toBe(
      `{${ZWSP}{{${ZWSP}{`,
    );
  });

  it("is idempotent on already-escaped text", () => {
    const once = escapeForPrompt("a {{b}} c", ["{{"]);
    expect(escapeForPrompt(once, ["{{"])).toBe(once);
  });

  it("leaves text that already carries a zero-width space untouched when no raw sequence remains", () => {
    const preEscaped = `{${ZWSP}{ok}`;
    expect(escapeForPrompt(preEscaped, ["{{"])).toBe(preEscaped);
  });

  it("escapes a raw sequence even when the text also carries pre-escaped ones", () => {
    const mixed = `safe {${ZWSP}{ raw {{`;
    expect(escapeForPrompt(mixed, ["{{"])).toBe(
      `safe {${ZWSP}{ raw {${ZWSP}{`,
    );
  });

  it("supports a custom escape sequence", () => {
    expect(escapeForPrompt("a <% b", ["<%"])).toBe(`a <${ZWSP}% b`);
  });

  it("ignores sequences shorter than 2 chars", () => {
    expect(escapeForPrompt("a { b", ["{"])).toBe("a { b");
  });
});

describe("loadConfig", () => {
  it("fills every default", () => {
    const config = loadConfig({ path: "/tmp/x.db" });
    expect(config.escapeSequences).toEqual(["{{"]);
    expect(config.dedupeThreshold).toBe(0.8);
    expect(config.staleAfterDays).toBe(90);
    expect(config.promptRecentCount).toBe(10);
  });

  it("throws on missing/empty path", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ path: "" })).toThrow(/path/);
  });

  it("throws on threshold outside [0,1]", () => {
    expect(() => loadConfig({ path: "x", dedupeThreshold: 1.5 })).toThrow(
      /dedupeThreshold/,
    );
    expect(() => loadConfig({ path: "x", dedupeCosineThreshold: -0.1 })).toThrow(
      /dedupeCosineThreshold/,
    );
  });

  it("throws on non-integer bounds", () => {
    expect(() => loadConfig({ path: "x", promptMaxChars: 1.5 })).toThrow(
      /promptMaxChars/,
    );
    expect(() => loadConfig({ path: "x", staleAfterDays: 0 })).toThrow(
      /staleAfterDays/,
    );
  });

  it("throws when searchLimitDefault exceeds the cap", () => {
    expect(() =>
      loadConfig({ path: "x", searchLimitDefault: 10, searchLimitMax: 5 }),
    ).toThrow(/searchLimitDefault/);
  });

  it("throws on degenerate escape sequences", () => {
    expect(() => loadConfig({ path: "x", escapeSequences: ["{"] })).toThrow(
      /escapeSequences/,
    );
    expect(() =>
      loadConfig({ path: "x", escapeSequences: [`{${ZWSP}{`] }),
    ).toThrow(/escapeSequences/);
  });

  it("schemastery schema exists for the entry config", () => {
    expect(typeof Config).toBe("function");
    expect(() => validateConfig(loadConfig({ path: "x" }))).not.toThrow();
  });
});
