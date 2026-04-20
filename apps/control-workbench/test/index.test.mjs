import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGptHealth,
  normalizeCanvasHealth,
  normalizeSub2apiHealth,
  normalizeOpsDoctor,
  buildSummary,
  CONTROL_WORKBENCH_VERSION,
} from "../src/index.mjs";

// ─── CONTROL_WORKBENCH_VERSION ────────────────────────────────────────────────

test("exports CONTROL_WORKBENCH_VERSION as wcapi.control-workbench.v2", () => {
  assert.equal(typeof CONTROL_WORKBENCH_VERSION, "string");
  assert.equal(CONTROL_WORKBENCH_VERSION, "wcapi.control-workbench.v2");
});

// ─── normalizeGptHealth ─────────────────────────────────────────────────────

test("normalizeGptHealth maps ok=true to status=ok", () => {
  const input = {
    ok: true,
    service: "gpt_web_api",
    cdp: "http://127.0.0.1:9222",
    browserConnected: true,
    queue_depth: 3,
    session_locks: 1,
    account_id: null,
    profile_lock: null,
    lease: null,
    account_pool_summary: null,
    proxy_pool_summary: null,
  };
  const result = normalizeGptHealth(input);
  assert.equal(result.provider, "gpt-web-api");
  assert.equal(result.status, "ok");
  assert.equal(result.health.cdp, "http://127.0.0.1:9222");
  assert.equal(result.health.browserConnected, true);
  assert.equal(result.runtime.queue_depth, 3);
  assert.equal(result.runtime.session_locks, 1);
  assert.equal(result.accountPool, null);
  assert.equal(result.proxyPool, null);
});

test("normalizeGptHealth maps ok=false to status=error", () => {
  const result = normalizeGptHealth({ ok: false });
  assert.equal(result.status, "error");
});

test("normalizeGptHealth maps service_alive=false to status=blocked", () => {
  const result = normalizeGptHealth({ ok: true, service_alive: false });
  assert.equal(result.status, "blocked");
});

test("normalizeGptHealth handles missing fields gracefully", () => {
  const result = normalizeGptHealth({});
  assert.equal(result.provider, "gpt-web-api");
  assert.equal(result.status, "ok");
  assert.equal(result.health.cdp, null);
  assert.equal(result.health.browserConnected, null);
  assert.equal(result.runtime.queue_depth, null);
  assert.equal(result.accountPool, null);
});

test("normalizeGptHealth attaches account_pool_summary when present", () => {
  const poolSummary = { total: 2, available: 1, leased: 1 };
  const result = normalizeGptHealth({ ok: true, account_pool_summary: poolSummary });
  assert.deepEqual(result.accountPool, poolSummary);
});

test("normalizeGptHealth attaches proxy_pool_summary when present", () => {
  const proxySummary = { total: 3, healthy: 2 };
  const result = normalizeGptHealth({ ok: true, proxy_pool_summary: proxySummary });
  assert.deepEqual(result.proxyPool, proxySummary);
});

// ─── normalizeCanvasHealth ───────────────────────────────────────────────────

test("normalizeCanvasHealth maps status=ok to provider status=ok", () => {
  const input = {
    contract_version: "wcapi.browser_worker_runtime.v1",
    provider_id: "gemini-canvas",
    provider_type: "browser-session",
    status: "ok",
    logged_in: true,
    cdp_ready: true,
    browser_connected: true,
    queue: {
      supported: true,
      mode: "profile-serial",
      depth: { pending: 1, running: 0, completed: 5, failed: 0 },
      leases: [],
      lock_policy: { scope: "profile" },
    },
  };
  const result = normalizeCanvasHealth(input);
  assert.equal(result.provider, "gemini-canvas");
  assert.equal(result.providerType, "browser-session");
  assert.equal(result.status, "ok");
  assert.equal(result.health.logged_in, true);
  assert.equal(result.health.cdp_ready, true);
  assert.equal(result.health.browser_connected, true);
  assert.equal(result.queueState.provider, "gemini-canvas");
  assert.equal(result.queueState.queues[0].mode, "profile-serial");
  assert.equal(result.queueState.queues[0].depth.pending, 1);
  assert.equal(result.queueState.queues[0].depth.running, 0);
});

test("normalizeCanvasHealth maps status=degraded correctly", () => {
  const result = normalizeCanvasHealth({ status: "degraded" });
  assert.equal(result.status, "degraded");
});

test("normalizeCanvasHealth maps status=blocked correctly", () => {
  const result = normalizeCanvasHealth({ status: "blocked" });
  assert.equal(result.status, "blocked");
});

test("normalizeCanvasHealth maps unknown status to error", () => {
  const result = normalizeCanvasHealth({ status: "unknown_status" });
  assert.equal(result.status, "error");
});

test("normalizeCanvasHealth handles null/undefined queue gracefully", () => {
  const result = normalizeCanvasHealth({ status: "ok" });
  assert.equal(result.queueState, null);
  assert.equal(result.runtime.queue, null);
});

test("normalizeCanvasHealth uses queue.depth for depth values", () => {
  // This test verifies the fix: after canvas-to-api was updated to use
  // queue.depth.{pending,running}, normalizeCanvasHealth reads from the same path
  const input = {
    status: "ok",
    provider_id: "gemini-canvas",
    provider_type: "browser-session",
    queue: {
      supported: true,
      mode: "profile-serial",
      depth: { pending: 2, running: 1, completed: null, failed: null },
      leases: [],
      lock_policy: null,
    },
  };
  const result = normalizeCanvasHealth(input);
  assert.equal(result.queueState.queues[0].depth.pending, 2);
  assert.equal(result.queueState.queues[0].depth.running, 1);
});

test("normalizeCanvasHealth defaults missing depth fields to 0", () => {
  const input = {
    status: "ok",
    queue: {
      supported: true,
      mode: "profile-serial",
      depth: {},
      leases: [],
      lock_policy: null,
    },
  };
  const result = normalizeCanvasHealth(input);
  assert.equal(result.queueState.queues[0].depth.pending, 0);
  assert.equal(result.queueState.queues[0].depth.running, 0);
});

test("normalizeCanvasHealth passes through leases array when present", () => {
  const input = {
    status: "ok",
    queue: {
      supported: true,
      mode: "profile-serial",
      depth: { pending: 0, running: 0 },
      leases: [{ task_id: "task_1", profile_lock: "default", leased_by: "worker-1" }],
      lock_policy: { scope: "profile" },
    },
  };
  const result = normalizeCanvasHealth(input);
  assert.equal(result.queueState.queues[0].leases.length, 1);
  assert.equal(result.queueState.queues[0].leases[0].task_id, "task_1");
});

// ─── normalizeSub2apiHealth ────────────────────────────────────────────────────

test("normalizeSub2apiHealth maps ok=true to status=ok", () => {
  const input = {
    ok: true,
    version: "1.2.3",
    uptime_s: 3600,
    providers: [{ id: "gpt-web-api" }, { id: "gemini-canvas" }],
    accounts: [{ id: "acct1" }],
  };
  const result = normalizeSub2apiHealth(input);
  assert.equal(result.provider, "sub2api");
  assert.equal(result.providerType, "shim");
  assert.equal(result.status, "ok");
  assert.equal(result.health.ok, true);
  assert.equal(result.health.version, "1.2.3");
  assert.equal(result.health.uptime_s, 3600);
  assert.equal(result.runtime.providers_count, 2);
  assert.equal(result.runtime.accounts_count, 1);
  assert.equal(result.accountPool, null);
  assert.equal(result.proxyPool, null);
});

test("normalizeSub2apiHealth maps ok=false to status=error", () => {
  const result = normalizeSub2apiHealth({ ok: false });
  assert.equal(result.status, "error");
});

test("normalizeSub2apiHealth handles missing fields gracefully", () => {
  const result = normalizeSub2apiHealth({});
  assert.equal(result.provider, "sub2api");
  assert.equal(result.status, "ok");
  assert.equal(result.health.ok, null);
  assert.equal(result.health.version, null);
  assert.equal(result.health.uptime_s, null);
  assert.equal(result.runtime.providers_count, null);
  assert.equal(result.runtime.accounts_count, null);
});

// ─── normalizeOpsDoctor ────────────────────────────────────────────────────────

test("normalizeOpsDoctor returns null when data.checks is missing", () => {
  const result = normalizeOpsDoctor({});
  assert.equal(result, null);
});

test("normalizeOpsDoctor returns null when data is null", () => {
  const result = normalizeOpsDoctor(null);
  assert.equal(result, null);
});

test("normalizeOpsDoctor overall=ok when all checks OK", () => {
  const input = {
    timestamp: "2026-04-20T12:00:00.000Z",
    repo_root: "/repo",
    checks: [
      { name: "output_dir_writable", status: "OK", detail: "/generated is writable" },
      { name: "jobs_json", status: "OK", detail: "total=7 image_jobs=3" },
    ],
  };
  const result = normalizeOpsDoctor(input);
  assert.equal(result.overall, "ok");
  assert.equal(result.timestamp, "2026-04-20T12:00:00.000Z");
  assert.equal(result.repo_root, "/repo");
  assert.equal(result.checks.output_dir_writable.status, "OK");
  assert.equal(result.checks.jobs_json.detail, "total=7 image_jobs=3");
});

test("normalizeOpsDoctor overall=warn when any check WARN", () => {
  const input = {
    timestamp: "2026-04-20T12:00:00.000Z",
    repo_root: "/repo",
    checks: [
      { name: "output_dir_writable", status: "OK", detail: "writable" },
      { name: "media_json", status: "WARN", detail: "legacy media present" },
    ],
  };
  const result = normalizeOpsDoctor(input);
  assert.equal(result.overall, "warn");
});

test("normalizeOpsDoctor overall=fail when any check FAIL", () => {
  const input = {
    timestamp: "2026-04-20T12:00:00.000Z",
    repo_root: "/repo",
    checks: [
      { name: "output_dir_writable", status: "OK", detail: "writable" },
      { name: "jobs_json", status: "FAIL", detail: "not found" },
    ],
  };
  const result = normalizeOpsDoctor(input);
  assert.equal(result.overall, "fail");
});

test("normalizeOpsDoctor handles checks with no detail field", () => {
  const input = {
    timestamp: "2026-04-20T12:00:00.000Z",
    repo_root: "/repo",
    checks: [{ name: "pool_data", status: "OK" }],
  };
  const result = normalizeOpsDoctor(input);
  assert.equal(result.checks.pool_data.status, "OK");
  assert.equal(result.checks.pool_data.detail, "");
});

// ─── buildSummary ────────────────────────────────────────────────────────────

test("buildSummary counts statuses correctly", () => {
  const providers = [
    { provider: "gpt-web-api", status: "ok" },
    { provider: "gemini-canvas", status: "ok" },
    { provider: "ds-free-api", status: "degraded" },
    { provider: "unknown", status: "error" },
  ];
  const summary = buildSummary(providers);
  assert.equal(summary.counts.ok, 2);
  assert.equal(summary.counts.degraded, 1);
  assert.equal(summary.counts.error, 1);
  assert.equal(summary.counts.blocked, 0);
  assert.equal(summary.counts.unreachable, 0);
  assert.equal(summary.total, 4);
});

test("buildSummary overall=ok when all providers ok", () => {
  const providers = [
    { provider: "a", status: "ok" },
    { provider: "b", status: "ok" },
  ];
  const summary = buildSummary(providers);
  assert.equal(summary.overall, "ok");
});

test("buildSummary overall=mixed when ok and degraded co-exist", () => {
  const providers = [
    { provider: "a", status: "ok" },
    { provider: "b", status: "degraded" },
  ];
  const summary = buildSummary(providers);
  // ok+degraded is "mixed" (multiple non-ok states)
  assert.equal(summary.overall, "mixed");
});

test("buildSummary overall=degraded when all providers degraded", () => {
  const providers = [
    { provider: "a", status: "degraded" },
    { provider: "b", status: "degraded" },
  ];
  const summary = buildSummary(providers);
  assert.equal(summary.overall, "degraded");
});

test("buildSummary overall=blocked when any blocked and no errors", () => {
  const providers = [
    { provider: "a", status: "ok" },
    { provider: "b", status: "blocked" },
  ];
  const summary = buildSummary(providers);
  assert.equal(summary.overall, "blocked");
});

test("buildSummary overall=all_unreachable when all unreachable", () => {
  const providers = [
    { provider: "a", status: "unreachable" },
    { provider: "b", status: "unreachable" },
  ];
  const summary = buildSummary(providers);
  assert.equal(summary.overall, "all_unreachable");
});

test("buildSummary overall=blocked when blocked and degraded co-exist (blocked wins)", () => {
  const providers = [
    { provider: "a", status: "ok" },
    { provider: "b", status: "ok" },
    { provider: "c", status: "degraded" },
    { provider: "d", status: "blocked" },
  ];
  const summary = buildSummary(providers);
  // blocked has higher priority than degraded; overall reflects worst non-ok state
  assert.equal(summary.overall, "blocked");
});

test("buildSummary handles empty provider list", () => {
  const summary = buildSummary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.counts.ok, 0);
  assert.equal(summary.overall, "all_unreachable");
});
