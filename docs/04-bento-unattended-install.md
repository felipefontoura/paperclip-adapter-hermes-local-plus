# How bento installs the plugin (unattended, zero terminal post-install)

This doc explains what `bento install` does when you deploy the
`paperclip` stack, with or without the companion `hermes` stack on the
same host. Read it if you joined the project after the fact and want to
know what actually happens between "I clicked deploy" and "I'm in the
Paperclip UI clicking Run Heartbeat".

---

## 1. Two scenarios bento has to support

### 1.1. Scenario A — paperclip alone, no hermes stack

- The operator deploys only the `paperclip` stack.
- Built-in adapters (`claude_local`, `codex_local`, `opencode_local`)
  cover their needs.
- The `hermes_local` adapter plugin IS still installed. It's harmless
  on its own (zero RAM, zero disk beyond the plugin tarball) and
  becomes immediately usable the day the operator adds the `hermes`
  stack to the same host.
- Creating an agent of type "Hermes Agent (local)" succeeds in the UI,
  but Run Heartbeat fails with a clear "deploy hermes stack and re-run
  `bento install paperclip`" message in the Run page. Expected.

### 1.2. Scenario B — paperclip + hermes, both deployed

- The operator deploys both stacks.
- `hermes_local` becomes fully functional. It spawns the Hermes CLI
  from the cross-stack mount of the `hermes-bin` volume — no copies,
  no duplication.
- `config.yaml` and `auth.json` are shared between the hermes daemon
  (running `gateway run` in the hermes stack) and the Hermes
  subprocess spawned by the plugin in the paperclip container. Single
  source of truth: whatever the hermes stack renders from
  `state.providers` is what both Hermes runtimes use.

---

## 2. The bind that makes Scenario B work

Bento's `lib/install-helpers.sh` ships
`graft_external_volume_to_service` — a helper that calls
`docker service update --mount-add` to attach a named volume from one
stack to a service in another, at runtime, on a rolling update.

It is **symmetric and idempotent**:

- Soft no-op when the peer service doesn't exist.
- Soft no-op when the volume doesn't exist.
- Soft no-op when the target path is already mounted.
- Otherwise: rolling update, mount added.

Paperclip's `install.sh` calls it twice:

```bash
graft_external_volume_to_service \
    paperclip_paperclip \
    hermes_hermes-bin \
    /opt/hermes \
    readonly

graft_external_volume_to_service \
    paperclip_paperclip \
    hermes_hermes-data \
    /opt/hermes-shared \
    readonly
```

After both grafts succeed, the paperclip container can:

| Path in paperclip | Source | Used for |
| --- | --- | --- |
| `/opt/hermes/bin/hermes` | hermes stack volume `hermes-bin` (RO) | Plugin subprocess: `exec /opt/hermes/bin/hermes chat …` |
| `/opt/hermes-shared/config.yaml` | hermes stack volume `hermes-data` (RO) | Symlinked at `/paperclip/.hermes/config.yaml` |
| `/opt/hermes-shared/auth.json` | hermes stack volume `hermes-data` (RO) | Symlinked at `/paperclip/.hermes/auth.json` |
| `/paperclip/.hermes/skills/` | paperclip-data | Plugin `syncSkills` writes here (per-wake state) |
| `/paperclip/.hermes/sessions/` | paperclip-data | Hermes subprocess writes per-wake session DBs here |

Plugin code doesn't need to know which scenario it's in — the wrapper
at `/usr/local/bin/hermes-paperclip` execs `/opt/hermes/bin/hermes`
unconditionally, and the symlinks resolve to wherever they point.

---

## 3. How the hermes stack prepares the `hermes-bin` volume

`stacks/app/hermes/compose.yml` declares a one-shot init service:

```yaml
hermes-init:
  image: nousresearch/hermes-agent:${HERMES_IMAGE_TAG:-latest}
  entrypoint: ["sh", "-c"]
  command: ["cp -r /opt/hermes/. /shared/hermes/ && echo done"]
  volumes:
    - hermes-bin:/shared/hermes
  deploy:
    restart_policy:
      condition: none
```

Swarm schedules it once on every stack deploy. It copies the Hermes
runtime out of the image into the `hermes-bin` named volume, then
exits. Re-running on the same volume is idempotent (`cp -r` over the
same bytes is a no-op).

The hermes stack's `install.sh` checks the service status afterwards
and surfaces failures in install logs — image pull errors, disk full,
etc — instead of swallowing them.

`hermes-bin` is a `driver: local` named volume; nothing prevents
paperclip from mounting it RO via the graft. Hermes the daemon never
writes to it at runtime; it only reads `/opt/hermes/*` (the binary +
Python deps).

---

## 4. Deploy order

Both deploy orders end in the same correct state. The graft handles
both directions silently.

### 4.1. paperclip first, hermes after

```bash
bento install paperclip   # grafts no-op (hermes-bin doesn't exist yet)
bento install hermes      # init populates hermes-bin
bento install paperclip   # grafts succeed, mounts wired, symlinks point at shared config
```

The double-`bento install paperclip` is the cost of letting paperclip
stand alone in Scenario A. If the operator knows they'll deploy both,
they can reverse the order:

### 4.2. hermes first, paperclip after

```bash
bento install hermes      # init populates hermes-bin
bento install paperclip   # grafts succeed on first try
```

This is the recommended order for operators planning Scenario B.

### 4.3. Re-deploy hermes after both are live

`docker service update` on `hermes_hermes` replaces tasks but doesn't
touch named volumes — the `hermes-bin` mount in paperclip survives.
The `hermes-init` service re-fires on stack-level redeploys (i.e.
`bento install hermes` re-runs `portainer_create_stack_from_git`),
which is the moment the binary could change. Idempotent: cp -r over
identical bytes is a no-op; over a new Hermes version, it overwrites
in place. Paperclip's existing mount sees the new bytes next time it
exec's the binary — no paperclip restart required.

---

## 5. Failure modes called out

| Symptom | What happened | Fix |
| --- | --- | --- |
| Run Heartbeat exits with `[hermes-paperclip] /opt/hermes/bin/hermes not found. Deploy the hermes stack…` | Scenario A path. Graft hasn't fired because hermes stack isn't there. | Deploy hermes (`bento install hermes`), re-run `bento install paperclip`. |
| `hermes_local` adapter type not present in the UI Configuration tab | npm package version pinned in `manifest.json` (`HERMES_LOCAL_PLUS_VERSION`) isn't on the registry yet. | Bump the version to one that's published, or register the plugin manually via the Adapter manager. |
| Wake exits 0 but `config.yaml` shows providers the operator never set | The shared mount is wired and the operator was looking at `/opt/data/config.yaml` (the hermes daemon's view). That's the same file the plugin reads. By design. | Edit `/opt/data/config.yaml` (in either container) once; both Hermes runtimes see the change immediately. |
| `paperclip` redeployed after operator hand-edited `config.yaml.local-backup-…` | install.sh moved any non-symlink config out of the way before laying down the symlink. The backup is the prior content. | Reconcile by hand — paste merge-relevant entries into the shared `/opt/data/config.yaml`, delete the backup once you're sure. |

---

## 6. What about Cross B (paperclip-data → hermes)?

The hermes daemon (future Telegram/cron paths) will want to read
paperclip skills + agent instructions to drive externally-triggered
agents. That mount goes the OTHER direction — paperclip's volume into
the hermes container.

It is **not** in this Sprint. The reason is purely a deploy-order
limitation: declaring `paperclip_paperclip-data` as `external: true`
in the hermes compose breaks the hermes-only scenario (Swarm fails
validation when the volume hasn't been created yet). The next sprint
on this codepath will add the second graft from the hermes side once
the cross-call semantics are firmed up.

---

## 7. Migration from the prior approach

The previous version of this install.sh copied 1.2 GB of Hermes
runtime into `paperclip-data` at first deploy. That is gone. On the
next `bento install paperclip` after this change lands:

1. The graft fires (assuming hermes is deployed).
2. The wrapper script is updated to point at `/opt/hermes/bin/hermes`
   (the mount target) instead of `/paperclip/.hermes-runtime/bin/hermes`
   (the now-orphan copy).
3. The orphan `/paperclip/.hermes-runtime/` directory is NOT cleaned up
   by install.sh — that's left to the operator if they care about the
   1.2 GB. Run inside the paperclip container:

```bash
docker exec -u node <paperclip-container> sh -c 'rm -rf /paperclip/.hermes-runtime'
```

---

## 8. Where the source lives

- This file: `paperclip-adapter-hermes-local-plus/docs/04-bento-unattended-install.md`
- Helper: `bento/lib/install-helpers.sh::graft_external_volume_to_service`
- Bento bento changes: `bento/stacks/app/{paperclip,hermes}/{install.sh,compose.yml,manifest.json}`
- Plugin code: `paperclip-adapter-hermes-local-plus/src/`
- Legacy manual reproduction (kept as emergency recovery): `paperclip-adapter-hermes-local-plus/REPRODUCTION.md`
