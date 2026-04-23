# Smoke Checks

Gemini smoke vocabulary:

- provider family: Gemini Web
- canonical provider surface: `providers/gemini-web/`
- current live transport: canvas-share bridge
- compatibility/runtime path that remains live: `providers/canvas-to-api/`
- live service names remain `canvas-to-api.service` and `gemini-canvas-browser@*.service`
- provider id compatibility remains `gemini-canvas`

Current local smoke commands:

```bash
curl -sS http://127.0.0.1:18080/health
curl -sS http://127.0.0.1:4242/health
curl -sS http://127.0.0.1:4252/health
curl -sS http://127.0.0.1:7861/health
uv run --project packages/ops_doctor wcapi-doctor
```

Do not treat the Gemini Web provider family as healthy just because the current `canvas-to-api` bridge answers `/health`. That proves only the live canvas-share bridge surface is reachable. Treat Gemini as healthy only when `browserConnected=true` or a direct generation smoke check passes.

Do not treat a chat-compatible worker as healthy just because `/v1/models` passes. A valid content smoke must return non-empty assistant text through the worker, the shim/native Responses path, and finally through `sub2api`.
