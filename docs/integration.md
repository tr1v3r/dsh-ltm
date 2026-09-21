# P4 集成与发布准备（runbook）

> 状态：**只准备，不执行**。push 到 GitHub、npm publish、dotfiles 提交/推送、真实 boot
> 验证均需用户本人确认后手动执行。本文记录每一步的确切命令与验收标准。
> 产出日期：2026-09-21（P3 双评审 PASS 后）。

## 0. 前置事实核对（本任务实测）

- 仓库 `~/workspace/opensource/dsh-ltm`：`git init` 已有（分支 `main`、零提交）。
  已补 `.gitignore`（node_modules/dist/缓存）、`LICENSE`（MIT）、
  `.github/workflows/{ci,publish}.yml`、`packageManager: pnpm@11.21.0`、
  `repository` 字段。`pnpm install --frozen-lockfile` / `typecheck` / `test`（69 用例）
  / `build` 全绿，pack 内容断言本地验证通过。
- 两 profile 现状（dotfiles chezmoi source `~/.local/share/chezmoi/dot_config/dsh/profiles/`）：
  - `dsh-tui/package.json`：`dependencies["dsh-memory"]: "^0.1.0"`，`bundles` 含 `"dsh-memory"`。
  - `web/package.json`：同上（dependencies + bundles 都有 `dsh-memory`）。
  - **本地 pnpm patch 残留核对**：`web/patches/dsh-memory@0.1.0.patch` 在 live 目录是
    **悬空 symlink**（chezmoi source 里已不存在该文件）；`dsh-tui/patches/` 无 memory patch；
    两个 profile 的 `pnpm-workspace.yaml` **均无** `dsh-memory` 的 `patchedDependencies` 键，
    lockfile 也无 patched 段。⇒ 实际只需删掉 web 的悬空 symlink 并在两处确认无键即可。
- 旧库：`~/.config/dsh/memory/memory.db`（+ `-wal`/`-shm`），dsh-memory 写入路径
  `dshHomePath('memory/memory.db')`，两 profile 共享。
- 新库（本插件 cordis.patch.yml）：`dshHomePath('memory/ltm.db')`，独立路径，不动旧库。

## 1. GitHub 仓库与推送准备

```sh
cd ~/workspace/opensource/dsh-ltm
git add -A
git commit -m "feat: dsh-ltm 0.1.0 — structured long-term memory for DeepSeek Harness"
git remote add origin git@github.com:tr1v3r/dsh-ltm.git   # 已 init，若已有 remote 跳过
# ⚠️ 需用户确认后执行：
gh repo create tr1v3r/dsh-ltm --public --source . --remote origin --push
# 或：git push -u origin main
```

CI（参照 dsh-quote-followup 惯例，已写入仓库）：

- `.github/workflows/ci.yml`：push/PR 触发；Node 22/24 矩阵跑
  `pnpm install --frozen-lockfile && typecheck && test && build` + CLI 冒烟
  （`--help` + import/export 往返 + 中文 search 命中）；另设 pack job 断言 tarball
  文件白名单（dist/ 哈希 chunk 视为可替换）。
- `.github/workflows/publish.yml`：`workflow_dispatch` 输入 tag，tag 必须等于
  `v<package.json version>`；走 npm Trusted Publishing（OIDC + provenance，无存储 token）。
  一次性设置：npmjs.com 包设置 → Publishing access → 绑定本仓库 + `publish` workflow。

## 2. dotfiles 切换 dsh-memory → dsh-ltm

在 chezmoi source（`~/.local/share/chezmoi/dot_config/dsh/profiles/`）改，然后 `chezmoi apply`：

1. `dsh-tui/package.json` 与 `web/package.json`：
   - `dependencies`：删 `"dsh-memory": "^0.1.0"`，加 `"@tr1v3r/dsh-ltm": "^0.1.0"`（发布后）。
   - `dsh.profile.bundles`：列表里 `"dsh-memory"` → `"@tr1v3r/dsh-ltm"`。
2. 删本地 patch 残留：
   - live：`rm ~/.config/dsh/profiles/web/patches/dsh-memory@0.1.0.patch`（悬空 symlink）；
   - 确认两 profile 的 `pnpm-workspace.yaml` 无 `dsh-memory*` 的 `patchedDependencies` 键
     （当前实测没有；dsh-tui 的 dsh-tui 补丁键保留不动）。
3. `dsh-tui/dot_npmrc` 里关于 dsh-memory 404 的注释可顺手更新（dsh-ltm 同样走公共源）。
4. 安装（每个 profile 分别执行，注意是 runtime target 不是 chezmoi source）：

```sh
chezmoi apply
dsh plugin --profile dsh-tui install
dsh plugin --profile web install
```

5. 验证组合树（不 boot）：

```sh
dsh --profile dsh-tui --dump-config | tee /tmp/dump-tui.yaml
dsh --profile web --dump-config | tee /tmp/dump-web.yaml
grep -c 'entry ".*" not found' /tmp/dump-tui.yaml /tmp/dump-web.yaml   # 期望 0（既有 not found 也应为 0）
grep -n 'id: ltm' /tmp/dump-tui.yaml /tmp/dump-web.yaml                # 新 entry 在树中
grep -n 'dsh-memory' /tmp/dump-tui.yaml /tmp/dump-web.yaml             # 期望无
```

## 3. 数据迁移（备份先行）

前提：dsh-ltm 已在两 profile 挂载（新库路径自动创建），且旧库不再有写入
（dsh-memory 已从树中移除、dsh 进程已退出）。

```sh
# 0) 停止所有 dsh 进程（TUI/web），确保 wal 落盘
# 1) 备份
cp ~/.config/dsh/memory/memory.db ~/.config/dsh/memory/memory.db.bak-$(date +%Y%m%d)
cp ~/.config/dsh/memory/memory.db-wal ~/.config/dsh/memory/memory.db-wal.bak-$(date +%Y%m%d) 2>/dev/null || true
# 2) 迁移（CLI 只读打开旧库副本，原库不动）
dsh-ltm migrate ~/.config/dsh/memory/memory.db          # 默认目标 $DSH_HOME/memory/ltm.db
# 3) 验收
dsh-ltm list --limit 20
dsh-ltm list --pinned                                    # pinned 记录迁移后可见
dsh-ltm search "<某条中文记忆关键词>"                     # 中文可检索即 R2/R8 达成
sha256sum ~/.config/dsh/memory/memory.db*                # 与迁移前一致（只读佐证）
```

回滚：`rm ~/.config/dsh/memory/ltm.db*`，把 dotfiles 换回 `dsh-memory`，从备份恢复旧库即可。

## 4. 真实 boot 两 profile（--dump-config 不够，必须 import 插件）

```sh
# TUI：伪 TTY，渲染出横幅即通过
timeout 15 script -q /dev/null dsh --profile dsh-tui
# web：看监听 URL
dsh web   # 或 dsh --profile web，观察启动日志无插件 import 报错、能打开页面
```

验收：横幅/监听正常；会话里模型能列出 `memory_write/memory_search/memory_confirm/...`
七工具；`ltm:recall` 分节出现在系统提示词（可在会话日志 zstdcat 验证）；写一条→search
→confirm→forget 全链路。

## 5. npm 发布（需用户本人确认）

```sh
npm publish --provenance --access public --registry https://registry.npmjs.org
# 本机注意：~/.npmrc 默认指向 bnpm，需显式官方源；~/.npm 有 root 属主缓存时 --cache 指到临时目录。
# 或走 GitHub Actions publish.yml（tag 门控 + Trusted Publishing，推荐）。
```

发布后：dotfiles 依赖装的就是 npm 版；`minimumReleaseAgeExclude` 若 pnpm 因最小发布年龄
拒绝安装，把 `@tr1v3r/dsh-ltm@0.1.0` 加进对应 profile 的 `pnpm-workspace.yaml`。

## 6. 明确不做（本任务）

- 不 push、不 publish、不改 dotfiles 仓库、不 boot 真实 profile —— 全部留给用户确认。
