# dsh-sandbox-noop-escalation

[中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that removes `sandbox_permissions` / `justification` arguments when they cannot widen the call's current sandbox mode. Without it, a call like this fails before the command runs:

```
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

## Why it happens

DSH's escalating tools (`bash`, `pwsh`, `write`, `edit`, `run_code`) advertise a fixed enum `["workspace-write", "danger-full-access"]` for `sandbox_permissions`. Core accepts the field only when it names the current mode or a strictly wider one.

GPT models, trained on Codex's shell tool (which has fields with the same names), tend to fill every optional field on every call, including plain read-only commands. Because the enum has no "use the default" value, they usually pick `workspace-write`. In a `danger-full-access` session that is narrower than the current mode, so the call is rejected.

## What it does

Before each call to a watched tool runs (on the `tools/pre-execute` hook), the plugin compares the requested mode with the mode the session's sandbox policy resolves for that call:

| Call arguments | Action |
| --- | --- |
| requested mode equal to or narrower than the current mode | remove `sandbox_permissions` and `justification` |
| `justification` without `sandbox_permissions` | remove `justification` |
| requested mode wider than the current mode | leave unchanged; DSH asks for approval as usual |
| unknown requested mode, or current mode cannot be resolved | leave unchanged; DSH decides |

It only touches tools whose registered schema advertises DSH's own escalation fields, so third-party tools that reuse the names are ignored. The call is rewritten before it runs, so no failed attempt is spent, and the plugin does not match on error text.

It never widens permissions. It only removes a request that would not have changed the mode anyway.

## Install

From the DSH plugin market, or with the CLI:

```sh
dsh plugin --profile <name> add dsh-sandbox-noop-escalation
```

The package ships a `dsh.bundle.patch`, so it mounts itself; no profile edits are needed.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tools` | `string[]` | `["bash", "pwsh", "write", "edit", "run_code"]` | Tool names to watch. An empty list disables the plugin. |

Override it from your profile's `cordis.patch.yml`:

```yaml
- id: sandbox-noop-escalation
  config:
    tools: [bash, pwsh]
```

## Compatibility

Tested with DSH 0.2.0-rc.2 (cordis 4.0.4). It relies on the `tools/pre-execute` hook and the `tools` and `sandboxPolicy` services. If any of them is missing, the plugin does not load; if the policy cannot be resolved, calls pass through unchanged.

## Development

```sh
npm test
```

## License

MIT
