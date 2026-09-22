# ADR-001：语义检索采用零网络混合重排（BM25 + char n-gram 余弦）

- 状态：已接受（0.1）
- 日期：2026-09-21
- 决策阶段：P0 规格阶段

## 背景

R3 要求语义检索，同时默认**零网络依赖**（不能用托管 embeddings）。
现役 dsh-memory 只有 FTS5 关键词检索，中文基本无效（unicode61 默认
tokenizer 把整句当一个 token）。

## 决策

0.1 的默认档 = CJK 感知分词的 BM25（FTS5 rank）+ **字符 n-gram（2–3）
余弦相似度**混合重排。CJK 连续文本同时索引逐字 unigram 和相邻 bigram：
unigram 支持单字查询，bigram 继续提供多字短语的精确召回。

```
normBM25 = (worstRank − rank) / (worstRank − bestRank)
score = w · normBM25 + (1 − w) · cosine(ngram(query), ngram(text)),  w = 0.6
```

FTS5 rank 越小越好且通常为负数；上述候选集内 min-max 公式将最佳结果
映射为 1、最差结果映射为 0，避免按正数处理负 rank 而把 BM25 分量全部退化为 1。
单候选或 rank 全相同时统一取 1。

理由：

1. 字符 n-gram 不需要词典与模型，对中文同义改写（「长久记忆」↔
   「跨会话记忆」共享 bigram 子串）有可测的召回改善。
2. BM25 提供精确关键词信号，余弦提供模糊语义信号，权重可配。
3. 实现自包含（~100 行），无第三方依赖，符合「零强制网络」。

## 备选方案

- **FTS5 trigram tokenizer**：SQLite ≥3.34 可用，但 Node 内置
  `node:sqlite` 的 FTS5 编译选项未保证启用 trigram；且 trigram 对
  短中文查询（<3 字符）失效。弃用。
- **本地 embeddings 模型**（如 transformers.js / onnxruntime）：推理
  依赖重（数十 MB）、首启慢，违背「极轻量」。作为 0.2+ 可选档，
  通过 `EmbeddingAdapter` 接口（contracts.ts 已冻结）接入。
- **纯 BM25**：无法覆盖同义改写，R3 验收不满足。

## 后果

- 检索质量上限受 n-gram 语义粒度限制；接受（个人自用规模 <10⁴ 条）。
- 每次检索多一轮内存向量计算，O(N·L)；在个人规模下 <10ms，可接受。
- 若 0.2 引入 embeddings，重排管线形状不变，只替换 cosine 项。
- token 格式是派生索引版本而非 SQL schema 版本；打开旧库发现
  `meta.fts_token_version` 缺失/过旧时，从 `memories` 原文在事务内重建 FTS，
  因而已有 bigram-only 数据无需人工迁移即可获得 unigram 召回。
