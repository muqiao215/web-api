# ds-free-api

Wrapper target for `/root/.ductor/workspace/ds-free-api`.

Current live unit is transient:

- `ds-free-api-b492dedd.service`
- bind: `127.0.0.1:5317`

Do not rewrite the Rust worker. First normalize service ownership, env/config paths, and add a Responses shim if it needs to sit behind `sub2api`.
