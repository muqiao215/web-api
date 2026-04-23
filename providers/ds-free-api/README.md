# ds-free-api

This provider now has a real upstream source slice inside the monorepo, but its practical shape is still **external worker + generic shim**.

## Layout

- `upstream/`
  Vendored Apache-2.0 upstream worker source from `NIyueeE/ds-free-api`.
- provider root
  Local integration notes, ignore rules, and the boundary to repo-owned shims/control plane code.

## What Is Absorbed

- Rust worker source under `upstream/src`
- upstream docs and examples
- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`
- `config.example.toml`
- upstream `LICENSE`

## What Is Intentionally Not Copied

- local credential-bearing configs
- `py-e2e-tests/` because the current local copies include account-specific config files
- build output such as `target/`
- host-specific service state

## Current Local Runtime

Current live unit is transient:

- `ds-free-api-b492dedd.service`
- bind: `127.0.0.1:5317`

Current unification path:

- worker surface: `127.0.0.1:5317`
- generic shim source: [`shims/chat-responses`](../../shims/chat-responses)
- local shim target: `127.0.0.1:5327`

That is the important architecture fact: the repo is currently integrating an external worker and normalizing it through a generic shim, not replacing the worker with a repo-native rewrite.

## Integration Rule

Do not rewrite the Rust worker first. Normalize service ownership, env/config paths, and Responses-shim registration around the absorbed upstream.

Important runtime note:

- local auth to the worker is necessary but not sufficient
- if direct `/v1/chat/completions` still returns empty assistant content, do not register it into `sub2api` as healthy
