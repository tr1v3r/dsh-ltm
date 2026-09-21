# P2 验证报告 — dsh-ltm 整体验证与真实 boot 探针

日期：2026-09-27 · 环境：macOS / Node v24.20.0 / dsh 0.1.5-rc.1（dsh-app-boot 0.1.5-rc.2）· 工作区 `dsh-ltm` @ P1+P1' 完成后

## 1. 测试矩阵

| 检查 | 命令 | 结果 |
|---|---|---|
| 全仓类型检查 | `pnpm typecheck` | ✅ 0 错（t1 报的 surface 残留错误已由 t2 收敛） |
| 全部单测 | `pnpm test`（vitest run） | ✅ 10 文件 / 96 用例全绿 |
| 构建 | `pnpm build` | ✅ dist 5 文件，含 bin 所需 `dist/cli.js` |
| Schema 安全回归 | `tests/store.test.ts` | ✅ 未来版/脏值/无迁移旧版均在 PRAGMA/DDL 前拒绝，sha256 不变 |
| WAL 快照回归 | `tests/migrate.test.ts` | ✅ 活动 writer + 未 checkpoint WAL 的已提交行进入一致快照，源 db/WAL sha256 不变 |
| 真实 boot 探针 | `node probe/boot-probe.mjs` | ✅ 18/18 断言通过，exit 0 |

## 2. 真实 boot 探针（非 `--dump-config`）

`--dump-config` 只组合配置、不 import 插件模块（AGENTS.md 已知坑），因此探针走
`@deepseek-ai/dsh-app-boot` 的真实 `boot()`：`probe/cordis.yml` 挂最小树
（`@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-system-prompt` + 本仓构建产物
`../dist/index.js`），launcher 事实按 AGENTS.md 伪造——`process.stdout.isTTY = true`、
`prepare` 回调里 `provideCmdline(ctx, {args, exit})` 并 `ctx.provide("launchEnvironment",
createLaunchEnvironmentSnapshot([...process.env]))`。收尾用 `ctx.fiber.dispose()`
（cordis 4 无 `ctx.dispose()`）。

断言与结果（`probe/boot-probe.mjs`，18/18 PASS）：

1. **七个工具注册且模型可见**：`ctx.tools.get(name)` + `ctx.tools.schemas()` 均含
   `memory_write/search/forget/update/confirm/list/merge`。
2. **write→search→confirm→forget 全链路**（经注册后的真实 execute，落盘 SQLite）：
   - write 返回 `written=true`（id=1）；近似文本再写被去重拦截（`written=false`，1 hit，sim=1）；
   - confirm 单条（string id `"2"`）confirmed=1；`"*"` 全量 confirmed=2；
   - forget 后 search 不再返回该记录。
3. **中文端到端**：中文写入 → 中文关键词（“迁移 数据库”）检索命中；recall 分节文本含该中文记忆。
4. **系统提示词**：`ctx.systemPrompt.assemble()` 的 sections 含 `ltm:recall`。

## 3. 迁移端到端（真实旧库）

旧库：`~/.config/dsh/memory/memory.db`（真实 dsh-memory 库，含 wal/shm）。先整体拷贝到
`/tmp` 临时目录，再 `node bin/dsh-ltm.mjs migrate <copy> --db <tmp>/ltm.db --json`：

- **80/80 迁移成功**，dedupedCount=0，failures=[]；
- **原库未被触碰**：migrate 前后 `memory.db` 与 `memory.db-wal` 的 sha256 逐一不变；
- 迁移产物可检索：中文关键词与 "preference" 均命中；`list` 共 80 条，JSON 合法。

## 4. 发现并修复的问题

| # | 严重度 | 问题 | 处置 |
|---|---|---|---|
| F1 | 中 | `bin/dsh-ltm.mjs` 直接 `process.exit(code)`，非 TTY（管道）下大 JSON 输出在 64 KiB 管道缓冲处被静默截断（`list --json` 80 条稳定复现 65536 字节、JSON 解析失败） | 已修复：退出前 `process.stdout.write("", resolve)` 等待排空；管道输出恢复完整（104178 字节、JSON 可解析），`export` 同样验证 |
| F2 | 低 | `src/index.ts` 中 `memory_write` 的 output schema 声明顶层 `id: integer`，但 execute 实际返回 `record: {id, ...}`（schema `additionalProperties: false`，两者不一致；当前 dsh-tools 未强制校验未炸，但下游一旦按 schema 校验/裁剪会破坏 `record` 字段） | 报告给 surface 维护者，建议 schema 改为 `record`（对齐 `serializers.write`）或 execute 改回顶层 `id` |

## 5. 结论

P1（核心引擎）+ P1'（插件面）联合验证通过：全测试矩阵绿、真实 boot 七工具全链路（含中文）通过、真实旧库迁移只读且原库字节不变。F1 已修复，F2 建议在 P3 评审前收敛。可以进入 P3 双评审。

## 附：复现命令

```sh
pnpm typecheck && pnpm test && pnpm build
node probe/boot-probe.mjs                       # 真实 boot 探针（18 断言）
cp ~/.config/dsh/memory/memory.db* /tmp/ltm-src/
node bin/dsh-ltm.mjs migrate /tmp/ltm-src/memory.db --db /tmp/ltm-src/ltm.db --json
node bin/dsh-ltm.mjs search "数据库" --db /tmp/ltm-src/ltm.db --json
```
