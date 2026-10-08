# 代理安全：风险监测与审计 V1 设计与实现

状态：V1 已在当前源码实现，尚未发布。调研日期：2026-09-26；分段正文与完整检测修订：2026-09-27。第 1-8 节保留分类、分级的设计依据，第 9 节记录实际实现、边界和验证方式。

设计先核对成熟框架的分类、分级和事件模型，再选择适合 CableTidy 的第一版方案。下文明确区分框架原有定义与产品取舍；产品分类、默认等级和规则样例不代表任何标准组织的认证。

## 1. 第一版目标与建议

第一版完成风险监测、结果持久化和本地管理页面展示。用户已明确排除通知、阻断和人工授权；检测结果不产生这些动作。

建议采用以下组合：

| 设计部分 | 借鉴来源 | V1 采用方式 |
| --- | --- | --- |
| 风险分类 | OWASP Top 10 for Agentic Applications 2026，辅以 LLM Top 10 | 建立适合本地编程代理的产品分类，并保存标准映射 |
| 具体攻击技术 | MITRE ATLAS 2026.09 | 在有对应证据时附加技术标签，支持解释与后续扩展 |
| 严重程度与审计字段 | OCSF 1.9.0 | 借鉴 severity、confidence、evidence 的独立建模 |
| 分级依据 | NIST SP 800-30 Rev. 1 | 考虑影响范围、资产敏感性、可恢复性与不确定性 |
| 后续系统风险评估 | CVSS v4.0、OWASP AIVSS v0.8 | 保留研究结论，V1 不生成漏洞分数或综合风险分数 |

产品页面使用“严重程度”，其含义是观察到的行为或内容可能造成的影响。它不表示恶意意图已经确定，也不表示操作已经执行。

## 2. 当前架构的可观测边界

根据当前 [server.rs](../src/server.rs)、[架构说明](architecture.md) 和协议测试：

- CableTidy 转发 OpenAI Responses 与 Anthropic Messages，能观察请求内容、普通响应与 SSE 流中的工具调用。
- 工具由 Codex / Claude Code 等客户端执行。代理只能在后续模型请求中看到客户端带回的工具结果，不能直接验证本机进程、文件或网络变化。
- `proxy.request` 在取得上游响应头时写入，现有 `latencyMs` 不能当作完整响应耗时；连接失败、流中断与正常结束需要另行形成审计结果。
- `AppState.events` 是最多 200 条的内存队列，`/api/v1/events` 返回最近 100 条；重启后丢失，不能承担持久审计。
- 普通诊断日志只保留路由、模型和状态元数据。审计记录独立保存正文与检测快照，包括凭据原文及其检测位置；普通诊断事件继续脱敏。
- 当前纯透传路径也必须纳入监测；不能仅在发生模型改名的分支检测响应。

因此，V1 的覆盖范围是“经过 CableTidy 的 Agent 模型交互”。跨代理通信、宿主机真实执行、上游训练数据和模型内部状态均不在此观察范围内。

## 3. 框架比较

| 方案 | 主要回答的问题 | 可借鉴内容 | 在本项目中的限制 |
| --- | --- | --- | --- |
| OWASP Agentic Top 10 2026 [S1] | Agentic 系统有哪些重要安全风险？ | 目标劫持、工具误用、身份权限滥用、意外代码执行、上下文污染等分类 | 属于风险清单，编号不表示某次事件的严重程度；部分风险需要运行时或系统层证据 |
| OWASP LLM Top 10 [S2][S3] | LLM 应用有哪些重要安全风险？ | 提示注入、敏感信息披露、过度代理能力、资源消耗等 | 覆盖模型、数据、应用等多个层面，不能直接全部变成网关检测项 |
| MITRE ATLAS [S4] | 攻击者可能使用什么战术和技术？ | 技术 ID、技术关系、攻击案例、技术成熟度 | 技术存在于知识库不代表本次请求正在遭受攻击；技术成熟度也不是本次检测置信度 |
| OCSF [S5] | 安全事件与检测结果怎样统一表达？ | 独立的严重程度、置信度、影响、证据和活动结果；Detection Finding 与 AI Operation | 是数据规范，不提供本产品的检测规则或自动分级算法 |
| NIST SP 800-30 Rev. 1 [S6] | 如何评估风险与不确定性？ | 发生可能性与影响的组合、评估假设和证据限制 | 需要系统环境与资产信息；不能把检测置信度直接当作发生可能性 |
| CVSS v4.0 [S7] | 一个漏洞在具体环境下有多严重？ | 标准化漏洞指标、影响维度和等级术语 | 一次 shell 调用通常没有完整的漏洞评分向量，不适合直接套用 |
| OWASP AIVSS v0.8 [S8] | Agentic 特性如何放大漏洞与系统风险？ | 在 CVSS v4.0 基础上考虑代理自主性、工具访问等放大因素 | 仍在演进，需要更多部署上下文；不是逐请求检测评分标准 |

这些方案的成熟程度和用途不同。NIST、CVSS 是长期使用的方法；OCSF 是有明确版本的安全事件规范。Agentic Top 10 和 AIVSS 针对较新的问题，其中 AIVSS 官方页面明确仍在调整算法、筹备 v1.0，不能把它当作已经稳定的统一运行时评分标准。

### 3.1 Agentic Top 10 与网关覆盖关系

以下名称和编号取自 2026 版正文；覆盖结论是 CableTidy 的工程判断。

| 编号 | 官方名称 | V1 可观察部分 | 无法据此确认的事实 |
| --- | --- | --- | --- |
| ASI01 | Agent Goal Hijack | 工具结果或外部文本中的疑似指令操纵 | 代理真实目标已被改变 |
| ASI02 | Tool Misuse and Exploitation | 具有敏感读取、破坏或导出语义的工具调用 | 调用是否越过用户意图、是否真实执行 |
| ASI03 | Identity and Privilege Abuse | 提权、凭据使用、安全配置变更相关调用 | 用户授权范围、有效身份和最终权限变化 |
| ASI04 | Agentic Supply Chain Vulnerabilities | 安装、加载外部代码或工具的可见参数 | 软件包、插件或 MCP 服务确实遭到污染 |
| ASI05 | Unexpected Code Execution (RCE) | 下载后执行、动态执行等明确调用结构 | 代码成功执行、宿主机失陷或沙箱逃逸 |
| ASI06 | Memory & Context Poisoning | 当前请求可见的上下文或记忆写入线索 | 内容已持久化并影响未来行为 |
| ASI07 | Insecure Inter-Agent Communication | 偶尔出现在模型内容中的通信线索 | Agent 间通道、身份认证与完整协议行为 |
| ASI08 | Cascading Failures | 本网关范围内的请求失败和重复调用现象 | 多系统故障的传播链和因果关系 |
| ASI09 | Human-Agent Trust Exploitation | 返回给用户的可见文本 | 用户是否受骗、是否据此操作 |
| ASI10 | Rogue Agents | 当前请求中有限的行为线索 | 长期目标偏离、自主持续活动和完整行为链 |

不建议把十项直接做成十个“已启用检测”开关。页面应展示实际支持的检测项和覆盖限制。

### 3.2 LLM 分类必须绑定版本

官网的 LLM Top 10 总览仍列出 2025 编号，同时资源页已经提供 2026 文档。2026 下载正文仍保留发布日期占位文本，因此本草案同时记录两版映射，不将无版本编号视为稳定标识。

| 风险主题 | 2025 版 | 已获取的 2026 版正文 |
| --- | --- | --- |
| Prompt Injection | LLM01:2025 | LLM01:2026 |
| Sensitive Information Disclosure | LLM02:2025 | LLM02:2026 |
| Excessive Agency | LLM06:2025 | LLM03:2026 |
| Supply Chain | LLM03:2025 | LLM04:2026 |
| Unbounded Consumption | LLM10:2025 | LLM06:2026 |
| Improper Output Handling | LLM05:2025 | LLM10:2026 |
| 系统提示与隐藏上下文披露 | LLM07:2025 System Prompt Leakage | LLM08:2026 Hidden Context Exposure，范围有所扩大 |

规则映射必须保存 `framework + version + id`。未来升级框架或规则后，历史记录继续保留当时使用的映射与规则版本。

### 3.3 ATLAS 适合作为技术标签

已核对 ATLAS 内容版本 `2026.09`，数据格式 `6.0.0`。可参考的技术包括：

| 技术 ID | 名称 | 对应的可见线索 |
| --- | --- | --- |
| AML.T0051 / AML.T0051.001 | LLM Prompt Injection / Indirect | 来自工具结果或外部内容的指令操纵线索 |
| AML.T0086 | Exfiltration via AI Agent Tool Invocation | 工具参数同时含有敏感数据源与外发目标 |
| AML.T0101 | Data Destruction via AI Agent Tool Invocation | 工具调用中的明确破坏性操作 |
| AML.T0081 | Modify AI Agent Configuration | 修改代理指令、工具配置或安全设置的调用 |
| AML.T0034.002 | Agentic Resource Consumption | 有可靠范围与基线时，异常密集或重复的代理调用 |

这些是可能相关的技术映射。工具正常调用、普通配置编辑和正常高并发本身均不足以确认对应攻击。

## 4. 分级建议

### 4.1 严重程度

借鉴 OCSF 的等级名称和标识，产品使用四档风险严重程度，另设信息性审计与未知值：

| 页面显示 | 值 | OCSF severity_id | CableTidy 建议含义 |
| --- | --- | --- | --- |
| 信息 | informational | 1 | 普通审计事实，不计入风险数量 |
| 低 | low | 2 | 规则命中的影响局限、对象非敏感且可恢复 |
| 中 | medium | 3 | 可能影响工作内容，或涉及敏感访问、权限改变，需要结合环境判断 |
| 高 | high | 4 | 明确的敏感数据暴露路径、重大数据破坏或高权限操作风险 |
| 严重 | critical | 5 | 有充分结构证据指向大范围或灾难性影响，例如明确面向系统根目录并绕过根目录保护的递归删除调用 |
| 未知 | unknown | 0 | 信息不足以确定等级；不是低风险，也不是未命中 |

这里只借鉴 OCSF 的表达方式，不宣称内部 JSON 已符合完整 OCSF。OCSF 还定义 Fatal 和 Other，V1 不需要主动产生这两个等级。

分级按规则分别制定，保存理由，例如“目标为系统根目录，操作为递归强制删除”。影响范围、可恢复性和资产敏感性应来自可见证据或明确配置；不能仅因路径名含 `prod` 就认定是生产资产。

`critical` 必须满足对应规则的严格条件；普通删除、安装、联网或使用 `sudo` 不自动进入最高等级。没有合适规则时可以暂时没有某一级别的命中，不为填满等级而制造风险。

### 4.2 置信度与发生可能性

建议置信度使用 `low / medium / high / unknown`：

- 高：完整结构化参数明确匹配规则，或检测到可精确确认的敏感值。
- 中：格式和上下文共同支持判断，但目标性质或部分参数仍有歧义。
- 低：主要来自语义启发式，例如外部内容疑似在要求代理改写目标。
- 未知：证据不足，无法评价判断可靠性。

置信度描述“规则判断有多可靠”。它不描述“工具有多大概率执行成功”，也不证明行为恶意。参数已经完整解析，可以高置信度确认模型提出了一个危险调用，同时仍完全不知道调用有没有执行。

NIST SP 800-30 将风险与发生可能性、影响相联系，并要求体现不确定性。V1 缺少真实执行、资产价值、权限与环境基线，建议不估算 `likelihood`，也不生成 0-100 总分；不能用 `severity * confidence` 冒充风险模型。

### 4.3 为什么暂不采用 CVSS / AIVSS 数字分数

CVSS v4.0 的 None / Low / Medium / High / Critical 对应 0、0.1-3.9、4.0-6.9、7.0-8.9、9.0-10.0，但这些区间服务于漏洞评分向量。只有一个命令字符串时没有足够依据计算该向量。

AIVSS v0.8 要求 CVSS v4.0 基线，并加入 Agentic 风险放大因素。官方正文也强调分数是序数，不能跨 finding 求平均，不能把小数位差异解释成等比例风险差异。对本项目更有价值的是其影响因素与评估思路，而非在第一版实现完整评分公式。

## 5. 建议的产品分类

第一版采用五类可解释的风险，另保留资源异常的演进方向。分类是本产品基于可观测行为的划分，标准 ID 用于补充解释。一个 finding 有一个主分类，可以附带多个技术标签；同一证据命中多个独立规则时允许产生多个 finding。

| 产品分类 | 建议初始规则 | 标准参考 | V1 边界 |
| --- | --- | --- | --- |
| 敏感数据与凭据 | 凭据读取调用、明确敏感值进入模型请求、敏感数据外发调用 | LLM02:2025/2026；具备工具外发结构时参考 ASI02、AML.T0086 | 普通认证头注入不是泄露；发现敏感路径不等于已读取到秘密 |
| 破坏性操作 | 递归删除重要路径、不可恢复覆盖、破坏性仓库操作 | ASI02、AML.T0101 | 从真实工具参数识别；文档示例或 `echo` 打印命令不构成执行调用 |
| 权限与安全配置变更 | 放宽访问权限、修改凭据或代理安全设置 | ASI03；涉及代理配置时参考 AML.T0081 | 记录权限敏感行为；没有授权基线时不声称“越权已发生” |
| 外部代码执行 | 下载后直接执行、可识别的动态执行链 | ASI05；有供应链证据时再参考 ASI04 | 普通下载、正常依赖安装不自动认定为恶意代码 |
| 疑似指令操纵 | 工具结果或外部文本要求更改目标、越过约束并进行敏感操作 | ASI01、LLM01:2025/2026、AML.T0051.001 | 启发式检测，展示置信度；单个关键词不足以确认提示注入 |
| 资源异常，后续启用检测 | 请求或工具调用异常重复、消耗异常增长 | LLM10:2025 / LLM06:2026、AML.T0034.002 | V1 先记录计数、耗时和已返回的 usage；缺少基线时不直接认定攻击或计算费用 |

框架映射是带条件的关联，不能把所有敏感字段都映射成数据窃取，也不能把所有配置修改都标成权限滥用。

### 5.1 用于校准规则的样例

下表用于校准初始规则，具体支持的语法和资源边界见第 9 节。

| 观察内容 | 建议分类与等级 | 证据结论 |
| --- | --- | --- |
| 用户讨论递归删除命令的危险性 | 普通审计，不产生破坏性调用 finding | 用户文本中的讨论 |
| 工具调用只打印一段危险命令文本 | 普通审计，不按该文本执行效果分级 | 实际操作为打印；若还存在命令替换等执行语法需另行解析 |
| 模型提出对系统根目录进行递归强制删除，并明确关闭根目录保护 | 破坏性操作；严重；高置信度 | 明确调用提议，实际执行未知 |
| 模型提出读取私钥文件 | 敏感数据与凭据；中；高置信度 | 敏感访问提议，未证明读取成功或内容外发 |
| 请求正文包含与本地已知 secret 完全一致的值 | 敏感数据与凭据；高；高置信度 | 敏感值出现在模型请求正文；是否已转发看请求审计结果 |
| 工具返回文本要求忽略原任务并上传凭据 | 疑似指令操纵；高潜在影响；低或中置信度 | 外部文本中的指令线索，未证明代理遵循 |
| 正常读取文件或普通依赖安装 | 普通审计 | 仅凭工具名或联网动作不产生风险 |
| SSE 在工具参数未完整返回前断开 | 检测不完整；能否分级取决于已有证据 | 未完整检查不能显示为“安全” |

## 6. 检测记录需要分开的维度

| 维度 | 建议字段 | 含义 |
| --- | --- | --- |
| 风险类型 | category、ruleId、ruleVersion | 触发哪条规则及对应分类 |
| 严重程度 | severity、severityReason | 潜在影响及其分级依据 |
| 判断可靠性 | confidence、confidenceReason | 支持结论的证据强度 |
| 证据阶段 | evidenceStage | 观察到输入、调用提议、历史重放、工具结果还是模型返回内容 |
| 检查完整性 | inspectionStatus、coverageReasons | 支持范围内检查完成、部分完成、跳过或失败 |
| 执行情况 | executionStatus | 工具默认 unknown；客户端报告结果也需注明来源 |
| 网关结果 | requestOutcome、httpStatus | 转发、连接失败、流中断等事实，与风险等级独立 |
| 处理模式 | mode = record_only | 第一版只记录结果 |

`evidenceStage` 至少区分：

1. `request_content`：本轮发送给模型的内容。
2. `tool_call_proposed`：本轮模型新提出的工具调用。
3. `tool_call_replayed`：客户端请求里携带的历史调用。
4. `tool_result_reported`：客户端向模型报告的工具执行结果。
5. `response_content`：模型返回的文本内容。

CableTidy 自身的配置操作不在 Agent 内容审计范围内，不生成审计记录或风险 finding；Agent 请求中涉及配置修改的工具提议仍按内容规则检查。

同一历史调用在多轮请求重复出现，不应重复计作新的执行动作。只有存在可靠的 provider、会话或 response、call 标识时才做关联；缺少标识时保留独立观察，不凭命令相同猜测会话或执行次数。

同一 HTTP 请求可产生多个 finding。页面可以显示该请求已发现风险的最高严重程度，但不能求和或平均；`inspectionStatus` 仍需独立显示。“未命中已启用规则”不等于“已证明安全”。

内部记录的示意片段：

```json
{
  "schemaVersion": 4,
  "requestId": "request-example",
  "category": "destructive_action",
  "ruleId": "SEC-DELETE-001",
  "ruleVersion": "1",
  "severity": "critical",
  "severityReason": "recursive deletion targets the filesystem root",
  "confidence": "high",
  "confidenceReason": "complete structured tool arguments match the rule",
  "evidenceStage": "tool_call_proposed",
  "executionStatus": "unknown",
  "inspectionStatus": "complete",
  "mode": "record_only",
  "evidence": {
    "operation": "recursive_delete",
    "targetClass": "filesystem_root",
    "bodyRef": { "snapshotId": "evidence/example", "location": "evidence/field/1", "sourceSnapshotId": "response" }
  },
  "frameworkMappings": [
    { "framework": "OWASP_AGENTIC", "version": "2026", "id": "ASI02" },
    { "framework": "MITRE_ATLAS", "version": "2026.09", "id": "AML.T0101" }
  ]
}
```

这是 CableTidy 内部格式示意，不是 OCSF 标准事件；实际记录还需时间、配置快照标识及关联对象。风险发现保存结构化判断与正文定位引用，正文单独存储，保留秘密值原文及敏感位置。

## 7. 对第一版监测与审计设计的约束

### 7.1 检测链路

在请求内容和响应内容被观察到时运行本地规则；V1 不增加外部模型调用。规则仅解释已识别的协议内容和工具参数，不执行命令、脚本、JavaScript 或工具代码。

Responses 应覆盖普通响应中的 function/custom tool call，以及 SSE 的 `response.output_item.*`、`response.function_call_arguments.*` 和 `response.custom_tool_call_input.*`。官方文档已确认参数是分片返回的，需要按 item 关联后拼接 [S10]。最终完整事件不能与先前 delta 重复累计。同一原理用于 Messages 的工具块；具体协议支持以脱敏 fixture 和契约测试为验收依据。

必须兼容纯透传、模型改名、非流式、流式、并发工具调用、UTF-8 跨块、错误事件和客户端断连。未知工具包装、无法解释的动态脚本、超限内容和缺失分片需要显式记录覆盖不足。

检查使用全局共享的工作内存、加密暂存、持久存储、并发工作槽和队列预算，不按每请求内容量、单事件或单工具参数固定截断。无法申请资源时记录具体缺口，响应转发不等待后台检测完成。第一版不承诺识别编码隐藏、任意 shell 语义、图片秘密或加密内容。

### 7.2 审计范围与持久化

审计范围限定为经过代理的 Agent 内容：

- 请求审计：已知配置入口的推理和 token counting 请求，包含成功、路由/解析失败、上游连接失败、响应中断；记录请求 ID、时间、配置修订、CLI 类型、模型、上游标识、状态和阶段耗时。
- CableTidy 自身配置提交、配置启停、客户端配置应用/恢复的成功与失败均不采集。旧的 `kind=management` 记录从审计列表、会话统计、详情和正文接口排除，底层数据按原保留周期清理。
- 审计存储缺口继续作为完整性信息保存，显示在健康提示中，不作为 Agent 会话。

风险 finding 关联 Agent 请求审计。页面读取、静态资源和自动刷新不产生审计记录，避免查询自身不断增加日志。模型列表等本地发现接口可以继续使用普通诊断信息。

使用独立的本地 SQLite 审计库，支持重启保留、分页、筛选和统计；现有 `config.json` / `secrets.json` 继续承担配置职责。V1 固定保留 30 天、容量预算 128 MiB，暂不提供配置入口；到期或接近容量时清理关联数据，页面显示实际保留范围。数据库、WAL 和共享内存文件均计入容量统计。

写入通过有界队列和独立 worker 完成。代理不等待审计数据库提交，正文转发所需的临时加密暂存仍可能等待文件 I/O；正常退出时排空已接收写入；进程强制结束可能丢失尚未提交的记录，因此这是本地可追溯日志，不是零丢失或防篡改审计系统。

队列满、磁盘错误或数据库不可用时，监测退化状态、丢弃计数和最近成功写入时间通过内存运行状态展示；存储恢复后补记缺口摘要。数据库未能打开时保持 `unavailable`，后续正文写入失败或队列丢弃不能将其改成 `degraded`；实际恢复后才按历史缺口显示降级。不能在失败时继续显示“完整审计”。重启时将未结束的请求标为结果未知，不能自动补成成功。

### 7.3 正文、敏感位置与来源

保留网关实际读取的客户端请求、上游响应和网关本地响应，包括对话、模型输出、工具参数与客户端带回的工具结果。保留位置在模型名或其他代理字段改写之前。JSON 保留可读结构，SSE 保留事件顺序、data 和其他事件行，普通非 JSON 内容以文本保留；这不是字节级抓包，不承诺保留 JSON 空白和传输编码。

每次响应风险首次命中时，冻结实际检查的文本或工具参数作为独立检测快照。流式快照明确标记为网关重组内容，后续 done / 最终输出不得覆盖它；原始事件上下文从同记录的响应正文查看。请求风险定位到该次请求快照。正文与检测不再按单条长度或前缀截断；共享资源预算和不可解析的结构仍可能造成明确的覆盖缺口。检测不完整并不意味着没有保留正文。

定向检测凭据：本地已知密钥、认证头、Cookie、API Key / password / token 等凭据字段、内嵌 JSON 凭据、私钥、常见令牌格式及 URL 认证信息和凭据查询参数。普通对话、命令、目标路径、非凭据 URL 参数保持可读。凭据字段、字段名及文本中的凭据保留原值，记录命中片段的位置与原因，页面自动高亮敏感内容。跨 SSE 片段先重组匹配，事件中的原始分片用重组内容的快照引用替换；已接收的未完成文本仍保留原文，并标记检查覆盖不足。未知编码或未支持协议中的隐藏秘密不在确定覆盖范围内。

审计保留和检测不改变真实代理请求和响应。字段名本身也可能含秘密，规则位置使用不包含原始键名的序数路径，正文复核使用已保存原文的 UTF-8 字节偏移（JSON 字符串按持久化的转义形式计数）。JSON 字段按观察顺序输出，不依赖浏览器重新枚举对象键。页面统一转义正文，不能把内容作为 HTML 执行。凭据检测工作区不足时保留可存储的原文并报告检测不完整，沿用 `credential_redaction_budget` / `redaction_buffer_budget` 原因代码。长 URL 认证区或令牌前缀暂时无法确认时保留原文，分别标注 `url_authority_uncertain` / `credential_prefix_uncertain`；不确定的片段记录在 `coverageRanges`，后续片段确认格式后才生成对应风险。

客户端提供的会话 ID、用户信息和工具结果只是客户端报告。没有可靠会话标识时按请求展示，不把同一 provider 下的不同流量拼成会话，也不把调用提议视作真实执行。

## 8. 本地管理页

沿用现有管理台风格，审计入口默认展示会话列表。每行显示会话标题、配置、记录数量、风险数量、最高风险、活动 / 异常 / 检查状态与最近时间。会话使用 `#security/session/<key>` 深链接；打开后以顶部请求概览、左侧请求轨迹、右侧详情组织信息。概览默认按请求数量分配宽度，仅提供“耗时占比”开关：选中时按累计请求耗时分配宽度（不代表会话墙钟时长），再次点击恢复默认，请求顺序始终不变；轨迹按请求观察顺序连续滚动，首次获取 50 条，滚动接近底部时继续追加；取消详情中的上下页按钮。追加和刷新保留已读范围、当前选择与滚动位置，加载失败保留已读记录并提供重试。超过 60 条时，顶部概览将相邻请求合并为最多 60 组，避免导航溢出。每条请求及详情概览使用一行“模型  客户端模型 → 上游模型”展示模型映射，使用该请求记录的模型 ID，缺失时显示“未记录”，不从当前配置推算。支持已加载摘要搜索和仅看风险，搜索范围明确限于已加载的摘要、客户端模型、上游模型与工具名。详情的概览、风险、原始内容分开阅读，只有查看原文或定位风险时加载正文。

会话根据 `session_id`、`x-session-id`、`x-codex-session-id` 请求头（按此顺序）识别；没有可用会话头时，支持 `metadata.session_id`，以及 Claude Code 的 `metadata.user_id` JSON 中的 `session_id` 或旧格式 `_session_<UUID>` 后缀。会话 ID 必须非空、最多 128 字节，只含字母、数字及 `_-.:`，按 provider 与协议计算 SHA-256 归组键。标识只是客户端报告，不是身份认证。共享账号、请求内容相同、时间邻近不能作为归组依据。没有会话标识的 Agent 请求与历史 Agent 记录使用自身审计 ID 作为独立入口；不回填或猜测旧会话。

输入与输出摘要最多 480 UTF-8 字节，标题取首个用户输入的首行、最多 120 字节，均按字符边界截取并在页面转义；摘要可能不完整，原文仍以正文快照为准。工具名最多保留 12 个不同名称，仅用于导航，不表示执行次数。元数据提取复用已有正文扫描，不为会话列表加载全部正文。

筛选包含时间、配置、仅看有风险、最高严重程度、分类、置信度、证据阶段、结果、检查状态。分类、置信度和阶段组合匹配同一条 finding。任一请求命中即可选中会话，服务端先归组再分页，统计和会话轨迹包含该会话全部已保留请求，避免风险筛选丢失上下文。分别显示会话 / 独立入口数量、审计记录数、有风险会话数和关联风险总数。

原独立审计详情 `#security/audit/<UUID>` 继续支持直接打开或刷新。返回按钮和浏览器后退恢复会话列表的筛选、分页和滚动位置；会话内切换步骤保留轨迹滚动位置，过期异步结果不能覆盖当前选择。

详情保留元数据、覆盖状态、Token 用量，逐项显示全部关联风险的等级、阶段、判断依据和规则映射。点击风险切换到相应正文或检测快照，高亮命中字段 / 工具参数并滚动定位；凭据风险定位到敏感原文的实际命中点，同时滚动正文容器和页面使其可见，前后文继续可读。流式风险展开其对应的检测快照并定位敏感原文；响应正文中的关联引用也可打开重组内容，快照支持上下文分页。旧分段记录的宽检测范围通过逐页查询脱敏位置定位，不改写历史证据；无法找到精确命中点时展示定位缺口和上下文，不把整段正文伪装成命中点。也可切换请求、响应和检测快照，查看敏感位置并定位。找不到关联正文时明确提示缺失；旧记录显示未保留正文，超限、中断和未观察状态独立显示。

默认最近 24 小时，详情展示时区和实际保留范围。页面手动刷新，保留筛选条件与当前复核快照；过期查询不能覆盖新的筛选或详情选择。无数据、读取失败和记录缺口有不同提示。页面固定为“仅记录”，不提供通知、阻断或授权动作。

## 9. V1 实现契约与验收

### 9.1 规则与覆盖范围

实现位于 `src/security/`，当前规则版本为 `2`，历史记录保留原版本。分类、严重程度与置信度独立保存，详情包含 `severityReason`、`confidenceReason` 和带版本的框架映射。请求严重程度取已发现风险中的最高值，无 finding 的审计为 `informational`，不计算风险总分。

| 规则 | 检测结构 | 默认严重程度 / 置信度 |
| --- | --- | --- |
| SEC-SECRET-001 | 内容包含本地已知凭据，或 sk / GitHub / AWS / 私钥头等格式 | 高 / 已知值高，格式特征中 |
| SEC-READ-001 | Read 或 cat/head/tail 等字面量调用引用 `.env`、私钥及凭据文件 | 中 / 高 |
| SEC-DELETE-001 | rm 等支持的递归删除调用 | 一般目录中，广泛目录高，显式关闭根保护后删除根目录严重 / 高 |
| SEC-DELETE-002 | apply_patch 的 Delete File 指令 | 中 / 高 |
| SEC-VCS-001 | git reset --hard、带强制选项且非 dry-run 的 git clean | 高 / 高 |
| SEC-CONFIG-001 | Write/Edit/apply_patch 指向代理指令或安全配置 | 中 / 高 |
| SEC-PRIV-001 | sudo / su 提权结构 | 中 / 高 |
| SEC-PRIV-002 | chmod 模式包含已支持的全员写权限形式 | 高 / 高 |
| SEC-EXEC-001 | curl/wget 经直接管道送入已支持的解释器 | 高 / 高 |
| SEC-EXEC-002 | eval / Invoke-Expression 等动态执行结构 | 中 / 高，同时标记代码内容未检查 |
| SEC-EXPORT-001 | curl/wget 参数引用敏感文件 | 高 / 中，未确认文件已发送 |
| SEC-INJECT-001 | 工具结果同时包含覆盖原指令与执行敏感动作的线索 | 高 / 低，未确认代理遵循 |

支持 Bash / shell / exec_command 等常见名称、Read/Write/Edit 类工具，以及 apply_patch。shell 检查只解析有限的字面量参数、分隔符和直接管道；变量展开、重定向、未知包装和动态脚本不做效果推断。构建或包管理命令不直接产生风险，其脚本行为标记为未覆盖。规则是有限的结构匹配，不等价于完整 shell / PowerShell 解释器或漏洞扫描器。

请求中的工具定义仅作为内容检查，历史调用标记为 `tool_call_replayed`；工具结果标记为客户端报告。Responses 的 function/custom tool call 和 Messages 的 tool_use 按输出索引拼接。同一位置的工具风险按完整参数内容指纹和工具名区分版本，只有内容相同的 done / 最终对象合并风险发现；参数或上下文改变后分别保留命中依据与快照，记录最高等级取所有版本中的最高值。去重状态只保留增量计算的内存指纹，正文和证据保留原文与敏感位置。不同请求中的历史调用保留为独立观察，不跨请求猜测会话或执行次数。

请求的额外 JSON 字段也纳入有界凭据检查。响应检查聚焦支持的文本与工具输出项，错误文本只作凭据检查；推理内容、图片、加密数据、未知工具和超限情况保留覆盖不足原因。`previous_response_id` 引用的未见上下文也明确标记。

### 9.2 分段存储、后台检测与共享预算

普通正文、单个 JSON 字符串、工具参数、SSE 事件及响应项没有单条固定长度或数量上限。网关删除原来的 8 MiB 请求拒绝条件，检测删除原来的 1 MiB 前缀、64 KiB 参数 / 文本、256 KiB 事件、128 项、8,192 节点及 32 个 finding 截断。资源足够时，从开头到结尾检查所有保留的可检测内容。

| 资源 | 当前共享预算与行为 |
| --- | --- |
| 正文处理工作区 | 256 MiB；页缓冲、检测窗口、凭据字典、索引、工具参数解析和 finding 去重状态申请额度并随生命周期释放 |
| 临时加密文件 | 512 MiB，按实际暂存字节及认证标签计费；所有请求、响应、路由改写与流式重组共享 |
| 后台检测并发 | 4 个工作槽；排队中的正文仍占用共享暂存预算 |
| 段大小 / 正文查询页 | UTF-8 安全边界的约 32 KiB / 最多 4 段；页面不拼装完整正文 |
| 写入队列 / 元数据更新 | 256 项 / 64 KiB；后台分批提交风险，正文逐段等待存储确认；HTTP 生命周期元数据队列满时累计缺口 |
| 审计持久存储 | 保留 30 天，主库 / WAL / SHM 合计目标 128 MiB；主库约 96 MiB。正文使用 80 MiB 的已用页面预算，写入前计入待写段及页面开销；接近预算先清理已完成旧记录并重试，无可回收空间时记录缺口，为终态、风险与缺口保留余量 |
| 结构与语义工作量 | JSON 递归栈最多 512 层、凭据内嵌 JSON 学习最多 32 层；shell 只解析支持的字面量语法，嵌套包装、动态代码和未知工具显式标记未覆盖 |

预算是整个 daemon 中正文处理子系统的额度，不是每请求额度，也不是整个进程 RSS 上限。HTTP、TLS、配置、SQLite 缓存等仍有各自的内存开销。预算不足时不能推断为“无风险”；状态、覆盖原因、保留字节与缺口范围一起展示。管理 JSON 等需要构造完整值的操作，先按预计解析开销申请共享工作区；普通代理请求通过流式索引读取路由所需字段，长工具参数先选择规则需要的语义字段，避免大段 description 挤占命令检查资源。

流程如下：

1. 接收时以固定页写入匿名临时文件，内容由每文件随机密钥以 ChaCha20-Poly1305 加密，每页使用独立 nonce；密钥只在内存中。请求路由、模型名改写、流式事件重组均从加密暂存读取，不建立完整明文正文缓冲，不把原始凭据写进临时文件。
2. 请求结束或中断后进入后台队列。先学习结构化 / 内嵌凭据，再逐段执行原始内容检测，把原文、判断依据和敏感位置偏移交给 SQLite worker。跨页模式使用重叠窗口及连续凭据状态；跨 SSE delta 的内容按条目重组后处理。
3. 规则结果随检查进度分批保存。`inspectionStatus` 为 `pending`、`running`、`complete`、`partial`、`failed` ；存储缺口等完整性记录使用 `skipped`；`inspectionProgress` 提供 `state`、`phase`、`active`、`processedBytes`、`observedBytes`、`updatedAt`。`active` 从正文接收、排队到全部检测与风险批次完成前均为 `true`，最终更新才设为 `false`、`phase: finished`。某阶段失败后可能继续检测其余正文，因此 `failed` 不代表任务已结束；页面对 `failed + active` 显示“部分步骤失败，仍在检测”。接收阶段总量继续增长；检查结束后已扫描字节与捕获字节对齐，语义覆盖不足仍可为 `partial`。这是经过正文扫描的进度，不能解释为所有语义均被识别。
4. 保存失败或不可解析内容标明缺口，释放临时文件和预算。完整扫描已保留内容不等于支持所有工具、编码、脚本或模型内部语义。长 URL 认证区或令牌前缀无法在检测工作区中确认时保留原文，明确记录检测覆盖不足。

临时文件只保存密文，退出后删除；进程重启不能恢复内存中的密钥，因此不能重启续扫未完成的原始正文。正常退出等待后台检测和持久写入完成。强制退出后，未结束请求恢复为 `unknown`；已结束 HTTP 请求保留原结果，未完成的检测标为 `partial`（已失败的检测保留 `failed`），进度标为失败、`active: false` 并增加 `daemon_restarted`；未封口的正文清单标为 `gap`。已经保存的风险与证据继续保留，任务异常退出也会结束活跃状态。

数据库位于 `CABLETIDY_HOME/audit.sqlite3`，Unix 主库权限 `0600`，Windows 使用用户目录 ACL。`user_version = 3`，事务迁移版本 1 / 2，保留旧记录和快照。`audit` 与 `findings` 一对多；`audit_snapshots` 保存正文清单、语义参数快照或固定范围；`audit_body_chunks` 以 `(audit_id, snapshot_id, start)` 唯一键保存连续段。完成后的清单、段和检测范围不能覆盖，后续 done / 最终输出写入新的快照。删除父审计记录时级联清理关联内容。

到期或接近容量时清理较旧的已完成记录，不清理仍在接收 / 检测的记录来伪装完整覆盖，实际保留期可能短于 30 天。启动维护与正文追加使用同一已用页面阈值；回收后空闲页可立即复用，不必等数据库 / WAL 文件达到另一个阈值。过期和容量清理均独立检查持久化的 `inspectionProgress.active`；即使 HTTP 已完成、某阶段为 `failed`，任务尚未结束的记录仍不可回收，不限于当前写入的记录。若仅有活跃记录占用预算，则保留失败状态和缺口。旧记录没有该字段时沿用请求结果与检查状态判断。数据库损坏或版本过新时保留原文件，不自动删除重建。`failedWrites`、`droppedWrites`、最近成功写入时间及后续 `audit.gap` 摘要记录存储缺口；计数是写入次数，不是请求数。

审计存储或检测失败不产生通知、阻断或授权动作。代理路由或改写本身无法取得必要暂存资源时属于基础设施失败；例如请求暂存预算耗尽返回 `503 resource_budget_exhausted`，不再返回基于 8 MiB 的 `413`。这与风险等级无关。

### 9.3 本地 HTTP 查询

接口沿用管理 API 的 loopback Host / Origin 校验，只提供读取：

| GET 路径 | 返回内容 |
| --- | --- |
| `/api/v1/security/status` | 仅记录模式、规则版本、覆盖与限制、存储健康和丢弃/失败次数 |
| `/api/v1/security/sessions` | 按会话聚合的列表；先筛选命中会话，再统计全部已保留上下文 |
| `/api/v1/security/audit` | Agent 请求与存储缺口摘要列表；`session=<key>` 按顺序读取指定会话 |
| `/api/v1/security/audit/<UUID>` | `record`、全部 `findings` 与 `bodySnapshots` 清单，不含正文 |
| `/api/v1/security/audit/<UUID>/body?snapshot=<id>&offset=<UTF-8字节>` | 指定正文或检测快照的一页内容、敏感位置与上下页偏移 |

列表接受 `hours`（1-720，默认 24）、`limit`（1-100，默认 50）、`cursor`（上一页返回的 `nextCursor`）。统一筛选为 `hasRisk=true|false`、`provider`、`severity`、`inspection`、`outcome`、`kind`、`category`、`confidence`、`stage`。`severity` 比较记录的最高等级；风险属性通过同一个 EXISTS 子查询匹配，多个 finding 不会生成重复行。使用严格校验和 SQL 绑定参数，无正文全文搜索。原 `/security/findings` 路由移除，返回 404。

返回包含 `items`、`total`（全部匹配审计记录数）、`riskRecordCount`（其中有关联风险的记录数）、`findingCount`（这些记录的全部关联风险数）、`counts`（按记录最高等级统计）、`nextCursor`、历史配置候选 `providers`、`oldestAtMs` 和 `storage`。行内 `findingCount` 也取实际关联数量。计数覆盖整个筛选范围，不只统计当前页；即使筛选某个分类，发现数仍包含匹配记录的其他分类风险。游标防止新记录插入造成重复翻页，但不是冻结快照，进行中记录、计数和保留范围可以变化。时间以 UTC 写入，页面按浏览器时区显示时区名称。

会话列表接受相同筛选参数，返回 `total`（会话 / 独立入口数）、`recordCount`、`riskSessionCount`、`findingCount`、`items`、`nextCursor`、`providers`、`oldestAtMs` 与 `storage`。每个会话包含起止观察时间、请求累计耗时、请求数、风险记录数、异常数、进行中数与未完整检查数。按最后一条请求的序号倒序分页。活跃会话新增请求后排序可能改变，列表不是冻结快照，可手动刷新。

`session=<key>` 用于两个列表接口，查询全部已保留会话内容，不应用默认 24 小时时间窗；显式会话查询的 `hours` 也不限制该会话。审计请求列表此时按序号升序，游标取上一页末项；其余筛选仍有效。未知会话返回空列表，页面显示未找到或已过期。会话索引使用已有 JSON 元数据的 SQLite 表达式索引，不重写旧正文。

参数无效返回 400；详情不存在或被清理返回 404；存储忙、损坏或不可用返回 503。读取不会产生新的审计记录。

请求结果 `outcome` 与检查状态分开：`started` / `streaming` 表示尚未结束；完成结果包括 `completed`、`local_error`、`upstream_error`、`connection_error`、`stream_error`、`interrupted`、`unknown`。`httpStatus` 在有上游响应时为其状态，否则为本地返回状态；HTTP 200 中的协议错误仍可为 `stream_error`。这些都不表示工具已执行。CableTidy 自身的配置操作不生成记录；Agent 请求仍保留当时的配置修订用于追溯。

### 9.4 正文与证据接口

新记录 `schemaVersion = 4`，正文快照带 `contentMode: original`；旧记录保留原有脱敏文本，无法恢复已替换的凭据。新旧记录的列表与详情均含 `requestBodyState` / `responseBodyState`。正文接口按需获取内容；省略 offset 时从当前快照范围起点读取，offset 必须为非负整数。快照 ID 按查询参数编码，允许 `stream/`、`evidence/` 等命名。

详情的 `bodySnapshots` 清单包含：

| 字段 | 含义 |
| --- | --- |
| `id` | `request`、`response`、`request/headers`、`response/headers`、`stream/<UUID>`、`evidence/<UUID>` |
| `source` | 客户端请求、上游响应、本地响应、观察到的头、流式重组、工具语义参数或检测时范围 |
| `format` | 新分段正文为可读 `text`，JSON 使用规范化字符串表示，SSE 保留有序事件及分片引用 |
| `state` | `receiving`、`complete`、`interrupted`、`gap`；未观察的正文通过记录字段 `not_observed` 表达 |
| `byteLength` | 已保存原文的 UTF-8 字节数；检测范围清单为固定范围长度 |
| `observedBytes` / `capturedAt` | 观察或重组对象字节数与快照时间 |
| `sourceSnapshotId` / `rangeStart` / `rangeEnd` | 固定检测范围指向原正文的绝对字节边界，后续正文追加不会扩大该快照 |

正文页返回 `snapshotId`、`chunks`（每段 `start`、`end`、`content`、`sensitiveRanges`、`coverageRanges`、`redactions`）、`offset`、`nextOffset`、`previousOffset`、`rangeStart`、`rangeEnd`、`state`、`gap`。每个位置含 `reason`、`start`、`end`、`unit: utf8_bytes`。`sensitiveRanges` 是确认的敏感位置，`coverageRanges` 是不确定或检查不完整的范围，`redactions` 仅用于旧记录的脱敏标记；新位置带 `kind: sensitive | coverage`。SQLite 复用原 `redactions` 列保存带类型的标注，无需改写旧记录。所有位置以**实际持久化文本**为准。范围视图只返回检测时固定范围内的字节，并在 UTF-8 字符边界裁剪；不能读出后来追加的内容。

`finding.evidence.bodyRef` 包含 `snapshotId`、`start`、`end`、`unit`，可附 `sourceSnapshotId`。工具风险独立保留检测时的语义参数，另以 `sourceStart` / `sourceEnd` 指向完整工具参数，避免长描述让风险跳转停在无关段落。文本风险指向不可改写的正文或固定检测范围；凭据风险的 `start` / `end` 精确指向敏感原文，并附 `matchKind: sensitive`，检测快照仍保留其周围上下文。其他风险的高亮可表示检测窗口或语义参数。旧记录仍按 `matchKind: redaction` 定位已保存的脱敏标记。页面正确转换 UTF-8 字节位置，并统一 HTML 转义。

流式事件的 `data` 中，原始参数、初始文本和后续文本 delta 替换为 `{contentSnapshotId, observedFragmentStart, observedFragmentEnd, fragmentUnit: decoded_utf8_bytes}`。`response.content_part.added`、`response.reasoning_summary_part.added`、初始输出项及响应对象中的文本，按同一输出 / 内容索引加入后续 delta 的重组通道；非空初始文本不能逐事件提前落盘。done / 最终对象保留为独立快照，初始文本后中断仍保留已观察的末尾并标记不完整；若新初始值替换了尚未结束的旧通道，旧通道按不完整内容封口。这是网关观察片段到重组快照的关联；观察片段偏移不是持久化 JSON 正文偏移，不能用于正文高亮。重组快照保存参数 / 文本原文和敏感位置，不受后来最终输出覆盖；事件顺序、非 data 行和未替换字段仍保留。无法解析的事件按原始文本保留并标为 `invalid_sse_event`；不完整 JSON 只保留流式解析器已输出的前缀，正文标为 `gap`，检测注明 `invalid_json_or_structure_budget`；解析器尚未输出的尾部可能缺失。

`response.reasoning_summary_text.delta/done` 和 `response.reasoning_text.delta/done` 同样先重组再检测敏感位置，分别按输出索引与摘要 / 内容索引隔离，交错分片不会混入其他条目。推理文本仍执行凭据检查与精确定位，但推理语义标记 `reasoning_content_not_inspected`。未知事件或未知 Messages delta 的 payload 保留原文，记录带 `unsupported_response_event`；仍执行可用的凭据文本检测，不因协议未知而生成凭据风险，也不改变转发给客户端的内容。

`complete` 表示对应内容完成保留，不表示检测语义完整。检查进度、失败和覆盖原因独立于正文状态。`coverageGaps` 可含 `snapshotId`、`reason`、`observedBytes`、`retainedBytes` 或 `retainedForProcessingBytes`，分别说明持久化原文和加密捕获的缺口。未读取请求、缺失正文和写入失败不从后来流量重建。

版本 2 的既有完整快照不在详情里直接返回，按页端点以 `legacySnapshot` 兼容读取旧的有界对象，旧序数路径仍可高亮；版本 1 没有正文时明确提示无法复核。主列表始终不加载正文，详情的全部关联风险不受列表分类筛选裁剪。

### 9.5 验证

`npm test` 包含 Rust 规则 / 流解析 / 存储测试及 `test/security.test.mjs` HTTP 契约、`test/web.test.mjs` 页面测试，覆盖：

- 文本示例、工具定义、历史调用、结果报告与调用提议的区分，以及严重程度与置信度的独立表达。
- Responses 普通响应、function/custom tool 的 SSE 拼接与去重、Messages JSON / UTF-8 分片，纯透传与模型改名。
- 响应头之后才到达的风险、HTTP 200 协议错误、缺少终止事件、客户端取消及上游连接关闭。
- 配置操作成功或失败均不采集；Agent 本地解析失败、暂停入口的请求、连接失败仍记录；读取接口不自增日志。
- SQLite 重启保留、未结束状态恢复、过期级联清理、损坏/新版本保留、共享预算和队列退化、存储失败后的恢复缺口。
- 筛选去重、最高等级语义、同一 finding 的组合属性、记录数与发现数独立统计，以及稳定游标分页。
- 凭据、认证头、Cookie、嵌套参数、跨 SSE 分片的原文保留与敏感位置；普通正文可读、HTML 转义、UTF-8 字节定位、超长正文与非法 JSON、本地错误正文。
- 旧库迁移、正文快照不可覆盖、后续最终内容改变仍可复核命中时参数、正文级联清理，以及详情关闭和筛选后的过期响应防覆盖。

补充验证覆盖超过 8 MiB 请求、1 MiB 之后的风险、超长工具参数与 SSE 事件、9,000 多个节点、超过 32 个 finding、密文暂存及认证校验、跨页 / 跨事件凭据、资源预算耗尽仍转发可转发的响应、按页加载和过期正文请求防覆盖。

Review 回归覆盖交错的推理摘要 / 推理文本分片、未知片段与中断尾部保留原文并标记覆盖不足、正文定位对应真实敏感内容、约 84 MiB 已用页面且磁盘文件未到 96 MiB 时的在线 / 重启容量回收、活跃记录保护，以及同一调用从中风险升级为严重风险后所有参数版本的独立证据和最高等级。

另覆盖非空初始文本与后续 delta 跨边界的凭据、初始文本后断连或收到 error / incomplete 终止事件、初始输出项内嵌文本，以及请求 A 已保存严重风险并出现阶段失败、仍在处理长响应时，请求 B 触发容量回收的并发场景。验证 A 的风险与证据在检测期间和最终失败后均保持，重启能结束遗留活跃状态，页面区分阶段失败与任务结束。

`cargo fmt --check` 与严格 Clippy 检查为配套验证。自动化使用隔离临时目录与模拟上游，不访问真实客户端配置或真实账户；生产上游的扩展事件和平台差异仍需按实际接入验证。

桌面浏览器回归使用 `npm run test:security:browser`，首次运行先执行 `npx playwright install chromium`。可通过 `CABLETIDY_BROWSER_EXECUTABLE` 指定已有 Chromium，`CABLETIDY_BROWSER_OUTPUT` 指定截图目录。脚本以 1440 × 1000 桌面视口与 390 × 844 窄屏视口验证会话轨迹、超过 50 条请求的滚动追加与刷新定位、摘要搜索、详情标签、独立详情深链接、筛选后的第二页、返回 / 前进 / 刷新后的列表滚动恢复，以及 1 MiB 之后的请求和响应凭据命中点。可见性断言同时检查页面视口与正文滚动容器边界，不能仅以 DOM 中存在高亮判为通过。整页截图与几何断言报告默认保存在 `.cabletidy-debug/security-review/`，验收时逐张检查。

已检查的截图：[会话列表](screenshots/security-audit-list.png)、[会话轨迹](screenshots/security-session-trace.png)、[窄屏轨迹](screenshots/security-session-mobile.png)、[精确凭据命中点](screenshots/security-audit-detail.png)。截图使用隔离测试数据；列表配置优先显示，审计时间统一采用 24 小时制。


## 10. 后续参考与来源

OWASP 的 Agent Control Standard (ACS) [S9] 面向代理运行时的检查、控制协议和审计，可以在将来需要真实工具执行挂钩时继续评估。它不能让当前 HTTP 代理自动获得宿主机执行事实，第一版也不引入其中的允许、拒绝或修改动作。

本次读取了一手正文或版本化源文件，以下为可追溯来源：

- [S1] [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)，资源页日期 2025-12-09；已读取其 [下载正文](https://genai.owasp.org/download/52117/)。分类名来自该项目，覆盖关系和中文说明为本草案分析。
- [S2] [OWASP LLM Top 10 总览](https://genai.owasp.org/llm-top-10/)，本次总览显示 LLMxx:2025。
- [S3] [OWASP GenAI LLM Top 10 2026](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/)，已读取 [下载正文](https://genai.owasp.org/download/56857/)。正文包含新编号以及发布日期占位文字，本草案不推断其最终定稿状态。
- [S4] [MITRE ATLAS 数据仓库](https://github.com/mitre-atlas/atlas-data) 与 [2026.09 版本数据](https://github.com/mitre-atlas/atlas-data/blob/main/dist/v6/ATLAS-2026.09.yaml)，内容修改日期 2026-09-15。旧 `dist/ATLAS.yaml` 已标记停止更新，本次使用 v6 格式的版本文件。
- [S5] [OCSF 1.9.0](https://github.com/ocsf/ocsf-schema/releases/tag/1.9.0)，发布于 2026-08-03；已核对 [属性字典](https://github.com/ocsf/ocsf-schema/blob/1.9.0/dictionary.json)、[Detection Finding](https://github.com/ocsf/ocsf-schema/blob/1.9.0/events/findings/detection_finding.json) 与 [AI Operation](https://github.com/ocsf/ocsf-schema/blob/1.9.0/profiles/ai_operation.json)。
- [S6] [NIST SP 800-30 Rev. 1](https://csrc.nist.gov/pubs/sp/800/30/r1/final)，2012-09；已读取 [全文](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-30r1.pdf)，重点参考附录 G、H、I、J 的可能性、影响、风险和不确定性说明。
- [S7] [FIRST CVSS v4.0 Specification](https://www.first.org/cvss/v4.0/specification-document)，重点参考指标分组与 Qualitative Severity Rating Scale。
- [S8] [OWASP AIVSS 官方项目](https://aivss.owasp.org/) 与 [v0.8 正文](https://aivss.owasp.org/assets/publications/AIVSS%20Scoring%20System%20For%20OWASP%20Agentic%20AI%20Core%20Security%20Risks%20v0.8.pdf)，重点参考第 3.1.1、3.2 和 3.5.2 节。
- [S9] [OWASP ACS 资源页](https://genai.owasp.org/resource/agent-control-standard-acs/) 与 [官方仓库](https://github.com/GenAI-Security-Project/agent-control-standard)，本次仅用于识别未来运行时接入方向。
- [S10] OpenAI 官方 [函数调用流式指南](https://developers.openai.com/api/docs/guides/function-calling#streaming)、[function arguments delta](https://developers.openai.com/api/reference/resources/responses/streaming-events#response.function_call_arguments.delta) 和 [custom tool input delta](https://developers.openai.com/api/reference/resources/responses/streaming-events#response.custom_tool_call_input.delta)。
