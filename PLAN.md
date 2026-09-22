# dsh-ltm 实施计划

> 从零编写的个人 DSH 记忆插件（不 fork [dsh-memory](https://www.npmjs.com/package/dsh-memory)）。
> 目标：结构化跨会话记忆，主要自用，发布到 `github.com/tr1v3r/dsh-ltm` + npm 公开包。

## 1. 背景与动机

- 现役 `dsh-memory@0.1.0`（上游唯一版本，2026-08-13 后无更新、无 repository 字段）只有
  平文本记忆 + FTS5 关键词检索，中文检索基本无效（默认 tokenizer 把整句当一个 token）。
- 长期记忆还需要结构化组织、近重复治理、过期复核和受预算约束的召回；这些能力不适合继续靠本地补丁维护。
- 参考（MIT，只读）：`~/.config/dsh/profiles/web/node_modules/dsh-memory/`。
- 工程惯例对齐 `~/workspace/opensource/dsh-quote-followup` / `dsh-jev`。

## 2. 用户需求（核心范围）

| # | 需求 | 说明 |
|---|------|------|
| R1 | 结构化存储 | 不同对话的核心上下文信息按 scope/project/tag 维度组织 |
| R2 | 中文分词检索 | FTS5 unicode61 + trigram，或 CJK 二元分词方案 |
| R3 | 语义检索 | 默认零网络依赖：BM25 + char n-gram 余弦混合重排；可选外部 embeddings adapter（不强制联网） |
| R4 | 去重 | 写入前近似重复检测（token Jaccard / 余弦阈值可配），提示合并 |
| R5 | 过期复核 | `lastConfirmedAt` / `stale` 标记，`memory_confirm` 刷新 |
| R6 | 跨项目聚合 | 相似信息按 scope/tag 聚合视图 |
| R7 | CLI 管理 | `list/search/show/edit/tag/pin/merge/confirm/export/import/migrate`，JSON + 人类双输出；Web 界面为 stretch goal，不入 0.1 |
| R8 | 自动迁移 | 读旧 `~/.config/dsh/memory/memory.db`（`memories` 表 + FTS5 external-content 索引，SCHEMA_VERSION=1）→ 复制进新 schema，原库只读保留为回滚 |
| R9 | 提示词渲染 | pinned 优先 + 字符预算机制保留；记忆原文默认不变，`escapeSequences` 仅作为部署层显式 opt-in（默认 `[]`） |
| R10 | 发布 | GitHub `tr1v3r/dsh-ltm` + npm 公开包（`dsh-ltm` 名已于 2026-09-21 确认可用） |

## 3. 架构

```
src/
├── contracts.ts     # 冻结接口：MemoryRecord(扩展)/Store API/SearchResult/DedupeHit/MigrationReport
├── schema.ts        # schema version + 增量迁移 DDL
├── store.ts         # node:sqlite，WAL + busy_timeout，幂等 open/close
├── tokenize.ts      # CJK 感知分词：拉丁按词、CJK 二元；token 全引号防 FTS5 操作符注入
├── search.ts        # FTS5/BM25 + char n-gram 余弦重排（默认档）；embeddings adapter 接口留桩
├── dedupe.ts        # 近似重复检测（阈值可配）
├── expire.ts        # lastConfirmedAt / stale 判定
├── migrate.ts       # 旧 dsh-memory 库 → 新 schema，产出 MigrationReport
├── config.ts        # schemastery Config（path 必填、escapeSequences、预算/上限类字段齐全，fail-loud）
├── tools.ts         # 模型侧工具（见 §4）
├── prompt.ts        # recall 分节渲染（pinned 优先 + 预算 + 可选输出变换）
├── cli.ts + bin/    # CLI（--db 参数，JSON/人类输出）
└── index.ts         # Cordis apply：ctx.tools.register + ctx.systemPrompt.section，dispose 关库
cordis.patch.yml     # - insert: 行，path 用 dshHomePath（新库独立路径，不覆盖旧库）
```

- 技术栈：pnpm + tsdown + vitest + typescript；`type: module`；
  `engines.node: ^22.19.0 || >=24.0.0`；MIT；peerDeps 对齐 dsh rc 线。
- 零强制网络依赖：embedding/分词自实现或极轻量库。

## 4. 模型侧工具集

兼容保留（语义不破坏）：`memory_write` / `memory_search` / `memory_forget`。
新增（具体以 requirements 定稿为准）：

- `memory_update` — 修订既有记忆文本/标签（旧版只能删了重写，丢 id 引用）
- `memory_confirm` — 刷新 lastConfirmedAt，清除 stale
- `memory_list` — 按 scope/tag/stale 过滤浏览
- `memory_merge` — 合并重复条目

写入路径：`memory_write` 先走 dedupe 检测，命中阈值返回既有相近条目供模型决定合并或强写。

## 5. 阶段计划（含验收）

| 阶段 | 任务 | 依赖 | 验收 |
|------|------|------|------|
| P0 | 需求与架构规格：`docs/requirements.md`、`docs/data-model.md`、冻结 `src/contracts.ts`、`docs/adr-semantic-search.md` | — | 需求→验收映射完整；contracts 编译通过；包名 npm 可用 |
| P1 | 核心引擎：store/schema/tokenize/search/dedupe/expire/migrate + 单测 | P0 | 中文（纯中文、中英混排）按二元分词命中；迁移 fixture 旧库记录数一致且原文件未动；去重阈值内命中；`pnpm install/typecheck/test/build` 全绿 |
| P1'（并行） | 插件面：config/tools/prompt/cli + `cordis.patch.yml` + README（先以 contracts+桩并行，最终联调） | P0 | 三旧工具兼容；默认原文渲染及显式 opt-in 输出变换均有测试；config 非法值 load 即抛；CLI migrate 对 fixture 跑通 |
| P2 | 整体验证：测试矩阵 + **真实 boot 探针**（`dsh-app-boot` boot() 挂最小树，伪造 isTTY/DSH_LAUNCH_ENVIRONMENT_KEY/provideCmdline；断言工具注册、write→search→confirm→forget 全链路）+ 中文端到端 + 迁移端到端（真实旧库拷贝到临时位置，原库不动）→ `docs/verification.md` | P1, P1' | boot-probe 真实加载插件；两处端到端通过 |
| P3 | 评审 ×2（core / surface）：SQL 注入面、并发、迁移只读、错误语义、dispose 无泄漏、README 准确性 | P2 | verdict=pass，无 blocker/high 遗留 |
| P4 | 集成：仓库推 GitHub + CI（tag 门控发布，参照 dsh-quote-followup）；dotfiles 两 profile bundles 替换 `dsh-memory` → `dsh-ltm`；`dsh plugin install`；停旧库写入后 CLI migrate（备份先行）；真实 boot 两 profile（TUI 伪 TTY 横幅 + web 监听） | P3 | dump 无 `not found` 警告且新 entry 在树中；pinned 记忆迁移后可检索；**push/publish 前需本人确认** |

## 6. 关键约束与坑（来自 dotfiles 经验）

- ⚠️ `--dump-config` 不 import 插件模块——每轮验证必须真实 boot。
- ⚠️ 顶层 `- id:` patch 是定位不是新增，新插件 entry 必须走 `- insert:`。
- ⚠️ schema 分节校验失败是注册即抛、整树 fail loud，改配置先本地 merge 验证。
- ⚠️ 新库独立路径（如 `$DSH_HOME/memory/ltm.db`），迁移完成验证前不动旧 `memory.db`。
- ⚠️ `node:sqlite` 在 Node 22/24 会打一条 ExperimentalWarning，属预期。
- CLI/工具输出不回显秘密；记忆内容不写日志。

## 7. 非目标（0.1 不做）

- Web 管理界面（stretch goal）。
- 强制 embeddings / 任何联网依赖。
- 多机同步、服务端。
