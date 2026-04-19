# systemd templates

These are examples for the future monorepo paths. Do not install them blindly while existing production units are running from old paths.

Recommended naming:

- `genapi-control-sub2api.service`
- `genapi-provider-gpt-web.service`
- `genapi-shim-gpt-responses.service`
- `genapi-provider-canvas.service`
- `genapi-provider-ds-free.service`

Operational note:

- GPT runtime cutover was completed on 2026-04-19.
- Before/after unit snapshots are stored in [backups/20260419-gpt-cutover](/root/.ductor/workspace/web_capability_api/ops/systemd/backups/20260419-gpt-cutover).
