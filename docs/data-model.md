# dsh-ltm 数据模型（P0 定稿；v2 增补见 §1.1）

> 与 `src/contracts.ts` 同步冻结。新库独立路径 `$DSH_HOME/memory/ltm.db`。

## 1. Schema（SCHEMA_VERSION = 2）

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- meta.schema_version = '2'

CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  text             TEXT    NOT NULL,
  tags             TEXT    NOT NULL DEFAULT '',   -- 规范化：小写去重空格连接
  scope            TEXT    NOT NULL DEFAULT '',
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,             -- epoch ms
  updated_at       INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1    -- CAS 版本，见 §1.1
    CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991)
);

-- CJK 单字 + 二元分词索引（content 自持有；不用 external-content，
-- 因为 token 是自定义分词结果，需要重建能力）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, tags, scope,
  tokenize = 'unicode61'
);
-- 索引列存的是 tokenize() 产物（拉丁整词 + CJK unigram/bigram），写入/更新/删除
-- 与 memories 表同事务维护。meta.fts_token_version 独立跟踪派生 token 格式；
-- 版本缺失或过旧时，打开库会从 memories 原文原子重建整个 FTS 表。
```

要点：

- `scope=''` 表示全局记忆。插件默认从每个 agent 的 `session.header.cwd` 派生项目
  scope：Git 仓库使用 canonical common Git directory（linked worktree 共享），非 Git
  工作区使用 canonical cwd；Git scope 只含路径 SHA-256 短摘要，目录 scope 另带可读 basename，均不存绝对路径。
  模型召回限制为“当前项目 + 全局”，跨项目聚合仍由 `memory_list`/CLI 显式提供。
- 打开已有库先在**独立只读连接**上校验 `meta.schema_version`（读写句柄本身对 WAL
  库就是破坏性的：最后一个连接关闭会 checkpoint 并把 `-wal`/`-shm` 融合/删除），
  通过后才执行 `journal_mode=WAL` 与 DDL。版本值只接受规范的非负十进制整数字符串
  （如 `1`）；未来版本、无版本、脏值、未识别形状的 `meta` 表以及没有显式迁移路径的
  旧版本都 fail-closed，拒绝时**主库与 `-wal` 字节不变**（`-shm` 是 SQLite 的共享
  内存协调文件，只读连接也可能创建/更新它）。
- FTS 虚表存**分词后文本**而非原文；原文只在 `memories.text`。CJK run 同时
  写入逐字 unigram 和相邻 bigram：单字查询可命中长文本，bigram 保留多字短语的
  选择性。检索 = 查询同构分词 → 去重、全引号拼 `OR` MATCH → BM25 候选。
- WAL + `busy_timeout=5000`；所有写操作单事务包裹（含 FTS 同步）。去重检查在 `BEGIN IMMEDIATE` 后执行，跨连接并发写不会绕过检查。
- 导出格式 `dsh-ltm-export/2`（每条 revision 必填）；导入同时接受 `/1`（缺版本按 1 恢复、带版本严格校验）与 `/2`，严格验证并原样恢复 id/时间戳/tags/scope/pinned/revision。相同 ID 且含 revision 的全部状态一致时幂等跳过，不同则整批事务回滚（见 §1.1）。
- `stale` 不是列：`last_confirmed_at + staleAfterDays*86400000 < now` 派生。

### 1.1 revision 与乐观并发（issue #32 阶段一，schema v1→v2）

`memories.revision` 是与时钟完全无关的正安全整数（1..9007199254740991，
即 `Number.MAX_SAFE_INTEGER`），NOT NULL DEFAULT 1 并带 CHECK 约束。写路径规则：

- 新 write/force 写入 =1；dedupe 命中不修改旧记录、返回其当前版本。
- update 成功一次 +1（text/tags/pinned 任意更新、同值 patch、空 patch 均算）；
  不隐式刷新 `last_confirmed_at`。
- confirm 单条成功 +1，仅刷新 `last_confirmed_at`，保持 updatedAt/正文；同毫秒
  确认也 +1。`confirm('*')` 每条实际匹配（可见 scope 内）记录 +1，整批同一事务，
  任一可见行到达上限即 `MEMORY_REVISION_OVERFLOW` 全批失败。
- merge 目标 +1（即使正文相同），源记录物理删除且不产生可见新版本；目标保持旧
  `last_confirmed_at`。上限源可被匹配版本删除；上限目标禁止 merge。
- forget 真正删除基表+FTS 行，无历史/tombstone，不为已删除行递增。
- 导出格式 `dsh-ltm-export/2` 每条 revision 必填；`/1` 缺版本按 1 导入、带版本
  严格校验。importRecords 对现有 ID 做含 revision 的全字段幂等比较，不同即整批
  回滚，绝不覆盖写（也不导入降版本）。
- schema v1→v2 显式升级把旧行初始化为 1，不改正文/timestamps/scope/tags/pinned；
  FTS 重建与 `fts_token_version` 修复不递增 revision；搜索/list/forPrompt/doctor/
  export 均不递增。
- 读取路径（toRecord）拒绝缺失/畸形 revision 的行，绝不静默按 1 读取。

CAS 输入严格校验：`expectedRevision`/merge 参与者版本只接受正安全整数；
0、负数、小数、NaN、Infinity、null、字符串一律 `MEMORY_INVALID_ARGUMENT`，
不得按「未提供」降级。未提供任何版本字段 = 明确的非 CAS 旧行为（不宣称受保护）。
提供版本时，读取-比较-写入（基表+revision+FTS）在同一个 `BEGIN IMMEDIATE`
事务内完成；冲突不自动重试旧内容。scope 权限在版本比较之前应用：未知/已删除/
越权统一 `MEMORY_NOT_FOUND` 且不披露 currentRevision；可见但跨 scope 的 merge
为 `MEMORY_SCOPE_MISMATCH`；SQLITE_BUSY 保持既有 actionable busy 行为。

工具/CLI 面：`memory_update/confirm/forget` 增 optional `expectedRevision`，
`memory_merge` 增 `expectedRevision` + `expectedSourceRevisions[]`（恰好覆盖去重
后源集合）；输出 schema 的记录投影增必填 `revision`；结构化失败为原布尔/计数字段
+ `error:{code,operation,id?,expectedRevision?,currentRevision?}`；
`confirm('*')` 不接受任何版本字段。prompt 行渲染 `(#id, rev N, …)`。
CLI `edit/tag/pin/confirm/forget/merge` 增 `--expected-revision`，merge 另有
`--expected-source-revisions id:rev,id:rev`；CAS 标志在打开库前完成语法与完整性
校验；`confirm --all --expected-revision` 拒绝。

### 1.2 v1→v2 显式升级路径

普通 `MemoryStore`/插件/CLI 打开 v1 库一律只读拒绝并指向 `dsh-ltm upgrade-schema`
（`src/upgrade.ts` 的 `upgradeSchema(path, {backupPath?})`）。升级流程：

1. 只读句柄分类：empty（拒绝，不代建库）/ current-v2（metadata-only no-op）/
   supported-v1（不仅看 meta 值：校验规范 `schema_version='1'`、meta 形状、
   完整旧列名/类型/not-null/PK、FTS 形状；已有 revision 列或异常自定义结构拒绝）/
   unsupported（未知无 meta、畸形版本串、schema 0、较新版本、伪造 v1）。
   拒绝时不建读写句柄，主库与已提交 WAL 字节不变（`-shm` 只读协调例外照旧）。
2. 备份：只读连接 `VACUUM INTO`（单一一致快照，含已提交 WAL；Node 22/24 通用，
   不用仅 24 的 serialize API）。默认名 `<db>.pre-v2-backup-<UTC时间戳>`；
   显式 `--backup` 必须是新文件，拒绝覆盖既有文件/数据库本体/sidecars/别名。
3. 读写句柄 `BEGIN IMMEDIATE` 后重新核验版本与 v1 结构（不能只信无锁 preflight）；
   并发已升级则报告 already-current。`ALTER TABLE memories ADD COLUMN revision …`
   与 `meta.schema_version='2'` 同一事务提交；失败回滚列与版本戳、保留备份，
   无半升级状态。不动 `fts_token_version`。
4. 回滚方法（operator 手册）：先停掉所有写入者，再恢复备份快照；升级后发生的
   写入会随恢复丢失。旧二进制遇 v2 按「较新版本」fail-closed。

## 2. 迁移（旧 dsh-memory → 新库）

旧库（SCHEMA_VERSION=1, `memories(id,text,tags,pinned,created_at,updated_at)` +
external-content FTS）只读打开：

1. 用只读 SQLite 连接的 `VACUUM INTO` 取得单个一致快照（包含已提交 WAL 帧），写入
   临时数据库后读取；不逐个复制主库/`-wal`/`-shm`，也不在源库执行 checkpoint。
   （不用 `DatabaseSync#serialize()`：它只在 Node 24 起存在，本包仍支持 Node 22.19。）
2. 逐行映射：`scope=''`、`last_confirmed_at=updated_at`、tags 沿用规范化。
3. 每行先过 dedupe（对已迁移内容），命中计入 `dedupedCount`。
4. 产出 `MigrationReport`（见 contracts.ts）；失败行记录 `{legacyId, reason}`。

迁移不捕获或降级文件系统/SQLite I/O 错误；真实原因直接返回调用方。源主库和 WAL
字节在迁移前后保持不变（`-shm` 是 SQLite 的共享内存协调文件，读连接可更新它）。

## 3. 检索管线

```
query ─tokenize→ tokens ─全引号 MATCH→ FTS5/BM25 候选
      └─char n-gram(2..3) 向量 ──┐
                                 ├→ 混合 score = w·bm25norm + (1-w)·cosine
candidates ──rerank──────────────┘
```

- BM25 归一化：FTS5 `rank` 越小越好且通常为负数；在本批候选内使用
  `(worstRank - rank) / (worstRank - bestRank)`，最佳映射为 1、最差映射为 0。
  单候选或全部同 rank 时无可区分的跨度，统一映射为 1。
- n-gram 余弦对原文（而非 token）计算，覆盖二元分词的同义改写召回。
- 默认权重 `w = 0.6`（实现期可调，写入 ADR-001 附录）。

## 4. 写入 / 去重路径

```
memory_write(text, tags, opts)
  ├─ 长度/空白校验（fail-loud）
  ├─ tokenize(text) → token 集
  ├─ 对同 scope 既有记录算 Jaccard（可选 cosine）
  │    ├─ max ≥ threshold 且未 force → 返回 DedupeHit[]，不写入
  │    └─ 否则/force → INSERT memories + memories_fts（同事务）
  └─ 返回 {record, dedupeHits}
```
