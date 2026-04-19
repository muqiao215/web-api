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
