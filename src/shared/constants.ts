/**
 * Shared constants — fork of hermes-paperclip-adapter@0.3.0 (Nous Research).
 * Same identifiers used so Paperclip resolves us as the override for the
 * built-in hermes_local registration.
 */

/** Adapter type identifier — matches the built-in hermes_local to enable override. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/**
 * Default hermes binary when the "Command" field is blank — the bento
 * cross-stack mount target. Absolute path, independent of PATH.
 */
export const HERMES_CLI_DEFAULT = "/opt/hermes/bin/hermes";

/** Backwards-compat alias kept for the test entrypoint. */
export const HERMES_CLI = HERMES_CLI_DEFAULT;

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Prefix used by Hermes for tool output lines (consumed by parse-stdout). */
export const TOOL_OUTPUT_PREFIX = "┊";
