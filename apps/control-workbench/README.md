# control-workbench

Placeholder for a future first-party UI. Keep this thin: it should read status from provider health endpoints, shared schemas, and `sub2api`, not duplicate provider logic.

For Gemini dual-track identity, the control-workbench surface should treat
`gemini-web` as the primary consumer-facing provider key whenever canonical
fields are present, while still preserving the live bridge/runtime identity via
`providerLegacy=gemini-canvas` and `runtime.provider_id=gemini-canvas`.
