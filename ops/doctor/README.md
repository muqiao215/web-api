# Doctor

Operator naming for current Gemini checks:

- canonical provider surface: `providers/gemini-web/`
- current live transport: canvas-share bridge
- legacy compatibility path still exercised by service/runtime wiring: `providers/canvas-to-api/`
- live unit names stay `canvas-to-api.service` and `gemini-canvas-browser@*.service`
- provider id compatibility stays `gemini-canvas`

Run:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Strict mode:

```bash
uv run --project packages/ops_doctor wcapi-doctor --strict
```

The doctor entrypoint follows the canonical Gemini runtime surface, but current warnings still describe the live bridge/service reality.

Expected current warning when the current Gemini Web canvas-share bridge is logged out or disconnected:

```text
WARN http gemini-web-runtime service ok via canvas-to-api /health but browserConnected=false (legacy provider_id=gemini-canvas)
WARN runtime gemini-web-browser-worker status=blocked logged_in=false browserConnected=false cdp_ready=true ...
```
