# qwen2api

Wrapper target for an upstream `qwen2API` deployment.

Current known shape:

- Python FastAPI backend.
- Vite frontend.
- Requires account-pool health before it should be considered a stable provider.

Migration rule: do not register it into `sub2api` until local direct chat works and account pool is non-empty.
