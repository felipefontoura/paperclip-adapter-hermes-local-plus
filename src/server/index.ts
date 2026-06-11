/**
 * Server-side adapter module exports — mirrors hermes-paperclip-adapter@0.3.0
 * shape so any Paperclip codepath that imports our package gets the same
 * function names.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import jsYaml from "js-yaml";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  detectModel,
  parseModelFromConfig,
  resolveProvider,
  inferProviderFromModel,
} from "./detect-model.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";

// ---------------------------------------------------------------------------
// listModels — populate the Model combobox in Paperclip's Configuration tab
// from Hermes' on-disk state. No hardcoded model names: we read what THIS
// install of Hermes was actually configured with.
//
// Mirrors Hermes' OFFICIAL resolution chain (per Nous Research docs):
//   1. CLI args (`-m <model>` / `--provider <p>`)       [enforced by execute.ts]
//   2. `~/.hermes/config.yaml` — `model.default`, `model.provider`,
//      `custom_providers[].model`
//   3. `~/.hermes/.env` — `HERMES_MODEL`
//   4. Built-in default (Hermes falls back to anthropic/claude-sonnet-4 —
//      will fail without Anthropic creds, which is the install's problem,
//      not ours)
//
// We surface every model the user already configured (steps 2 + 3) so the
// combobox is honest. We do NOT make up models the user didn't pick.
//
// The Paperclip UI dedupes by `id`, so duplicates across sources are fine.
// ---------------------------------------------------------------------------

interface HermesConfigYaml {
  model?: { default?: string; provider?: string };
  custom_providers?: Array<{ name?: string; model?: string }>;
}

interface HermesAuthJson {
  credential_pool?: Record<string, unknown>;
}

async function readJsonOrYamlFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (filePath.endsWith(".json")) {
      return JSON.parse(raw) as T;
    }
    return jsYaml.load(raw) as T;
  } catch {
    return null;
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function listModels(): Promise<Array<{ id: string; label: string }>> {
  const home = process.env.HOME || os.homedir();
  const hermesDir = path.join(home, ".hermes");
  const [config, auth] = await Promise.all([
    readJsonOrYamlFile<HermesConfigYaml>(path.join(hermesDir, "config.yaml")),
    readJsonOrYamlFile<HermesAuthJson>(path.join(hermesDir, "auth.json")),
  ]);

  const out = new Map<string, { id: string; label: string }>();
  const push = (id: string, label: string) => {
    if (!out.has(id)) out.set(id, { id, label });
  };

  // 1) Default model from config.yaml (the one Hermes uses when `-m` is omitted).
  const defaultModel = asString(config?.model?.default);
  const defaultProvider = asString(config?.model?.provider);
  if (defaultModel) {
    const label = defaultProvider
      ? `${defaultModel} (${defaultProvider} · default)`
      : `${defaultModel} (default)`;
    push(defaultModel, label);
  }

  // 2) Models exposed by each custom_provider entry.
  const customProviders = Array.isArray(config?.custom_providers)
    ? (config!.custom_providers as Array<Record<string, unknown>>)
    : [];
  for (const cp of customProviders) {
    const model = asString(cp.model);
    const providerName = asString(cp.name);
    if (model) {
      const label = providerName ? `${model} (${providerName})` : model;
      push(model, label);
    }
  }

  // 3) `~/.hermes/.env` — HERMES_MODEL is the env-override channel of the
  // official resolution chain. Honour it.
  const envOverride = await readEnvVariable(path.join(hermesDir, ".env"), "HERMES_MODEL");
  if (envOverride) {
    push(envOverride, `${envOverride} (.env)`);
  }

  // Silently drop the auth.json credential_pool here. Those are PROVIDERS,
  // not models — leaving them in the combobox poisoned the picker with
  // unusable entries (e.g. "zai (no model pinned)" can't be passed via
  // `-m` because Hermes expects a model id, not a provider key). The
  // honest behaviour is: only show what config.yaml/.env actually pinned.
  // The "Default" entry covers everything else by skipping `-m`.
  void auth;

  return Array.from(out.values());
}

// v0.1.8 — listProviders() populates the Provider select on the
// Configuration tab. Same pattern as listModels(): zero hardcoded names,
// reads Hermes' on-disk config + auth state, returns only what THIS
// install can actually route to.
//
// First two entries are always:
//   - Auto    → Hermes resolves provider from config.yaml + model name
//   - Custom  → reveals the OpenAI-compatible Custom Provider form fields
//                (URL / API Key / Model / Headers) — see execute.ts handling.
//
// Then we surface each custom_providers[] entry from config.yaml AND any
// authenticated credential pool key in auth.json that maps to a known
// built-in provider. Duplicates collapse by id.
const BUILTIN_PROVIDER_LABELS: Record<string, string> = {
  "openai-codex": "OpenAI (Codex Plus)",
  "openai-api": "OpenAI-compatible",
  "anthropic": "Anthropic",
  "openrouter": "OpenRouter",
  "nous": "Nous Research",
  "copilot": "GitHub Copilot",
  "copilot-acp": "GitHub Copilot (ACP)",
  "huggingface": "Hugging Face",
  "zai": "Z.AI",
  "kimi-coding": "Moonshot / Kimi",
  "minimax": "MiniMax",
  "minimax-cn": "MiniMax CN",
  "kilocode": "Kilocode",
};

export async function listProviders(): Promise<Array<{ id: string; label: string }>> {
  const home = process.env.HOME || os.homedir();
  const hermesDir = path.join(home, ".hermes");
  const [config, auth] = await Promise.all([
    readJsonOrYamlFile<HermesConfigYaml>(path.join(hermesDir, "config.yaml")),
    readJsonOrYamlFile<HermesAuthJson>(path.join(hermesDir, "auth.json")),
  ]);

  const out = new Map<string, { id: string; label: string }>();
  const push = (id: string, label: string) => {
    if (!out.has(id)) out.set(id, { id, label });
  };

  // 1) Always-on entries — Auto + Custom.
  push("auto", "Auto (Hermes default)");
  push("custom", "Custom (OpenAI-compatible)");

  // 2) Default provider from config.yaml — surface it explicitly so aluno
  //    can see what "Auto" would resolve to.
  const defaultProvider = asString(config?.model?.provider);
  if (defaultProvider) {
    push(defaultProvider, `${defaultProvider} (default)`);
  }

  // 3) Each custom_provider entry from config.yaml.
  const customProviders = Array.isArray(config?.custom_providers)
    ? (config!.custom_providers as Array<Record<string, unknown>>)
    : [];
  for (const cp of customProviders) {
    const name = asString(cp.name);
    if (!name) continue;
    const model = asString(cp.model);
    const label = model ? `${name} (${model})` : name;
    push(name, label);
  }

  // 4) Authenticated built-in providers from auth.json credential_pool.
  //    Surface only those that exist in BUILTIN_PROVIDER_LABELS so we don't
  //    pollute the dropdown with unknown ids.
  const pool = auth?.credential_pool;
  if (pool && typeof pool === "object") {
    for (const key of Object.keys(pool)) {
      const label = BUILTIN_PROVIDER_LABELS[key];
      if (label) push(key, label);
    }
  }

  return Array.from(out.values());
}

async function readEnvVariable(envPath: string, key: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() !== key) continue;
      return unquote(line.slice(eq + 1).trim());
    }
    return null;
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for cross-heartbeat session continuity via the Hermes
 * `--resume <sessionId>` CLI flag.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
