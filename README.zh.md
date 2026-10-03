# dsh-ltm（中文说明）

> 本文件是 [README.md](README.md) 的中文对照说明；内容以英文版为准，两者同步更新。

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的结构化长期记忆插件：
本地 SQLite 存储 + 中文感知分词检索（CJK 二元分词 + FTS5）、BM25 与字符 n-gram 余弦混合重排、
近似重复检测、过期复核、以及从 `dsh-memory` 的一次性迁移 —— 零强制联网依赖。

## 为什么需要

- `dsh-memory@0.1.0` 是纯文本 + 默认分词器的 FTS5：中文检索基本不可用（整句变成单个 token）。
- 长期记忆需要追加/检索之外的生命周期管理：结构化 scope 与 tags、重复检测、复核时间戳、有界召回。

## 安装到 profile

`@tr1v3r/dsh-ltm` **0.1.2 及以上**可用一条命令安装并注册 bundle 配置：

```sh
dsh plugin --profile web add @tr1v3r/dsh-ltm
```

把 `web` 换成你的 profile 名（例如 `dsh-tui`），然后重启该 profile。bundle 会把数据库路径设为
`$DSH_HOME/memory/ltm.db`；无需 API key 或 embedding 服务。

替换 `dsh-memory` 时先禁用其旧条目：两个插件都注册 `memory_write` / `memory_search` /
`memory_forget`。若此前手工插入过 `ltm` 条目，启用 bundle 前先移除手工 insert，避免重复实例。
安装不会自动迁移旧库；见[从 dsh-memory 迁移](#从-dsh-memory-迁移)。

手工组合（含缺少 bundle manifest 的 0.1.0–0.1.1）：安装 npm 依赖后，在 profile 的
`cordis.patch.yml` 里 insert：

```yaml
- insert:
    - id: ltm
      name: '@tr1v3r/dsh-ltm'
      config:
        path: !!js dshHomePath('memory/ltm.db')
```

`path` **必填**，代码侧无默认值。推荐的部署路径是 `$DSH_HOME` 下的 `memory/ltm.db` ——
独立新库，本插件绝不写旧 `memory/memory.db`。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `path` | *（必填）* | SQLite 文件，或 `:memory:` |
| `defaultScope` | `""` | 兜底 scope；关闭自动检测时作为固定 scope |
| `autoProjectScope` | `true` | 从每个 agent 会话的 cwd/Git 仓库推导当前项目 |
| `escapeSequences` | `[]` | 可选：渲染进提示词前以零宽空格打断的输出序列 |
| `promptRecentCount` | `10` | 召回分节中未置顶的最近记忆数 |
| `promptMaxChars` | `2000` | 分节硬性 UTF-16 字符预算；置顶记录优先保留 |
| `promptMaxTokens` | *（未设）* | 可选的正安全整数硬 token 上限（与字符预算并存） |
| `promptTokenizerPath` | *（未设）* | 本地受支持的 Hugging Face `tokenizer.json`；与 `promptMaxTokens` 成对必填 |
| `maxTextChars` | `2000` | 单条记忆最大字符数 |
| `searchLimitDefault` / `searchLimitMax` | `10` / `50` | 检索结果数量限制 |
| `promptOrder` | `50` | 召回分节顺序 |
| `dedupeThreshold` | `0.8` | Jaccard 相似度 ≥ 该值判定近似重复 |
| `dedupeCosineThreshold` | `0.92` | 余弦相似度 ≥ 该值同样判定近似重复 |
| `staleAfterDays` | `90` | 超过该天数未确认的记忆标记 stale |

默认情况下，记忆文本在召回提示词中逐字保留。`escapeSequences` 是部署级显式开关，
面向把渲染后的提示词再交给其它基于定界符解析器的环境；DSH 本身不需要。

非法值（空路径、非整数边界、阈值超出 `[0,1]`、短于 2 字符或含零宽空格的转义序列）
在插件加载时即抛错 —— fail loud，而不是等第一次工具调用。

### 自动项目隔离

`autoProjectScope: true` 时，每个 agent 解析自己的 `session.header.cwd`；绝不使用共享的
DSH 进程 cwd。Git 检出以其 canonical common Git directory 识别，因此子目录与 linked
worktree 共享同一项目 scope；非 Git 工作区按 canonical 目录识别。Git scope 名只含 SHA-256
短摘要（各种 linked-worktree 布局保持一致）；目录 scope 另带可读 basename。绝不存储绝对路径。

模型面默认刻意收窄：

- 写入与近似重复检查使用当前项目 scope；
- 检索与自动召回只看当前项目 + 全局记忆（`scope=""`）；
- update / forget / confirm / merge 拒绝可见 scope 之外的记录，merge 绝不跨 scope；
- `memory_list` 与 CLI 保留显式跨项目聚合/管理面。

设 `autoProjectScope: false` 可只用 `defaultScope` 作为固定部署 scope（`""` 即仅全局）。
scope 是上下文隔离边界，不是操作系统权限边界：能直接访问 SQLite 文件或 CLI 的人仍可管理所有记录。

### 可选离线提示词 token 预算

两个选项默认都不启用：既有纯字符输出保持不变。必须成对设置。可选依赖
`@huggingface/tokenizers@0.2.0` **只在配置了该功能的插件启动时**加载一次；渲染保持同步，
无网络请求、下载或文件读取。CLI `doctor` 可用显式 JSON 配置渲染诊断投影（绝不读取运行中的
profile）。支持受限且经过保真测试的 ByteLevel/BPE 子集；不支持的管线/选项在启动时失败，
而不是静默近似。上限统计**完整的转义后召回分节**（含头部、元数据、换行、截断省略号与
省略提示）；置顶记录优先，recent 绝不为了省略提示挤掉置顶。离线计数对所选 tokenizer 定义是
精确的，**不是服务端用量的承诺**。详见 [docs/prompt-token-budget.md](docs/prompt-token-budget.md)。

## 模型工具

兼容 `dsh-memory` 习惯：

- `memory_write(text, tags?, pinned?, force?)` —— 先做去重检查；近似重复返回候选而非写入，
  除非 `force: true`
- `memory_search(query, limit?)` —— 中文感知分词 + 混合重排
- `memory_forget(id, expectedRevision?)`

新增：

- `memory_update(id, text?, tags?, pinned?, expectedRevision?)` —— 原位修订，保留 id
- `memory_confirm(id | "*", expectedRevision?)` —— 刷新复核时间戳、清除 stale
- `memory_list(scope?, tags?, stale?, limit?)` —— 过滤浏览（tags AND 语义）
- `memory_merge(targetId, sourceIds[], text?, tags?, expectedRevision?, expectedSourceRevisions?)` —— 合并重复；tags 默认取并集

身份未知时先检索既有事实/主题再写入。**同一事实**的状态变化应走 `memory_update`，
而不是再写一条或 force 写入近似重复。相似度不能证明等价或矛盾；请审阅候选。这是指引，
不是强制的额外检索调用。

成功的置顶写入与相关更新附带可选 `budget` 反馈；去重拦截的写入不声明新的置顶预算。

### 乐观并发（revision CAS，#32 阶段一）

每条存储的记忆都带 `revision`（正整数，从 1 起，与时钟无关）。所有读取 —— 检索结果、
list、提示行（`(#id, rev N, …)`）、去重候选 —— 以及每次成功写入都会报告它。向
`memory_update` / `memory_confirm` / `memory_forget` / `memory_merge` 传入
`expectedRevision`（你最近读到的版本）即把该变更变成同一个 `BEGIN IMMEDIATE` 事务内的
比较交换：若记录在你读取之后发生了变化，操作以结构化 `MEMORY_REVISION_CONFLICT`
（`{code, operation, id, expectedRevision, currentRevision}`）失败且**什么都不写** ——
不会自动重试你的旧内容。重新读取记录，用其当前版本重试。

- 省略版本字段保持旧的、**不受保护**的行为；不带版本的调用绝不宣称受 CAS 保护。
- 严格模式的 `memory_merge` 要求目标的 `expectedRevision` 加上恰好覆盖唯一源 id 集合的
  `expectedSourceRevisions`；部分/重复/多余/包含目标的声明在任何读取之前即被拒绝。
- `id: "*"` 的 `memory_confirm` 只刷新复核时间戳，不是逐条验证，且拒绝 `expectedRevision`。
- 冲突与未知/已删除/越权 id 都是纯元数据失败（错误码：`MEMORY_REVISION_CONFLICT`、
  `MEMORY_NOT_FOUND`、`MEMORY_INVALID_ARGUMENT`、`MEMORY_SCOPE_MISMATCH`、
  `MEMORY_REVISION_OVERFLOW`）；错误中绝不包含记忆正文。
- 成功的 update/confirm/merge 返回新 revision；`memory_forget` 返回 `deletedRevision`
  （被删除时的版本）。
- revision 计数有上限（`Number.MAX_SAFE_INTEGER`）；到达上限的记录不能再被更新、确认或
  作为 merge 目标 —— 整次操作拒绝，不静默溢出。删除不受上限限制。

阶段一限制（分阶段计划见 issue #32）：CAS 只保护你观察到的版本，不证明内容正确；
阶段二至四（provenance/evidence、分层复核状态、历史/回滚）尚未实现；没有跨恢复/导入的
incarnation/tombstone 保护 —— 此类操作后请静默写入者并重新读取。

## 规模与限制

近似重复检测在每次非 force 的 `memory_write` 时扫描同 scope 的全部记忆。该设计面向个人
长期事实库而非大型文档集合。写成本随该 scope 内记忆的数量与长度增长；暂无基准支撑的
容量上限。多会话可共享本地 WAL 库：初始化后的兼容打开不抢 schema 写锁；首次初始化、
schema 修复与 token 索引重建仍需写入。SQLite 以 5 秒 busy 超时串行化写入者；`SQLITE_BUSY`
提示稍后重试，无自动应用层重试。这不是高并发服务，也不是跨机数据库同步。

## CLI

```sh
npx -p @tr1v3r/dsh-ltm dsh-ltm --db /path/to/ltm.db <command> [--json]
```

`list / search / show / edit / tag / pin / merge / confirm / forget / upgrade-schema /
export / import` —— 每个子命令都支持 `--json`。未知 flag、互斥 flag 与多余位置参数一律
拒绝。默认数据库：`$DSH_HOME/memory/ltm.db`。

`edit`/`tag`/`pin`/`confirm <id>`/`forget` 接受 `--expected-revision N`；`merge` 另有
`--expected-source-revisions id:rev,id:rev`（恰好覆盖唯一源集合）。这些 flag 在打开数据库
之前完成校验；`confirm --all --expected-revision` 拒绝。CAS 失败以退出码 1 结束，`--json`
输出与工具相同的结构化 `error` 详情，人类模式只输出错误码/id/版本与重读指引，绝不回显
未请求的正文。成功的 `show`/`list`/`search`/`edit`/`tag`/`pin`/`merge` 输出版本号；
`confirm <id>` 报告 `confirmed` + `revision`，`--all` 只报告计数；`forget` 报告
`deleted` + `deletedRevision`。

#### Schema 升级（v1 → v2）

revision 列之前创建的数据库（schema v1）**绝不隐式升级**：普通 store/插件/CLI 打开时只读
拒绝，并指向显式升级入口。先停掉所有写入者（包括运行中的插件），然后：

```sh
dsh-ltm --db /path/to/ltm.db upgrade-schema            # 默认在库旁生成备份
dsh-ltm --db /path/to/ltm.db upgrade-schema --backup /path/to/new-backup.db
```

该命令先在只读连接上分类（未知、畸形、伪造 v1、较新版本一律拒绝，主库与已提交 WAL 字节
不变），再用只读 `VACUUM INTO` 取一份 SQLite 一致的备份（默认名
`<db>.pre-v2-backup-<UTC时间戳>`，绝不覆盖既有文件、绝不指向数据库/sidecar），最后在
写锁下重新核验 v1 结构后，于同一事务应用 `ALTER TABLE memories ADD COLUMN revision …`
与 `meta.schema_version = '2'` 版本戳。旧行保持正文/时间戳/scope/tags/pinned 并从
revision 1 开始；`fts_token_version` 不动。失败即回滚、无半升级状态、备份保留。回滚需
手工进行：停掉写入者并恢复备份快照（升级后的写入会丢失）。已升级库是 metadata-only
no-op；该命令绝不创建缺失或空数据库。旧的 `dsh-memory` → dsh-ltm 一次性迁移是独立的
仓库内工具（见下）。

`export` 输出 `dsh-ltm-export/2`（每条记录携带 `revision`）；`--out` 必须是**新文件**：
既有文件（含符号链接与硬链接）绝不覆盖，数据库及其 SQLite sidecar 路径即使不存在也被
预留。不给 `--out` 时 JSON 走 stdout；shell 重定向不在此保护范围内。

`import` 同时接受 `dsh-ltm-export/1`（无 revision 的记录按 1 恢复；带 revision 则严格
校验、绝不忽略）与 `/2`（revision 必填并保留）。完整校验载荷并恢复 ID、时间戳、规范化
tags、scope、pinned、复核生命周期与 revision。完全一致（含 revision）的重复导入幂等跳过；
不同则整批中止、无部分写入 —— 导入绝不以不同 revision 覆盖既有 id。恢复/导入是管理性
恢复边界：CAS 令牌不跨备份或已删除 id 的重导入存活（阶段一无 tombstone），此类操作后
请静默写入者并重新读取。

### 只读质量体检（doctor）

```sh
dsh-ltm --db /path/to/ltm.db doctor --json
dsh-ltm doctor --config /path/to/ltm-config.json --scope 'git:…' --max-pairs 100000 --json
```

`doctor` 以 SQLite `readOnly: true` 打开**既有**库，绝不经 `MemoryStore`：不创建、不改
journal mode、不重建 FTS、不迁移、不确认、不清理。缺失文件/父目录与不兼容 schema 一律
fail loud。读取一致基表快照（含已提交 WAL）。FTS 健康明确不检查不修复。两种输出模式都
不包含记忆正文与 tags；findings 只含 ID、规则名、原因、长度/相似度。规则是建议性的，
不是删除/搬移/缩短任何内容的授权。分析与 scope 分布覆盖**整个数据库**；prompt 统计单独
按可见 scope 计算。CLI **不加载运行中的 profile**；不带 `--config` 时预算是包默认值。
同 scope 近似重复分析是记录数的二次方（对文本长度也敏感），默认上限 100,000 对比较；
总数/已比较/跳过/是否完整始终显式，不完整的扫描不可能冒充完整覆盖。相似度是词法证据，
不是矛盾检测。

### 从 dsh-memory 迁移

从已退役的 `dsh-memory` 插件的一次性导入位于仓库内而非已发布 CLI
（`scripts/legacy-migration/`，见其 README）。dsh-ltm 数据库之间的备份与转迁移请用
`export` / `import`：它们保留项目 scope 与复核时间戳，而迁移（旧 schema、全局 scope 映射）
不保留。

## 开发

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

- `node:sqlite`（Node `^22.19.0 || >=24.0.0`）；WAL + `busy_timeout`。
- 引擎模块：`src/store.ts`、`src/tokenize.ts`、`src/search.ts`、`src/dedupe.ts`、
  `src/expire.ts`、`src/errors.ts`、`src/schema.ts`、`src/upgrade.ts`；冻结接口在
  `src/contracts.ts`。
- 面模块：`src/config.ts`、`src/tools.ts`、`src/prompt.ts`、`src/cli.ts`、`src/index.ts`。
- 改插件接线或工具 schema 后必须跑真实 boot 探针：`node probe/boot-probe.mjs`。

## 发布凭据

发布经 npm Trusted Publishing（OIDC + provenance）从 `.github/workflows/publish.yml`
进行，CI 不需要任何存储型 npm token。其它 npm 发布凭据尽量放在仓库之外；如需项目级配置
请使用被忽略的 `.npmrc-publish` 路径，绝不强制加入 Git。不要把 npm token 放进被跟踪的
`.npmrc`、源码、示例、测试夹具、shell 记录或 CI 日志。若凭据可能进入过 commit、日志、
产物或共享终端历史，先在 npm 账号立即吊销或轮换，再清理暴露副本；仅改写 Git 历史并不能
使凭据失效。

MIT © tr1v3r
