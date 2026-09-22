# CableTidy 安装与分发决策

决策日期：2026-09-21。初始研究基于提交 `9256804`，在 `research/installable-package` 分支实施。

## 决策与当前状态

采用 Node.js CLI 的 npm 包，同时支持同一产物的 `.tgz` 安装。现有应用由 Node.js HTTP 服务和静态管理台组成，没有前端构建步骤；用户数据独立于安装目录，因此无需引入 Electron、打包器或重写服务。

安装、运行、升级、卸载及验证命令统一以 [README](../README.md#安装与运行) 为准。主发布渠道为 npm 官方源 `https://registry.npmjs.org/`，包名为 `cabletidy`；本地 tarball 继续作为同一产物的安装方式。首版 `cabletidy@0.1.0` 已于 2026-09-21 公开发布，`latest` 指向 `0.1.0`。

CLI 只提供 `start`、`status`、帮助和版本查询。`status` 只读；尚无配置时仅报告未启动，不创建数据文件或生成 URL，已有配置时汇总 daemon 状态、管理台 URL 和配置套装列表。配置校验仍在服务启动和管理台保存时执行；客户端配置预览和应用由管理台负责，不再提供单独的调试命令或临时客户端启动命令。

当前服务以前台方式运行。安装与后台常驻分开交付，npm 安装过程不会启动服务、注册系统服务或修改客户端配置。

## 包边界与运行约束

- `bin/cabletidy.mjs` 是 npm 命令入口；源码启动入口和 CLI 均调用 `startDaemon()`，共用启动和信号退出逻辑。
- `files` 白名单包含 `bin/`、`src/`、`web/`；npm 自动纳入包元数据、README 和存在的许可文件。测试、研究文档和用户数据不进入发行包。
- 服务根据模块位置定位 Web 资源，必须保留 `src/` 与 `web/` 的相对结构。`web/config-identity.js` 同时被服务端导入，不能只分发服务端源码。
- 数据默认位于 `~/.cabletidy`，也可通过 `CABLETIDY_HOME` 指定。升级替换程序后需要重启；卸载保留数据及已应用的客户端配置。
- `start` 首次收到 SIGINT / SIGTERM 时停止接受新连接，等待请求、子进程和配置写入完成，再清理运行状态；不设置退出倒计时。等待期间再次收到 SIGINT 则终止目录查询子进程并以退出码 130 强制退出。
- 首次启动且尚无配置时，优先使用 `127.0.0.1:43100`；占用则由系统分配可用端口，监听成功后保存。后续启动复用已保存端口，占用时明确报错，因为客户端接入地址必须稳定。同一数据目录通过带持有者 PID 和启动标识的实例锁阻止重复启动；异常锁只有在确认原进程已退出且至少 10 秒未更新时才回收，暂停中的旧进程不会被误接管。
- Codex 可选模型设置依赖本机 Codex CLI 及其 `PATH`。CableTidy 安装包不附带 Codex，也不以它作为纯透传配置的启动前提。
- 当前是可执行应用，没有对外承诺 JavaScript 库接口，因此无需添加 `main` 或 `exports`。

推荐 Node.js 24，版本约束为 `^22.13.0 || >=24`。锁文件中的 TOML 解析依赖要求 `^20.19.0 || ^22.13.0 || >=24`，因此不能宣称支持 Node 18 或 Node 22.0；首版主动不纳入 Node 20，以控制维护范围。

`package-lock.json` 用于仓库内 `npm ci`，不会自动锁定消费者的传递依赖。当前沿用正常依赖范围，并测试实际 tarball 安装。只有完全固定消费者依赖成为明确需求时，再考虑 `npm-shrinkwrap.json`。

`.tgz` 不等于完全离线安装：仍需要本机 Node.js，以及未缓存的 npm 依赖。完全离线交付需要另行包含依赖和运行时。

## 分发方式的取舍

| 方式 | 适用情况 | 决策与重新评估条件 |
| --- | --- | --- |
| npm 官方 registry | 已有 Node.js 的 CLI 用户 | 主要发布渠道；已发布 `0.1.0`，采用 MIT 许可 |
| npm tarball | 内测、固定版本、未发布 registry | 已支持，与 registry 共用包结构 |
| Git URL / 固定提交 | 开发者试用 | 依赖 Git 和仓库权限，不作为普通用户主路径 |
| Node 运行时与应用压缩包 | 不希望预装 Node.js、需要离线交付 | 出现明确需求时优先评估；需维护 OS/CPU 产物和依赖 |
| Node SEA / Bun 单文件 | 下载单个可执行程序 | 后续独立验证 ESM、静态资源、依赖和子进程行为，当前不承诺可用 |
| Homebrew / Scoop | 系统包管理器用户 | 有需求后包装既有产物，另行维护版本和校验和 |
| Docker | 隔离服务部署 | 不作为本地 CLI 集成首选；需要解决回环监听、本机 Codex、配置路径和 PID 边界 |

Docker 不能只添加 Dockerfile 就宣称完整支持：容器回环地址与宿主机不同，普通端口映射无法直接暴露容器内的 loopback 监听；容器也无法直接使用宿主机 Codex 和默认配置目录。改变监听范围属于独立设计，需要保留现有本地访问边界并重新验证。

## 验证证据与边界

初始研究用临时源码副本生成 tarball，在隔离前缀安装后删除该副本，再从无关目录运行，验证了应用不依赖源码工作目录。原型同时验证了静态资源、状态查询、退出清理、npm exec 和卸载保留数据。其临时路径、包大小和一次性命令输出不作为长期验收依据。

初次封装曾在 Linux 的 Node 22.13.0、24.21.0、25.6.0 验证源码测试和安装流程；这些结果仅对应当时的实现。后续 CLI 收敛后，以当前源码执行以下检查作为验收：

- `npm test`：配置、路由、客户端配置生成和应用、管理台及 CLI 的回归测试；Linux 上覆盖长请求收尾、客户端断开后的任务、再次 Ctrl+C 强制退出及目录查询子进程清理。
- `npm run test:package`：实际 tarball 的隔离安装、跨工作目录运行、Web 资源内容、状态与 URL、端口冲突、SIGINT / SIGTERM、npm exec、卸载保留数据。
- 安装测试保留独立 `CODEX_HOME` 并检查它未被创建，以隔离真实客户端目录并验证服务启动不会应用客户端配置。

2026-09-21 首版发布在 Linux / Node.js 25.6.0 上通过 136 项源码测试、安装冒烟测试与发布预演。正式发布后，确认官方源的版本、`latest` 标签和 tarball 校验值，并使用独立 npm 配置、全新缓存及临时安装目录，从官方源按包名安装 `cabletidy@0.1.0`。验证覆盖 CLI 版本与帮助、Web 资源、状态查询、端口冲突、SIGINT / SIGTERM、按包名运行 `npm exec`，以及卸载保留用户数据。

Windows 的安装测试目前不会验证信号生命周期或直接执行 cmd shim；macOS、Windows、真实上游和系统服务仍需各自验收。Linux 检查通过不代表这些边界已经验证。

初始 HTTP 探测曾受环境代理影响；手工验证脚本对回环请求绕过代理后通过。部署验证应注意回环请求的代理配置，不据此改变应用的访问边界。

## npm 官方源发布流程

`package.json` 的 `publishConfig` 将发布目标设为 npm 官方源，并将访问级别设为 `public`。仓库地址取自 Git origin：`https://github.com/ZY-WANG-0304/cabletidy`。经维护者确认采用 MIT 许可，根目录 `LICENSE` 随包分发。交互式发布前，应在 npm 账号设置中启用双因素验证（2FA），并在 npm 提示时完成本次发布的浏览器身份验证；登录成功本身不代表满足发布认证要求。

从仓库根目录执行：

```bash
npm ci
npm publish --dry-run --registry=https://registry.npmjs.org/
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/
```

`prepublishOnly` 在发布及发布预演时自动运行源码测试与安装冒烟测试；任一失败会阻止发布。预演成功只验证本地检查和打包流程，不验证账号发布权限或包名可用性。实际发布需要完成 npm 要求的身份验证。此钩子不会在用户安装包时执行。

发布成功后，确认官方源记录与 CLI 版本：

```bash
npm view cabletidy@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
npm exec --yes --registry=https://registry.npmjs.org/ --package=cabletidy@0.1.0 -- cabletidy --version
```

首版为 `0.1.0`，后续发布必须递增版本号，并对应更新锁文件；同名同版本不能覆盖发布。当前平台验收范围仍为 Linux，不将 npm 发布成功视为 macOS 或 Windows 已验证。

## 尚未实施的服务管理

后台常驻优先使用平台原有的用户级进程管理：Linux systemd user service、macOS LaunchAgent，Windows 另行评估任务计划程序或服务。若增加服务管理命令，应仅在用户主动执行时注册，并解决：

- Node 和包入口的稳定路径，以及版本管理器升级带来的路径变化。
- 服务的 `CABLETIDY_HOME` 和包含 Codex 的 `PATH`，不假设继承交互 shell 环境。
- 重复启动、崩溃重启、日志轮转，以及升级后的重启。
- 流式请求收尾、手动强制退出、原子写入与实例归属判断。
- 登录启动与开机启动的区别，以及服务卸载后的状态。

简单的 nohup、PID 文件和 kill 不足以构成跨平台服务管理。`runtime.json` 用于发现和探测实例，不能作为长期有效的进程身份凭证。
