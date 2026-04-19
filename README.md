# Web Capability API

`web_capability_api` is the local monorepo skeleton for turning logged-in web, browser, and local provider capabilities into manageable APIs.

The core product is not a Telegram bot. Bots, showcase sites, and batch jobs are downstream consumers. The core is:

```text
logged-in browser / local worker / upstream API
  -> provider API
  -> protocol shim where needed
  -> sub2api management plane
  -> consumers
```

## Current Principles

- Use `sub2api` as the unified API management plane.
- Use `uv` for first-party Python packages and CLIs.
- Use `bun` for first-party JavaScript and TypeScript apps.
- Do not force browser-profile-bound services into containers for neatness.
- Keep browser sessions, Chrome CDP, and noVNC as explicit runtime dependencies.
- Keep Go/Rust/external upstream projects as vendor or wrapper boundaries unless there is a concrete reason to fork.
- Treat Telegram bots and showcase sites as consumers, not as the core architecture.

## Current Local Reality

Confirmed live services on this host:

| Role | Current service | Local surface | Status |
| --- | --- | --- | --- |
| API management plane | `sub2api-local.service` | `127.0.0.1:18080` | active, `/health` ok |
| GPT browser worker | `gpt-web-api.service` | `127.0.0.1:4242` | active, `/health` ok |
| GPT Responses shim | `gpt-web-responses-shim.service` | `127.0.0.1:4252` | active, `/health` ok |
| Gemini/Canvas worker | `canvas-to-api.service` | `127.0.0.1:7861` | service active, `browserConnected=false` can still block image generation |
| DeepSeek worker | `ds-free-api-b492dedd.service` | `127.0.0.1:5317` | active, auth required |
| Browser runtime | Chrome CDP | `127.0.0.1:9222` | listening |
| Manual browser rescue | noVNC/websockify | `127.0.0.1:6080` | listening |

This repository starts as a scaffold. Do not migrate running services blindly; migrate one layer at a time and rewire systemd paths only after smoke checks pass.

## Migration Status

Already migrated into this repository:

- `providers/gpt-web-api/`
- `shims/gpt-web-responses/`
- `packages/prompt-factory/`

Already cut over to run from this repository:

- `gpt-web-api.service`
- `gpt-web-responses-shim.service`

Still running from legacy or external paths:

- all current `sub2api` units
- Canvas units
- other provider and consumer services

That means GPT code migration and GPT runtime cutover are both complete, while the rest of the stack is still staged.

## Layout

```text
apps/                 optional first-party control surfaces
providers/            API workers that expose real capabilities
shims/                protocol adapters between workers and sub2api
packages/             shared schemas, prompt/control packages, ops CLIs
consumers/            Telegram bots, showcase sites, batch jobs
vendor/               pinned external source or binary boundaries
ops/                  systemd, env templates, smoke checks, runbooks
```

## Tooling

Python:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

JavaScript/TypeScript:

```bash
bun install
bun run doctor
```

Note: this host currently has `uv` available. If `bun` is missing on a target host, install it before relying on JS workspace scripts; do not fall back to `npm` for new first-party work unless this is an emergency recovery.

## Migration Order

1. Keep all existing services running from their current directories.
2. Use `packages/ops_doctor` to establish a baseline.
3. GPT API, GPT shim, and prompt factory have already been copied and verified in this repo; GPT runtime cutover is complete.
4. Keep `sub2api` under `vendor/` and deploy wrappers under `ops/`.
5. Treat `CanvasToAPI` as a browser-session provider; fix login/profile operations before calling it stable.
6. Move consumers last.

## Verification

Run:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Use `--strict` when a warning such as `browserConnected=false` should fail the check.
