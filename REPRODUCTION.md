# Plugin Override Reproduction Guide

End-to-end reproduction of `@felipefontoura/paperclip-adapter-hermes-local-plus@0.1.2`
plugin override of the built-in `hermes_local` adapter. Validated 2026-06-11
against Paperclip production at `paperclip.base25.so` (stack `paperclip`,
container image `ghcr.io/paperclipai/paperclip:latest`).

What this plugin replaces (vs. upstream `hermes-paperclip-adapter@0.3.0` from
Nous Research): the four patches Felipe was applying via bind-mount on the VPS
go INTO the plugin source, so the Paperclip container no longer bind-mounts
patched JS files over the upstream package.

## What the plugin needs at runtime

The plugin itself is self-contained (`@paperclipai/*` deps bundled inline via
tsup `noExternal`). The host needs these EXTERNAL pieces that the plugin does
not ship:

1. **Hermes binary inside the Paperclip container at `/opt/hermes/bin/hermes`**.
   The plugin spawns this as a subprocess. Provided via cross-stack named
   volume mount (the `hermes-bin` volume from the `hermes` stack).
2. **Shell wrappers** at `/usr/local/bin/hermes` and `/usr/local/bin/hermes-paperclip`
   that export `HERMES_DOCKER_EXEC_AS_ROOT=1` and exec the real binary.
   Hermes' shim refuses to run as root without that env flag; the Paperclip
   container runs as root inside (not the host root). Wrappers are tiny — 5
   lines each — bind-mounted from `/srv/paperclip/bin/` on the host.

## One-shot install on the VPS (what I did this session)

```bash
ssh root@paperclip.base25.so
PCID=$(docker ps --filter "name=paperclip_paperclip" --format "{{.ID}}" | head -1)

# 1) Cross-stack hermes-bin mount (only if not already mounted)
docker volume inspect hermes_hermes-bin >/dev/null 2>&1 || { echo "hermes stack not deployed"; exit 1; }
docker service update \
  --mount-add "type=volume,source=hermes_hermes-bin,target=/opt/hermes,volume-nocopy=true,readonly" \
  paperclip_paperclip

# 2) Wrappers
mkdir -p /srv/paperclip/bin
cat > /srv/paperclip/bin/hermes <<'WRAPPER'
#!/bin/bash
export HERMES_DOCKER_EXEC_AS_ROOT=1
exec /opt/hermes/bin/hermes "$@"
WRAPPER
cp /srv/paperclip/bin/hermes /srv/paperclip/bin/hermes-paperclip
chmod +x /srv/paperclip/bin/hermes /srv/paperclip/bin/hermes-paperclip

docker service update \
  --mount-add "type=bind,source=/srv/paperclip/bin/hermes,target=/usr/local/bin/hermes,readonly" \
  --mount-add "type=bind,source=/srv/paperclip/bin/hermes-paperclip,target=/usr/local/bin/hermes-paperclip,readonly" \
  paperclip_paperclip

# 3) Pack + ship + extract plugin
cd ~/Work/paperclip-adapter-hermes-local-plus
pnpm pack
scp felipefontoura-paperclip-adapter-hermes-local-plus-0.1.2.tgz root@paperclip.base25.so:/tmp/

ssh root@paperclip.base25.so '
PCID=$(docker ps --filter "name=paperclip_paperclip" --format "{{.ID}}" | head -1)
docker cp /tmp/felipefontoura-paperclip-adapter-hermes-local-plus-0.1.2.tgz "$PCID:/paperclip/adapter-plugins/"
docker exec -u node "$PCID" sh -c "
  cd /paperclip/adapter-plugins
  rm -rf hermes-local-plus-0.1.2
  mkdir hermes-local-plus-0.1.2
  cd hermes-local-plus-0.1.2
  tar xzf ../felipefontoura-paperclip-adapter-hermes-local-plus-0.1.2.tgz --strip-components=1
"
'

# 4) Register in adapter-plugins.json (overrides built-in hermes_local)
docker exec -u node -i "$PCID" node - <<'NODEJS'
const fs = require("fs");
const p = "/paperclip/adapter-plugins.json";
let cur = JSON.parse(fs.readFileSync(p, "utf8") || "[]").filter(x => x && x.type !== "hermes_local");
cur.push({
  packageName: "/paperclip/adapter-plugins/hermes-local-plus-0.1.2",
  localPath:   "/paperclip/adapter-plugins/hermes-local-plus-0.1.2",
  version: "0.1.2",
  type: "hermes_local",
  installedAt: new Date().toISOString()
});
fs.writeFileSync(p, JSON.stringify(cur, null, 2));
NODEJS

# 5) Restart Paperclip server so it re-imports the registered plugins
docker kill "$PCID"
# Swarm respawns automatically; wait ~30s for the new container to be ready.
```

Verify the override registered:

```bash
docker service logs paperclip_paperclip --since 2m 2>&1 \
  | grep -E 'External adapter|Loaded external'
```

Should print:
```
[paperclip] External adapter "hermes_local" overrides built-in adapter
Loaded external adapters from plugin store {"count":N,"adapters":[...,"hermes_local"]}
```

## What to test (canonical E2E)

1. UI → New Agent → Configure manually → Hermes Agent (local).
2. In the New Agent form, pick the password-test skill (or any other Paperclip-managed skill that has known content).
3. Save. The Instructions tab is now visible because the plugin advertises
   `supportsInstructionsBundle: true`. Edit `AGENTS.md` via the UI — write
   something specific (e.g. "reply with the password from the password-test skill, nothing else").
4. (Optional) `POST /api/agents/<id>/skills/sync` with the desired skill list
   to force materialisation of the symlinks under `~/.hermes/skills/`. Wakes
   should trigger this automatically; this is just to verify out-of-band.
5. UI → Run Heartbeat. Expected: the agent reads the AGENTS.md you wrote,
   invokes `skill_view` to extract whatever your skill returns, and replies
   with that string verbatim.

## What bento needs to do to ship this

- `stacks/app/paperclip/install.sh`: replace the hand-mounted patches block
  with `npm pack` of this package + extract into `/paperclip/adapter-plugins/`
  + JSON-merge into `adapter-plugins.json`. Same pattern as the existing
  `hermes-gateway` install.
- `stacks/app/paperclip/compose.yml`: keep the wrapper bind mounts
  (`/srv/paperclip/bin/hermes*` → `/usr/local/bin/hermes*`).
- `lib/install-helpers.sh::graft_external_volume_to_service`: must be RESTORED
  (it was removed when the HTTP arch landed). It is the helper that mounts the
  `hermes_hermes-bin` volume into the Paperclip service.
- `stacks/app/paperclip/manifest.json`: declare the volume graft and the
  wrapper bind mounts as install-time steps so unattended re-installs reproduce
  the state.

This guide reflects the **manual** sequence I ran this session against the
live VPS. None of it touched bento source. When you want to land it for real,
mirror the steps in install.sh + manifest.
