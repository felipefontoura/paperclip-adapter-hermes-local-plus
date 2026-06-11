# paperclip-adapter-hermes-local-plus

**Drop-in replacement for Paperclip's built-in `hermes_local` adapter.**
Brings the full power of [Hermes Agent](https://hermes-agent.nousresearch.com)
into the [Paperclip](https://paperclipai.com) UI — for both the non-technical
operator and the operator who knows their way around a YAML.

```bash
npm install @felipefontoura/paperclip-adapter-hermes-local-plus
```

That's it. No fork, no patch, no monkey-patch. The plugin registers under
the same `type` as the built-in adapter and Paperclip's external-plugin
loader makes it the active one.

---

## Why this exists

Paperclip ships a tiny built-in `hermes_local` adapter that spawns
`hermes chat -q "<prompt>"` and parses the output. It's a starting
point. In day-to-day operation, you hit ten things that don't quite work:

- Multi-file skills (Hormozi, Feynman, etc.) lose their `references/`
  on the way to Hermes because Paperclip's runtime build strips them.
- Provider selection lives in `~/.hermes/config.yaml`. Want this agent
  on Anthropic and that one on Z.AI? SSH in, edit YAML, restart.
- Pluging in a Together AI / Groq / Ollama / OpenRouter? Edit
  `custom_providers:` by hand. Aluno leigo never finds out how.
- The default heartbeat template kidnaps the agent. The persona you
  carefully wrote in AGENTS.md gets overridden by "list all open
  issues, post a completion comment …".
- 22% of every wake's token bill is the Paperclip server's own
  `AGENTS.md` accidentally injected by Hermes auto-discovery into the
  system prompt — for every aluno agent that has nothing to do with
  the Paperclip codebase.
- Cosmetic UI fields that don't do anything ("Thinking effort" — pass-
  through to a CLI flag that Hermes doesn't have).

This plugin is the **production-grade** version that fixes all of those
without touching the upstream Paperclip image and without writing to
`~/.hermes/config.yaml`.

The full list is in `docs/01-configuration-fields-reference.md`.

---

## Highlights

| Feature | What it changes |
| --- | --- |
| **Skill references survive** | `syncSkills()` symlinks against the source directory, not the runtime snapshot. Every file in `references/`, `assets/`, etc. shows up to Hermes. |
| **Provider dropdown that tells the truth** | UI Provider select is built dynamically from `~/.hermes/config.yaml` + `auth.json`. Only providers actually configured on this install show up. No 401s from clicking "huggingface" without a key. |
| **Custom OpenAI-compatible provider, 1 minute** | Pick `Custom` in the Provider select, paste a Base URL, paste a key, type a model id. Plugin injects `OPENAI_BASE_URL` / `OPENAI_API_KEY` plus Hermes's `_HERMES_FORCE_` escape hatch. Routes the wake at Together / Groq / Fireworks / OpenRouter / Ollama / vLLM / anything OpenAI-shaped. |
| **One company secret, N agents** | Custom Provider API Key field accepts `${TOGETHER_API_KEY}` references resolved from the agent-level Environment Variables row. Rotate a key once; every agent picks up the change. |
| **Heartbeat template that doesn't hijack** | When `AGENTS.md` has substantive content, a light prompt template kicks in. The persona drives, not the operational workflow. 18 k → 5 k input tokens on a focused-task wake we measured. |
| **22% token cost reduction shipped** | Per-agent scratch CWD stops Hermes from auto-injecting Paperclip's own contributor guide as "Project Context". Verified live: 9 044 → 6 992 input tokens. |
| **Honest error surfaces** | No silent `catch { }` blocks for failure paths the plugin owns. Wrong JSON in Extra Headers? Surface in the Run page. Provider auto-detection fell back? Logged. |
| **Configuration fields the upstream adapter doesn't expose** | `getConfigSchema()` returns 10 fields the Paperclip UI renders natively — Provider, Custom Provider URL/Key/Model/Headers, Heartbeat template mode, Prompt template, Toolsets, Session resume, Debug. |

---

## How to install

### Option 1: as a Paperclip external plugin

The Paperclip server reads `/paperclip/adapter-plugins.json`. Add this
plugin and restart the service:

```bash
# Inside the paperclip container
cd /paperclip/adapter-plugins
mkdir -p hermes-local-plus-0.1.11
cd hermes-local-plus-0.1.11
npm pack @felipefontoura/paperclip-adapter-hermes-local-plus@0.1.11
tar xzf felipefontoura-paperclip-adapter-hermes-local-plus-0.1.11.tgz --strip-components=1

# Register
node -e '
  const fs = require("fs");
  const p = "/paperclip/adapter-plugins.json";
  const cur = JSON.parse(fs.readFileSync(p, "utf8")).filter(x => x.type !== "hermes_local");
  cur.push({
    packageName: "/paperclip/adapter-plugins/hermes-local-plus-0.1.11",
    localPath:   "/paperclip/adapter-plugins/hermes-local-plus-0.1.11",
    version: "0.1.11",
    type: "hermes_local",
    installedAt: new Date().toISOString(),
  });
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
'

# Restart paperclip
docker service update --force paperclip_paperclip
```

After the restart Paperclip's UI shows `Hermes Agent (local)` as an
adapter type. Create an agent, hit `Run Heartbeat`, done.

### Option 2: via bento (unattended install)

If your Paperclip lives on a [bento](https://github.com/felipefontoura/bento)-managed
host, `bento install paperclip` does everything above. See
`docs/04-bento-unattended-install.md` for the full breakdown.

---

## Configuration in the Paperclip UI

`Configuration` tab on every agent of type `Hermes Agent (local)`:

```
Permissions & Configuration
├── Command                           hermes
├── Model                             Default ▾  (dynamic from config.yaml)
├── Provider                          Auto ▾     (dynamic from config.yaml + auth.json)
├── Custom Provider — Base URL        https://api.together.xyz/v1
├── Custom Provider — API Key         ${TOGETHER_API_KEY}
├── Custom Provider — Model           meta-llama/Llama-3.1-70B-Instruct
├── Custom Provider — Extra headers   {"X-Org-Id": "abc"}
├── Heartbeat template mode           Auto ▾
├── Prompt template (advanced)        (textarea, supports {{variables}})
├── Toolsets                          terminal,skills,web,browser,...
├── Session resume                    Auto ▾
└── Debug                             ⚫ off
```

Each field is documented in `docs/01-configuration-fields-reference.md`
with the exact CLI flag / env var it maps to and the trade-off you're
buying.

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ Paperclip server (Node)                                │
│   ↳ external adapter plugin: hermes-local-plus         │
│       ├── getConfigSchema()    drives the UI form       │
│       ├── listModels()         Model select             │
│       ├── listProviders()      Provider select          │
│       ├── execute(ctx, cfg)    spawns Hermes subprocess │
│       └── syncSkills(ctx, …)   symlinks source dirs     │
└──────────────────────┬─────────────────────────────────┘
                       │  subprocess
                       ▼
┌────────────────────────────────────────────────────────┐
│ /usr/local/bin/hermes-paperclip                        │
│   ↳ wraps /opt/hermes/bin/hermes                       │
│       ↳ reads ~/.hermes/config.yaml + auth.json + .env │
│       ↳ runs `chat` with args+env from the plugin      │
└────────────────────────────────────────────────────────┘
```

The plugin owns translation: UI form fields → CLI args + env vars.
Hermes owns execution. `config.yaml` belongs to the operator alone —
the plugin reads it to populate dropdowns, but never writes.

---

## Documentation

| Doc | Read when |
| --- | --- |
| [`docs/01-configuration-fields-reference.md`](./docs/01-configuration-fields-reference.md) | You're configuring an agent and want to know what a field does, what the trade-off is, and an example. |
| [`docs/02-why-wakes-cost-tokens.md`](./docs/02-why-wakes-cost-tokens.md) | You're surprised by your bill. Empirical breakdown of where Hermes input tokens go, what's prunable, what isn't. |
| [`docs/03-cwd-fix-saved-22-percent.md`](./docs/03-cwd-fix-saved-22-percent.md) | You want a template for measuring + validating a plugin optimization. |
| [`docs/04-bento-unattended-install.md`](./docs/04-bento-unattended-install.md) | You operate a bento-managed host and want the unattended install path. |

---

## Compatibility

Tested against:

- Paperclip server: `ghcr.io/paperclipai/paperclip:latest` (built-in
  external-adapter loader required).
- Hermes Agent: `nousresearch/hermes-agent:latest`. Verified routes:
  `chat`, `sessions export`, `--resume`, `--continue`. Custom Provider
  routing tested with Z.AI's OpenAI-compatible endpoint.
- Providers exercised end-to-end: Anthropic (`anthropic`), OpenAI
  (`openai-codex`), Z.AI (`zai-coding-plan`), OpenRouter (`openrouter`),
  any OpenAI-compatible via the Custom Provider form.
- Docker Swarm with Paperclip running as a single replica. Plugin is
  stateless — multi-replica is a function of the underlying Paperclip
  install, not us.

---

## Status

`v0.1.x` — production-deployed at the maintainer's install. Stable for
the use cases listed above. Breaking changes still permitted between
minor versions while the API settles. Pin a specific version in your
`adapter-plugins.json` entry.

---

## License

MIT. See [`LICENSE`](./LICENSE).

Built on top of [`hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-agent)
(Nous Research) — same shape, different opinion about what the operator
actually needs.
