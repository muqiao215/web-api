# Task Plan: Productize Web Capability API with gpt2api Lessons

## Goal

Improve `web_capability_api` by absorbing the useful productized runtime patterns from `432539/gpt2api` while keeping the current multi-provider architecture integrated through `sub2api`.

## Current Phase

Phase 4

## Scope

This plan is for architecture and implementation sequencing only. It does not replace the current `sub2api -> provider/shim -> worker` architecture, and it does not propose cutting over live services without smoke checks.

## Non-Goals

- Do not replace `sub2api` with `gpt2api`.
- Do not force browser-profile-bound providers into Docker.
- Do not make GPT image generation the only first-class path.
- Do not build full SaaS billing before provider/runtime contracts are stable.
- Do not register a provider as healthy unless direct and `sub2api` smokes both pass.

## Phases

### Phase 1: Requirements & Discovery

- [x] Capture user intent: keep our larger integration architecture, imitate `gpt2api` strengths.
- [x] Capture existing local architecture and provider status.
- [x] Capture `gpt2api` strengths worth reusing.
- [x] Document findings in `findings.md`.
- **Status:** complete

### Phase 2: Contract Design

- [x] Extend `packages/provider_contracts` with schemas for account pool, proxy pool, image task, queue state, and audit event.
- [x] Define one internal image task state machine that can serve GPT, Gemini Canvas, DeepSeek, Qwen, and future providers.
- [x] Define a provider capability contract that distinguishes `api_surface_aligned`, `routed`, and `healthy` via `health_tier` field on `provider-capability.schema.json`.
- [x] Define artifact metadata contract shared by workers, bots, showcase sites, and admin surfaces (existing `artifact-record.schema.json` covers this; aligned with image-task via `artifact-output.schema.json` + `ARTIFACT_MAPPING.md`).
- **Status:** complete

#### Schema additions (Phase 2)

| Schema | Purpose |
|--------|---------|
| `image-task.schema.json` | Unified async image task state machine (queued/running/succeeded/failed/partial/cancelled) for all providers |
| `account-pool.schema.json` | Provider account/profile registry with lease, health, cooldown, and capability flags |
| `proxy-pool.schema.json` | Proxy metadata, health score, account binding, failure tracking (optional per provider) |
| `queue-state.schema.json` | Async task queue state with profile/global scope, capacity, and lease semantics |
| `audit-event.schema.json` | Audit event for admin actions, provider selections, route decisions, task lifecycle, artifact writes |
| `provider-capability.schema.json` | Added `health_tier: enum(api_surface_aligned, routed, healthy)` field |
| `artifact-output.schema.json` | Lightweight output item shape; bridges `image-task.outputs[]` and `artifact-record` lifecycle stages |
| `ARTIFACT_MAPPING.md` | Field-level mapping table: `artifact_id→id`, `mime→mime_type`, `width/height/sha256→metadata`, task-level context fields |

#### Artifact Alignment

- `image-task.outputs[]` items now reference `artifact-output.schema.json` via `$ref` (allOf composition).
- `artifact-record.metadata` now explicitly allows `width`, `height`, `sha256` (previously not present).
- `ARTIFACT_MAPPING.md` documents the conversion from `ImageTask.outputs[]` to `ArtifactRecord` including the rename rules and context-only fields.
- Tests: 22 total, all pass (added 5 new tests for artifact alignment).

#### Schema validation

- `packages/provider_contracts/test/schemas.test.mjs` — 17 tests, all pass (Node.js built-in test runner + ajv + ajv-formats)
- Run: `cd packages/provider_contracts && node --test test/schemas.test.mjs`

### Phase 3: Runtime Standardization

- [x] Add `packages/provider_contracts/validate_runtime.mjs` — normalization/validation script for jobs.json and media.json against new schemas.
- [x] Document jobs.json → image-task normalization gaps (artifact_id, width, height, sha256 not yet in write path).
- [x] Document media.json legacy format (object: "media", output_path) — normalized to ArtifactRecord before validation.
- [x] Add `account_id`, `profile_lock`, `lease` nullable fields to GPT worker admin health (`provider_admin_service.mjs`).
- [x] Close GPT provider write path: `generateImage()` in `browser_runtime.mjs` now returns `artifact_id`, `width`, `height`, `sha256` — aligned with image-task.outputs schema.
- [x] Migrate existing `jobs.json` historical records via `migrate_jobs_image_results.mjs` (deterministic artifact_id, SHA-256 computed from file, PNG/JPEG dimensions parsed from file header).
- [x] `validate_runtime.mjs` now exits 0 with all image-gen jobs fully validated against image-task schema.
- [ ] Align `providers/gpt-web-api/data/media.json` write path to full ArtifactRecord schema (Phase 4+).
- [ ] Add the same queue/profile-lock vocabulary to Gemini Canvas worker docs and future runtime wrappers.
- [ ] Keep provider-specific implementation details behind adapters.
- **Status:** complete

### Phase 4: Pooling & Scheduling Layer

- [x] Create `packages/provider_pool` for account/profile registry, health, cooldowns, and capability flags — aligned with account-pool.schema.json.
- [x] Create `packages/proxy_pool` for proxy registry with health scoring — aligned with proxy-pool.schema.json.
- [x] Create `packages/job_queue` for async image tasks, retries, aggregation, and restart-safe task state — aligned with queue-state.schema.json and image-task.schema.json.
- [x] Define queue lease semantics for browser-profile-bound workers so the same browser identity cannot be mutated concurrently.
- [x] Wire pool status into GPT provider admin service (`getProviderDetail`, `health`) — backward-compatible, optional, read-only.
- [ ] Add the same queue/profile-lock vocabulary to Gemini Canvas worker docs and future runtime wrappers.
- [ ] Keep provider-specific implementation details behind adapters.
- **Status:** complete

### Phase 5: Observability & Admin Surface

- [ ] Extend `packages/ops_doctor` to check account pool, queue depth, artifact writeability, latest task, and `sub2api` route status.
- [ ] Add `packages/audit_log` or a shared audit schema before building UI-heavy admin features.
- [ ] Expand `apps/control-workbench` into a lightweight control surface for provider health, queues, artifacts, and audit logs.
- [ ] Defer billing, payment, and public SaaS user management until task/artifact/account models are stable.
- **Status:** pending

### Phase 6: Verification & Cutover

- [ ] Add schema tests for all new provider contracts.
- [ ] Add direct worker smoke tests for GPT and one non-GPT provider.
- [ ] Add `sub2api` smoke checks for any routed provider before marking healthy.
- [ ] Document rollback paths for any systemd runtime cutover.
- [ ] Promote only verified builds/routes to stable consumer paths.
- **Status:** pending

## Key Questions

1. What should be the minimum common task model that works for both GPT Image and Gemini Canvas image generation?
2. Which runtime state belongs inside a provider worker, and which belongs in shared packages?
3. How much of `gpt2api`-style account/proxy scheduling should be generic now versus deferred until multiple GPT accounts are actually active?
4. What is the smallest `control-workbench` surface that improves operations without becoming a premature SaaS backend?

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Keep `sub2api` as the external API management plane | It already provides unified key/group/account/routing semantics and keeps consumers detached from provider-specific ports. |
| Treat `gpt2api` as a reference, not a replacement | Its product maturity is useful, but it is a GPT-image-focused single product rather than a multi-provider web capability platform. |
| Prioritize image task and artifact models first | GPT, Gemini Canvas, bots, prompt workflows, and showcase sites all need consistent async image/task metadata. |
| Add pool/proxy concepts as shared contracts before deep implementation | Avoids overfitting to one upstream while still preparing for multi-account and proxy scheduling. |
| Build lightweight control surfaces before billing | Operational clarity is needed now; SaaS monetization can wait until contracts and smokes are reliable. |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| None | 1 | No implementation errors in planning phase. |

## Current Dirty State Note

The repository already has unrelated prompt-library changes in `packages/prompt-factory/sources/manual_gpt_prompts.json`. Do not mix those with future runtime/productization implementation commits unless the user explicitly asks to commit all prompt work together.

## Deliverables

- `task_plan.md`: phased execution plan.
- `findings.md`: requirements, evidence, architectural findings, and decisions.
- `progress.md`: current planning progress and reboot state.

