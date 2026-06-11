# Configuration Guide — `paperclip-adapter-hermes-local-plus`

A complete walk-through of every Configuration tab field this plugin adds to
the Paperclip UI, why each one exists, what it changes inside Hermes, and the
trade-offs each option carries.

This document is the source of truth for **what you can drive from the UI
without touching `~/.hermes/config.yaml`** and what still requires a CLI/SSH
session. It is also a reference for upstream Paperclip if any of these ideas
are ever adopted into the core `hermes_local` adapter.

---

## 1. Introduction

### 1.1. Who is this plugin for?

Two profiles need to coexist on the same install:

- **The "aluno leigo"** (the non-technical operator). Opens the Paperclip
  UI, creates an agent, hits "Run Heartbeat", and expects work to happen.
  They will not SSH into the container, will not edit YAML, will not run
  `hermes config set …` by hand.
- **The "aluno avançado"** (the operator who knows the underlying tools).
  They edit `~/.hermes/config.yaml`, drop API keys into `auth.json`,
  experiment with new providers, and tune Hermes to their workload.

`hermes_local` from Nous Research (the built-in adapter) targets the
advanced operator first. This plugin keeps that audience happy while
making the same Hermes runtime usable through the Paperclip UI alone.

### 1.2. Where this plugin fits

```
┌──────────────────────────────────────────────────────────┐
│ Paperclip server (Node)                                  │
│   ↳ external adapter plugin: hermes-local-plus           │
│       ├─ getConfigSchema()    ← drives the UI form        │
│       ├─ listModels()         ← Model select              │
│       ├─ listProviders()      ← Provider select           │
│       ├─ execute(ctx, cfg)    ← spawns Hermes subprocess  │
│       └─ syncSkills(ctx, …)   ← materialises skill symlinks│
└──────────────────────────────────────────────────────────┘
                    │
                    ▼ subprocess
┌──────────────────────────────────────────────────────────┐
│ /usr/local/bin/hermes-paperclip → /opt/hermes/bin/hermes  │
│   ↳ reads ~/.hermes/config.yaml + auth.json + .env        │
│   ↳ executes chat with the args + env the plugin built    │
└──────────────────────────────────────────────────────────┘
```

The plugin is a translator. The aluno sets fields in the UI; the plugin
turns them into CLI flags and env vars; Hermes runs.

### 1.3. Versions covered by this document

| Version | Headline change |
| --- | --- |
| `v0.1.5` | Skill symlinks point at the source dir, not `__runtime__`, so multi-file skills (Hormozi, Feynman, …) expose their `references/`. |
| `v0.1.6` | `sourcePath` taken from the Paperclip HTTP API instead of inferred via string parsing. |
| `v0.1.7` | `getConfigSchema()` correctly exported; `promptTemplate` field exposed; auto-detect of light vs heavy heartbeat template. |
| `v0.1.8` | Tier 1+2 fields: `provider` dynamic select, Custom Provider form (OpenAI-compatible), `heartbeatTemplateMode`, `toolsets` (powerful default), `sessionResume`, `debug`. |
| `v0.1.9` | `${SECRET_NAME}` substitution reads from `adapterConfig.env` (agent-level Environment Variables row), not just the plugin's `process.env`. |
| `v0.1.10` | Custom Provider env injection uses `OPENAI_BASE_URL` (correct name) plus the `_HERMES_FORCE_` prefix to bypass Hermes's provider-env blocklist. |

---

## 2. Motivation & the Problem

### 2.1. What "hermes_local" gave you on day one

The built-in `hermes_local` adapter shipped by Paperclip is a thin process
runner. It takes a model id, spawns `hermes chat -q "<prompt>" -m <model>`,
captures stdout, parses out a session id, and returns. That's it.

For an aluno avançado that's enough — they already curated their
`config.yaml` to point Hermes at the right provider, set the right
toolsets, picked a reasoning effort, and dropped keys into `auth.json`.

### 2.2. What was missing for everybody else

Try to onboard a non-technical operator with the built-in adapter and the
list of unmet needs gets long fast:

1. **Skills with references were broken.** When you "manage a skill via
   Paperclip" the server materialises the skill into
   `instances/.../__runtime__/<bare>--<hash>/`. The materialise step
   strips everything except `SKILL.md`. Multi-file skills like the
   Hormozi or Feynman bundles became one-page stubs the moment they
   reached Hermes. `skill_view` couldn't open `references/secret.md` —
   it didn't exist on disk anymore.
2. **No way to choose a provider from the UI.** The Model select existed,
   but Provider lived in `config.yaml`. Want this agent on Anthropic and
   that one on Z.AI? SSH in for each switch.
3. **No way to plug in an "exotic" provider.** Together, Groq, Fireworks,
   Ollama, vLLM, OpenRouter — every modern endpoint speaks OpenAI Chat
   Completions. None of them are first-class Hermes providers. The only
   way to use them was to hand-edit `config.yaml` `custom_providers:` and
   restart Hermes.
4. **The heartbeat template kidnapped the agent.** When the aluno gave a
   focused instruction in `AGENTS.md` ("read the file, return the
   token"), the default prompt template still appended the whole
   Paperclip workflow ("list issues, check backlog, post a comment…").
   Models loyal to the operational template ignored `AGENTS.md`. xhigh
   reasoning burned tokens on the wrong task.
5. **Toolsets were timid.** Default `terminal,skills` left every other
   Hermes power (web, browser, code_execution, memory, vision,
   delegation) disabled. The whole reason to pick Hermes is the toolset
   buffet — defaulting to two of them defeated the point.
6. **No verbose toggle.** When a wake failed silently, the only way to
   see what Hermes was actually doing was to grep container logs.
7. **No way to start fresh.** "Resume previous session" was hard-coded.
   You couldn't say "no, this agent should never resume" without writing
   a config.
8. **API keys lived per-agent.** If you wanted 50 agents to share one
   Together AI key, you stored the key in 50 places. Key rotation = 50
   edits.
9. **The Model and Provider fields lied about their effect.** The
   built-in `Thinking effort` field pushed `--reasoning-effort` into
   Hermes's CLI, but Hermes never had that flag. The arg was silently
   dropped.

This plugin works through that list.

### 2.3. The constraint that shaped the solution

Felipe was explicit: **do not modify `~/.hermes/config.yaml` from the
plugin.** A plugin that writes config.yaml is a dual-owner: Hermes
reloads it, the plugin overwrites it, races emerge, the aluno avançado
loses their edits, the daemon picks up the wrong defaults mid-run, and
debugging becomes archaeology. Hard rule: the plugin reads `config.yaml`
to populate dropdowns; it never writes.

That single rule forces every UI feature into one of three buckets:

- **CLI flag** — the plugin can pass it through `hermes chat`.
- **Subprocess env var** — Hermes reads from `os.environ`.
- **Plugin-internal logic** — never reaches Hermes; lives in the
  prompt-build pipeline or the skill symlink path.

Anything that doesn't fit one of those three buckets is **honestly
documented as cosmetic** (see §4.2) instead of pretending it works.

---

## 3. The fields

Each subsection covers: what the field is, what it actually does at run
time, the trade-offs, and a concrete example.

### 3.1. `provider` (select, dynamic)

**Where:** Configuration tab → Permissions & Configuration → Provider.
**Default:** `auto`.
**Options:** built at schema-fetch time by `listProviders()`. Always
includes `Auto (Hermes default)` and `Custom (OpenAI-compatible)`. Then
appends every `custom_providers[].name` from `~/.hermes/config.yaml` and
every authenticated built-in provider in `auth.json.credential_pool`.

**What happens at run time:**

| Selected | CLI / env changes |
| --- | --- |
| `auto` | No `--provider` flag. Hermes resolves from `config.yaml` (`model.provider`). |
| `custom` | `--provider openai-api`, plus `OPENAI_BASE_URL` / `OPENAI_API_KEY` env vars from the Custom Provider form. See §3.3. |
| any other | `--provider <name>` passed through. Hermes routes to that named provider. |

**Trade-offs:**

- *Pro:* The dropdown is **honest about this install**. If a provider
  isn't configured, it isn't there to pick. No clicking "huggingface"
  and getting a 401 because no key was ever loaded.
- *Pro:* The aluno avançado still wins. They edit `config.yaml`, the
  cache invalidates after 30s, the dropdown updates automatically.
- *Con:* The dropdown is **scoped to this install**. If you migrate the
  agent record to a different host with a different `config.yaml`, the
  saved value might point at a provider that no longer exists. The
  fallback is `auto`, which keeps the wake working.

**Example flow — switch from Z.AI to Anthropic at runtime:**

1. Aluno avançado has both providers configured in `auth.json`.
2. In the UI, Provider changes from `zai-coding-plan` to `anthropic`.
3. Next wake: plugin passes `--provider anthropic`. Hermes routes to its
   built-in Anthropic provider. No restart, no config edit.

### 3.2. Custom Provider form (4 fields, OpenAI-compatible)

When `provider = custom`, four sibling fields drive the OpenAI-compatible
shim:

| Field | Type | Used as |
| --- | --- | --- |
| `customProviderBaseUrl` | text | `OPENAI_BASE_URL` env var |
| `customProviderApiKey` | secret | `OPENAI_API_KEY` env var |
| `customProviderModelOverride` | text | `-m <value>` CLI arg |
| `customProviderHeaders` | textarea (JSON) | `OPENAI_EXTRA_HEADER_<KEY>` env vars |

**Why an OpenAI-compatible shim?** Almost every modern inference provider
exposes a `/v1/chat/completions` endpoint with the OpenAI request shape:
Together, Groq, Fireworks, OpenRouter, Ollama, vLLM, LM Studio, Anyscale,
Anthropic's OpenAI-compatible endpoint, even Z.AI. By translating "Custom"
into Hermes's `openai-api` provider plus env overrides, the aluno gets
N+1 providers without N+1 plugin features.

**Why the `_HERMES_FORCE_` prefix?** Hermes maintains a provider-env
blocklist that strips `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and friends
from any subprocess to prevent ambient host env from poisoning runs.
Without an escape hatch, our intentional injection would be silently
stripped at spawn time. The hatch is documented in
`/opt/hermes/tests/tools/test_local_env_blocklist.py`: prefix any
otherwise-blocked var with `_HERMES_FORCE_` and Hermes drops the prefix
and injects the bare name into the subprocess env. The plugin sets both
the bare name (compatible with older Hermes builds) and the
force-prefixed name (compatible with current Hermes that gates them).

**Example — wire Together AI in 30 seconds:**

```
Provider              = Custom
customProviderBaseUrl = https://api.together.xyz/v1
customProviderApiKey  = ${TOGETHER_API_KEY}
customProviderModelOverride = meta-llama/Llama-3.1-70B-Instruct
customProviderHeaders = {"HTTP-Referer": "https://base25.so"}
```

The `${TOGETHER_API_KEY}` reference resolves at wake time. See §3.7 for
secret resolution.

**Trade-offs:**

- *Pro:* Zero changes to `config.yaml`. Aluno leigo plugs in any new
  provider through the UI alone.
- *Pro:* Per-agent. Agent A on Together, agent B on Groq, with one
  Hermes install.
- *Con:* Streaming-chat-only. If the provider exposes embeddings, vision,
  audio, or any other non-chat surface, the shim doesn't route those.
  Use the corresponding Hermes-native provider entry instead.
- *Con:* No request transformation. If the provider has a quirky body
  shape (some require `:free` suffixes, some need a model registry
  lookup), you'd need a real Hermes provider, not the shim.

### 3.3. `heartbeatTemplateMode` (select)

**Default:** `auto`.
**Options:** `auto`, `light`, `full`, `custom`.

The plugin maintains two opinionated templates:

- `LIGHT_PROMPT_TEMPLATE` — identity + task block + a `noTask` stub.
  Lets `AGENTS.md` drive the agent without injecting the full heartbeat
  workflow.
- `DEFAULT_PROMPT_TEMPLATE` — the heavy template inherited from
  `hermes-paperclip-adapter`. Tells the agent to list issues, pick the
  highest-priority one, post comments on completion, post a parent
  notification, etc.

**What each mode does:**

| Mode | Behaviour |
| --- | --- |
| `auto` | If `AGENTS.md` > 200 chars and no explicit `promptTemplate`, use Light. Else use Default. If the aluno typed a `promptTemplate`, that wins regardless. |
| `light` | Always Light. Force the persona-driven path even when `AGENTS.md` is short. |
| `full` | Always Default. Force the heartbeat workflow even when `AGENTS.md` is rich. |
| `custom` | Use `promptTemplate` field verbatim (variables and conditional blocks supported). |

**Why this matters:** in our experiments, a wake against an agent with a
500-char `AGENTS.md` ("read this file, return one line") and the default
template used **18k input tokens and 2m08s wall-clock** — almost all of
it spent on the heartbeat workflow the operator never asked for. The
same wake with `light` mode used **5.2k tokens and ran in under 30s**.

**Trade-offs:**

- *Pro:* Aluno leigo: pick `light`, write what you want in `AGENTS.md`,
  the agent stays focused.
- *Pro:* Aluno avançado: pick `custom`, paste a fully custom template,
  the plugin renders variables and conditional blocks.
- *Con:* `light` strips workflow guidance. Agents that should be working
  off issues need `auto` (with a small AGENTS.md) or `full`.
- *Caveat:* Some models actively refuse "ignore previous instructions"
  style framing in `AGENTS.md` even when it's exactly what the operator
  wants. `light` mode helps; safety alignment from the model itself
  doesn't.

### 3.4. `promptTemplate` (textarea, advanced)

**Default:** empty.

When non-empty, becomes the system prompt body (subject to the
`heartbeatTemplateMode` rules above). Supports the same variables as the
internal templates:

```
{{agentName}}      {{agentId}}      {{companyId}}
{{runId}}          {{taskId}}       {{taskTitle}}     {{taskBody}}
{{paperclipApiUrl}}
```

And conditional blocks:

```
{{#taskId}} … {{/taskId}}
{{#noTask}} … {{/noTask}}
{{#commentId}} … {{/commentId}}
```

**Use case:** when neither the Default nor the Light template fits and
you need a third behaviour for this specific agent (e.g. "this is a
billing-summariser bot, ignore tasks entirely, always do X").

**Tip:** keep `heartbeatTemplateMode = auto` and just fill this field.
The plugin's priority order surfaces a non-empty `promptTemplate` over
the auto-detect.

### 3.5. `toolsets` (text, comma-separated)

**Default:** `terminal,skills,web,browser,file,code_execution,memory,todo,vision,session_search,delegation` (11 toolsets).

Maps directly to `hermes chat -t <value>`. Defines which tool groups the
agent has access to during this run.

**Why so many by default?** Hermes ships ~25 toolsets and enables about
17 by default when you run `hermes chat` directly on the host. The
earlier "timid" default of `terminal,skills` crippled the agent
compared to running Hermes outside Paperclip. People who pick a "Hermes
Agent" want the buffet.

**Toolset glossary (the 11 in the default):**

| Toolset | What it gives the agent |
| --- | --- |
| `terminal` | Shell access, process spawning. Critical for any agent that does Paperclip API calls via curl. |
| `skills` | `skill_view` / `skills_list`. Required for Paperclip-managed skills to work — `syncSkills()` materialised symlinks are useless without this. |
| `web` | Web search & scraping (Exa / Tavily / Firecrawl backends). |
| `browser` | Full browser automation (Browserbase / Browser Use). |
| `file` | File system read/write. |
| `code_execution` | Sandboxed code runner. |
| `memory` | Long-term memory across sessions. |
| `todo` | Task planning state machine. |
| `vision` | Image analysis. |
| `session_search` | Search previous session transcripts. |
| `delegation` | Spawn sub-agents. |

**Optional opt-ins (not in default):** `image_gen`, `tts`, `video`,
`video_gen`, `x_search`, `moa`, `context_engine`, `homeassistant`,
`spotify`, `computer_use`, `yuanbao`, `cronjob`, `messaging`, `clarify`.
Some are expensive (generative), some are platform-locked, some are
provider-specific. Aluno avançado adds them deliberately.

**Trade-offs:**

- *Pro:* Aluno leigo gets a powerful agent without thinking.
- *Pro:* Aluno avançado can lock things down for unattended jobs:
  e.g. an evening rollup bot might be `terminal,skills` only.
- *Con:* More toolsets = larger system prompt = more input tokens per
  wake. The 11-toolset default adds roughly 4-5k tokens to baseline vs.
  the 2-toolset minimum.

### 3.6. `sessionResume` (select)

**Default:** `auto`.
**Options:** `auto`, `never`.

| Mode | Behaviour |
| --- | --- |
| `auto` | When the agent has a saved session id from a previous wake, pass `--resume <id>` to Hermes. Matches the legacy `persistSession=true` behaviour. |
| `never` | Never pass `--resume`. Every wake starts a fresh Hermes session. |

**When to use `never`:** debugging ("did the agent get into a bad state
the previous run?"), one-shot workers ("each wake is independent"),
clean A/B testing of a prompt change.

**Backward compatibility:** agents created before `v0.1.8` only have
`persistSession: true` (no `sessionResume` field). The plugin keeps that
working — when `sessionResume` is unset, it falls back to the legacy
boolean.

### 3.7. `debug` (toggle)

**Default:** off.

When on, passes `-v` (verbose) to `hermes chat`. Stdout/stderr include
tool I/O, reasoning summaries, retry attempts. The plugin still filters
the loudest noise (`session_id:`, init banners) so the Run page stays
readable, but the rest comes through.

**Use case:** an agent silently exits with code 1 and no output. Toggle
debug, re-wake, read the stderr surfaced on the Run page.

**Cost:** longer transcripts, larger logs. Don't leave on for production.

### 3.8. `${SECRET_NAME}` substitution (cross-cutting)

Any text field that accepts a value can include `${NAME}` references.
The plugin resolves them at wake time with this priority:

1. Agent-level Environment Variable (the "Environment variables" row on
   the Configuration tab) — what the aluno fills in via Paperclip's UI.
   Lives in `adapterConfig.env[NAME].value`.
2. `process.env[NAME]` — the env of the Paperclip server itself (set in
   compose or shell).
3. Unmatched: leave the literal `${NAME}` so the failure is visible
   rather than silently sending an empty value.

**Why this design?**

- Aluno leigo creates a *company-level* secret once (e.g.
  `TOGETHER_API_KEY` via the Environment variables row, with the **Seal**
  button to encrypt at rest). 50 agents reference `${TOGETHER_API_KEY}`
  in their Custom Provider API Key field. Key rotation = 1 edit.
- Aluno avançado can drop the key into the Paperclip container's env
  vars and skip the UI entirely. The plugin resolves from `process.env`.
- Plain-text values still work: paste the raw key, no `${}`. The plugin
  passes it through unchanged.

**Where references are honored today:**

- `customProviderBaseUrl`
- `customProviderApiKey`
- Each value inside `customProviderHeaders` JSON

---

## 4. The cosmetic field

### 4.1. `thinkingEffort` (universal Paperclip form field)

This field appears in Paperclip's New Agent dialog for **every** adapter
because it lives on `CreateConfigValues`, not on the adapter's schema.
Plugins can't hide it.

For Hermes specifically, this field has **no effect**:

- Hermes CLI (`hermes chat --help`) has no `--reasoning-effort` flag.
- Hermes recognises no env var that overrides reasoning effort.
- The reasoning effort lives in `~/.hermes/config.yaml` under
  `agent.reasoning_effort` and is global to the Hermes daemon.

The plugin's `v0.1.8` change removed the broken `--reasoning-effort`
push that earlier builds tried (it produced "unrecognized arguments"
errors in stderr that the plugin silently swallowed).

### 4.2. Why we don't fix it

The only way to honour `thinkingEffort` per-agent would be to:

1. Have the plugin write `agent.reasoning_effort: <value>` to
   `~/.hermes/config.yaml` on every wake.
2. Trust that no other writer (Hermes daemon, aluno avançado's editor,
   `hermes config set` from another session) is touching the same file.
3. Hope Hermes re-reads the file on each subprocess spawn (it does, but
   that's fragile).

That's the dual-owner pattern Felipe explicitly ruled out. The cost of
the cosmetic field (some aluno picks "high" and gets the same behaviour
as "low") is lower than the cost of corrupted config files in
production.

**The current contract:** aluno avançado edits `config.yaml`, aluno
leigo gets whatever the global value is, the UI field is documented as
cosmetic in the source and surfaced as no-op in the upstream docs.

---

## 5. How this interacts with Hermes

### 5.1. The wake pipeline (v0.1.10)

```
Aluno hits "Run Heartbeat" in the UI
  │
  ▼
Paperclip server → external adapter `hermes_local` (this plugin)
  │
  ▼
execute(ctx, config)
  │
  ├─ pickPromptTemplate(config, persona)
  │    └─ heartbeatTemplateMode + AGENTS.md auto-detect
  │
  ├─ Custom Provider resolution
  │    ├─ resolveSecretRefs("${API_KEY}", config) → real value
  │    └─ customProviderEnv = { OPENAI_BASE_URL, OPENAI_API_KEY, _HERMES_FORCE_* }
  │
  ├─ Build args:
  │    chat -q "<rendered prompt>" -Q
  │      --provider openai-api  (if custom) | <name>  (if explicit)
  │      -m <customModel> | <model from select>
  │      -t terminal,skills,web,browser,...
  │      [--resume <sid>]  (if sessionResume=auto + sid exists)
  │      [-v]  (if debug=on)
  │      --source tool --yolo
  │
  ├─ Build env:
  │    { ...process.env, ...buildPaperclipEnv(ctx.agent), ...customProviderEnv }
  │
  ▼
spawn /usr/local/bin/hermes-paperclip with that argv + env
  │
  ▼
Hermes reads ~/.hermes/config.yaml (for reasoning_effort, custom_providers, etc.)
Hermes filters env through provider blocklist
Hermes recognises _HERMES_FORCE_ prefix, injects OPENAI_BASE_URL + OPENAI_API_KEY
Hermes routes to openai-api provider (when --provider openai-api)
Hermes runs the agent loop, prints to stdout
  │
  ▼
Plugin captures stdout, parses session_id, returns to Paperclip
```

### 5.2. What lives where

| Lives in | Things stored there |
| --- | --- |
| Paperclip DB (`adapterConfig`) | Every UI form field. Per-agent. Persisted across upgrades. |
| `adapterConfig.env` | Per-agent secrets (the Environment variables row). |
| `~/.hermes/config.yaml` | Built-in providers, custom_providers, agent.reasoning_effort, default model. Global to Hermes daemon. |
| `~/.hermes/auth.json` | Built-in provider credential pool. Global. |
| `~/.hermes/.env` | Some Hermes settings (the blocklist filters most of these out of subprocesses). |
| Plugin source (constants.ts) | `DEFAULT_TOOLSETS`, `HERMES_CLI_DEFAULT` (wrapper path), `DEFAULT_TIMEOUT_SEC`. |
| Plugin runtime (skill symlinks) | `~/.hermes/skills/<bare-name>/` → source dir of each Paperclip-managed skill. |

---

## 6. Case studies

### 6.1. "Plug in Together AI for the marketing team"

**Goal:** the marketing team's 5 agents should all use Together AI's
Llama-3 70B for cheaper bulk drafts.

1. Aluno (avançado or leigo) goes to Configuration tab → Environment
   variables row → KEY `TOGETHER_API_KEY`, switches type to **Secret**,
   pastes value, clicks **Seal**.
2. For each of the 5 agents: open Configuration → Provider = `Custom`,
   `customProviderBaseUrl = https://api.together.xyz/v1`,
   `customProviderApiKey = ${TOGETHER_API_KEY}`,
   `customProviderModelOverride = meta-llama/Llama-3.1-70B-Instruct`.
3. Save. Run Heartbeat. The plugin substitutes the secret, injects
   `OPENAI_BASE_URL` and `OPENAI_API_KEY` (plus the force-prefixed
   variants), spawns Hermes with `--provider openai-api`. Together
   returns the completion.
4. Key rotation 30 days later: edit the secret value, click Seal again.
   All 5 agents pick up the new key on the next wake. Zero per-agent
   edits.

### 6.2. "I want a focused agent, no heartbeat workflow noise"

**Goal:** an agent whose only job is to summarise the day's emails into
a single message — no issue listing, no comment posting.

1. Configuration tab → `heartbeatTemplateMode` = `light`. Save.
2. Instructions tab → `AGENTS.md`: "Read inbox via the gmail skill,
   summarise top 5 important emails in 3 sentences each, return."
3. Run Heartbeat. The plugin renders the Light template (just identity
   + a `noTask` stub), prepends AGENTS.md. Hermes spends its budget on
   the actual task, not the workflow.

### 6.3. "Debug why a wake is silently failing"

**Goal:** wake exits with code 1 and no useful output.

1. Configuration tab → `debug` toggle ON. Save.
2. Run Heartbeat. Stderr surfaces full Hermes verbose output on the Run
   page: tool calls, reasoning summaries, retry attempts, API errors.
3. Identify the root cause (e.g. provider 401, blocklist stripping an
   env var, malformed `customProviderHeaders` JSON).
4. Toggle debug OFF, fix the root cause, re-wake.

### 6.4. "Run the same agent fresh every wake (no resume)"

**Goal:** an A/B testing harness where each wake should start a clean
session to avoid context bleed.

1. Configuration tab → `sessionResume` = `never`. Save.
2. Every Run Heartbeat from now on spawns a brand new Hermes session.
   No `--resume` flag, no carryover.

### 6.5. "Build a multi-file skill with references"

**Goal:** the Hormozi skill needs `references/00-canon.md` through
`12-canonical-phrases.md` available to the agent via `skill_view`.

This used to silently fail before `v0.1.5`. The fix is in `syncSkills`:
when the Paperclip server tells the plugin "this skill lives at
`__runtime__/alex-hormozi--80084ad248`", the plugin checks whether a
source dir (`<companyId>/alex-hormozi/`) exists and symlinks Hermes at
the source instead. Hermes's `skill_view(file_path='references/...')`
finds the file. `v0.1.6` improved this by asking the HTTP catalog for
the authoritative `sourcePath` instead of inferring from naming.

No UI changes — this is a plugin internal. But it unlocks every
multi-file skill in the catalog.

---

## 7. Trade-offs (the full ledger)

| Choice | Cost | Benefit |
| --- | --- | --- |
| Read `config.yaml`, never write | aluno leigo can't change `reasoning_effort` from the UI | no dual-owner race; aluno avançado's edits always win |
| Honest dropdowns (filter to what's configured) | provider you forgot to configure won't appear, you might not realise you can use it | no clicking "huggingface" and getting 401s |
| Custom Provider via OpenAI-compat shim | chat-completions only; no embeddings/vision/audio through this path | unlocks 80% of modern providers without per-provider code |
| `${SECRET}` resolution from `adapterConfig.env` | aluno has to know to use the Environment variables row | 50 agents share 1 secret; rotation is single-edit |
| Light template by default when AGENTS.md is rich | agents intended for the full Paperclip workflow need a longer AGENTS.md or `mode=full` | persona-driven agents stop being kidnapped by the workflow |
| Powerful toolsets default | larger system prompt, more input tokens per wake | aluno leigo gets a real Hermes agent, not a stub |
| `thinkingEffort` field is cosmetic | aluno might pick "high" and not understand why nothing changes | no dual-owner pattern for config.yaml |
| `_HERMES_FORCE_` prefix for custom provider envs | extra env keys in the spawn (cosmetic; Hermes strips the prefix) | bypasses Hermes's provider-env blocklist cleanly |
| Plugin override of built-in `hermes_local` | a Paperclip upgrade that ships a new `hermes_local` schema could collide | every operator can opt out by removing the plugin and falling back to upstream |

---

## 8. Reference — the full UI form

Stacked in display order:

```
Identity
├─ Name, Title, Reports to, Capabilities          (Paperclip-universal)

Adapter
└─ Adapter type = Hermes Agent (local)

Permissions & Configuration
├─ Command                                         (Paperclip-universal)
├─ Model                                           (Paperclip-universal, populated by listModels())
├─ Thinking effort                                 (Paperclip-universal, cosmetic for Hermes)
├─ Provider                                        ← NEW, dynamic select
├─ Custom Provider — Base URL                      ← NEW (active when Provider=Custom)
├─ Custom Provider — API Key                       ← NEW (secret, ${ref} aware)
├─ Custom Provider — Model                         ← NEW
├─ Custom Provider — Extra headers (JSON)          ← NEW
├─ Heartbeat template mode                         ← NEW
├─ Prompt template (advanced)                      ← NEW, textarea
├─ Toolsets (comma-separated)                      ← NEW, powerful default
├─ Session resume                                  ← NEW
├─ Debug (verbose Hermes output)                   ← NEW
├─ Extra args (comma-separated)                    (Paperclip-universal)
├─ Environment variables row (KEY / Plain|Secret / value / Seal)
└─ Timeout (sec) / Interrupt grace period (sec)    (Paperclip-universal)

Run Policy, Trust, Permissions, API Keys           (Paperclip-universal)
Configuration Revisions                            (Paperclip-universal)
```

---

## 9. What's still missing (next sprints)

- **Token baseline visibility.** Surface input/output token decomposition
  on the Run page so the aluno understands where their budget went.
- **System prompt audit.** Render the concatenated system prompt the
  plugin actually sent to Hermes — invaluable for diagnosing why an
  agent ignored an instruction.
- **Bento installer integration.** Right now this plugin still requires
  manual extraction into `/paperclip/adapter-plugins/`. The bento
  install script should `npm pack` it during stack deploy.
- **Configurable `reasoning_effort` per agent.** Only worth doing if we
  find a Hermes hook that doesn't require writing to `config.yaml`.

---

## 10. License & contribution back

This plugin is MIT-licensed. If any of the patterns here (especially the
dynamic provider dropdown, the Custom Provider OpenAI-compat shim, the
heartbeat-template-mode tri-state, the `${SECRET}` resolution from
`adapterConfig.env`, or the `_HERMES_FORCE_` env injection) are useful
to upstream Paperclip's built-in `hermes_local` adapter, please pull
them in. The whole point was to make Hermes-via-Paperclip work for both
audiences — this plugin should be the prototype, not the permanent home.
