# dsh-ltm 入门图解

按以下顺序阅读：

1. `01-memory-collaboration.architecture.json`：跨会话记忆的用途，自动召回与主动搜索。
2. `02-write-search.architecture.json`：写入去重、中文索引、候选召回和排序。
3. `03-maintenance.lifecycle.json`：记忆复核周期、适用场景及能力边界。

这里只跟踪图的 JSON 源文件。独立 HTML、浏览器截图和本次交付回执是生成产物，由本目录 `.gitignore` 忽略；可作为发布附件或文档站产物分发。

## 生成与验证

本批图使用 **Archify 2.17.0-dev.1** 生成（工具 `package.json` 版本），需要 Node.js >=18。Archify 是外部工具，不属于本项目依赖；需自行准备对应版本。仅记录版本并不锁定工具字节，不保证其他构建生成相同的 HTML 哈希。

在仓库根目录执行，先将 `ARCHIFY_HOME` 指向本机 Archify 工具目录：

```bash
export ARCHIFY_HOME="/path/to/archify"

set -e
for name in 01-memory-collaboration 02-write-search 03-maintenance; do
  type=architecture
  if [ "$name" = 03-maintenance ]; then
    type=lifecycle
  fi
  spec="docs/diagrams/$name.$type.json"
  html="docs/diagrams/$name.html"

  node "$ARCHIFY_HOME/bin/archify.mjs" validate "$type" "$spec" --quality showcase --json
  node "$ARCHIFY_HOME/bin/archify.mjs" deliver "$type" "$spec" "$html" --quality showcase --json
  node "$ARCHIFY_HOME/bin/archify.mjs" visual-check "$html" --json
done
```

`deliver` 成功后可直接用浏览器打开生成的 HTML，无需启动服务。`visual-check` 需要可运行的 Chrome/Chromium，并生成截图和浏览器检查回执。

## 维护约定

- 修改 JSON 源文件，不直接编辑生成的 HTML。
- 保持图中说明与 `src/` 当前实现一致，尤其是 scope、去重、搜索和过期语义。
- 每次修改后重新验证、生成；showcase 应通过全部 9 项检查且无错误或警告。
- 浏览器检查与截图视觉复核分别进行：自动通过不代表布局已被人工或图像模型检查。
- 如需分发 HTML，使用当前源文件重新生成的版本；不要附带含本机绝对路径的交付回执。
