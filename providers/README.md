# Providers

Providers expose real capability. A provider can be backed by a logged-in browser, a local API service, or an external binary.

Provider rules:

- Expose `/health`.
- Report capabilities using the shared provider contract.
- Keep browser profile/session state explicit.
- Do not hide login failures behind endless restarts.
- Prefer localhost-only bind by default.

Initial mapping:

| Existing project | Target | Strategy |
| --- | --- | --- |
| `/root/.ductor/workspace/gpt_web_api` | `providers/gpt-web-api/` | migrated source; runtime cutover later |
| `/root/.ductor/workspace/CanvasToAPI` | `providers/canvas-to-api/` | wrap/adopt carefully; browser session is critical |
| `/root/.ductor/workspace/qwen2API` | `providers/qwen2api/` | candidate after account pool is usable |
| `/root/.ductor/workspace/ds-free-api` | `providers/ds-free-api/` | wrapper around Rust binary/config first |
