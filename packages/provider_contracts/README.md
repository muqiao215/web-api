# provider_contracts

Shared JSON schemas for provider capability, browser-worker runtime state, and artifact metadata.

These contracts are intentionally small. They standardize what the control plane, doctor, and downstream consumers need to know without forcing every provider into the same implementation.

Current schema set:

- `provider-capability.schema.json`
- `runtime-health.schema.json`
- `browser-worker-runtime.schema.json`
- `artifact-record.schema.json`

Design rules:

- A browser worker should always report `service_alive`, `logged_in`, `cdp_ready`, and `queue`.
- Queue and lock semantics are profile-scoped, even when the current worker only has one active profile:
  - GPT Web currently reports one `default` profile and serializes provider operations through `JobQueue`.
  - Gemini Web currently reaches this repo through the `canvas-to-api` compatibility wrapper and reports profiles `a` and `b`; each profile must be treated as single-flight until CanvasToAPI exposes upstream queue counters.
- Artifact metadata should be independent of any specific bot or provider implementation.

Runtime payloads intentionally keep both `browser_connected` and `browserConnected` during migration. New code should prefer `browser_connected`; doctor checks still surface the legacy `browserConnected` spelling because CanvasToAPI already emits it.

For Gemini dual-track provider identity, the live runtime payload may keep `provider_id=gemini-canvas` for compatibility while also emitting `provider_id_canonical=gemini-web`, `provider_id_legacy=gemini-canvas`, and `provider_aliases`. New consumers should prefer `provider_id_canonical`, then `provider_family`, and only fall back to `provider_id` when the canonical field is absent.
