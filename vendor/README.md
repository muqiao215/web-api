# Vendor

Pinned external projects and binary boundaries live here.

Initial policy:

- Keep `sub2api` as vendor/control-plane boundary.
- Do not rewrite `sub2api` into `uv` or `bun`.
- Keep Rust/Go upstreams as source or binary boundaries unless a targeted patch is justified.
