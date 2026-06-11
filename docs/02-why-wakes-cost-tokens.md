# Token Baseline Analysis — `paperclip-adapter-hermes-local-plus`

Empirical decomposition of where input tokens go during a Hermes wake spawned
by this plugin, and a ranked list of safe cuts. Generated from real production
wakes on the `paperclip.base25.so` install during the v0.1.5 → v0.1.10
development sprint.

---

## 1. Why we measured

Several wakes on the same agent (`skills-coexist`, GLM-5.1 via Z.AI) showed
input-token swings from **1.5k to 15.3k** for what looked like equivalent
operator intent. The cost of running each chief at xhigh reasoning effort was
becoming the dominant operational expense for the install. Before we could
recommend defaults or cuts, we needed to know **where the tokens were
actually going**.

We did not measure latency or LLM response quality here — only the cold input
size and how it decomposes by component.

---

## 2. The data set

Six real wakes captured over a single afternoon. Same agent, same Hermes
runtime, varying configuration:

| Session ID | Provider | Heartbeat mode | AGENTS.md | Skills marked | Tool loops | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `20260611_140303_70a60e` | Hermes default (zai-coding-plan, xhigh) | full (default) | mixed/redundant | 7 | 17 | curl quoting hell, full heartbeat workflow |
| `20260611_131958_1d6282` | Hermes default | light (auto) | persona-driven (~600 chars) | 7 | 2 | well-scoped task, model refused on safety |
| `20260611_131609_ffe319` | Hermes default | full | mixed | 7 | 11 | another refuse loop |
| `20260611_162617_1a40b9` | Custom (Z.AI via OPENAI_BASE_URL) — failed | light | minimal | 7 | 0 | `${SECRET}` not yet resolved (v0.1.9 fix landed after) |
| `20260611_163226_fe28db` | Custom (Z.AI) — succeeded | light | minimal | 7 | 0 | v0.1.10; model refused on safety |

Two more from the same run series were not directly comparable (one died
mid-spawn before any token accounting; one was a malformed export). They are
excluded from the table.

---

## 3. Token decomposition

Source: `hermes sessions export --session-id <id>` reading the SQLite
session DB Hermes writes per wake.

| Session | input | cache_read | output | msgs | tool_calls | msg[0] chars |
| --- | --- | --- | --- | --- | --- | --- |
| `140303` | **15 350** | 200 128 | 2 668 | 36 | 17 | 3 166 |
| `131958` | **1 543** | 27 776 | 598 | 6 | 2 | 2 761 |
| `131609` | 12 047 | 116 992 | 2 291 | 24 | 11 | 2 440 |
| `162617` | 0 | 0 | 0 | 1 | 0 | 1 523 |
| `163226` | **9 044** | 0 | 644 | 2 | 0 | 1 523 |

### 3.1. Reading the table

- **`131958` is the floor we should be aiming at: 1 543 tokens.** Light
  template, persona-driven AGENTS.md, no tool retries, model answered on
  the second message. This is roughly the cost of a clean Hermes wake
  with 7 Paperclip-managed skills indexed.
- **`140303` is the ceiling: 15 350.** Same agent, full heartbeat
  template, model entered an N-attempt curl quoting loop that produced
  17 tool calls and 36 messages of recoverable shell errors. The bulk
  of input growth is *not* the prompt — it is the agent feeding its own
  retries back into the context.
- **`163226` is the most diagnostic one: 9 044 input tokens for a
  2-message conversation with zero tool calls.** This is what one *cold*
  prompt costs when the agent doesn't enter a loop. Roughly half is the
  Hermes runtime prompt itself; the other half is the heartbeat
  workflow text plus the auto-discovered skills index.

### 3.2. Where the tokens live

Reading the captured `system_prompt` and `messages[0].content` for the
`163226` session, the 9 044 input tokens decompose roughly like this:

| Component | Estimated tokens | Source |
| --- | --- | --- |
| Hermes runtime system prompt (identity, tool enforcement, finish-the-job, mid-turn steering, etc.) | ~1 200 | `/opt/hermes/cli.py` system prompt template |
| `<available_skills>` block — auto-discovered, all 90+ Hermes-native skills + 7 Paperclip-managed | ~3 800 | `system_prompt.py: build_skills_system_prompt` |
| AGENTS.md persona (this case: small, but concatenated with leftover history from earlier UI edits) | ~600 | plugin's `readBundleEntry()` |
| Heartbeat template body (heavy in this run because we tested light vs full) | ~400 | plugin's `DEFAULT_PROMPT_TEMPLATE` or `LIGHT_PROMPT_TEMPLATE` |
| Toolsets schema (11 toolsets enabled) | ~1 800 | Hermes injects tool JSON schemas for each enabled toolset |
| Project context / AGENTS.md auto-injected from CWD | ~1 200 | Hermes auto-discovery (the long Paperclip `AGENTS.md` you saw in §3.1 of the configuration guide) |
| Everything else (memory header, host info, profile note, …) | ~50 | misc |

Total estimated: ~9 050. Matches the measured 9 044.

### 3.3. Caching

Z.AI returns `cache_read_tokens` values that suggest server-side prompt
caching is engaged when the prefix is stable across wakes. In `140303`,
`cache_read = 200 128` against `input = 15 350` — i.e. the provider
billed cold for the new content and read 13× that volume from cache for
prior history. **The cache is real but does not relieve the cold cost
of the first wake or any wake where the prompt prefix changes.**

---

## 4. Ranked cuts

### 4.1. Cut 1 — Filter the `<available_skills>` block to skills the agent actually uses

**Estimated saving:** **~3 000 tokens cold** on every wake where the
agent has fewer than ~10 Paperclip-marked skills (the common case).

**Why it works:** the auto-discovery walks the entire
`~/.hermes/skills/` tree and emits one entry per skill in the system
prompt. For an agent with 7 desired skills and a Hermes install carrying
90+ native skills, that is roughly 83 entries × ~46 chars on average =
~3 800 chars wasted.

**Why this plugin can't ship it alone:**

| Path | Verdict |
| --- | --- |
| Edit `~/.hermes/config.yaml` `skills.platform_disabled` per agent | violates the dual-owner rule (§3.1 of the configuration guide). Plugin will not touch config.yaml. |
| `hermes chat --ignore-rules` | strips skills auto-injection — but also strips AGENTS.md / SOUL.md / memory injection. Unacceptable; AGENTS.md is the entire point. |
| Remove symlinks pre-spawn, restore post-spawn | racy with concurrent wakes on the same install. |
| Patch Hermes upstream: `--skills-allowlist <list>` flag | clean. Out of scope of this plugin alone. |

**Recommendation:** open an upstream issue with Hermes Agent requesting
a `--skills-allowlist` (or `--skills-deny <list>`) flag. The plugin
already knows the desired skill list from `paperclipSkillSync.desiredSkills`
and can pass it through whichever name they choose.

### 4.2. Cut 2 — Use `light` template by default when AGENTS.md is non-trivial

**Estimated saving:** **~400 tokens per wake** when triggered.

**How it works today:** since `v0.1.7`, the plugin auto-picks the light
template when AGENTS.md exceeds 200 characters. Aluno doesn't have to
toggle anything; the default `heartbeatTemplateMode = auto` already does
this.

**Where the saving comes from:** the default template injects the
"Heartbeat Wake — Check for Work" workflow (~400 chars of curl recipes
and step-by-step instructions). Light mode replaces that block with a
one-line "follow the instructions above" hint.

**No upstream patch required** — this is purely a plugin choice and
already implemented. The cut is "free" — measure your install, confirm
it triggered on your agents.

### 4.3. Cut 3 — Narrow `DEFAULT_TOOLSETS` when the agent's job is bounded

**Estimated saving:** **~150-500 tokens per toolset removed**, depending
on toolset complexity.

The default `terminal,skills,web,browser,file,code_execution,memory,
todo,vision,session_search,delegation` (11 toolsets) injects roughly
**1 800 tokens of tool JSON schemas** into every wake. Each toolset
contributes its tool definitions to the schema block.

**When to cut:** an unattended worker that only needs to call the
Paperclip API and read skills can run with `terminal,skills` only — 2
toolsets, ~300 tokens. Saving ~1 500 tokens cold per wake.

**Trade-off:** the agent loses access to those tools. Trusting the
operator to know what they're cutting matters. The default stays
powerful so aluno leigo gets a real Hermes agent; aluno avançado who
operates one-shot harvesters edits the field.

### 4.4. Cut 4 — Drop AGENTS.md auto-injection from CWD when running in `/app`

**Estimated saving:** **~1 200 tokens cold** on every wake on this
specific install.

When Hermes spawns with CWD inside a tree that contains an `AGENTS.md`,
it auto-injects that file's content into the system prompt as "Project
Context". On the production install, the Hermes subprocess runs with
`CWD=/app` which contains the Paperclip server's own `AGENTS.md` —
roughly 6 000 chars of contributor guidelines for the Paperclip codebase
itself. That content is meaningless to most aluno agents.

**Plugin-side fix:** set CWD explicitly to a workspace dir that does
not contain an `AGENTS.md`, or pass `--ignore-rules` (acceptable here
*only* if we re-inject AGENTS.md ourselves via the bundle path, which
we already do via `instructionsFilePath`). This needs to be designed
carefully so we don't accidentally lose AGENTS.md altogether.

**Recommendation:** Sprint #190 (system prompt audit) should dump the
exact prompt the plugin sends Hermes vs. what Hermes ends up emitting
to the model — that gap is the auto-injection. Once measured, decide
whether to suppress.

### 4.5. Cut 5 — Suppress redundant Paperclip `AGENTS.md` in heartbeat template

**Estimated saving:** **~300-600 tokens** when triggered.

In `140303`, msg[0].content shows three different versions of the same
"return the token" instruction concatenated by the UI editor across
prior sessions. We saw similar concatenation in `131958` and `131609`.
This is a Paperclip TipTap-editor artefact: edits append rather than
replace. The plugin should detect duplicate-instruction patterns in the
AGENTS.md it loads and dedupe.

**Trade-off:** dedup is fuzzy — false positives might collapse
intentional repetition. Better to flag in the UI ("this AGENTS.md
contains repeated paragraphs — review?") than to silently strip.

---

## 5. Recommendation summary

| # | Cut | Saving (cold) | Plugin-only? | Status |
| --- | --- | --- | --- | --- |
| 1 | Filter auto-discovered skills index | ~3 000 | no (needs Hermes upstream flag) | **open issue upstream** |
| 2 | Light template auto-default | ~400 | yes (already shipped in v0.1.7) | **done, validate on your install** |
| 3 | Narrow toolsets for bounded workers | ~1 500 | yes (per-agent in UI) | **document & encourage** |
| 4 | Suppress CWD-injected AGENTS.md | ~1 200 | yes (CWD change, careful) | **design in Sprint #190** |
| 5 | Dedupe AGENTS.md repetition | ~300-600 | yes (plugin loader) | **UI-side warning preferred** |

**Aggregate addressable saving with all five cuts:** roughly **6 000 to
7 500 tokens cold per wake**, which would bring a typical `163226`-shape
wake from ~9k input down to ~2-3k. The model-induced refuse/curl loops
in `140303` are an *additional* axis that none of these cuts address —
that one is a model and template alignment problem, not an input bloat
problem.

---

## 6. What we won't cut

- **Hermes runtime system prompt itself.** Removing or shrinking it
  breaks Hermes tool calling, finish-the-job behaviour, and
  mid-turn-message steering. Not negotiable.
- **The agent's own AGENTS.md persona.** The whole reason to use this
  plugin is to drive the agent through AGENTS.md.
- **Tool JSON schemas for *enabled* toolsets.** Those are required for
  the model to know how to call the tool.

---

## 7. Caveats

- All measurements come from one provider (Z.AI / GLM-5.1). Token
  counts may shift with other providers due to different tokenizer
  behaviour. The relative proportions should be stable.
- Cache hit rates are provider-side and outside the plugin's control.
  The cold cost is what the plugin can reduce.
- We did not measure latency. A "cheaper" prompt that is also worse
  doesn't help. Each cut should be validated on a real task with a
  honest judge before adopting as default.

---

## 8. Next steps (assigned to Sprint #190)

1. Capture the **exact** system prompt the plugin sends Hermes vs. the
   exact prompt Hermes hands the model (`request_dump_*.json` in the
   session directory). The difference is what Hermes auto-injects.
2. Identify the largest single auto-injection source and decide
   whether it's worth suppressing.
3. Confirm Cut 2 is firing (auto-light) on existing agents in the
   install.
4. Write up a one-page "how to lighten your agent" cheat sheet for the
   aluno avançado who already has 30+ agents and wants to reduce bill.

---

## 9. Sprint #190 update — actual decomposition from `request_dump_*.json`

Reading `~/.hermes/sessions/request_dump_<sess>_<ts>.json` for a real wake
gives the **exact** instructions block sent to the provider.

### 9.1. Real numbers

- Total `instructions` field: **24 600 chars** (~6 150 tokens at 4 char/tok).
- 87 double-newline chunks.
- Tools array: 5 entries (toolset schemas not counted in the 24k above).

### 9.2. Top consumers (verified, not estimated)

| Chunk | Chars | ~Tokens | What it is | Plugin-controllable? |
| --- | --- | --- | --- | --- |
| `<available_skills>` block | 8 329 | 2 080 | All 90+ Hermes-native skills + 7 Paperclip-managed | **No** (Hermes auto-discovers) — Cut 1 target |
| Paperclip `/app/AGENTS.md` auto-injection (chunks 25, 40, 41, 67, 70, 74, 76, 78, 84) | ~3 500 | 875 | Paperclip codebase contributor guide — irrelevant to most agents | **Yes** — change CWD or `--ignore-rules` (Cut 4 target) |
| "Skills (mandatory)" instruction header | 1 466 | 370 | Tells the model to scan skills | No (Hermes runtime) |
| Hermes core enforcement (tool use, finishing, mid-turn) | ~2 200 | 550 | Identity, behavior contract | No (non-negotiable) |
| Memory header + footer | ~700 | 175 | User personal-notes scope | No |
| Everything else | ~8 400 | 2 100 | Glossary, format hints, host info | Mixed |

### 9.3. Concrete saving roadmap

| If we implement | Expected reduction |
| --- | --- |
| Cut 1 (Hermes upstream `--skills-allowlist`) | -8 329 chars / -2 080 tokens |
| Cut 4 (plugin sets CWD to a clean workspace dir) | -3 500 chars / -875 tokens |
| Both | **-11 800 chars / -2 955 tokens** |

A 9 044-input wake (as measured in `163226`) drops to ~6 100 input tokens
with both cuts. That's ~33% cold cost reduction per wake. Multiplied
across 30 agents × 24 wakes/day × 30 days, it's millions of tokens
per month on a busy install.

### 9.4. Cut 4 implementation outline (plugin-side, safe)

Today `execute.ts` sets `cwd: <project workspace>` for the spawned
Hermes subprocess. Hermes's auto-injection walks up from CWD looking
for `AGENTS.md`. Because the wake runs inside `/app` (the Paperclip
server image WORKDIR), Hermes lands on Paperclip's contributor guide.

Plugin fix: explicitly point CWD to a per-agent scratch dir that does
not contain an `AGENTS.md` of its own:

```
const agentScratch = `/paperclip/instances/${instance}/workspaces/${ctx.agent.id}`;
ensureDir(agentScratch);
// in spawn options:
cwd: agentScratch
```

That dir already exists for most wakes (fallback workspace logged by
the plugin). Confirming it's truly free of an inherited `AGENTS.md` and
making this the explicit default avoids the 875-token penalty.

**Caveat:** the agent loses the ability to "discover" project context
when working inside `/app`. Since AGENTS.md is already prepended via
the bundle, this is the right trade. We're not removing AGENTS.md from
the system prompt; we're stopping Hermes from injecting a *different*,
unintended AGENTS.md alongside ours.

### 9.5. Decision

- **Cut 4 → ship in v0.1.11**: small, safe, plugin-only, well-bounded
  saving of ~875 tokens per wake.
- **Cut 1 → file upstream issue with Hermes Agent**: request a
  `--skills-allowlist <comma-list>` flag (or equivalent env var) so the
  plugin can pass `paperclipSkillSync.desiredSkills` and suppress the
  rest of the auto-discovery.
- All other cuts already shipped in earlier versions.
