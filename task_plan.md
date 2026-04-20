# Task Plan: Productize Web Capability API with gpt2api Lessons

## Goal

Improve `web_capability_api` by absorbing the useful productized runtime patterns from `432539/gpt2api` while keeping the current multi-provider architecture integrated through `sub2api`.

## Current Phase

Phase 5E

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
- [x] Migrate existing `media.json` historical records via `migrate_media_legacy_records.mjs` (converts `object:"media"`→`"artifact"`, `output_path`→`local_path`, computes sha256/width/height from file, infers mime_type from extension; idempotent).
- [ ] MediaStore (`providers/gpt-web-api/lib/media_store.mjs`) already writes new records in correct artifact format — no write-path change needed.
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

- [x] Extend `packages/ops_doctor` to check account pool, queue depth, artifact writeability, latest task, and `sub2api` route status. *(Phase 5A)*
- [x] Add `packages/audit_log` — JSONL append-only audit logger aligned with `audit-event.schema.json`. *(Phase 5A)*
- [x] Expand `apps/control-workbench` into a lightweight control surface for provider health, queues, artifacts, and audit logs. *(Phase 5B: skeleton + 23 tests)*
- [x] Extend control-workbench to fully wire sub2api into providers+summary (default on), add ops_doctor diagnostic layer via subprocess. *(Phase 5C: v2 + 9 new tests)*
- [x] Fix `diagnose.mjs` `jobs_json` check to distinguish active (pending/running) from historical (completed) failures — historical failures no longer trigger misleading WARN. *(Phase 5D: 4 new tests)*
- [x] Enrich control-workbench normalizers: GPT now preserves `runtime_contract` fields (service_alive, logged_in, cdp_ready, blocked_by, capabilities), `providers[]` with capabilities/models, and file paths; canvas gains `runtime_status.mjs` subprocess integration (same ops_doctor pattern) for rich profile+queue data; canvas thin /health auto-detected and handled gracefully. *(Phase 5E: read-only enrichment + 6 new tests, 38 total)*
- [ ] Defer billing, payment, and public SaaS user management until task/artifact/account models are stable.
- **Status:** partial — Phase 5A (ops_doctor + audit_log) and Phase 5B (control-workbench) complete; Phase 5C (control-workbench v2) complete; Phase 5D (diagnose.mjs jobs history) complete; Phase 5E (control-workbench normalizer enrichment) complete; billing/deferred items deferred.

### Phase 6: Verification & Cutover

- [x] Add schema tests for all new provider contracts (22 tests covering 11 schemas — done in Phase 2).
- [x] Add direct worker smoke tests for GPT provider (3 new tests in `provider_admin_service.test.mjs`: runtime_contract shape validation, browser failure mapping, model capability metadata).
- [x] Add `sub2api` smoke checks via `phase6_verify.mjs` (HTTP reachability + health shape validation).
- [x] Add gpt-web-responses shim smoke tests (3 new tests: /health, /healthz, /v1/chat/completions routing).
- [x] Document canvas runtime_status.mjs blocker: `systemctl is-active` calls on 3 systemd units violate "do not touch live systemd services" constraint — detected by source analysis in `phase6_verify.mjs` without running the script.
- [ ] Document rollback paths for any systemd runtime cutover (deferred — systemd runtime cutover not planned yet).
- [ ] Promote only verified builds/routes to stable consumer paths (deferred — requires verified runtime first).
- **Status:** in-progress — Phase 6 verification slice complete; sub2api shape discrepancy noted; canvas blocker documented; rollback/cutover deferred.

#### Phase 6 Known Discrepancies

| Item | Detail | Action |
|------|--------|--------|
| sub2api /health shape | Running sub2api returns `{"status": "ok"}` — different from control-workbench's expected `normalizeSub2apiHealth` shape (`ok`, `version`, `providers`). Keys observed: `["status"]` | Documented in `phase6_verify.mjs` evidence output; control-workbench `normalizeSub2apiHealth` needs alignment with actual sub2api shape — deferred to when sub2api config is managed |
| Canvas systemd blocker | `runtime_status.mjs` calls `systemctl is-active` on 3 units — BLOCKED by constraint | Fix: extract read-only CDP checks into a separate no-systemd script, or use canvas-to-api HTTP /health (thin endpoint) as smoke entry point |

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

