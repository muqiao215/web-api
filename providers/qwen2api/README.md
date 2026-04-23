# qwen2api

This provider now has a real upstream source slice inside the monorepo.

## Layout

- `upstream/`
  Vendored upstream `qwen2API` source tree.
- provider root
  Local integration notes, ignore rules, and the boundary to repo-owned shims/control-plane code.

## What Is Absorbed

- Python FastAPI backend source under `upstream/backend`
- Vite frontend source under `upstream/frontend`
- upstream startup/deploy files such as `start.py`, `Dockerfile`, `.env.example`, and `docker-compose.yml`
- upstream WebUI and admin-plane source

## What Is Intentionally Not Copied

- `.venv`
- `frontend/node_modules`
- `frontend/dist`
- account-pool and user data JSON files
- local logs and caches

## Current Runtime Facts

- local account-pool import path is proven
- direct local chat smoke has already been proven once account data is populated
- it still should not be treated as healthy by default unless the account pool is non-empty and a fresh content smoke passes

## Integration Rule

Do not register it into `sub2api` until local direct chat works and account pool is non-empty.
