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
  const config = { promptMaxChars: 2000, escapeSequences: [], staleAfterDays: 90 };

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

  it("preserves template-like text by default", () => {
    const text = renderPrompt([record({ text: "example {{ .var }}" })], config);
    expect(text).toContain("example {{ .var }}");
    expect(text).not.toContain(ZERO_WIDTH_SPACE);
  });

  it("breaks explicitly configured output sequences", () => {
    const text = renderPrompt([record({ text: "example {{ .var }}" })], {
      ...config,
      escapeSequences: ["{{"],
    });
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
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it("counts the omission tail within the exact character budget", () => {
    const records = [
      record({ id: 1, text: "a".repeat(25), pinned: true }),
      record({ id: 2, text: "b".repeat(25) }),
      record({ id: 3, text: "c".repeat(200) }),
    ];
    const budget = 170;
    const text = renderPrompt(records, {
      promptMaxChars: budget,
      escapeSequences: [],
      staleAfterDays: 90,
    });

    expect(text).toMatch(/more memories not shown/);
    expect(text.length).toBeLessThanOrEqual(budget);
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

  it("never evicts a pinned line when the omission notice does not fit", () => {
    // Regression: the eviction loop used to pop from the end of `kept`, which
    // contains the pinned lines first. When only the pinned line survived, it
    // popped that too and returned "" — silently erasing the always-relevant
    // fact for a whole band of budgets (199..233 in the original report).
    const records = [
      record({ id: 1, text: "a".repeat(100), pinned: true }),
      record({ id: 2, text: "b".repeat(20) }),
    ];
    for (let budget = 100; budget <= 400; budget++) {
      const text = renderPrompt(records, {
        promptMaxChars: budget,
        escapeSequences: [],
        staleAfterDays: 90,
      });
      expect(text, `budget=${budget}`).not.toBe("");
      expect(text, `budget=${budget}`).toContain("(#1");
      expect(text.length, `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps a long pinned memory at the default budget instead of dropping the section", () => {
    // The old code lost the entire section for pinned texts of ~1881..1901
    // characters at promptMaxChars=2000 (inside the default maxTextChars).
    for (let length = 1800; length <= 1950; length++) {
      const text = renderPrompt(
        [
          record({ id: 1, text: "P".repeat(length), pinned: true }),
          record({ id: 2, text: "recent" }),
        ],
        { promptMaxChars: 2000, escapeSequences: [], staleAfterDays: 90 },
      );
      expect(text, `length=${length}`).not.toBe("");
      expect(text, `length=${length}`).toContain("(#1");
      expect(text.length, `length=${length}`).toBeLessThanOrEqual(2000);
    }
  });

  it("respects the budget for astral pinned text and for tiny budgets", () => {
    const emoji = renderPrompt(
      [
        record({ id: 1, text: "\u{1F600}".repeat(400), pinned: true }),
        record({ id: 2, text: "recent" }),
      ],
      { promptMaxChars: 300, escapeSequences: [], staleAfterDays: 90 },
    );
    expect(emoji).toContain("(#1");
    expect(emoji.length).toBeLessThanOrEqual(300);

    // Below HEADER + marker the section cannot be rendered at all; the budget
    // still wins over emitting an over-long section.
    const tiny = renderPrompt(
      [
        record({ id: 1, text: "x".repeat(5000), pinned: true }),
        record({ id: 2, text: "recent" }),
      ],
      { promptMaxChars: 100, escapeSequences: [], staleAfterDays: 90 },
    );
    expect(tiny.length).toBeLessThanOrEqual(100);
  });

  it("never exceeds the budget or silently erases pinned records (property)", () => {
    let seed = 20_260_921;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 500; trial++) {
      const count = 1 + rand(6);
      const records: MemoryRecord[] = [];
      let pinnedCount = 0;
      for (let i = 0; i < count; i++) {
        const pinned = rand(2) === 0;
        if (pinned) pinnedCount++;
        const length = [0, 1, 5, 50, 500, 1980, 4000][rand(7)]!;
        records.push(record({ id: 1000 + i * 7, text: "字".repeat(length), pinned }));
      }
      const budget = 1 + rand(3000);
      const text = renderPrompt(records, {
        promptMaxChars: budget,
        escapeSequences: [],
        staleAfterDays: 90,
      });
      expect(text.length, `trial=${trial} budget=${budget}`).toBeLessThanOrEqual(budget);
      if (pinnedCount > 0 && budget >= 100) {
        expect(text, `trial=${trial} budget=${budget}`).not.toBe("");
      }
      const shows = (id: number): boolean => text.includes(`(#${id}`);
      const renderedRecent = records.some((r) => !r.pinned && shows(r.id));
      if (renderedRecent) {
        const renderedPinned = records.filter((r) => r.pinned && shows(r.id)).length;
        expect(renderedPinned, `trial=${trial} budget=${budget}`).toBe(pinnedCount);
      }
    }
  });
});

describe("promptLine", () => {
  it("is idempotent under escaping (pre-escaped text untouched)", () => {
    const line = promptLine(record({ text: `{${ZERO_WIDTH_SPACE}{ok}` }), ["{{"], 90);
    expect(line).toContain(`{${ZERO_WIDTH_SPACE}{ok}`);
    expect(line).not.toContain("{{");
  });
});
