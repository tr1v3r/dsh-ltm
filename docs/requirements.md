# dsh-ltm 0.1 需求规格（P0 定稿）

> 状态：冻结。变更需同步 `src/contracts.ts` 与 `docs/data-model.md`。
> 本文是 R1–R10 → 验收的唯一映射。

## 1. 范围

从零实现个人 DSH 记忆插件 `dsh-ltm`（不 fork dsh-memory），发布到
`github.com/tr1v3r/dsh-ltm` + npm `dsh-ltm`。0.1 不做：Web 管理界面、
强制 embeddings/联网依赖、多机同步、服务端。

## 2. 需求 → 验收映射

| # | 需求 | 验收（可执行/可检查） |
|---|------|----------------------|
| R1 结构化存储 | scope/project/tag 维度组织 | `MemoryRecord` 含 `scope`/`tags`；`memory_list({scope, tags})` 过滤命中（单测）；写入带 scope 后聚合视图可查 |
| R2 中文分词检索 | FTS5 + CJK 二元分词 | 纯中文查询「记忆插件」命中含该词文本；中英混排「dsh 记忆」同时命中英文与中文 token（单测：tokenize 断言 + search 端到端） |
| R3 语义检索 | 默认零网络：BM25 + char n-gram 余弦混合重排 | 同义改写查询（如「长久记忆」vs「跨会话记忆」）排序优于纯关键词结果的 case（单测）；`EmbeddingAdapter` 接口留桩（编译通过即验收） |
| R4 去重 | 写前近似重复检测 | 相似度 ≥ `dedupeThreshold` 时 `memory_write` 返回非空 `dedupeHits` 且不写入（`force: true` 才写）；`memory_merge` 合并后 source 消失、target tags 取并集（单测） |
| R5 过期复核 | `lastConfirmedAt`/`stale` | 写入时置 `lastConfirmedAt=now`；`staleAfterDays` 天后 `list({stale:true})` 命中；`memory_confirm` 刷新后不再 stale（单测，用可注入时钟或直接操纵字段） |
| R6 跨项目聚合 | scope/tag 聚合视图 | `memory_list` 无 scope 时返回全部并按 scope 排序分组；tag 过滤 AND 语义（单测） |
| R7 CLI 管理 | `list/search/show/edit/tag/pin/merge/confirm/export/import/migrate` | 每个子命令 JSON（`--json`）与人类双输出；`--db` 指定库路径；未知/互斥 flag 与多余位置参数 fail-loud；export/import 保持完整记录状态并验证格式与 ID 冲突（集成测试） |
| R8 自动迁移 | 旧 `~/.config/dsh/memory/memory.db` → 新 schema | 对真实旧库拷贝跑 `migrate`：`MigrationReport.migratedCount == sourceCount`，原库文件字节不变（迁移后 sha256 对比），pinned 记忆迁移后可检索 |
| R9 提示词渲染 | pinned 优先 + 字符预算 + 默认保持原文 | `escapeSequences` 默认 `[]`，模板式文本原样渲染；显式配置定界符时才以零宽空格打断，且嵌套序列与文本自带零宽空格的边界有单测；config 非法值（如 threshold∉[0,1]）load 即抛 |
| R10 发布 | GitHub + npm | CI tag 门控发布（参照 dsh-quote-followup）；**push/publish 前需用户本人确认**；`main` 分支保护：只能经 PR 合并，必检 `test (22)`/`test (24)`/`pack` 全绿且分支最新，禁强推与删分支，管理员不豁免（见 `docs/integration.md` §1） |

## 3. 工具集契约（§4 定稿）

兼容保留（参数与返回形状对齐 dsh-memory@0.1.0，模型习惯不变）：

- `memory_write(text, tags?, pinned?)` → `{record, dedupeHits}`（新增 `force?` 与 `dedupeHits` 字段为增量，不破坏旧消费方）
- `memory_search(query, limit?)` → `{results}`（`results[]` 字段结构与旧版 `matches` 等价，含 rank 语义）
- `memory_forget(id)` → `{deleted}`

新增：

- `memory_update(id, text?, tags?, pinned?)` — 原位修订，保留 id 引用
- `memory_confirm(id | "*")` — 刷新 `lastConfirmedAt`、清 stale
- `memory_list(scope?, tags?, stale?, limit?)` — 过滤浏览
- `memory_merge(targetId, sourceIds[], text?, tags?)` — 合并重复

写入路径：`memory_write` 先 dedupe（Jaccard；cosine 阈值配置了才启用），
命中则返回相近条目让模型决定 merge 或 `force` 强写。

## 4. 关键约束（评审对照清单）

1. 每轮验证必须真实 boot（`--dump-config` 不 import 模块）。
2. 新插件 entry 必须走 `cordis.patch.yml` 的 `- insert:`，独立新库路径
   （`$DSH_HOME/memory/ltm.db`），迁移完成验证前不动旧 `memory.db`。
3. FTS5 MATCH 表达式中每个 token 必须加引号（防操作符注入）。
4. `node:sqlite` 的 ExperimentalWarning 属预期，不视为失败。
5. CLI/工具输出不回显秘密；记忆内容不写日志。
6. schema 分节校验失败 fail-loud：非法 config 值在 load 即抛。
