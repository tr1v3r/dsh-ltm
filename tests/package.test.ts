import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

describe("installable DSH bundle", () => {
  it("declares and ships the patch used by dsh plugin add", () => {
    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(manifest.files).toContain("cordis.patch.yml");
    const patch = readFileSync(new URL(manifest.dsh.bundle.patch, root), "utf8");
    expect(patch).toContain("- insert:");
    expect(patch).toContain(`name: '${manifest.name}'`);
    expect(patch).toContain("dshHomePath('memory/ltm.db')");
  });
});
