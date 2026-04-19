# ops_doctor

Small `uv`-managed CLI for local health checks.

Run from repo root:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Strict mode treats warnings as failures:

```bash
uv run --project packages/ops_doctor wcapi-doctor --strict
```
