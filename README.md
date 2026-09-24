# CableTidy

CableTidy 是一个不依赖桌面 GUI 的本地 coding CLI gateway。它在本机运行一个 daemon 和一个 Web 管理台，为 Claude Code、Codex 以及其他编程 CLI 提供各自原生的本地接入服务。

CableTidy 的核心不是“提供一个统一 OpenAI API”，而是把复杂度留在本地控制面：

- 管理多个上游代理、账号、协议和能力差异。
- 为不同 CLI 暴露多个 Virtual Provider，每个服务使用目标 CLI 熟悉的 wire protocol。
- 默认透传客户端请求的模型名；按需配置模型改名、能力和 context window，reasoning effort 由 CLI 请求选择。
- 由内部 Route 把一个本地 Virtual Provider 连接到对应的上游和模型绑定。
- 让 Codex 或 Claude Code 连接本地 endpoint，并保留客户端选择的模型名。

项目使用 Node.js 实现，使用 `toml-eslint-parser` 按语法树增量修改 Codex 配置。

## 模型透传与可选设置

每份配置默认将客户端请求的 `model` 原样发送到唯一上游，无需注册模型或填写同名映射。未配置的模型、工具和输入类型由上游判断是否支持；协议兼容不代表上游支持所有模型。

需要改名或覆盖上下文等参数时，才添加模型设置。上游模型 ID 可留空，留空时继续使用请求中的模型名。设置只在当前配置内生效，不会影响其他配置，也不会阻止未配置的模型请求。请求未携带模型且没有显式默认模型时，返回 `model_required`。

Codex 的可选模型设置目前只支持与本机官方 GPT 目录明确对应的模型，允许上游使用不同的模型名称：

- 客户端默认保留对应的官方模型名，例如 `gpt-5.5`；CableTidy 将它映射为上游要求的模型名，不要求用户另外设置别名。
- 模型提示词和行为配置沿用对应的 Codex 官方模型定义，不用其他 GPT 模型冒充，也不提供自研的通用中性提示词。
- 模型身份对应不代表上游能力完整；仍需确认实际支持的工具、输入类型和上下文限制。
- 不对应 Codex 官方 GPT 模型的接入与适配推迟到后续版本，当前不提供相关配置向导或兼容性承诺。

可选设置中的模型选择来自本机 `codex debug models --bundled`，不维护静态模型名白名单。新增或修改 Codex 模型设置、预览和应用含模型设置的配置时，会检查官方目录匹配；纯透传配置不依赖该目录。旧配置可继续加载和运行，不会自动改名或删除。目录匹配不等于上游模型身份认证，仍需依据上游接入说明确认，连通性测试不能证明模型身份或完整兼容性。

仅模型名称不同且元数据一致时，不生成额外目录。显式覆盖上下文窗口或输入类型时，CableTidy 生成 `model_catalog_json` 并保留对应官方模型的完整指令、模板变量、reasoning 选项和工具配置。当前不实现逐模型 compact 策略同步，旧 compact 数据保留但不生效。

## 安装与运行

推荐 Node.js 24，也支持 Node.js 22.13 及以上的 22.x 版本；完整版本约束见 `package.json`。CI 在 Linux、macOS 和 Windows 上执行源码测试与安装冒烟测试，平台验证结果以对应提交的 CI 为准。Windows 使用系统自带的 Windows PowerShell 查询进程身份；Codex 模型目录查询还需要允许 PowerShell `Add-Type` 调用 Windows Job Object API。

### 从 npm 官方源安装

```bash
npm install -g cabletidy --registry=https://registry.npmjs.org/
cabletidy --version
cabletidy start
```

也可以不做全局安装，直接运行：

```bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=cabletidy -- cabletidy start
```

### 从本地安装包使用

拿到 `.tgz` 安装包后，无需 clone 仓库即可安装：

```bash
npm install -g /absolute/path/cabletidy-0.1.0.tgz
cabletidy --version
cabletidy start
```

也可以不做全局安装，直接运行同一个安装包：

```bash
npm exec --yes --package=/absolute/path/cabletidy-0.1.0.tgz -- cabletidy start
```

安装包仍依赖本机 Node.js；npm 会下载尚未缓存的运行时依赖，因此 `.tgz` 本身不代表完全离线安装。安装过程不会启动服务或修改客户端配置。

### 启动、升级与卸载

`cabletidy start` 在前台运行，打印管理台地址；按 Ctrl+C 或收到 SIGTERM 后停止接受新连接，等待已开始的请求、子进程和配置写入完成，再清理 `runtime.json` 并退出，不设置退出倒计时。等待期间再次按 Ctrl+C 会强制退出，退出码为 130；此时可能保留过期的 `runtime.json`，状态检查会检测服务是否仍在线。当前不包含后台常驻或开机自启。

在另一个终端可以运行：

```bash
cabletidy --help
cabletidy status
```

`status` 同时显示 daemon 是否在线、管理台 URL、配置版本和当前配置套装列表；每套配置包含 ID、名称、目标 CLI、本地接入 URL 和启用状态，不再需要单独的 URL 或 Web 状态命令。
`status` 和不带参数的命令只读取状态，不创建数据目录、配置、密钥或备份。尚未初始化时，只提示未启动以及运行 `cabletidy start`，不返回预设的管理台地址。

升级时先停止服务，再安装最新版本并重新启动：

```bash
npm install -g cabletidy@latest --registry=https://registry.npmjs.org/
cabletidy start
```

从本地安装包升级时，将安装目标换成新版本 `.tgz`。卸载使用 `npm uninstall -g cabletidy`，不会删除 `~/.cabletidy` 或撤销已应用的客户端配置；彻底停用前应先把客户端切换到其他接入。

### 从源码运行与打包

```bash
npm ci
npm start

# 生成可安装的 cabletidy-0.1.0.tgz。
npm pack
```

`npm start` 与 `cabletidy start` 使用相同的启动和退出逻辑。源码用户也可以通过 `node bin/cabletidy.mjs --help` 调用完整 CLI。

验证源码和安装产物：

```bash
npm test
npm run test:package
```

安装冒烟测试会在临时目录打包、安装、启动和卸载，验证安装后的 CLI、Web 资源、重复启动、重启地址及用户数据保留；需要能够获取 npm 依赖。Linux / macOS 验证 SIGINT / SIGTERM；Windows 直接执行 npm 的 `.cmd` 入口，验证强制终止后的旧锁恢复。Windows 的退出处理逻辑通过测试 IPC 触发验证，真实终端 Ctrl+C 的事件投递仍需交互验收。分发方案的取舍、维护者发布流程与后续服务管理设计见 [安装与分发决策](https://github.com/ZY-WANG-0304/cabletidy/blob/main/docs/installation-research.md)。

使用 Codex 可选模型设置时，本机需要可执行支持 `debug models --bundled` 的 Codex CLI，daemon 的 `PATH` 必须包含它。目录读取失败不会阻止纯透传配置的创建、代理启动、预览或应用，但会阻止新增模型设置或应用包含模型设置的 Codex 接入；管理台可在更新 Codex 后刷新模型列表。已在 Codex 0.154.0 验证目录加载和实际请求。

管理台默认只监听本机回环地址。启动后可从 `cabletidy status` 输出中取得地址。

默认数据目录为 `~/.cabletidy`。如需启动一个临时实例：

```bash
CABLETIDY_HOME="$PWD/.cabletidy-dev" cabletidy start
```

源码运行时，将命令末尾的 `cabletidy start` 换成 `npm start`。

首次执行 `start` 且数据目录中没有 `config.json` 时，先尝试监听 `127.0.0.1:43100`；若端口已被占用，则直接由操作系统分配空闲端口。监听成功后将实际端口保存到 `config.json` 的 `web.port`，后续启动复用该端口。多人共用服务器时，各用户的数据目录独立，首次启动会自动避开已占用端口。

已有配置中的端口（包括手动指定的端口）被占用时，启动会明确报错，不会自动更换。可以停止占用端口的服务，或修改 `web.port` 后重启，并重新应用客户端配置。实际地址以启动输出或 `cabletidy status` 为准。

同一份数据目录只允许运行一个实例，启动和退出清理期间均持有 `daemon.lock`。锁记录主机名、持有者 PID 和进程启动标识：Linux 使用系统启动 ID 与进程启动时钟，macOS 使用 `ps` 的启动时间，Windows 使用 PowerShell 的 `StartTime`。正常退出或启动失败后释放；只有能识别锁的代次、确认原进程已退出或 PID 已被复用，且锁至少 10 秒未更新时才自动回收。被暂停的实例仍然持有锁，恢复后不会因锁被误回收而崩溃。

旧版本的空锁目录、缺少启动标识的存活 PID、进程查询不可用或来自另一主机的锁，可能无法确认归属。此时启动返回 `ELOCKUNKNOWN` 并列出锁目录路径；继续等待不会补全缺失信息。请检查并停止使用该数据目录的 CableTidy，确认没有运行中或暂停中的实例后，手动删除提示的 `daemon.lock` 目录并重新启动，保留 `config.json` 和 `secrets.json`。不要仅凭 `status` 离线就删除锁，暂停中的实例也可能无法响应探测。

Web 管理台与所有 Virtual Provider 共用最终分配的端口。以下示例假设端口为 `43100`；每份配置通过 `/<配置ID>/v1/...` 接入，例如 `http://127.0.0.1:43100/codex-main/v1/responses`；管理接口仍使用 `/api/v1/...`。

## Web 配置管理

管理台直接显示配置列表，首次使用与后续使用采用相同的操作流程，不设置介绍页或配置向导。点击“新建配置”填写：

- 目标 CLI：Codex 或 Claude Code。
- 配置名称（可选）；留空时按 `<CLI 名称> / <上游主机名>` 自动生成展示名称。
- 上游地址和 API Key。
- Claude Code 上游可选 `x-api-key` 或 `Authorization: Bearer` 认证。
- 模型设置（可选）：Codex 选择官方模型，Claude Code 填写客户端请求中的完整模型 ID；上游模型 ID 留空时直接透传。
- Claude Code 的“模型别名”（可选）：Opus / Sonnet / Fable / Haiku 从本次填写的客户端模型 ID 中选择，也可由 Claude 默认决定。
- Claude Code 的“默认模型”（可选）：启动模型和子代理模型均以下拉选项选择。启动模型支持 Claude 官方的 `best`、`opus`、`sonnet`、`fable`、`haiku`、`opus[1m]`、`sonnet[1m]`、`opusplan` 和 `opusplan[1m]`；子代理模型支持 `opus`、`sonnet`、`fable`、`haiku`。两者都可选择对应的默认行为，或当前配置中的客户端模型 ID；保存别名本身，不提前转换为具体模型 ID。

点击“创建配置”后，服务端自动校验、保存并使配置生效，成功后进入详情页。本地服务入口和路由自动生成。配置 ID 按配置名称规范化生成，Virtual Provider ID 为 `cabletidy_<配置ID>`，并直接用作 Codex 的 `model_provider`；URL 路径使用不带此前缀的配置 ID。留空名称时，自动生成的名称也会参与 ID 规范化；如果多个配置使用同一上游主机且都留空名称，需要为后续配置填写不同名称。

列表显示 CLI、模型设置数量（无设置时显示“直接透传”）、本地地址和本地服务状态。列表与详情页的状态根据 Virtual Provider 的运行情况显示“已启动”“已暂停”或“未启动”，不受上游连通性测试结果影响。详情页依次展示唯一上游的连接设置、可选模型设置和客户端接入；每行模型设置包含客户端模型及可选的上游模型 ID，底部接入区域集中展示本地地址、Virtual Provider ID 和服务启停、预览、应用操作。“保存上游”和“保存模型设置”分别直接保存对应修改；模型设置可全部删除，恢复直接透传。失败时保留输入并在当前表单显示错误。“诊断”页面提供模型解析测试和事件记录，解析使用已保存的配置。

仅在存在实际未保存修改时，切换页面、返回列表或关闭页面会提示确认；改回原值后不再拦截。点击“刷新模型列表”同步更新沿用官方定义的元数据和最新限制，保留手动覆盖值与其他表单输入。

“应用到 Codex”和“应用到 Claude Code”保持独立，只有主动点击时才修改客户端配置文件。测试连通性和配置预览使用已保存的配置。

按需在 Codex 套装详情页中添加模型设置；仅覆盖上下文时无需填写上游模型 ID。模型能力与上下文默认折叠，元数据默认“沿用官方定义”；
展开并选择“覆盖上游限制”后可设置 context window 和图片输入，已有覆盖值或待确认的旧策略会自动展开。不提供固定 reasoning effort 或未实现的 compact 控件。
旧窗口和压缩配置会提示待确认，不会因升级自动同步到 Codex。不同套装可使用同一个官方模型名，映射在各自 Virtual Provider 内隔离。

Daybreak Blue 和 Red 保留可选，位于模型列表末尾的“安全专项模型”分组，分别标记“需授权”和“需专项授权”。选中后显示简短用途提示，不自动禁用或更改已有映射；目录中的隐藏标记不等同于授权状态，实际可用性由上游支持和账户权限决定。

每份配置只连接一个上游，配置内所有模型都映射到该上游；Codex 接入使用 Responses 协议。需要另一个上游时创建另一份配置，不支持在同一配置内添加备用上游或自动切换。多上游配置会被校验拒绝，上游失败直接返回错误。
首次配置不再填充统一的百万上下文或 850K 压缩阈值，也不要求用户填写模型别名或内部 ID。

创建或保存时，服务端执行配置校验、版本冲突检查和运行时更新。校验或更新失败不会覆盖已生效配置；版本冲突时刷新管理页会合并其他窗口新增的模型和不冲突的字段修改，保留本地编辑。同一字段冲突、修改与删除冲突或无法安全合并的结构变更会暂停该表单的保存，并保留当前输入；可先复制需要保留的内容，再点击“加载最新配置”确认放弃该表单的本地修改后重新编辑。上游 secret 保存在本地 `secrets.json`，Web GET 和预览不会回显明文。

上游认证只使用 `secretRef` 对应的已保存密钥，不读取认证环境变量。旧 `envKey` 和 Codex 上游认证元数据在加载或保存配置时丢弃，`env://` 引用也不再读取环境变量；曾仅使用环境变量配置密钥时，需要在管理台填写并保存 API Key。

## Codex 接入

当前 Codex 接入生成一个本地 `config.toml` managed block，例如：

```toml
model_provider = "cabletidy_xxx"

[model_providers.cabletidy_xxx]
name = "CableTidy / local"
base_url = "http://127.0.0.1:43100/xxx/v1"
wire_api = "responses"
requires_openai_auth = false
```

新配置不强制指定 `model`，应用时保留 Codex 已有的模型选择。旧配置中的显式 `defaultModel` 仍受支持。

配置与 Virtual Provider 一对一。例如填写配置名称 `my-relay`，配置 ID、Virtual Provider ID 和 Codex `model_provider` 分别为 `my-relay`、`cabletidy_my-relay` 和 `cabletidy_my-relay`。名称包含大写或空格时仍会规范化为同样的配置 ID。
配置名称会转换为小写，并将空格等字符转换为 `-`；无法生成有效标识时使用原配置 ID。规范化后重名的配置，以及占用管理接口保留路径 `api` 的配置，会被拒绝。
旧配置加载时自动对齐内部 ID 和引用，保留模型映射和上游密钥，并移除 Virtual Provider 的独立 `listenHost` / `listenPort` 及 `daemon.proxyPortRange`。共用监听地址由 `web.listenHost` / `web.port` 决定，修改它需要重启 daemon。
升级后重启 CableTidy，在详情页重新“应用到 Codex”，将旧的独立端口地址更新为配置路径。暂停一份配置只暂停对应入口；重命名配置会改变路径，需要再次应用客户端配置。
上游连接的内部 ID 只用于 CableTidy 关联模型映射和路由，不参与 Codex provider 命名。
CableTidy 不会在 daemon 启动时改写已有 Codex `config.toml`；只有用户主动应用配置时才会写入新的 provider。

Codex Native Provider 的 MVP 接口契约是：

```text
GET  /v1/models       返回当前配置中显式设置的模型
POST /v1/responses    必须：普通和 stream Responses 请求
```

`/models` 和 `/responses` 仍作为兼容别名保留，但不能替代标准的
`/v1/models` 和 `/v1/responses`。`GET /v1/models` 返回的是 CableTidy
维护的 client model ID，不是上游真实模型 ID。它只列出显式模型设置，不是请求白名单，也不自动发现上游模型；纯透传配置返回空列表，客户端仍可请求上游支持的模型。

CableTidy 生成的 `base_url` 永远指向本地 Virtual Provider。Codex 不需要知道：

- 上游真实地址或上游 API Key。
- 上游模型名称和模型映射。
- 内部 Route 和上游健康状态；必要的模型能力元数据由 CableTidy 管理并通过客户端适配提供。
- 外部教程、profile ID 或 profile 文件。
- CableTidy 的内部 Model Profile 和 Upstream Model Binding。

Web 管理台的“应用”操作会在 `~/.codex/config.toml` 中增量维护 CableTidy 的根级选择和 provider 条目，不修改其他 `model_providers`，并创建备份。

启用元数据覆盖后，“应用”还会写入 `model-catalogs/cabletidy-<hash>.json`，将根级 `model_catalog_json` 指向其绝对路径，并暂时移除会覆盖逐模型窗口的根级 `model_context_window`。原目录引用和窗口保存在 `.cabletidy-model-catalog.json`，所有模型恢复官方定义、再次应用时会恢复它们。原目录文件不被覆盖，其其他条目保留在生成目录中。

Codex 的模型目录是当前配置级别的，不按 provider 隔离。手动切换其他 provider 不会自动撤销目录覆盖；应先恢复官方定义并应用。已有 `model_instructions_file`、`developer_instructions`、reasoning effort、compact 阈值和其他用户设置保持不变，预览会提示影响模型行为的覆盖项。生成目录后重启 Codex；更新 Codex 版本后刷新模型列表并重新应用。

Virtual Provider 只监听 `127.0.0.1`、`localhost` 或 `::1`，不生成或校验本地 API Key。
Codex 配置不包含 `env_key`，也不需要设置认证环境变量。例如，可以直接请求：

```bash
curl http://127.0.0.1:43100/codex-main/v1/models
```

升级后重启 CableTidy，再在套装详情页点击“应用 Codex 配置”，即可移除该 provider
旧的 `env_key`。旧 CableTidy 配置中的 `localAuth` 和 `codex.localEnvKey` 在加载时忽略，
旧 secrets store 中的本地密钥不再使用；上游密钥仍用于 daemon 出站认证。
Claude Code 适配器会自动注入固定的 `cabletidy-local` 占位值以满足客户端认证检查，
它不是密钥，本地服务不会校验这个值。Generic CLI 只生成本地地址和模型环境变量。

## Claude Code 接入

新建配置时选择 Claude Code，填写 Anthropic Messages 兼容上游地址、认证方式和凭据。Anthropic 官方 API 和提供同协议的中转服务使用同一接入流程，每份配置仍只连接一个上游。

默认透传客户端模型名，无需登记模型。按需添加“客户端完整模型 ID → 上游模型 ID”映射；仅改名不会限制工具、图片、thinking 等能力，具体能力由客户端和上游决定。已有配置中的显式能力限制仍然生效。Claude Code 的 `sonnet`、`opus` 等别名会在客户端解析，映射应填写实际发到 API 的完整模型 ID。

模型映射只提供“客户端模型 ID”和“上游模型 ID”。客户端输入框支持搜索官方建议，也可直接填写自定义 ID；上游 ID 手动填写，留空时原样透传。建议目录内置于 `web/claude-models.js`，根据 [Anthropic 模型文档](https://platform.claude.com/docs/en/about-claude/models/overview) 整理，记录核对日期和来源，随 CableTidy 发版更新，无需额外 API Key。目录只辅助输入，不限制保存或请求中的模型名，也不会自动加入 `/v1/models`。

“Claude Code 模型选择”分为“模型别名”和“默认模型”：前者包含 Opus/Sonnet/Fable/Haiku 的别名指向，后者包含下拉选择的启动模型和子代理模型。两类下拉都提供默认行为、对应的官方别名和当前配置客户端模型 ID；创建页使用本次填写的模型映射，详情页使用已保存的模型映射，不使用上游模型 ID 或其他配置的模型。模型发现开关保留在表单底部，不单独分组。四个家族别名分别生成官方的 `ANTHROPIC_DEFAULT_<家族>_MODEL` 变量，Fable 使用 `ANTHROPIC_DEFAULT_FABLE_MODEL`。模型改名时同步更新引用它的家族别名，删除模型时相应别名回到默认；保存后需要重新应用客户端配置。已不在候选列表中的旧默认值会在下一次正常保存时清空，页面不会自动写回配置。

选择默认行为时 CableTidy 不指定该字段对应的模型；再次应用会恢复此前接管的对应环境变量原值，由 Claude 自身配置决定。选择启动模型通过 `ANTHROPIC_MODEL` 设置，选择子代理模型通过 `CLAUDE_CODE_SUBAGENT_MODEL` 设置，后续每次启动都会生效。上下文、reasoning effort 和压缩策略仍由 Claude Code 管理，不生成没有实际效果的逐模型窗口或 compact 设置。

### 预览、应用与撤销

点击“预览配置”不会写入文件。预览仅展示 CableTidy 生成的字段、目标路径和冲突提示，不回显原客户端文件中的凭据。“应用到 Claude Code”增量合并用户配置的 `env`：默认位置为 `~/.claude/settings.json`，Windows 为 `%USERPROFILE%\.claude\settings.json`；设置了 `CLAUDE_CONFIG_DIR` 时使用该目录。

接入的核心配置如下，Base URL 不额外带 `/v1`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:43100/claude-main",
    "ANTHROPIC_AUTH_TOKEN": "cabletidy-local"
  }
}
```

生成的完整配置还会将用户环境中的旧 API Key、OAuth Token、自定义请求头置空，并将云厂商接入开关设为 `0`，使该配置使用 Messages 本地入口。原值会保留供撤销使用。权限、Hooks、MCP、根级 `model` 和其他用户设置保持不变；项目配置、`--settings` 或企业 managed settings 仍可能覆盖用户配置。应用后重新启动 Claude Code，用 `/status` 核对 Base URL 和认证来源。

用户只填写上游凭据。本地不生成、保存或校验 Key；`cabletidy-local` 是公开占位值，仅满足 Claude 客户端认证检查，不会转发给上游。直接调用四个本地接口可以完全不带认证头。真实上游认证始终来自 CableTidy 的 secrets store。

应用前会在 CableTidy 的 `backups` 目录备份原文件，在 Claude 配置目录的 `.cabletidy-settings.json` 中记录接管字段及原值，文件权限为 `0600`。切换到另一份 Claude 配置后，撤销仍恢复最初接入前的值。点击当前已应用配置的“撤销接入”恢复这些字段，保留应用后新增的无关设置；不会停止本地服务。

如果接管字段已被手工修改，预览列出冲突字段，应用和撤销均停止写入，不覆盖修改，也不显示冲突字段的秘密值。请先核对备份并保留自己的修改后处理冲突。无效 JSON、非普通文件和符号链接文件不会被替换。已有 `claude.env.v1` 配置继续兼容，新配置使用 `claude.settings.json.v1`。

管理台仅展示实际应用到 `settings.json` 的 JSON 片段，包含将合并的 `env` 字段，并显示目标路径、变更字段和冲突提示。点击“应用到 Claude Code”后仍显示同一种内容，不展示独立文件、Shell 命令或 PowerShell 等其他接入方式。

### 本地接口

所有路径均相对于 `ANTHROPIC_BASE_URL`，共享配置的启停状态：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/v1/messages` | 普通及 SSE 推理；保留查询参数、协议扩展字段和 `anthropic-*` 请求头 |
| POST | `/v1/messages/count_tokens` | 使用相同上游和模型映射，返回上游计数；不要求 `max_tokens`，上游不支持时保留其错误 |
| GET | `/v1/models` | 只返回当前配置显式设置的客户端模型，协议字段 `display_name` 使用客户端 ID；支持 `limit=1..1000` 和 `after_id` |
| HEAD | `/api/hello` | 本地返回 204、不请求上游，仅确认本地入口可达 |

`/messages` 保留为旧版兼容路径。标准接口应使用 `/v1/messages`。SSE 保留 ping、工具参数增量和流内错误，客户端断开时取消上游请求；模型改名只修改 Messages 响应及 `message_start` 的模型字段，不改工具数据。上游错误保留原状态码和响应体，重试、请求 ID 和 Anthropic 限流头随响应转发。

模型发现需在客户端开启 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`，可通过管理台复选框生成。纯透传配置返回空列表，不影响其他模型请求；模型列表不是白名单，也不自动发现上游模型。Claude 会按自身版本过滤发现条目，不含 `claude` 或 `anthropic` 的别名可能不显示。Token counting 为官方可选接口，上游不支持时 Claude 可退回上下文估算。

“测试连通性”与 Codex 使用相同逻辑：使用已保存的连接向上游 Base URL 发起 GET 请求，检查 HTTP 可达性并展示耗时，不发起模型推理，也不判断认证、模型或流式推理是否可用。

### 验证与范围

`npm test` 包含模拟上游的协议、免认证入口、配置合并、恢复、冲突与管理台测试。安装本机 Claude Code 后可执行原生 CLI 冒烟测试，它使用临时配置目录和本地模拟上游，不调用真实模型，也不修改日常 Claude 配置：

```bash
npm run test:claude

# 多个安装版本共存时，可指定要验证的可执行文件。
CABLETIDY_CLAUDE_BIN=/absolute/path/claude npm run test:claude
```

首版仅支持 Anthropic Messages 兼容上游。HTTP/HTTPS 企业网络代理、动态上游凭据、Bedrock/Vertex 原生协议转换和内置 `claude gateway` 托管不在本版范围。模型网关不代表 npm、Git、MCP 子进程或 Claude 其他联网流量也经过 CableTidy。

## 其他 CLI

未来的 Gemini CLI、OpenCode 和其他编程 CLI 可以增加各自的 Target Adapter；它们不需要被强行改成 OpenAI 配置。

## CLI

```bash
node src/cli.mjs status
npm test
```

配置文件和 secrets 使用原子写入。管理台和 Virtual Provider 都只绑定 loopback，不需要本地访问 token、API Key 或 session 有效期。上游 API Key 由 CableTidy 单独保存和使用。

## 许可证

本项目采用 [MIT License](LICENSE)。
