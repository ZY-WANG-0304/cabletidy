# Codex 请求内容概览

## 调研结论

Codex 的模型提供方使用 Responses 协议。一次请求的 `input` 是模型上下文，可能同时包含多条用户消息、系统或开发者指令、历史模型消息、推理、工具调用和工具结果，也可能只有工具结果或为空。不能将最后一条用户消息视为请求的全部内容。

顶层 `instructions` 与 `input` 中的消息是两个独立的指令来源；`tools` 声明可用工具，不表示模型已经调用它们。Responses 的 `function_call` / `function_call_output` 是独立条目，以 `call_id` 对应。Codex 的补丁等自定义工具使用 `custom_tool_call.input`，其输入是自由文本，不必是 JSON；结果使用 `custom_tool_call_output.output`。

官方依据（2026-10-09 查阅）：

- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：`model_providers.<id>.wire_api` 使用 `responses`。
- [Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)：Messages 与 Items 的区别、顶层 `instructions`、多轮历史和推理项。
- [函数与自定义工具](https://developers.openai.com/api/docs/guides/function-calling)：多个函数调用、`call_id` 关联、字符串或结构化结果、自定义工具的自由文本输入。

## 已实现的展示

会话轨迹的右侧“概览”增加“请求内容”区域。按保留正文中的顺序列出内容，并统计下列类型：

| 请求结构 | 概览分类与内容 |
| --- | --- |
| 顶层 `instructions`、`input` 中 `role: system` | 系统提示词 |
| `role: developer` | 开发者指令 |
| 字符串 `input`、`role: user` | 每一条用户输入；保留消息内的多个文本片段 |
| `role: assistant` | 历史模型消息，与本轮响应分开 |
| `function_call.arguments`、`custom_tool_call.input` | 历史工具调用，展示工具名称、参数及调用标识 |
| `function_call_output.output`、`custom_tool_call_output.output` | 工具结果；按完整 `call_id` 关联本次请求中对应调用，支持跨页 |
| `reasoning`、`compaction` | 可读推理摘要或压缩上下文；加密内容单独标示 |
| `previous_response_id`、`conversation`、`item_reference` | 历史引用；提示其内容未包含在本次正文中 |
| 顶层 `tools` | 单独折叠的可用工具定义 |
| 图片、文件、音频、视频 | 类型标记，原始载荷通过原文复核 |
| 未识别条目 | 其他内容，完整展示保留结构和原文入口 |

工具调用和结果都缺失时数量显示为零。只有工具结果时不补造用户输入。找不到对应调用、找不到结果或调用标识重复时明确提示；匹配只在本次请求内进行，不根据工具名猜测或跨请求补造结果。客户端报告的结果不证明真实执行状态。

每组最多 40 项，长请求可以继续分页。每项默认展开，文本、工具参数与结果完整展示，不设字符或字节截断上限；工具定义完整展示 JSON，额外字段、非文本载荷和思考签名可在“完整内容结构”中展开查看。标题行右侧的“查看此项原文”按钮通过原文范围和结构位置定位，收起此项后也可使用。工具定义分组单独折叠，避免大量工具声明掩盖对话。

## 数据与边界

概览从已留存的请求正文只读生成，不改变代理载荷，也不新增审计记录、改变风险检测或调用模型。逐块读取正文，只收集当前页各项的完整内容，不累积页外正文或整个长请求；单项和本页的内存与返回大小会随实际内容增长。请求详情返回首组内容和全部已解析类型的计数；`GET /api/v1/security/audit/<id>/content?offset=40` 获取后续组。请求列表仍只读取轻量元数据。

概览使用独立的只读 SQLite 连接与线程，最多执行一项解析并排队四项；队列满立即返回繁忙，等待超过 30 秒或调用取消时停止扫描，不占用审计读写队列。首次扫描建立条目范围、角色和工具关联索引，缓存命中时，后续详情与翻页只读取当前页的正文范围，不重复扫描整份正文或二次扫描工具关联。索引按快照 manifest 校验更新，最多缓存 8 份、按序列化元数据计 8 MiB，不缓存正文；超出缓存预算的索引仅用于本次读取。

已有分段正文和旧格式正文快照都可生成概览，不需要重新请求或写入迁移数据。未保留正文时显示无法还原；正文缺口、未结束或解析失败时只展示已完成条目，并提示内容不完整。旧快照即使有可解析的 JSON，也只有原状态为 `complete` 时才显示完整；`truncated`、`partial`、`interrupted` 或缺少状态均提示不完整。加密推理不尝试解密，图片等载荷不推断语义；历史引用不自动拉取远端上下文。[Claude Code 请求概览](claude-request-overview.md) 使用同一分页和原文定位机制，按 Messages 内容块解析工具上下文。

## 验证

Rust 测试覆盖任意字段顺序、角色与多文本内容、函数及自定义工具、结构化结果、完整长文本、分页计数、旧格式快照及其不完整状态、分段读取与正文缺口、缓存失效、跨页索引复用、扫描取消以及审计队列隔离。HTTP 测试验证跨页长内容、关联、重启后已有记录、原文字节定位、参数校验以及代理载荷与记录数量。页面测试验证逐项完整展示、安全转义、标题原文入口、分页和原文跳转；浏览器验收覆盖桌面与 390px 窄屏的混合 Codex 请求。

发布构建在本地模拟的 72 MiB 分段留存正文上复测：4 次并发详情均返回 200，约 0.48 秒；期间列表约 1.1 ms，重复详情约 1.9 ms、后续页约 0.8 ms。同期独立 SQLite 连接写入记录与正文约 1.2 ms；Store 队列隔离另有确定性回归验证。该样本的大字段在当前页条目之外，用于验证扫描隔离和索引复用；实际延迟随机器、条目数量及本页内容大小变化。

验收截图：[桌面概览](screenshots/codex-request-overview.png)、[手机概览](screenshots/codex-request-overview-mobile.png)。
