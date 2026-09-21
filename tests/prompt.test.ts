import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "../src/contracts.js";
import { isStale, promptLine, renderPrompt } from "../src/prompt.js";
import { ZERO_WIDTH_SPACE } from "../src/config.js";

const DAY = 86_400_000;

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 1,
    text: "text",
    tags: "a b",
    scope: "",
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastConfirmedAt: Date.now(),
    ...overrides,
  };
}

describe("isStale", () => {
  const now = 1_000_000_000_000;
  it("marks records older than the horizon", () => {
    expect(
      isStale({ lastConfirmedAt: now - 91 * DAY }, 90, now),
    ).toBe(true);
    expect(
      isStale({ lastConfirmedAt: now - 89 * DAY }, 90, now),
    ).toBe(false);
  });
});

describe("renderPrompt", () => {
  const config = { promptMaxChars: 2000, escapeSequences: ["{{"], staleAfterDays: 90 };

  it("renders pinned first with flags, tags, scope", () => {
    const text = renderPrompt(
      [
        record({ id: 5, text: "always", pinned: true, scope: "work" }),
        record({ id: 6, text: "recent", tags: "" }),
      ],
      config,
    );
    expect(text).toContain("(#5, pinned) [a b] {work} always");
    expect(text).toContain("(#6) recent");
    expect(text.indexOf("#5")).toBeLessThan(text.indexOf("#6"));
  });

  it("escapes {{ with a zero-width space", () => {
    const text = renderPrompt([record({ text: "chezmoi {{ .var }}" })], config);
    expect(text).not.toContain("{{");
    expect(text).toContain(`{${ZERO_WIDTH_SPACE}{ .var }}`);
  });

  it("keeps pinned lines when the budget drops recent ones", () => {
    const records = [
      record({ id: 1, text: "pinned".repeat(5), pinned: true }),
      record({ id: 2, text: "recent".repeat(200) }),
    ];
    const text = renderPrompt(records, {
      promptMaxChars: 200,
      escapeSequences: [],
      staleAfterDays: 90,
    });
    expect(text).toContain("#1");
    expect(text).not.toContain("#2");
    expect(text).toMatch(/more memories not shown/);
  });

  it("drops recent, never a larger pinned, under a tight budget (regression: H-4)", () => {
    // A large pinned entry followed by a small recent one. The old greedy loop
    // used `continue`, so the large pinned line was skipped while the small
    // recent line was still emitted — inverting R9 (lost the always-relevant
    // fact, kept the disposable one).
    const records = [
      record({ id: 1, text: "P".repeat(1990), pinned: true }),
      record({ id: 2, text: "short recent" }),
    ];
    const text = renderPrompt(records, {
      promptMaxChars: 2000,
      escapeSequences: [],
      staleAfterDays: 90,
    });
    expect(text).toContain("#1");
    expect(text).not.toContain("#2");
    expect(text).toMatch(/more memories not shown/);
  });

  it("guarantees at least a truncated first pinned when it exceeds the budget (regression: M-1)", () => {
    // A single pinned line larger than the whole budget previously erased the
    // entire recall section (returned ""), silently hiding an always-relevant
    // fact. It must instead survive, truncated on a code-point boundary.
    const records = [
      record({ id: 1, text: "常识".repeat(500), pinned: true }),
      record({ id: 2, text: "recent" }),
    ];
    const text = renderPrompt(records, {
      promptMaxChars: 300,
      escapeSequences: [],
      staleAfterDays: 90,
    });
    expect(text).toContain("#1");
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain("…");
    // Never split a multi-byte character: the body is whole code points only.
    expect(text.includes("\uFFFD")).toBe(false);
  });

  it("returns empty for no records or nothing fitting", () => {
    expect(renderPrompt([], config)).toBe("");
    expect(
      renderPrompt([record({ text: "x".repeat(300) })], {
        promptMaxChars: 50,
        escapeSequences: [],
        staleAfterDays: 90,
      }),
    ).toBe("");
  });

  it("marks stale records", () => {
    const now = Date.now();
    const text = renderPrompt(
      [record({ lastConfirmedAt: now - 400 * DAY })],
      config,
    );
    expect(text).toContain("stale");
  });
});

describe("promptLine", () => {
  it("is idempotent under escaping (pre-escaped text untouched)", () => {
    const line = promptLine(record({ text: `{${ZERO_WIDTH_SPACE}{ok}` }), ["{{"], 90);
    expect(line).toContain(`{${ZERO_WIDTH_SPACE}{ok}`);
    expect(line).not.toContain("{{");
  });
});
