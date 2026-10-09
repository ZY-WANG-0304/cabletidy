# Claude Code 响应内容概览

## 调研

Messages 返回的 `content` 是内容块数组，包括文本、可读思考、不透明思考、客户端工具调用及服务端工具调用和结果。`tool_use.input` 是对象，`tool_use.id` 是调用标识；本轮调用不证明客户端已执行。`thinking.signature` 用于验证思考内容，不能当成思考正文；`redacted_thinking.data` 是不透明数据。

流式 Messages 不包含 Codex 那样的最终完整输出数组。必须按 `index` 累积 `content_block_start` / `content_block_delta` / `content_block_stop`；`text_delta.text`、`thinking_delta.thinking`、`signature_delta.signature`、`input_json_delta.partial_json` 分属不同字段。工具输入在内容块结束后解析为 JSON。`message_delta` 报告结束原因，`message_stop` 表示协议结束；`tool_use`、`max_tokens` 与 `end_turn` 有不同含义。`ping` 不产生输出条目，未知事件保留为其他内容并提示解析不完整。

官方依据（2026-10-09 实际读取）：

- [Messages API](https://platform.claude.com/docs/en/api/messages)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)

## 实现

在完成 [Codex 响应概览](codex-response-overview.md) 后扩展共享投影与界面。Claude 按内容块逐项展开完整文本、思考、工具输入和服务端结果；签名与引用、额外字段保留在完整结构中。不透明思考仅标示类型，不解密。独立“响应内容”页签显示结束原因及分类计数，位于“请求内容”和“原始内容”之间；响应每组 40 项，与请求分页独立。

流式投影分别拼接思考与签名，沿已有内容快照的 UTF-8 片段引用还原原始内容，并支持已留存工具输入变为结构化对象的情形。缺少内容块结束或消息结束、工具 JSON 无法完成、正文缺口和引用丢失均提示不完整。

详情的 `responseContent`、响应分页与原文入口、旧快照读取、独立只读线程与索引缓存沿用 Codex 机制；不改转发请求或响应，不写迁移记录，不重新调用模型。原文入口进入对应响应事件，可继续复核其中独立快照引用。

## 验证

HTTP 回归覆盖长中文与 emoji 内容、签名和不透明思考、引用额外字段、客户端与服务端工具、46 项分页、重启后的已有记录；流式回归覆盖不同增量字段、多段工具 JSON、思考与签名分离、心跳和结束原因。界面测试覆盖完整内容安全转义、响应与请求分页独立、响应原文定位和缺失 / 中断 / 空响应提示。

额外回归覆盖缺字段及错误类型的 delta：详情明确提示不完整，重复查询、请求分页和后续正常响应仍可读取。非流式业务对象不解析快照引用；流式仅还原留存改写的字段并校验完整格式与来源，不递归替换自定义工具参数中的 `contentSnapshotId` 等同名业务字段。

Rust 回归另覆盖旧快照状态、缺口、取消、未知事件及大量页外嵌套字段不进入索引。全量 `npm test` 通过。浏览器验收使用真实本地网关和模拟上游，在桌面与 390px 窄屏验证完整长响应、推理 / 思考及工具调用、五个同级页签的顺序、响应与请求独立分页及切换后保留分页、响应原文精确定位、安全转义与无横向溢出；并复核原有请求与风险导航。此验收未连接真实远端模型服务。

验收截图：[桌面](screenshots/claude-response-overview.png)、[手机](screenshots/claude-response-overview-mobile.png)。
