/**
 * dsh-sandbox-noop-escalation
 *
 * DSH's escalating tools (bash, pwsh, write, edit, run_code) advertise a
 * static `sandbox_permissions` enum of ["workspace-write", "danger-full-access"]
 * plus a paired `justification`. Core accepts the field only when it names the
 * call's current mode or a strictly wider one; anything narrower throws
 *
 *   sandbox escalation to "workspace-write" is not strictly wider than this
 *   call's current "danger-full-access" mode
 *
 * before the command runs. Some models (notably GPT/Codex, whose native shell
 * tool has same-named fields) fill these optional fields on every call. This
 * plugin removes them in `tools/pre-execute` when they cannot widen anything,
 * so the call runs under the session's standing policy. Requests that really
 * widen are never touched and still go through DSH's own approval.
 */

export const name = "sandbox-noop-escalation";
export const inject = ["tools", "sandboxPolicy"];

/** Sandbox modes from narrowest to widest. */
export const SANDBOX_MODES = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
/** Targets DSH core advertises in the escalation enum. */
export const ESCALATION_TARGETS = Object.freeze(["workspace-write", "danger-full-access"]);
/** DSH-native tools that implement the escalation contract. */
export const DEFAULT_TOOLS = Object.freeze(["bash", "pwsh", "write", "edit", "run_code"]);

const RANK = new Map(SANDBOX_MODES.map((mode, index) => [mode, index]));

/** @param {unknown} value */
export function isSandboxMode(value) {
  return typeof value === "string" && RANK.has(value);
}

/** The widest mode; nothing can be requested beyond it. */
const WIDEST_MODE = SANDBOX_MODES[SANDBOX_MODES.length - 1];

/**
 * Codex's shell tool uses the same field names with its own vocabulary
 * (`codex-rs/protocol/src/models.rs`, enum `SandboxPermissions`):
 * `use_default` | `require_escalated` | `with_additional_permissions`.
 * `use_default` means "no override", like an empty value.
 */
export const NO_REQUEST_VALUES = Object.freeze(["use_default"]);

/**
 * True when a `sandbox_permissions` value asks for nothing: null, an empty or
 * blank string, or Codex's `use_default`.
 * @param {unknown} value
 */
export function isNoRequest(value) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text === "" || NO_REQUEST_VALUES.includes(text);
}

/**
 * Decide what to do with one call's escalation fields.
 *
 * - `none`: the call carries neither field.
 * - `strip`: the fields cannot widen the current mode; remove `keys`.
 * - `keep`: leave the call untouched for DSH core to approve or reject.
 *
 * @param {Record<string, unknown>} args - the call arguments.
 * @param {unknown} currentMode - the call's standing sandbox mode.
 * @returns {{ kind: "none" } | { kind: "strip", keys: string[], reason: string } | { kind: "keep", reason: string }}
 */
export function classify(args, currentMode) {
  const hasMode = args.sandbox_permissions !== undefined;
  const hasReason = args.justification !== undefined;
  if (!hasMode && !hasReason) return { kind: "none" };
  const both = () => (hasReason ? ["sandbox_permissions", "justification"] : ["sandbox_permissions"]);
  const requested = args.sandbox_permissions;
  // Asking for nothing is a no-op whatever the current mode is.
  if (hasMode && isNoRequest(requested)) return { kind: "strip", keys: both(), reason: "no-request-value" };
  if (!isSandboxMode(currentMode)) return { kind: "keep", reason: "unknown-current-mode" };
  if (!hasMode) {
    // A lone justification requests nothing; core would only reject the pairing.
    return { kind: "strip", keys: ["justification"], reason: "lone-justification" };
  }
  if (!isSandboxMode(requested)) {
    // Nothing is wider than the widest mode, so any request there is a no-op
    // (e.g. Codex's `require_escalated` in a danger-full-access session).
    if (currentMode === WIDEST_MODE) return { kind: "strip", keys: both(), reason: "already-widest" };
    return { kind: "keep", reason: "unknown-requested-mode" };
  }
  if (RANK.get(requested) > RANK.get(currentMode)) return { kind: "keep", reason: "widening" };
  return { kind: "strip", keys: both(), reason: requested === currentMode ? "same-mode" : "narrower-mode" };
}

/** @param {unknown} value */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * True when the registered definition advertises DSH's native escalation
 * contract, so a third-party tool that merely reuses the field names is left alone.
 * @param {unknown} definition
 */
export function advertisesEscalation(definition) {
  const properties = record(record(record(definition)?.parameters)?.properties);
  const mode = record(properties?.sandbox_permissions);
  const reason = record(properties?.justification);
  return (
    mode?.type === "string" &&
    Array.isArray(mode.enum) &&
    mode.enum.length > 0 &&
    mode.enum.every(isSandboxMode) &&
    reason?.type === "string"
  );
}

/**
 * Normalize user config.
 * @param {{ tools?: unknown } | undefined} config
 * @returns {{ tools: string[] }}
 */
export function resolveConfig(config) {
  const raw = record(config)?.tools;
  if (raw === undefined) return { tools: [...DEFAULT_TOOLS] };
  if (!Array.isArray(raw)) throw new TypeError("sandbox-noop-escalation: config.tools must be an array of tool names");
  const tools = [...new Set(raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return { tools };
}

/**
 * @param {any} ctx - the cordis context.
 * @param {{ tools?: string[] }} [config]
 */
export function apply(ctx, config) {
  const { tools } = resolveConfig(config);
  if (tools.length === 0) {
    ctx.logger.info("sandbox-noop-escalation: inactive (config.tools is empty)");
    return;
  }
  const enabled = new Set(tools);
  let warnedResolve = false;

  ctx.on("tools/pre-execute", (exec, next) => {
    if (!enabled.has(exec.name)) return next();
    const args = record(exec.arguments);
    if (args === undefined) return next();
    if (args.sandbox_permissions === undefined && args.justification === undefined) return next();
    if (!advertisesEscalation(ctx.tools.get(exec.name, exec.agent))) return next();

    let currentMode;
    try {
      currentMode = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })?.mode;
    } catch (error) {
      if (!warnedResolve) {
        warnedResolve = true;
        ctx.logger.warn("sandbox-noop-escalation: could not resolve the sandbox policy; only empty/use_default requests will be removed", error);
      }
      currentMode = undefined;
    }

    const decision = classify(args, currentMode);
    if (decision.kind === "strip") {
      const drop = new Set(decision.keys);
      exec.arguments = Object.freeze(Object.fromEntries(Object.entries(args).filter(([key]) => !drop.has(key))));
      ctx.logger.debug(
        `sandbox-noop-escalation: removed ${decision.keys.join(", ")} from ${exec.name} call ${exec.callId ?? ""} (${decision.reason}; current mode ${currentMode})`
      );
    }
    return next();
  });

  ctx.logger.info(`sandbox-noop-escalation: active for ${tools.join(", ")}`);
}
