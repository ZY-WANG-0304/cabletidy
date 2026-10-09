# Codex 响应内容概览

## 调研

Responses 的 `output` 是按顺序排列的输出条目，可以包含模型消息、推理摘要及加密推理、函数调用、自定义工具调用和服务端工具等。函数调用的 `arguments` 是 JSON 字符串，自定义工具 `input` 可以是自由文本；工具调用表示模型提议，不证明客户端已执行。

流式响应使用 SSE 语义事件。`output_index` 区分输出，`content_index` / `summary_index` 区分正文和推理片段；增量、字段完成、条目完成以及最终 `response.completed` 中的同一内容不能重复展示。`response.failed` / `response.incomplete` 也是协议结束事件，结束不等于模型成功完成。

官方依据（2026-10-09 实际读取）：

- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Streaming function calls](https://developers.openai.com/api/docs/guides/function-calling#streaming)

## 实现

右侧详情增加独立“响应内容”页签，位于“请求内容”和“原始内容”之间，与“概览”“风险”同级；与请求一样默认展开完整文本、工具参数和自由文本输入，提供分类计数、每组 40 项分页、完整结构与原文入口。优先采用最终响应的输出数组，其次采用完成条目；缺少最终条目时按输出和内容索引合并增量，标示未完整返回。推理不透明字段不解密，额外字段保留在完整结构中。

现有流式留存将可读内容替换为 `contentSnapshotId` 和解码后的 UTF-8 范围。投影解析事件元数据，按引用只读加载对应内容快照并还原内容；原文入口定位保留的响应事件，可继续通过原始内容中的引用查看独立快照。不改代理载荷、不增加审计记录、不重新调用模型。已有记录无需迁移。

详情增加 `responseContent`，独立分页入口是 `GET /api/v1/security/audit/<id>/response-content?offset=40`。请求入口保持兼容。列表不加载内容。复用独立只读工作线程、有界队列、超时和取消；响应索引仅缓存元数据及范围，最多 8 份、8 MiB，manifest 变化时失效。分页只实体化当页内容及其引用，单项内存随内容长度增长。非流式 JSON 按输出条目扫描，SSE 分段读取且不累积完整事件正文。

正文缺口、缺少结束事件、未留存引用内容、旧快照不完整状态均明确提示。失败状态与正文留存完整性分别展示。

## 验证

HTTP 回归覆盖长中文与 emoji 文本、推理与拒绝、函数及自定义工具、43 项分页、原文范围、重启后读取、只读及参数校验；流式回归覆盖完整快照引用、增量和最终输出去重，以及缺少结束事件时的已收到文本。

Rust 回归另覆盖旧快照状态、缺口、取消、未知事件及大量页外嵌套字段不进入索引。全量 `npm test` 通过。浏览器验收使用真实本地网关和模拟上游，在桌面与 390px 窄屏验证完整长响应、推理 / 思考及工具调用、五个同级页签的顺序、响应与请求独立分页及切换后保留分页、响应原文精确定位、安全转义与无横向溢出；并复核原有请求与风险导航。此验收未连接真实远端模型服务。

验收截图：[桌面](screenshots/codex-response-overview.png)、[手机](screenshots/codex-response-overview-mobile.png)。
