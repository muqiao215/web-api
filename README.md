# Web Capability API

Web Capability API is a self-hosted control-layer monorepo for turning logged-in web apps, browser sessions, and local model workers into manageable HTTP APIs.

It is designed for builders who already have real capability backends, such as browser profiles, share-link workers, or lightweight account-pool runtimes, and want to expose them behind a clearer northbound surface.

This repo is not a claim that every provider has already been fully absorbed into one native codebase. It is a practical unification layer with mixed ownership models.

## What This Repo Is Good At

- wrapping browser-backed capability as provider APIs
- adding protocol shims where an upstream surface is incomplete
- keeping provider contracts, queue state, artifacts, and health signals in one place
- giving downstream bots, apps, and automation jobs a more stable surface than direct browser scripting
- supporting a narrow center/worker execution model for selected remote jobs

## Stable

These are the clearest public-facing paths in the repository today.

### Repo-native control and contract layer

- `packages/provider_contracts`
- `packages/job_queue`
- `packages/provider_pool`
- `packages/proxy_pool`
- `packages/audit_log`
- `packages/provider_artifacts`
- `packages/ops_doctor`

This is the reusable substrate of the repo: schemas, queue semantics, artifact records, runtime health vocabulary, and operator-facing diagnostics.

### GPT web provider line

- `providers/gpt-web-api`
- `shims/gpt-web-responses`
- `shims/chat-responses`

This is the strongest repo-native provider path right now. It already owns provider routing, session affinity, queue behavior, browser runtime checks, admin surfaces, async jobs, and media/index handling inside the repo.

### Control and worker surfaces

- `apps/control-workbench`
- `apps/private-worker`

These provide the read-only control aggregation layer and the first narrow distributed execution slice.

## Experimental

These paths are real and useful, but they should still be read as evolving integrations rather than flat, fully mature product surfaces.

### Gemini Web family

- canonical provider family: `providers/gemini-web`
- current bridge compatibility path: `providers/canvas-to-api`

Current practical status:

- Gemini Web chat is admitted through the unified northbound surface
- Gemini image flows exist, but should still be treated as experimental / degraded-first
- the current live transport still preserves canvas-share era assumptions

Conceptually this repo now treats the family as **Gemini Web**, not "Canvas provider", but the compatibility path remains because the runtime transport has not been fully re-homed yet.

### Lightweight text boundaries

- `providers/qwen2api`
- `providers/ds-free-api`

These are useful integration boundaries, but they are not equivalent to the GPT web line in repo ownership.

- `qwen2api` is primarily an account-pool text path
- `ds-free-api` is primarily an external worker plus normalization shim

### Prompt and prompt-export tooling

- `packages/prompt-factory`

This area is already useful, but it also depends on external prompt sources and bridge logic. It is best treated as a practical pipeline, not as a sealed standalone product.

## Legacy

These paths still matter operationally, but they should be read as compatibility or transition layers rather than the long-term public model.

### Gemini compatibility aliases

- `providers/canvas-to-api`
- legacy provider id: `gemini-canvas`

These remain in the tree because today's live runtime and service wiring still depend on them. They are preserved so existing deployments and runtime assumptions do not break abruptly.

### Transitional worker and runtime shapes

- legacy internal worker routes still exist in `apps/private-worker`
- some runtime payloads still expose legacy ids or compatibility fields during migration

This repo keeps those edges visible on purpose. The goal is controlled migration, not fake cleanliness.

## Quick Start

Install workspace dependencies:

```bash
bun install
uv sync --project packages/ops_doctor
```

Run the health doctor:

```bash
uv run --project packages/ops_doctor wcapi-doctor
```

Run key services from the repo root:

```bash
cd providers/gpt-web-api
bun run start
```

```bash
cd shims/gpt-web-responses
bun run start
```

Canonical Gemini Web launcher from the repo root:

```bash
node providers/gemini-web/start.mjs
```

## Repository Layout

```text
apps/                 thin first-party orchestration runtimes
providers/            provider integration boundaries and owned runtimes
shims/                protocol adapters
packages/             shared contracts, queues, and control-plane libraries
consumers/            downstream bots and apps
vendor/               upstreams kept outside provider ownership
ops/                  deployment/runtime examples and environment templates
```

## Reading Guide

- Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the four-layer control-plane model.
- Start with [UPSTREAMS.md](UPSTREAMS.md) for the current upstream and ownership map.
- Start with [providers/README.md](providers/README.md) for provider-specific surfaces.
- See [shims/README.md](shims/README.md) for protocol adapters.
- See [ops/README.md](ops/README.md) for runtime templates and environment examples.

## Honest Boundary

- Some providers only work when a real browser session is already authenticated.
- Some integrations are repo-native runtimes, while others remain runtime-status bridges or external worker boundaries.
- A remote management plane can sit northbound, but this repo does not require a local `sub2api` service to make sense.
- The repo is strongest today as a unified control layer, not as a claim that every referenced provider has already been fully re-implemented here.
