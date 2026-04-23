# Providers

Providers expose real capability. A provider can be backed by a logged-in browser, a local API service, or an external binary.

Provider rules:

- Expose `/health`.
- Report capabilities using the shared provider contract.
- Keep browser profile/session state explicit.
- Do not hide login failures behind endless restarts.
- Prefer localhost-only bind by default.

`providers/` is an integration directory, not a statement that every provider has the same ownership level.

Current provider classes:

| Class | Meaning |
| --- | --- |
| repo-native runtime | Real runtime behavior is owned here |
| runtime-status bridge | Upstream runtime still does the work; repo adds inspection and integration boundary |
| compatibility wrapper | Repo keeps a stable local provider path while the live transport is still narrower than the conceptual provider family |
| lightweight text boundary | Account-pool or token-oriented text provider integration |
| external worker + shim | External worker is primary; repo normalizes the northbound shape |

Current mapping:

| Existing runtime | Target | Class | Strategy |
| --- | --- | --- | --- |
| existing ChatGPT web worker | `providers/gpt-web-api/` | repo-native runtime | own the browser-backed capability runtime in-repo |
| existing Gemini Web worker family | `providers/gemini-web/` | repo-owned provider surface + compatibility wrapper | treat `providers/gemini-web/` as the canonical Gemini Web provider surface, while keeping `providers/canvas-to-api/` as the legacy compatibility shell and preserving older service/runtime names |
| existing Qwen worker | `providers/qwen2api/` | lightweight text boundary | keep the account-pool and direct-smoke boundary explicit |
| existing DeepSeek worker | `providers/ds-free-api/` | external worker + shim | keep the worker plus generic shim shape explicit instead of rewriting first |

Gemini-specific note:

- canonical provider-family surface: `providers/gemini-web/`
- preserved compatibility wrapper: `providers/canvas-to-api/`
- canonical northbound/public provider id: `gemini-web`
- accepted legacy alias: `gemini-canvas`
- `/v1/providers` and `/v1/models` should expose `gemini-web`, not `gemini-canvas`
- current live transport remains the canvas-share bridge until a later migration
