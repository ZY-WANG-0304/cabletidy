# CableTidy 安装与分发决策

更新日期：2026-09-25。2026-09-21 的初始方案为 Node.js CLI npm 包；本次 Rust 重构沿用 npm 命令体验，服务端改为原生程序。

## 当前决策

主要分发产物仍是 npm 包及同结构的 `.tgz`。包内包含 Node.js 薄启动器和预编译的 Rust 程序，没有 npm 运行时依赖，也没有安装时下载或编译步骤。独立 Rust 二进制同样可运行，不需要 Node.js。

npm 上已发布的 `0.1.0` / `0.2.0` 仍对应原 Node 实现；本次迁移不覆盖既有版本，也不自动发布。下一次发布前需要同步递增 `Cargo.toml`、`Cargo.lock`、`package.json` 和 `package-lock.json` 的应用版本。

CLI 继续提供 `start`、`status`、帮助和版本查询。安装不启动服务、不注册系统服务、不修改客户端配置。用户数据独立于安装目录，继续使用 `config.json`、`secrets.json`、`runtime.json` 和 `daemon.lock/`；升级不要求转换为 TOML 或 OS keyring。

安装与使用命令以 [README](../README.md#安装与运行) 为准。

## 包边界

- `bin/cabletidy.mjs` / `bin/native.mjs` 选取当前 OS / CPU 的原生程序，并通过私有标准输入管道传递退出信号。启动器退出后，原生子进程停止，避免留下失去管理的 daemon。
- npm 的 `files` 白名单只包含 `bin/`、`native/`，以及 npm 自动纳入的元数据、README 和许可证。源码、测试桥接程序、用户数据不进入发行包。
- Web 资源通过 Rust `include_bytes!` 在编译时嵌入，运行时无需查找源码或 Web 目录。
- `native/<平台>/build.json` 记录应用版本、编译目标和二进制 SHA-256，用于打包检查。
- npm 启动器沿用 `^22.13.0 || >=24` 的 Node.js 版本范围。用户安装 npm 包不需要 Rust；源码开发和维护者构建需要稳定版 Rust 及系统链接器。

| 平台目录 | 完整发行包编译目标 |
| --- | --- |
| `linux-x64` | `x86_64-unknown-linux-musl` |
| `linux-arm64` | `aarch64-unknown-linux-musl` |
| `darwin-x64` | `x86_64-apple-darwin` |
| `darwin-arm64` | `aarch64-apple-darwin` |
| `win32-x64` | `x86_64-pc-windows-msvc` |

Linux 完整发行产物使用 musl，减少宿主 glibc 版本差异。本地构建使用当前 Rust host target，也允许 Linux GNU target 显式构建。未提供的平台会明确报错，用户可自行从源码构建。

当前将各平台二进制放入同一包，优点是安装无需下载脚本、单一 tarball 可分发；代价是包包含当前机器用不到的二进制。暂不引入多个平台 npm 包、Homebrew / Scoop 或系统服务注册。

## 运行与升级语义

`start` 前台运行。首次 SIGINT / SIGTERM 停止接受新连接，等待流式请求、客户端断连后仍需完成的管理任务和配置写入，然后清理运行状态、释放实例锁；再次 SIGINT 清理 Codex 子进程并以 130 退出。

首次启动优先绑定 `127.0.0.1:43100`，占用则直接绑定系统分配的端口并保存；已有配置必须使用保存的端口。实例锁记录主机、PID 和平台启动标识，仅在锁超过 10 秒且确认原持有者死亡 / PID 复用时回收。未知归属给出人工恢复提示，不能只按 mtime 接管暂停的实例。

升级前停止服务，替换程序后重新启动。卸载保留用户数据及已应用的客户端配置，彻底停用前由用户切换客户端接入。Codex CLI 不随包分发，只在配置可选模型元数据时需要；纯透传配置不依赖它。

Windows 需要系统 Windows PowerShell。Codex 查询使用 `Add-Type` 和 Job Object 监督后代；在禁用该能力的 PowerShell 环境中会明确失败。

## 构建与验证

```bash
npm ci
npm run build:debug
cargo fmt --check
cargo clippy --locked --all-targets --features test-support -- -D warnings
npm test
npm run test:package
```

`npm test` 构建 feature-gated 测试程序，运行 Rust 单元测试，以及直接调用 Rust 的 JavaScript 契约、HTTP、CLI、生命周期和管理页测试。旧 Node 服务端不作为测试实现或发行依赖。原先模拟 Node 文件系统方法的故障测试已迁移为 Rust 文件系统重试、原子写入、进程身份和锁代次测试。

`npm run test:package` 构建 release 二进制，在临时前缀执行实际 tarball 安装，从无关工作目录验证 CLI、内嵌 Web 文件、状态、端口冲突、重启地址、退出和卸载保留数据。测试使用临时数据目录，不操作日常 Codex / Claude 配置。

CI 的 `Test` 工作流在 Linux、macOS、Windows 上运行 Node.js 22.13.0 / 24 的测试及打包冒烟。`Build Native Package` 工作流额外构建五个平台产物；macOS 两种架构由 Xcode SDK 编译，测试在工作流实际宿主架构上运行。Windows 自动化覆盖私有管道触发的退出处理、npm `.cmd` 入口和 Job Object 后代清理；真实控制台 Ctrl+C 仍需交互验收。平台结果以该提交的 Actions 为准，Linux 本地测试不能替代这些结果。

安装了 Claude Code 时，`npm run test:claude` 用本地模拟上游验证真实 CLI 与 Rust daemon 的 JSON / SSE 接入，不调用真实模型服务。

## 发行包组装

本地 `npm pack` 的 `prepack` 只构建当前平台，适合同平台测试，不作为跨平台正式发行物。

完整包由 `.github/workflows/native-package.yml` 在手动触发或版本 tag 后组装：各 runner 测试并构建目标二进制，汇总到 `native/`，校验版本和摘要，在 Linux 上对汇总包执行安装冒烟，最后上传 npm tarball。工作流没有 npm 发布步骤。

维护者下载各平台产物到 `native/` 后，也可以本地验证和打包：

```bash
npm run check:release
npm run test:package:built
npm pack --ignore-scripts
```

`check:release` 缺少任一平台、版本不一致或摘要不匹配时失败。`prepublishOnly` 先检查完整平台集合，再运行源码与安装测试，防止把只有当前机器二进制的包作为通用包发布。手动跳过 npm 生命周期钩子也会跳过该保护，维护者应发布已验证的完整产物。

实际发布继续使用 npm 官方源和 MIT 许可，需维护者完成 npm 登录与发布认证；同版本不能覆盖发布。发布成功后确认 registry 的版本、`latest` 和 `dist.integrity`，再使用全新缓存执行按包名安装验证。

## 后续服务管理

后台常驻优先评估平台用户级进程管理：Linux systemd user service、macOS LaunchAgent，以及 Windows 任务计划程序或服务。独立设计须处理原生程序稳定路径、数据目录与 Codex PATH、重复启动、崩溃恢复、升级重启、请求排空和卸载行为。`runtime.json` 用于发现与在线探测，不是可长期信任的进程身份凭据。
