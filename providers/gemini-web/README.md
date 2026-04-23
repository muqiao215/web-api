# gemini-web

This directory is the repo's **canonical Gemini Web provider surface**.

It now owns the repo's **Gemini Web-first runtime contract** while still preserving the historical compatibility shell:

- **provider family**: Gemini Web
- **canonical transport**: Gemini Web cookie-auth runtime
- **legacy compatibility path**: `providers/canvas-to-api/`

## Current Scope

This directory is intentionally small and repo-owned:

- `start.mjs`
  Canonical Gemini Web launcher. It owns the repo-level launch contract and starts the repo-owned Gemini runtime under `./upstream/`.
- `runtime_status.mjs`
  Canonical Gemini Web runtime inspection entrypoint for repo tooling.
- `lib/`
  Shared runtime-status implementation and Gemini Web boundary metadata.
- `upstream/`
  Repo-owned Python Gemini runtime based on `gemini-webapi`.

The stable narrative is now:

1. `providers/gemini-web/` is the canonical provider/runtime surface
2. the new runtime is Gemini Web-first and cookie-auth based
3. `providers/canvas-to-api/` remains only as a legacy compatibility shell

## Compatibility Contract

- `providers/canvas-to-api/` stays in place
- `providers/canvas-to-api/start.mjs` stays callable as a thin launcher shim
- `providers/canvas-to-api/runtime_status.mjs` stays callable
- existing service names such as `canvas-to-api.service` and `gemini-canvas-browser@*.service` stay unchanged
- canonical northbound/public provider id is `gemini-web`
- `gemini-canvas` remains an accepted legacy alias for request routing compatibility
- runtime payload may still keep top-level `provider_id=gemini-canvas` while also emitting `provider_id_canonical=gemini-web`, `provider_id_legacy=gemini-canvas`, and `provider_aliases`
- legacy launcher mode can still bind `7861`; canonical launcher defaults to `7862`

## Admission

- chat: canonical / ready
- image generation: experimental / degraded-first
- files + vision: exposed by the runtime contract, but still need progressive hardening at the northbound layer

## Northbound Contract

- `providers/gpt-web-api/` now registers Gemini Web as a real provider instead of treating it as an undocumented side path
- `/v1/providers` and `/v1/models` expose `gemini-web` as the canonical Gemini provider/model owner
- unified chat is available through `POST /v1/chat/completions`
- unified image generation is admitted through `POST /v1/images/generations`, but image admission remains experimental / degraded-first
- on the northbound API, `stream: true` for `gemini-web` is not true incremental streaming yet; it is an explicit degraded single-event SSE strategy (`single_event_degraded`) followed by the terminal stop event and `[DONE]`

## Canonical Commands

Run the canonical launcher from the repo root:

```bash
node providers/gemini-web/start.mjs
```

Or through workspace scripts:

```bash
node providers/gemini-web/runtime_status.mjs
npm run gemini:start
npm run gemini:runtime:status
```

Canonical health endpoint:

```bash
curl http://127.0.0.1:7862/health
```

Legacy-compatible launcher path remains available:

```bash
node providers/canvas-to-api/start.mjs
```
