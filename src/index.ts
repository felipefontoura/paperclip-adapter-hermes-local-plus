/**
 * Root entry — what Paperclip's external adapter plugin-loader calls.
 *
 * We REGISTER under the same type as the built-in hermes_local adapter so
 * Paperclip's registry treats us as an override:
 *
 *   [paperclip] External adapter "hermes_local" overrides built-in adapter
 *
 * Once registered, every wake routed to hermes_local goes through OUR
 * execute() — which prepends the Paperclip-managed AGENTS.md bundle,
 * defaults toolsets to "terminal,skills", and respects the symlinks
 * materialised by OUR syncSkills().
 */

import {
  execute,
  testEnvironment,
  detectModel,
  sessionCodec,
  listSkills,
  syncSkills,
  listModels,
} from "./server/index.js";

import { getConfigSchema } from "./ui/build-config.js";

import {
  ADAPTER_TYPE,
  ADAPTER_LABEL,
} from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const category = "local" as const;

/**
 * Models list — always empty at build time. The combobox is populated at
 * runtime by `listModels()` (server/index.ts), which inspects Hermes'
 * actual config + credential pool on disk. Hardcoding would force every
 * install to ship Felipe-specific provider names.
 */
export const models: never[] = [];

export const agentConfigurationDoc = {
  summary:
    "Plugin override do adapter built-in hermes_local. Adiciona Instructions tab, default toolsets=terminal,skills, e materialização real de skills selecionadas como symlinks no ~/.hermes/skills/.",
  steps: [
    "O plugin está registrado automaticamente quando aparece em /paperclip/adapter-plugins.json.",
    "Criar agent Hermes Agent na UI Paperclip.",
    "Selecionar skills + editar SOUL.md/AGENTS.md tudo pela UI — sem tocar arquivos.",
    "Wake heartbeat — bundle entry vira prefixo do system prompt, skills materializam em ~/.hermes/skills/.",
  ],
};

/**
 * Paperclip plugin-loader contract — must export createServerAdapter()
 * returning a ServerAdapterModule. Capabilities here are what Patch #1
 * in paperclip-hermes-patch-bundle.md added by hand to the core
 * registry.js — embedding them in the plugin module means no bind mount.
 */
export function createServerAdapter() {
  return {
    type,
    label,
    category,
    execute,
    testEnvironment,
    sessionCodec,
    listSkills,
    syncSkills,
    detectModel,
    // listModels is called by Paperclip when the Model combobox opens. It
    // reads ~/.hermes/config.yaml and ~/.hermes/auth.json on disk and emits
    // ONLY the models/providers that Hermes is actually configured with —
    // zero hardcoded names.
    listModels,
    models,
    agentConfigurationDoc,
    // v0.1.7 — Paperclip's `/api/adapters/<type>/config-schema` route calls
    // `adapter.getConfigSchema()` (a function, NOT an object property called
    // `agentConfigurationSchema` — that name was a red herring).
    // See `/app/server/dist/routes/adapters.js:498`.
    getConfigSchema,

    // PATCH #1 (now embedded as plugin capability)
    // Tells Paperclip we accept a managed bundle. The server then injects
    // the resolved absolute path into adapterConfig.instructionsFilePath
    // at runtime, and our execute() reads it via readBundleEntry() and
    // prepends as system message.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",

    // hermes_local upstream advertises:
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  };
}

// Direct re-exports for any code path that imports specific symbols.
export { execute, testEnvironment, detectModel, listSkills, syncSkills, sessionCodec };
