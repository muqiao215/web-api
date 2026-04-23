# systemd templates

These are examples for the future monorepo paths. Do not install them blindly while existing production units are running from old paths.

Recommended naming:

- `genapi-control-sub2api.service`
- `genapi-provider-gpt-web.service`
- `genapi-shim-gpt-responses.service`
- `genapi-shim-chat-responses.service`
- `genapi-shim-ds-responses.service`
- `genapi-provider-canvas.service`
- `genapi-provider-ds-free.service`

Operational note:

- GPT runtime cutover was completed on 2026-04-19.
- These templates are examples only. Replace repo paths, env-file paths, and browser-state paths for your host before enabling them.
