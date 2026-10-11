# Codex 与 Claude Code 的会话上下文管理调研

调研日期：2026-10-11。状态：供请求历史折叠与检测复用方案评审，尚未修改产品实现。

本机版本：Codex CLI `0.161.0`、Claude Code `2.1.295`。结论分别注明官方文档、本机协议 schema / 程序检查和本机请求验证；不把某个版本的内部字段视为永久协议。

## 1. 最重要的结论

客户端的一个工作会话可能包含多条独立的上下文。主线程、side、fork 和子 agent 既可能共享一部分输入，又会分别增长、压缩或恢复。一个 HTTP 会话头不一定唯一标识其中的一条上下文。

因此需要区分：

1. **会话归组**：这些请求属于哪次工作或哪个会话树，供审计列表和会话概览使用。
2. **上下文身份**：请求属于哪个 thread、agent 或可明确识别的侧边分支，供历史比较使用。
3. **继承关系**：某个新上下文是否复制父上下文，以及复制到哪个边界。
4. **检测结果身份**：同一段内容在相同检查条件下的计算结果，独立于它出现在哪个分支。

当前 `src/security/session.rs` 只保存一个 `sessionKey`，优先读取 Codex 的 `session-id` 和 Claude 的 `X-Claude-Code-Session-Id`；没有单独保存上下文身份、父子 / fork 关系或请求类别。这可以归组记录，但不足以代表单一、持续追加的上下文。

## 2. Codex

### 2.1 主会话、恢复与压缩

官方 App Server 模型是 `Thread → Turn → Item`：[O2]。

- `thread/start` 新建线程；`thread/resume` 继续已有线程；`turn/start` 追加用户输入或工具输出。
- 一个用户 turn 可以触发多次模型请求和多次工具交互。请求序号不是用户输入的轮次，不能按“上一条请求已经处理完”来确定新内容边界。
- `turn/steer` 可以向进行中的 turn 追加用户输入，不保证每次新用户输入都会创建新 turn。
- `/compact` 或 `thread/compact/start` 可替换早期上下文。Responses 原生压缩还可以产生供后续请求回传的 `encrypted_content`，不能把新摘要视为原文未变化，也不能据旧原文的阴性检测结果宣称新摘要已经检查过：[O1、O2、O5]。
- Responses 支持正文中的历史条目和历史引用；网关只能检查当前实际观察到的载荷，不能将远端引用解释成已留存的完整历史。

本机 App Server schema 明确区分：[L1]。

| 字段 | schema 中的含义 | 本项目应采用的含义 |
| --- | --- | --- |
| `Thread.id` | 当前线程 ID | 单条上下文的身份 |
| `Thread.sessionId` | schema 描述为同一会话树中的共享会话 ID | 保留来源的归组线索；需与实际 HTTP 字段核对，不代替线程 ID |
| `parentThreadId` | 子 agent 的父线程 | 委派关系 |
| `forkedFromId` | fork 的来源线程 | 复制历史的来源，不等同于子 agent 父线程 |
| `ephemeral` | 是否仅在内存中保留 | 生命周期信息，不表示请求内容无需审计 |
| `source.subAgent` | review、compact、memory_consolidation 或 thread_spawn 等来源 | 分开标识内部任务与普通对话 |

本机 schema 中 `thread_spawn` 还包含 `parent_thread_id`、`depth`，以及可选的 agent 路径、昵称和角色。会话字段属于客户端提供的身份线索，不是权限或执行状态的认证。

### 2.2 Side 与普通 fork

官方文档区分两种入口：[O1、O2]。

- `/side`、`/btw` 建立当前聊天的临时 fork，side transcript 与父聊天分开；主聊天继续运行，结束 detour 后可以回到主聊天。side 内不能再开 side，也不能在 review 模式下使用。
- `/fork` 或 `codex fork` 复制聊天到一个新 ID，留下原聊天记录；这是另一条可以继续发展的聊天。
- App Server 的 `thread/fork` 可以复制到某个已完成 turn，或生成 `ephemeral: true` 的内存 fork。它是一次历史快照复制，不是实时共享父上下文；之后父与子分别追加内容。

Side 或 fork 第一份请求因此可能携带很多已经出现在父请求中的内容，但新增 side 问题仍必须展开。父聊天后来的输入不会自动进入已经分叉的那条上下文。

具体请求能否被标为“side”取决于载荷是否带有这种分类。仅发现一个 fork 来源，可以确认它是分叉，不能总能分清临时 side 与普通持久 fork。

### 2.3 子 agent

官方子 agent 文档确认每个 agent 有自己的线程、模型与工具工作，主线程收集其结果或摘要；各线程可以独立接收后续指令：[O3]。

本机程序包含 `fork_turns="all"` 与 `fork_turns="none"` 的能力说明：[L2]。

- `all` 携带父上下文历史；`none` 不携带周围历史，只以委派任务及自身配置启动。
- 不能只根据“这是一个子 agent”推断它一定继承全部主会话，也不能从共享工作目录推断共享模型上下文。
- 后续继续已有 agent 与新建另一个 agent 是两种行为；已有 agent 的历史继续在自己的线程中增长。

这些参数、默认值和可用工具可能随版本及客户端改变，方案按实际观察到的继承关系处理，不硬编码某个默认继承模式。

Codex hooks 的 `session_id` 对子 agent 使用父会话 ID，而 `agent_id` 才标识子 agent：[O4]。这是又一个“session ID 不等于单个 agent 上下文”的例子。Hooks 是另一个观测接口，不能假定这些字段都会原样出现在 HTTP 模型请求中。

### 2.4 本机实际请求验证

使用隔离的临时配置和本地模拟 Responses 上游，按 `主线程 → 临时 fork → 主线程继续 → 独立新线程` 执行了 4 个请求：[L3]。没有调用真实模型；临时 fork 使用 App Server 接口，未自动操作 TUI 的 `/side`。

用 A、B、C 代替实际 UUID，结果如下：

| 请求 | HTTP `session-id` | HTTP `thread-id` | turn metadata 的 `session_id` | fork 来源 | 正文中的探针输入 |
| --- | --- | --- | --- | --- | --- |
| 主线程首次输入 | A | A | A | 无 | 主输入 |
| `ephemeral` fork 首次输入 | A | B | B | A | 主输入 + fork 输入 |
| 主线程继续 | A | A | A | 无 | 主输入 + 主线程新输入 |
| 独立新线程 | C | C | C | 无 | 独立输入 |

额外发现：

- fork 的 `x-codex-turn-metadata` 携带 `thread_id`、`forked_from_thread_id` 和 `forked_from_ordinal_exclusive`。
- 主线程与 fork 的 `context_window_id` 相同，不能以 context window ID 唯一识别线程。
- 本例中 HTTP `session-id` 与 fork metadata 的 `session_id` 不同；不同接口中的同名字段不能未经核对就归一为一个意义。
- 本例 App Server 返回的 fork `Thread.sessionId` 也是 B，尽管 schema 将该字段描述为会话树共享 ID；HTTP `session-id` 则仍是 A。因此首版以实际观察到的 HTTP 归组信号和线程身份分别建模，不假定 schema 描述保证所有 fork 接口中的字段值一致。
- 本机程序中还存在 `x-codex-parent-thread-id` 和 `x-openai-subagent` 等字段的实现线索，但本次没有实际启动委派子 agent，不能宣称已经验证所有子 agent 的 HTTP 发包形式。

按当前项目的头部优先级，上表前三个请求会进入同一个 `sessionKey`。会话列表这样归组可以有用，但历史比较必须再按 A / B 分开，并单独记录 B 从 A 继承的前缀。

## 3. Claude Code

### 3.1 主会话、恢复与压缩

官方文档说明：[C1]。

- 普通新会话使用新上下文，不自动携带另一会话的对话历史；`CLAUDE.md`、auto memory、skills 等持久信息可以重新加载。
- `--continue`、`--resume` 在原会话 ID 下继续；`--fork-session` 或 `/branch` 复制历史到新 ID，原记录保持独立。
- 主上下文包含对话、已读文件、工具结果、项目规则、已加载技能和系统提示。
- 接近窗口上限时，先清理较早工具输出，再在需要时压缩摘要；不是每条请求都只在上一条正文末尾追加。

本机 `--help` 还记录了系统提示快照机制：启用时首个请求记录的提示可被后续请求及 resume 复用，直到 compact；关闭时每次重新生成。其启用范围由客户端能力决定：[L2]。因此系统提示通常稳定，但不能在服务端假定永久相同。

### 3.2 `/btw` Side 问答

Claude 的 `/btw` 不是普通委派子 agent：[C3]。

- 从主会话已经完成的消息、回答和工具结果作答；主会话仍在生成的那条回答不在其上下文中。
- 没有工具访问权限，side 的问题和回答不进入主会话历史。
- 后续 side 问题可以看到之前的 side 问答，终端每次回放最新 20 组；清除或退出后内存历史消失。
- VS Code 扩展使用独立面板，并有自己的持久化行为，不能将终端的退出生命周期套用到所有客户端。
- 用户可以把 side 问答转为具备完整工具访问的后台 fork；此后是新的上下文和能力状态，需要重新识别。

因此同一个用户工作会话中可能同时有：主上下文继续增长，以及“主上下文快照 + side 最近问答”组成的另一份请求上下文。

### 3.3 普通子 agent、fork 子 agent 与恢复

当前官方文档明确区分：[C1、C2]。

| 类型 | 启动上下文 | 后续历史与返回 |
| --- | --- | --- |
| 普通子 agent | 自己的系统提示、委派任务、适用项目规则、配置的技能等；不自动复制主对话 | 工具调用与结果留在自身上下文，向调用方返回摘要 |
| Fork 子 agent | 创建时复制主会话的完整消息历史、系统提示和工具定义 | 后续独立运行，工具过程不回填主会话，最终结果进入主会话 |
| Resume 已有子 agent | 恢复该 agent 自己之前的完整历史 | 沿用 agent ID，继续原工作 |
| 新建同类型子 agent | 新实例；不因类型或名称相同自动继承旧实例 | 新的出现身份，不合并为上一次调用 |

Fork 子 agent 可通过 `/subtask` 或 Agent 工具的 fork 类型启动；命令名称和交互默认值存在版本差异，不能把所有名为 fork 的机制混为一谈。技能中的 `context: fork` 在当前文档中指将技能放到隔离的子 agent 执行，启动时不携带当前对话；它与复制整个主会话的 conversation fork 有不同语义：[C2]。

子 agent 有单独的 transcript 和自动压缩机制。主会话 compact 不会替它压缩或重置历史；恢复主会话时可以恢复仍保留的子 agent。是否可恢复还取决于 agent 类型及留存状态，不能只根据一次完成通知判断它永久结束：[C2]。

当前文档还支持子 agent 继续委派子 agent，默认最多位于主会话以下三层，可通过 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 调整。每层仍有自己的上下文与委派关系；fork 不能再创建 fork，达到深度限制后的工具行为也有差别。不能沿用旧版本“子 agent 一律不能创建子 agent”的假设，也不能把多层结果通知当作完整上下文回填：[C2]。

Agent teams 的 teammate 是另一类完整独立会话：加载项目上下文与分配任务，主对话历史不自动继承；通信和任务共享不等于共享一份模型上下文：[C4]。

### 3.4 可观测标识与本机验证

Claude hooks 通过 `session_id`、`agent_id`、`agent_type` 区分会话和子 agent / teammate：[C5]。本机程序的 HTTP 请求构建还包含以下条件字段：[L2]。

| HTTP 字段 | 用途 |
| --- | --- |
| `X-Claude-Code-Session-Id` | 会话归组 |
| `x-claude-code-agent-id` | agent 实例 |
| `x-claude-code-parent-agent-id` | agent 的父实例 |
| `x-claude-code-agent-type` | 类型提示，不作为实例唯一身份 |
| `x-claude-code-request-class` | main、subagent、workflow、compaction、auxiliary、side_reply 等请求类别 |
| `x-claude-code-prompt-id` | 用户 prompt 的关联线索，不作为上下文身份 |

这些字段有条件地发送，不能要求每个第三方上游请求都携带全套字段。

使用本机 CLI 的 stream-json 控制接口、隔离配置和本地模拟 Messages 上游，执行 `主输入 → side_question → 主会话继续`：[L3]。

| 请求 | `X-Claude-Code-Session-Id` | 主输入 | Side 问题 | 主会话后续输入 |
| --- | --- | --- | --- | --- |
| 主会话首次请求 | S | 有 | 无 | 无 |
| Side 请求 | S | 有 | 有 | 无 |
| 主会话继续 | S | 有 | 无 | 有 |

本例三个请求都只带同一会话头，没有 agent ID 或 request class。Side 问题确实没有进入第三份正文。验证使用 side_question 控制接口，未自动操作终端 overlay，也没有实际运行委派子 agent。

这证明仅靠当前的会话头，网关有时无法准确给请求贴“主会话 / side”标签。字段缺失时需要保留“类型或上下文身份未识别”，不能根据文字内容、请求时间或模型名声称已经识别。

## 4. 对请求历史折叠与检测复用方案的修订

### 4.1 先保存分层身份

保留现有会话归组，并新增轻量上下文元数据：

```text
familyKey                 同配置与协议内的会话归组
contextKey                有可靠 thread / agent ID 时的上下文身份，否则未知
parentContextKey          明确的委派父上下文
forkedFromContextKey      明确的历史复制来源
forkBoundary              客户端报告的复制边界及其单位
contextKind               main / fork / side / subagent / compaction / auxiliary / unknown
identitySource            头部、metadata 或其他实际观察来源
```

Codex 优先用 `thread-id` 或可校验的 `x-codex-turn-metadata.thread_id` 识别上下文，单独保留会话头用于归组。Claude 在可靠 agent ID 存在时以会话 + agent ID 标识实例；没有这些信号时不把所有请求推定为主线程。

metadata 中的 boundary 可能是客户端内部日志 ordinal，不一定对应请求概览的第 N 项；需要验证映射后才能拿它划定可折叠范围。

### 4.2 历史比较依赖上下文关系

- **同一已识别上下文**：比较该上下文自己的前序请求，先匹配共同前缀，再处理明确的连续区间。
- **明确 fork / 继承关系**：新上下文首次请求中的相同继承部分可以折叠，标明来源；新增任务、fork 后改写的内容和后续独有消息展开。
- **普通子 agent / 独立新会话**：默认新上下文；相同项目规则或文字不证明已经继承主对话。
- **身份缺失的交错请求**：在同会话已留存候选中保守匹配明确相同的历史前缀，不用全会话“最后一条请求”替代唯一前驱，不据此补造分支类型或父子关系。无法确认的出现身份保持独立。
- **压缩、工具结果清理或历史回滚**：新摘要和变化条目属于新增内容；仍存在的完整相同条目可以复用，不把整条上下文判为“已经检查过”。

### 4.3 检测缓存与历史事件分开

同一会话归组中，不同上下文可以复用完全相同、依赖一致且已完成的单元检测模板，但每条请求都重建自己的证据位置。这样可以覆盖 fork 携带父内容、Claude side 回放主内容的重复计算，不要求先准确识别每一种客户端 UI。

缓存键必须包含内容、角色 / 检测阶段、工具及敏感字段上下文、规则 / 解析器版本和有效凭据集合等实际依赖。未来若加入整段对话推理规则，需要加入该规则所依赖的上下文，或不对它使用单元缓存。

检测缓存命中不证明是同一个历史事件：

- 可确认是历史携带或 fork 继承时，复用原出现身份并标注历史风险。
- 新的操作、不同 agent 的新调用、或者出现身份不明确时，保留新的风险关联，即使规则计算能够复用。
- 不将 side 的新问题、子 agent 的新任务、摘要中的新增风险隐藏在父会话已检查状态下。

### 4.4 请求类别与观测范围

会话轨迹可保留全部请求，同时给已识别的分支和辅助请求加标签。count_tokens、compaction、摘要生成或其他辅助请求不应增加“新增用户消息”统计，也不代表实际工具执行。

当前 Codex 代理支持 `/v1/responses`，没有实现 `/v1/responses/compact`；该端点也不在审计捕获列表中，见 `src/server.rs`。本方案不能宣称覆盖了未经过现有代理的压缩请求。首版可以正确处理后续正文中出现的压缩内容；新增 compact endpoint 的转发与审计属于独立协议工作，应另行确认范围。

首版不读取用户本地 transcript、不自动配置 hooks，也不接管 App Server。现有 HTTP 信号不足时明确显示未知。若以后需要完整的父子树、side 生命周期或压缩边界，再设计可选的客户端元数据接入，并独立评审其来源、版本和接入方式。

## 5. 新增验收场景

1. Codex 主线程 A 与 fork B 共享 HTTP 会话头，A / B 的历史仍独立；切回 A 不把 B 的新增输入归入 A。
2. Fork 首次继承的内容按实际相等条目折叠，fork 边界单位不匹配时不错误截取。
3. Codex 子 agent 的 all / none 继承模式、继续旧实例和新建同名实例分别处理。
4. Claude 主请求、side、主请求交错且只有一个会话头，新增 suffix 仍保持可见，side 问题不被误当作主历史。
5. Claude 普通子 agent、conversation fork、技能 context: fork 和 teammate 的初始上下文分别处理。
6. 主上下文与子 agent 分别压缩、恢复，不能使另一上下文的前驱或检查状态错误更新。
7. 字段缺失、旧版本、字段冲突、无 agent ID、并发请求和来源清理后，结果保守回退。
8. 同一检测模板跨分支复用时，风险位置仍指向当前请求；新的调用继续按新事件计数。

## 6. 依据与验证限制

官方资料已实际读取，以下链接用于核对具体结论：

- [O1：Codex CLI 命令、side、fork 与 compact](https://learn.chatgpt.com/docs/developer-commands)。
- [O2：Codex App Server 的 thread、turn 与 fork 接口](https://learn.chatgpt.com/docs/app-server)。
- [O3：Codex 子 agent 与线程管理](https://learn.chatgpt.com/docs/agent-configuration/subagents)。
- [O4：Codex hooks 的共享输入与 SubagentStart / SubagentStop](https://learn.chatgpt.com/docs/hooks)。
- [O5：Responses 压缩与 encrypted_content](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#compaction)。
- [C1：Claude Code 的会话、上下文与压缩](https://code.claude.com/docs/en/how-claude-code-works)。
- [C2：Claude 子 agent、fork、恢复与上下文管理](https://code.claude.com/docs/en/sub-agents)。
- [C3：Claude /btw 的 side 历史与工具边界](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)。
- [C4：Claude agent teams 的独立上下文](https://code.claude.com/docs/en/agent-teams)。
- [C5：Claude hooks 的 agent 与 session 标识](https://code.claude.com/docs/en/hooks)。

本机依据：

- L1：通过 `codex app-server generate-json-schema --experimental --out <临时目录>` 导出当前版本 schema，检查 Thread、SessionSource、SubAgentSource、ThreadForkParams 等定义。
- L2：检查已安装版本的 CLI 帮助及程序内嵌的工具能力、HTTP 头部构建逻辑。条件字段存在不等于每种上游都发送它。
- L3：本地模拟上游实际捕获了 Codex 4 次与 Claude 3 次请求，核对上下文回放及会话头；使用临时独立配置，没有调用真实模型。该验证不覆盖全部 CLI UI、真实委派、历史版本和远端提供方。

这份调研修订了原方案中“同一个 sessionKey 对应一条线性历史”的隐含假设。评审方案见 [请求历史折叠与风险检测复用方案](request-history-folding-and-inspection-reuse.md)。
