# Changelog

## 0.2.0 - 2026-10-07

- Treat `null`, empty/blank strings and Codex's `use_default` as "no request" and remove them in any mode, including when the sandbox policy cannot be resolved.
- When the session is already at `danger-full-access`, remove any `sandbox_permissions` value, including Codex's `require_escalated` / `with_additional_permissions`: nothing is wider. In narrower sessions those values are still left to DSH.

## 0.1.0 - 2026-10-07

- Initial release: drop `sandbox_permissions` / `justification` in `tools/pre-execute` when the requested mode is the same as or narrower than the current sandbox mode, and drop a lone `justification`. Widening and unknown requests are left to DSH core.
