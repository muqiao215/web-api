# Upstream Boundaries

`web-api` is a unification repo, not a claim that every runtime has already been absorbed into one native codebase.

Use this file to make that boundary explicit.

## How To Read This

- `owned here`
  The main implementation lives in this repo.
- `partially absorbed`
  The provider boundary lives here and a safe/licensed upstream source slice is vendored here, but the whole product has not been fully reworked into native repo ownership yet.
- `wrapped upstream`
  The real runtime still comes from another repo or binary, while this repo standardizes its API shape, health model, or deployment path.
- `consumer/source upstream`
  Not part of the core provider plane, but still referenced by the product.

## Control Plane

| Component | Status | Upstream |
| --- | --- | --- |
| `sub2api` | wrapped upstream | `https://github.com/Wei-Shaw/sub2api` |

## Provider Runtimes

| Local path in this repo | Status | Upstream |
| --- | --- | --- |
| `providers/gpt-web-api` | owned here | internal migrated code path in this repo |
| `providers/canvas-to-api` | partially absorbed | `https://github.com/iBUHub/CanvasToAPI` |
| `providers/qwen2api` | partially absorbed | `https://github.com/YuJunZhiXue/qwen2API` |
| `providers/ds-free-api` | partially absorbed | `https://github.com/NIyueeE/ds-free-api` |
| `providers/catgpt-gateway` | wrapped upstream | `https://github.com/GautamVhavle/CatGPT-Gateway` |

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

## Why Keep The Boundary Visible

This repo currently solves three different problems at once:

1. Standardizing provider health, queue state, and artifact contracts.
2. Normalizing mismatched upstream APIs into one management plane.
3. Gradually deciding which upstreams should stay external and which should be fully absorbed.

If that boundary is hidden, the repo reads like a messy half-migration. If it is explicit, the structure is easier to reason about:

- `packages/` is the reusable generic layer.
- `providers/` is the integration layer.
- `vendor/` plus listed upstream repos are the runtime boundary layer.

## Current Architectural Tension

Right now the repo is strongest as a **unified API orchestration layer**, not as a monolithic provider implementation repo.

That means the clean product statement is:

> `web-api` turns mixed browser/web/provider runtimes into a shared API management surface.

Not:

> `web-api` already fully re-implements every provider it references.

## Current Absorption Notes

- `providers/canvas-to-api`
  The upstream source is now vendored under `providers/canvas-to-api/upstream`, while browser identity slots, login state, share-link lifecycle, and runtime supervision still remain repo-level integration work.
- `providers/ds-free-api`
  The Apache-2.0 upstream worker source is now vendored under `providers/ds-free-api/upstream`, while local runtime ownership and shim registration still remain repo-level integration work.
- `providers/qwen2api`
  The upstream source is now vendored under `providers/qwen2api/upstream`, while local runtime ownership, account-pool lifecycle, and later repo-owned refactors still remain repo-level integration work.
