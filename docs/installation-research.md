# CableTidy 安装与分发决策

更新日期：2026-09-26。2026-09-21 的初始方案为 Node.js CLI npm 包；本次 Rust 重构沿用 npm 命令体验，服务端改为原生程序。

## 当前决策

主要分发产物仍是 npm 包及同结构的 `.tgz`。包内包含 Node.js 薄启动器和预编译的 Rust 程序，没有 npm 运行时依赖，也没有安装时下载或编译步骤。独立 Rust 二进制同样可运行，不需要 Node.js。

npm 上已发布的 `0.1.0` / `0.2.0` 仍对应原 Node 实现；本次迁移不覆盖既有版本，也不自动发布。下一次发布前需要同步递增 `Cargo.toml`、`Cargo.lock`、`package.json` 和 `package-lock.json` 的应用版本。

CLI 继续提供 `start`、`stop`、`status`、帮助和版本查询。安装不启动服务、不注册系统服务、不修改客户端配置。用户数据独立于安装目录，继续使用 `config.json`、`secrets.json`、`runtime.json` 和 `daemon.lock/`；升级不要求转换为 TOML 或 OS keyring。

安装与使用命令以 [README](../README.md#安装与运行) 为准。

## 包边界

- `bin/cabletidy.mjs` / `bin/native.mjs` 选取当前 OS / CPU 的原生程序。安装后的 `start` 脱离终端，Rust 在持有实例锁后初始化日志，按写入量轮转 `daemon.log`：每个文件最多 10 MiB，保留三份历史文件，总量最多 40 MiB。启动器仅通过临时 stderr 管道接收启动错误，确认管理接口就绪后关闭该管道并返回；前台标准输出保持不变。源码和 `start --foreground` 使用私有标准输入管道传递退出信号，前台启动器退出后其原生子进程停止。
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

源码调试入口的 `start` 前台运行；安装包的 Node 启动器将 daemon 放到后台，Rust CLI 提供 `stop` 命令。`stop` 校验 PID 启动标识、主机名和锁代次，将停止请求写入数据目录的 `stop-<实例 UUID>.json`；daemon 每 100 ms 检查本代次请求，跨平台执行同一优雅退出流程。停止命令等待本代次锁释放，无排空超时；不对缓存 PID 直接发终止信号。 Ctrl+C 在停止请求原子发布前取消操作，不发送请求；发布后仅取消客户端等待，保留停止请求让 daemon 继续关闭。取消时退出码为 130，并提示是否已提交；SIGTERM 同样取消操作或等待，退出码为 143。停止时先停止接受新连接，等待流式请求、客户端断连后仍需完成的管理任务和配置写入，然后清理运行状态、释放实例锁。

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

CI 的 `Test` 工作流在 Linux、macOS、Windows 上运行 Node.js 22.13.0 / 24 的版本检查、格式检查、Clippy、测试及打包冒烟。`Build Native Package` 在同一个提交上复用完整 `Test` 工作流，通过后构建五个平台产物，并在对应架构的 runner 上对实际发行二进制执行安装冒烟；macOS x64 使用 `macos-15-intel`，arm64 使用 `macos-latest`。Windows 自动化覆盖私有管道触发的退出处理、npm `.cmd` 入口和 Job Object 后代清理；真实控制台 Ctrl+C 仍需交互验收。平台结果以该提交的 Actions 为准，Linux 本地测试不能替代这些结果。

安装了 Claude Code 时，`npm run test:claude` 用本地模拟上游验证真实 CLI 与 Rust daemon 的 JSON / SSE 接入，不调用真实模型服务。

## 发行包组装

本地先运行 `npm run build`，再运行 `npm pack`，生成当前平台测试包。`npm pack` 不执行构建，打包和发布钩子不会重新生成或覆盖已经组装的 `native/` 产物。

完整包由 `.github/workflows/native-package.yml` 在手动触发或版本 tag 后组装。完整测试通过后，各 runner 构建并验证目标二进制，汇总到 `native/`，校验版本和摘要，再生成最终 tarball。Linux 安装冒烟直接安装该 tarball，通过后上传 `cabletidy-npm-package` artifact。tag 构建随后自动创建 GitHub Release 并附上该 artifact 中的三个文件；候选版本标记为 Pre-release，分支构建不创建 Release。工作流没有 npm 发布步骤。

artifact 包含 `package.tgz`、`SHA256SUMS` 和 `release.json`。后者记录包版本、提交 SHA、GitHub ref、运行 ID、tarball SHA-256 和 npm SHA-512 integrity。它们用于核对产物来源和完整性，不是签名或 npm provenance；应从对应提交的可信 Actions 运行下载。

维护者下载各平台产物到 `native/` 后，也可以本地验证和打包：

```bash
npm run check:release
npm run test:package:built
npm run pack:release
CABLETIDY_PACKAGE_TARBALL=dist-release/package.tgz npm run test:package:built
```

`check:version` 无需二进制即可核对 `package.json`、`package-lock.json`（含根包条目）、`Cargo.toml` 和 `Cargo.lock` 中的应用版本；tag 构建还必须满足 `GITHUB_REF=refs/tags/v<版本>`。`check:release` 包含上述检查，并在缺少任一平台、编译目标不匹配、版本不一致或摘要不匹配时失败；Linux 发行产物必须声明 musl 目标，宿主 GNU 构建不能通过校验。`pack:release` 先执行完整产物检查，再打包到 `dist-release/` 并生成摘要。

从源码目录发布时，`prepublishOnly` 运行源码测试、完整平台校验和 `test:package:built`，安装冒烟直接使用已组装的二进制，不调用会覆盖当前平台产物的 `test:package`。发布现成 tarball 时不依赖源码目录中的生命周期钩子，应使用已通过 CI 验证的完整产物。

实际发布继续使用 npm 官方源和 MIT 许可，需维护者完成 npm 登录与发布认证；同版本不能覆盖发布。发布成功后确认 registry 的版本、`latest` 和 `dist.integrity`，再使用全新缓存执行按包名安装验证。

具体的候选版验收、发布命令与失败处理见 [维护者发布流程](release-process.md)。

## 后续服务管理

当前后台运行由安装包的 Node 启动器负责，尚未注册为系统服务或开机自启。`runtime.json` 用于发现与在线探测，不是可长期信任的进程身份凭据；未来若接入 Linux systemd user service、macOS LaunchAgent 或 Windows 服务，仍需单独处理崩溃恢复、升级重启、请求排空和卸载行为。
