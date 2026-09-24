// Reviewed against Anthropic's public docs; update this snapshot with releases.
// Suggestions only: never use this catalog to validate or route model requests.
export const CLAUDE_MODEL_CATALOG = {
  updatedAt: "2026-09-23",
  sources: [
    "https://platform.claude.com/docs/en/about-claude/models/overview",
    "https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions",
    "https://platform.claude.com/docs/en/models/opus-4-5/overview",
    "https://platform.claude.com/docs/en/models/sonnet-4-5/overview",
    "https://code.claude.com/docs/en/model-config",
  ],
  models: [
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-opus-4-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5",
  ],
};

// Reviewed 2026-09-24. Keep startup modes separate from documented subagent aliases.
// https://code.claude.com/docs/en/model-config#model-aliases
// https://code.claude.com/docs/en/model-config#opusplan-model-setting
// https://code.claude.com/docs/en/sub-agents#choose-a-model
// `default` is a reset, and subagent `inherit` equals unset; the UI uses an empty value.
export const CLAUDE_MODEL_ALIASES = {
  defaultModel: ["best", "opus", "sonnet", "fable", "haiku", "opusplan"],
  subagent: ["opus", "sonnet", "fable", "haiku"],
};
