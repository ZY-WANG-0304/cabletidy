# CableTidy 架构设计

## 1. 定位与边界

CableTidy 是一个无桌面 GUI 依赖的本地 coding CLI gateway。它由一个 daemon 和一个本地 Web 管理台组成，面向 Claude Code、Codex 以及未来的其他编程 CLI。

CableTidy 不是一个“把所有上游都变成 OpenAI API”的薄代理。它的职责是：

1. 管理多个上游代理、账号、认证方式、wire protocol 和能力差异。
2. 在本地暴露多个面向具体客户端的 Virtual Provider。
3. 在 CableTidy 内完成客户端协议、上游协议和能力之间的适配。
4. 维护稳定的客户端模型身份和上游模型映射。
5. 在内部连接层处理 upstream、模型绑定、健康状态、重试和故障解释。
6. 为每个目标 CLI 生成它真正需要的原生接入配置。

无桌面 GUI 的含义是：CableTidy 不依赖 Electron、系统托盘或桌面窗口。Web 管理台由 daemon 提供，用户可以在本机浏览器或 SSH 端口转发后的浏览器中使用。

### 1.1 Codex MVP 模型支持范围

当前只支持与 Codex 官方 GPT 模型明确对应的上游模型；名称不同由 CableTidy 的模型映射处理。

- `clientModelId` 默认使用对应的官方模型名，`upstreamModelId` 保存上游要求的字符串，不要求用户额外创建客户端别名。
- 基础提示词、模板变量和工具行为配置沿用对应的 Codex 官方模型定义，不能随意套用另一个 GPT 模型的目录项。
- 同一模型经由不同上游接入时，仍需确认代理实际支持的能力和上下文限制，不能由官方模型身份推断完整兼容。
- 非对应 GPT 模型的客户端适配、中性提示词和自定义适配预设均推迟到后续版本，不属于当前 MVP。
- 本机 Codex 版本过旧而缺少某个官方模型时，应更新或补齐经过确认的官方目录，不将其当作非 GPT 模型适配。

上述范围不等于上游模型身份检测。官方模型列表动态读取本机 `codex debug models --bundled`，新增或修改 Codex 模型及生成客户端配置时检查目录匹配，不新增静态名称白名单。旧配置保持加载和转发兼容，不自动改名；模型映射重新编辑时需要确认官方模型。上游文档用于确认对应关系，连通性测试不能证明上游实际运行的模型身份或完整的代理任务兼容性。

### 1.2 模型元数据与客户端职责

CableTidy 管理模型能力、上下文窗口和相关策略；Codex 仍需通过其支持的机制获得影响客户端行为的元数据，并负责构造提示词、选择请求 reasoning effort、执行工具和管理会话上下文。CableTidy 不接管用户的 `AGENTS.md` 或额外开发者指令。

仅上游名称不同且元数据一致时，不为名称映射强制生成 `model_catalog_json`。模型的 `codex.metadataMode` 可为 `official` 或 `override`，旧配置不自动进入 override 模式。覆盖模式目前只支持 `contextWindow` 和 `codex.inputModalities`，窗口不得超过官方目录的已知上限，输入类型只能取官方类型的子集并保留 text。上游的 vision 能力限制也会反映到生成目录中。

生成器完整复制本机官方目录，只修改需要覆盖的模型字段，保留提示词、模板变量、reasoning 选项和工具定义。不生成中性提示词，也不将全部模型固定到同一套指令。`GET /v1/models` 仍是 CableTidy 的必需接口，但不作为 Codex 模型元数据自动同步机制。逐模型 compact 策略尚未同步，旧数据保留但不改变压缩行为。

预览、应用及临时启动使用同一套生成逻辑。应用时使用 TOML 语法树定位根级配置和当前 provider，保留其他 provider、多行指令和用户设置。模型目录采用内容寻址文件名，先写目录再切换 config.toml 引用；原目录和根级窗口的恢复信息独立保存。全部模型取消覆盖后再次应用时恢复原配置，不撤销用户随后自行修改的目录引用。目录覆盖是 Codex 当前配置级别的，不按 provider 隔离；手动切换其他 provider 前需要恢复原目录，或使用隔离 CODEX_HOME。

## 2. Codex Native Provider Integration

CableTidy 直接实现 Codex 原生 provider 接入方式。外部教程或客户端 profile
文件不是运行时依赖，也不进入 CableTidy 配置图。

### 2.1 Profile 语义

上游接入中可能出现：

```text
xxxgpt561 -> GPT-5.6 Sol
xxxgpt562 -> GPT-5.6 Terra
xxxgpt563 -> GPT-5.6 Luna
xxxgpt55  -> GPT-5.5
xxxgpt54  -> GPT-5.4
```

是上游教程为了适配 Codex 的不同实际使用场景而采用的 profile 配置手段。它们不是 CableTidy 的内部核心对象，CableTidy 不需要继续生成同名 profile 文件。

CableTidy 只吸收真正有运行时意义的语义：

- Model Profile。
- Upstream Model Binding。
- client model ID / alias。
- `upstream_model_id`。
- capabilities。
- context window。
- reasoning 能力；effort 由 CLI 请求选择。
- compact 策略。

因此，教程中的 profile ID 和 profile 文件只作为解析过程中的临时语法，
不会出现在迁移结果、CableTidy 配置或 Codex Target Adapter 生成物中。

例如，可选 migration preview 可以根据教程中的 `XXX-GPT-5.6-Sol`
推导 CableTidy 自己的 `clientModelId = "gpt-5.6-sol"`，并把它保存为
对应 Upstream Model Binding 的 `upstreamModelId`。解析时会丢弃教程的
外部 profile ID，不把它作为迁移结果或运行时字段。

## 3. 总体架构

```text
                       Control plane
  Browser ------------------ local HTTP ------------------+
     |                                                     |
     +-------------------- cabletidy daemon ---------------+
                           |                               |
       +-------------------+-------------------+           |
       |                                       |           |
  Web/control API                       Config service     |
  loopback-only access                  draft/validate     |
  static SPA                            diff/commit        |
       |                                       |           |
       +-------------------+-------------------+           |
                           v                               |
                    Runtime snapshot                       |
                           |                               |
       +-------------------+-------------------+           |
       |                                       |           |
  Codex Virtual Provider                 Claude Virtual Provider
  OpenAI Responses                       Anthropic Messages
       |                                       |
       +-------------------+-------------------+
                           v
             ingress adapter -> model resolver
                           |
                    route selector
                           |
          upstream binding + capability checks
                           |
                 protocol transform layer
                           |
                    upstream connector
                           |
        relay A / relay B / vendor proxy / provider C
```

一个请求的生命周期：

```text
1. 客户端连接某个本地 Virtual Provider
2. 校验请求大小和目标协议；本地 listener 无需 API Key
3. Ingress Adapter 提取 client_model_id 和请求能力
4. Model Resolver 得到 Model Profile
5. Route 根据模型绑定、协议和能力筛选 backend
6. 选择 upstream，并得到 upstream_model_id
7. 执行同协议转发或显式协议对转换
8. 注入上游认证，发送请求
9. 将上游响应、SSE 事件、错误和模型名改写回客户端语义
```

## 4. 核心领域对象

### 4.1 Target

Target 是实际运行的编程 CLI，例如：

- `codex`
- `claude-code`
- `gemini-cli`
- `opencode`
- `generic-env`

Target 描述如何让客户端使用本地服务，包括客户端原生协议、配置方式、模型字段、鉴权变量和启动方式。Target 不描述上游服务。

### 4.2 Upstream

Upstream 是 CableTidy 连接的一个上游实例。一个账号或一个 API Key 应该可以独立建模，以便单独记录健康状态、限流状态和配额。

```text
Upstream = endpoint + wire protocol + secret reference + runtime policy
```

示例字段：

```json
{
  "id": "relay-a",
  "name": "Relay A",
  "integration": "codex-native-provider",
  "protocol": "openai.responses",
  "baseUrl": "https://relay.example/v1",
  "envKey": "RELAY_A_API_KEY",
  "secretRef": "secret://upstreams/relay-a",
  "requestMaxRetries": 5,
  "streamMaxRetries": 5,
  "streamIdleTimeoutMs": 300000,
  "requiresOpenaiAuth": false,
  "supportsWebsockets": false
}
```

`integration` 是上游如何向用户描述接入方式；`protocol` 是 daemon 实际发出的 wire protocol。这两个概念不能混为一谈。

### 4.3 Codex Native Provider Integration

这是 MVP 的第一个上游接入方式。它不是外部教程文件格式，也不是运行时配置 schema。它表达的是一类 Codex 原生 provider 接入约定：

- Codex 的 user-level `config.toml` 使用 `model_provider` 和 `[model_providers.<id>]`。
- provider 使用 `base_url`、`env_key` 和 Responses wire protocol。
- 上游教程可能额外使用 profile 文件来组织模型、context window 和 compact 参数。
- CableTidy Web 向导将这些语义录入 CableTidy 自己的配置。

运行时配置来自 Web/CLI 的 CableTidy 配置图。

### 4.4 Model Profile

Model Profile 是 CableTidy 对客户端暴露的稳定逻辑模型。它不是 Codex profile 文件，也不是上游模型字符串的别名包装。

```json
{
  "id": "gpt56-sol",
  "name": "GPT-5.6 Sol",
  "clientModelId": "gpt-5.6-sol",
  "aliases": ["gpt-5.6-sol", "sol"],
  "family": "codex",
  "capabilities": ["streaming", "tools", "reasoning"],
  "contextWindow": 1000000,
  "compact": { "strategy": "auto", "tokenLimit": 850000 }
}
```

这些字段都由 CableTidy 管理。capabilities 参与请求能力检查；context window 仅在显式选择覆盖模式后同步，compact 仍是未生效的历史元数据。上例窗口和阈值来自参考教程，不是新模型的通用默认值。新模型不自动填充这些数值。

### 4.5 Upstream Model Binding

一个 Model Profile 可以绑定多个 Upstream，一个 Upstream 也可以实现多个 Model Profile：

```json
{
  "models": {
    "gpt56-sol": {
      "clientModelId": "gpt-5.6-sol",
      "upstreams": {
        "relay-a": {
          "upstreamModelId": "vendor-sol-v1",
          "capabilityOverrides": []
        },
        "relay-b": {
          "upstreamModelId": "coding-model-sol",
          "capabilityOverrides": ["-vision"]
        }
      }
    }
  }
}
```

`upstream_model_id` 只在 CableTidy daemon 发给上游时使用。上游切换时，客户端仍然看到同一个 `clientModelId`。

### 4.6 Route

Route 是有顺序的 upstream backend 集合。MVP 首先支持 `priority`：

```json
{
  "id": "codex-default",
  "strategy": "priority",
  "backends": [
    {
      "upstream": "relay-a",
      "priority": 10,
      "models": ["gpt56-sol", "gpt55"],
      "enabled": true
    },
    {
      "upstream": "relay-b",
      "priority": 20,
      "models": ["gpt56-sol"],
      "enabled": true
    }
  ]
}
```

backend 只声明某个 upstream 能实现哪些 Model Profile，模型的公共 alias 和能力由 Model Registry 统一维护。首字节之前的可重试失败可以切换 backend；流开始后不切换。

### 4.7 Virtual Provider

Virtual Provider 是 CableTidy 在本地暴露的一个面向客户端的服务：

```json
{
  "id": "codex-main",
  "listenHost": "127.0.0.1",
  "listenPort": 43101,
  "ingressProtocol": "openai.responses",
  "route": "codex-default",
  "allowedModels": ["gpt56-sol", "gpt55"],
  "defaultModel": "gpt56-sol"
}
```

Virtual Provider 只允许监听本机回环地址，不生成或校验本地 API Key。
旧配置中的 `localAuth` 在加载时忽略。不同 Virtual Provider 使用不同 listener 和目标协议：

```text
127.0.0.1:43101  Codex      openai.responses
127.0.0.1:43102  Claude     anthropic.messages
127.0.0.1:43103  Other CLI  its native protocol
```

### 4.8 Target Binding

Binding 把一个 Target 和一个 Virtual Provider 连接起来，并决定如何生成客户端原生配置：

```json
{
  "id": "codex-main",
  "target": "codex",
  "integration": "codex-native-provider",
  "targetFormat": "codex.config.toml.v1",
  "mode": "config",
  "virtualProvider": "codex-main",
  "defaultModel": "gpt56-sol",
  "codex": {
    "providerId": "cabletidy_<configuration-name>"
  }
}
```

一个 Virtual Provider 可以被多个 Target Binding 使用，一个 Target 也可以有多个 Binding。

## 5. Codex 接入语义

### 5.1 CableTidy 内部保存什么

Web 向导会将以下信息保存到 CableTidy：

```text
上游地址 / API Key / wire protocol
        |
        v
Upstream
        |
        +--> Model Profile
        |       client_model_id / aliases
        |       capabilities
        |       context window
        |       compact policy
        |
        +--> Upstream Model Binding
                upstream_model_id
                capability overrides
        |
        v
Route -> Virtual Provider -> Codex Binding
```

模型 profile 是教程 profile 语义的 CableTidy 化表达，不再使用 `xxxgpt561` 作为内部路由对象，也不需要保留 `xxxgpt56.config.toml` 这类客户端文件分组。

### 5.2 Codex 最终看到什么

当前接入生成的 user-level `config.toml` 配置选择一个本地 provider，并默认保留对应官方模型名：

```toml
model_provider = "cabletidy_relay"
model = "gpt-5.6-sol"

[model_providers.cabletidy_relay]
name = "CableTidy / Relay A"
base_url = "http://127.0.0.1:43101/v1"
wire_api = "responses"
requires_openai_auth = false
```

Codex Native Provider 的接口契约中，以下两个接口都是必须实现的：

```text
GET  /v1/models
POST /v1/responses
```

其中 `GET /v1/models` 必须返回当前 Virtual Provider 允许使用的全部
CableTidy client model ID；`POST /v1/responses` 同时承载普通请求和
`stream = true` 的 Responses SSE 请求。`/models` 与 `/responses` 可以
作为兼容别名，但不能替代带 `/v1` 的标准路径。

默认仅维护 `config.toml` 中的根级选择和 provider 条目。元数据存在覆盖时额外生成模型目录，它是 CableTidy 自动维护的客户端适配产物，不是用户需要编辑的 profile 文件。MVP 不生成 `xxxgpt561`、`xxxgpt562`、`xxxgpt563`、`xxxgpt55`、`xxxgpt54` 或其他 profile 文件。

Codex 不需要知道：

- 上游真实地址和上游 API Key。
- 上游模型名和 `upstream_model_id`。
- 内部 Route、retry 和上游健康状态；必要的模型能力元数据通过客户端适配提供。
- 外部教程的存在、内容和 profile 文件。
- CableTidy 内部的 Model Profile、Upstream Model Binding 和 transform plan。

Codex 看到的 `model` 是 CableTidy 的 client model ID。daemon 发给上游的模型名由 Model Resolver 决定。

### 5.3 secret 隔离

只有上游 API Key 需要 CableTidy 管理：

```text
上游 API Key
  -> CableTidy secrets store
  -> daemon 出站请求
```

Web API 和 artifact preview 不返回上游密钥明文。Virtual Provider 无需认证，
Codex 接入不生成 `env_key`，`target env` 和 `run` 不读取或注入本地密钥。
已有 Codex 配置重新应用后，该 CableTidy provider 的旧 `env_key` 会被移除，
其他 provider 保留。旧 secrets store 中的本地密钥不再使用。
Claude Code 适配器自动使用固定的 `cabletidy-local` 占位值满足客户端认证检查，
该值不是密钥，也不会在本地 listener 或上游认证中使用。

### 5.4 转发请求真正需要的配置

CableTidy 的配置图包含运行时对象、策略对象和展示/目标适配对象。不能因为
某个字段来自上游教程，就把它误认为是每次转发都必需的字段。

当前 `openai.responses` 同协议转发的最小数据面输入是：

```text
Upstream
  protocol
  baseUrl
  secretRef -> 上游 API Key
  auth.header / auth.scheme（缺省为 authorization / Bearer）

Model Profile
  clientModelId 或 aliases       用于识别客户端 model
  upstreams[upstream].upstreamModelId
                                  用于改写发给上游的 model
  capabilities                   用于判断 streaming/tools/reasoning 等请求是否可发

Route
  backends[].upstream
  backends[].models
  backends[].priority / enabled

Virtual Provider
  ingressProtocol
  route
  allowedModels / defaultModel
  listenHost / listenPort
```

下列字段不是透明转发每个请求的最低必需项，但可以保留在 CableTidy
配置中，由控制面或后续策略层使用：

```text
Model Profile:
  contextWindow
  compact
  family / name

Upstream:
  requestMaxRetries
  streamMaxRetries
  streamIdleTimeoutMs
  supportsWebsockets
  requiresOpenaiAuth
  envKey（仅作为 daemon 从环境变量读取 secret 的可选 fallback）

Route / Virtual Provider / Binding:
  name
  binding 的 target、providerId、targetFormat、defaultModel
  这些用于管理台、Codex artifact 和目标 CLI 接入，不参与上游 model 映射。
```

Codex `providerId` 默认由 binding 的配置名称生成，格式为
`cabletidy_<configuration-name>`。Upstream 的内部 ID 只作为 CableTidy
配置图中的关联键，用于模型绑定和 Route，不参与 Codex provider 命名；已有
Codex 配置只有在用户主动执行应用操作时才会写入新的 provider。

其中 `contextWindow` 和 `compact` 不是透明 relay 必须发送给上游的字段。
contextWindow 可经模型目录同步，compact 尚未实现逐模型同步。reasoning 只作为能力
参与请求筛选，effort 由 CLI 请求选择。首次配置从官方定义初始化请求能力，不要求填写上下文数值；后续可显式限制窗口或图片输入。

`requestMaxRetries`、`streamMaxRetries` 和 `streamIdleTimeoutMs` 目前也
只是可保存的运行策略字段；当前数据面主要按 Route backend 做首字节前
的切换，还没有把这三个字段完整实现为独立重试/空闲超时策略。因此首次
向导不要求用户填写它们，文档和 UI 也不应暗示它们已经改变了转发行为。

同理，上游的 `env_key` 不是 Codex 必须继续看到的配置。若用户在 Web
向导直接填写 API Key，CableTidy 使用自己的 `secretRef`；`envKey` 只
在用户明确希望 daemon 从进程环境变量读取密钥时才有意义。

## 6. 请求与能力路由

### 6.1 模型解析

```text
client_model_id
  -> client alias
  -> Model Profile
  -> current Route backend
  -> Upstream Model Binding
  -> upstream_model_id
```

默认值顺序：

```text
显式请求模型
  > Target Binding defaultModel
  > Virtual Provider defaultModel
  > allowedModels[0]
  > 拒绝请求
```

未知模型默认拒绝，不能静默透传给上游。

名称和 alias 的唯一性限定在 Virtual Provider 的 allowedModels 内，而不是全局。
不同套装可用相同官方模型名并分别绑定不同上游名称；解析和默认模型校验都在各自允许的模型集合内进行。

### 6.2 能力判断

CableTidy 根据请求需要的能力筛选 backend：

```text
stream       -> streaming
工具调用     -> tools
并行工具     -> parallel_tool_calls
图片输入     -> vision
reasoning    -> reasoning
```

有效能力由 Model Profile 和 Upstream Model Binding 的覆盖共同决定。如果能力不能安全转换，CableTidy 在本地返回目标协议错误，不发送一个已经静默丢能力的请求。

### 6.3 协议适配

数据面职责分为：

```text
IngressAdapter      client wire -> internal request
ModelResolver       client model -> profile -> upstream model
RequestTransform    internal request -> upstream wire
ResponseDecoder     upstream wire -> internal events
ResponseEncoder     internal events -> client wire
ErrorMapper         internal error -> target error
```

MVP 已实现同协议直通：

```text
openai.responses   -> openai.responses
anthropic.messages -> anthropic.messages
```

跨协议转换必须单独注册 protocol pair，并声明支持、拒绝和降级的能力。不能把所有协议强行压成一个不完整的 OpenAI Chat JSON。

## 7. Web 管理台与 MVP 向导

### 7.1 页面职责

Web 管理台是 MVP 的 P0 组件，不是未来可选功能。普通用户按“配置套装”管理，
而不是按底层资源表逐个拼装：

```text
配置套装 = 一个上游 + 一组模型映射/路由 + 一个 CLI 接入
```

一级页面只保留：

1. 配置套装：查看套装列表、创建套装、进入某套配置的详情页。
2. 诊断：执行配置校验、模型解析测试、上游连通性测试和脱敏事件查看。

套装详情页保留并展示模型映射配置。当前 MVP 一个 Virtual Provider 只连接
一个上游，内部 Route 由 CableTidy 自动创建，不向用户暴露主备或优先级配置。
模型映射区域展示：

- 对应的 Codex 官方模型名，客户端默认保持同名。
- 当前上游对应的 `upstream_model_id`。
- 官方元数据或显式覆盖的 context window / 图片输入；旧 compact 数据只提示未同步，不提供新的配置控件。

模型映射和 Route 仍然不是同一个领域概念：

- **模型映射**回答“这个客户端模型在某个上游叫什么、具备什么能力”。
- **内部 Route**回答“这个 Virtual Provider 使用哪个 upstream 连接”。

CableTidy 仍然在运行时保存独立的 `Model Profile`、`Upstream Model Binding`
和 `Route`。在只有一个上游时，Route 由向导自动创建，用户不需要单独配置。
未来如果一个 Virtual Provider 需要连接多个上游，可以在不改变客户端配置的
情况下扩展 Route；这不属于当前 MVP。

套装详情页只保留上游连接、模型映射和 CLI 配置预览所需的最小字段；
底层的 Upstream、Virtual Provider、Binding 和 Route 不再作为普通用户需要
理解或点击的高级设置入口，也不再作为一级导航和首次配置的必经步骤。

### 7.2 首次配置向导

空配置时 Overview 显示“创建配置套装”入口，点击后直接进入向导：

```text
Step 1  上游连接
        base URL / API Key / protocol

Step 2  CableTidy Model Profile
        官方模型 / upstream_model_id
        能力和上下文默认沿用官方定义

Step 3  本地 Codex 服务
        Virtual Provider / local port

完成
        自动创建 Route 和 Codex Target Binding
        生成 CableTidy config.toml preview
```

向导提交的是 CableTidy 草稿，提交前经过：

```text
browser draft
  -> POST /api/v1/config/validate
  -> effective diff + errors/warnings
  -> POST /api/v1/config/commit with baseRevision
  -> atomic store write
  -> stage listeners
  -> runtime snapshot swap
```

用户可以跳过向导进入详细页面，为同一个 Model Profile 增加第二个 upstream 或为同一个 Virtual Provider 增加其他 Target Binding。

## 8. Control API

当前 MVP 的主要接口：

```text
GET  /api/v1/catalog
GET  /api/v1/config
GET  /api/v1/runtime
GET  /api/v1/events

POST /api/v1/config/validate
POST /api/v1/config/commit
POST /api/v1/config/preview-target-artifacts
POST /api/v1/config/preview-codex-config

POST /api/v1/tests/upstream
POST /api/v1/tests/model-resolve
POST /api/v1/codex-native-provider/inspect
GET  /api/v1/integrations
```

管理台是本地 daemon 的 loopback-only 控制面，默认监听 `127.0.0.1:43100`，不使用访问 token 或 session 有效期。远程使用应通过 SSH port forwarding 等方式完成。Web 不把上游 secret 明文返回给浏览器。Virtual Provider 同样仅监听本机回环地址，无需本地 API Key。

## 9. 配置存储

当前 MVP 使用 Node.js 内置模块和本地 JSON store：

```text
~/.cabletidy/config.json
~/.cabletidy/secrets.json
~/.cabletidy/runtime.json
~/.cabletidy/backups/
```

`config.json` 保存非敏感的 CableTidy 配置图，`secrets.json` 只保存 secret reference 对应的本地 secret。后续可以替换为 Rust daemon、TOML 配置和 OS keyring，但不能改变领域对象边界。

新配置的最小结构：

```json
{
  "version": 1,
  "upstreams": {},
  "models": {},
  "routes": {},
  "virtualProviders": {},
  "bindings": {}
}
```

配置提交使用 revision compare-and-swap。监听器采用 staging reload，新的 listener 全部成功后才替换 runtime snapshot，失败时继续使用旧配置。

## 10. 代码模块边界

当前 Node MVP 对应关系：

```text
src/config.mjs
  store / secret references / normalize / diff

src/validation.mjs
  schema-like validation / references / listener conflicts

src/model-resolver.mjs
  alias / profile / upstream_model_id / capability routing

src/codex-native-provider.mjs
  Codex Native Provider Integration
  optional tutorial inspection/migration preview
  local config.toml artifact renderer

src/target-artifacts.mjs
  Codex / Claude Code / generic target artifacts

src/server.mjs
  Web control API + local Virtual Provider listeners

src/cli.mjs
  status / config check / inspect / artifact / run

web/index.html + web/app.js + web/styles.css
  local configuration console and first-run wizard
```

Codex Native Provider Integration 的运行实现位于 `src/codex-native-provider.mjs`。

## 11. 安全与可靠性原则

- Web 和数据面 listener 分离。
- Virtual Provider 只允许 loopback listener，无需本地 API Key。
- 上游 secret 和本地 secret 分离保存、分离注入。
- 日志只记录路由、模型和状态元数据，不记录 prompt、完整响应或 key。
- 上游 URL 可以在管理台展示，但不得写入 Codex 生成的 local provider block。
- Codex 生成配置只包含 CableTidy local endpoint 和 client model。
- 当前 MVP 使用单上游内部 Route；未来增加多上游后再启用 retry/priority 切换。
- 所有配置提交需要服务端校验、diff、revision 检查和 atomic reload。
- 生成 Codex 文件前备份原文件，managed block 重复应用必须幂等。

## 12. 测试与验收

MVP 至少覆盖：

1. Web 向导可以直接完成首次配置，不依赖外部教程或 profile 文件。
2. 同一个 upstream 可以被多个 Virtual Provider / Target Binding 复用。
3. 当前 MVP 一个 Virtual Provider 只连接一个 upstream；未来扩展时，一个 Model Profile 可以映射到多个 upstream 的不同 `upstream_model_id`。
4. 客户端模型名在请求和响应中保持稳定。
5. Codex artifact 只生成 `config.toml`，不生成 profile 文件。
6. Codex `base_url` 指向本地 Virtual Provider，不包含真实上游 URL。
7. Codex artifact 不包含上游 API Key 或本地 `env_key`；无认证请求仍使用独立的上游 API Key 转发。
8. unknown model、缺少 binding、能力不足和协议不兼容会在本地失败。
9. 当前 MVP 不配置主备；未来多上游 Route 再覆盖首字节前切换和备用模型映射。
10. commit 失败或 listener staging 失败时旧 runtime 继续服务。
11. `cabletidy run` 不修改用户全局 Codex 配置。
12. 外部教程和 profile 文件不是启动依赖，也不是运行时对象。

## 13. 演进路线

### Phase 1：当前 MVP

- Node daemon 和 loopback-only Web 管理台。
- Web 首次配置向导。
- `openai.responses` 和 `anthropic.messages` 同协议 Virtual Provider。
- Upstream、Model Profile、Upstream Model Binding、Route、Virtual Provider、Target Binding。
- Codex Native Provider Integration 的 Web 配置和原生配置生成。
- Codex 只生成本地 `config.toml` managed block。
- Claude Code 环境变量 artifact。
- 配置校验、diff、原子 reload 和脱敏事件。

### Phase 2：可靠性与更多目标

- health-aware / weighted routing。
- circuit breaker、主动健康检查和 metrics。
- Gemini、OpenCode 等 native Target Adapter。
- OS keyring、OAuth、credential pool。

### Phase 3：显式协议转换

- 以协议对为单位实现 request/response/event transform。
- 每个 transform 维护能力矩阵和错误映射。
- 对不能安全保真的能力显式拒绝，不静默降级。

## 14. 结论

CableTidy 的核心链路是：

```text
Target
  -> Target Binding
  -> Virtual Provider
  -> Model Resolver
  -> Model Profile
  -> Upstream Model Binding
  -> Route
  -> Upstream
  -> protocol-pair transform
```

CableTidy 的 Codex 集成链路是：

```text
Codex Native Provider Integration
  -> Web 向导填写 CableTidy 配置
  -> Upstream / Model Profile / Binding / Route
  -> local Virtual Provider
  -> ~/.codex/config.toml managed block
```

模型映射和 profile 中有意义的语义属于 CableTidy；Codex 只负责连接本地 endpoint 并发送 CableTidy 定义的 client model ID。
