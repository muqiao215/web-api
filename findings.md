# Findings & Decisions

## Requirements

- Preserve the current larger architecture: multiple local/browser/API providers integrate into `sub2api`.
- Use `gpt2api` as a productization reference, not as a replacement.
- Absorb four specific strengths:
  - account pool, proxy pool, and scheduler integration
  - mature image task model with async, batch, and aggregate results
  - admin and audit completeness
  - clearer OpenAI-compatible external API shape
- Clean up our interface layer so provider APIs feel less scattered.
- Keep deployment pragmatic and non-container-first for browser-profile-bound services.

## Existing Local Architecture Findings

- `web_capability_api` defines the core direction as:
  `logged-in browser / local worker / upstream API -> provider API -> protocol shim -> sub2api -> consumers`.
- `sub2api` is the API management plane and should remain the external entry.
- Current confirmed local roles include:
  - `sub2api-local.service` on `127.0.0.1:18080`
  - `gpt-web-api.service` on `127.0.0.1:4242`
  - `gpt-web-responses-shim.service` on `127.0.0.1:4252`
  - `canvas-to-api.service` on `127.0.0.1:7861`
  - `ds-free-responses-shim.service` on `127.0.0.1:5327`
- Existing provider status rules already say a provider is healthy only after direct worker, Responses/shim, `sub2api` account test, and downstream smoke all pass.
- GPT runtime has been migrated into this repo and cut over to systemd.
- Prompt factory is already part of this repo and should remain part of the control/runtime surface.

## gpt2api Findings

- Repository: `https://github.com/432539/gpt2api`
- `gpt2api` positions itself as a ChatGPT-to-OpenAI-compatible SaaS gateway.
- It is strongest around GPT image generation, especially `gpt-image-2` / IMG2 paths.
- It includes:
  - ChatGPT account pool
  - proxy pool
  - scheduler with Redis locks, cooldowns, account lease, and usage thresholds
  - OpenAI-style `/v1/images/generations`, `/v1/images/edits`, `/v1/images/tasks/:id`, `/v1/models`
  - admin backend, user keys, quotas, billing, audit, backups
  - image signed proxy and task aggregation
- Its README says current versions focus on image models; chat completion code exists but UI is disabled due to instability around `chatgpt.com` sentinel protocol.
- It is Go + Vue + MySQL + Redis + Docker Compose.

## Comparison

| Area | gpt2api | web_capability_api |
|------|---------|--------------------|
| Product shape | GPT image SaaS gateway | Multi-provider web capability API platform |
| Management plane | Built-in admin/billing/key system | `sub2api` as unified external management plane |
| Provider breadth | ChatGPT-focused | GPT, Gemini Canvas, DeepSeek, Qwen, future workers |
| Runtime style | Reverse-engineered ChatGPT protocol | Browser-session-backed workers plus shims |
| Deployment | Docker Compose first | Systemd/non-container first for browser-profile services |
| Strongest reusable idea | Productized task/account/proxy/audit model | Better integration architecture |

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Do not vendor `gpt2api` as the main runtime now | It would duplicate `sub2api` and narrow the project around GPT images. |
| Model its scheduling concepts as shared packages/contracts | Lets GPT, Gemini, and future providers use one vocabulary without copying a single-provider design. |
| Keep OpenAI compatibility at the integration boundary | Consumers and `sub2api` should see stable OpenAI-like APIs even if workers use different private APIs internally. |
| Standardize image task metadata before expanding UI | Task/artifact consistency unblocks bots, showcase sites, batch jobs, and future admin UI. |
| Treat proxy pool as optional capability | Some providers need proxies, some browser-profile workers may not; the contract should support but not require it. |

## Phase 2 Implementation Notes

The following schema design rules were applied:
- All schemas use JSON Schema draft/2020-12 (`$schema`, `$id`, `title` required).
- Nullable date-time fields use `anyOf: [{ type: "string", format: "date-time" }, { type: "null" }]` — not `type: ["string", "format": "date-time", "null"]` (format cannot appear inside a union type array).
- `additionalProperties: true` on all objects to allow forward extension without breaking existing consumers.
- Cross-schema `$ref` between `browser-worker-runtime.schema.json` and `runtime-health.schema.json` uses the base filename as the relative reference; Ajv's `loadSchema` callback resolves it.
- `proxy_pool` and `proxy_bindings` are optional in contracts — browser-profile workers may not use proxies.

## Proposed Shared Packages

| Package | Responsibility |
|---------|----------------|
| `packages/provider_contracts` | JSON schemas for provider capability, account state, queue state, image task, artifact, audit event. |
| `packages/provider_pool` | Account/profile registry, capability flags, health, cooldown, lease state. |
| `packages/proxy_pool` | Proxy metadata, health score, binding to provider accounts, failure tracking. |
| `packages/job_queue` | Async tasks, retries, aggregation, status transitions, restart-safe task records. |
| `packages/audit_log` | Admin actions, provider selections, route decisions, prompt/source trace, artifact writes. |
| `packages/provider_artifacts` | Shared image/file artifact metadata and access helpers. |

## Proposed Interface Shape

Internal provider/shim surfaces should converge toward:

```text
GET  /healthz
GET  /readyz
GET  /v1/models
GET  /v1/providers
GET  /v1/providers/:id
POST /v1/responses
POST /v1/chat/completions
POST /v1/images/generations
POST /v1/images/edits
POST /v1/images/tasks
GET  /v1/images/tasks/:id
GET  /v1/artifacts/:id
GET  /admin/providers
GET  /admin/jobs
GET  /admin/audit
```

Not every provider needs to implement every endpoint directly. Shims/adapters can expose the common shape over narrower workers.

## Proposed Image Task State

```json
{
  "id": "imgtask_xxx",
  "provider": "gpt-web",
  "model": "gpt-image-2",
  "status": "queued|running|succeeded|failed|partial|cancelled",
  "prompt": "...",
  "n": 4,
  "size": "1024x1024",
  "input_images": [],
  "outputs": [
    {
      "artifact_id": "art_xxx",
      "url": "/v1/artifacts/art_xxx",
      "mime": "image/png",
      "width": 1024,
      "height": 1024,
      "sha256": "..."
    }
  ],
  "attempts": 1,
  "account_id": "gpt-profile-a",
  "profile_lock": "gpt-web-default",
  "created_at": "...",
  "updated_at": "...",
  "error": null
}
```

## Risks

- Copying too much from `gpt2api` could duplicate or conflict with `sub2api`.
- Over-building a SaaS backend too early would delay the more urgent interface cleanup.
- Browser-profile workers need profile locks and manual login rescue paths; a generic scheduler must not ignore that.
- Provider health must remain evidence-based; a matching API surface is not enough.
- Mixing prompt-library commits with runtime productization commits will make review and rollback harder.

## Resources

- `gpt2api`: `https://github.com/432539/gpt2api`
- Local architecture: `README.md`
- Provider matrix: `ops/provider-status.md`
- GPT worker docs: `providers/gpt-web-api/README.md`
- GPT Responses shim docs: `shims/gpt-web-responses/README.md`
- Existing contracts: `packages/provider_contracts/schemas/`
- Existing artifact package: `packages/provider_artifacts/README.md`
- Existing doctor package: `packages/ops_doctor/README.md`
- Existing control workbench: `apps/control-workbench/README.md`

## Visual/Browser Findings

- No screenshots were used for this plan.

