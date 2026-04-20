# provider_artifacts

Shared artifact metadata helpers for browser/API workers.

Goals:

- Keep generated-image and downloaded-file metadata out of bot-specific code.
- Use one stable `artifact` record shape for providers, shims, and downstream consumers.
- Let workers keep their own binary outputs while sharing one index format.

Current first adopter:

- `providers/gpt-web-api`
