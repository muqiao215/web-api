# systemd templates

These are examples for the future monorepo paths. Do not install them blindly while existing production units are running from old paths.

Gemini-specific naming note:

- canonical provider surface is `providers/gemini-web/`
- canonical launcher is `providers/gemini-web/start.mjs`
- current transport is the canvas-share bridge
- runtime compatibility path stays `providers/canvas-to-api/`
- legacy launcher shim remains `providers/canvas-to-api/start.mjs`
- live service names remain canvas-oriented for compatibility

Do not rename current Gemini units just because the canonical provider surface moved.

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
- Gemini docs now treat `genapi-provider-canvas.service` as the current Gemini Web canvas-share bridge template, not as proof that the conceptual provider family is Canvas-only.
- The Gemini template now points at the canonical launcher path instead of relying on `WorkingDirectory=providers/canvas-to-api`.
- These templates are examples only. Replace repo paths, env-file paths, and browser-state paths for your host before enabling them.
