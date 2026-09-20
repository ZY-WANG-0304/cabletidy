# CableTidy

CableTidy 是一个不依赖桌面 GUI 的本地 coding CLI gateway。它在本机运行一个 daemon 和一个 Web 管理台，为 Claude Code、Codex 以及其他编程 CLI 提供各自原生的本地接入服务。

CableTidy 的核心不是“提供一个统一 OpenAI API”，而是把复杂度留在本地控制面：

- 管理多个上游代理、账号、协议和能力差异。
- 为不同 CLI 暴露多个 Virtual Provider，每个服务使用目标 CLI 熟悉的 wire protocol。
- 由 CableTidy 维护 Model Profile、client model ID / alias、`upstream_model_id`、能力、context window 和 compact 策略；reasoning effort 由 CLI 请求选择。
- 由内部 Route 把一个本地 Virtual Provider 连接到对应的上游和模型绑定。
- 让 Codex 或 Claude Code 只看到本地 endpoint 和 CableTidy 定义的模型名。

项目使用 Node.js 实现，使用 `toml-eslint-parser` 按语法树增量修改 Codex 配置。

## Codex MVP 模型范围

当前 Codex MVP 只支持与 Codex 官方 GPT 模型明确对应的上游模型，允许上游使用不同的模型名称。

- 客户端默认保留对应的官方模型名，例如 `gpt-5.5`；CableTidy 将它映射为上游要求的模型名，不要求用户另外设置别名。
- 模型提示词和行为配置沿用对应的 Codex 官方模型定义，不用其他 GPT 模型冒充，也不提供自研的通用中性提示词。
- 模型身份对应不代表上游能力完整；仍需确认实际支持的工具、输入类型和上下文限制。
- 不对应 Codex 官方 GPT 模型的接入与适配推迟到后续版本，当前不提供相关配置向导或兼容性承诺。

模型选择来自本机 `codex debug models --bundled`，不维护静态模型名白名单。新增或修改 Codex 模型、预览和应用接入配置时，会检查官方目录匹配；旧配置可继续加载和运行，不会自动改名或删除。目录匹配不等于上游模型身份认证，仍需依据上游接入说明确认，连通性测试不能证明模型身份或完整兼容性。

仅模型名称不同且元数据一致时，不生成额外目录。显式覆盖上下文窗口或输入类型时，CableTidy 生成 `model_catalog_json` 并保留对应官方模型的完整指令、模板变量、reasoning 选项和工具配置。当前不实现逐模型 compact 策略同步，旧 compact 数据保留但不生效。

## 运行

```bash
npm install
npm start
```

配置 Codex 接入时，本机需要可执行支持 `debug models --bundled` 的 Codex CLI，daemon 的 `PATH` 必须包含它。目录读取失败不会阻止代理启动，但会阻止创建模型或应用 Codex 接入；管理台可在更新 Codex 后刷新模型列表。已在 Codex 0.154.0 验证目录加载和实际请求。

管理台默认只监听本机回环地址。直接打开以下地址，或运行：

```bash
node src/cli.mjs web print-url
```

默认数据目录为 `~/.cabletidy`。如需启动一个临时实例：

```bash
CABLETIDY_HOME="$PWD/.cabletidy-dev" npm start
```

Web 管理台默认监听 `127.0.0.1:43100`，Virtual Provider 默认使用 `43101` 开始的端口。

## Web 配置管理

管理台直接显示配置列表，首次使用与后续使用采用相同的操作流程，不设置介绍页或配置向导。点击“新建配置”填写：

- 配置名称（可选）。
- 上游地址和 API Key。
- 一个或多个对应的 Codex 官方模型名与上游真实模型名。

点击“创建配置”后，服务端自动校验、保存并使配置生效，成功后进入详情页。本地服务、端口和路由自动分配，Codex provider ID 按配置名称生成。

列表显示 CLI、模型数量、本地地址和状态。详情页的“保存上游”和“保存模型映射”分别直接保存对应修改；失败时保留输入并在当前表单显示错误。“诊断”页面提供模型解析测试和事件记录，解析使用已保存的配置。

仅在存在实际未保存修改时，切换页面、返回列表或关闭页面会提示确认；改回原值后不再拦截。点击“刷新模型列表”同步更新沿用官方定义的元数据和最新限制，保留手动覆盖值与其他表单输入。

“应用到 Codex”保持独立，只有主动点击时才修改 Codex 配置文件。测试连通性和配置预览使用已保存的配置。

在 Codex 套装详情页中选择官方模型、填写上游名称。元数据默认“沿用官方定义”，
选择“覆盖上游限制”后可设置 context window 和图片输入；不提供固定 reasoning effort 或未实现的 compact 控件。
旧窗口和压缩配置会提示待确认，不会因升级自动同步到 Codex。不同套装可使用同一个官方模型名，映射在各自 Virtual Provider 内隔离。

Daybreak Blue 和 Red 保留可选，位于模型列表末尾的“安全专项模型”分组，分别标记“需授权”和“需专项授权”。选中后显示简短用途提示，不自动禁用或更改已有映射；目录中的隐藏标记不等同于授权状态，实际可用性由上游支持和账户权限决定。

当前 MVP 一个 Virtual Provider 只连接一个上游，固定使用 Responses 协议。
首次配置不再填充统一的百万上下文或 850K 压缩阈值，也不要求用户填写模型别名或内部 ID。

创建或保存时，服务端执行配置校验、版本冲突检查和运行时更新。校验或更新失败不会覆盖已生效配置；版本冲突时刷新管理页会合并其他窗口新增的模型和不冲突的字段修改，保留本地编辑。同一字段冲突、修改与删除冲突或无法安全合并的结构变更会暂停该表单的保存，并保留当前输入；可先复制需要保留的内容，再点击“加载最新配置”确认放弃该表单的本地修改后重新编辑。上游 secret 保存在本地 `secrets.json`，Web GET 和预览不会回显明文。

## Codex 接入

当前 Codex 接入生成一个本地 `config.toml` managed block，例如：

```toml
model_provider = "cabletidy_xxx"
model = "gpt-5.5"

[model_providers.cabletidy_xxx]
name = "CableTidy / local"
base_url = "http://127.0.0.1:43101/v1"
wire_api = "responses"
requires_openai_auth = false
```

Codex provider ID 默认由配置套件名称生成：`cabletidy_<配置名称>`。
上游连接的内部 ID 只用于 CableTidy 关联模型映射和路由，不参与 Codex provider 命名。
CableTidy 不会在 daemon 启动时改写已有 Codex `config.toml`；只有用户主动应用配置时才会写入新的 provider。

Codex Native Provider 的 MVP 接口契约是：

```text
GET  /v1/models       必须：返回 CableTidy 对外暴露的全部模型
POST /v1/responses    必须：普通和 stream Responses 请求
```

`/models` 和 `/responses` 仍作为兼容别名保留，但不能替代标准的
`/v1/models` 和 `/v1/responses`。`GET /v1/models` 返回的是 CableTidy
维护的 client model ID，不是上游真实模型 ID。

CableTidy 生成的 `base_url` 永远指向本地 Virtual Provider。Codex 不需要知道：

- 上游真实地址或上游 API Key。
- 上游模型名称和模型映射。
- 内部 Route 和 retry 策略；必要的模型能力元数据由 CableTidy 管理并通过客户端适配提供。
- 外部教程、profile ID 或 profile 文件。
- CableTidy 的内部 Model Profile 和 Upstream Model Binding。

可以预览或应用 Codex 配置：

```bash
node src/cli.mjs codex artifacts <binding-id>
node src/cli.mjs target env <binding-id>
node src/cli.mjs run --target codex --binding <binding-id> -- codex
```

`run` 使用临时 `CODEX_HOME`，不会覆盖用户全局 Codex 文件。Web 管理台的“应用”操作会在 `~/.codex/config.toml` 中增量维护 CableTidy 的根级选择和 provider 条目，不修改其他 `model_providers`，并创建备份。

启用元数据覆盖后，“应用”还会写入 `model-catalogs/cabletidy-<hash>.json`，将根级 `model_catalog_json` 指向其绝对路径，并暂时移除会覆盖逐模型窗口的根级 `model_context_window`。原目录引用和窗口保存在 `.cabletidy-model-catalog.json`，所有模型恢复官方定义、再次应用时会恢复它们。原目录文件不被覆盖，其其他条目保留在生成目录中。

Codex 的模型目录是当前配置级别的，不按 provider 隔离。手动切换其他 provider 不会自动撤销目录覆盖；应先恢复官方定义并应用，或使用隔离的 `cabletidy run`。已有 `model_instructions_file`、`developer_instructions`、reasoning effort、compact 阈值和其他用户设置保持不变，预览会提示影响模型行为的覆盖项。生成目录后重启 Codex；更新 Codex 版本后刷新模型列表并重新应用。

Virtual Provider 只监听 `127.0.0.1`、`localhost` 或 `::1`，不生成或校验本地 API Key。
Codex 配置不包含 `env_key`，也不需要设置认证环境变量。例如，可以直接请求：

```bash
curl http://127.0.0.1:43101/v1/models
```

升级后重启 CableTidy，再在套装详情页点击“应用 Codex 配置”，即可移除该 provider
旧的 `env_key`。旧 CableTidy 配置中的 `localAuth` 和 `codex.localEnvKey` 在加载时忽略，
旧 secrets store 中的本地密钥不再使用；上游密钥仍用于 daemon 出站认证。
Claude Code 适配器会自动注入固定的 `cabletidy-local` 占位值以满足客户端认证检查，
它不是密钥，本地服务不会校验这个值。Generic CLI 只生成本地地址和模型环境变量。

## 其他 CLI

Claude Code 使用 Anthropic Messages Virtual Provider，目标配置通过环境变量预览或 `cabletidy run` 注入。未来的 Gemini CLI、OpenCode 和其他编程 CLI 可以增加各自的 Target Adapter；它们不需要被强行改成 OpenAI 配置。

## CLI 与检查

```bash
node src/cli.mjs status
node src/cli.mjs config check
node src/cli.mjs model resolve <virtual-provider-id> <client-model-id>
npm test
```

配置文件和 secrets 使用原子写入。管理台和 Virtual Provider 都只绑定 loopback，不需要本地访问 token、API Key 或 session 有效期。上游 API Key 由 CableTidy 单独保存和使用。
