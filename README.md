# paperclip-adapter-hermes-local-plus

**Drop-in replacement for Paperclip's built-in `hermes_local` adapter.**
Brings [Hermes Agent](https://hermes-agent.nousresearch.com) into the
[Paperclip](https://paperclipai.com) UI, with the rough edges of the built-in
adapter fixed.

```bash
npm install @felipefontoura/paperclip-adapter-hermes-local-plus
```

No fork, no patch, no monkey-patch. The plugin registers under the same `type`
as the built-in adapter and Paperclip's external-plugin loader makes it the
active one.

---

## Why this exists

Paperclip ships a tiny built-in `hermes_local` adapter that spawns
`hermes chat -q "<prompt>"` and parses the output. It's a starting point. In
day-to-day operation you hit a handful of things that don't quite work — and
several of them are bugs the upstream `hermes-paperclip-adapter` (Nous Research)
has too:

- The agent's **persona** (SOUL/AGENTS/HEARTBEAT/TOOLS) never reaches Hermes —
  the built-in adapter ignores the Paperclip-managed instruction bundle.
- **Multi-file skills lose their `references/`** because Paperclip's runtime
  build strips everything except `SKILL.md`.
- **22% of every wake's input tokens** is Paperclip's own `/app/AGENTS.md`,
  accidentally injected by Hermes' auto-discovery.
- The **Run page shows dashes** for tokens/cost, and goes **blank** when
  Hermes' quiet mode doesn't echo the final message to stdout.
- **Comment/task wakes get ignored** because the wake context isn't read from
  the place Paperclip actually delivers it.

This plugin fixes all of those without touching the upstream Paperclip image and
without writing to `~/.hermes/config.yaml`.

---

## Highlights

| Feature | What it changes |
| --- | --- |
| **Persona reaches Hermes** | `readBundleEntry()` prepends the Paperclip-managed bundle (SOUL → AGENTS → HEARTBEAT → TOOLS) to every wake's prompt. The built-in adapter ignores it. |
| **Skill references survive** | `syncSkills()` symlinks against the source directory, not the runtime snapshot — every file in `references/`, `assets/`, etc. reaches Hermes. |
| **−22% input tokens** | Per-agent scratch CWD stops Hermes from auto-injecting Paperclip's `/app/AGENTS.md`. Measured 9 044 → 6 992 input tokens. See [`docs/03`](./docs/03-cwd-fix-saved-22-percent.md). |
| **Real tokens & cost on the Run page** | After the wake, `hermes sessions export` is read back to populate input/output/cache tokens and cost. |
| **No blank runs** | When Hermes' quiet mode doesn't echo the final message, the plugin recovers it from the session and replays it to the transcript. |
| **Comment/task wakes work** | Reads the wake context (task, comment) from `ctx.context` and injects Paperclip's task markdown, so the agent addresses what was actually asked. |
| **Hermes owns model/provider/effort** | The plugin doesn't fight Hermes over model selection — model, provider and reasoning effort are resolved from `~/.hermes/config.yaml`. |

This fork stays close to upstream: model/provider/effort, toolset defaults and
`--yolo` all behave the way Nous' adapter does. The value is the bundle
injection, skill symlinks, token/cost reporting and the wake-context fixes.

---

## How to install

### Option 1: as a Paperclip external plugin

The Paperclip server reads `/paperclip/adapter-plugins.json`. Add this plugin
and restart the service:

```bash
# Inside the paperclip container
cd /paperclip/adapter-plugins
mkdir -p hermes-local-plus-0.1.16
cd hermes-local-plus-0.1.16
npm pack @felipefontoura/paperclip-adapter-hermes-local-plus@0.1.16
tar xzf felipefontoura-paperclip-adapter-hermes-local-plus-0.1.16.tgz --strip-components=1

# Register
node -e '
  const fs = require("fs");
  const p = "/paperclip/adapter-plugins.json";
  const cur = JSON.parse(fs.readFileSync(p, "utf8")).filter(x => x.type !== "hermes_local");
  cur.push({
    packageName: "/paperclip/adapter-plugins/hermes-local-plus-0.1.16",
    localPath:   "/paperclip/adapter-plugins/hermes-local-plus-0.1.16",
    version: "0.1.16",
    type: "hermes_local",
    installedAt: new Date().toISOString(),
  });
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
'

# Restart paperclip
docker service update --force paperclip_paperclip
```

After the restart Paperclip's UI shows `Hermes Agent` as an adapter type.
Create an agent, hit `Run Heartbeat`, done.

The plugin spawns `/opt/hermes/bin/hermes` (override via the `PAPERCLIP_HERMES_CLI`
compose env, or the agent's `Command` field).

### Option 2: via bento (unattended install)

If your Paperclip lives on a [bento](https://github.com/felipefontoura/bento)-managed
host, `bento install paperclip` does everything above, including the cross-stack
mount of the Hermes binary. See
[`docs/04`](./docs/04-bento-unattended-install.md).

---

## Configuration

Model, provider and reasoning effort are **owned by Hermes** (`~/.hermes/config.yaml`)
— the universal "Model" / "Thinking effort" fields are ignored. The agent's
**persona** is edited in the **Instructions** tab (SOUL.md, AGENTS.md,
HEARTBEAT.md, TOOLS.md) and **skills** in the **Skills** tab.

The `Configuration` tab adds two plugin-specific fields:

```
├── Session resume   Auto ▾   (auto = resume previous session · never = fresh every wake)
└── Debug            ⚫ off    (pass -v to Hermes for verbose output)
```

Advanced operators can also set `command`, `cwd`, `maxTurnsPerRun` and
`extraArgs` via the API; they have no UI field.

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ Paperclip server (Node)                                │
│   ↳ external adapter plugin: hermes-local-plus         │
│       ├── getConfigSchema()    drives the UI form       │
│       ├── execute(ctx, cfg)    spawns Hermes subprocess │
│       └── syncSkills(ctx, …)   symlinks source dirs     │
└──────────────────────┬─────────────────────────────────┘
                       │  subprocess
                       ▼
┌────────────────────────────────────────────────────────┐
│ /opt/hermes/bin/hermes                                 │
│   ↳ reads ~/.hermes/config.yaml + auth.json + .env     │
│   ↳ runs `chat` with the args + env the plugin built   │
└────────────────────────────────────────────────────────┘
```

The plugin owns translation: persona bundle + skills → CLI args + env vars.
Hermes owns execution. `config.yaml` belongs to the operator alone — the plugin
never writes it.

---

## Documentation

| Doc | Read when |
| --- | --- |
| [`docs/03-cwd-fix-saved-22-percent.md`](./docs/03-cwd-fix-saved-22-percent.md) | You want the validation report (and template) for the per-agent CWD token optimization. |
| [`docs/04-bento-unattended-install.md`](./docs/04-bento-unattended-install.md) | You operate a bento-managed host and want the unattended install path. |

---

## Compatibility

Tested against:

- Paperclip server: `ghcr.io/paperclipai/paperclip:latest` (external-adapter
  loader required).
- Hermes Agent: `nousresearch/hermes-agent:latest`. Verified routes: `chat`,
  `sessions export`, `--resume`.
- Docker Swarm with Paperclip as a single replica. The plugin is stateless —
  multi-replica is a function of the underlying Paperclip install, not us.

---

## Status

`v0.1.x` — production-deployed at the maintainer's install. Stable for the use
cases above. Breaking changes still permitted between minor versions while the
API settles; pin a specific version in your `adapter-plugins.json` entry.

---

## License

MIT. See [`LICENSE`](./LICENSE).

Built on top of [`hermes-paperclip-adapter`](https://github.com/NousResearch/hermes-agent)
(Nous Research) — same shape, a few bugs fixed, an opinion about what the
operator actually needs.
