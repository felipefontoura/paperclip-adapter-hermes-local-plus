/**
 * Root entry for Paperclip's external adapter plugin-loader. Registers under
 * the built-in `hermes_local` type so Paperclip treats this as the override.
 */

import {
  execute,
  testEnvironment,
  sessionCodec,
  listSkills,
  syncSkills,
} from "./server/index.js";

import { getConfigSchema } from "./ui/build-config.js";

import {
  ADAPTER_TYPE,
  ADAPTER_LABEL,
} from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const category = "local" as const;

// Empty model list (no listModels/detectModel): model selection is owned by
// Hermes' config.yaml, so the universal Model field stays uncurated.
export const models: never[] = [];

export const agentConfigurationDoc = `# Hermes Agent (local)

Drop-in override of the built-in \`hermes_local\` adapter. Spawns Hermes
(\`hermes chat\`) with the Paperclip-managed instruction bundle prepended and the
selected skills materialized as symlinks under \`~/.hermes/skills/\`.

Model, provider and reasoning effort are owned by Hermes (\`~/.hermes/config.yaml\`),
not Paperclip — the universal Model / Thinking effort fields are ignored.

## Instructions

Edit the agent's persona in the Instructions tab. The bundle is read in order and
prepended to every wake's prompt: SOUL.md -> AGENTS.md -> HEARTBEAT.md -> TOOLS.md.

## Skills

Select skills in the Skills tab. They are symlinked into \`~/.hermes/skills/\`
before each run so Hermes' \`skills\` toolset can load them.

## Configuration fields

- sessionResume ("auto" | "never"): resume the previous Hermes session, or start
  fresh every wake. Default "auto".
- debug (boolean): pass \`-v\` to Hermes for verbose output. Default off.
- command (string, optional): path to the hermes binary. Defaults to
  \`/opt/hermes/bin/hermes\` (override via PAPERCLIP_HERMES_CLI).
- maxTurnsPerRun (number, optional): cap on agent tool-calling iterations.
- extraArgs (string, optional): extra \`hermes chat\` CLI arguments.
- cwd (string, optional): working directory for the run.
`;

/** Plugin-loader contract — returns the ServerAdapterModule Paperclip registers. */
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
    models,
    agentConfigurationDoc,
    // Drives the Configuration tab via `GET /api/adapters/<type>/config-schema`.
    getConfigSchema,

    // Accept the Paperclip-managed instruction bundle; the server injects its
    // path into adapterConfig.instructionsFilePath, which execute() reads.
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",

    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  };
}

// Direct re-exports for any code path that imports specific symbols.
export { execute, testEnvironment, listSkills, syncSkills, sessionCodec };
