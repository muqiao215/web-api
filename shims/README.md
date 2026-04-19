# Shims

Shims adapt provider-specific APIs to the protocol expected by `sub2api` or downstream clients.

Rules:

- Keep shims thin.
- Expose `/health`.
- Report upstream URL and default model without secrets.
- Do not implement business logic that belongs in a provider.
