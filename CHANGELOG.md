# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.16] - 2026-06-12

### Fixed

- **Comment/task wakes now reach the agent.** The plugin read the wake context (`taskId`, `commentId`, the comment body) from `ctx.config`, but Paperclip delivers it in `ctx.context` — so comment-triggered runs fell into the generic "no task" heartbeat and ignored the comment. `buildPrompt()` now reads the wake context from `ctx.context` (falling back to `ctx.config`) and injects Paperclip's `paperclipTaskMarkdown` (issue + latest comment + "use as the current assignment") into the prompt. Bug shared with upstream.
- **Blank Run output when Hermes' quiet mode doesn't echo.** `hermes chat -q … -Q` does not reliably print the agent's final message to stdout. The plugin now recovers it from `hermes sessions export` (already called for usage) and replays it to the transcript stream, so the Run page shows the response instead of going blank. Bug shared with upstream, which has no recovery at all.
- **`--reasoning-effort` no longer breaks wakes.** `hermes chat` has no such flag (its argparse rejects unknown arguments), so the value the universal "Thinking effort" field injected could fail the run. The plugin stops emitting it and strips it from any agent that still carries it in `extraArgs`.

### Changed

- **Model, provider and reasoning effort are delegated to Hermes.** The universal "Model" / "Thinking effort" fields are no longer forwarded; Hermes resolves them from `~/.hermes/config.yaml`.
- **Toolsets default removed.** When the field is blank the plugin no longer passes `-t`; Hermes uses its own default set (which already enables `terminal`, `skills`, etc., so `curl` and skill loading still work).
- Converged several behaviours back to upstream: `--yolo` is always passed (no toggle), env bindings are forwarded with `Object.assign` (Paperclip resolves them to plain strings before the adapter runs), `agentConfigurationDoc` is a markdown string instead of an object (it was being served as raw JSON), and best-effort failures (cwd, session-usage) are silent again.

### Removed

- The **Provider** and **Custom Provider** (Base URL / API Key / Model / Extra headers) configuration fields, `listProviders()`, `detect-model.ts` (provider routing/inference), and `listModels()` — model/provider selection lives in Hermes.
- The **LIGHT** heartbeat template and `heartbeatTemplateMode` field, and the **Prompt template** UI field (the upstream `promptTemplate` runtime plumbing stays).
- The `Toolsets` and `Skip approval prompts (--yolo)` configuration fields.
- The `js-yaml` dependency and dead constants (`VALID_PROVIDERS`, `MODEL_PREFIX_PROVIDER_HINTS`, `DEFAULT_MODEL`, `DEFAULT_TOOLSETS`, duplicate regexes).

## [0.1.15] - 2026-06-12

### Changed

- Default `Command` now points at `/opt/hermes/bin/hermes` (the bento cross-stack mount target) with a `PAPERCLIP_HERMES_CLI` env override, replacing the dead `/usr/local/bin/hermes-paperclip` wrapper. `testEnvironment` and `execute` resolve the same binary, so a green "Test" means the spawn will work. Removed the `HERMES_CLI_FALLBACK` / `canExecute()` probing.

## [0.1.14] - 2026-06-12

### Fixed

- Stale UI labels / hint for `heartbeatTemplateMode`. The "Auto (smart pick from AGENTS.md)" option was describing the v0.1.7-v0.1.11 behaviour that v0.1.12 reverted — Auto now always picks Full unless an explicit Prompt template is set. Updated the option labels and the hint accordingly so the dropdown matches actual runtime behaviour.

## [0.1.13] - 2026-06-12

### Changed

- **`syncHermesSkills()` no longer tears down "stale" symlinks at wake time.** `~/.hermes/skills/` is shared across every agent in the same container, so the per-agent cleanup loop was deleting symlinks that other agents in the company still wanted — and re-creating them on the next wake. Net effect: wasted I/O on every heartbeat and an oscillating skills dir. The current agent always sees its desired symlinks (still created above), so removing the cleanup never breaks a run. Orphan symlinks belong to a delete-time hook or a separate `hermes skills prune` command, not the per-wake sync.
- **`--yolo` is now an opt-out toggle.** New Configuration field `skipApprovalPrompts` (default `true`) controls whether the plugin passes `--yolo` to `hermes chat`. Upstream Nous never passed it; our fork has been hardcoding it since v0.1.0 because Hermes in `-q` (non-interactive) mode auto-DENIES every shell command after a TTY-prompt timeout — without `--yolo` the autonomous-issue workflow (`curl` to list/comment/close issues) blocks at the first call. Default `true` preserves the working autonomous behaviour; turn off to align with upstream's conservative posture, with the documented consequence that wakes will hang on shell calls.

## [0.1.12] - 2026-06-12

### Changed

- **`auto` mode no longer downgrades to LIGHT.** v0.1.7-v0.1.11 silently swapped the heartbeat template for a 7-line stub when `AGENTS.md > 200 chars`, intending to be a "token-saver for focused-persona agents". The side effect was that autonomous-issue workflows (list assigned, comment, mark done, parent notification — the whole point of the Nous Research default template) were stripped from every wake. **LIGHT is now strictly opt-in via `heartbeatTemplateMode: "light"`**. Default is FULL.
- `readBundleEntry()` now reads the four canonical files instead of `AGENTS.md` only. Concatenation order: **SOUL.md → AGENTS.md → HEARTBEAT.md → TOOLS.md**, separated by `---`. Each file is prefixed with a `# <FILENAME>` heading so the LLM sees the hierarchy. Markdown headings inside each file are demoted one level (`# X` → `## X`, up to h5) to protect the outer hierarchy when authors write natural `# Something` lines.

### Why

This release reverts the auto-LIGHT regression that capped agent autonomy. The token-saver intent was valid; the implicit auto-switch wasn't. Operators who want LIGHT now pick it explicitly and accept the autonomy trade-off documented on the `heartbeatTemplateMode` field.

## [0.1.11] - 2026-06-11

### Added
- Per-agent scratch CWD. Hermes is spawned with `cwd = /paperclip/instances/<inst>/workspaces/<agentId>` instead of the Paperclip server's own `/app` working directory.
- Honest error logging on the four `try { ... } catch { ... }` blocks the plugin owns. Failures now surface on the Run page with a `[paperclip] WARN ...` line instead of being swallowed silently.

### Changed
- Default `cwd` no longer inherits from the Paperclip server. The Hermes auto-injection that pulled `/app/AGENTS.md` (the Paperclip contributor guide) into every wake's system prompt is gone.

### Performance
- **-22.7% input tokens on cold wakes (9 044 → 6 992 measured).** See [`docs/03-cwd-fix-saved-22-percent.md`](./docs/03-cwd-fix-saved-22-percent.md) for the validation report.

## [0.1.10] - 2026-06-11

### Fixed
- Custom Provider env injection now uses the correct names: `OPENAI_BASE_URL` (not `OPENAI_API_BASE`) plus the `_HERMES_FORCE_<NAME>` escape hatch that bypasses Hermes's provider-env blocklist. End-to-end routing to OpenAI-compatible endpoints (Z.AI, Together AI, Groq, Ollama, vLLM, …) is finally working.

## [0.1.9] - 2026-06-11

### Fixed
- `${SECRET_NAME}` substitution now resolves from `adapterConfig.env` (the agent-level Environment Variables row in the Paperclip UI) before falling back to `process.env`. Lets one company secret serve dozens of agents.

## [0.1.8] - 2026-06-11

### Added
- 10 new fields on the Configuration tab: `provider` (dynamic), `customProviderBaseUrl`, `customProviderApiKey` (secret), `customProviderModelOverride`, `customProviderHeaders`, `heartbeatTemplateMode`, `toolsets`, `sessionResume`, `debug`, plus the v0.1.7 `promptTemplate`.
- `listProviders()` populates the Provider select dynamically from `~/.hermes/config.yaml` (`custom_providers[].name`) + `~/.hermes/auth.json` (`credential_pool`). Always includes `Auto` + `Custom (OpenAI-compatible)`.
- Custom Provider routing: when `provider = custom`, the plugin passes `--provider openai-api` and injects `OPENAI_BASE_URL` / `OPENAI_API_KEY` env vars from the form fields.
- `heartbeatTemplateMode` (`auto` / `light` / `full` / `custom`) gives the operator explicit control over which prompt template the plugin selects.

### Changed
- Default toolsets jump from `terminal,skills` to a powerful set matching what `hermes chat` enables on the host: `terminal,skills,web,browser,file,code_execution,memory,todo,vision,session_search,delegation`. Aluno leigo gets a real Hermes agent by default.
- Removed the broken `--reasoning-effort` push that the UI's universal `thinkingEffort` field used to generate. Hermes has no such CLI flag — the arg was being silently dropped.

## [0.1.7] - 2026-06-11

### Added
- `getConfigSchema()` is now exported correctly so the Paperclip server route `GET /api/adapters/<type>/config-schema` returns the plugin's UI form fields. The earlier `agentConfigurationSchema` name was a red herring; nothing read it.
- `LIGHT_PROMPT_TEMPLATE` for wakes where `AGENTS.md` has substantive content (>200 chars). Reduces a typical focused-task wake from ~18 k to ~5 k input tokens by skipping the heartbeat workflow injection.
- `promptTemplate` textarea field on the Configuration tab.

## [0.1.6] - 2026-06-11

### Changed
- `syncSkills()` now fetches `sourcePath` from Paperclip's HTTP API instead of inferring it via string parsing of the runtime snapshot path. Cached for 30 s per company to avoid hammering the server.

## [0.1.5] - 2026-06-11

### Fixed
- Skill references survive. `syncSkills()` symlinks against the source directory (`/paperclip/instances/.../skills/<bare>`) instead of the runtime snapshot (`__runtime__/<bare>--<hash>`), which strips everything except `SKILL.md` on build. Multi-file skills (Hormozi, Feynman, etc.) now expose `references/`, `assets/`, and friends to Hermes.

## [0.1.0 - 0.1.4]

Initial scaffold and early iterations. See git history.
</content>
