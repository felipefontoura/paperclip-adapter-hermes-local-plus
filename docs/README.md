# Docs — `paperclip-adapter-hermes-local-plus`

Operational reference for this plugin. For what it is and how to configure an
agent, start with the [root README](../README.md).

| Doc | What you'll learn |
| --- | --- |
| **[03 — How the CWD fix saved 22%](./03-cwd-fix-saved-22-percent.md)** | Validation report for the per-agent scratch CWD: spawning Hermes in `<agent>/` instead of `/app` stops it from auto-injecting Paperclip's own `/app/AGENTS.md`. Real before/after wake measurements (9 044 → 6 992 input tokens) and the regression check. |
| **[04 — Bento unattended install](./04-bento-unattended-install.md)** | How the bento `install paperclip` path lands the plugin and the cross-stack mount of the Hermes binary at `/opt/hermes` in one shot — no SSH, no editing files. Includes the idempotency contract and failure modes. |

## TL;DR

- The plugin **overrides Paperclip's built-in `hermes_local` adapter** — both register under the same `type`; the external one (us) wins when loaded.
- It **reads `~/.hermes/config.yaml`, never writes it.** Model, provider and reasoning effort are owned by Hermes; the plugin only translates the persona bundle, skills and a couple of runtime knobs into a `hermes chat` invocation.
