# ds-free-api

Wrapper target for `/root/.ductor/workspace/ds-free-api`.

Current live unit is transient:

- `ds-free-api-b492dedd.service`
- bind: `127.0.0.1:5317`

Do not rewrite the Rust worker. First normalize service ownership, env/config paths, and add a Responses shim if it needs to sit behind `sub2api`.

Current unification path:

- worker surface: `127.0.0.1:5317`
- generic shim source: [chat-responses](/root/.ductor/workspace/web_capability_api/shims/chat-responses)
- local shim target: `127.0.0.1:5327`

Important runtime note:

- local auth to the worker is necessary but not sufficient
- if direct `/v1/chat/completions` still returns empty assistant content, do not register it into `sub2api` as healthy
