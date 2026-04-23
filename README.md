# Web Capability API

Web Capability API is a self-hosted toolkit for turning logged-in web apps, browser sessions, and local model workers into manageable HTTP APIs.

It is aimed at builders who already have a working browser or provider runtime and want to expose it behind a more stable API surface instead of driving everything from ad hoc bots or manual browser clicks.

## What It Does

- Wrap browser-backed capabilities as local provider APIs.
- Add protocol shims where an upstream only exposes chat-completions style endpoints.
- Keep provider contracts, queue state, artifact records, and health checks in one place.
- Let downstream consumers such as bots, automation jobs, and showcase apps talk to a unified surface instead of each provider directly.

## Current Scope

Implemented or staged in this repository:

- ChatGPT web provider
- Generic chat-to-responses shim
- GPT responses shim
- Prompt factory and prompt export pipeline
- Canvas, DeepSeek, and Qwen integration stubs and runtime notes

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

## Repository Layout

```text
apps/                 optional control surfaces
providers/            capability workers
shims/                protocol adapters
packages/             shared contracts and CLIs
consumers/            downstream bots and apps
vendor/               external upstream boundaries
ops/                  env templates and deployment examples
```

## Tooling

- Python packages use `uv`.
- JavaScript and TypeScript packages use `bun`.
- Runtime verification starts with `packages/ops_doctor`.

## Honest Boundaries

- Some providers only work when a real browser session is already authenticated.
- Some integrations in this repo are wrappers or migration targets, not fully productized upstream forks.
- `sub2api` is the intended management plane, but not every provider in this repo should be registered into it until direct content smoke checks pass.

## Where To Go Next

- Start with [providers](providers/README.md) for provider surfaces.
- See [shims](shims/README.md) for protocol adapters.
- See [ops](ops/README.md) for deployment templates and non-secret environment examples.
