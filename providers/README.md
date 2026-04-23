# Providers

Providers expose real capability. A provider can be backed by a logged-in browser, a local API service, or an external binary.

Provider rules:

- Expose `/health`.
- Report capabilities using the shared provider contract.
- Keep browser profile/session state explicit.
- Do not hide login failures behind endless restarts.
- Prefer localhost-only bind by default.

Initial mapping:

| Existing runtime | Target | Strategy |
| --- | --- | --- |
| existing ChatGPT web worker | `providers/gpt-web-api/` | migrated source with local API surface |
| existing Canvas/Gemini worker | `providers/canvas-to-api/` | wrap carefully; browser session is critical |
| existing Qwen worker | `providers/qwen2api/` | only useful after account-pool import is working |
| existing DeepSeek worker | `providers/ds-free-api/` | wrapper around external binary/config first |
