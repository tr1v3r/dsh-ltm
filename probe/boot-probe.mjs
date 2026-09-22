// P2 real-boot probe: boot the built dsh-ltm plugin through the real
// @deepseek-ai/dsh-app-boot Loader pipeline (NOT --dump-config, which never
// imports plugin modules), with the launcher facts faked the way AGENTS.md
// describes: process.stdout.isTTY, provideCmdline, launch-environment
// snapshot. Then assert:
//
//   1. all seven memory_* tools are registered and visible via schemas();
//   2. write -> search -> confirm -> forget full chain executes against the
//      real on-disk SQLite store opened by the plugin;
//   3. CJK end-to-end: Chinese write is searchable by Chinese keywords;
//   4. the recall section appears in the assembled system prompt.
//
// Usage: node probe/boot-probe.mjs [db-path]   (default probe/tmp/ltm.db)

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DSH = "/Users/bytedance/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules";
const { boot } = await import(`${DSH}/@deepseek-ai/dsh-app-boot/lib/index.js`);
const { provideCmdline } = await import(`${DSH}/@deepseek-ai/dsh-cmdline/lib/index.js`);
const { createLaunchEnvironmentSnapshot } = await import(`${DSH}/@deepseek-ai/dsh-launch-environment/lib/index.js`);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbArg = process.argv[2] ?? path.join(root, "probe/tmp/ltm.db");
mkdirSync(path.dirname(dbArg), { recursive: true });
rmSync(dbArg, { force: true });

// Fake the launcher facts the tree expects (TUI surface wants a TTY; cmdline
// and launch-environment services are provided before any entry mounts).
process.stdout.isTTY = true;

const configPath = path.join(root, "probe/cordis.yml");

const ctx = await boot("ltm-probe", configPath, [], (host) => {
  provideCmdline(host, { args: [], exit: (code = 0) => process.exit(code) });
  host.provide(
    "launchEnvironment",
    createLaunchEnvironmentSnapshot([{ source: "process", values: process.env }]),
  );
});

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// Minimal agent-shaped scope: the registry only uses object identity for scoped
// routing, while dsh-ltm reads the durable session cwd from this public shape.
const probeAgent = {
  id: "ltm-boot-probe-agent",
  session: { header: { cwd: root } },
};
const isolatedDir = mkdtempSync(path.join(tmpdir(), "ltm-probe-other-"));
const otherAgent = {
  id: "ltm-boot-probe-other-agent",
  session: { header: { cwd: isolatedDir } },
};

let nextCallId = 1;
async function executeCall(name, args, agent = probeAgent) {
  const result = await ctx.tools.execute({
    callId: `boot-probe-${nextCallId++}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
  if (result.isError) {
    throw new Error(`${name} failed via registry: ${result.error.code}: ${result.error.message}`);
  }
  return result;
}

async function call(name, args, agent = probeAgent) {
  return (await executeCall(name, args, agent)).value;
}

// 1. seven tools registered + visible
const expected = [
  "memory_write", "memory_search", "memory_forget", "memory_update",
  "memory_confirm", "memory_list", "memory_merge",
];
const visible = ctx.tools.schemas().map((s) => s.name);
for (const name of expected) check(`tool registered+visible: ${name}`,
  visible.includes(name) && ctx.tools.get(name) !== undefined);

// 2. write -> search -> confirm -> forget chain
const w1 = await call("memory_write", { text: "Probe fact: the release branch is dev, squash-merge convention applies.", tags: ["probe"] });
const w1id = w1.record?.id ?? w1.id;
check("write returns written=true", w1.written === true && w1id !== undefined, `id=${w1id}`);
check("write uses an automatic Git project scope",
  typeof w1.record?.scope === "string" && w1.record.scope.startsWith("git:") && !w1.record.scope.includes(root),
  `scope=${w1.record?.scope}`);
const dup = await call("memory_write", { text: "Probe fact: the release branch is dev, squash merge convention applies." });
check("near-duplicate blocked", dup.written === false && dup.dedupeHits?.length > 0,
  `${dup.dedupeHits?.length} hit(s) sim=${dup.dedupeHits?.[0]?.similarity}`);

const w2 = await call("memory_write", { text: "数据库迁移时把 db+wal+shm 一起拷走再只读打开。", tags: ["probe", "migration"] });
const w2id = w2.record?.id ?? w2.id;
check("CJK write ok", w2.written === true && w2id !== undefined, `id=${w2id}`);

const s1Result = await executeCall("memory_search", { query: "release branch squash" });
const s1 = s1Result.value;
check("search passes registry output validation", !s1Result.isError);
check("fresh search result is not rendered stale",
  !s1Result.content.some((block) => block.type === "text" && block.text.includes("stale")));
check("latin search finds #1", s1.results.some((r) => r.id === w1id), `${s1.results.length} hit(s)`);
const listResult = await executeCall("memory_list", {});
check("fresh list result is not rendered stale",
  !listResult.content.some((block) => block.type === "text" && block.text.includes("stale")));
const s2 = await call("memory_search", { query: "迁移 数据库" });
check("CJK search finds #2", s2.results.some((r) => r.id === w2id), `${s2.results.length} hit(s)`);

const c1 = await call("memory_confirm", { id: String(w2id) });
check("confirm one", c1.confirmed === 1, `confirmed=${c1.confirmed}`);
const cAll = await call("memory_confirm", { id: "*" });
check("confirm all", cAll.confirmed >= 2, `confirmed=${cAll.confirmed}`);

const f1 = await call("memory_forget", { id: w1id });
check("forget deletes", f1.deleted === true);
const gone = await call("memory_search", { query: "release branch squash" });
check("forgotten record no longer searchable", !gone.results.some((r) => r.id === w1id));

// 3. recall section in the assembled system prompt
const assembly = await ctx.systemPrompt.assemble({ scope: probeAgent });
const ltmSection = assembly.sections.find((s) => s.name === "ltm:recall");
check("system prompt has ltm:recall section", ltmSection !== undefined);
check("recall section contains the CJK memory", !!ltmSection && ltmSection.text.includes("迁移"));

// 4. two agents sharing one plugin/store stay isolated by their own session cwd
const otherWrite = await call("memory_write", {
  text: "Second workspace private sentinel qzjxv.",
  tags: ["probe-isolation"],
}, otherAgent);
const otherId = otherWrite.record?.id;
check("second agent writes to a different scope",
  otherWrite.written === true && otherWrite.record?.scope !== w2.record?.scope,
  `scope=${otherWrite.record?.scope}`);
const primaryIsolationSearch = await call("memory_search", { query: "qzjxv" });
check("primary agent search excludes second project",
  !primaryIsolationSearch.results.some((record) => record.id === otherId));
const deniedForeignDelete = await call("memory_forget", { id: otherId });
check("primary agent cannot mutate second project", deniedForeignDelete.deleted === false);
const otherIsolationSearch = await call("memory_search", { query: "qzjxv" }, otherAgent);
check("second agent search sees its own project",
  otherIsolationSearch.results.some((record) => record.id === otherId));
const otherAssembly = await ctx.systemPrompt.assemble({ scope: otherAgent });
const otherLtmSection = otherAssembly.sections.find((s) => s.name === "ltm:recall");
check("primary prompt excludes second project", !ltmSection?.text.includes("qzjxv"));
check("second prompt recalls its own project", !!otherLtmSection?.text.includes("qzjxv"));

// 5. Actual registry serializer/schema/render retain optional budget metadata.
const pinnedResult = await executeCall("memory_write", {
  text: "Budget probe unique durable convention zbxkq.", pinned: true, force: true,
});
const pinnedId = pinnedResult.value.record.id;
check("pinned write passes registry schema with budget",
  pinnedResult.value.budget?.selectedIds.includes(pinnedId));
check("pinned write renders budget", pinnedResult.content.some((block) => block.type === "text" && block.text.includes("Recall budget:")));
check("budget excludes foreign project", !pinnedResult.value.budget?.selectedIds.includes(otherId));
for (const patch of [{ tags: ["budget-updated"] }, { text: "Budget probe revised durable convention zbxkq." }, { pinned: false }]) {
  const result = await executeCall("memory_update", { id: pinnedId, ...patch });
  check(`update budget passes registry schema: ${Object.keys(patch)[0]}`, result.value.updated && result.value.budget !== undefined);
  check(`update budget rendered: ${Object.keys(patch)[0]}`, result.content.some((block) => block.type === "text" && block.text.includes("Recall budget:")));
}
const missingUpdate = await call("memory_update", { id: 999999, pinned: true });
check("missing update omits budget", !missingUpdate.updated && missingUpdate.budget === undefined);
check("ordinary write omits budget", w2.budget === undefined);
check("blocked write omits budget", dup.budget === undefined);

await ctx.fiber.dispose();
rmSync(isolatedDir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PROBE CHECKS PASSED" : `\n${failures.length} FAILURE(S): ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
