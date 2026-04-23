# ops_doctor

Small `uv`-managed CLI for local health checks.

For Gemini, the CLI now follows the canonical provider surface under `providers/gemini-web/`, while preserving compatibility with the live canvas-share bridge service names and runtime path (`providers/canvas-to-api/`, `canvas-to-api.service`, `gemini-canvas-browser@*.service`, provider id `gemini-canvas`). The runtime payload now exposes both `provider_id_canonical=gemini-web` and `provider_id_legacy=gemini-canvas`; operator-facing doctor output prefers the canonical id while still surfacing the live legacy id in detail text.

Run from repo root:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Strict mode treats warnings as failures:

```bash
uv run --project packages/ops_doctor wcapi-doctor --strict
```
