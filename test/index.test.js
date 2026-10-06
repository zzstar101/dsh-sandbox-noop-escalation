import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as plugin from "../lib/index.js";

const { classify, advertisesEscalation, resolveConfig, apply, DEFAULT_TOOLS } = plugin;

const ESCALATING_DEFINITION = {
  name: "bash",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
      justification: { type: "string" }
    }
  }
};

describe("classify", () => {
  it("ignores calls without escalation fields", () => {
    assert.deepEqual(classify({ command: "ls" }, "danger-full-access"), { kind: "none" });
  });

  it("strips a narrower request with its justification", () => {
    assert.deepEqual(
      classify({ sandbox_permissions: "workspace-write", justification: "x" }, "danger-full-access"),
      { kind: "strip", keys: ["sandbox_permissions", "justification"], reason: "narrower-mode" }
    );
  });

  it("strips a same-mode request", () => {
    assert.deepEqual(classify({ sandbox_permissions: "workspace-write", justification: "x" }, "workspace-write"), {
      kind: "strip",
      keys: ["sandbox_permissions", "justification"],
      reason: "same-mode"
    });
  });

  it("strips a request without justification", () => {
    assert.deepEqual(classify({ sandbox_permissions: "workspace-write" }, "danger-full-access"), {
      kind: "strip",
      keys: ["sandbox_permissions"],
      reason: "narrower-mode"
    });
  });

  it("strips a lone justification", () => {
    assert.deepEqual(classify({ justification: "x" }, "read-only"), {
      kind: "strip",
      keys: ["justification"],
      reason: "lone-justification"
    });
  });

  it("keeps real widening requests", () => {
    assert.deepEqual(classify({ sandbox_permissions: "danger-full-access", justification: "x" }, "workspace-write"), {
      kind: "keep",
      reason: "widening"
    });
    assert.equal(classify({ sandbox_permissions: "workspace-write", justification: "x" }, "read-only").kind, "keep");
  });

  it("keeps unknown requested or current modes for core to judge", () => {
    assert.equal(classify({ sandbox_permissions: "full", justification: "x" }, "read-only").reason, "unknown-requested-mode");
    assert.equal(classify({ sandbox_permissions: "workspace-write", justification: "x" }, undefined).reason, "unknown-current-mode");
    assert.equal(classify({ justification: "x" }, "custom").reason, "unknown-current-mode");
  });
});

describe("advertisesEscalation", () => {
  it("accepts the native contract", () => {
    assert.equal(advertisesEscalation(ESCALATING_DEFINITION), true);
  });

  it("rejects tools without the contract", () => {
    assert.equal(advertisesEscalation(undefined), false);
    assert.equal(advertisesEscalation({ parameters: { properties: { command: { type: "string" } } } }), false);
    assert.equal(
      advertisesEscalation({
        parameters: { properties: { sandbox_permissions: { type: "string", enum: ["low", "high"] }, justification: { type: "string" } } }
      }),
      false
    );
  });
});

describe("resolveConfig", () => {
  it("defaults to the native escalating tools", () => {
    assert.deepEqual(resolveConfig(undefined).tools, [...DEFAULT_TOOLS]);
    assert.deepEqual(resolveConfig({}).tools, [...DEFAULT_TOOLS]);
  });

  it("trims, dedupes and drops non-strings", () => {
    assert.deepEqual(resolveConfig({ tools: [" bash ", "bash", 1, "", "pwsh"] }).tools, ["bash", "pwsh"]);
  });

  it("rejects a non-array", () => {
    assert.throws(() => resolveConfig({ tools: "bash" }), TypeError);
  });
});

function fakeContext({ mode = "danger-full-access", definitions = { bash: ESCALATING_DEFINITION }, resolve } = {}) {
  const listeners = [];
  const logs = [];
  const log = (level) => (...args) => logs.push([level, ...args]);
  const ctx = {
    logger: { info: log("info"), warn: log("warn"), debug: log("debug") },
    tools: { get: (name) => definitions[name] },
    sandboxPolicy: { resolve: resolve ?? (() => ({ mode })) },
    on(event, listener) {
      assert.equal(event, "tools/pre-execute");
      listeners.push(listener);
    }
  };
  async function run(exec) {
    let reached = false;
    await listeners[0](exec, async () => {
      reached = true;
    });
    assert.equal(reached, true, "listener must call next()");
    return exec;
  }
  return { ctx, listeners, logs, run };
}

describe("apply", () => {
  it("removes redundant fields before the tool sees them", async () => {
    const { ctx, run } = fakeContext();
    apply(ctx, undefined);
    const original = Object.freeze({ command: "pwd", sandbox_permissions: "workspace-write", justification: "x" });
    const exec = await run({ name: "bash", callId: "c1", arguments: original, agent: { session: {} } });
    assert.deepEqual(exec.arguments, { command: "pwd" });
    assert.equal(Object.isFrozen(exec.arguments), true);
  });

  it("passes the session to the policy resolver", async () => {
    const session = { id: "s" };
    let seen;
    const { ctx, run } = fakeContext({ resolve: (request) => ((seen = request), { mode: "workspace-write" }) });
    apply(ctx, undefined);
    await run({ name: "bash", arguments: { command: "x", sandbox_permissions: "workspace-write", justification: "y" }, agent: { session } });
    assert.equal(seen.session, session);
  });

  it("leaves widening requests untouched", async () => {
    const { ctx, run } = fakeContext({ mode: "workspace-write" });
    apply(ctx, undefined);
    const args = { command: "x", sandbox_permissions: "danger-full-access", justification: "y" };
    const exec = await run({ name: "bash", arguments: args, agent: { session: {} } });
    assert.equal(exec.arguments, args);
  });

  it("ignores tools that are not configured or do not advertise the contract", async () => {
    const { ctx, run } = fakeContext({ definitions: { bash: ESCALATING_DEFINITION, other: { parameters: {} } } });
    apply(ctx, { tools: ["other"] });
    const args = { sandbox_permissions: "workspace-write", justification: "y" };
    assert.equal((await run({ name: "bash", arguments: args })).arguments, args);
    assert.equal((await run({ name: "other", arguments: args })).arguments, args);
  });

  it("fails open when the policy cannot be resolved", async () => {
    const { ctx, run, logs } = fakeContext({
      resolve: () => {
        throw new Error("boom");
      }
    });
    apply(ctx, undefined);
    const args = { sandbox_permissions: "workspace-write", justification: "y" };
    assert.equal((await run({ name: "bash", arguments: args, agent: { session: {} } })).arguments, args);
    await run({ name: "bash", arguments: args, agent: { session: {} } });
    assert.equal(logs.filter(([level]) => level === "warn").length, 1);
  });

  it("registers nothing for an empty tool list", () => {
    const { ctx, listeners } = fakeContext();
    apply(ctx, { tools: [] });
    assert.equal(listeners.length, 0);
  });

  it("declares its services", () => {
    assert.equal(plugin.name, "sandbox-noop-escalation");
    assert.deepEqual(plugin.inject, ["tools", "sandboxPolicy"]);
  });
});
