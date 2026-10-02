# 维护者发布流程

发布使用 GitHub Actions 生成的五平台完整 npm 包。候选版进入 `next`，正式版进入 `latest`；tag 工作流在构建和验证通过后自动创建 GitHub Release，但不自动向 npm 发布。下面以 `0.3.0-rc.1` 和 `0.3.0` 为例，版本号按实际发布替换。

## 1. 准备发布提交

在发布分支完成变更和发布说明，说明新增行为、Node / 平台要求、配置迁移、已知限制及用户升级步骤。同步更新 README 中对应版本的“尚未发布”描述。

```bash
npm version 0.3.0-rc.1 --no-git-tag-version
```

同步修改 `Cargo.toml` 的 `[package].version`，执行 `cargo check` 更新 `Cargo.lock`，检查差异，避免夹带无关依赖升级。然后验证：

```bash
npm ci
npm run check:version
cargo fmt --check
cargo clippy --locked --all-targets --features test-support -- -D warnings
npm test
npm run test:package
```

提交并推送变更。给该提交打 tag：

```bash
git tag -a v0.3.0-rc.1 -m "Release 0.3.0-rc.1"
git push origin v0.3.0-rc.1
```

`Build Native Package` 会针对 tag 指向的同一个提交先执行完整测试矩阵，再构建和验证五平台发行包。版本文件或 tag 不一致会失败。手动构建分支也支持，但不会创建 GitHub Release；正式发布应使用匹配版本 tag 的成功构建。

安装包验证通过后，工作流自动创建对应 tag 的 GitHub Release，附上 `package.tgz`、`SHA256SUMS` 和 `release.json`。包含预发布后缀的版本（如 `0.3.0-rc.1`）标记为 Pre-release，不设为 Latest。正文优先使用 `docs/releases/<版本>.md`，缺少时使用 GitHub 自动生成的变更说明；正文同时说明 npm 发布是独立步骤。GitHub Release 创建成功不代表 npm 已发布。

## 2. 核对并发布候选包

从该 tag 的 GitHub Release 下载三个附件，或从成功运行下载 `cabletidy-npm-package` artifact 并解压，然后进入目录。核对 `release.json` 的版本、提交 SHA、ref 和运行 ID 与 Actions 页面一致；确认所有检查通过。

```bash
sha256sum -c SHA256SUMS
# macOS 可用 shasum -a 256 -c SHA256SUMS。
# Windows 可用 Get-FileHash package.tgz -Algorithm SHA256 核对摘要。
npm login --registry=https://registry.npmjs.org/
npm publish ./package.tgz --tag next --access public --registry=https://registry.npmjs.org/
npm view cabletidy@0.3.0-rc.1 version dist.integrity --registry=https://registry.npmjs.org/
npm view cabletidy dist-tags --registry=https://registry.npmjs.org/
```

registry 的 `dist.integrity` 应与 `release.json` 相同，`next` 应指向候选版本，`latest` 应仍是原稳定版。直接发布下载的 tarball，不重新本地构建或打包。

## 3. 验收候选版

每次验收记录操作系统、架构、Node 版本、旧版与候选版版本号、客户端版本和结果。使用全新 npm 缓存按版本从官方源安装，避免本地包掩盖分发问题。

- 全新安装：验证版本、首次启动、管理台静态资源、配置创建、重复启动、停止和重新启动。
- 从 `0.2.0` 升级：先停止旧服务，备份完整 CableTidy 数据目录以及 Codex / Claude 配置目录。在隔离目录的副本上检查已有配置、密钥、模型设置、地址和客户端应用行为；测试客户端也指向隔离配置目录。
- 客户端接入：验证 Codex / Claude 的普通与流式请求、模型透传或映射、配置预览、应用和支持的撤销行为。真实上游测试使用专门的测试凭据和请求。
- 安全审计：验证请求记录、风险详情、正文查看、筛选及重启后的持久化；确认未命中规则时的展示符合说明。
- 生命周期：验证后台启动、请求排空、停止、重启；Windows 额外手动验证真实终端 Ctrl+C。
- 恢复演练：停止候选版，在隔离环境重新安装旧版本并恢复升级前备份，验证服务和客户端配置可恢复。

备份包含密钥和对话等敏感数据，应按原有权限保管。不要直接让旧版本读取已迁移的数据来代替恢复演练。验收结果和未解决问题写入发布说明；问题修复后发布新的候选版本，不能覆盖既有 npm 版本。

## 4. 发布正式版

候选版验收通过后，将四个版本文件同步更新为 `0.3.0`，完成正式发布说明并提交。为正式提交创建 `v0.3.0` tag，重新走完整构建和验证，下载并核对新的 artifact。正式包版本不同，需要重新生成。

```bash
npm publish ./package.tgz --tag latest --access public --registry=https://registry.npmjs.org/
npm view cabletidy@0.3.0 version dist.integrity --registry=https://registry.npmjs.org/
npm view cabletidy dist-tags --registry=https://registry.npmjs.org/
```

核对 integrity 和 `latest`，使用全新缓存按包名安装并验证版本、启动、管理台和停止。核对工作流已自动创建的 GitHub Release 及三个附件，按需补充 npm 发布后的验收结果和安装说明；保留附件文件名，以便直接校验 `SHA256SUMS`。

用户升级前停止服务，升级后重启。发布说明应明确哪些旧配置需要重新应用到客户端。

## 5. 失败与回退

构建或发布前检查失败时，修复后重新验证；已经公开的 tag 保留，后续修复使用新版本。npm 发布命令报错或超时后，先用 `npm view cabletidy@<版本>` 确认是否实际发布成功，再决定后续操作。

如果 GitHub Release 创建失败，Actions artifact 仍可下载。修复权限或网络问题后，可重跑失败的 release job；如果同名 Release 已存在，命令会失败而不会覆盖已有附件，应先核对现有 Release 和附件是否完整，再人工补齐。工作流仅为 release job 赋予 `contents: write`，使用内置 `GITHUB_TOKEN`，无需额外 PAT。

正式版有问题时优先发布修复版本。必要时，将 `latest` 指回已验证的稳定版本，并说明问题版本的限制，例如：

```bash
npm dist-tag add cabletidy@0.2.0 latest --registry=https://registry.npmjs.org/
npm deprecate cabletidy@0.3.0 "Known upgrade issue; see the release notes for recovery instructions." --registry=https://registry.npmjs.org/
```

这些命令仅在确认需要回退时执行。移动标签影响后续默认安装，不会自动降级现有用户。已经升级的用户应先停止服务，保留当前数据副本，再按经验证的恢复流程安装旧版本并恢复升级前的数据与客户端配置备份。不要把卸载重装等同于数据回滚。

后续可在 npm 配置 Trusted Publishing，通过 GitHub Actions OIDC 发布；在维护者配置好 npm 信任关系之前，继续手动发布已验证的 tarball。
