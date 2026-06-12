/**
 * Build adapter configuration from UI form values.
 *
 * Translates Paperclip's CreateConfigValues into the adapterConfig
 * object stored in the agent record.
 *
 * NOTE: Provider resolution happens at runtime in execute.ts, not here.
 * The UI may or may not pass a provider field. If it does, we persist it
 * as the user's explicit override. If not, execute.ts will detect it from
 * ~/.hermes/config.yaml at runtime.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import {
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_TOOLSETS,
} from "../shared/constants.js";

import { listProviders } from "../server/index.js";

/**
 * Build a Hermes Agent adapter config from the Paperclip UI form values.
 */
export function buildHermesConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // Model
  if (v.model.trim()) {
    ac.model = v.model.trim();
  }

  // NOTE: Provider is NOT set here because the Paperclip UI form
  // (CreateConfigValues) does not expose a provider field.
  // Instead, provider is resolved at runtime in execute.ts using
  // a priority chain:
  //   1. adapterConfig.provider (if set via API directly)
  //   2. ~/.hermes/config.yaml detection
  //   3. Model-name prefix inference
  //   4. "auto" fallback
  // This ensures correct provider routing even for agents created
  // before provider tracking existed.

  // Execution limits — let the user configure these from the Paperclip UI.
  // timeoutSec: wall-clock kill timeout for the hermes child process.
  // maxTurnsPerRun: maps to Hermes's --max-turns (agent tool-calling iterations).
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (v.maxTurnsPerRun > 0) {
    ac.maxTurnsPerRun = v.maxTurnsPerRun;
    // Scale timeout to match: ~20s per tool turn is generous headroom.
    // Never go below the default (1800s / 30 min).
    ac.timeoutSec = Math.max(DEFAULT_TIMEOUT_SEC, v.maxTurnsPerRun * 20);
  }

  // Session persistence (default: on)
  ac.persistSession = true;

  // Working directory
  if (v.cwd) {
    ac.cwd = v.cwd;
  }

  // Custom hermes binary path
  if (v.command) {
    ac.hermesCommand = v.command;
  }

  // Extra CLI arguments
  if (v.extraArgs) {
    ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);
  }

  // v0.1.8 AUDIT — `thinkingEffort` field used to push
  // `--reasoning-effort <val>` into extraArgs. Hermes CLI (`chat --help`)
  // has NO such flag — it's only honoured via `~/.hermes/config.yaml`
  // `model.reasoning_effort` (or the per-provider variant). The CLI arg
  // was silently dropped by Hermes's argparse, so the field never had
  // any effect. We stop emitting it. Aluno avançado who needs to change
  // reasoning_effort still edits config.yaml; a UI-driven solution is
  // tracked as Sprint #189 follow-up.

  // Prompt template
  if (v.promptTemplate) {
    ac.promptTemplate = v.promptTemplate;
  }

  // Heartbeat config is handled by Paperclip itself

  return ac;
}

/**
 * v0.1.7 — `getConfigSchema()` for the Paperclip Configuration tab.
 *
 * Paperclip's UI calls `GET /api/adapters/<type>/config-schema`, which in
 * turn calls `adapter.getConfigSchema()` on the registered adapter object
 * (see `/app/server/dist/routes/adapters.js:498`). The function MUST be
 * named exactly that on the adapter — `agentConfigurationSchema` was a
 * red herring; it isn't read by anything.
 *
 * Verified shape (mirrors `@paperclipai/adapter-cursor-cloud`):
 *
 *   {
 *     fields: [{
 *       key:       string,           // adapterConfig key the field writes to
 *       label:     string,           // UI label
 *       type:      "text" | "select" | "toggle",   // observed values
 *       required?: boolean,
 *       default?:  string | boolean, // NOT "defaultValue"
 *       hint?:     string,           // NOT "description"
 *       options?:  [{ value, label }] // only for type: "select"
 *     }]
 *   }
 *
 * Aluno-leigo note: a "textarea" type was NOT observed in any built-in
 * adapter. We use plain "text" — even multi-line content survives there,
 * just gets rendered in a single-line input. Trade-off accepted: real
 * UI for the field, ugly for long content. Advanced users that paste
 * multi-line templates can still set them via `PATCH adapterConfig`.
 */
export async function getConfigSchema() {
  // Dynamic Provider options: built from Hermes config.yaml + auth.json at
  // schema-fetch time so the aluno only sees providers their install can
  // actually route to. Falls back to a minimal Auto/Custom pair if Hermes
  // state is unreadable for any reason (fresh install, perms, etc.).
  let providerOptions: Array<{ value: string; label: string }>;
  try {
    const detected = await listProviders();
    providerOptions = detected.map((p) => ({ value: p.id, label: p.label }));
    if (!providerOptions.find((o) => o.value === "auto")) {
      providerOptions.unshift({ value: "auto", label: "Auto (Hermes default)" });
    }
    if (!providerOptions.find((o) => o.value === "custom")) {
      providerOptions.splice(1, 0, {
        value: "custom",
        label: "Custom (OpenAI-compatible)",
      });
    }
  } catch {
    providerOptions = [
      { value: "auto", label: "Auto (Hermes default)" },
      { value: "custom", label: "Custom (OpenAI-compatible)" },
    ];
  }

  return {
    fields: [
      // ───────── Provider selection ─────────
      {
        key: "provider",
        label: "Provider",
        type: "select" as const,
        default: "auto",
        options: providerOptions,
        hint:
          "Which inference provider Hermes should route to. 'Auto' lets Hermes resolve from ~/.hermes/config.yaml. 'Custom' exposes the OpenAI-compatible fields below — use it for Together AI, Groq, Fireworks, Ollama, vLLM, OpenRouter, or any custom endpoint that speaks the OpenAI Chat Completions API. Built-in entries (Z.AI, Anthropic, etc.) appear here automatically when configured in Hermes.",
      },
      {
        key: "customProviderBaseUrl",
        label: "Custom Provider — Base URL",
        type: "text" as const,
        default: "",
        hint:
          "Only used when Provider = Custom. Example: https://api.together.xyz/v1 (Together AI), https://api.groq.com/openai/v1 (Groq), http://ollama:11434/v1 (local Ollama). Must include the /v1 suffix.",
      },
      {
        key: "customProviderApiKey",
        label: "Custom Provider — API Key",
        // Paperclip's "secret" type masks the value in the UI and stores
        // encrypted at rest. Plus we accept `${SECRET_NAME}` references
        // resolved from Paperclip company-level secrets (managed via the
        // Environment Variables row above + Seal). One secret can serve
        // many agents — best practice for multi-agent deployments.
        type: "secret" as const,
        default: "",
        hint:
          "API key for the Custom provider. Best practice: reference a Paperclip company secret as ${TOGETHER_API_KEY} (or whatever name you used in the Environment Variables row). Plaintext also works but is harder to rotate across many agents.",
      },
      {
        key: "customProviderModelOverride",
        label: "Custom Provider — Model",
        type: "text" as const,
        default: "",
        hint:
          "Model id the Custom provider serves (e.g. meta-llama/Llama-3-70b-chat-hf, llama-3.1-70b-versatile, gemma-7b-it). When Provider = Custom, this OVERRIDES the Model select above.",
      },
      {
        key: "customProviderHeaders",
        label: "Custom Provider — Extra headers (JSON)",
        type: "textarea" as const,
        default: "",
        hint:
          "Optional JSON object of extra HTTP headers for the Custom provider. Example: {\"X-Title\": \"my-app\", \"HTTP-Referer\": \"https://example.com\"}. Header values may use ${SECRET_NAME} references.",
      },

      // ───────── Heartbeat template behaviour ─────────
      {
        key: "heartbeatTemplateMode",
        label: "Heartbeat template mode",
        type: "select" as const,
        default: "auto",
        options: [
          { value: "auto", label: "Auto (smart pick from AGENTS.md)" },
          { value: "light", label: "Light (persona drives)" },
          { value: "full", label: "Full (Paperclip workflow)" },
          { value: "custom", label: "Custom (use Prompt template field)" },
        ],
        hint:
          "How the plugin chooses the system prompt template. Auto = light template when AGENTS.md has substantive content (>200 chars), otherwise the full Paperclip heartbeat. Force 'Light' to skip issue listing even with empty AGENTS.md. Force 'Full' to inject the workflow even when AGENTS.md is rich. 'Custom' uses the Prompt template field verbatim.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template (advanced)",
        type: "textarea" as const,
        default: "",
        hint:
          "Override the heartbeat prompt sent to Hermes. Leave empty to use the plugin's auto-detection (see Heartbeat template mode). Variables: {{agentName}}, {{agentId}}, {{companyId}}, {{runId}}, {{taskId}}, {{taskTitle}}, {{taskBody}}, {{paperclipApiUrl}}. Conditional blocks: {{#taskId}}…{{/taskId}}, {{#noTask}}…{{/noTask}}, {{#commentId}}…{{/commentId}}.",
      },

      // ───────── Hermes runtime knobs (CLI-honest) ─────────
      {
        key: "toolsets",
        label: "Toolsets (comma-separated)",
        type: "text" as const,
        default: DEFAULT_TOOLSETS,
        hint:
          "Comma-separated list of toolsets Hermes activates for this agent. Default is a powerful set matching what 'hermes chat' enables on the host. Operational core: terminal, skills, web, browser, file, code_execution, memory, todo, vision, session_search, delegation. Optional add-ons: image_gen, tts, video, video_gen, x_search, moa, context_engine, homeassistant, spotify, computer_use, yuanbao, cronjob, messaging, clarify. Remove what you don't need to narrow the agent's capabilities.",
      },
      {
        key: "sessionResume",
        label: "Session resume",
        type: "select" as const,
        default: "auto",
        options: [
          { value: "auto", label: "Auto (resume previous when available)" },
          { value: "never", label: "Never (always start fresh)" },
        ],
        hint:
          "When the agent has a saved session id from a previous wake, should this one resume it? Default 'Auto' resumes when possible (matches v0.1.7 persistSession=true). 'Never' starts a fresh Hermes session every wake — useful for debugging or one-shot agents.",
      },
      {
        key: "debug",
        label: "Debug (verbose Hermes output)",
        type: "toggle" as const,
        default: false,
        hint:
          "When ON, passes -v to Hermes for verbose stdout/stderr. Useful when wakes fail silently. The plugin still filters known-noisy lines so the Run page stays readable; you'll see tool I/O and reasoning summaries you wouldn't see normally.",
      },
      {
        key: "skipApprovalPrompts",
        label: "Skip approval prompts (--yolo)",
        type: "toggle" as const,
        default: true,
        hint:
          "When ON (default), passes --yolo so the agent can run any shell command (curl, bash, file ops, etc.) without confirmation. Required for autonomous wakes: in non-interactive mode Hermes auto-DENIES every command after a TTY-prompt timeout, so the agent can't update issues, list backlogs, or post comments. Turn OFF only if you want Hermes' default conservative posture and accept that wakes will block on every shell call.",
      },
    ],
  };
}
