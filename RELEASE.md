# CCAPI 发版指南

本文档说明如何发布一个新版本，以便已安装 CCAPI 的用户通过内置 Updater 自动收到更新。

---

## 0. 一次性准备（首次发版前做一次即可）

### 0.1 生成签名密钥

Tauri Updater 要求用私钥签每个安装包，客户端用对应公钥校验。

```bash
# 生成 ccapi.key（私钥）与 ccapi.key.pub（公钥）
bun tauri signer generate -w ./ccapi.key
```

> ⚠️ `ccapi.key` 是私钥，**绝对不要提交到 Git**，也不要发到任何公共渠道。
> 它的副本最少留两份：本地一份 + 1Password / 密码管理器 一份。
> 弄丢的话所有已安装的客户端都收不到后续更新（只能让用户重装新版本）。

### 0.2 把公钥写进 `src-tauri/tauri.conf.json`

打开 `src-tauri/tauri.conf.json`，定位到 `plugins.updater.pubkey`，把 `ccapi.key.pub` 的整段内容粘进去（一行 base64 字符串），替换占位符 `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY`。

### 0.3 配置 GitHub 仓库 URL

在 `tauri.conf.json` 的 `plugins.updater.endpoints` 里把 `REPLACE_OWNER/REPLACE_REPO` 改成你真实的 GitHub 用户名 + 仓库名，例如：

```json
"endpoints": [
  "https://github.com/yourname/ccapi-releases/releases/latest/download/latest.json"
]
```

### 0.4 在 GitHub 上建仓库

1. 打开 https://github.com/new
2. Repository name: 比如 `ccapi-releases`（推荐用一个独立的"只放发布物"仓库）
3. Public（公开），不勾 README/License（保持为空）
4. Create repository

回到本地，把它接进来：

```bash
git remote add origin https://github.com/yourname/ccapi-releases.git
git push -u origin main
```

### 0.5 配置 GitHub Actions Secrets

打开仓库 → Settings → Secrets and variables → Actions，添加两个 Repository secret：

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `ccapi.key` 文件的**完整内容**（base64 字符串） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码（如果没设就留空字符串 `""`） |

---

## 1. 日常发版流程

### 1.1 改版本号

同步改这三个文件的 `version` 字段，保持一致：

```bash
# 1) package.json
# 2) src-tauri/Cargo.toml
# 3) src-tauri/tauri.conf.json
```

例如从 `0.1.0` 改到 `0.1.1`。

### 1.2 提交并打 tag

```bash
git add -A
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

### 1.3 等 Actions 跑完

push tag 会触发 `.github/workflows/release.yml`：

- Windows / macOS / Linux 三平台并行 build
- 自动调用 `tauri build` 生成安装包
- 自动用 Secret 中的私钥签名
- 自动上传到一个新的 GitHub Release（草稿状态）
- 自动生成 `latest.json`（updater 的 manifest）

### 1.4 写更新日志 + 发布

到仓库 Releases 页面 → 看到刚刚生成的 Draft，点 Edit：

- **Title**: `v0.1.1`
- **Body**: 写更新说明（支持 Markdown）。**这段会被 CCAPI 客户端弹窗里的"更新日志"原样显示**。例：

  ```markdown
  ## 🎉 新功能
  - 新增 Skills 管理
  - 智能体可配置沙箱级别

  ## 🐛 Bug 修复
  - 修复频繁切换 KEY 时的通知刷屏
  - 修复设置页顶栏拥挤

  ## ⚙️ 其它
  - 升级依赖
  ```

- 点 **Publish release**

发布后 1~2 分钟内，所有运行中的 CCAPI 在下一次启动检查时就会看到弹窗。

---

## 2. 手动发版（如果不想用 Actions）

```bash
# 1) 改版本号 → commit → tag → push (同 1.1、1.2)

# 2) 本地构建（私钥通过环境变量提供，Bash/zsh）
export TAURI_SIGNING_PRIVATE_KEY="$(cat ./ccapi.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
bun run tauri build

# Windows PowerShell:
# $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw ./ccapi.key
# $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
# bun run tauri build

# 3) 产物在 src-tauri/target/release/bundle/ 下
#    - msi/CCAPI_0.1.1_x64_en-US.msi
#    - msi/CCAPI_0.1.1_x64_en-US.msi.sig   ← 签名文件
#    - nsis/CCAPI_0.1.1_x64-setup.exe
#    - nsis/CCAPI_0.1.1_x64-setup.exe.sig

# 4) 手动写一个 latest.json（同名上传到 Release 根目录）：
```

`latest.json` 示例（Updater 期待的 JSON 结构）：

```json
{
  "version": "0.1.1",
  "notes": "更新日志正文（也可直接放 Markdown）",
  "pub_date": "2026-06-10T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件里的整段 base64>",
      "url": "https://github.com/yourname/ccapi-releases/releases/download/v0.1.1/CCAPI_0.1.1_x64-setup.exe"
    },
    "darwin-x86_64": {
      "signature": "<...>",
      "url": "https://github.com/yourname/ccapi-releases/releases/download/v0.1.1/CCAPI_0.1.1_universal.dmg"
    },
    "linux-x86_64": {
      "signature": "<...>",
      "url": "https://github.com/yourname/ccapi-releases/releases/download/v0.1.1/ccapi_0.1.1_amd64.AppImage"
    }
  }
}
```

把每个平台的安装包 + 对应的 `.sig` 文件 + `latest.json` 一起上传到这次 Release 的 Assets。

---

## 3. 常见问题

**Q: 如果"私有仓库"行不行？**
A: 客户端无法匿名访问私有 Release，必须带 `Authorization: Bearer <github_token>` 请求。这意味着 Token 需要内置到客户端二进制里，反编译就能拿到。**不推荐**。如果非要私有，建议改用 Cloudflare R2 / 阿里云 OSS 等存储，updater endpoint 指向那里的 `latest.json`。

**Q: 用户怎么收到提示的？**
A: 客户端启动 2.5 秒后会去拉 `latest.json`，发现版本号比自己大就弹窗。也可以在「设置 → 更新与启动 → 立即检查更新」手动触发。

**Q: 旧版本会留在硬盘上吗？**
A: 不会。Windows 的 NSIS / MSI 安装器会**就地升级**，自动覆盖旧文件、保留用户配置。macOS 的 `.app` 也是覆盖式。Linux AppImage 因为是单文件，新版本会直接替换。

**Q: 我能不能不传源码、只发 Release？**
A: 可以。这个 `ccapi-releases` 仓库就只用来托管 `Releases` 标签页的安装包。源码留在你本地或另一个**私有仓库**里都行。Updater 只读 Release Assets，跟仓库里是否有源代码无关。

**Q: 怎么回滚到旧版本？**
A: 在 GitHub Release 页把当前 Release 改成 "Pre-release" 或删除，最新的 Release 会自动指向上一个。客户端下次检查时看到的就是旧版本（但 updater **只升不降**，旧版本用户没法被强制降级）。

---

## 4. 紧急情况处置

- **不小心把 `ccapi.key` 提交了**：立刻 `git filter-repo` 或 `git rebase` 清掉历史 → force push → 同时把私钥作废，重新生成一对新的，公钥替换到 conf.json，下次发版生效（已安装的客户端将无法验证旧公钥签的更新——意味着这些用户必须手动下载新版本）。
- **`latest.json` 写错**：直接到 Release 页面替换文件，重新上传同名文件即可。
- **Actions 失败**：去 Actions 标签页看具体 step 报错，通常是 Secret 没配或私钥格式错。
