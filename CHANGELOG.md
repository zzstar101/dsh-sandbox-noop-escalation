# Changelog

## 0.1.0 - 2026-10-07

- Initial release: drop `sandbox_permissions` / `justification` in `tools/pre-execute` when the requested mode is the same as or narrower than the current sandbox mode, and drop a lone `justification`. Widening and unknown requests are left to DSH core.
