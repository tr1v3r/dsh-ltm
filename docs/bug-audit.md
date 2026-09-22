# dsh-ltm Bug 审计报告

> 项目：`@tr1v3r/dsh-ltm` 0.1.0（DeepSeek Harness 长期记忆插件）
> 范围：只读审计现有代码的隐藏缺陷、正确性/边界/并发/注入/资源泄漏/安全（秘密回显）问题。
> 基线（审计前已核）：`pnpm typecheck` 通过、`pnpm test` 69/69 通过、`pnpm build` 可产 `dist`。
> 方法：4 名审计员分片（数据层 / 检索·分词·去重 / 迁移·过期·配置 / 工具·提示词·CLI·插件面）独立审计，
> 全部发现以 `node:sqlite` 原句探针或运行时复现实证；本报告由 captain 合并去重、交叉验证并按严重度排序。
> 标记：**已确认** = 有探针/运行时复现或直接代码路径证明；**疑似** = 静态分析推断，未构造复现。
> 未改动任何 `src/`。既有 69 个测试仍全绿——下列均为测试套件未覆盖的**隐藏**缺陷。

---

## 摘要

| 严重度 | 数量 | 条目 |
|---|---|---|
| Blocker | 0 | —（无真实 SQL 注入、无秘密写日志、无数据损坏路径） |
| **High** | **5** | H-1 重排丢弃 BM25；H-2 标签过滤 LIKE 通配符泄漏；H-3 提示词转义簇状绕过；H-4 预算优先级倒置丢 pinned；H-5 CLI `--db=PATH` 静默失效 |
| Medium | 8 | M-1..M-8（并发/资源/契约/数据安全边界） |
| Low | 12 | L-1..L-12（一致性/健壮性/性能/国际化） |
| Info/正面 | 6 | 设计正确、防误报的核验点 |

**总体评价**：无 blocker、无真实注入或秘密泄漏，核心事务原子性与句柄幂等设计良好。
但有 5 处 High：其中 3 处直接破坏需求规格与契约中声明的核心承诺——R3 混合重排（H-1 实际退化为纯余弦）、
R9 提示词注入防护（H-3 簇状花括号绕过）、R9「宁丢 recent 不丢 pinned」（H-4 实际相反），
另 2 处是正确性假阳性（H-2）与数据安全（H-5 读写错库）。建议优先修复 5 个 High。

---

## High

### H-1 — 混合重排静默丢弃 BM25 分量，退化为纯余弦（R3 失效）· 已确认
- **位置**：`src/search.ts:88-91`（`rerankResults`），契约 `src/contracts.ts:50-54`（`SearchResult.ftsRank` 「lower = better」）。
- **问题**：FTS5 `rank`(bm25) 列恒为**负值**，越相关越负（captain 探针实测：最佳 `-3.28e-6`，最差 `-2.06e-6`，全部 `< 0`）。
  代码 `maxRank = Math.max(...ftsRank)` 取到的是「最不负 = 最差匹配」，
  归一化 `bm25norm = hits.length===1 ? 1 : (maxRank>0 ? 1 - ftsRank/maxRank : 1)`。
  因 `maxRank` 恒 `< 0`，守卫 `maxRank > 0` **永远为假** → 每条 `bm25norm` 恒等于 `1` →
  `BM25_WEIGHT(0.6) * bm25norm` 变成常数，最终排序完全由 `0.4 * 余弦` 决定。
  声称的 60/40 混排实际为 **0% BM25 / 100% 余弦**，FTS 层的核心相关度信号被丢弃。
- **复现**：任意返回 ≥2 条候选的 `search()`；测试未暴露因未断言多候选精确 BM25 顺序。
- **⚠️ 修复陷阱**：不能只删 `maxRank>0` 守卫——那会踩负号 bug（最佳匹配 `ftsRank/maxRank>1` → `bm25norm` 变负，排序反转）。
- **修复方向**：按「rank 为负、越小越好」归一化：对候选集内 rank 做 min-max 使**最佳→1、最差→0**
  （如 `bm25norm = (r - maxRank) / (minRank - maxRank)`，`minRank` 最负、`maxRank` 最不负），或先取 `-rank` 再归一化。
  SQL 层 `ORDER BY memories_fts.rank` + LIMIT 的候选集选取本身正确，仅最终返回顺序受损。

### H-2 — `list()` 标签过滤 LIKE 通配符泄漏，返回错误行（正确性假阳性）· 已确认
- **位置**：`src/store.ts:258-263`（标签过滤 `(' ' || tags || ' ') LIKE ?`），配合 `src/tokenize.ts` `normalizeTags`（保留 `_`）。
- **问题**：标签用 `LIKE '% tag %'` 匹配，但 `tag` 中的 `_` / `%` 是 LIKE 元字符且**无 `ESCAPE` 子句**。
  含下划线的标签很常见（`build_tool`、`vim_mode`）；`_` 作为单字符通配符会误命中其它标签。
- **复现**（captain 探针，vitest）：写入 `build_tool` / `build-tool` / `buildXtool` 三条，
  `list({ tags: ["build_tool"] })` 返回 **3 条**（预期 1 条）——`_` 匹配了 `-` 和 `X`。
- **修复方向**：转义模式中的 `\ % _`（`replace(/[\\%_]/g, "\\$&")`）并加 `ESCAPE '\\'`；或改整词精确匹配（如 FTS/等值 join）。

### H-3 — `escapeForPrompt` 对簇状/奇数长度定界符留残余 raw `{{`（R9 注入防护绕过）· 已确认
- **位置**：`src/config.ts:39-49`（`escapeForPrompt` / `escapeSequence` + `replaceAll`），经 `src/prompt.ts:38-41` `promptLine` 渲染进系统提示。
- **问题**：`replaceAll("{{", "{\u200b{")` 是**非重叠**从左到右替换，奇数个连续 `{` 会剩下一个未拆的 `{{`。
- **复现**（captain 探针，已确认）：
  - `"{{{"` → `"{​{{"` — **仍含 `{{`**
  - `"{{{ .var }}}"` → `"{​{{ .var }}}"` — **仍含 `{{`**（一段可执行 chezmoi/handlebars 模板）
  - `"{{{{"` → `"{​{{​{"` — **仍含 `{{`**
  - `"{{"` → `"{​{"` — 正确（2 个时才对）
  用户粘贴的含 3+ 连续 `{` 的记忆文本会带着活的 `{{ … }}` 模板序列进入 recall 系统提示——正是审计基线中 R9 要拦的注入。
- **修复方向**：循环转义至不再含 raw 序列，或用 `/\{(?=\{)/g` 式对每个前导字符插零宽空格，或按序列 split 后 rejoin。补 3/4/5 花括号与内嵌 run 的测试。
- **交叉验证**：本条被 t3（迁移·配置审计）与 t4（surface 审计）**独立同时命中**，证据一致。

### H-4 — 提示词预算循环丢弃 PINNED、保留较小 RECENT（R9 优先级倒置）· 已确认
- **位置**：`src/prompt.ts:77-85`（`renderPrompt`）。
- **问题**：预算超限时循环用 `continue` 而非 `break`。记录按 pinned 优先排列，
  但一条超预算的**大 pinned 行被跳过**，后面较小的 recent 行仍被 push。
  与 R9 及函数自身注释「budget too small … keeps what the deployment explicitly marked as always-relevant … drop recent, never pinned」**完全相反**；pinned 块内部也会倒置（大 pinned[0] 丢、小 pinned[1] 留）。
- **复现**（captain 探针，已确认）：`promptMaxChars:2000`，records = `[{id:1,pinned:true,text:"P"×1990}, {id:2,pinned:false,text:"short recent"}]`
  → 输出**含 `#2`（recent）、不含 `#1`（pinned）**，尾部 `(1 more memories not shown)`。既有测试只覆盖小 pinned + 大 recent，掩盖了本 bug。
- **修复方向**：先为 pinned 预留预算全渲染，再用剩余预算填 recent；或至少一旦丢弃任一 pinned 就停止再发 recent。
  可考虑对超长单条 pinned 带标记截断以保证其出现（与 M-1 一并处理）。

### H-5 — CLI `--db=PATH`（等号形式）被静默忽略，回退默认库（数据安全）· 已确认
- **位置**：`src/cli.ts:82-101`（`parseArgv`）。
- **问题**：仅识别独立 token 的 `--db <path>`（`arg === "--db"`）。`--db=/tmp/x.db` 命中 `arg.startsWith("--")` 分支落入 `boolFlags`，
  `parsed.db` 仍为 `undefined` → `runCli` 回退 `defaultDbPath()`（`~/.config/dsh/memory/ltm.db`）。
- **复现**（代码路径已确认）：`dsh-ltm --db=/tmp/x.db list` 读**默认库**、`/tmp/x.db` 从不创建，且无任何告警。
  用户以为在操作指定库，实际读写生产默认库——数据安全隐患。
- **修复方向**：解析 `--flag=value` 等号形式（含 `--db=`、`--json=` 无意义时报错），或对未知 `--x=` 显式报错而非静默吞。

---

## Medium

### M-1 — 单条超预算 pinned 使整个 recall 段返回 `""`（always-relevant 事实消失）· 已确认
`src/prompt.ts:73-89`。若唯一/首条 pinned 就超 `promptMaxChars`，`lines` 为空 → `renderPrompt` 返回 `""`，
整节消失，模型看不到任何 always-relevant 记忆。修复：保证至少渲染 pinned（必要时截断并标记）。与 H-4 同源，建议合并修。

### M-2 — search/list 渲染合成 record 写 `lastConfirmedAt: 0`，每行恒 stale（R5 信号损坏）· 已确认
`src/index.ts:186-198`（search render）及 list 投影路径。渲染 `promptLine` 时构造合成对象注入 `lastConfirmedAt: 0`（1970），
`isStale` 恒为真 → 模型看到的**每条 search/list 行都误带 `stale` 标记**，破坏 R5 的「按 stale 提示复核」语义。
`SearchResult` 本已带真实 `lastConfirmedAt`；应传真值（list 的 execute 投影若丢了该字段需加回）。

### M-3 — 去重检查在写事务外的 TOCTOU（并发下 R4 护栏失效）· 疑似
`src/store.ts:152-166`（`write`）、`199-206`（`insertMigrated`）。`findDuplicates` 读发生在 `BEGIN IMMEDIATE` 事务**之外**。
插件默认全机共享单库（`dshHomePath('memory/ltm.db')`）；两个进程/会话并发写近似内容时，各自 dedupe 读都在写事务前完成 → 双写。
修复：把 dedupe 读纳入同一 `BEGIN IMMEDIATE` 事务，或写后在事务内复核。单进程场景不触发，故列 Medium。

### M-4 — 构造函数 `ensureSchema` 抛错时 SQLite 句柄泄漏· 疑似
`src/store.ts:92-96` + `src/schema.ts:63-66`。构造函数先 `new DatabaseSync(...)` 再 `ensureSchema`；后者在 schema 版本过高/DDL 失败时抛错，
`#db` 已打开却从不 `close()` → 连接与 WAL 锁泄漏，共享单库下拖累其它进程。修复：`ensureSchema` 包 try/catch，出错先 `close()` 再抛。

### M-5 — 无 `SQLITE_BUSY` 退避重试；`confirm` 未包事务· 疑似
`src/store.ts:104-118`（`#transaction`）、`329-343`（`confirm`）。对端持锁超过 `busy_timeout(5s)` 时 `SQLITE_BUSY` 直接冒泡给工具调用者，无重试；
`confirm` 的多语句路径未包在 `#transaction` 内。共享库高并发下偶发失败。修复：对 BUSY 做有界退避重试，`confirm` 纳入事务。

### M-6 — `serializers.search` 输出 9 字段 vs 注册 schema 声明 4 字段（契约漂移）· 已确认
`src/tools.ts:254-261` 返回 `id,text,tags,scope,pinned,createdAt,updatedAt,lastConfirmedAt,score` 共 9 字段，
但 `src/index.ts` 注册的 output schema 只声明 4 字段 + `additionalProperties:false`；harness 校验器实测不强制 `additionalProperties`（故未报错），
结果未承诺字段（含 `scope`/时间戳）进模型，契约不准。`memory_list` 的 execute 已正确收窄为 4 字段，仅 search 不一致。修复：收窄 search execute 或放宽 schema 并保持一致。

### M-7 — CLI value flag 无条件吞掉下一个 argv（`--json` 被当值吃掉）· 已确认
`src/cli.ts:90-93`。`--text/--tags/--limit/--file/--source/--out/--scope` 无条件 `argv[++i]`。
`edit 1 --text --json` → `text` 存成字符串 `"--json"`、丢失 JSON 模式、exit 0。修复：吞入值若以 `--` 开头则报错。

### M-8 — 配置默认与库默认漂移：`dedupeCosineThreshold` 插件 0.92 vs 库 1（OFF）· 已确认
`src/config.ts:67` 默认 `0.92`（余弦去重**开**），`src/store.ts:49` `DEFAULT_STORE_OPTIONS` 为 `1`（**关**）。
作为插件运行时 config 值胜出（开），直接用 `MemoryStore` 库默认时关。同一「默认」在两种入口行为不同，易误判去重表现。
修复：单一事实源（库默认对齐 0.92，或文档明确两者差异）。

---

## Low

- **L-1** `src/cli.ts:347-373` `import` 只读 `text/tags/scope/pinned` 且 force 重写 → 新 id、时间戳全为 `now()`，丢弃导入数据的 `id/createdAt/lastConfirmedAt`（重置 R5、破坏 id 引用）。`export` 侧本已含这些字段，纯 import 侧丢失；cli 测试只断言 `imported===3` 掩盖。修复：走 `store.insertMigrated` 的保时间戳路径。· 已确认
- **L-2** `src/store.ts:284-293` `forPrompt` 用两次独立查询（pinned + recent）拼接，非一致性快照；并发写入下两段可能不自洽。· 疑似
- **L-3** `src/schema.ts:51-69` 迁移为桩；`DDL + 版本戳`未包在事务内；损坏版本串 `parseInt` → `NaN`，`!Number.isInteger(NaN)` 命中「newer than supported」误导性报错（实为损坏，非版本过高）。· 已确认
- **L-4** `src/store.ts` 每次 `write` 对同 scope 全量 `list()` 再逐条分词做去重（`findDuplicates` 默认 `limit=-1`）；大 scope 下写入 O(N·分词)，迁移整体 O(n²)。性能非正确性。· 已确认
- **L-5** `src/tokenize.ts` 仅覆盖 ASCII-Latin+数字+下划线 与 CJK/假名；带变音符拉丁文（é/ü/ñ）、西里尔/希腊/阿拉伯/泰文/谚文等整片脚本产生**零 token** → 该类文本写入后 FTS 检索不到、dedupe（jaccard 空集恒 0）也测不出重复。文档仅声明「故意排除谚文」，实际影响面更大。中英自用场景影响小，故 Low（国际化工具视角可升 Medium）。· 已确认
- **L-6** `src/tokenize.ts` + `src/schema.ts:38-41` 双重分词：应用层先切空格分隔 bigram 流，FTS5 再用 `unicode61` 二次分词。目前自洽（写入/查询同路径），但写入侧 `ftsValue` 与查询侧 `compileMatch` 必须永远用同一 tokenizer；任一侧或 `tokenize=` 选项单独改动会静默 desync 致检索全空。建议用注释/测试固化此不变量。· 已确认
- **L-7** `src/dedupe.ts` `jaccard` 在任一 token 集为空时返回 0 → 两条零-token 文本（纯 emoji/纯未覆盖脚本，见 L-5）即便完全相同也永不判重。· 已确认
- **L-8** `src/search.ts:36` `compileMatch` 用 ` OR ` 连接全部 token，任一 bigram 命中即召回（召回优先，靠重排排序）；叠加 H-1（BM25 被丢）后精度全靠余弦，噪声候选更易靠前。修好 H-1 后缓解。· 已确认
- **L-9** `src/search.ts:44-60` `ngramCounts` 用 n=2..3，长度 <2 的串产生空 map → 余弦恒 0；单个 CJK 字/单字符查询余弦无区分度，此时排序仅剩被丢弃的 BM25（见 H-1）。修好 H-1 后 BM25 兜底。· 已确认
- **L-10** `src/tools.ts:60-72` `requireText` 硬编码 `"memory_write:"` 前缀，被 `memory_update` 复用 → 错误信息把 update 错标成 write。· 已确认
- **L-11** `src/cli.ts:300-319` / `src/store.ts:345` 坏 source id 抛 `memory merge: source #N does not exist` 走外层裸 catch，`--json` 模式**不发 `{error}`**；仅坏 target 走友好分支。另 `confirm` 对不存在 id 返回 exit 0（`confirmed 0`），与 show/edit/tag/pin 的 exit 1 不一致。· 已确认
- **L-12** `src/index.ts:316-319` `Number(args.id)` 接受 `0x10`/`1e3`/空串(→0)/`"1.0"`/`" 5 "` 等非规范输入；`src/prompt.ts:52-58` 重复实现了一份 `isStale`（与 `src/expire.ts:14` 逻辑相同、常量 `86_400_000` 硬编码），应复用 `expire.ts` 避免二处漂移。· 已确认

---

## Info / 正面核验（防下游误报）

- **I-1 无真实 SQL 注入**：所有 SQL 全参数化（`prepare` + `?`）；FTS5 MATCH 的每个 token 都被引号化，操作符字面匹配（`tokenize` 测试已证不产出裸操作符）。
- **I-2 事务原子性正确**：`#transaction` 用 `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK`，异常路径回滚经实证；FTS 与主表三路（insert/update/delete + merge/forget）同步覆盖完整，`confirm` 不动 FTS 亦正确。
- **I-3 句柄生命周期健康**：`store` 建于 `ctx.effect`，disposer 调 `close()` 并置空；工具/分节经 fiber-scoped `open()` Proxy，dispose 后 fail-loud（`ltm: store is not open`）；`close()`/`dispose()` 幂等（`store.ts:401-410`）。无泄漏（H-4 泄漏例外，仅构造期异常路径）。
- **I-4 插件挂载正确**：`cordis.patch.yml` 用 `- insert:` 声明 `ltm` entry（非顶层 `- id:` 定位），entry 会真正加载。
- **I-5 无多字节中间截断**：`renderPrompt` 按整行丢弃、从不切片，不会切断 CJK/emoji 多字节字符。
- **I-6 无秘密写日志**：surface 各文件 grep 无 `console`/logger 写记忆内容；`presentCall` 的 `rawInput` 是用户自身动作在 UI 卡展示，非日志。需求规格 §4.5「不写日志」成立。类型层面 `count`/`.changes`/`RETURNING` 返回 JS number 非 BigInt。

---

## 建议修复顺序

1. **H-1**（重排丢 BM25，注意负号陷阱）、**H-3**（转义簇状绕过，安全）、**H-4**（预算倒置丢 pinned，含 M-1）——三处破坏需求规格中的核心承诺，优先。
2. **H-2**（标签 LIKE 转义）、**H-5**（CLI `--db=` 解析，数据安全）。
3. Medium：M-2（stale 误标）、M-6（契约收窄）、M-7（value flag 吞 `--json`）、M-8（默认漂移）优先；M-3/M-4/M-5（并发/资源）按共享库使用强度决定。
4. Low 批量清理（L-1 保时间戳、L-3 损坏版本报错、L-10/L-11/L-12 一致性）。

> 每处修复建议附对应回归测试（尤其 H-1 多候选 BM25 顺序、H-3 奇数花括号、H-4 大 pinned + 小 recent、H-2 含下划线标签），
> 以固化当前测试未覆盖的边界。
