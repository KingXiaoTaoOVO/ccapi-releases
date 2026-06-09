# CCAPI · Claude Code 智能管家

CCAPI 是一款专为 Claude Code 设计的桌面端 API Key 智能管理工具。它通过内置的本地反向代理无缝接管 Claude Code 的请求出口，实现密钥的自动监控、轮换、失败重试；同时提供智能体（Agents）、技能（Skills）、MCP 服务、规则（Rules）等工作区资产的统一管理，并内置更新通道、运行日志、用量视图等运维能力。

- 桌面端框架：Tauri 2.0（Rust + WebView）
- 前端：React 19 + TypeScript 5.8 + Vite 7 + Tailwind 3 + Zustand 5 + GSAP 3
- 包管理：Bun
- 支持平台：Windows / macOS / Linux

---

## 目录

- [一、设计思路](#一设计思路)
- [二、功能总览](#二功能总览)
- [三、视图与交互](#三视图与交互)
  - [3.1 控制台 Dashboard](#31-控制台-dashboard)
  - [3.2 对话 Chat](#32-对话-chat)
  - [3.3 用量 Usage](#33-用量-usage)
  - [3.4 智能体 Agents](#34-智能体-agents)
  - [3.5 技能 Skills](#35-技能-skills)
  - [3.6 MCP 服务](#36-mcp-服务)
  - [3.7 规则 Rules](#37-规则-rules)
  - [3.8 任务 Tasks](#38-任务-tasks)
  - [3.9 日志 Logs](#39-日志-logs)
  - [3.10 设置 Settings](#310-设置-settings)
- [四、本地代理接管原理](#四本地代理接管原理)
- [五、自动轮换与监控](#五自动轮换与监控)
- [六、安全与隐私](#六安全与隐私)
- [七、自动更新与开机自启](#七自动更新与开机自启)
- [八、国际化与主题](#八国际化与主题)
- [九、技术栈与目录结构](#九技术栈与目录结构)
- [十、开发指南](#十开发指南)
- [十一、发版指南](#十一发版指南)
- [十二、未来路线图](#十二未来路线图)
- [十三、许可证](#十三许可证)

---

## 一、设计思路

Claude Code 官方 CLI 把 API 凭据写在 `~/.claude/settings.json` 里。第三方中转密钥或自建网关常见的痛点是：

1. 多账户切换繁琐，要手动改文件、重启会话
2. 切换时弹"Do you want to use this API key"确认框，无法静默生效
3. 第三方 KEY 落到磁盘容易泄漏
4. 限流 / 额度耗尽时没有故障转移
5. 找不到统一的运行日志，问题排查难

CCAPI 的解决方案是：

- **内置本地反向代理（127.0.0.1:55005）**：Claude Code 看到的只是本地端口 + 一个本应用生成的虚拟 Bearer Token，真实第三方 KEY 永远不写入 `~/.claude/settings.json`。
- **应用接管 KEY 的选择**：代理在转发时从内存池里挑一个健康的 KEY 注入到上游请求头，遇到 4xx/5xx 自动切换并重试。
- **零交互运行**：因为 Claude Code 只看到本地的虚拟凭据，启动时没有可疑变更，不会弹确认框。
- **统一可观测**：日志、用量、任务、对话全部在一个窗口里。

---

## 二、功能总览

| 模块 | 功能 |
|---|---|
| 工作区 / 控制台 | API Key CRUD、批量导入、状态分类、手动切换、批量删除 |
| 工作区 / 对话 | 与 Claude Code 直接对话；提问模式 / 执行模式；可挂载智能体 |
| 工作区 / 用量 | 累计转发、剩余额度、命中 Key 进度条、按 Key 排序 / 搜索 |
| 智能体中心 / 智能体 | 自定义系统提示词、模型、沙箱级别、审批策略、联网开关；关联 Skills / MCP / Rules |
| 智能体中心 / 技能 | 可复用提示词片段；标签分组；引用统计 |
| 智能体中心 / MCP | 注册外部 MCP 服务（stdio / HTTP / SSE） |
| 智能体中心 / 规则 | 全局 / 项目 / 个人三层约束 |
| 智能体中心 / 任务 | 智能体执行记录；状态机（排队 / 运行 / 成功 / 失败 / 取消） |
| 系统 / 日志 | 持久化日志；按级别 / 来源过滤；导出剪贴板；自动捕获浏览器异常和代理事件 |
| 系统 / 设置 | 轮换 / 监控 / 代理凭据 / 配置接管 / 备份 / 清理 / 更新 / 自启动 / 运行环境 |
| 全局 | 中英双语、三主题、GSAP 动画、系统托盘、桌面通知、自动更新 |

---

## 三、视图与交互

### 3.1 控制台 Dashboard

- 四张总览卡：密钥总数、正常可用、冷却 / 异常、剩余总额度
- 状态分组过滤（全部 / 正常可用 / 额度不足 / 冷却中 / 已禁用）
- 搜索框（名称 / 备注 / Key 子串）
- 顶部操作：顺序循环、轮换、检测全部、导出 JSON、批量导入、多选删除、添加
- 卡片：脱敏 Key、延迟、最近检测时间、启用开关、检测 / 设为当前 / 编辑 / 删除

#### 批量导入

支持四种来源：

- 粘贴文本（每行一个 KEY，或 `name,key,note` CSV 行，或 JSON 数组）
- 上传 `.txt / .csv / .json` 文件
- 剪贴板自动解析
- 智能识别官方 (`sk-ant-`) / 中转 (`fe_oa_`) / 通用三类格式

导入预览中可单条编辑、勾选、批量名称前缀、批量统一 API URL，再一次性提交。

### 3.2 对话 Chat

- 左侧会话列表（新建 / 删除 / 自动以首条消息生成标题 / 相对时间排序）
- 顶部上下文条：会话标题、模式切换（提问 / 执行）、智能体下拉、清空消息
- 中部消息流（用户 / 助手 / 系统三种角色泡泡，相对时间戳）
- 底部输入区，支持 Ctrl+Enter / Cmd+Enter 发送
- 提问消息会同时进入「任务」面板的队列；助手回复落地为本地记录

### 3.3 用量 Usage

- 四张总览：密钥总数、总额度、已用额度、剩余额度（命中 Key 信息内嵌副标题）
- 排序：按名称 / 按用量 / 按剩余
- 表格列：名称、状态、已用 / 总额、剩余、进度条（绿 / 黄 / 红）、延迟、最近检测
- 「刷新数据」按钮一键 `检测全部`
- 当所有 Key 都未查询到额度时显示提示卡，引导用户在设置中开启额度查询

### 3.4 智能体 Agents

支持自定义系统提示词、模型选择、沙箱等级（Read-only / Workspace Write / Full Access）、审批策略（每次询问 / 按需 / 不询问）、联网开关、关联 Skills / MCP / Rules（多选 checklist）。

每张卡片右下有两个快捷动作：

- 快速开启对话 → 跳转「对话」并预设此智能体
- 快速下发任务 → 入「任务」队列并切到面板

### 3.5 技能 Skills

可复用的提示词片段：

- 名称、简介、长文本提示词、标签（空格 / 逗号自动拆分去重）
- 启用开关
- 引用计数（被多少智能体引用）
- 删除时会从引用方的智能体里自动解除挂载

### 3.6 MCP 服务

注册三种传输协议：

- `stdio`：本地命令 + 参数 + 环境变量
- `http` / `sse`：URL

存储在本地配置中，可启用 / 禁用、统计引用、删除时同步从智能体解除。

### 3.7 规则 Rules

行为约束：全局 / 项目 / 个人三类范围。支持自然语言描述、启用开关、引用统计。

### 3.8 任务 Tasks

- 状态过滤条：全部 / 排队 / 运行 / 成功 / 失败
- 卡片显示：状态徽章、类型徽章、智能体、相对时间、提示词预览、结果摘要、完成时间
- 状态机操作：排队 → 运行 → 成功 / 失败，或随时取消
- 「在对话中查看」：把任务回放为一段对话
- 「清理已完成」：一键删掉所有终结态记录

### 3.9 日志 Logs

- 级别筛选：全部 / 信息 / 警告 / 错误（自带计数）
- 搜索：消息、来源、详情子串
- 复制全部：导出为剪贴板纯文本
- 清空全部：两次点击确认（防误操作）
- 自动捕获：代理转发失败、密钥状态变化、浏览器全局异常 / Promise 拒绝、更新检查 / 安装事件
- 容量限制：最多 500 条，超出自动丢弃最旧的

### 3.10 设置 Settings

| 区块 | 内容 |
|---|---|
| 轮换与监控 | 策略、额度阈值、超时、监控间隔、活跃 Key 巡检、桌面通知开关 + 测试 |
| 代理凭据 | 本地端口（含占用检测 / 应用新端口）、代理虚拟密钥（显示 / 隐藏 / 复制 / 重新生成） |
| 代理状态 | 累计转发、当前命中、池中密钥数、失败计数明细 |
| Claude Code 配置文件 | 当前 Key 脱敏 / 鉴权字段 / API URL / 重新读取 |
| 配置备份 | 立即备份、备份列表、一键恢复 |
| 更新与启动（本轮新增） | 当前版本、启动检查、自动安装、开机自启、立即检查 / 查看可用更新 |
| 默认连接 | API URL、鉴权方式、测试用模型 |
| 清理与重置 | 一键清空备份目录 / 日志缓存 |
| 运行环境 | Claude Code 安装路径 / 版本 / 安装方式 / 重新检测 |

---

## 四、本地代理接管原理

启动流程：

1. 应用启动时，Rust 端尝试在配置端口（默认 `55005`，可自定义）监听一个本地 HTTP 反向代理。
2. 端口被占用时弹错误吐司；用户可在「设置 → 代理凭据」改端口并触发应用新端口（自动重启代理）。
3. 应用首次写 `~/.claude/settings.json`：
   - `ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:<port>`
   - `ANTHROPIC_AUTH_TOKEN` 设为本应用生成的 `sk-ccapi-<48 字符>` 虚拟 Token
   - 原文件先备份到 `~/.claude/backups/`
4. Rust 端把 KEY 池（健康优先 + 当前活跃排首位）注入到代理。

请求转发时：

1. Claude Code 携带虚拟 Token 请求 `127.0.0.1:<port>`。
2. 代理验证 Token 后，从池中按当前轮换策略挑一个 KEY。
3. 改写上游 URL、注入 `Authorization` / `x-api-key`，转发到真实上游。
4. 拿到响应回写给 Claude Code。
5. 如果上游返回 4xx/5xx，触发 `proxy://switch` 事件，前端：
   - 把失败 KEY 标记成对应状态（冷却 / 失效）
   - 同时切到下一个健康 KEY 重发
   - 写一条日志

效果：

- Claude Code 整个会话过程中从未看到真实 KEY
- 切换瞬时完成，不需要重启会话
- 第三方 KEY 永远只存活在本应用的本地状态文件里

---

## 五、自动轮换与监控

三种轮换策略：

- `sequential` 顺序循环（按添加顺序）
- `quota` 剩余额度优先（额度查询接口可用时）
- `latency` 响应速度优先

两个监控线程：

- **全局监控**：每 N 秒检测所有启用的 KEY；并发上限 4；可关闭
- **活跃 KEY 快速巡检**：每 N 秒只检测当前生效那一个，遇到 401/403 立即换 KEY；可关闭

熔断保护（本轮新增）：

- 60 秒内连续 ≥ 5 个不同 KEY 全部失败且无任何成功 → 自动关闭 `autoRotate`，弹一条错误通知 + 日志；避免在上游整体故障时刷屏轮换。

冷却恢复：

- 每 10 秒扫描一次，冷却到期的 KEY 自动从 `cooling` 回到 `unknown` 等待下次检测。

通知去重（本轮新增）：

- 同一目标 KEY 的轮换通知 30 秒窗口内只弹一次
- 应用内吐司同屏最多 5 条，超出弹掉最旧
- 完全相同（tone + title + message）的吐司直接合并

---

## 六、安全与隐私

- 真实第三方 KEY 仅存在 `~/AppData/Roaming/CCAPI/state.json`（Windows）或 `~/Library/Application Support/com.tauri-app.ccapi/state.json`（macOS）等 OS 标准目录下，**永远不会**进入 `~/.claude/settings.json`。
- 写 Claude 配置前自动备份；如果用户禁用「写入前备份」，仍会在内存里保留原内容用于恢复。
- 应用所有持久化都是本地 JSON，没有任何遥测 / 上报。
- 自动更新走 GitHub Releases 公开 URL；安装包必须用 Tauri Signer 私钥签名，客户端用配置的公钥验签。

---

## 七、自动更新与开机自启

基于官方插件：

- `tauri-plugin-updater` 负责更新检查与签名校验
- `tauri-plugin-autostart` 负责开机自启
- `tauri-plugin-process` 负责安装后 `relaunch()`

配置位置：`src-tauri/tauri.conf.json` → `plugins.updater`：

```jsonc
{
  "active": true,
  "dialog": false,
  "pubkey": "<TAURI_SIGNER_PUBLIC_KEY>",
  "endpoints": [
    "https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
  ]
}
```

策略（默认值）：

- `autoCheckUpdate = true`：启动 2.5 秒后静默检查
- `autoInstallUpdate = false`：发现新版本后弹「更新弹窗」展示 Release body 作为 changelog，用户确认后下载安装
- `autostart = false`：默认不开机自启；切换时会跟操作系统真实状态对账

发版完整流程见仓库根目录的 `RELEASE.md`。

---

## 八、国际化与主题

i18n：

- 中文（默认）/ 英文
- `src/i18n/messages.ts` 是唯一翻译源；所有键中英文严格对称（CI 可校验）
- 切换按钮在主窗顶栏右侧，无须重启
- `t()` 同时提供给 React Hook (`useT`) 与命令式调用（store / service）

主题：

- 浅色 / 深色 / 跟随系统三种
- 切换走 GSAP 过渡，依赖 `prefers-reduced-motion` 自动降级
- CSS 变量 + Tailwind 3 自定义 token，主题色一处改全局生效
- 极简科技风：毛玻璃卡片、渐变边框、Aurora 背景

动画：

- 入场：`useEntrance`、`useStaggerChildren`
- 状态变化：`usePulse`
- 主题过渡：`useThemeTransition`
- 模态 / Toast 进出：GSAP 接管 transform + opacity

---

## 九、技术栈与目录结构

```
CCAPI/
├── src/
│   ├── components/
│   │   ├── BrandLogo.tsx
│   │   ├── ImportModal/         批量导入
│   │   ├── InstallGuide/        未检测到 Claude Code 时的引导
│   │   ├── KeyCard/             单个 Key 卡片
│   │   ├── KeyForm/             新增 / 编辑表单
│   │   ├── LanguageToggle.tsx
│   │   ├── Onboarding/          首次启动
│   │   ├── SeamlessToggle.tsx   代理状态胶囊
│   │   ├── StatusBadge/         状态徽章
│   │   ├── ThemeToggle/
│   │   ├── Toast/
│   │   ├── TrayMenu/            托盘窗口
│   │   ├── UpdateModal/         更新弹窗（本轮）
│   │   ├── ui/                  Button / Modal / Select / Switch / TextField / Spinner
│   │   ├── layout/              Sidebar / TopBar / AuroraBackground
│   │   └── workspace/           WorkspacePage / EmptyState / EntityCard（本轮）
│   ├── views/
│   │   ├── Dashboard.tsx
│   │   ├── Chat.tsx             （本轮）
│   │   ├── Usage.tsx            （本轮）
│   │   ├── Agents.tsx           （本轮）
│   │   ├── Skills.tsx           （本轮）
│   │   ├── McpServers.tsx       （本轮）
│   │   ├── Rules.tsx            （本轮）
│   │   ├── Tasks.tsx            （本轮）
│   │   ├── Logs.tsx             （本轮）
│   │   └── Settings.tsx
│   ├── hooks/
│   │   ├── useConfigFile.ts
│   │   └── useGSAPAnim.ts
│   ├── services/
│   │   ├── apiMonitor.ts        额度检测 / probe
│   │   ├── claudeInstall.ts     环境探测
│   │   ├── configManager.ts     ~/.claude/settings.json 接管
│   │   ├── importParser.ts      txt/csv/json 解析
│   │   ├── keyStore.ts          本地持久化
│   │   ├── notify.ts            统一通知
│   │   ├── tauri.ts             Rust 命令 / 事件的强类型 wrapper
│   │   └── updater.ts           Tauri Updater / Autostart wrapper（本轮）
│   ├── store/
│   │   ├── useAppStore.ts       核心 KEY / 代理 / 配置状态
│   │   ├── useWorkspaceStore.ts Skills / MCP / Rules / Agents / Tasks / Chats / Logs（本轮）
│   │   ├── useUpdateStore.ts    更新 phase / progress（本轮）
│   │   ├── useThemeStore.ts
│   │   └── useToastStore.ts     吐司队列 + 去重 + 上限（本轮强化）
│   ├── i18n/
│   │   ├── index.ts
│   │   └── messages.ts          中英双语
│   ├── lib/
│   │   ├── cn.ts                Tailwind class 合并
│   │   ├── defaults.ts          默认设置 + 版本号 + 校验
│   │   ├── format.ts            脱敏 / 时间 / 持续时长
│   │   ├── rotation.ts          策略 pickNext / pickBest
│   │   └── status.ts            状态元信息
│   ├── styles/
│   ├── types/
│   │   └── index.ts             所有共享类型
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs               插件注册 / setup / invoke 列表
│   │   ├── main.rs
│   │   ├── proxy.rs             本地反向代理（Axum + Tokio）
│   │   ├── monitor.rs           上游探测
│   │   ├── quota.rs             额度查询
│   │   ├── config.rs            settings.json 接管 / 备份
│   │   ├── installer.rs         一键安装 Claude Code
│   │   ├── env_detect.rs        环境探测
│   │   ├── tray.rs              系统托盘
│   │   ├── notify.rs            桌面通知
│   │   ├── storage.rs           应用状态持久化
│   │   ├── appid.rs             Windows AUMID
│   │   ├── paths.rs / fsio.rs / sys.rs / models.rs
│   ├── capabilities/
│   │   ├── default.json         主窗权限
│   │   └── tray-menu.json
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .github/
│   └── workflows/
│       └── release.yml          三平台 CI（本轮）
├── .gitignore
├── RELEASE.md                   发版手册（本轮）
├── README.md
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
└── vite.config.ts
```

核心依赖（已在 `package.json` / `Cargo.toml` 中固定）：

- 前端运行时：`@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-autostart`, `@tauri-apps/plugin-process`, `@tauri-apps/plugin-updater`
- UI：`react`, `react-dom`, `clsx`, `tailwindcss`, `gsap`, `lucide-react`, `zustand`
- 后端：`tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-notification`, `tauri-plugin-updater`, `tauri-plugin-autostart`, `tauri-plugin-process`, `axum`, `tokio`, `reqwest`, `serde`, `chrono`, `regex`, `dirs`

---

## 十、开发指南

### 前置环境

- Node 不需要；项目使用 **Bun** 作为包管理 + Vite 运行时
- Rust toolchain (`rustup` 装 stable)
- Tauri 2 系统依赖（macOS / Linux 需要 WebView 相关库，参考 Tauri 官方）

### 安装与运行

```bash
bun install                 # 安装前端 + Tauri 插件 JS 包
bun run tauri dev           # 开发模式（含 Rust 自动重编译）
bun run dev                 # 仅前端（连不上 Rust 命令，调样式用）
```

### 类型检查与构建

```bash
bunx tsc --noEmit           # 全量类型检查
bunx vite build             # 前端打包（产物到 dist/）
bun run tauri build         # 三平台原生安装包（macOS / Win / Linux）
```

### 代码规范

- 严格 TS：`strict: true`；所有共享类型集中在 `src/types/index.ts`
- 状态管理：业务状态在 store；组件只渲染
- GSAP：通过 `hooks/useGSAPAnim.ts` 提供 `useEntrance / useStaggerChildren / usePulse`，组件内不写裸 `gsap.to(...)`
- 异步副作用：统一封装到 `services/`
- i18n：所有用户可见字符串必须走 `t(key)` / `useT()`；新增键必须中英文同时补
- 错误：业务侧用 `toast.error()` 反馈；致命异常通过 `console.error` + 全局 `window.onerror` 钩子自动写日志

---

## 十一、发版指南

完整流程详见 `RELEASE.md`。最简版：

```bash
# 1. 改同步的三处版本号: package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
# 2. 提交并打 tag
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
# 3. GitHub Actions 自动跑三平台 build → 在 Releases 页面建草稿 → 你编辑 body 写更新日志 → Publish
```

首次发版前要做：

1. `bun tauri signer generate -w ./ccapi.key` 生成签名密钥
2. 把公钥粘进 `tauri.conf.json` 的 `pubkey`
3. 把端点 `endpoints` 中的 `REPLACE_OWNER/REPLACE_REPO` 改成你的 GitHub `<owner>/<repo>`
4. 在 GitHub 仓库 → Settings → Secrets 添加 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
5. `git remote add origin ...` → `git push -u origin main`

---

## 十二、未来路线图

| 项 | 状态 |
|---|---|
| 直接读写 `~/.claude/skills/` 目录与 markdown 文件，实现与官方 Skills 系统的双向同步 | 待开发 |
| MCP 公共注册表搜索 + 一键安装 / 卸载 | 待开发 |
| 智能体真正调用 Claude API（当前 Chat 视图为本地记录，已为后端接入预留接口） | 待开发 |
| 多语言扩展（日 / 韩 / 法 / 德 等） | 待开发 |
| 设置数据库迁移（state.json → SQLite）以支持更大规模日志和会话历史 | 待开发 |
| Linux ARM64 / macOS 原生二进制 CI | 待开发 |

---

## 十三、许可证

本仓库默认不附带许可证。需要发布到公开仓库时请按需补 `LICENSE` 文件（建议 MIT 或 Apache 2.0）。
