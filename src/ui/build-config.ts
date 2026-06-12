/**
 * Build adapter configuration from UI form values — translates Paperclip's
 * CreateConfigValues into the stored adapterConfig. Model, provider and
 * reasoning effort are resolved by Hermes from ~/.hermes/config.yaml, so the
 * universal Model / Thinking effort fields are not forwarded.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { DEFAULT_TIMEOUT_SEC } from "../shared/constants.js";

export function buildHermesConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // Model & provider come from Hermes config.yaml; not forwarded.

  // Execution limits.
  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (v.maxTurnsPerRun > 0) {
    ac.maxTurnsPerRun = v.maxTurnsPerRun;
    // ~20s per tool turn, never below the 30-min default.
    ac.timeoutSec = Math.max(DEFAULT_TIMEOUT_SEC, v.maxTurnsPerRun * 20);
  }

  ac.persistSession = true;

  if (v.cwd) ac.cwd = v.cwd;
  if (v.command) ac.hermesCommand = v.command;
  if (v.extraArgs) ac.extraArgs = v.extraArgs.split(/\s+/).filter(Boolean);

  // Reasoning effort comes from Hermes config.yaml; not forwarded.

  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;

  return ac;
}

/**
 * Declarative fields for the Paperclip Configuration tab. Paperclip calls
 * `GET /api/adapters/<type>/config-schema` → `adapter.getConfigSchema()`.
 * Field shape: { key, label, type: "text"|"textarea"|"select"|"toggle",
 * default?, hint?, options? }.
 */
export async function getConfigSchema() {
  return {
    fields: [
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
          "When the agent has a saved session id from a previous wake, should this one resume it? 'Auto' resumes when possible. 'Never' starts a fresh Hermes session every wake — useful for debugging or one-shot agents.",
      },
      {
        key: "debug",
        label: "Debug (verbose Hermes output)",
        type: "toggle" as const,
        default: false,
        hint:
          "When ON, passes -v to Hermes for verbose stdout/stderr. Useful when wakes fail silently. The plugin still filters known-noisy lines so the Run page stays readable; you'll see tool I/O and reasoning summaries you wouldn't see normally.",
      },
    ],
  };
}
