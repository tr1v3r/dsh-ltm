# dsh-ltm 数据模型（P0 定稿）

> 与 `src/contracts.ts` 同步冻结。新库独立路径 `$DSH_HOME/memory/ltm.db`。

## 1. Schema（SCHEMA_VERSION = 1）

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- meta.schema_version = '1'

CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  text             TEXT    NOT NULL,
  tags             TEXT    NOT NULL DEFAULT '',   -- 规范化：小写去重空格连接
  scope            TEXT    NOT NULL DEFAULT '',
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,             -- epoch ms
  updated_at       INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL
);

-- CJK 二元分词索引（detail=none, content 自持有；不用 external-content，
-- 因为 token 是自定义分词结果，需要重建能力）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, tags, scope,
  tokenize = 'unicode61'
);
-- 索引列存的是 tokenize() 产物（拉丁整词 + CJK bigram），写入/更新/删除
-- 与 memories 表同事务维护。
```

要点：

- FTS 虚表存**分词后文本**而非原文；原文只在 `memories.text`。检索 = 
  查询分词 → 全引号拼 MATCH → BM25 排序。
- WAL + `busy_timeout=5000`；所有写操作单事务包裹（含 FTS 同步）。
- `stale` 不是列：`last_confirmed_at + staleAfterDays*86400000 < now` 派生。

## 2. 迁移（旧 dsh-memory → 新库）

旧库（SCHEMA_VERSION=1, `memories(id,text,tags,pinned,created_at,updated_at)` +
external-content FTS）只读打开：

1. 复制文件到临时位置再打开（绝不在原文件上写）。
2. 逐行映射：`scope=''`、`last_confirmed_at=updated_at`、tags 沿用规范化。
3. 每行先过 dedupe（对已迁移内容），命中计入 `dedupedCount`。
4. 产出 `MigrationReport`（见 contracts.ts）；失败行记录 `{legacyId, reason}`。

## 3. 检索管线

```
query ─tokenize→ tokens ─全引号 MATCH→ FTS5/BM25 候选
      └─char n-gram(2..3) 向量 ──┐
                                 ├→ 混合 score = w·bm25norm + (1-w)·cosine
candidates ──rerank──────────────┘
```

- BM25 归一化：`1 - rank / max(rank)`（rank 越小越好）。
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
