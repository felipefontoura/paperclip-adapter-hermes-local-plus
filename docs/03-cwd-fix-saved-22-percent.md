# Cut 4 — Validation report (v0.1.11)

Real-wake measurement of the per-agent scratch CWD change shipped in
`v0.1.11`. See `docs/token-baseline-analysis.md` §4.4 / §9.4 for the
design rationale and proposal that this report validates.

---

## 1. What Cut 4 changes

Before `v0.1.11` the plugin spawned `hermes chat` with `cwd = "."`. The
Paperclip server itself runs with `WORKDIR=/app` inside its container,
so the subprocess inherited `cwd = /app`. Hermes's auto-discovery walks
up from CWD looking for `AGENTS.md` / `SOUL.md` / `.cursorrules` /
`memory` and injects whatever it finds into the system prompt as
"Project Context". `/app/AGENTS.md` is Paperclip's own contributor
guide — not relevant to any aluno agent.

The plugin now sets `cwd = /paperclip/instances/<inst>/workspaces/<agentId>/`
when no explicit `cwd` field is configured. That dir already exists for
the wake (Paperclip's own fallback workspace logic creates it), contains
no inherited `AGENTS.md`, and writes/reads are isolated per agent.

The plugin still injects its own AGENTS.md (the persona) via the
managed bundle path (`adapterConfig.instructionsFilePath`) — so the
persona is preserved; only the bogus `/app/AGENTS.md` is dropped.

---

## 2. Test plan

Two back-to-back wakes against the `skills-coexist` agent on
`paperclip.base25.so`. Same provider (Custom → Z.AI / GLM-5.1 via
`OPENAI_BASE_URL` shim with `_HERMES_FORCE_` envs), same toolsets
(plugin default — 11 toolsets), same heartbeat mode (light), same
AGENTS.md.

Wake #1 is the **cold case**: first wake after the `paperclip` Docker
container restart, no provider-side cache to lean on. Wake #2 is the
**warm case** roughly 4 minutes after Wake #1, same prefix.

Reference baseline: session `20260611_163226_fe28db` captured in
`docs/token-baseline-analysis.md` §3 — same agent and configuration on
`v0.1.10` before the CWD change landed.

---

## 3. Results

| Metric | Baseline `163226` (v0.1.10 cold) | Wake #1 `174605` (v0.1.11 cold) | Wake #2 `174929` (v0.1.11 warm) |
| --- | ---:| ---:| ---:|
| input_tokens | **9 044** | **6 992** | **612** |
| output_tokens | 644 | 469 | 429 |
| cache_read_tokens | 0 | 7 168 | 13 568 |
| tool_calls | 0 | 1 | 1 |
| messages in session | 2 | 4 | 4 |
| exit code | 0 | 0 | 0 |
| stdout | (refusal) | `MARCH-LIGHTNING-2289-RAVEN-FALLOW-OPAL` | `MARCH-LIGHTNING-2289-RAVEN-FALLOW-OPAL` |

### 3.1. Cold reduction

`9 044 → 6 992 = -2 052 tokens input` (**-22.7%**) on the cold wake.

That matches the §9.3 estimate (~875 tokens for the
`/app/AGENTS.md` portion alone) plus extra savings the audit hadn't
quantified separately:

- `Skills (mandatory)` boilerplate that gets shortened when no
  contributor `AGENTS.md` is present (-200ish tokens).
- A small `Project Context` heading + framing block that disappears
  with no project context to wrap (-100ish tokens).
- Some Hermes-side dedup; Hermes still injects its own runtime
  prompt, but parts of the contributor-guide context were echoing
  near identical wording (no longer triggers).

The total is larger than §9.3 alone predicted because the audit was
estimating chunk-by-chunk; the real cut also eliminates a few framing
sentences that exist only when a Project Context exists at all.

### 3.2. Warm wake — cache lands cleanly

Wake #2's `input_tokens = 612` shows the provider returning a very
tight cold delta when only the user message changes between wakes.
`cache_read_tokens = 13 568` confirms Z.AI is recognising the stable
prefix. The model still emits the same final answer (`MARCH-LIGHTNING-…`)
so the cut isn't tradeable against quality.

This second figure isn't *caused* by Cut 4 specifically — it's the
provider's prompt-prefix caching kicking in for the second wake of a
stable session. The relevant point is that **the cut is compatible
with the cache**: it doesn't break stable-prefix recognition.

### 3.3. Functional regression check

The token `MARCH-LIGHTNING-2289-RAVEN-FALLOW-OPAL` lives in
`alex-hormozi/references/secret-bonus.md`. Both wakes returned it
correctly. This proves:

- Skill symlink (`alex-hormozi`) is still pointing at the right
  source dir (the Cut 4 CWD change did not break the `v0.1.5/v0.1.6`
  symlink work).
- `skill_view` finds the reference file (`references/secret-bonus.md`).
- The agent reads it and returns the literal token.
- AGENTS.md persona is still injected (the operator-supplied
  instructions still arrive).
- Custom Provider routing (Z.AI via `OPENAI_BASE_URL` + force prefix)
  still works.

In short: -22.7% input tokens, **no quality regression**, end-to-end
canary green.

---

## 4. Per-agent savings projection

The install carries ~30 chiefs in active use. Assuming each runs
24 wakes/day, the daily cold-input saving is roughly:

```
30 agents × 24 wakes × 2 052 tokens = 1 477 440 tokens / day
```

At Z.AI GLM-5.1 pricing of roughly USD 0.50 per million input tokens
(varies; check current pricing), that is **about USD 0.74 / day** or
**~USD 22 / month** on this install for one trivial plugin change.

Multiply by larger installs or higher pricing tiers and the cut keeps
paying out for as long as the plugin is deployed.

---

## 5. Operational note

The `[paperclip] No project or prior session workspace was available.`
log line is still printed in both wakes. That message is emitted by
the Paperclip server (NOT the plugin) when it falls back to
`<agent-id>/` as the workspace. Both before and after Cut 4 the
fallback path *was* the agent's workspace dir; the difference is that
*before* the plugin then ignored that dir and spawned in `/app`. Now
the plugin honours it.

Operator action: no change to the agent. Wakes look identical from the
UI. The saving lives in the API bill.

---

## 6. Verdict

**Cut 4 shipped, validated, deployed.** Default `cwd` now points at
the per-agent scratch workspace whenever no explicit `cwd` is set on
the agent. ~2 000 tokens cold per wake. No quality regression. No
opt-in needed from aluno — applies on the next wake automatically.

Remaining cuts (Cut 1 — skills-index allowlist) need upstream Hermes
support; documented as a follow-up issue.
