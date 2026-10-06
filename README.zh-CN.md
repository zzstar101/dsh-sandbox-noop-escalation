# dsh-sandbox-noop-escalation

[English](./README.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：当 `sandbox_permissions` / `justification` 参数不会让当前沙箱模式变宽时，把它们从调用里去掉。不装这个插件时，下面这种调用会在命令执行前直接失败：

```
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

## 为什么会出现

DSH 中能升权的工具（`bash`、`pwsh`、`write`、`edit`、`run_code`）给 `sandbox_permissions` 声明的是固定的可选值 `["workspace-write", "danger-full-access"]`。DSH 只接受等于当前模式或比当前模式更宽的值。

GPT 系列模型习惯了 Codex 的 shell 工具（它有同名参数），往往每次调用都会把可选参数填满，连只读命令也不例外。可选值里没有“使用默认”这一项，它们通常会选 `workspace-write`。在 `danger-full-access` 会话里，这个值比当前模式窄，调用就被拒绝了。

## 插件做了什么

在受监控工具的每次调用执行前（`tools/pre-execute` 钩子），插件把请求的模式和会话沙箱策略对这次调用给出的当前模式做比较：

| 调用参数 | 处理 |
| --- | --- |
| 请求的模式等于或窄于当前模式 | 去掉 `sandbox_permissions` 和 `justification` |
| `sandbox_permissions` 是 `null`、空字符串，或 Codex 的 `use_default` | 不论当前模式，两个字段都去掉 |
| 会话已经是 `danger-full-access`（例如传了 Codex 的 `require_escalated`） | 两个字段都去掉，因为不存在更宽的模式 |
| 只有 `justification`，没有 `sandbox_permissions` | 去掉 `justification` |
| 请求的模式宽于当前模式 | 不改动，DSH 照常请求批准 |
| 当前模式低于 `danger-full-access` 时请求了无法识别的值，或当前模式无法获取 | 不改动，交给 DSH 判断 |

Codex 自己的 shell 工具也用这个字段，取值是 `use_default` / `require_escalated` / `with_additional_permissions`，GPT 模型有时会把这些值带过来。`use_default` 和空值视为“没有请求”。另外两个值只在会话已经不受限制时去掉；在更窄的会话里交给 DSH 拒绝，因为猜测它们该对应多宽的模式，就等于替用户授予权限。

插件只处理在注册时声明了 DSH 自带升权参数的工具，第三方工具即使用了同名参数也不会被改动。改写发生在执行之前，所以不会先失败一次，也不依赖匹配错误文字。

插件不会放宽任何权限，只会去掉那些本来就不会改变模式的请求。

## 安装

在 DSH 插件市场中安装，或使用命令行：

```sh
dsh plugin --profile <name> add dsh-sandbox-noop-escalation
```

包里带有 `dsh.bundle.patch`，安装后会自动挂载，不需要改 profile 配置。

## 配置

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `tools` | `string[]` | `["bash", "pwsh", "write", "edit", "run_code"]` | 要监控的工具名。设为空列表即停用插件。 |

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: sandbox-noop-escalation
  config:
    tools: [bash, pwsh]
```

## 兼容性

已在 DSH 0.2.0-rc.2（cordis 4.0.4）上测试。插件依赖 `tools/pre-execute` 钩子以及 `tools`、`sandboxPolicy` 两个服务。缺少其中任何一项时插件不会加载；当前沙箱策略获取失败时，只去掉空值和 `use_default`，其余调用原样放行。

## 开发

```sh
npm test
```

## 许可证

MIT
