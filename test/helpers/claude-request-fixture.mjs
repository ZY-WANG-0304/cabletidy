// Messages wire context shared by HTTP and real-browser overview checks.
export function claudeRequestFixture({ history = 0 } = {}) {
  return {
    system: [
      { type: "text", text: "你是编程助手。保留已有修改并验证工具结果。", cache_control: { type: "ephemeral", ttl: "1h" } },
      { text: "遵循仓库规范，先阅读文件再修改。", type: "text" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "检查请求概览为什么遗漏工具上下文。" }] },
      { content: [
        { type: "thinking", thinking: "先检查解析器和概览的数据来源。", signature: "opaque-signature" },
        { data: "encrypted-thinking-data", type: "redacted_thinking" },
        { type: "text", text: "正在读取解析器。" },
        { type: "tool_use", id: "read-source", name: "Read", input: { text: "保留参数 JSON 的键", file_path: "src/security/content.rs" } },
        { type: "tool_use", id: "run-check", name: "Bash", input: { command: "cargo check" } },
        { type: "server_tool_use", id: "srvtoolu_docs", name: "web_search", input: { query: "Messages tool_result" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_docs", content: [{ type: "web_search_result", title: "Messages 文档", url: "https://platform.claude.com/docs/en/api/messages", encrypted_content: "encrypted-citation" }] },
        ...Array.from({ length: history }, (_, i) => ({ type: "text", text: `已保留历史模型文本块 ${i + 1}` })),
      ], role: "assistant" },
      { content: [
        { type: "tool_result", tool_use_id: "read-source", content: [
          { type: "text", text: "解析器已经按内容块读取。" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "opaque-image" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "opaque-document" } },
          { type: "tool_reference", tool_name: "Edit" },
        ], is_error: false, cache_control: { type: "ephemeral" } },
        { type: "tool_result", tool_use_id: "run-check", content: "客户端报告：检查失败，需要继续修复。", is_error: true },
        { type: "text", text: "请结合截图和文档继续检查。<script>literal</script>" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "opaque-image" } },
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "opaque-document" } },
        { type: "future_block", payload: { value: "未识别内容仍保留原文" } },
        { type: "tool_result", tool_use_id: "absent-call", content: "本次请求只有这条结果，没有调用。" },
      ], role: "user" },
    ],
    tools: [
      { name: "Read", description: "读取项目文件", input_schema: { type: "object", properties: { file_path: { type: "string" } } }, cache_control: { type: "ephemeral" } },
      { name: "Bash", description: "执行命令", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ],
  };
}
