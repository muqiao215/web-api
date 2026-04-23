# Upstream Boundaries

`web-api` is a unification repo, not a claim that every runtime has already been absorbed into one native codebase.

Use this file to make that boundary explicit.

## How To Read This

Read each component on two axes:

- `code position`
  Where the source currently lives.
- `runtime ownership`
  Who really owns the live runtime behavior today.

Those two axes are intentionally separate. A provider may have upstream source inside this repo and still operate as an external worker at runtime.

### Code Position

- `repo-native`
  The main implementation lives here.
- `vendored boundary`
  Upstream source is placed here for integration purposes, but repo-native ownership is incomplete.
- `external upstream`
  The runtime/source still primarily lives elsewhere.

### Runtime Ownership

- `repo-owned runtime`
  Main runtime behavior is implemented and supervised here.
- `runtime-status bridge`
  Repo adds inspection and control-plane boundary, but upstream runtime still does the real work.
- `lightweight text boundary`
  Repo integrates a lighter text/runtime path, usually account-pool or token driven.
- `external worker + shim`
  External worker does the job, and this repo mainly standardizes the northbound surface.
- `management-plane boundary`
  External control plane or registry boundary that this repo integrates with.

## Control Plane

| Component | Code position | Runtime ownership | Upstream |
| --- | --- | --- | --- |
| `sub2api` | external upstream | management-plane boundary | `https://github.com/Wei-Shaw/sub2api` |

## Provider Runtimes

| Local path in this repo | Code position | Runtime ownership | Upstream | Notes |
| --- | --- | --- | --- | --- |
| `providers/gpt-web-api` | repo-native | repo-owned runtime | internal migrated code path in this repo | Browser-backed capability runtime for ChatGPT-specific features |
| `providers/canvas-to-api` | vendored boundary | runtime-status bridge | `https://github.com/iBUHub/CanvasToAPI` | Gemini Web compatibility wrapper; upstream browser worker still does the real generation path through the current canvas-share bridge |
| `providers/qwen2api` | vendored boundary | lightweight text boundary | `https://github.com/YuJunZhiXue/qwen2API` | Account-pool driven text path; do not treat as healthy without non-empty pool and direct content smoke |
| `providers/ds-free-api` | vendored boundary | external worker + shim | `https://github.com/NIyueeE/ds-free-api` | Real runtime is still the worker on `5317`, normalized northbound through generic Responses shim |
| `providers/catgpt-gateway` | external upstream | external worker + shim | `https://github.com/GautamVhavle/CatGPT-Gateway` | Wrapped boundary only |

## Protocol Shims

| Local path in this repo | Status | Notes |
| --- | --- | --- |
| `shims/gpt-web-responses` | owned here | Adapts the local GPT web provider to a Responses-style surface |
| `shims/chat-responses` | owned here | Generic chat-completions to Responses adapter |

## Prompt / Asset Sources

These are not provider runtimes, but they are still upstream dependencies of the broader product line.

| Local area | Status | Upstream |
| --- | --- | --- |
| `packages/prompt-factory` | owned here with external sources | `https://github.com/YouMind-OpenLab/ai-image-prompts-skill` |
| `packages/prompt-factory` | consumer/source upstream | `https://github.com/Toloka/BestPrompts` |
| `packages/prompt-factory` | consumer/source upstream | `https://github.com/Dalabad/stable-diffusion-prompt-templates` |
| `packages/prompt-factory` | consumer/source upstream | `https://github.com/HoppyCat/prompt-pack` |
| `packages/prompt-factory` | consumer/source upstream | `https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts` |

## Architectural References

These repos influence architecture thinking without necessarily being upstream runtime dependencies.

| Reference | Why it matters | Adoption stance |
| --- | --- | --- |
| `https://github.com/xtekky/gpt4free` | Good reference for provider registry, model/provider indirection, fallback, and request/provider decoupling | Architectural reference only; do not flatten browser runtimes into a generic adapter zoo |
| `https://github.com/Wei-Shaw/sub2api` | Defines the intended management-plane boundary | Integrated as external management-plane boundary |

## Why Keep The Boundary Visible

This repo currently solves four different problems at once:

1. Standardizing provider health, queue state, and artifact contracts.
2. Normalizing mismatched upstream APIs into one management plane.
3. Gradually deciding which upstreams should stay external and which should be fully absorbed.
4. Owning real runtime behavior such as browser sessions, profile slots, locks, queue policy, and remote worker execution.

If that boundary is hidden, the repo reads like a messy half-migration. If it is explicit, the structure is easier to reason about:

- `packages/` is the reusable generic layer.
- `providers/` is the integration layer.
- `vendor/` plus `providers/*/upstream` are the source/runtime boundary layer.
- provider-local runtime status, systemd ownership, and `/v1/jobs` routing form the runtime/control layer.

## Current Architectural Tension

Right now the repo is strongest as a **unified control layer**, not as a monolithic provider implementation repo.

That means the clean product statement is:

> `web-api` turns mixed browser sessions and local/provider runtimes into a shared API management surface.

Not:

> `web-api` already fully re-implements every provider it references.

## Current Absorption Notes

- `providers/canvas-to-api`
  The upstream source is vendored under `providers/canvas-to-api/upstream`, but the live shape is still a runtime-status bridge around an upstream browser worker. Conceptually this belongs to the Gemini Web provider family; operationally it is still the current canvas-share bridge path. Browser identity slots, login state, share-link lifecycle, and runtime supervision remain repo-level integration work.
- `providers/ds-free-api`
  The Apache-2.0 upstream worker source is vendored under `providers/ds-free-api/upstream`, but the operational shape remains `worker -> generic chat-responses shim`. Service ownership, env/config normalization, and health gates matter more than rewriting the Rust worker first.
- `providers/qwen2api`
  The upstream source is vendored under `providers/qwen2api/upstream`, but the practical integration story is still an account-pool and direct-smoke boundary. It should evolve as a lightweight text provider path rather than being mistaken for a fully repo-owned runtime.
- `providers/gpt-web-api`
  This is already the clearest repo-native runtime. It owns browser-backed provider behavior, queue state, files/media, conversations, and provider/admin surfaces inside the repo rather than merely describing an upstream boundary.
