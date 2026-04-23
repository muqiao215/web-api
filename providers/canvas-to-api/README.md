# canvas-to-api

This directory should now be read as the repo's **Gemini Web provider compatibility wrapper**.

It keeps the historical `canvas-to-api` path, but the conceptual provider boundary is broader than Canvas-only naming. The current live transport is still the Canvas/share bridge, so the operational identity remains a **runtime-status bridge** around an upstream browser worker rather than a fully generic Gemini Web runtime.

Canonical Gemini Web provider-surface files now live under `../gemini-web/`.
This directory stays in place as the stable compatibility path for existing routes, docs, tests, and service wiring.

## Layout

- `../gemini-web/`
  Canonical Gemini Web provider surface owned by this repo.
- `upstream/`
  Vendored upstream `CanvasToAPI` source tree.
- provider root
  Local integration notes, ignore rules, plus legacy-compatible `start.mjs` and `runtime_status.mjs` wrappers.

## Narrative Boundary

Use these terms carefully:

- **provider family**: Gemini Web
- **current bridge transport**: Canvas/share bridge
- **compatibility path in this repo**: `providers/canvas-to-api/`

This repo intentionally keeps those three layers separate. We are not renaming the folder yet, and we are not claiming the current runtime already covers every Gemini Web transport shape.

## What Is Absorbed

- Node/Express proxy worker source under `upstream/src`
- Vue/Vite UI source under `upstream/ui`
- upstream configs, docs, scripts, and startup files
- upstream `LICENSE`

## What Is Intentionally Not Copied

- `node_modules`
- `ui/dist`
- `.env*` runtime files other than `.env.example`
- `configs/share-link.json`
- auth/cache/temp runtime state

## Current Live Runtime

Current live unit:

- `canvas-to-api.service`
- bind: `127.0.0.1:7861`
- current entry is still managed by the upstream Canvas worker runtime, not by repo-owned replacement code

Important: service health and browser session health are different. `browserConnected=false` means the worker process is alive but Gemini/Banana generation can still fail.

That distinction is the main reason this provider should not be described as “fully absorbed”. The repo currently owns the integration boundary and runtime inspection, not the whole live runtime behavior.

It is also why this directory should not be read as "the final Canvas-only provider". The stable story is: Gemini Web provider family, current canvas-share bridge transport, compatibility wrapper path preserved.

Persistent browser profiles are managed separately from the API worker:

- `gemini-canvas-browser@a.service`: profile slot A, CDP `127.0.0.1:9231`
- `gemini-canvas-browser@b.service`: profile slot B, CDP `127.0.0.1:9232`
- noVNC handoff: `gemini-canvas-novnc.service`, local bind `127.0.0.1:6081`

Keep browser profile state outside Git and inject its root path through `WCAPI_CANVAS_PROFILE_ROOT` when needed.

## Runtime Contract

Canonical launcher:

```bash
node providers/gemini-web/start.mjs
```

Legacy-compatible launcher shim:

```bash
node providers/canvas-to-api/start.mjs
```

Canonical runtime-status entry:

```bash
node providers/gemini-web/runtime_status.mjs
```

Legacy-compatible entry:

```bash
node providers/canvas-to-api/runtime_status.mjs
```

Both commands emit the same `wcapi.browser_worker_runtime.v1` payload with `logged_in`, `browserConnected`, `cdp_ready`, profile list, and queue/lock policy. Queue counters are currently `null` because CanvasToAPI does not expose them yet; the standard policy is still profile-level single-flight for each persistent Google profile.
