# Doctor

Run:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Strict mode:

```bash
uv run --project packages/ops_doctor wcapi-doctor --strict
```

Expected current warning when Canvas is logged out or disconnected:

```text
WARN http canvas-to-api service ok but browserConnected=false
WARN runtime canvas-browser-worker status=blocked logged_in=false browserConnected=false cdp_ready=true ...
```
