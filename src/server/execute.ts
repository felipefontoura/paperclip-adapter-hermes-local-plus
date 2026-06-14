/**
 * Server-side execution — fork of hermes-paperclip-adapter@0.3.0. Differences
 * from upstream:
 *  - Prepends the agent bundle (SOUL/AGENTS/HEARTBEAT/TOOLS) to the prompt.
 *  - Defaults the toolsets and the hermes binary path when left blank.
 *  - Filters Hermes' quiet-mode meta lines off stderr.
 *  - Enriches usage/cost (and recovers the final response) from
 *    `hermes sessions export` after the run.
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
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
} from "../shared/constants.js";

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

// Strip `--reasoning-effort <val>` from forwarded extraArgs — `hermes chat`
// has no such flag and passing it can break the wake. Handles `--flag val`
// and `--flag=val`.
function stripReasoningEffort(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reasoning-effort") {
      i++; // also skip the value token that follows
      continue;
    }
    if (a.startsWith("--reasoning-effort=")) continue;
    out.push(a);
  }
  return out;
}

// Binary to spawn: UI `hermesCommand`, else PAPERCLIP_HERMES_CLI (compose env —
// lets the operator/bento own the path without republishing the plugin), else
// the /opt/hermes/bin/hermes mount target. Exported so test.ts resolves the
// exact same binary as the wake.
export function resolveHermesCommand(config: Record<string, unknown>): string {
  return (
    cfgString(config.hermesCommand) ||
    process.env.PAPERCLIP_HERMES_CLI ||
    HERMES_CLI_DEFAULT
  );
}

// `hermes sessions export --session-id <id> -` prints one JSON row with the
// session metadata (tokens, cost) and messages. We read it back to surface
// real usage/cost on the Runs page and to recover the final response.
interface HermesSessionMessage {
  role?: string;
  content?: unknown;
}

interface HermesSessionMetadata {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;
  model?: string;
  billing_provider?: string;
  messages?: HermesSessionMessage[];
}

type SessionFetchResult = {
  usage?: UsageSummary;
  costUsd?: number;
  responseText?: string;
  model?: string;
  provider?: string;
};

// Hermes message `content` is either a plain string or an array of parts
// (`{ type: "text", text }`, `{ type: "tool_use", ... }`, …). Pull the text.
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

// Walk the exported session backwards and return the last assistant message
// that actually has text. Used to recover the agent's final answer when
// Hermes' quiet mode didn't echo it to stdout (only persisted it to state.db).
function lastAssistantText(messages: HermesSessionMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const text = extractMessageText(m.content).trim();
    if (text) return text;
  }
  return "";
}

async function fetchSessionUsage(
  hermesCmd: string,
  sessionId: string,
  env: Record<string, string>,
  cwd: string,
): Promise<SessionFetchResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: SessionFetchResult | null) => {
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
        const responseText = lastAssistantText(obj.messages) || undefined;
        const model =
          typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined;
        const provider =
          typeof obj.billing_provider === "string" && obj.billing_provider.trim()
            ? obj.billing_provider.trim()
            : undefined;
        settle({ usage: fullUsage, costUsd, responseText, model, provider });
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

// readBundleEntry: read the Paperclip-managed instruction bundle off disk and
// prepend it to the prompt so Hermes sees the agent's identity. Reads the four
// canonical files in semantic order, each prefixed with a `# <FILENAME>`
// heading; markdown headings inside each file are demoted one level so authors'
// `# X` lines don't break the outer hierarchy. Located via the server's
// `instructionsFilePath` hint, else composed from the bundle path layout.
// Guarded by fs.existsSync — a no-op when the agent has no instructions/.
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

// sessionResume: "auto" resumes when a prior session id is on file, "never"
// always starts fresh. Falls back to the legacy `persistSession` boolean.
function shouldResumeSession(
  config: Record<string, unknown>,
  hasPrevSession: boolean,
): boolean {
  const mode = (cfgString(config.sessionResume) || "").toLowerCase();
  if (mode === "never") return false;
  if (mode === "auto" || mode === "prompt") return hasPrevSession;
  return cfgBoolean(config.persistSession) !== false && hasPrevSession;
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const persona = readBundleEntry(ctx, config);
  // Upstream behaviour: the operator's `promptTemplate` wins if set, otherwise
  // the full Paperclip heartbeat workflow. (The opt-in LIGHT mode was removed —
  // it diverged from upstream and added a bug surface without a reliable win.)
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  // Paperclip delivers the wake context (task, comment, …) in `ctx.context`,
  // NOT `ctx.config` (which is the adapterConfig). Merge both — context wins —
  // so the {{#taskId}}/{{#commentId}} blocks actually fire on task/comment
  // wakes. (Reading only ctx.config silently drops the task and comment, so the
  // agent falls into the generic heartbeat and ignores what was asked.)
  const wake = {
    ...((ctx.config ?? {}) as Record<string, unknown>),
    ...((ctx.context ?? {}) as Record<string, unknown>),
  };
  const issue = (wake.paperclipIssue ?? {}) as Record<string, unknown>;

  const taskId = cfgString(wake.taskId) ?? cfgString(wake.issueId);
  const taskTitle = cfgString(wake.taskTitle) || cfgString(issue.title) || "";
  const taskBody = cfgString(wake.taskBody) || cfgString(issue.description) || "";
  const commentId = cfgString(wake.commentId) || "";
  const wakeReason = cfgString(wake.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(wake.companyName) || "";
  const projectName = cfgString(wake.projectName) || "";

  // Paperclip pre-builds a task-context string (issue + latest wake comment +
  // "use as the current assignment"). Inject it verbatim so the agent actually
  // sees the comment — the template alone only tells it to curl one.
  const taskMarkdown = cfgString(wake.paperclipTaskMarkdown);

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

  // Assemble: persona bundle → Paperclip task/comment context → workflow.
  return [persona, taskMarkdown, renderedPrompt]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n---\n\n");
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
  const hermesCmd = resolveHermesCommand(config);

  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);

  // Pass `-t` only when toolsets are explicitly set; otherwise Hermes uses
  // its own default set (terminal, skills, etc. are on by default).
  const toolsets =
    cfgString(config.toolsets) ||
    cfgStringArray(config.enabledToolsets)?.join(",");

  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Build prompt (bundle prepended) ────────────────────────────────────
  const prompt = buildPrompt(ctx, config);

  // ── Build command args ─────────────────────────────────────────────────
  const useQuiet = cfgBoolean(config.quiet) !== false;
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  // Accept `debug` or legacy `verbose`.
  if (cfgBoolean(config.debug) === true || cfgBoolean(config.verbose) === true) {
    args.push("-v");
  }

  args.push("--source", "tool");

  // `--yolo` bypasses approval prompts — the agent has no TTY, so without it
  // Hermes auto-denies every shell call after a prompt timeout.
  args.push("--yolo");

  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  if (prevSessionId && shouldResumeSession(config, true)) {
    args.push("--resume", prevSessionId);
  } else if (persistSession && prevSessionId && !cfgString(config.sessionResume)) {
    // Legacy agents only have persistSession: true.
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...stripReasoningEffort(extraArgs));
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if ((ctx as { authToken?: string }).authToken && !env.PAPERCLIP_API_KEY)
    env.PAPERCLIP_API_KEY = (ctx as { authToken: string }).authToken;
  // Wake context (taskId) lives in ctx.context; fall back to ctx.config.
  const taskId =
    cfgString((ctx.context as Record<string, unknown> | undefined)?.taskId) ||
    cfgString(ctx.config?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  // Paperclip resolves env bindings (plain + secret_ref) into plain string
  // values before the adapter runs, so config.env is a flat KEY=value map.
  const userEnv = config.env as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") {
    Object.assign(env, userEnv);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  // Hermes auto-injects any AGENTS.md/SOUL.md/memory it finds by walking up
  // from the spawn CWD. Defaulting to "." (the server's /app) would pull in
  // /app/AGENTS.md (the Paperclip contributor guide) on every wake. So we
  // spawn in a per-agent scratch workspace that has no inherited AGENTS.md —
  // the persona still arrives via the managed bundle. Resolution order:
  //   1. config.cwd                — explicit Configuration field
  //   2. ctx.config.workspaceDir   — Paperclip-assigned project workspace
  //   3. <PAPERCLIP_HOME>/instances/<inst>/workspaces/<agentId>/  (scratch)
  //   4. "."                       — last resort
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
  // Best-effort — if this fails (race, perms), Hermes still spawns in the
  // closest existing parent.
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // ignore
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog("stdout", `[hermes] Resuming session: ${prevSessionId}\n`);
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes its quiet-mode `session_id:` line plus benign INFO/DEBUG
  // status to stderr, which Paperclip would render as errors. Split each
  // stderr chunk line-by-line, drop the session_id meta, and reclassify the
  // rest to stdout when only benign lines remain.
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
  // When Hermes resumes a session it may not re-print the `session_id:` line,
  // so parseHermesOutput comes back empty even though the session exists. Fall
  // back to the session we asked Hermes to --resume, so the enrichment below
  // (usage/cost/model + response recovery) and session persistence still work.
  const sessionId = parsed.sessionId || prevSessionId;
  if (sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
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

  // Quiet mode omits token counts, so read the authoritative usage/cost from
  // the persisted session and overwrite parseHermesOutput's guess.
  if (sessionId) {
    try {
      const sessionMetrics = await fetchSessionUsage(hermesCmd, sessionId, env, cwd);
      if (sessionMetrics?.usage) {
        executionResult.usage = sessionMetrics.usage;
      }
      if (sessionMetrics?.costUsd != null) {
        executionResult.costUsd = sessionMetrics.costUsd;
      }
      // Plugin doesn't pick model/provider — surface what Hermes actually used
      // so the Run page badge isn't "unknown/unknown".
      if (sessionMetrics?.model) {
        executionResult.model = sessionMetrics.model;
      }
      if (sessionMetrics?.provider) {
        executionResult.provider = sessionMetrics.provider;
      }
      // Recover the final answer from the session when Hermes printed nothing
      // to stdout. Hermes' quiet mode (`-q … -Q`) does NOT reliably echo the
      // agent's last message — depending on the agent's execution path the
      // wake can "succeed" with a blank Run page because stdout only carried
      // the `[hermes] Starting/Exit` lines. The message is always in state.db,
      // which `hermes sessions export` already gave us above.
      if (!parsed.response?.trim() && sessionMetrics?.responseText?.trim()) {
        parsed.response = sessionMetrics.responseText;
        // Replay the recovered text to stdout so the Run transcript shows it —
        // it feeds the transcript stream just like a normal Hermes echo would.
        // (Without this the summary is captured but the transcript is blank.)
        await ctx.onLog("stdout", `${sessionMetrics.responseText}\n`);
      }
    } catch {
      // Best-effort enrichment — the wake still succeeds without token counts.
    }
  }

  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  if (persistSession && sessionId) {
    executionResult.sessionParams = { sessionId };
    executionResult.sessionDisplayId = sessionId.slice(0, 16);
  }

  return executionResult;
}
