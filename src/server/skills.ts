/**
 * Skills bridge — fork of hermes-paperclip-adapter@0.3.0 with:
 *
 *  - Patch #4: syncHermesSkills() actually materialises symlinks in
 *    `<HERMES_HOME>/.hermes/skills/` mirroring the opencode_local pattern.
 *    Upstream is a no-op, so selecting a Paperclip-managed skill in the UI
 *    never reaches Hermes' runtime scanner. We materialise on every sync
 *    + tear down skills that were unselected.
 *
 * listHermesSkills + buildHermesSkillSnapshot are unchanged — they already
 * scan both Paperclip-managed and Hermes-native skills.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// v0.1.6 — Paperclip skill catalog reader (HTTP)
// ---------------------------------------------------------------------------
// `@paperclipai/adapter-utils` returns `source` pointing at the per-skill
// `__runtime__/<bare>--<hash>/` directory. That snapshot only contains
// SKILL.md — references/, assets/, etc. are stripped by the server's
// materialise step. To make multi-file skills (Hormozi, Feynman, etc)
// usable from Hermes, we need the ORIGINAL source dir — which the server
// exposes at `GET /api/companies/:cid/skills` via the `sourcePath` field.
//
// Why HTTP and not a direct module import:
//   - The plugin runs in the same Node process as the Paperclip server,
//     so technically we COULD `import("/app/server/dist/services/company-skills.js")`
//     and call `companySkillService(...)`.
//   - The internal service requires the server's DB pool, secret resolver,
//     and config — none of which are passed to plugins by contract.
//     Wiring them up is fragile and acopla o plugin a paths internos
//     undocumented que mudam entre versões.
//   - `@paperclipai/adapter-utils` deliberately does NOT expose sourcePath,
//     by design — adapters should not depend on filesystem layout details.
//   - The HTTP API IS the contract. It's documented, stable, versioned,
//     and the response includes everything we need (`sourcePath`,
//     `fileInventory`). Adapter already has the auth token in `ctx`.
//
// Latency cost: one extra ~5-10ms localhost roundtrip per syncSkills call.
// We cache the result by companyId for 30s so consecutive wakes don't pay
// the cost. The Paperclip server is the source of truth — when the cache
// expires we fetch again.
// ---------------------------------------------------------------------------

interface PaperclipSkillCatalogEntry {
  key: string;
  slug: string;
  sourcePath: string | null;
  fileInventory: Array<{ path: string }> | string[];
}

interface CatalogCacheEntry {
  fetchedAt: number;
  byKey: Map<string, PaperclipSkillCatalogEntry>;
}

const CATALOG_CACHE = new Map<string, CatalogCacheEntry>();
const CATALOG_CACHE_TTL_MS = 30_000;

function readCtxAuthToken(ctx: AdapterSkillContext): string | null {
  const candidates = [
    (ctx as { authToken?: unknown }).authToken,
    (ctx.config as { paperclipApiKey?: unknown } | undefined)?.paperclipApiKey,
    process.env.PAPERCLIP_API_KEY,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

function readCtxCompanyId(ctx: AdapterSkillContext): string | null {
  const fromAgent = (ctx as { agent?: { companyId?: unknown } }).agent?.companyId;
  if (typeof fromAgent === "string" && fromAgent.trim().length > 0) return fromAgent.trim();
  const fromConfig = (ctx.config as { companyId?: unknown } | undefined)?.companyId;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) return fromConfig.trim();
  return null;
}

function readPaperclipApiBase(ctx: AdapterSkillContext): string {
  const fromConfig = (ctx.config as { paperclipApiUrl?: unknown } | undefined)?.paperclipApiUrl;
  const raw =
    (typeof fromConfig === "string" && fromConfig) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  return raw.endsWith("/api") ? raw : raw.replace(/\/+$/, "") + "/api";
}

async function fetchPaperclipSkillCatalog(
  ctx: AdapterSkillContext,
): Promise<Map<string, PaperclipSkillCatalogEntry> | null> {
  const companyId = readCtxCompanyId(ctx);
  if (!companyId) return null;

  const cached = CATALOG_CACHE.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cached.byKey;
  }

  const token = readCtxAuthToken(ctx);
  if (!token) return null;
  const base = readPaperclipApiBase(ctx);
  const url = `${base}/companies/${encodeURIComponent(companyId)}/skills`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    const byKey = new Map<string, PaperclipSkillCatalogEntry>();
    for (const raw of data) {
      const entry = raw as Record<string, unknown>;
      const key = asString(entry.key);
      if (!key) continue;
      const slug = asString(entry.slug) ?? "";
      const sourcePath = asString(entry.sourcePath);
      const fileInventoryRaw = entry.fileInventory;
      const fileInventory: Array<{ path: string }> = [];
      if (Array.isArray(fileInventoryRaw)) {
        for (const f of fileInventoryRaw) {
          if (typeof f === "string") fileInventory.push({ path: f });
          else if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
            fileInventory.push({ path: (f as { path: string }).path });
          }
        }
      }
      byKey.set(key, { key, slug, sourcePath, fileInventory });
    }
    CATALOG_CACHE.set(companyId, { fetchedAt: Date.now(), byKey });
    return byKey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    if (
      typeof val === "string" &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(skillsHome: string): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];
  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          entries.push(
            await buildSkillEntry(item.name, skillMd, `${cat.name}/${item.name}`),
          );
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true,
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true,
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, ".hermes", "skills");

  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason ?? null,
    });
  }

  for (const entry of hermesSkillEntries) {
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

/**
 * PATCH #4 — materialise Paperclip-managed skills as symlinks under
 * `<HERMES_HOME>/.hermes/skills/<runtimeName>` so Hermes' own scanner picks
 * them up at runtime. Then tear down any symlinks pointing at skills the
 * user unselected.
 *
 * Without this, the UI shows a checked checkbox but the runtime never sees
 * the skill — Hermes only scans its own ~/.hermes/skills/.
 *
 * Idempotent: re-running with the same desired set is a no-op. Required
 * skills are always installed regardless of the desiredSkills argument.
 */
export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const config = ctx.config;
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);

  // Paperclip persists desired skills as fully-qualified identifiers
  // (`<namespace>/<version>/<key>` — e.g. `local/75cfe85572/password-test`).
  // The filesystem uses the bare key (`password-test`). resolvePaperclip*
  // translates the persisted identifiers into the bare keys we can match
  // against `available.key`. We also fall back to the raw desiredSkills arg
  // in case a caller already passes resolved keys, and ALWAYS include
  // anything flagged as `required` by the runtime so policy-mandated skills
  // are guaranteed to materialise.
  const resolvedDesired = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set<string>([
    ...resolvedDesired,
    ...desiredSkills,
    ...availableEntries.filter((e) => e.required).map((e) => e.key),
  ]);

  const home = resolveHermesHome(config);
  const skillsHome = path.join(home, ".hermes", "skills");
  await fs.mkdir(skillsHome, { recursive: true });

  // v0.1.6 — fetch the authoritative skill catalog from Paperclip's HTTP API.
  // When present, each entry's `sourcePath` is the source-of-truth dir we
  // should symlink against. Falls back gracefully to the v0.1.5 heuristic
  // (`pickSymlinkTarget`) if the catalog is unavailable for any reason.
  const catalog = await fetchPaperclipSkillCatalog(ctx);

  // Use the BARE skill name (last segment of `key`, e.g. `password-test` from
  // `local/75cfe85572/password-test`) instead of the hashed `runtimeName`
  // (`password-test--df9642b338`). Hermes scans the filesystem and surfaces
  // `password-test` as the user-visible name — when the symlink keeps the
  // `--<hash>` suffix, Hermes treats it as a different (and unrecognised)
  // skill and the agent can't find it via `skills_list`.
  const hermesNameOf = (entry: { key: string; runtimeName: string }): string => {
    const lastSegment = entry.key.split("/").pop();
    return lastSegment && lastSegment.length > 0 ? lastSegment : entry.runtimeName;
  };

  const availableByHermesName = new Map(
    availableEntries.map((e) => [hermesNameOf(e), e]),
  );

  // 1) Install / refresh symlinks for every desired Paperclip-managed skill.
  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, hermesNameOf(available));

    // Priority order for the symlink target:
    //   1. `sourcePath` from Paperclip's HTTP catalog (authoritative)
    //   2. `pickSymlinkTarget` heuristic derived from the runtime path (v0.1.5)
    //   3. Raw `available.source` (last-resort, may be the runtime snapshot)
    const catalogEntry = catalog?.get(available.key);
    const catalogSourcePath =
      catalogEntry?.sourcePath && existsSync(catalogEntry.sourcePath)
        ? catalogEntry.sourcePath
        : null;
    const linkTarget = catalogSourcePath ?? pickSymlinkTarget(available.source);
    try {
      // If something already exists at `target`, replace it only when the
      // existing entry doesn't already point at the resolved target path.
      let needsRecreate = true;
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) {
          const current = await fs.readlink(target);
          if (path.resolve(skillsHome, current) === linkTarget) {
            needsRecreate = false;
          }
        }
      } catch {
        // target doesn't exist yet — we'll create it below.
      }
      if (needsRecreate) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        await fs.symlink(linkTarget, target);
      }
    } catch {
      // Materialisation failure is logged on the next list call as a warning
      // entry; we don't want to throw here and stop the whole sync.
    }
  }

  // v0.1.13 — REMOVED active cleanup of "stale" symlinks.
  //
  // ~/.hermes/skills/ is a SHARED directory across every agent in the same
  // container. v0.1.5..v0.1.12 tore down any symlink whose `key` was not in
  // THIS agent's desiredSet — but that's wrong: another agent in the same
  // company may want that skill. The result was an oscillating skills dir
  // (each wake re-created the agent's own symlinks, deleted everyone else's)
  // and silent I/O thrash on every heartbeat.
  //
  // The agent currently waking always sees its desired symlinks (we created
  // them above), so removing the cleanup never breaks the run path. Orphan
  // entries do accumulate when a skill is unselected from every agent or an
  // agent is deleted — that lifecycle belongs to a delete-time hook or a
  // separate `hermes skills prune` admin command, not the wake-time sync.
  return buildHermesSkillSnapshot(config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; required?: boolean }>,
): string[] {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}

// ---------------------------------------------------------------------------
// pickSymlinkTarget — v0.1.5
// ---------------------------------------------------------------------------
// Paperclip persists every Paperclip-managed skill in two places:
//
//   1. The SOURCE dir — `/paperclip/instances/.../skills/<companyId>/<bare>/`
//      which is what the operator edits via the Paperclip UI. Holds the
//      authored SKILL.md plus the full `references/`, `assets/`, etc.
//
//   2. The RUNTIME dir — `/paperclip/instances/.../skills/<companyId>/__runtime__/<bare>--<hash>/`
//      which is a frozen, hash-pinned deployment snapshot. Paperclip rebuilds
//      this on every save and STRIPS everything except `SKILL.md` (verified
//      empirically against `alex-hormozi` on 2026-06-11 — the runtime build
//      drops `references/00-canon.md` … `12-canonical-phrases.md`).
//
// `readPaperclipRuntimeSkillEntries` returns the runtime path because it's
// what the server uses internally. If we symlink Hermes against the runtime
// path, the agent can only `skill_view` the SKILL.md and not any reference.
// That breaks the entire point of multi-file skills like Hormozi/Feynman
// where the reference files ARE the operational knowledge.
//
// Solution: prefer the SOURCE dir whenever it exists on disk. Fall back to
// the runtime path for skills that have no source (e.g. the legacy
// `password-test` was created directly under `__runtime__/` without a
// matching source dir — that one still works because we degrade gracefully).
//
// This change does NOT touch Hermes-native skills (those live in
// `~/.hermes/skills/<native-name>/` as real directories, never symlinked by
// us) — coexistence between both worlds is preserved.
// ---------------------------------------------------------------------------

export function pickSymlinkTarget(runtimePath: string): string {
  const parentDir = path.dirname(runtimePath);
  if (path.basename(parentDir) !== "__runtime__") return runtimePath;
  const runtimeBase = path.basename(runtimePath);
  // Runtime entries are named `<bare>--<hash>`. If a different naming scheme
  // appears we fall back to the runtime path to avoid breaking the symlink.
  const dashDashIdx = runtimeBase.indexOf("--");
  if (dashDashIdx === -1) return runtimePath;
  const bareName = runtimeBase.slice(0, dashDashIdx);
  const sourceDir = path.join(path.dirname(parentDir), bareName);
  return existsSync(sourceDir) ? sourceDir : runtimePath;
}
