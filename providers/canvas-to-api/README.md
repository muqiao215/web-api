# canvas-to-api

Future target for `/root/.ductor/workspace/CanvasToAPI`.

Current live unit:

- `canvas-to-api.service`
- bind: `127.0.0.1:7861`
- current entry: `npm start` from `/root/.ductor/workspace/CanvasToAPI`

Important: service health and browser session health are different. `browserConnected=false` means the worker process is alive but Gemini/Banana generation can still fail.

Persistent browser profiles are managed separately from the API worker:

- `gemini-canvas-browser@a.service`: `/root/.ductor/state/browser-profiles/gemini-a`, CDP `127.0.0.1:9231`
- `gemini-canvas-browser@b.service`: `/root/.ductor/state/browser-profiles/gemini-b`, CDP `127.0.0.1:9232`
- noVNC handoff: `gemini-canvas-novnc.service`, local bind `127.0.0.1:6081`

Runbook: [`ops/browser-profiles/gemini-canvas-profiles.md`](../../ops/browser-profiles/gemini-canvas-profiles.md).

Runtime contract:

```bash
node providers/canvas-to-api/runtime_status.mjs
```

This emits `wcapi.browser_worker_runtime.v1` with `logged_in`, `browserConnected`, `cdp_ready`, profile list, and queue/lock policy. Queue counters are currently `null` because CanvasToAPI does not expose them yet; the standard policy is still profile-level single-flight for each persistent Google profile.
