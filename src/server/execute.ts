/**
 * Server-side execution — fork of hermes-paperclip-adapter@0.3.0 with:
 *
 *  - Patch #2: readBundleEntry() + buildPrompt prepends the agent bundle
 *    (SOUL.md + AGENTS.md + HEARTBEAT.md + TOOLS.md from v0.1.12;
 *    AGENTS.md only on v0.1.0-v0.1.11) before the rendered template, so
 *    Hermes sees the Paperclip-managed identity. Upstream ignored the
 *    bundle even when Paperclip injected `instructionsFilePath`.
 *
 *  - Patch #3: default toolsets become "terminal,skills" when the agent
 *    leaves the field blank, so Hermes auto-exposes `skills_list` /
 *    `skill_view` tools and the materialised Paperclip skill symlinks
 *    are reachable.
 *
 *  - v0.1.3 / Fix #1 — `resolveHermesCommand` defaults the Command field
 *    to `/usr/local/bin/hermes-paperclip` (the wrapper bento installs)
 *    when the user leaves it blank, with `hermes` on PATH as the
 *    last-resort fallback. Aluno leigo never has to type a path.
 *
 *  - v0.1.3 / Fix #2 — `wrappedOnLog` swallows the `session_id: …`
 *    quiet-mode meta line emitted on Hermes' stderr so it doesn't
 *    surface as a red "stderr" panel in the Paperclip Run UI. The
 *    session id is already captured via parseHermesOutput and shown
 *    cleanly in the structured summary.
 *
 *  - v0.1.3 / Fix #3 — `fetchSessionUsage` calls `hermes sessions
 *    export --session-id <id> -` after the run completes, parses the
 *    JSONL row, and populates `executionResult.usage` (input/output/
 *    cache/reasoning tokens) + `executionResult.costUsd`. The Runs
 *    page now shows the real token + cost figures instead of dashes.
 *
 * Everything else mirrors upstream so a future merge upstream of the
 * same features is a straight cherry-pick.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI_DEFAULT,
  HERMES_CLI_FALLBACK,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_TOOLSETS,
} from "../shared/constants.js";

import { detectModel, resolveProvider } from "./detect-model.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

// ---------------------------------------------------------------------------
// v0.1.3 / Fix #1 — Command field defaulting
// ---------------------------------------------------------------------------
// Priority order when picking which binary to spawn:
//   1. Explicit `adapterConfig.hermesCommand` from the UI (whatever the
//      user typed).
//   2. The bento wrapper at `/usr/local/bin/hermes-paperclip` if present.
//      That wrapper exports `HERMES_DOCKER_EXEC_AS_ROOT=1` and execs the
//      real binary from the cross-stack `/opt/hermes/bin/hermes` mount.
//   3. Plain `hermes` on PATH (legacy installs / dev).
// ---------------------------------------------------------------------------

function resolveHermesCommand(config: Record<string, unknown>): string {
  const explicit = cfgString(config.hermesCommand);
  if (explicit) return explicit;
  if (canExecute(HERMES_CLI_DEFAULT)) return HERMES_CLI_DEFAULT;
  return HERMES_CLI_FALLBACK;
}

function canExecute(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// v0.1.3 / Fix #3 — Session usage fetch
// ---------------------------------------------------------------------------
// After the wake completes, `hermes sessions export --session-id <id> -`
// prints a single JSONL row with the full metadata: input/output/cache/
// reasoning tokens, billing provider, and the provider-estimated cost.
// We parse that and surface it through `executionResult.usage` and
// `executionResult.costUsd` so the Paperclip Runs page renders real
// numbers instead of dashes.
// ---------------------------------------------------------------------------

interface HermesSessionMetadata {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;
  billing_provider?: string;
}

async function fetchSessionUsage(
  hermesCmd: string,
  sessionId: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ usage?: UsageSummary; costUsd?: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: { usage?: UsageSummary; costUsd?: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(
      hermesCmd,
      ["sessions", "export", "--session-id", sessionId, "-"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    // Silently discard stderr — non-zero exits also drop here.
    child.stderr?.on("data", () => {});

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle(null);
    }, 5_000);

    child.once("close", () => {
      clearTimeout(killTimer);
      const firstJsonLine = stdoutBuf
        .split("\n")
        .find((line) => line.trim().startsWith("{"));
      if (!firstJsonLine) {
        settle(null);
        return;
      }
      try {
        const obj = JSON.parse(firstJsonLine) as HermesSessionMetadata;
        const usage: UsageSummary = {
          inputTokens: typeof obj.input_tokens === "number" ? obj.input_tokens : 0,
          outputTokens: typeof obj.output_tokens === "number" ? obj.output_tokens : 0,
        };
        // Extra fields aren't in the strict UsageSummary type but are
        // accepted at runtime — the Paperclip UI displays them when present.
        const extras: Record<string, number> = {};
        if (typeof obj.cache_read_tokens === "number") {
          extras.cacheReadTokens = obj.cache_read_tokens;
        }
        if (typeof obj.cache_write_tokens === "number") {
          extras.cacheWriteTokens = obj.cache_write_tokens;
        }
        if (typeof obj.reasoning_tokens === "number") {
          extras.reasoningTokens = obj.reasoning_tokens;
        }
        const fullUsage = { ...usage, ...extras } as UsageSummary;

        const costUsd =
          typeof obj.estimated_cost_usd === "number" && obj.estimated_cost_usd > 0
            ? obj.estimated_cost_usd
            : typeof obj.actual_cost_usd === "number" && obj.actual_cost_usd > 0
              ? obj.actual_cost_usd
              : undefined;
        settle({ usage: fullUsage, costUsd });
      } catch {
        settle(null);
      }
    });

    child.once("error", () => {
      clearTimeout(killTimer);
      settle(null);
    });
  });
}

// ---------------------------------------------------------------------------
// PATCH #2 — readBundleEntry: pull AGENTS.md (or whichever entry the
// Paperclip server pinned via `adapterConfig.instructionsFilePath`) off
// disk so we can prepend it to the rendered prompt.
//
// Safe with no Paperclip-managed bundle: every read is guarded by
// `fs.existsSync`. When the agent has no instructions/, this is a silent
// no-op and the original prompt template is used unchanged.
// ---------------------------------------------------------------------------

// v0.1.12 — read ALL four canonical instruction files (SOUL, AGENTS,
// HEARTBEAT, TOOLS) and concatenate them in semantic order:
//
//   SOUL.md       — who the agent is (identity, values, voice)
//   AGENTS.md     — what the agent does (domain, delegation, peers)
//   HEARTBEAT.md  — how the agent runs each wake (workflow)
//   TOOLS.md      — what the agent can call (tool inventory + recipes)
//
// Each file is prefixed with a `# <FILENAME>` header so the LLM sees the
// hierarchy. Markdown headings INSIDE the file content are bumped one
// level (`# X` → `## X`, `## Y` → `### Y`, etc., up to h5→h6) so authors
// can write natural `# Something` lines without breaking the outer
// hierarchy. Files are separated by `---` for clear delimitation.
//
// The `instructionsFilePath` server hint (set when
// supportsInstructionsBundle: true) is still honoured as the canonical
// pointer to the SOUL.md entry — we use its directory to locate the
// sibling files. Falls back to the default Paperclip bundle path layout.
const BUNDLE_ORDER = ["SOUL.md", "AGENTS.md", "HEARTBEAT.md", "TOOLS.md"];

function bumpMarkdownHeadings(content: string): string {
  // Demote h1..h5 by one level. h6 stays (already deepest). Only matches
  // line-leading hashes followed by a space — fenced code blocks and inline
  // `#tag` references are untouched.
  return content.replace(/^(#{1,5}) /gm, "$1# ");
}

function readBundleEntry(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  try {
    // Locate the instructions/ directory:
    //   1. From the server-injected `instructionsFilePath` (canonical, set
    //      when supportsInstructionsBundle: true on our registry entry).
    //   2. Or compose from PAPERCLIP_HOME + instance + company + agent ID.
    let instructionsDir = "";
    const explicit = cfgString(config?.instructionsFilePath);
    if (explicit && path.isAbsolute(explicit) && fs.existsSync(explicit)) {
      instructionsDir = path.dirname(explicit);
    } else {
      const home = process.env.PAPERCLIP_HOME || "/paperclip";
      const instance = process.env.PAPERCLIP_INSTANCE_ID || "production";
      const cid = (ctx.agent as { companyId?: string } | undefined)?.companyId;
      const aid = ctx.agent?.id;
      if (!cid || !aid) return "";
      instructionsDir = path.join(
        home,
        "instances",
        instance,
        "companies",
        cid,
        "agents",
        aid,
        "instructions",
      );
    }

    if (!fs.existsSync(instructionsDir)) return "";

    const sections: string[] = [];
    for (const fileName of BUNDLE_ORDER) {
      const full = path.join(instructionsDir, fileName);
      if (!fs.existsSync(full)) continue;
      const raw = fs.readFileSync(full, "utf8").trim();
      if (!raw) continue;
      sections.push(`# ${fileName}\n\n${bumpMarkdownHeadings(raw)}`);
    }

    return sections.join("\n\n---\n\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder — unchanged from upstream apart from prepending
// the bundle entry returned by readBundleEntry().
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\\"identifier\\"]} {i[\\"status\\"]:>12} {i[\\"priority\\"]:>6} {i[\\"title\\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\\"identifier\\"]} {i[\\"title\\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

// ---------------------------------------------------------------------------
// v0.1.7 — LIGHT_PROMPT_TEMPLATE
// ---------------------------------------------------------------------------
// Activated when the agent has a non-trivial AGENTS.md (the persona/bundle
// took the wheel) and the user didn't override `adapterConfig.promptTemplate`.
//
// The default template above is opinionated: it always tells the agent to
// list issues, check the backlog and process them. That's the right behaviour
// for a generic heartbeat agent, but it actively HIJACKS agents whose
// AGENTS.md is a focused instruction (read X, return Y, etc.) — the LLM ends
// up obeying the heartbeat template instead of the operator's brief.
//
// The light template just sets identity + task pointer + a "no task" stub so
// any persona-supplied instruction reads as the single source of truth.
// ---------------------------------------------------------------------------
const LIGHT_PROMPT_TEMPLATE = `Run context: {{runId}}
Agent: {{agentName}} ({{agentId}}) — Company {{companyId}}
Paperclip API: {{paperclipApiUrl}}

{{#taskId}}
Assigned task: {{taskId}} — {{taskTitle}}
{{taskBody}}
{{/taskId}}

{{#noTask}}
No specific task assigned this wake. Follow the instructions above (AGENTS.md).
{{/noTask}}`;

const LIGHT_TEMPLATE_PERSONA_THRESHOLD = 200;

// v0.1.8/v0.1.9 — `${VAR_NAME}` substitution.
//
// Paperclip's Configuration tab "Environment Variables" row writes to
// `adapterConfig.env[KEY] = { type: "plain" | "secret", value }`. The
// plugin's Custom Provider form accepts `${SECRET}` references so 50
// agents can share one entry — edit once, every agent picks up.
//
// Priority order:
//   1. Agent-level env binding (adapterConfig.env) — set by aluno via UI
//   2. process.env — set by Paperclip server compose or shell
//   3. Unmatched → leave literal `${NAME}` so the failure is visible
//      (rather than silently sending an empty Authorization header)
//
// v0.1.9 fix — previously only read process.env. The agent-level
// envBindings live in config.env (typed Record<string, EnvBinding>),
// NOT in the plugin process's environment. Paperclip injects those into
// the Hermes SUBPROCESS env, but my plugin needs the value EARLIER, to
// rewrite the Custom Provider API key field that feeds OPENAI_API_KEY.
function resolveSecretRefs(
  value: string,
  config: Record<string, unknown>,
): string {
  const envBindings = config.env;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name) => {
    if (envBindings && typeof envBindings === "object") {
      const binding = (envBindings as Record<string, unknown>)[name];
      if (binding && typeof binding === "object") {
        const v = (binding as { value?: unknown }).value;
        if (typeof v === "string" && v.length > 0) return v;
      }
      if (typeof binding === "string" && binding.length > 0) return binding;
    }
    const fromProcess = process.env[name];
    if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
    return match;
  });
}

// v0.1.8 — Aluno picks how the prompt template is chosen:
//   "auto"   (default, v0.1.12+) — `promptTemplate` field if set, else FULL.
//                        v0.1.7-v0.1.11 auto-switched to LIGHT when the persona
//                        was substantial; that quietly capped autonomous-issue
//                        workflows (curl/list/comment/done) so v0.1.12 reverted.
//   "light"           — force LIGHT_PROMPT_TEMPLATE regardless of bundle.
//                        OPT-IN token saver: drops the workflow boilerplate
//                        (~13k tokens/wake). Use when AGENTS.md fully describes
//                        what the agent should do AND you don't need the agent
//                        to autonomously list/comment/close issues via the
//                        Paperclip API. Picking "light" trades autonomy for tokens.
//   "full"            — force DEFAULT_PROMPT_TEMPLATE regardless of bundle.
//                        Identical to "auto" today; kept as explicit opt-in
//                        in case the auto behaviour changes in the future.
//   "custom"          — use `config.promptTemplate` verbatim. Identical to
//                        leaving heartbeatMode at "auto" with a non-empty
//                        promptTemplate; kept as an explicit opt-in for clarity.
function pickPromptTemplate(
  config: Record<string, unknown>,
  _persona: string,
): string {
  const userTemplate = cfgString(config.promptTemplate);
  const mode = (cfgString(config.heartbeatTemplateMode) || "auto").toLowerCase();

  // Explicit forced modes:
  if (mode === "custom" && userTemplate) return userTemplate;
  if (mode === "light") return LIGHT_PROMPT_TEMPLATE;
  if (mode === "full") return DEFAULT_PROMPT_TEMPLATE;

  // `auto` (or unrecognised): user-supplied template wins; otherwise FULL.
  if (userTemplate) return userTemplate;
  return DEFAULT_PROMPT_TEMPLATE;
}

// v0.1.8 — sessionResume tri-state replacing the legacy `persistSession`
// boolean. "auto" preserves v0.1.7 behaviour (resume when last sessionId
// is on file). "never" disables resume entirely. "prompt" is reserved for
// a future "ask Felipe each wake" hook — for now it behaves like "auto".
function shouldResumeSession(
  config: Record<string, unknown>,
  hasPrevSession: boolean,
): boolean {
  const mode = (cfgString(config.sessionResume) || "").toLowerCase();
  if (mode === "never") return false;
  if (mode === "auto" || mode === "prompt") return hasPrevSession;
  // Legacy boolean preserved for back-compat with agents created < v0.1.8.
  return cfgBoolean(config.persistSession) !== false && hasPrevSession;
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const persona = readBundleEntry(ctx, config);
  const template = pickPromptTemplate(config, persona);

  const taskId = cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(ctx.config?.projectName) || "";

  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: (ctx.agent as { companyId?: string } | undefined)?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
  };

  let rendered = template;

  // {{#taskId}}...{{/taskId}}
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}}
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );

  // {{#commentId}}...{{/commentId}}
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  const renderedPrompt = renderTemplate(rendered, vars);

  // PATCH #2 — prepend bundle entry (SOUL/AGENTS/HEARTBEAT/TOOLS, whichever
  // Paperclip pinned). When no bundle exists, behaviour matches upstream.
  // The bundle was already read at the top of this function to choose between
  // the heartbeat-default and light templates — reuse it.
  return persona ? `${persona}\n\n---\n\n${renderedPrompt}` : renderedPrompt;
}

// ---------------------------------------------------------------------------
// Output parsing (unchanged from upstream)
// ---------------------------------------------------------------------------

const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch[1];
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch[1];
    }
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line));
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  // v0.1.3 / Fix #1: respect explicit hermesCommand, otherwise auto-pick
  // the wrapper at `/usr/local/bin/hermes-paperclip` (bento default) and
  // fall back to plain `hermes` on PATH if the wrapper isn't installed.
  const hermesCmd = resolveHermesCommand(config);

  // v0.1.4 — "Default" means: don't pass `-m` / `--provider` to the CLI at
  // all. Let Hermes resolve the model + provider out of its own
  // `~/.hermes/config.yaml`, which the bento install configures once
  // (typically zai/glm-5.1 in this deployment). Falling back to
  // `anthropic/claude-sonnet-4` like upstream does breaks zero-touch agents
  // because the Hermes container has no Anthropic API key.
  const model = cfgString(config.model);
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);

  // PATCH #3 — default toolsets `terminal,skills` so Paperclip-managed
  // skill symlinks become `skill_view` tools at runtime without aluno
  // having to configure anything in the UI.
  const toolsets =
    cfgString(config.toolsets) ||
    cfgStringArray(config.enabledToolsets)?.join(",") ||
    DEFAULT_TOOLSETS;

  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── v0.1.8 NOTE on `thinkingEffort` (CreateConfigValues universal field) ─
  // The Paperclip New Agent form exposes a "Thinking effort" field for ALL
  // adapters (it's part of the universal CreateConfigValues type, not our
  // schema). For the Hermes adapter it is COSMETIC: Hermes has no CLI flag
  // and no env var for reasoning effort — the value lives only in
  // `~/.hermes/config.yaml` under `agent.reasoning_effort` and is global
  // to the Hermes daemon. The plugin DOES NOT and WILL NOT modify
  // config.yaml (dual-owner risk; Felipe ruled it out explicitly). Aluno
  // avançado who wants to change reasoning effort edits config.yaml
  // directly and the next wake picks it up. Aluno leigo: the field has no
  // effect; ignore it.

  // ── v0.1.8 — Custom provider (OpenAI-compatible) ───────────────────────
  // When the user picks `provider: "custom"` in the UI, the plugin treats it
  // as a generic OpenAI-compatible endpoint. We pass `--provider openai-api`
  // to Hermes and inject the user-supplied URL/key/headers via env vars so
  // the openai-api provider routes to their custom endpoint.
  //
  // Why this design: 99% of "exotic" providers today (Together, Groq,
  // Fireworks, Ollama, vLLM, OpenRouter, etc.) speak the OpenAI Chat
  // Completions API. Aluno picks "Custom", fills 3 fields, plugin handles
  // the routing — zero config.yaml edits required.
  //
  // Secret refs (`${VAR_NAME}`) in the API Key field are resolved against
  // process.env at run time. Paperclip's Environment Variables row injects
  // company-level secrets into the run env — so the API key never lives in
  // adapterConfig in plaintext. Aluno creates one company secret, all
  // agents reference it by `${NAME}`.
  const explicitProviderConfig = cfgString(config.provider);
  const customProviderEnv: Record<string, string> = {};
  let customProviderModel: string | null = null;
  let customProviderActive = false;
  if (explicitProviderConfig === "custom") {
    const baseUrl = resolveSecretRefs(
      cfgString(config.customProviderBaseUrl) || "",
      config,
    );
    const apiKey = resolveSecretRefs(
      cfgString(config.customProviderApiKey) || "",
      config,
    );
    customProviderModel = cfgString(config.customProviderModelOverride) || null;
    // v0.1.10 — Hermes uses `OPENAI_BASE_URL` (not `OPENAI_API_BASE`) AND
    // strips provider-related envs from the subprocess via a hard blocklist
    // (see /opt/hermes/agent/.../local_env_blocklist tests). The escape hatch
    // is the `_HERMES_FORCE_<NAME>` prefix: Hermes recognises it, drops the
    // prefix, and injects `<NAME>` into the spawn env. We use both: normal
    // names so older Hermes builds keep working, and the force-prefixed
    // variants for current Hermes that gates them.
    if (baseUrl) {
      customProviderEnv.OPENAI_BASE_URL = baseUrl;
      customProviderEnv._HERMES_FORCE_OPENAI_BASE_URL = baseUrl;
    }
    if (apiKey) {
      customProviderEnv.OPENAI_API_KEY = apiKey;
      customProviderEnv._HERMES_FORCE_OPENAI_API_KEY = apiKey;
    }
    // Extra headers JSON — merge each key as HEADER_<NAME> env var that
    // Hermes openai-api provider picks up. Best-effort parse; broken JSON
    // is ignored silently.
    const headersJson = cfgString(config.customProviderHeaders);
    if (headersJson) {
      try {
        const parsed = JSON.parse(headersJson);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") {
              customProviderEnv[
                `OPENAI_EXTRA_HEADER_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
              ] = resolveSecretRefs(v, config);
            }
          }
        }
      } catch (err) {
        // Malformed JSON in the Custom Provider Extra Headers field is a
        // common aluno mistake (missing comma, trailing comma, single quotes).
        // We can't fail the wake — `headersJson` is optional — but a silent
        // skip leaves the aluno wondering why their custom header isn't being
        // sent. Surface the parse error so it shows up on the Run page.
        const message = err instanceof Error ? err.message : String(err);
        await ctx.onLog(
          "stdout",
          `[paperclip] WARN Custom Provider Extra headers JSON did not parse: ${message}. ` +
            `Extra headers will NOT be sent on this wake.\n`,
        );
      }
    }
    customProviderActive = true;
  }

  // ── Resolve provider ───────────────────────────────────────────────────
  // Only run the provider-resolution chain when we actually have a model
  // override — otherwise we'd guess a provider for a model name the user
  // never typed.
  let resolvedProvider = "auto";
  let resolvedFrom: string = "hermesDefault";
  if (model) {
    let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
    const explicitProvider = cfgString(config.provider);
    if (!explicitProvider) {
      try {
        detectedConfig = await detectModel();
      } catch (err) {
        // detectModel() reads ~/.hermes/config.yaml + auth.json to guess
        // which provider the model name belongs to. Failing here just
        // means we fall through to `auto` and let Hermes resolve. We log
        // because if the user expects model-based provider inference to
        // work, a silent fallback is a confusing debugging hole.
        const message = err instanceof Error ? err.message : String(err);
        await ctx.onLog(
          "stdout",
          `[paperclip] WARN provider auto-detection failed: ${message}. ` +
            `Falling back to provider=auto. Pick a Provider explicitly in ` +
            `the UI to override.\n`,
        );
      }
    }
    const resolved = resolveProvider({
      explicitProvider,
      detectedProvider: detectedConfig?.provider,
      detectedModel: detectedConfig?.model,
      model,
    });
    resolvedProvider = resolved.provider;
    resolvedFrom = resolved.resolvedFrom;
  }

  // ── Build prompt (with bundle entry prepended via PATCH #2) ────────────
  const prompt = buildPrompt(ctx, config);

  // ── Build command args ─────────────────────────────────────────────────
  const useQuiet = cfgBoolean(config.quiet) !== false;
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  // v0.1.4 — only pass `-m` and `--provider` when the user picked a model
  // in the UI. Empty Model field == use whatever Hermes' own config.yaml
  // resolves to.
  // v0.1.8 — `provider: "custom"` short-circuits this: pass
  // `--provider openai-api` and the Custom Model Override as `-m`. The
  // OPENAI_API_BASE / OPENAI_API_KEY envs (set above) redirect Hermes's
  // built-in openai-api adapter at the aluno's endpoint.
  if (customProviderActive) {
    args.push("--provider", "openai-api");
    if (customProviderModel) args.push("-m", customProviderModel);
  } else if (model) {
    args.push("-m", model);
    if (resolvedProvider !== "auto") {
      args.push("--provider", resolvedProvider);
    }
  } else if (explicitProviderConfig && explicitProviderConfig !== "auto") {
    // Explicit non-custom provider, no model override → trust the provider
    // entry in Hermes config.yaml to carry its own model default.
    args.push("--provider", explicitProviderConfig);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  // v0.1.8 — accept either `debug` (new UI toggle) or `verbose` (legacy) for back-compat.
  if (cfgBoolean(config.debug) === true || cfgBoolean(config.verbose) === true) {
    args.push("-v");
  }

  args.push("--source", "tool");
  args.push("--yolo");

  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  // v0.1.8 — sessionResume enum supersedes persistSession boolean.
  if (prevSessionId && shouldResumeSession(config, true)) {
    args.push("--resume", prevSessionId);
  } else if (persistSession && prevSessionId && !cfgString(config.sessionResume)) {
    // Legacy back-compat: old agents (created < v0.1.8) only have
    // `persistSession: true` — keep behaviour identical.
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
    // v0.1.8 — Custom provider env injection. Must come AFTER the spread of
    // process.env so we override any pre-existing OPENAI_* values that the
    // host shell may have set for other purposes.
    ...customProviderEnv,
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if ((ctx as { authToken?: string }).authToken && !env.PAPERCLIP_API_KEY)
    env.PAPERCLIP_API_KEY = (ctx as { authToken: string }).authToken;
  const taskId = cfgString(ctx.config?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  // Paperclip persists adapterConfig.env as a map of "env bindings" — each
  // value is wrapped in {type: "plain", value: "..."} for the strict-secret
  // gate. Extract .value here for plain bindings; resolved secret_ref
  // bindings arrive as plain strings already.
  const userEnv = config.env;
  if (userEnv && typeof userEnv === "object" && !Array.isArray(userEnv)) {
    for (const [key, raw] of Object.entries(userEnv as Record<string, unknown>)) {
      if (typeof raw === "string") {
        env[key] = raw;
      } else if (
        raw &&
        typeof raw === "object" &&
        (raw as { type?: unknown }).type === "plain" &&
        typeof (raw as { value?: unknown }).value === "string"
      ) {
        env[key] = (raw as { value: string }).value;
      }
    }
  }

  // ── Resolve working directory (v0.1.11 — Cut 4 from token audit) ──────
  // Why this is non-trivial:
  // Hermes auto-injects any `AGENTS.md` (and SOUL.md, .cursorrules, memory)
  // it finds by walking up from the spawn CWD. Earlier builds let `cwd`
  // default to `"."` (the Paperclip server's CWD = `/app`). `/app/AGENTS.md`
  // is the Paperclip codebase contributor guide (Express, Drizzle, React)
  // — irrelevant to every aluno agent, costing ~875 tokens per cold wake.
  // See docs/token-baseline-analysis.md §9 for the measured numbers.
  //
  // Resolution order (first non-empty wins):
  //   1. `config.cwd`               — explicit Configuration field
  //   2. `ctx.config.workspaceDir`  — Paperclip-assigned project workspace
  //   3. agent scratch workspace    — `<PAPERCLIP_HOME>/instances/<inst>/workspaces/<agentId>/`
  //      Already created by Paperclip for the fallback workspace logged at
  //      wake start (`[paperclip] Using fallback workspace …`). Free of any
  //      inherited `AGENTS.md`, so Hermes's discovery walk finds nothing
  //      to inject. The plugin still ships its own AGENTS.md via the
  //      managed bundle path (`instructionsFilePath`), so the persona is
  //      not lost — only the bogus injection.
  //   4. `"."` last-resort (pre-v0.1.11 behaviour)
  const explicitCwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir);
  let cwd: string;
  if (explicitCwd) {
    cwd = explicitCwd;
  } else {
    const paperclipHome = process.env.PAPERCLIP_HOME || "/paperclip";
    const instance = process.env.PAPERCLIP_INSTANCE_ID || "production";
    const agentId = ctx.agent?.id;
    if (agentId) {
      cwd = path.join(
        paperclipHome,
        "instances",
        instance,
        "workspaces",
        agentId,
      );
    } else {
      cwd = ".";
    }
  }
  // ensureAbsoluteDirectory may fail on race, perms, or non-absolute paths.
  // We don't want to abort the wake (Hermes will still spawn against the
  // closest existing parent and run), but we DO want the failure visible —
  // a silent catch here hides "your token saving never landed because the
  // scratch dir wasn't writable". Surface it on the Run page log.
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog(
      "stdout",
      `[paperclip] WARN could not ensure cwd ${cwd}: ${message}. ` +
        `Hermes will spawn in the closest existing parent; the AGENTS.md ` +
        `auto-injection saving may not apply this wake.\n`,
    );
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model ?? "hermes default"}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog("stdout", `[hermes] Resuming session: ${prevSessionId}\n`);
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // v0.1.3 / Fix #2 (revised in v0.1.4): Hermes emits its quiet-mode
  // `session_id: <id>` line on stderr, plus a handful of INFO/DEBUG status
  // messages that aren't real errors. v0.1.3 tried matching `^session_id:`
  // against the whole chunk after `trimEnd()`, which missed cases where the
  // session line arrived prefixed by a leading newline or batched with
  // other output. v0.1.4 splits the chunk line-by-line and drops every
  // matching line individually, then forwards whatever's left (reclassified
  // to stdout when only benign lines remain).
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream !== "stderr") {
      return ctx.onLog(stream, chunk);
    }

    const lines = chunk.split("\n");
    const survivors: string[] = [];
    let onlyBenign = true;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        // Preserve blank lines so multi-line stderr output stays formatted.
        survivors.push(rawLine);
        continue;
      }
      // Silently drop the Hermes session_id meta line entirely.
      if (/^session_id:\s/.test(line)) continue;
      survivors.push(rawLine);
      const isBenign =
        /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(line) ||
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(line) ||
        /Successfully registered all tools/.test(line) ||
        /MCP [Ss]erver/.test(line) ||
        /tool registered successfully/.test(line) ||
        /Application initialized/.test(line);
      if (!isBenign) onlyBenign = false;
    }

    const reduced = survivors.join("\n");
    // Entire chunk was session_id meta — drop without surfacing in the UI.
    if (!reduced.trim()) return;
    if (onlyBenign) {
      return ctx.onLog("stdout", reduced);
    }
    return ctx.onLog(stream, reduced);
  };

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: wrappedOnLog,
  });

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // v0.1.3 / Fix #3: enrich usage + cost from the persisted Hermes session
  // metadata. The CLI's quiet-mode output deliberately doesn't include
  // tokens, but `hermes sessions export` reads them out of state.db.
  // Authoritative numbers come from there — overwrite parseHermesOutput's
  // optimistic guess when we have them.
  if (parsed.sessionId) {
    try {
      const sessionMetrics = await fetchSessionUsage(hermesCmd, parsed.sessionId, env, cwd);
      if (sessionMetrics?.usage) {
        executionResult.usage = sessionMetrics.usage;
      }
      if (sessionMetrics?.costUsd != null) {
        executionResult.costUsd = sessionMetrics.costUsd;
      }
    } catch (err) {
      // `hermes sessions export` is best-effort enrichment. If it fails
      // the wake still succeeds — we just don't show authoritative token
      // counts on the Run page. Log the reason so the operator can tell
      // the difference between "this wake didn't use tokens" and "the
      // plugin couldn't read them back from state.db".
      const message = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[paperclip] WARN could not enrich session usage metrics for ` +
          `${parsed.sessionId}: ${message}. Token counts on the Run page ` +
          `may be incomplete; the wake itself succeeded.\n`,
      );
    }
  }

  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
