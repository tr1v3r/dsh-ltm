# P2 验证报告 — dsh-ltm 整体验证与真实 boot 探针

日期：2026-09-27 · 环境：macOS / Node v24.20.0 / dsh 0.1.5-rc.1（dsh-app-boot 0.1.5-rc.2）· 工作区 `dsh-ltm` @ P1+P1' 完成后

## 1. 测试矩阵

| 检查 | 命令 | 结果 |
|---|---|---|
| 全仓类型检查 | `pnpm typecheck` | ✅ 0 错（t1 报的 surface 残留错误已由 t2 收敛） |
| 全部单测 | `pnpm test`（vitest run） | ✅ 10 文件 / 112 用例全绿 |
| 构建 | `pnpm build` | ✅ dist 5 文件，含 bin 所需 `dist/cli.js` |
| Schema 安全回归 | `tests/store.test.ts` | ✅ 未来版/脏值/无迁移旧版均在 PRAGMA/DDL 前拒绝，sha256 不变 |
| WAL 快照回归 | `tests/migrate.test.ts` | ✅ 活动 writer + 未 checkpoint WAL 的已提交行进入一致快照，源 db/WAL sha256 不变 |
| 真实 boot 探针 | `node probe/boot-probe.mjs` | ✅ 21/21 断言通过，exit 0 |

## 2. 真实 boot 探针（非 `--dump-config`）

`--dump-config` 只组合配置、不 import 插件模块（AGENTS.md 已知坑），因此探针走
`@deepseek-ai/dsh-app-boot` 的真实 `boot()`：`probe/cordis.yml` 挂最小树
（`@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-system-prompt` + 本仓构建产物
`../dist/index.js`），launcher 事实按 AGENTS.md 伪造——`process.stdout.isTTY = true`、
`prepare` 回调里 `provideCmdline(ctx, {args, exit})` 并 `ctx.provide("launchEnvironment",
createLaunchEnvironmentSnapshot([...process.env]))`。收尾用 `ctx.fiber.dispose()`
（cordis 4 无 `ctx.dispose()`）。

断言与结果（`probe/boot-probe.mjs`，21/21 PASS）：

1. **七个工具注册且模型可见**：`ctx.tools.get(name)` + `ctx.tools.schemas()` 均含
   `memory_write/search/forget/update/confirm/list/merge`。
2. **write→search→confirm→forget 全链路**（统一经 `ctx.tools.execute()` 的 registry runtime，覆盖输入/输出 schema 校验、策略管线与落盘 SQLite；不再直接调用 `tool.execute`）：
   - write 返回 `written=true`（id=1）；近似文本再写被去重拦截（`written=false`，1 hit，sim=1）；
   - 有命中的 search 通过 registry 输出校验，并返回完整的 scope/时间字段；
   - confirm 单条（string id `"2"`）confirmed=1；`"*"` 全量 confirmed=2；
   - forget 后 search 不再返回该记录。
3. **中文端到端**：中文写入 → 中文关键词（“迁移 数据库”）检索命中；recall 分节文本含该中文记忆。
4. **系统提示词**：`ctx.systemPrompt.assemble()` 的 sections 含 `ltm:recall`。

## 3. 迁移端到端（真实旧库）

旧库：`~/.config/dsh/memory/memory.db`（真实 dsh-memory 库，含 wal/shm）。先整体拷贝到
`/tmp` 临时目录，再 `pnpm exec tsx scripts/legacy-migration/cli.ts --source <copy> --db <tmp>/ltm.db`（历史记录：当时经 `dsh-ltm migrate` 执行；该子命令现退役为仓库内脚本）：

- **80/80 迁移成功**，dedupedCount=0，failures=[]；
- **原库未被触碰**：migrate 前后 `memory.db` 与 `memory.db-wal` 的 sha256 逐一不变；
- 迁移产物可检索：中文关键词与 "preference" 均命中；`list` 共 80 条，JSON 合法。

## 4. 发现并修复的问题

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| F1 | 中 | `bin/dsh-ltm.mjs` 直接 `process.exit(code)`，非 TTY（管道）下大 JSON 输出在 64 KiB 管道缓冲处被静默截断（`list --json` 80 条稳定复现 65536 字节、JSON 解析失败） | 已修复：退出前 `process.stdout.write("", resolve)` 等待排空；管道输出恢复完整（104178 字节、JSON 可解析），`export` 同样验证 |
| F2 | 低 | `src/index.ts` 中 `memory_write` 的 output schema 曾与 serializer 不一致 | 已修复：schema 与 `serializers.write` 对齐，并覆盖写入/去重两分支验证 |
| F3 | 高 | `memory_search` serializer 返回完整记录与 score，但注册 schema 只允许部分字段，registry runtime 对命中结果报 `INVALID_TOOL_OUTPUT` | 已修复：抽取共享完整记录/search-hit schema；boot probe 通过 `ctx.tools.execute()` 验证真实命中 |
| F4 | 中 | search/list render 用 `lastConfirmedAt=0` 占位，导致新记录也显示 stale | 已修复：工具输出保留真实 scope 和时间字段，render 直接消费真实记录 |
| F5 | 中 | omission tail 在截断后追加，最终 prompt 可超过 `promptMaxChars` | 已修复：tail 纳入预算，必要时从末尾移除低优先级记录；单测断言最终长度 |
| F6 | 低 | 非有限 `promptOrder` 未 fail-loud | 已修复：`loadConfig` 拒绝 `NaN` / `Infinity` |
| F7 | 高 | 预算驱逐循环可从 `kept` 末尾弹出 pinned 行：`promptMaxChars` 199–233（小样本）或默认 2000 下 pinned 文本 1881–1901 字时整个 recall 分节变为 `""`；截断路径按码点计 room 导致 astral 文本超预算 | 已修复：驱逐只弹 recent；notice 仅在 pinned 仍可辨识时保留；截断按 UTF-16 计长（issue #8） |

## 5. 结论

P1（核心引擎）+ P1'（插件面）联合验证通过：全测试矩阵绿、真实 boot 七工具全链路（含中文及 registry 输出校验）通过、真实旧库迁移只读且原库字节不变。上述 F1–F6 均已收敛，可以进入后续评审。

## 6. issue #32 阶段一（revision CAS）验证增补

日期：2026-10 · 同机同 Node。新增测试面与结果：

| 检查 | 覆盖 | 结果 |
|---|---|---|
| `tests/cas.test.ts`（store 层） | 双连接同读 v1 后 A 成功 v2、B expected 1 冲突且正文/时间/FTS/revision 全保留；冻结时钟同毫秒 1→2→3→4→5 可区分；dedupe/空 patch/同值 patch/confirm/`*`/merge 的递增规则；只读路径不递增；MAX 上限（update/confirm/merge 目标整次拒绝、`*` 任一可见行 MAX 全批失败、MAX forget/源删除仍可用）；畸形版本（0/负/小数/NaN/Infinity/字符串/null/超界）一律 INVALID_ARGUMENT；CAS 未知/已删除/越权统一 NOT_FOUND 无 currentRevision；旧版本 confirm 不能确认新正文、旧版本 forget 不能删新记录；严格 merge（目标/任一源冲突、缺源、越权、跨 scope、部分/重复/多余/only-target/空/畸形声明）零写入 | ✅ 全绿 |
| `tests/upgrade-schema.test.ts` | 真实 v1 库（含未 checkpoint WAL）：普通打开只读拒绝且字节不变；升级后旧行 revision=1、正文/时间戳/scope/tags/pinned/ids/FTS 检索全保留；默认与显式备份（`VACUUM INTO` 一致快照）；备份覆盖/指向库本体/sidecar/既有文件拒绝；ALTER/COMMIT 失败回滚列+版本戳且保留备份；锁后并发升级重验（已升级→already-current）；结构中途变更 fail loud；unknown/畸形/较新/伪造 v1/带 revision 的假 v1 拒绝且 main+WAL sha256 不变；empty/缺失库不创建 | ✅ 全绿 |
| `tests/cas-tools.test.ts`（工具层） | 四个变更工具的注册输出 schema（memory{Update,Confirm,Forget,Merge}OutputSchema）与实际值经 `validateJsonSchemaValue` 一致；结构化 error 原字段 false/0 保留、无 record/budget；`*`+版本拒绝；dedupe/记录/搜索投影携带 revision；跨项目隔离下 CAS 失败仅元数据 | ✅ 全绿 |
| `tests/cli-cas.test.ts` | `--expected-revision` 全命令生命周期与冲突（--json 结构化 error、人类模式仅码/版本/重读指引）；畸形 flag 在建库前拒绝；merge `--expected-source-revisions` 八类反例；export `/2` 往返、import `/1`（缺省 1/带版本校验）、`/2` 缺版本拒绝、同 id 异 revision 整批回滚；upgrade-schema CLI 全流程与反例 | ✅ 全绿 |
| 真实 boot 探针 | 读版本→CAS 成功→结构化冲突（registry 校验通过、渲染含码与重读指引、零写入）→严格 merge 成功/陈旧拒绝→CAS confirm/forget→`*`+版本拒绝→跨 scope NOT_FOUND 无版本披露→跨项目 memory_list 聚合不回退 | ✅ 新增 16 断言全 PASS |

阶段一明确未做（非目标）：provenance/evidence/hash（阶段二）、来源变化/争议持久状态（阶段三）、
历史/actor/回滚（阶段四）；forget 仍真正删除正文+FTS，无新增正文历史或敏感留存；无强制网络。

## 附：复现命令

```sh
pnpm typecheck && pnpm test && pnpm build
node probe/boot-probe.mjs                       # 真实 boot 探针（含 CAS 链）
node bin/dsh-ltm.mjs --help
node --test .github/scripts/check-packed.cases.mjs
cp ~/.config/dsh/memory/memory.db* /tmp/ltm-src/
pnpm exec tsx scripts/legacy-migration/cli.ts --source /tmp/ltm-src/memory.db --db /tmp/ltm-src/ltm.db
node bin/dsh-ltm.mjs search "数据库" --db /tmp/ltm-src/ltm.db --json
```
