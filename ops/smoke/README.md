# Smoke Checks

Current local smoke commands:

```bash
curl -sS http://127.0.0.1:18080/health
curl -sS http://127.0.0.1:4242/health
curl -sS http://127.0.0.1:4252/health
curl -sS http://127.0.0.1:7861/health
uv run --project packages/ops_doctor wcapi-doctor
```

Do not treat Canvas/Gemini image generation as healthy unless `browserConnected=true` or a direct generation smoke check passes.

Do not treat a chat-compatible worker as healthy just because `/v1/models` passes. A valid content smoke must return non-empty assistant text through the worker, the shim/native Responses path, and finally through `sub2api`.
