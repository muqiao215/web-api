# Architecture

`web-api` is best understood as a **unified control-layer monorepo**:

- `sub2api` is the management-plane boundary.
- browser sessions and local workers are the actual capability backends.
- some upstream runtimes are partly absorbed into the repo tree, but they are not all owned in the same way.

It is therefore not accurate to describe this repo as either:

- a single self-contained product, or
- a flat collection of equivalent provider wrappers.

It is a control plane plus a set of provider integrations at different maturity levels.

## Four Layers

### 1. Generic / Shared Contracts Layer

This is the reusable shared substrate.

Main areas:

- `packages/provider_contracts`
- `packages/job_queue`
- `packages/provider_pool`
- `packages/proxy_pool`
- `packages/audit_log`
- `packages/provider_artifacts`
- `packages/ops_doctor`

What it does:

- defines schemas for health, artifacts, account pools, proxies, queue state, and audit events
- standardizes queue and runtime metadata
- gives providers a common control-plane vocabulary

What it does not do by itself:

- run browsers
- own provider sessions
- guarantee that a specific upstream runtime is healthy

### 2. Integration / Provider Layer

This is where real capability is exposed.

Main areas:

- `providers/*`
- `shims/*`
- `apps/private-worker`

What it does:

- exposes browser-backed or local-worker capability as HTTP APIs
- adapts mismatched provider surfaces into shared northbound shapes
- keeps center/worker execution paths explicit

Rule of thumb:

- `provider` = capability source
- `shim` = protocol adapter
- `private-worker` = execution-side node for remote capability handoff

### 3. Vendored / Upstream Boundary Layer

This layer keeps source provenance and ownership honest.

Main areas:

- `vendor/sub2api`
- `providers/<provider>/upstream`

What it does:

- records which systems are still external in product terms
- allows selective source absorption without pretending runtime ownership is solved
- keeps license and provenance boundaries visible

Important point:

Source absorption and runtime ownership are different axes. A provider may have upstream source inside this repo and still operate as an external worker at runtime.

### 4. Runtime / Control Layer

This is the part that tends to disappear if the repo is described too abstractly.

Main areas:

- provider-local runtime status and admin surfaces
- browser profile management
- session locks and queue policies
- systemd units and host runtime layout
- center `/v1/jobs` flow plus worker registry routing

What it does:

- decides whether a provider is merely alive or actually usable
- binds browser profiles, locks, queue semantics, and runtime health into real operational behavior
- coordinates remote execution and local fallback

This repo is hard to understand if this layer is omitted. The real control plane is not only `sub2api`; it is the combination of shared packages, provider-local runtime logic, ops/runtime policy, and northbound registration boundaries.

## Provider Maturity Is Not Flat

`providers/` is an integration directory, not a promise that every entry has the same ownership level.

Current practical classes:

| Provider | Code position | Runtime ownership | Best description |
| --- | --- | --- | --- |
| `gpt-web-api` | repo-native | repo-owned browser runtime | browser-backed capability runtime |
| `canvas-to-api` | vendored upstream boundary | upstream browser worker still live | Gemini Web compatibility wrapper over the current canvas-share bridge |
| `qwen2api` | vendored upstream boundary | external account-pool runtime | lightweight text boundary |
| `ds-free-api` | vendored upstream boundary | external worker + generic shim | external worker plus shim |

## Runtime Tiers

The repo should not treat all provider runtimes as the same operational cost.

Recommended tiering:

### Tier 0. Lightweight Text

Use for ordinary text chat whenever possible.

Typical candidates:

- `qwen2api`
- `ds-free-api`
- future HTTP-native or token/account-pool text providers

### Tier 1. Browser-Backed Capability

Use when the value comes from a real logged-in browser capability, not just generic text.

Typical candidates:

- `gpt-web-api`
- `canvas-to-api`

Typical capabilities:

- image generation
- file upload / browser-native attachment flows
- browser-bound conversation continuity
- provider-specific research or tool flows

### Tier 2. Session / Login Maintenance

Use for keeping browser identities and login state alive.

Typical responsibilities:

- profile slots
- CDP attachment
- noVNC/manual takeover
- login-state import or repair

### Tier 3. Long-Running and Artifact-Heavy Jobs

Use for async or stateful workflows that should not be treated like cheap chat requests.

Typical capabilities:

- research jobs
- large file flows
- artifact-heavy image/media tasks
- remote worker execution through `/v1/jobs`

## GPT Line Versus The Others

The GPT line is already qualitatively different from the other providers.

`providers/gpt-web-api` is not only a wrapper. It is a repo-native runtime with:

- provider routing
- job records
- media indexing
- conversation/session affinity
- file staging
- browser runtime checks
- admin and health detail

By contrast:

- `canvas-to-api` should now be read as the current **Gemini Web provider surface**, but only through a compatibility wrapper over the current canvas-share bridge transport
- its live runtime is still primarily an upstream browser worker with repo-owned runtime inspection around it
- `qwen2api` is primarily an account-pool and direct-smoke integration boundary
- `ds-free-api` is primarily an external worker plus generic Responses normalization

That difference should stay explicit in docs and directory narrative.

## Gemini Narrative Boundary

The right conceptual framing is no longer "Canvas provider".

For this repo, the provider family is **Gemini Web**:

- the capability source is a logged-in Gemini web session
- the current live transport is the Canvas/share bridge path
- the local repo path stays `providers/canvas-to-api/` for compatibility

That means three things should remain true at once:

1. docs should describe the provider family as Gemini Web
2. `providers/canvas-to-api` should remain a compatibility wrapper layer for the current bridge transport
3. docs should not overclaim that the current runtime is already a fully generic Gemini Web runtime

So the current state is: Gemini Web provider family, current canvas-share bridge transport, compatibility path preserved.

## Reference Repos

Two external references matter conceptually:

### `sub2api`

`sub2api` is the northbound management-plane boundary for unified registration and routing.

It is not the whole control plane by itself.

### `xtekky/gpt4free`

`gpt4free` is useful as an architectural reference for:

- provider registry patterns
- model-to-provider indirection
- fallback / retry / rotation thinking
- keeping northbound request handling decoupled from specific upstreams

It is **not** a direct template for this repo's runtime model. `web-api` must additionally deal with:

- real browser sessions
- CDP/browser profile lifecycle
- session locks
- single-flight constraints
- host/runtime supervision

So the right move is to learn from its provider-abstraction ideas without flattening browser runtimes into a generic adapter zoo.
