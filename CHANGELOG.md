# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
