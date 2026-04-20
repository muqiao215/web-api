# Progress Log

## Session: 2026-04-20

### Phase 1: Requirements & Discovery

- **Status:** complete
- **Started:** 2026-04-20
- Actions taken:
  - Captured user direction: keep our integration architecture and absorb `gpt2api` productization strengths.
  - Reviewed local `web_capability_api` architecture and provider status.
  - Reviewed `gpt2api` README and repository root structure.
  - Created persistent planning files in the project root.
- Files created/modified:
  - `task_plan.md` created.
  - `findings.md` created.
  - `progress.md` created.

### Phase 2: Contract Design

- **Status:** complete
- **Started:** 2026-04-20
- Actions taken:
  - Created 5 new JSON schemas under `packages/provider_contracts/schemas/`.
  - Updated `provider-capability.schema.json` to add `health_tier` enum field.
  - Fixed JSON Schema `anyOf` nullable format syntax across all new schemas.
  - Added `packages/provider_contracts/package.json` (private npm package manifest).
  - Added `packages/provider_contracts/test/schemas.test.mjs` with 17 tests covering all schemas and key variant cases.
  - Installed `ajv` and `ajv-formats` as dev dependencies.
  - All 17 tests pass.
- Files created/modified:
  - `packages/provider_contracts/schemas/image-task.schema.json` (new)
  - `packages/provider_contracts/schemas/account-pool.schema.json` (new)
  - `packages/provider_contracts/schemas/proxy-pool.schema.json` (new)
  - `packages/provider_contracts/schemas/queue-state.schema.json` (new)
  - `packages/provider_contracts/schemas/audit-event.schema.json` (new)
  - `packages/provider_contracts/schemas/provider-capability.schema.json` (updated — added `health_tier`)
  - `packages/provider_contracts/package.json` (new)
  - `packages/provider_contracts/test/schemas.test.mjs` (new)
  - `task_plan.md` (Phase 2 checklist updated)
  - `progress.md` (this entry)

### Phase 2 Follow-up: Artifact Metadata Alignment

- **Status:** complete
- **Actions taken:**
  - Identified field naming mismatches between `image-task.outputs[]` and `artifact-record`:
    - `artifact_id` vs `id`, `mime` vs `mime_type`, missing `width/height/sha256` in artifact-record top-level
  - Created `schemas/artifact-output.schema.json` as lightweight output item shape referenced by `image-task.outputs[]` via `$ref` (allOf composition).
  - Updated `image-task.schema.json` to add `$ref: artifact-output.schema.json` in `outputs.items` and description pointing to mapping doc.
  - Added `width`, `height`, `sha256` to `artifact-record.metadata.properties` so image-task dimensions are explicitly representable.
  - Created `schemas/ARTIFACT_MAPPING.md` with full field-level mapping table and conversion pseudocode.
  - Updated test runner: replaced lazy `loadSchema` with pre-register-by-$id strategy (Ajv v8 resolves $ref immediately at compile time).
  - Added 5 new tests (artifact-output validation, image-task $ref validation, artifact-record width/height/sha256 in metadata, conversion test).
  - All 22 tests pass.
- Files created/modified:
  - `packages/provider_contracts/schemas/artifact-output.schema.json` (new)
  - `packages/provider_contracts/schemas/ARTIFACT_MAPPING.md` (new)
  - `packages/provider_contracts/schemas/image-task.schema.json` (updated — added $ref to outputs, updated description)
  - `packages/provider_contracts/schemas/artifact-record.schema.json` (updated — added width/height/sha256 to metadata)
  - `packages/provider_contracts/test/schemas.test.mjs` (updated — 5 new tests, 22 total, pre-register strategy)
  - `task_plan.md` (artifact alignment note added to Phase 2)
  - `progress.md` (this entry)

### Phase 3: Runtime Standardization

- **Status:** complete
- **Started:** 2026-04-20
- **Completed:** 2026-04-20
- Actions taken:
  - Analyzed `jobs.json` (7 jobs, 3 images.generations) against image-task.schema.json.
  - Analyzed `media.json` (1 record) against artifact-record.schema.json.
  - Identified gaps: jobs.json lacks artifact_id/width/height/sha256 in result[] items (write path gap — Phase 4+); media.json is in legacy "media" format (pre-schema).
  - Created `packages/provider_contracts/validate_runtime.mjs` — normalization + validation script that:
    - Normalizes jobs.json image-gen result[] items to ImageTask.outputs[] shape before validation
    - Normalizes legacy media.json "media" format to ArtifactRecord format before validation
    - Reports known gaps with clear "KNOWN GAP" / "NORM GAP" labels
    - Exit code 0 when normalized, exit code 1 when non-normalized gaps found
  - Added `account_id`, `profile_lock`, `lease` nullable fields to `provider_admin_service.mjs` queueMetrics() and health() output (Phase 4 account pool fills these).
  - Added 2 new tests to `providers/gpt-web-api/test/provider_admin_service.test.mjs` for new admin health fields.
  - All 3 admin service tests pass; all 22 schema tests pass.
- Files created/modified:
  - `packages/provider_contracts/validate_runtime.mjs` (new — normalization/validation script)
  - `providers/gpt-web-api/services/provider_admin_service.mjs` (updated — added account_id/profile_lock/lease nullable fields)
  - `providers/gpt-web-api/test/provider_admin_service.test.mjs` (updated — 2 new tests for new admin health fields)
  - `task_plan.md` (Phase 3 checklist updated)
  - `progress.md` (this entry)

### Phase 3 Key Findings

| File | Finding | Action |
|------|---------|--------|
| `jobs.json` | `result[]` items have `output_path`/`mime_type` but no `artifact_id`, `width`, `height`, `sha256` | Closed: `generateImage()` in `browser_runtime.mjs` now computes and returns these fields; existing records migrated via `migrate_jobs_image_results.mjs` |
| `media.json` | Uses legacy `object: "media"` and `output_path` — pre-ArtifactRecord schema | Closed: `migrate_media_legacy_records.mjs` converts legacy records to artifact format (object:"artifact", local_path, contract_version, sha256/width/height computed from file). MediaStore already writes correct format for new records. |
| `provider_admin_service.mjs` | Missing `account_id`, `profile_lock`, `lease` fields in admin health output | Added as nullable (null) with Phase 4 comment |

### Phase 3 Write-Path Fix (Critical Follow-up)

- **Status:** complete
- **Completed:** 2026-04-20
- Actions taken:
  - Traced `generateImage()` in `browser_runtime.mjs` — found it returned only `{created, model, prompt, conversation_url, output_path, mime_type, image_url, alt}` without enrichment fields.
  - Added `sha256()` helper (Node.js built-in `crypto.createHash`, no external deps) and `readImageDimensions()` helper (PNG IHDR chunk parsing at bytes 16-23, JPEG SOF0/SOF2 marker scanning).
  - Updated `generateImage()` return to include `artifact_id`, `sha256`, `width`, `height` — all computed at write time when both `bytes.buffer` and `filepath` are available.
  - Created `packages/provider_contracts/migrate_jobs_image_results.mjs` — idempotent one-time migration for historical `jobs.json` image-gen records. Generates deterministic `artifact_id` from `result.created + output_path` path hash. Computes SHA-256 and dimensions from actual files on disk. Second run: "No migration needed."
  - Verified: `validate_runtime.mjs` now exits 0 with all 3 image-gen jobs fully validated.
- Files created/modified:
  - `providers/gpt-web-api/services/browser_runtime.mjs` (added sha256, readImageDimensions, enrichment in generateImage return)
  - `providers/gpt-web-api/data/jobs.json` (migrated in place — 1 image-gen job enriched with artifact_id/sha256/width/height)
  - `packages/provider_contracts/migrate_jobs_image_results.mjs` (new — idempotent migration script)
  - `task_plan.md` (Phase 3 write-path items marked complete)
  - `progress.md` (this entry)

### Phase 3 Media Historical Migration

- **Status:** complete
- **Completed:** 2026-04-20
- Actions taken:
  - Created `packages/provider_contracts/migrate_media_legacy_records.mjs` — idempotent migration for legacy `media.json` records.
  - Converts `object:"media"` → `object:"artifact"`, `output_path` → `local_path`, adds `contract_version: "wcapi.artifact.v1"`.
  - Computes `sha256`, `width`, `height` from actual image file on disk (same PNG/JPEG header parsing helpers as jobs migration).
  - Infers `mime_type` from file extension (`.png`→`image/png`, `.jpg`/`.jpeg`→`image/jpeg`, etc.).
  - Keeps original record ID to avoid ID churn; second run skips already-migrated records.
  - Verified: `validate_runtime.mjs` exits 0 (artifact-record schema: 1 valid, 0 invalid); `diagnose.mjs` reports `total=1 artifacts=1 legacy=0`.
- Files created/modified:
  - `packages/provider_contracts/migrate_media_legacy_records.mjs` (new — idempotent migration script)
  - `providers/gpt-web-api/data/media.json` (migrated in place — 1 legacy record converted to artifact format with sha256/width/height in metadata)
  - `task_plan.md` (Phase 3 media migration item marked complete)
  - `progress.md` (this entry)

### Phase 4: Pooling & Scheduling Layer

- **Status:** complete
- **Started:** 2026-04-20
- **Completed:** 2026-04-20
- Actions taken:
  - Created `packages/provider_pool`: account/profile registry with lease, health, cooldown, and selection primitives aligned with `account-pool.schema.json`.
  - Created `packages/proxy_pool`: proxy registry with health score (0-1), failure tracking, and cooldown aligned with `proxy-pool.schema.json`.
  - Created `packages/job_queue`: general async `JobQueue` + `ProfileSerialQueue` with lease semantics aligned with `queue-state.schema.json`.
  - `createProviderPool()`: `selectAccount()`, `acquireLease()`, `releaseLease()`, `recordUsage()`, `updateHealth()`, `tick()`, `toJSON()` for file-backed persistence.
  - `createProxyPool()`: `selectProxy()`, `recordSuccess()`, `recordFailure()`, `tick()`, `toJSON()` for file-backed persistence.
  - `createProfileSerialQueue()`: `acquireLease()`/`releaseLease()` per profile, `listQueueStates()` returning schema-aligned queue states.
  - Wired pool status into `provider_admin_service.mjs`: `getProviderDetail()` and `health()` now attach `account_pool` and `proxy_pool` summary objects when pools are provided (backward-compatible — pools are optional).
  - Added 1 new test to `provider_admin_service.test.mjs` verifying pool status is attached when pools are wired.
- Files created/modified:
  - `packages/provider_pool/src/index.mjs` (new)
  - `packages/provider_pool/package.json` (new)
  - `packages/provider_pool/test/index.test.mjs` (new — 13 tests)
  - `packages/proxy_pool/src/index.mjs` (new)
  - `packages/proxy_pool/package.json` (new)
  - `packages/proxy_pool/test/index.test.mjs` (new — 8 tests)
  - `packages/job_queue/src/index.mjs` (new)
  - `packages/job_queue/package.json` (new)
  - `packages/job_queue/test/index.test.mjs` (new — 11 tests)
  - `providers/gpt-web-api/services/provider_admin_service.mjs` (updated — pool wiring, backward-compatible)
  - `providers/gpt-web-api/test/provider_admin_service.test.mjs` (updated — +1 pool integration test)
  - `task_plan.md` (Phase 4 checklist updated)
  - `progress.md` (this entry)

### Phase 5: Observability & Admin Surface

- **Status:** partial — Phase 5A (ops_doctor + audit_log) and Phase 5B (control-workbench) complete; Phase 5C (control-workbench v2) complete; Phase 5D (diagnose.mjs jobs history) complete; Phase 5E (control-workbench normalizer enrichment) complete; billing/deferred items deferred.
- **Phase 5A:** ops_doctor extension + audit_log package.
- **Phase 5B:** control-workbench skeleton + canvas-to-api vocabulary alignment (completed in prior session).
- **Phase 5C:** control-workbench narrow expansion — sub2api fully wired into providers+summary, ops_doctor diagnostic layer added.
  - `normalizeSub2apiHealth` now exported and returns full ProviderSnapshot with health.version, health.uptime_s, runtime.providers_count, runtime.accounts_count.
  - sub2api now participates in `providers[]` and `buildSummary` counts by default (`includeSub2api` defaults to `true`; use `--no-sub2api` to opt out).
  - Error-state normalization for GPT and Canvas now adds a placeholder `{ status: "error" }` entry to providers array (previously only "unreachable" placeholder was added on fetch failure).
  - Added `opsDoctorPath` option to `createControlBench()` — when set, spawns `diagnose.mjs` subprocess and includes parsed checks in report under `opsDoctor` field.
  - `normalizeOpsDoctor(data)` normalizes the diagnose.mjs JSON output: `checks` map by name, `overall` = "fail"/"warn"/"ok".
  - CLI gains `--ops-doctor-path=<abs-path>` flag; exit code 1 also when `opsDoctor.overall === "fail"`.
  - All 32 tests pass (9 new tests added for sub2api + ops_doctor coverage).
- Phase 5A actions taken:
  - Created `packages/audit_log/src/index.mjs` — JSONL append-only audit logger factory (`createAuditLogger({ dataDir, validate, enrich })`). Writes one JSON object per line to `{dataDir}/audit.jsonl`. Auto-fills `contract_version`, `id`, `timestamp`, `actor.type` when `enrich=true`. `query({ event_type, actor_type, since, limit })` supports temporal and type filtering. `enrichEvent` now accepts `{ enrich }` option to allow validation of raw partials before auto-fill.
  - Created `packages/ops_doctor/src/diagnose.mjs` — Node.js diagnostic companion script called by Python CLI as subprocess. Checks: `output_dir_writable` (try-write test with timestamped temp file), `jobs_json` (summary counts), `media_json` (artifact/legacy summary), `provider_pool_data` (if pool data path provided), `proxy_pool_data` (if proxy data path provided). Outputs JSON with `{ checks, timestamp, repo_root }`; exit 1 on any FAIL.
  - Extended `packages/ops_doctor/src/web_capability_api_ops_doctor/cli.py` — added `gpt-provider-diagnostic` to `RUNTIME_COMMAND_CHECKS`; added `diagnose_result()` to parse nested check list from diagnostic JSON into individual `CheckResult` entries; routed diagnostic output to `diagnose_result()` instead of `runtime_status_to_result()`.
  - Added `checkPathWritability` to `provider_admin_service.mjs` — `health()` now includes `path_checks.output_dir` and `path_checks.upload_dir` when `checkPathWritability` function is provided.
  - Wired `checkPathWritability` into `providers/gpt-web-api/server.mjs` using timestamped test-file pattern.
- Phase 5A files created/modified:
  - `packages/audit_log/src/index.mjs` (new)
  - `packages/audit_log/test/index.test.mjs` (new — 13 tests)
  - `packages/ops_doctor/src/diagnose.mjs` (new)
  - `packages/ops_doctor/test/diagnose.test.mjs` (new — 7 tests)
  - `packages/ops_doctor/src/web_capability_api_ops_doctor/cli.py` (updated — diagnose integration)
  - `providers/gpt-web-api/services/provider_admin_service.mjs` (updated — checkPathWritability)
  - `providers/gpt-web-api/server.mjs` (updated — checkPathWritability wiring)
  - `task_plan.md` (Phase 5 checklist updated)
  - `progress.md` (this entry)
- Phase 5B (control-workbench) actions taken (prior session):
  - Created `apps/control-workbench/src/index.mjs` — read-only control surface that aggregates state from GPT admin service and canvas-to-api via HTTP. Exports `createControlBench()`, `normalizeGptHealth()`, `normalizeCanvasHealth()`, `buildSummary()`, and CLI `main()`. Aligns with `provider-capability.schema.json` and `queue-state.schema.json` vocabulary.
  - Updated `providers/canvas-to-api/runtime_status.mjs` — added `runtime_contract` field (status_schema, artifact_schema, queue_scope) aligned with `provider-capability.schema.json`; migrated `queue.pending/running/locks_active` to nested `queue.depth.{pending,running,completed,failed}` structure aligned with `queue-state.schema.json`; same migration applied to per-profile `inspectProfile()` queue blocks.
  - Fixed `buildSummary()` overall rollup: `degraded` is no longer counted as "healthy" — priority ordering is now unreachable > error > blocked > degraded > mixed > ok.
  - Added 23 unit tests for control-workbench (normalizeGptHealth, normalizeCanvasHealth, buildSummary coverage).
- Phase 5B files created/modified:
  - `apps/control-workbench/src/index.mjs` (new)
  - `apps/control-workbench/package.json` (updated — added main, exports, engines)
  - `apps/control-workbench/test/index.test.mjs` (new — 23 tests)
  - `providers/canvas-to-api/runtime_status.mjs` (updated — runtime_contract, queue.depth structure)
- Phase 5C (control-workbench narrow expansion — this session):
  - `apps/control-workbench/src/index.mjs` (updated — v2: sub2api fully wired, ops_doctor integration, error-state placeholders)
  - `apps/control-workbench/test/index.test.mjs` (updated — 9 new tests, 32 total: normalizeSub2apiHealth 3, normalizeOpsDoctor 6)
- Phase 5D: GPT jobs history diagnostic classification (this session):
  - Root cause: `jobs_json` WARN triggered by 2 historical failed image jobs (finished_at set, from 2026-04-19) even though they represent old timeouts, not current operational problems.
  - Fix: `summarizeJobs()` now separates active (pending/running) from historical (completed) jobs. Health check only evaluates active jobs. Historical failures are reported separately in detail string without triggering WARN.
  - Before: `jobs_json` WARN (2 failed > 3/2 threshold, all treated equally)
  - After: `jobs_json` OK (active=0, historical=7, 2 historical failures visible in detail but do not affect health)
- Phase 5E: control-workbench normalizer enrichment (this session):
  - `normalizeGptHealth` now preserves all fields from the rich GPT /health `runtime_contract` object:
    - `health.service_alive`, `health.logged_in`, `health.cdp_ready`, `health.blocked_by` (from `runtime_contract.*`)
    - `health.browserConnected` prefers `runtime_contract.browser_connected` over top-level `raw.browserConnected`
    - `runtime.provider_count`, `runtime.providers[]` (id, type, capabilities, models)
    - `runtime.capabilities` (from `runtime_contract.capabilities`)
    - `runtime.jobs_path`, `runtime.session_affinity_path`, `runtime.image_output_dir`, `runtime.upload_dir`, `runtime.media_index_path`
  - `normalizeCanvasHealth` now auto-detects thin vs rich response (presence of `contract_version` field)
    - Thin /health: `{"browserConnected":false,"status":"ok","timestamp":"..."}` — handled gracefully with nulls for rich fields
    - Rich runtime_status: full profile, queue, and capability data preserved
  - Added `canvasRuntimeScriptPath` option to `createControlBench()` — spawns `runtime_status.mjs` subprocess (same ops_doctor pattern) to get rich canvas data without requiring HTTP auth
  - Added `runCanvasRuntimeStatus(scriptPath)` helper — mirrors `runOpsDoctor` pattern
  - CLI gains `--canvas-runtime-script-path=<path>` flag
  - `printText` updated to display new fields (capabilities, provider_count, upstream_status, blocked_by, service_alive, etc.)
  - All 38 tests pass (6 new tests for runtime_contract enrichment and canvas thin/rich auto-detection)
- Deferred:
  - Billing, payment, SaaS user management.

### Phase 6: Verification & Cutover

- **Status:** pending
- Actions taken:
  - Not started.
- Files created/modified:
  - None yet.

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Planning file creation | `task_plan.md`, `findings.md`, `progress.md` | Files exist with concrete plan content | All three files created and content verified by `test -s` and keyword checks | pass |
| Phase 2 schema validation | `packages/provider_contracts/test/schemas.test.mjs` | All 17 tests pass | All 17 tests pass (original Phase 2 schemas) | pass |
| Phase 2 artifact alignment | `packages/provider_contracts/test/schemas.test.mjs` | All 22 tests pass | All 22 tests pass (added 5 tests: artifact-output basic+full, image-task $ref, artifact-record width/height/sha256 in metadata, conversion test) | pass |
| Phase 3 schema suite | `packages/provider_contracts/test/schemas.test.mjs` | All 22 pass | All 22 pass | pass |
| Phase 3 admin health | `providers/gpt-web-api/test/provider_admin_service.test.mjs` | All 4 pass (including pool integration test) | All 4 pass | pass |
| Phase 3 runtime validation | `packages/provider_contracts/validate_runtime.mjs` | Exit 0 (all valid) | Exit 0 with all 3 image-gen jobs fully validated (write-path fix complete) | pass |
| Phase 3 migration script | `packages/provider_contracts/migrate_jobs_image_results.mjs` | Idempotent; second run "No migration needed" | Ran twice — second run exits 0 with "No migration needed" | pass |
| Phase 3 media migration | `packages/provider_contracts/migrate_media_legacy_records.mjs` | Migrate 1 legacy record; validate_runtime.mjs exit 0; diagnose.mjs reports legacy=0 | Migrated 1 record (object:"media"→"artifact", sha256/width/height computed); validate_runtime.mjs exit 0; diagnose.mjs: total=1 artifacts=1 legacy=0 | pass |
| Phase 4 provider_pool | `packages/provider_pool/test/index.test.mjs` | All 13 pass | All 13 pass | pass |
| Phase 4 proxy_pool | `packages/proxy_pool/test/index.test.mjs` | All 8 pass | All 8 pass | pass |
| Phase 4 job_queue | `packages/job_queue/test/index.test.mjs` | All 11 pass | All 11 pass | pass |
| Phase 5A audit_log | `packages/audit_log/test/index.test.mjs` | All 13 pass | All 13 pass (validateEvent 4, log/list/query 7, throws on invalid 2) | pass |
| Phase 5A diagnose.mjs | `packages/ops_doctor/test/diagnose.test.mjs` | All 7 pass | All 7 pass (exit 0, output_dir_writable, jobs_json, media_json, --jobs override, JSON-only, repo_root) | pass |
| Phase 5B control-workbench | `apps/control-workbench/test/index.test.mjs` | All 23 pass | All 23 pass (normalizeGptHealth 6, normalizeCanvasHealth 7, buildSummary 10) | pass |
| Phase 5C control-workbench v2 | `apps/control-workbench/test/index.test.mjs` | All 32 pass | All 32 pass (added 9: normalizeSub2apiHealth 3, normalizeOpsDoctor 6) | pass |
| Phase 5E control-workbench v3 enrichment | `apps/control-workbench/test/index.test.mjs` | All 38 pass | All 38 pass (added 6: GPT runtime_contract fields 4, canvas thin/rich auto-detect 2) | pass |
| Phase 5D ops_doctor historical vs active | `packages/ops_doctor/test/diagnose.test.mjs` | All 11 pass | All 11 pass (4 new: historical failures OK, active running OK, active queued OK, mixed only active affects health) | pass |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-04-20 | None | 1 | No planning errors so far. |
| 2026-04-20 Phase 2 | JSON Schema syntax: `type: ["string", "format": "date-time", "null"]` is invalid (format cannot be inside union type array) | 1 | Fixed to `anyOf: [{ type: "string", format: "date-time" }, { type: "null" }]` in all affected schemas (image-task, account-pool, proxy-pool, queue-state) |
| 2026-04-20 Phase 2 | Ajv duplicate schema registration when pre-adding then compiling | 1 | Moved to lazy `loadSchema` callback; all schemas registered lazily on first $ref encounter |
| 2026-04-20 Phase 2 | `fileURLToPath` path.join issue with URL objects | 1 | Added explicit `fileURLToPath` + `path.join` for `import.meta.url` in test runner |
| 2026-04-20 Follow-up | Ajv MissingRefError: `$ref: artifact-output.schema.json` not resolved via lazy loadSchema | 1 | Replaced lazy `loadSchema` strategy with pre-register-all-by-$id: load all schemas first, `ajv.addSchema()` each by its `$id`, then compile — Ajv v8 resolves `$ref` immediately at compile time, not lazily |
| 2026-04-20 Follow-up | JSON Schema `$ref` inside `allOf` with `additionalProperties: true` | 1 | Validated: `allOf: [{ $ref: "artifact-output.schema.json" }, { type: "object", properties: {...} }]` + `additionalProperties: true` on parent — composition works correctly; outputs items pass both the ref and the inline property constraints |
| 2026-04-20 Phase 3 | `validate_runtime.mjs`: `result` referenced instead of `job.result` in normalizeJobToImageTask | 1 | Fixed to `job.result` |
| 2026-04-20 Phase 3 | `validate_runtime.mjs`: typo `normNormalizedRecord` instead of `normalizedRecord` in media validation | 1 | Fixed variable name |
| 2026-04-20 Phase 3 Write-Path | `generateImage()` in `browser_runtime.mjs` missing artifact_id, width, height, sha256 | 1 | Added sha256(), readImageDimensions() helpers; updated generateImage() return with enrichment fields |
| 2026-04-20 Phase 4 | ESM packages used `require("node:fs")` instead of `import` | 1 | Replaced with top-level `import fs from "node:fs"` and `import path from "node:path"` in all three packages |
| 2026-04-20 Phase 4 | job_queue stats test checked `summary.completed` but summary has `succeeded` | 1 | Fixed test to check `summary.succeeded`; `completed` exists only in per-profile depth tracking |
| 2026-04-20 Phase 4 | provider_admin_service pool accessor used `getPoolPolicy()?.provider` (pool policy has no provider field) | 1 | Added `getProvider()` method to provider_pool and proxy_pool; updated admin service to use it |
| 2026-04-20 Phase 5B | buildSummary: `degraded` was counted as "healthy" via `totalHealthy = ok+degraded` — `[ok, degraded]` reported overall="ok" | 1 | Changed `buildSummary` to use strict priority ordering: unreachable > error > blocked > degraded > mixed > ok; updated two tests to match corrected logic |
| 2026-04-20 Phase 5B | normalizeCanvasHealth read `raw.queue.pending` after canvas-to-api was updated to use `queue.depth.pending` | 1 | Updated normalizeCanvasHealth to read `raw.queue.depth.pending` and `raw.queue.depth.running` to match the new canvas-to-api vocabulary |
| 2026-04-20 Phase 5A | diagnose test: all 7 tests failing with "Could not find test/diagnose.test.mjs" | 1 | Root cause: `import.meta.dirname` equals CWD at invocation, not test file's directory. DIAGNOSE path resolved via `new URL("src/diagnose.mjs", import.meta.url)` gave wrong path. Fix: use `path.dirname(fileURLToPath(import.meta.url))` for reliable test-file-relative path resolution. |
| 2026-04-20 Phase 5A | audit_log test 10: query(since) returned 2 events instead of 1 | 1 | Root cause: evt_new's auto-filled timestamp (now) satisfies `>= before`, same as evt_old's explicit timestamp (before). Fix: capture evt_new's actual timestamp from log() return value and use it as `since` filter so only evt_new (timestamp=now) satisfies `>= now`. |
| 2026-04-20 Phase 5A | audit_log test 11: "Missing expected exception" — enrich=true auto-filled id/event_type/actor before validation | 1 | Root cause: `enrichEvent()` always auto-filled missing required fields regardless of `enrich` flag. Fix: refactored `enrichEvent(event, { enrich })` to accept enrich option; when `enrich=false` it returns raw event with contract_version only. Test passes `enrich: false` to createAuditLogger. |
| 2026-04-20 Phase 5A | audit_log test 11 follow-up: enrichEvent still auto-filled even after adding { enrich } param | 1 | log() called `enrichEvent(partial)` without passing the `enrich` flag. Fixed: `enrichEvent(partial, { enrich })` now passes the flag through. |
| 2026-04-20 Phase 5E | normalizeGptHealth test "service_alive=false to status=blocked" failing | 1 | Root cause: old code checked `raw.service_alive` (flat), but real GPT /health has `service_alive` inside `runtime_contract`. Fix: check `rc.service_alive ?? raw.service_alive` — prefers nested (real data), falls back to flat (test fixture compatibility). |
| 2026-04-20 Phase 5A | audit_log test 11: "Missing expected exception" — enrich=true auto-filled id/event_type/actor before validation | 1 | Root cause: `enrichEvent()` always auto-filled missing required fields regardless of `enrich` flag. Fix: refactored `enrichEvent(event, { enrich })` to accept enrich option; when `enrich=false` it returns raw event with contract_version only. Test passes `enrich: false` to createAuditLogger. |
| 2026-04-20 Phase 5A | audit_log test 11 follow-up: enrichEvent still auto-filled even after adding { enrich } param | 1 | log() called `enrichEvent(partial)` without passing the `enrich` flag. Fixed: `enrichEvent(partial, { enrich })` now passes the flag through. |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 5A complete (ops_doctor + audit_log, 20 tests); Phase 5B complete (control-workbench 23 tests); Phase 5C complete (control-workbench v2, 32 tests); Phase 5D complete (diagnose.mjs jobs history, 11 tests); Phase 5E complete (control-workbench normalizer enrichment, 38 tests). All Phase 1-5E done; Phase 6 (verification/cutover) pending. |
| Where am I going? | Phase 5 builds observability & admin surface (ops_doctor, audit_log, control-workbench). |
| What's the goal? | Productize `web_capability_api` using `gpt2api` strengths while keeping `sub2api` integration architecture. |
| What have I learned? | See `findings.md`. |
| What have I done? | Created the persistent plan/finding/progress files. |
