# canvas-to-api

Bridge target for an upstream Canvas/Gemini worker.

Current live unit:

- `canvas-to-api.service`
- bind: `127.0.0.1:7861`
- current entry is still managed by the upstream Canvas worker runtime, not by this wrapper package

Important: service health and browser session health are different. `browserConnected=false` means the worker process is alive but Gemini/Banana generation can still fail.

Persistent browser profiles are managed separately from the API worker:

- `gemini-canvas-browser@a.service`: profile slot A, CDP `127.0.0.1:9231`
- `gemini-canvas-browser@b.service`: profile slot B, CDP `127.0.0.1:9232`
- noVNC handoff: `gemini-canvas-novnc.service`, local bind `127.0.0.1:6081`

Keep browser profile state outside Git and inject its root path through `WCAPI_CANVAS_PROFILE_ROOT` when needed.

Runtime contract:

```bash
node providers/canvas-to-api/runtime_status.mjs
```

This emits `wcapi.browser_worker_runtime.v1` with `logged_in`, `browserConnected`, `cdp_ready`, profile list, and queue/lock policy. Queue counters are currently `null` because CanvasToAPI does not expose them yet; the standard policy is still profile-level single-flight for each persistent Google profile.
