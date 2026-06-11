# Docs — `paperclip-adapter-hermes-local-plus`

Reference material for anyone who joins this codebase without having lived
through the development sprints. Read in order; each document is
self-contained but builds on the previous one.

| Doc | What you'll learn |
| --- | --- |
| **[01 — Configuration fields reference](./01-configuration-fields-reference.md)** | Every field this plugin adds to the Paperclip Configuration tab — what it does at runtime, when to use it, what the trade-offs are. Includes 5 worked case studies (plug in Together AI, focus an agent, debug silent failures, fresh sessions every wake, multi-file skills with references). The starting point if you're trying to operate an agent. |
| **[02 — Why wakes cost tokens](./02-why-wakes-cost-tokens.md)** | Empirical breakdown of where input tokens go on every Hermes wake. Measured numbers from production, not estimates. Five ranked "cuts" with savings projections and an honest verdict on which ones the plugin can ship alone vs. which need upstream Hermes changes. |
| **[03 — How the CWD fix saved 22%](./03-cwd-fix-saved-22-percent.md)** | Validation report for the `v0.1.11` change: per-agent scratch CWD instead of `/app`. Real wake measurements before/after, projected dollar savings, regression check. The pattern this report uses (cold vs. warm wake comparison) is the template for any future plugin optimization. |
| **[04 — Bento unattended install](./04-bento-unattended-install.md)** | How the bento `install paperclip` path lands the plugin, the Hermes binary, and the wrapper in one shot — no SSH, no editing files. Includes the three-option design analysis, the idempotency contract, failure modes, and the upgrade path for an existing install. |
| **[Reproduction guide](../REPRODUCTION.md)** | (Legacy) Step-by-step manual install on a VPS. Use `04` instead; this kept around as an emergency recovery doc. |

## TL;DR for the impatient

- The plugin **overrides Paperclip's built-in `hermes_local` adapter**. Both register under the same `type`, but the external one (us) wins when loaded.
- It targets two operators at once: the **aluno leigo** (UI-only) and the **aluno avançado** (CLI/yaml-comfortable). Neither audience is degraded for the other.
- The hard rule: **the plugin reads `~/.hermes/config.yaml`, never writes it.** No dual-owner races, no clobbering operator edits.
- v0.1.10 was the milestone version where Custom Provider routing started working end-to-end (correct env var names + Hermes blocklist bypass). v0.1.11 added the CWD optimization.

## What's not in here yet

- `05 — Upstream Hermes patch proposal` — the `--skills-allowlist` flag we'd need to land Cut 1. Filed against Hermes Agent once the patch is drafted.
- `06 — Publishing v0.1.x to npm` — the install path expects the package on the registry; the publish step is still manual today.
