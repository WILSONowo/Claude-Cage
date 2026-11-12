# Cage 工作台代码地图

本地验收分支 `feat/workbench-redesign` 基于 fork 的 `main` 提交 `53b7c13a`（v0.1.7）。下文保留改版前的代码地图与构建基线，方便对比。

## 新版入口与验收

- 桌面布局、控件间距和窄窗口规则在 [workbench-layout.css](../ui/src/workbench-layout.css)。[外观预设](../ui/src/appearance-presets.mjs) 定义新版默认配色，用户可以继续使用已有主题。
- [views.jsx](../ui/src/views.jsx) 负责按需加载[终端](../ui/src/terminal-pane.jsx)与[远程画面](../ui/src/remote-pane.jsx)。[桌面入口](../ui/src/desktop-entry.jsx) 在连接就绪后加载工作台。[手机入口](../ui/src/mobile-cli/main.jsx) 按需加载[聊天与消息渲染](../ui/src/mobile-cli/chat.jsx)。
- [验收预览脚本](../ui/scripts/installation-preview.mjs) 提供工作台、登录、初始化和手机的模拟数据。真实 Windows 桌面壳另外通过了 WebView2 与 Go 后端的原生桥自检。
- 同机 Chromium 冷页面各测 5 次，导航至工作台首页启动按钮出现的中位数从 418.5 ms 降至 131.2 ms，首页加载的解码后 JavaScript 从 1,269,544 字节降至 698,102 字节。真实客机启动、SSH 延迟和移动真机性能仍待测量。

## 基线架构：从窗口到客机

1. Windows 的 [MainWindow.cs](../desktop/windows/MainWindow.cs)、macOS 的 [Cage.swift](../desktop/Cage.swift) 和 Linux 的 [cage-desktop.c](../desktop/linux/cage-desktop.c) 分别托管 WebView2、WKWebView 和 WebKitGTK。原生壳负责加载工作台、窗口生命周期、菜单、文件选择和系统剪贴板等平台操作。涉及窗口边框、启动失败页和原生输入的设计需要分别检查三端。
2. Go 命令入口在 [cmd/cage/main.go](../cmd/cage/main.go)。[desktop_gateway.go](../internal/workbench/desktop_gateway.go) 管理本机和 SSH 目标连接，[server.go](../internal/workbench/server.go) 提供工作台服务并嵌入网页资产。桌面窗口打开本机入口，界面通过 HTTP、SSE 和 WebSocket 访问所选环境。
3. [desktop-entry.jsx](../ui/src/desktop-entry.jsx) 安装诊断边界、挂载连接选择组件 ClientRoot，再按需加载 [main.jsx](../ui/src/main.jsx)。这里协调账号与初始化、项目和侧栏、标签与分屏、终端、浏览器、Claude Desktop 和设置。阅读时可以从 App 的状态轮询、浏览器事件订阅、窗格渲染这三处入手。
4. [views.jsx](../ui/src/views.jsx) 中的 TerminalView 创建 xterm 和每会话的 WebSocket，RemoteView 把打过补丁的 noVNC 接到客机显示。macOS Claude 窗口另有 [macos-claude-window.jsx](../ui/src/macos-claude-window.jsx) 和专用帧连接。客机浏览器脚本在 [internal/cage](../internal/cage/)，平台显示、终端和工作台 HTTP 处理在 [internal/workbench](../internal/workbench/)。

## 完整 UI 涉及的目录

| 界面或能力 | 主要入口 | 改动影响 |
| --- | --- | --- |
| 桌面布局与交互 | [主工作台](../ui/src/main.jsx)、[侧栏](../ui/src/workspace-sidebar.jsx)、[窗格标题](../ui/src/pane-headers.jsx)、[设置](../ui/src/settings.jsx) | 涉及标签恢复、分屏、焦点、键盘操作和窗口隐藏后的资源释放。 |
| 主题与组件样式 | [style.css](../ui/src/style.css)、[AppearanceProvider](../ui/src/appearance.jsx)、[主题设置与变量](../ui/src/appearance-state.mjs) 及功能 CSS | 现有用户主题、终端配色、字体、深浅色和减弱动态效果都有数据来源。共用控件可先接入已有变量。 |
| 网络与原生桥 | [api.js](../ui/src/api.js)、[client-context.mjs](../ui/src/client-context.mjs)、[Agent 使用入口](../AGENT-USE.md) | 普通请求携带连接标识，流地址也绑定目标。切换连接、登录续期、账号锁定和原生菜单需要参与回归。外部 Agent 也消费工作台协议。 |
| 手机 | [mobile-cli/main.jsx](../ui/src/mobile-cli/main.jsx)、[手机画面与输入](../ui/src/mobile-cli/browser-session.mjs)、[mobile](../mobile/) | 会话、工具审批和远程画面有独立页面。Android/iOS 有各自宿主，[移动构建](../mobile/build-ui.mjs) 单独打包手机入口。 |
| 客机与配套页面 | [internal/cage](../internal/cage/)、[scripts/guest-os](../scripts/guest-os/)、[www](../www/) | 客机内部的浏览器行为、输入和平台组件需要沿客机链路定位。官网和用户文档由独立 Astro 项目构建。 |

## 已验证的构建基线

在 `ui` 下执行了 `npm ci`、`npm test`、`npm run lint` 和 `npm run build`。环境为 Node 24.19.0、npm 11.17.0，165 项测试通过，ESLint 通过，构建校验了 20 个前端资源。Windows 本次构建把已有 uv 所在目录加入进程 PATH，并设置了 `PYTHONUTF8=1`。

| Vite 生产构建产物 | 压缩代码体积 | gzip 估算 |
| --- | ---: | ---: |
| 工作台 main JS | 977.47 kB | 283.39 kB |
| 共用 client JS | 207.37 kB | 65.06 kB |
| 手机入口 mobile JS | 115.84 kB | 38.50 kB |

各行是单个构建块。桌面入口已经延迟加载工作台，进入工作台后仍会加载引用 xterm、noVNC 和设置页面的模块图。Vite 对 main 给出了大于 500 kB 的提示。首次交互时间还取决于原生壳、目标连接、JS 解析和会话初始化，需要分别计时。

[Vite 配置](../ui/vite.config.js) 将双入口输出到 `internal/workbench/web/`，[构建校验](../ui/scripts/verify-build.mjs) 生成资源哈希清单。改动应落到 `ui/src` 或构建脚本；noVNC 的 Cage 行为由 [补丁脚本](../internal/cage/novnc-patch.py) 在构建时生成。

## 重构顺序与性能测量

| 顺序 | 代码中的依据 | 实施前后的对照 |
| --- | --- | --- |
| 1. 分开测窗口启动和工作区加载 | 桌面入口和工作台已有独立加载边界；main 静态引用多项功能。 | 同机分别记录启动至连接选择可操作、选择目标至工作台可操作、首次打开终端和远程画面的耗时。按功能试拆设置、终端或远程显示，再核对首次打开这些功能的代价。 |
| 2. 拆分工作台状态与布局 | main.jsx 有 1,971 行。状态轮询完成后按任务运行、窗口可见、窗口隐藏分别等待 1.2、3、15 秒；就绪时还会读取终端列表。浏览器已有 SSE，初始化或事件流不可用时会补读标签快照。 | 在空闲、任务运行和窗口隐藏三种状态下，记录每分钟请求数与 React 提交次数。优先检查内容相同的快照是否引发整棵工作台更新。 |
| 3. 分开测后台会话和可见窗格 | 主视图会为每个终端标签挂载 TerminalView；各自持有 xterm、6,000 行回滚配置和 WebSocket。 | 固定输出速率对比 1、5、10 个终端时的内存、CPU 与切换时延。对任何延迟挂载或暂停绘制方案复测后台输出、回滚、重连、焦点和双窗格。 |
| 4. 独立测量各条画面链路 | 桌面 noVNC、macOS 窗口帧流、手机画面读取有不同实现。[Windows 显示链路](../internal/workbench/windows_display.go) 已按输入与画面变化调整请求节奏。 | 固定分辨率、缩放、客机和网络，分别测静止、连续滚动、中文输入、隐藏再恢复。记录输入至可见反馈的 p50/p95、帧间隔、CPU 与传输字节数。 |

改版可先迁移主题与共用控件，再迁移导航、设置和窗格布局，最后按各端实测调整终端与远程显示。每步复用现有 [UI 测试](../ui/package.json)、[原生桥测试](../scripts/windows-native-bridge.test.mjs)、[帧节奏测试](../internal/workbench/native_frame_pace_test.go) 和[三平台 CI](../.github/workflows/ci.yml)。本次验证覆盖前端测试、静态检查与生产构建；原生桌面、真实客机、手机配对及运行时性能尚待测量。
