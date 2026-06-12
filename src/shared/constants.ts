/**
 * Shared constants — fork of hermes-paperclip-adapter@0.3.0 (Nous Research).
 * Same identifiers used so Paperclip resolves us as the override for the
 * built-in hermes_local registration.
 */

/** Adapter type identifier — matches the built-in hermes_local to enable override. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/**
 * Default CLI command used when the Configuration tab's "Command" field is
 * left blank. Points at the canonical mount target the bento install creates
 * via `graft_external_volumes_to_service`: `hermes_hermes-bin` (named volume
 * owned by the hermes stack) is grafted onto the paperclip service at
 * `/opt/hermes`, so `/opt/hermes/bin/hermes` is the real binary at runtime.
 *
 * Absolute path — independent of `PATH`. If the mount isn't present, the
 * spawn fails with a clear "ENOENT: /opt/hermes/bin/hermes" instead of a
 * vague "command not found" that could mean PATH was unset.
 */
export const HERMES_CLI_DEFAULT = "/opt/hermes/bin/hermes";

/** Backwards-compat alias kept for the test entrypoint. */
export const HERMES_CLI = HERMES_CLI_DEFAULT;

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Default model to use if none specified. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/**
 * Default toolsets passed to `hermes chat -t ...` when the agent leaves
 * the toolsets field blank in the UI.
 *
 * v0.1.8 — expanded from the timid v0.1.7 `terminal,skills` to a powerful
 * default that matches Hermes' own "enabled by default" set. People who
 * pick Hermes Agent want the power — capping it at 2 toolsets crippled
 * the agent compared to running `hermes chat` directly on the host.
 *
 * Hermes ships ~25 toolsets total (`hermes tools list`); these 11 are the
 * operational core for an autonomous agent:
 *   terminal       — shell, processes
 *   skills         — Paperclip-managed skill_view / skills_list (CRITICAL —
 *                    syncSkills() materialises symlinks that depend on this)
 *   web            — web search & scraping (Exa/Tavily/Firecrawl backends)
 *   browser        — full browser automation (Browserbase/Browser Use)
 *   file           — file system operations
 *   code_execution — sandboxed code runner
 *   memory         — long-term memory across sessions
 *   todo           — task planning state machine
 *   vision         — image analysis
 *   session_search — search prior session transcripts
 *   delegation     — spawn sub-agents
 *
 * Aluno avançado who wants something narrower (e.g. terminal-only for an
 * unattended script worker) overrides via the Toolsets field on the
 * Configuration tab. Aluno leigo gets a powerful agent by default.
 *
 * NOT enabled by default (require explicit opt-in):
 *   video, video_gen, image_gen — heavy / generative, can be expensive
 *   x_search                    — paid Twitter API
 *   moa, context_engine         — experimental
 *   homeassistant, spotify      — niche integrations
 *   computer_use                — macOS-only, doesn't make sense in container
 *   yuanbao                     — provider-specific
 *   tts                         — text-to-speech, mostly noise in agent runs
 *   cronjob, messaging, clarify — useful but Hermes-daemon-side concepts
 */
export const DEFAULT_TOOLSETS =
  "terminal,skills,web,browser,file,code_execution,memory,todo,vision,session_search,delegation";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 */
export const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Model-name prefix → provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  ["claude", "anthropic"],
  ["gemini", "auto"],
  ["hermes-", "nous"],
  ["glm-", "zai"],
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  ["minimax", "minimax"],
  ["deepseek", "auto"],
  ["llama", "auto"],
  ["qwen", "auto"],
  ["mistral", "auto"],
  ["huggingface/", "huggingface"],
];

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "┊";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "💭";
