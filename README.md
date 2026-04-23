# Web Capability API

Web Capability API is a self-hosted toolkit for turning logged-in web apps, browser sessions, and local model workers into manageable HTTP APIs.

It is aimed at builders who already have a working browser or provider runtime and want to expose it behind a more stable API surface instead of driving everything from ad hoc bots or manual browser clicks.

This repository is best described as a **unified control-layer monorepo**:

- `sub2api` is the management-plane boundary
- browser sessions and local workers are the actual capability backends
- some upstream runtimes are partly absorbed into the tree, but not all are owned in the same way

This is therefore not a full source mirror of every provider it can manage, and not a flat collection of equivalent wrappers either.

## What It Does

- Wrap browser-backed capabilities as local provider APIs.
- Add protocol shims where an upstream only exposes chat-completions style endpoints.
- Keep provider contracts, queue state, artifact records, and health checks in one place.
- Let downstream consumers such as bots, automation jobs, and showcase apps talk to a unified surface instead of each provider directly.
- Expose a center-owned async job surface and let private worker nodes execute selected capabilities remotely.

## Current Scope

Implemented or staged in this repository:

- ChatGPT web provider
- Generic chat-to-responses shim
- GPT responses shim
- Prompt factory and prompt export pipeline
- DeepSeek provider boundary around an external worker plus generic Responses shim
- Qwen provider boundary around a lightweight account-pool runtime
- Gemini Web-first provider surface under `providers/gemini-web/`, with `providers/canvas-to-api/` preserved as the legacy compatibility wrapper around the current browser/runtime transport
- Private worker pilot runtime for the two-node center/worker path

This repository is intentionally systemd-first and browser-aware. It does not try to hide that some providers depend on a real logged-in browser session.

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

Run a provider or shim from the repo root:

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

## Layering

The architecture has four visible layers:

1. Generic / shared contracts layer
   `packages/` and reusable schemas, queues, pools, artifacts, and health tooling.
2. Integration / provider layer
   `providers/`, `shims/`, and `apps/private-worker`.
3. Vendored / upstream boundary layer
   `vendor/` and `providers/<provider>/upstream`.
4. Runtime / control layer
   provider-local runtime status, browser profiles, queue/lock policy, and service ownership.

For Gemini specifically, the conceptual provider family is now **Gemini Web**. The canonical repo/provider surface is `providers/gemini-web/`. The path `providers/canvas-to-api/` remains in place only as a compatibility wrapper because today's live transport still preserves canvas-share era service/runtime assumptions. That path should not be read as the canonical provider id or long-term provider model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full four-layer model and [UPSTREAMS.md](UPSTREAMS.md) for the current boundary map.

## Runtime Tiers

Not every provider should be treated as the same default path.

- Tier 0: lightweight text
  Prefer this for ordinary text chat where possible.
- Tier 1: browser-backed capability
  Use this for image generation, file flows, and browser-native features.
- Tier 2: login/session maintenance
  Browser profile repair, CDP attachment, and identity lifecycle.
- Tier 3: long-running and artifact-heavy jobs
  Research, async jobs, remote worker execution, and similar flows.

This matters because browser-backed providers are powerful but more memory-expensive. They should not silently become the default path for every cheap text request.

## Tooling

- Python packages use `uv`.
- JavaScript and TypeScript packages use `bun`.
- Runtime verification starts with `packages/ops_doctor`.

## Honest Boundaries

- Some providers only work when a real browser session is already authenticated.
- Some integrations in this repo are repo-native runtimes, while others are runtime-status bridges or external worker boundaries.
- Gemini Web chat is already admitted through the unified northbound `/v1/chat/completions` surface; Gemini image admission exists but remains experimental / degraded-first.
- Gemini Web's canonical public/provider id is `gemini-web`; `gemini-canvas` remains only a legacy compatibility alias.
- `sub2api` is the intended management plane, but not every provider in this repo should be registered into it until direct content smoke checks pass.
- The first distributed execution slice is intentionally narrow: center northbound `/v1/jobs`, static worker registry, private worker execution, and local fallback.

## Where To Go Next

- Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the control-plane model.
- Start with [providers](providers/README.md) for provider surfaces.
- See [shims](shims/README.md) for protocol adapters.
- See [ops](ops/README.md) for deployment templates and non-secret environment examples.
