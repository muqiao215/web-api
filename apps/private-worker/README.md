# private-worker

Thin first-party private worker runtime for the two-node pilot.

## Purpose

- Run on the private worker host, not the public center
- Accept center-issued jobs over a private HTTP surface
- Forward execution to a local upstream runtime on that host
- Keep the center/worker split explicit inside the monorepo

## Current Endpoints

- `GET /health` — provider-style private health alias
- `POST /v1/chat/completions` — provider-style private unified API surface for `chat.completion`
- `GET /internal/worker/health` — transitional legacy alias
- `POST /internal/worker/jobs` — transitional legacy alias

## Required Environment

```bash
PRIVATE_WORKER_SHARED_TOKEN=change-me
PRIVATE_WORKER_OPENAI_BASE_URL=http://127.0.0.1:7860
```

Optional:

```bash
PRIVATE_WORKER_HOST=127.0.0.1
PRIVATE_WORKER_PORT=7788
PRIVATE_WORKER_ID=py-machine
PRIVATE_WORKER_CAPABILITIES=chat.completion
PRIVATE_WORKER_OPENAI_API_KEY=
PRIVATE_WORKER_OPENAI_MODEL=qwen3.6-plus
```

## Run

```bash
node server.mjs
```

## Notes

- This is intentionally private-host oriented.
- It is not a second public northbound API gateway.
- For `chat.completion`, the preferred southbound contract is provider-style `POST /v1/chat/completions` with `Authorization: Bearer <PRIVATE_WORKER_SHARED_TOKEN>`.
- The legacy `x-wcapi-worker-token` + `/internal/worker/jobs` path still works as a transitional compatibility layer.
