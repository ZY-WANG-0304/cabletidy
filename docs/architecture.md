# CableTidy 架构设计

## 1. 定位与边界

CableTidy 是一个无桌面 GUI 依赖的本地 coding CLI gateway。它由一个 daemon 和一个本地 Web 管理台组成，面向 Claude Code、Codex 以及未来的其他编程 CLI。

CableTidy 不是一个“把所有上游都变成 OpenAI API”的薄代理。它的职责是：

1. 管理多个上游代理、账号、认证方式、wire protocol 和能力差异。
2. 在本地暴露多个面向具体客户端的 Virtual Provider。
3. 在 CableTidy 内完成客户端协议、上游协议和能力之间的适配。
4. 维护稳定的客户端模型身份和上游模型映射。
5. 在内部连接层处理 upstream、模型绑定、健康状态和故障解释。
6. 为每个目标 CLI 生成它真正需要的原生接入配置。

无桌面 GUI 的含义是：CableTidy 不依赖 Electron、系统托盘或桌面窗口。Web 管理台由 daemon 提供，用户可以在本机浏览器或 SSH 端口转发后的浏览器中使用。

### 1.1 Codex MVP 模型支持范围

默认按客户端请求中的模型名透传到上游，不要求预先登记模型。可选的 Codex 模型改名和元数据设置只支持与官方 GPT 目录明确对应的模型；上游是否支持未配置的模型由上游判断。

- `clientModelId` 默认使用对应的官方模型名，`upstreamModelId` 保存上游要求的字符串，不要求用户额外创建客户端别名。
- 基础提示词、模板变量和工具行为配置沿用对应的 Codex 官方模型定义，不能随意套用另一个 GPT 模型的目录项。
- 同一模型经由不同上游接入时，仍需确认代理实际支持的能力和上下文限制，不能由官方模型身份推断完整兼容。
- 非对应 GPT 模型的客户端适配、中性提示词和自定义适配预设均推迟到后续版本，不属于当前 MVP。
- 本机 Codex 版本过旧而缺少某个官方模型时，应更新或补齐经过确认的官方目录，不将其当作非 GPT 模型适配。

上述范围不等于上游模型身份检测。官方模型列表动态读取本机 `codex debug models --bundled`，新增或修改 Codex 模型设置及生成包含模型设置的客户端配置时检查目录匹配，不新增静态名称白名单。纯透传配置的创建、预览和应用不依赖官方目录。旧配置保持加载和转发兼容，不自动改名；模型映射重新编辑时需要确认官方模型。上游文档用于确认对应关系，连通性测试不能证明上游实际运行的模型身份或完整的代理任务兼容性。

### 1.2 模型元数据与客户端职责

CableTidy 管理模型能力、上下文窗口和相关策略；Codex 仍需通过其支持的机制获得影响客户端行为的元数据，并负责构造提示词、选择请求 reasoning effort、执行工具和管理会话上下文。CableTidy 不接管用户的 `AGENTS.md` 或额外开发者指令。

仅上游名称不同且元数据一致时，不为名称映射强制生成 `model_catalog_json`。模型的 `codex.metadataMode` 可为 `official` 或 `override`，旧配置不自动进入 override 模式。覆盖模式目前只支持 `contextWindow` 和 `codex.inputModalities`，窗口不得超过官方目录的已知上限，输入类型只能取官方类型的子集并保留 text。上游的 vision 能力限制也会反映到生成目录中。

生成器完整复制本机官方目录，只修改需要覆盖的模型字段，保留提示词、模板变量、reasoning 选项和工具定义。不生成中性提示词，也不将全部模型固定到同一套指令。`GET /v1/models` 仍是 CableTidy 的必需接口，但不作为 Codex 模型元数据自动同步机制。逐模型 compact 策略尚未同步，旧数据保留但不改变压缩行为。

预览和应用使用同一套生成逻辑。应用时使用 TOML 语法树定位根级配置和当前 provider，保留其他 provider、多行指令和用户设置。模型目录采用内容寻址文件名，先写目录再切换 config.toml 引用；原目录和根级窗口的恢复信息独立保存。全部模型取消覆盖后再次应用时恢复原配置，不撤销用户随后自行修改的目录引用。目录覆盖是 Codex 当前配置级别的，不按 provider 隔离；手动切换其他 provider 前需要恢复原目录。

## 2. Codex Native Provider Integration

CableTidy 直接实现 Codex 原生 provider 接入方式。外部教程或客户端 profile 文件不是运行时依赖，也不进入 CableTidy 配置图。
用户填写上游连接信息即可生成本地接入配置。需要改名或覆盖上下文等参数时，
再选择本机官方目录中的模型并添加设置；上游模型名可留空以保持透传。
不提供教程解析或导入，不根据教程中的模型字符串推断官方模型身份。

### 2.1 Model Profile 与客户端配置

Model Profile 是 CableTidy 自己维护的模型身份、能力和元数据，
Upstream Model Binding 记录它在具体上游使用的模型名。
Codex 的 reasoning effort 由请求选择；旧 compact 数据保留但不生效。

客户端接入通过 `config.toml` 的根级模型选择和 provider 条目完成，
显式元数据覆盖按需生成模型目录。不生成额外的 profile/TUI 文件，
也不接受自定义文件清单作为旧格式 artifact 写入。

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
4. Model Resolver 查找当前配置内可选的 Model Profile，未匹配时透传模型名
5. Route 定位唯一 upstream，检查协议；匹配 Model Profile 时检查其绑定和能力
6. 使用显式 upstream_model_id，否则沿用客户端请求中的 model
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
Upstream = endpoint + wire protocol + secret reference
```

示例字段：

```json
{
  "id": "relay-a",
  "name": "Relay A",
  "integration": "codex-native-provider",
  "protocol": "openai.responses",
  "baseUrl": "https://relay.example/v1",
  "secretRef": "secret://upstreams/relay-a"
}
```

`integration` 是上游如何向用户描述接入方式；`protocol` 是 daemon 实际发出的 wire protocol。这两个概念不能混为一谈。

### 4.3 Codex Native Provider Integration

这是 MVP 的第一个上游接入方式。它不是外部教程文件格式，也不是运行时配置 schema。它表达的是一类 Codex 原生 provider 接入约定：

- Codex 的 user-level `config.toml` 使用 `model_provider` 和 `[model_providers.<id>]`。
- provider 使用本地 `base_url` 和 Responses wire protocol；上游 API Key 由 CableTidy 的 `secretRef` 管理。
- CableTidy 管理台录入上游连接和模型映射，模型元数据默认沿用本机官方目录。
- 客户端配置通过 TOML 语法树更新，保留其他 provider 和用户设置，不写入额外的 profile 文件。

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

这些字段都由 CableTidy 管理。capabilities 参与请求能力检查；context window 仅在显式选择覆盖模式后同步，compact 仍是未生效的历史元数据。上例窗口和阈值仅用于展示旧数据结构，不是新模型的通用默认值。新模型不自动填充这些数值。

### 4.5 Upstream Model Binding

每份配置只连接一个 Upstream，配置内的 Model Profile 都映射到这个 Upstream。一个 Upstream 可以提供多个模型；不同配置使用同名客户端模型时，分别保存各自的 Model Profile 和上游映射：

```json
{
  "models": {
    "gpt56-sol": {
      "clientModelId": "gpt-5.6-sol",
      "upstreams": {
        "relay-a": {
          "upstreamModelId": "vendor-sol-v1",
          "capabilityOverrides": []
        }
      }
    }
  }
}
```

`upstream_model_id` 只在 CableTidy daemon 发给该配置的上游时使用。客户端请求和响应中的模型名保持为 `clientModelId`。

### 4.6 Route

Route 记录配置的唯一 upstream 及其可用模型。存储结构中的 `backends` 必须且只能有一个元素：

```json
{
  "id": "codex-default",
  "backends": [
    {
      "upstream": "relay-a",
      "models": ["gpt56-sol", "gpt55"],
      "enabled": true
    }
  ]
}
```

backend 连接唯一 upstream，`models` 保存当前配置可选的 Model Profile 引用，不是请求白名单；可省略或为空。模型的公共 alias 和能力由 Model Registry 维护。配置不支持多上游、主备切换或故障转移；上游错误直接返回客户端，连接失败返回 502。旧配置中的 route `strategy`、backend `priority` / `weight` 只保留原值，不再校验或参与转发。

### 4.7 Virtual Provider

Virtual Provider 是 CableTidy 在本地暴露的一个面向客户端的服务：

```json
{
  "id": "cabletidy_codex-main",
  "ingressProtocol": "openai.responses",
  "route": "codex-default",
  "allowedModels": ["gpt56-sol", "gpt55"],
  "defaultModel": "gpt56-sol"
}
```

Virtual Provider 与管理台共用一个本机回环监听器，不生成或校验本地 API Key。
监听地址由 `web.listenHost` / `web.port` 决定；旧配置中的 `localAuth`、独立
`listenHost` / `listenPort` 和 `daemon.proxyPortRange` 在加载时移除。
首次启动且没有配置文件时，优先绑定 `43100`，遇到 `EADDRINUSE` 则在同一个服务对象上绑定端口 `0`，由操作系统选择可用端口。监听器始终保持打开，实际端口保存到配置和运行状态中，所有入口和客户端配置均使用这个端口。已有配置的端口被占用时直接报错，需要手动修改后重启并重新应用客户端配置。
配置 ID 用作第一级路径，转发给上游前去掉此前缀并保留请求的查询参数。以下示例假设最终端口为 `43100`：

```text
127.0.0.1:43100/                       Web 管理台
127.0.0.1:43100/api/v1/...             管理接口
127.0.0.1:43100/codex-main/v1/...      Codex openai.responses
127.0.0.1:43100/claude-main/v1/...     Claude anthropic.messages
```

不使用额外的 `/providers` 前缀，路径中的配置 ID 也不带 `cabletidy_`。
`api` 是保留配置 ID。未知或已删除的配置路径返回 404，暂停的配置返回 503；
管理接口和其他配置继续可用。配置重命名后旧路径失效，需要重新应用客户端配置。

### 4.8 Target Binding

Binding 把一个 Target 和一个 Virtual Provider 连接起来，并决定如何生成客户端原生配置：

```json
{
  "id": "codex-main",
  "target": "codex",
  "integration": "codex-native-provider",
  "targetFormat": "codex.config.toml.v1",
  "mode": "config",
  "virtualProvider": "cabletidy_codex-main",
  "defaultModel": "gpt56-sol",
  "codex": {}
}
```

配置（Target Binding）与 Virtual Provider 一对一，不允许多个 Binding 引用同一个 Virtual Provider。一个 Target 可以有多份配置，每份配置使用自己的 Virtual Provider。

配置 ID 由配置名称规范化生成，例如填写 `my-relay` 时配置 ID 为 `my-relay`；Virtual Provider 的记录键、`id` 和 Binding 的 `virtualProvider` 均为 `cabletidy_my-relay`。名称包含大写或空格时仍会规范化为同样的配置 ID。Codex 的 `model_provider` 直接使用这个 Virtual Provider ID，不再另行生成。
旧配置加载时同步迁移记录键和引用，保留模型映射及上游连接；规范化名称冲突时保留原记录并报告校验错误，不覆盖配置。名称修改会同步改变配置 ID、入口路径和 Virtual Provider ID。

## 5. Codex 接入语义

### 5.1 CableTidy 内部保存什么

Web 配置表单会将以下信息保存到 CableTidy：

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

Model Profile 和上游模型映射由 CableTidy 配置图维护，不依赖客户端 profile 名称或文件分组。

### 5.2 Codex 最终看到什么

当前接入生成的 user-level `config.toml` 默认只选择一个本地 provider，不强制写入 `model`，因此保留 Codex 当前的模型选择：

```toml
model_provider = "cabletidy_relay"

[model_providers.cabletidy_relay]
name = "CableTidy / Relay A"
base_url = "http://127.0.0.1:43100/relay/v1"
wire_api = "responses"
requires_openai_auth = false
```

Codex Native Provider 的接口契约中，以下两个接口都是必须实现的：

```text
GET  /v1/models
POST /v1/responses
```

其中 `GET /v1/models` 返回当前 Virtual Provider 显式设置的
client model ID；它不是请求白名单，也不自动发现上游模型，纯透传配置返回空列表。
`POST /v1/responses` 同时承载普通请求和
`stream = true` 的 Responses SSE 请求。`/models` 与 `/responses` 可以
作为兼容别名，但不能替代带 `/v1` 的标准路径。

默认仅维护 `config.toml` 中的 provider 选择和条目，不强制写入 `model`，保留客户端的模型选择。旧配置的显式 `defaultModel` 仍受支持。元数据存在覆盖时额外生成模型目录，它是 CableTidy 自动维护的客户端适配产物，不是用户需要编辑的 profile 文件。不生成额外的 profile/TUI 文件。

Codex 不需要知道：

- 上游真实地址和上游 API Key。
- 上游模型名和 `upstream_model_id`。
- 内部 Route 和上游健康状态；必要的模型能力元数据通过客户端适配提供。
- 外部教程的存在、内容和 profile 文件。
- CableTidy 内部的 Model Profile、Upstream Model Binding 和 transform plan。

Codex 自行选择请求的 `model`，daemon 默认原样发送；仅在命中当前配置的显式改名设置时使用上游模型名。

### 5.3 secret 隔离

只有上游 API Key 需要 CableTidy 管理：

```text
上游 API Key
  -> CableTidy secrets store
  -> daemon 出站请求
```

Web API 和 artifact preview 不返回上游密钥明文。Virtual Provider 无需认证，
Codex 接入不生成 `env_key`，Web 管理台负责目标配置的预览和应用，不通过 CLI 读取或注入本地密钥。
已有 Codex 配置重新应用后，该 CableTidy provider 的旧 `env_key` 会被移除，
其他 provider 保留。旧 secrets store 中的本地密钥不再使用。
Claude Code 适配器自动使用固定的 `cabletidy-local` 占位值满足客户端认证检查，
该值不是密钥，也不会在本地 listener 或上游认证中使用。

Claude Code 使用官方 `ANTHROPIC_BASE_URL` 接入，地址为配置入口根路径，不带 `/v1`。
本地入口支持 `POST /v1/messages`、`POST /v1/messages/count_tokens`、
`GET /v1/models` 和 `HEAD /api/hello`；模型发现只返回当前配置显式登记的模型，
不限制未登记模型的请求透传。上游支持 API Key 和 Bearer 认证，客户端认证头由
daemon 替换为已保存的上游凭据。消息和 token 计数使用相同的模型映射，保留
Anthropic 扩展字段、协议头和 SSE 事件，仅在消息的模型字段还原客户端模型名。

目标配置生成 `claude.settings.json.v1`，同时提供独立 `--settings` 文件和
Bash / PowerShell 环境变量。管理台仅展示实际应用的 `settings.json` JSON 片段、
目标路径和变更提示，不展示其他导出格式。应用只合并用户 `settings.json` 的相关 `env` 字段，
通过独立 ownership 记录保留原值，支持重复应用、切换配置和撤销接入。写入使用
文件锁、备份和原子替换；受管理字段在应用后被手动修改时拒绝覆盖，并提示冲突字段。
项目设置和 managed policy 等更高优先级配置可能覆盖用户设置，预览会提示检查。

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

Model Profile（可选）
  clientModelId 或 aliases       用于识别客户端 model
  upstreams[upstream]             关联当前配置的唯一上游
  upstreams[upstream].upstreamModelId（可选）
                                  填写时改写 model，省略时透传
  capabilities                   用于判断 streaming/tools/reasoning 等请求是否可发

Route
  backends[].upstream
  backends[].models（可选模型设置引用）
  backends[0].enabled

Virtual Provider
  ingressProtocol
  route
  allowedModels（可选模型设置引用）/ defaultModel（可选）

Shared listener
  web.listenHost / web.port
  /<configuration ID>/v1/...
```

下列字段不是透明转发每个请求的最低必需项，但可以保留在 CableTidy
配置中，由控制面或后续策略层使用：

```text
Model Profile:
  contextWindow
  compact
  family / name

Route / Virtual Provider / Binding:
  name
  binding 的 target、virtualProvider、targetFormat、defaultModel
  这些用于管理台、Codex artifact 和目标 CLI 接入，不参与上游 model 映射。
```

配置 ID 由 binding 的配置名称规范化生成，Virtual Provider ID 为
`cabletidy_<configuration-id>`，Codex `providerId` 直接使用该值。Upstream 的内部 ID 只作为 CableTidy
配置图中的关联键，用于模型绑定和 Route，不参与 Codex provider 命名；已有
Codex 配置只有在用户主动执行应用操作时才会写入新的 provider。

其中 `contextWindow` 和 `compact` 不是透明 relay 必须发送给上游的字段。
contextWindow 可经模型目录同步，compact 尚未实现逐模型同步。reasoning 只作为能力
参与请求筛选，effort 由 CLI 请求选择。首次配置从官方定义初始化请求能力，不要求填写上下文数值；后续可显式限制窗口或图片输入。

上游 API Key 只通过 `secretRef` 从 CableTidy 的 secrets store 读取。
配置规范化会丢弃旧 `envKey`、`codexToml` 和 `codexNative`，不再迁移或读取其中的认证环境变量。
`env://` 和裸变量名形式的 secret 引用也不再读取环境变量，保存的新 API Key 会直接用于出站认证。
原先仅通过环境变量提供密钥的配置需要在管理台填写并保存 API Key。

## 6. 请求与能力路由

### 6.1 模型解析

```text
client_model_id
  -> 当前 Virtual Provider 的可选 Model Profile
  -> 已配置 upstream_model_id 则改名，否则原样透传
  -> current Route 的唯一 upstream
```

默认值顺序：

```text
显式请求模型
  > Virtual Provider defaultModel
  > 拒绝请求
```

Target Binding 的 `defaultModel` 只用于客户端接入生成；新建配置不自动设置默认模型，客户端自行选择。未登记模型默认透传，不套用其他模型的能力限制；无请求模型且未设置默认模型时返回 `model_required`。

名称和 alias 的唯一性限定在 Virtual Provider 的 `allowedModels` 引用内，而不是全局。该历史字段现在表示可选设置集合，不限制客户端能请求哪些模型。
不同套装可用相同官方模型名并分别绑定不同上游名称；集合为空或省略时不得回退到其他配置或全局模型设置。

### 6.2 能力判断

匹配到显式 Model Profile 时，CableTidy 检查配置的唯一 upstream 是否具备请求需要的能力；纯透传请求的能力由上游判断：

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

## 7. Web 管理台与配置流程

### 7.1 页面职责

Web 管理台是 MVP 的 P0 组件，不是未来可选功能。普通用户按“配置套装”管理，
而不是按底层资源表逐个拼装：

```text
配置套装 = 一个上游 + 可选模型设置 + 自动路由 + 一个 CLI 接入
```

一级页面只保留：

1. 配置套装：查看套装列表、创建套装、进入某套配置的详情页。
2. 诊断：执行模型解析测试和脱敏事件查看。上游连通性测试位于套装详情页，配置校验由保存接口执行。
3. 安全：统一审计列表与风险筛选，详情复核关联风险、正文和检测快照。

套装详情页按上游连接、可选模型设置、客户端接入的顺序纵向排列。底部展示本地地址、
Virtual Provider ID 以及服务启停、预览和应用操作。一个 Virtual Provider 只连接
一个上游，内部 Route 由 CableTidy 自动创建，不向用户暴露主备或优先级配置。
上游连接单独编辑，只需地址和凭据；Claude Code 还可选择 API Key 或 Bearer 认证。
Codex 的通栏可选模型设置区域每行展示：

- 对应的 Codex 官方模型名，客户端默认保持同名。
- 当前上游对应的 `upstream_model_id`（可选，留空使用请求中的模型名）。
- 可展开的模型能力与上下文设置：默认沿用官方定义；已有覆盖值或待确认的旧策略自动展开。旧 compact 数据只提示未同步，不提供新的配置控件。

模型映射和 Route 仍然不是同一个领域概念：

- **模型映射**回答“这个客户端模型在某个上游叫什么、具备什么能力”。
- **内部 Route**回答“这个 Virtual Provider 使用哪个 upstream 连接”。

CableTidy 仍然在运行时保存独立的 `Model Profile`、`Upstream Model Binding`
和 `Route`。每个 Model Profile 只有一个上游映射，一份配置中的所有模型共用
同一上游。Route 随配置自动创建，用户不需要单独配置；需要另一个上游时创建
另一份配置，不扩展当前 Virtual Provider 的上游数量。

套装详情页只保留上游连接、模型映射和 CLI 配置预览所需的最小字段；
底层的 Upstream、Virtual Provider、Binding 和 Route 不再作为普通用户需要
理解或点击的高级设置入口，也不再作为一级导航和首次配置的必经步骤。
Claude Code 模型行只提供客户端模型 ID 和可选的上游模型 ID，不套用 Codex 的
模型能力和上下文元数据。客户端 ID 使用可搜索、允许手动填写的输入框，
`web/claude-models.js` 保存按 Anthropic 官方文档整理的建议目录、来源和核对日期，
随版本更新，不请求 Models API、不需要额外 Key，也不参与校验白名单或推理路由。
上游 ID 留空时原样透传。`/v1/models` 只列当前配置的客户端模型，`display_name`
使用同一 ID，不返回自定义名称或说明；未登记模型继续透传。
客户端区域分为“模型别名”和“默认模型”两组。“模型别名”包含 Opus / Sonnet / Fable / Haiku，
从当前配置已保存的客户端 ID 中选择，或由 Claude 默认决定；“默认模型”包含两个下拉选择：
启动模型提供 `best`、`opus`、`sonnet`、`fable`、`haiku`、`opusplan`，子代理模型提供
`opus`、`sonnet`、`fable`、`haiku`，并分别提供
默认行为和当前配置客户端 ID。创建页使用本次填写的 ID，详情页使用已保存的 ID；不使用上游
模型 ID 或其他配置的模型。已有模型发现开关保留在表单底部，不新增分组。
改名或移除模型时同步家族别名、启动模型和子代理模型中的客户端 ID 引用，并同时维护
Binding 与 Virtual Provider 的默认模型。官方启动别名优先于同名内部 profile ID 或 profile
自定义别名，生成配置时保留原文，由 Claude 解析；普通别名不随模型映射删除而清空。
四个家族均生成官方 `ANTHROPIC_DEFAULT_*_MODEL` 变量。
启动模型不暴露 `[1m]` 选项：该后缀是 Claude Code 的上下文模式控制，客户端会在上游请求前移除，
CableTidy 也无法通过 `/v1/models` 判断或保证上游支持 1M，当前没有专门的 1M 能力验证。
Claude 与 Codex 共用简单的上游连通性测试：向已保存的 Base URL 发起 GET 请求，
报告 HTTP 可达性和耗时，不执行推理或判断模型可用性。Generic CLI 仍保留高级模型编辑入口。

### 7.2 创建配置

首次使用与后续使用采用同一流程：从配置列表点击“新建配置”，进入单页表单：

```text
基本信息
  配置名称（可选）/ CLI（Codex 或 Claude Code）

上游连接
  base URL / 凭据（Claude Code 可选 API Key 或 Bearer）

模型设置（可选，默认不添加）
  Codex 官方模型或 Claude 客户端模型 / upstream_model_id（可选）
  Codex 上下文等参数在创建后的详情页调整

Claude Code 模型选择（仅 Claude Code，可选）
  模型别名：Opus / Sonnet / Fable / Haiku 从本次填写的客户端模型 ID 中选择，或由 Claude 默认决定
  默认模型：启动模型、子代理模型分别从官方适用别名、默认行为和本次填写的客户端模型 ID 中选择

  选择保存别名本身；不在候选列表中的旧值在正常保存时清空，不自动回写配置

创建配置
  自动创建 Route、Virtual Provider 和所选 CLI 的 Target Binding
  保存成功后进入详情页，再按需预览或应用客户端配置
```

创建表单没有对应的远端记录。刷新保留当前 CLI、模型行和选填值，不将 CLI 切换造成的
初始表单差异当成并发冲突；提交时仍基于最新配置检查名称冲突，并由服务端校验和应用：

```text
browser draft
  -> POST /api/v1/config/commit with baseRevision
  -> revision check + validation + effective diff
  -> atomic store write
  -> runtime snapshot swap
```

详情页用于编辑当前配置的唯一上游和模型映射。需要接入另一个 upstream 时创建另一份配置，使用独立的 Virtual Provider。
内部 Route 与 Target Binding 由套装流程维护，不提供独立的路由或绑定编辑页面。

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
POST /api/v1/targets/apply
POST /api/v1/targets/restore

POST /api/v1/tests/upstream
POST /api/v1/tests/model-resolve
GET  /api/v1/integrations
```

预览与应用统一使用 `preview-target-artifacts` 和 `/api/v1/targets/apply`。未指定 `bindingId` 时选择首个启用的 binding；要应用特定配置，应显式传入其 `bindingId`。Codex 和 Claude Code 均支持持久化应用。成功应用返回 `target`，记录 `target.apply` 事件；应用失败使用 `target_apply_failed`，不支持持久化写入的目标返回 `501 target_apply_not_supported`。`/api/v1/targets/restore` 仅用于撤销当前已应用的 Claude Code binding，恢复原有受管理字段，保留其他用户设置；失败返回 `422 target_restore_failed`。

原型接口 `preview-codex-config`、`preview-provider-artifacts` 和 `/api/v1/targets/codex/apply` 已退役，均返回 `404 not_found`。

管理台是本地 daemon 的 loopback-only 控制面，首次启动优先监听 `127.0.0.1:43100`，占用时自动分配其他端口并保存，不使用访问 token 或 session 有效期。远程使用应通过 SSH port forwarding 等方式完成。Web 不把上游 secret 明文返回给浏览器。Virtual Provider 同样仅监听本机回环地址，无需本地 API Key。

## 9. 配置存储

当前 daemon 使用 Rust 和本地 JSON store。Tokio 驱动异步任务，Axum 提供共用 HTTP 监听器，reqwest 转发上游请求；实例锁由 Rust 文件系统与进程身份检查实现：

```text
~/.cabletidy/config.json
~/.cabletidy/secrets.json
~/.cabletidy/runtime.json
~/.cabletidy/daemon.lock/
~/.cabletidy/backups/
```

`config.json` 保存非敏感的 CableTidy 配置图，`secrets.json` 只保存 secret reference 对应的本地 secret。Rust 重构继续读取这两份文件及已有的 runtime / lock / 客户端归属记录，不引入 TOML 应用配置或 OS keyring。`Cargo.toml` 仅用于 Rust 构建；Codex 的 `config.toml` 仍由客户端适配器维护。

原型 Codex 配置不再自动迁移。`providerFormat`、`targetOverrides.codex`、`legacyCodex` 和原型 profile 文件元数据在规范化时被丢弃，保存时不再保留，也不会填充当前字段。仍使用原型格式的配置应在升级前备份并手动转换：

- upstream 或 binding 的 `providerFormat: "codex.toml.v1"` 改为 `integration: "codex-native-provider"`。
- binding 的 `targetFormat: "codex.toml.v1"` 改为 `"codex.config.toml.v1"`；旧值会被校验拒绝。
- 模型 `targetOverrides.codex` 或 `legacyCodex` 中的 `model`、`modelContextWindow`、`personality` 分别移至模型的 `clientModelId`、`contextWindow`、`personality`。
- 若需要保留历史 compact 元数据，将 `modelAutoCompactTokenLimit` 移至模型的 `compact: { strategy: "auto", tokenLimit: ... }`；该元数据仍不改变运行时压缩行为。

已采用当前字段的模型数据继续保留。配置名称与引用的同步重命名、旧本地认证字段清理和密钥脱敏继续生效。

新配置不再生成 `web.enabled`。旧配置中的该字段以及顶层 `models.<id>.capabilityOverrides` 保留原值，但运行时忽略，不进行专用校验。套餐入口的启停由 `virtualProviders.<id>.enabled` 控制；实际生效的能力覆盖位于 `models.<id>.upstreams.<upstream>.capabilityOverrides`，继续校验和应用。

配置和密钥读取不初始化 store；缺失时分别返回无配置和空密钥。`status` 只读，未初始化时仅报告未启动，不生成 URL 或创建文件。`start` 先取得数据目录的实例锁，再读取配置和监听；首次监听成功后保存配置。锁在请求排空和运行状态清理完成后释放，防止重复启动或退出期间启动第二个实例；启动失败也会释放锁。

`src/lifecycle.rs` 先在临时目录写入带 UUID 文件名的 owner 记录，再原子发布整个非空锁目录，避免取得锁和写入归属之间的空窗。记录包含主机名、PID 和同一模块查询的启动标识：Linux 的 boot ID + `/proc` start ticks、macOS 的 `ps lstart`、Windows 的 `GetProcessTimes` 创建时间。Windows 使用只读进程查询句柄，结合退出状态区分已退出进程与无法查询的进程，不启动 PowerShell；创建时间转换为既有 `win32:` 标识使用的 .NET UTC ticks，保持旧锁兼容。Tokio 任务每 2 秒刷新心跳，但禁用仅凭 mtime 的自动回收；只有身份检查确认原进程死亡或 PID 被复用，且锁至少 10 秒未更新时才回收。回收与释放只删除对应代次的 owner 文件，然后使用非递归 `rmdir`，不会删除并发启动者的新 owner。

身份检查明确区分存活、死亡和未知。存活或未过期返回 `ELOCKED`；过期但身份未知（旧格式缺字段、查询失败、其他主机）或缺少可安全删除的 owner 标记，返回 `ELOCKUNKNOWN` 和人工恢复步骤。旧 Linux start ticks 不含 boot ID，只能在数值不同时排除原持有者，不能凭数值相同确认存活。空的旧锁目录也需要人工确认和删除。暂停的实例不被 mtime 误回收，恢复后的心跳仍能正常更新。

Windows 的 Codex 查询通过系统 PowerShell 启动固定参数的 `codex` 命令，兼容 `.exe` 和 npm `.cmd`。监督进程先加入带 `KILL_ON_JOB_CLOSE` 的 Windows Job Object，所有后代继承该归属；查询结束、超时或强制终止监督进程时一并清理后代，即使中间启动器已退出也不遗留持有管道的进程。监督进程忽略控制台 Ctrl+C，由 daemon 控制排空和终止；同时持有 daemon 的 Windows 进程句柄，daemon 被系统强制结束时关闭整个 Job Object，不受 PID 复用影响。Linux / macOS 使用进程组处理受控退出。

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

配置提交与服务启停串行执行，提交使用 revision compare-and-swap。配置和密钥保存成功后一次性替换运行时快照，失败时继续使用旧配置。请求在进入时捕获快照，已有流式请求不受后续重命名或暂停影响。共用监听地址或端口的修改需要重启 daemon。

## 10. 代码模块边界

当前 Rust 实现对应关系：

```text
src/main.rs                       CLI: start / status / help / version
src/config.rs                     JSON store / normalization / secrets / diff
src/validation.rs                 graph validation / references / local listener limits
src/model.rs                      provider-scoped model resolution / capabilities / rewrites
src/catalog.rs                    Codex subprocess supervision / cache / official metadata
src/targets/mod.rs                shared artifact selection and rendering
src/targets/codex.rs               TOML editing / catalog staging / application
src/targets/claude.rs              settings merge / ownership ledger / restore
src/lifecycle.rs                  process identities / instance lock / runtime status
src/fsutil.rs                     bounded retries for filesystem sharing violations
src/server.rs                     shared listener / management APIs / native JSON and SSE proxy
src/security/mod.rs               request and management audit lifecycle / bounded inspections
src/streaming.rs                  encrypted paged spools / streaming JSON / transport model rewriting
src/security/pipeline.rs           asynchronous redaction / complete retained-content inspection
src/security/sse.rs                Responses and Messages fragment reconstruction / immutable evidence
src/security/capture.rs           incremental credential redaction / cross-segment matching / positions
src/security/rules.rs             local risk rules / structured evidence / redacted metadata
src/security/store.rs             SQLite worker / retention / keyset queries / storage health
bin/cabletidy.mjs + bin/native.mjs npm executable selection / signal forwarding
web/                              existing management UI, embedded at compile time
```

配置与模型图继续保留未知 JSON 字段，保证现有配置的往返兼容；具体操作在边界校验。
运行配置采用 `Arc<Snapshot>`，请求进入时捕获快照。提交与 provider 启停共用异步互斥锁，
客户端配置应用单独串行化；管理客户端断连不会中断已开始的配置写入或探测。

SSE 按事件边界增量处理，未发生模型改名的事件保持原始字节。数据面断连取消上游读取，
管理面后台任务则在退出前排空。第一次退出信号停止接受新连接，等请求与管理任务结束后
删除 runtime 并释放实例锁；再次 Ctrl+C 清理 Codex 子进程并以 130 退出。

Web 文件通过 `include_bytes!` 嵌入原生程序。npm 包只包含薄启动器和各平台二进制，
不分发或执行旧 Node 服务端；独立二进制无需 Node.js。开发和测试使用 Node.js 驱动既有
管理页与协议契约测试，`test-support` 特性下的测试程序不进入发行包。

## 11. 安全与可靠性原则

- Web 和数据面共用一个 loopback listener，管理接口保留 `/api/v1/...`，配置入口使用 `/<配置ID>/v1/...`。
- 管理接口和配置入口都校验本地 Host / Origin，无需本地 API Key。
- 上游 secret 单独存入 `secrets.json`，仅在请求上游时注入；本地入口不生成或校验访问密钥。
- 普通诊断日志只记录路由、模型和状态元数据；安全审计按下述约定保留定向脱敏正文，任何持久化日志都不保存原始凭据。
- 风险监测固定为仅记录模式，区分调用提议、历史调用和客户端报告；不推断真实工具执行，不触发通知、阻断或人工授权。
- 安全审计与风险发现保持一对多；列表按审计记录分页和筛选，详情加载关联风险与正文快照。风险记录数与发现数分别统计。
- 请求、响应不设单条固定长度上限；网关路由和模型改写使用 32 KiB 页的临时加密文件，密钥仅在内存中。正文处理共享 256 MiB 工作区、512 MiB 加密暂存预算。资源不足导致无法路由请求时返回基础设施 503；审计捕获或存储失败不会基于风险阻断转发。
- 4 个后台检测工作槽在请求结束或中断后重放保留内容：先学习并识别凭据，再把脱敏正文逐段提交到 SQLite；流式工具参数与文本先跨事件重组，原始分片由内容快照引用替换。完整扫描保留的可检测内容，局部结构、未知语义、存储与工作区缺口明确记录。
- 审计库 schema 3 的 audit / findings 保持一对多；audit_snapshots 保存不可覆盖的完成清单或检测范围，audit_body_chunks 保存连续、不可改写的正文段。详情返回清单，独立 /security/audit/<id>/body 接口每页返回最多 4 段。进度、失败和覆盖原因独立于请求结果与风险等级。
- 上游 URL 可以在管理台展示，但不得写入 Codex 生成的 local provider block。
- Codex 生成配置只包含 CableTidy local endpoint 和 client model。
- 每份配置只连接一个 upstream，不支持主备或多上游切换。多 backend、同一 Model Profile 的多上游映射以及配置内模型与上游不一致都必须校验失败。
- 所有配置提交需要服务端校验、diff、revision 检查和 atomic reload。
- 生成 Codex 文件前备份原文件，managed block 重复应用必须幂等。

## 12. 测试与验收

MVP 至少覆盖：

1. Web 单页表单可以直接完成首次配置，不依赖外部教程或 profile 文件。
2. 每份配置与 Virtual Provider 一对一，并通过 Route 连接唯一的 upstream。
3. 每个 Model Profile 只有一个上游映射；一份配置内所有模型均映射到该配置的 upstream。不同配置可使用相同客户端模型名。
4. 客户端模型名在请求和响应中保持稳定。
5. Codex artifact 默认只生成 `config.toml`；元数据覆盖时按需生成模型目录，不生成额外的 profile/TUI 文件。
6. Codex `base_url` 指向本地 Virtual Provider，不包含真实上游 URL。
7. Codex artifact 不包含上游 API Key 或本地 `env_key`；无认证请求仍使用独立的上游 API Key 转发。
8. 未登记模型透传，显式设置缺少上游绑定、能力不足和协议不兼容会在本地失败。模型设置可为空，元数据覆盖不要求改名。
9. 上游失败时直接返回错误，不向其他配置的 upstream 重试。即使额外 backend 被禁用，多上游配置也必须被拒绝。
10. commit 失败时旧 runtime 继续服务；配置入口独立暂停、重命名或删除，不影响其他入口和已有流式请求。
11. 客户端配置由 Web 管理台应用，不通过 CLI 临时改写用户全局配置。
12. 外部教程和 profile 文件不是启动依赖，也不是运行时对象。

## 13. 演进路线

当前运行时以 Rust 重构后的实现为基础。代理安全 V1 已实现本地规则检测、请求与管理操作审计、SQLite 持久化和“安全”管理页；分类依据、规则边界和接口契约见 [代理安全 V1 设计与实现](agent-security-v1.md)。第一版仅记录并展示，不包含通知、阻断或人工授权。

### Phase 1：当前 MVP

- Rust daemon 和内嵌的 loopback-only Web 管理台。
- Web 配置创建与详情编辑。
- `openai.responses` 和 `anthropic.messages` 同协议 Virtual Provider。
- Upstream、Model Profile、Upstream Model Binding、Route、Virtual Provider、Target Binding。
- Codex Native Provider Integration 的 Web 配置和原生配置生成。
- Codex 只生成本地 `config.toml` managed block。
- Claude Code 官方 Base URL 接入、四个本地接口、模型映射与上游连通性测试。
- Claude Code settings 预览、应用和恢复，以及独立文件、Bash / PowerShell artifact。
- 配置校验、diff、原子 reload 和脱敏事件。
- Responses / Messages 的风险监测、统一审计列表、脱敏正文与检测快照、风险定位复核、筛选分页和存储退化状态。

### Phase 2：可靠性与更多目标

- health-aware / weighted routing。
- circuit breaker、主动健康检查和 metrics。
- Gemini、OpenCode 等 native Target Adapter。
- OAuth、credential pool（独立设计，当前继续使用本地 secrets.json）。

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
  -> Web 表单填写 CableTidy 配置
  -> Upstream / Model Profile / Binding / Route
  -> local Virtual Provider
  -> ~/.codex/config.toml managed block
```

可选模型改名和元数据覆盖由 CableTidy 管理；Codex 连接本地 endpoint 并自行选择请求的模型名，未配置的模型名默认透传。
