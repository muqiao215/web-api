import assert from "node:assert/strict";
import test from "node:test";

import { ProviderRouter } from "../lib/provider_router.mjs";
import { createProviderAdminService } from "../services/provider_admin_service.mjs";

function createProvider(id, models = [], capabilities = {}) {
  return {
    id,
    name: `${id}-name`,
    type: "test",
    capabilities,
    descriptor() {
      return {
        id,
        object: "provider",
        name: `${id}-name`,
        type: "test",
        capabilities,
        models,
      };
    },
    models() {
      return models.map((modelId) => ({
        id: modelId,
        object: "model",
        owned_by: `${id}-owner`,
        provider: id,
      }));
    },
    async healthCheck() {
      return { ok: true, provider: id, browser: "Chrome/1.0" };
    },
  };
}

test("Provider admin service exposes provider details with health and queue metrics", async () => {
  const router = new ProviderRouter();
  router.register(
    createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"], {
      chat: true,
      images: true,
    }),
    { isDefault: true },
  );

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({
      ok: true,
      browser: "Chrome/1.0",
      websocket_debugger_url: "ws://127.0.0.1/devtools/browser/test",
    }),
    inspectRuntimeStatus: async () => ({
      contract_version: "wcapi.browser_worker_runtime.v1",
      provider_id: "chatgpt-web",
      provider_type: "browser-session",
      status: "ok",
      service_alive: true,
      logged_in: true,
      browser_connected: true,
      browserConnected: true,
      cdp_ready: true,
      queue: {
        supported: true,
        mode: "profile-serial",
        pending: 2,
        running: 1,
        locks_active: 1,
      },
      lock_policy: {
        scope: "profile",
        implementation: "JobQueue",
      },
      profiles: [
        {
          id: "default",
          cdp_http: "http://127.0.0.1:9222",
          logged_in: true,
          cdp_ready: true,
        },
      ],
    }),
    getQueueDepth: () => 3,
    getQueueStats: () => ({ pending: 2, running: 1, total: 3 }),
    getSessionLockCount: () => 1,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  const model = service.getModel("chatgpt-images");
  const provider = await service.getProviderDetail("chatgpt-web");
  const listing = await service.listProviderDetails();

  assert.equal(model.id, "chatgpt-images");
  assert.equal(model.provider, "chatgpt-web");
  assert.equal(model.capabilities.images, true);
  assert.equal(model.provider_name, "chatgpt-web-name");

  assert.equal(provider.id, "chatgpt-web");
  assert.equal(provider.health.ok, true);
  assert.equal(provider.runtime.queue_depth, 3);
  assert.equal(provider.runtime.session_locks, 1);
  // account_id, profile_lock, lease: nullable — Phase 4 account pool fills these
  assert.equal(provider.runtime.account_id, null);
  assert.equal(provider.runtime.profile_lock, null);
  assert.equal(provider.runtime.lease, null);
  assert.equal(provider.runtime_contract.provider_id, "chatgpt-web");
  assert.equal(provider.runtime_contract.queue.mode, "profile-serial");
  assert.deepEqual(provider.models, ["chatgpt-web", "chatgpt-images"]);

  assert.equal(listing.object, "list");
  assert.equal(listing.data.length, 1);
  assert.equal(listing.data[0].health.browser, "Chrome/1.0");
});

test("Provider admin service rejects unknown providers", async () => {
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web"]), { isDefault: true });

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({ ok: true }),
    inspectRuntimeStatus: async () => ({ status: "ok" }),
    getQueueDepth: () => 0,
    getQueueStats: () => ({ pending: 0, running: 0, total: 0 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  await assert.rejects(() => service.getProviderDetail("missing"), /Unknown provider/);
});

test("Provider admin service health output includes account_id, profile_lock, lease fields (Phase 4 placeholders)", async () => {
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web"]), { isDefault: true });

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({ ok: true }),
    inspectRuntimeStatus: async () => ({ status: "ok" }),
    getQueueDepth: () => 1,
    getQueueStats: () => ({ pending: 1, running: 0, total: 1 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  const healthOutput = await service.health();
  assert.equal(healthOutput.queue_depth, 1);
  assert.equal(healthOutput.session_locks, 0);
  assert.equal(healthOutput.account_id, null, "account_id is nullable — Phase 4 account pool");
  assert.equal(healthOutput.profile_lock, null, "profile_lock is nullable — Phase 4 account pool");
  assert.equal(healthOutput.lease, null, "lease is nullable — Phase 4 account pool");
});

test("Provider admin service attaches pool status when pool packages are wired (Phase 4)", async () => {
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web"]), { isDefault: true });

  // Create a real provider_pool and proxy_pool
  const { createProviderPool } = await import("../../../packages/provider_pool/src/index.mjs");
  const { createProxyPool } = await import("../../../packages/proxy_pool/src/index.mjs");

  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct_a", label: "Account A", priority: 10 });
  pool.addAccount({ id: "acct_b", label: "Account B", priority: 5 });
  pool.acquireLease("acct_a", "task_1", "worker-a");

  const proxyPool = createProxyPool({ provider: "chatgpt-web" });
  proxyPool.addProxy({ id: "px1", host: "1.2.3.4", port: 8080 });
  proxyPool.addProxy({ id: "px2", host: "5.6.7.8", port: 8080 });
  proxyPool.recordFailure("px1"); // score drops, still active

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({ ok: true }),
    inspectRuntimeStatus: async () => ({ status: "ok" }),
    getQueueDepth: () => 0,
    getQueueStats: () => ({ pending: 0, running: 0, total: 0 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
    providerPool: pool,
    proxyPool: proxyPool,
  });

  const healthOutput = await service.health();
  assert.equal(healthOutput.account_pool_summary.total, 2);
  assert.equal(healthOutput.account_pool_summary.available, 1, "acct_b is available (acct_a is leased)");
  assert.equal(healthOutput.account_pool_summary.leased, 1);
  assert.equal(healthOutput.proxy_pool_summary.total, 2);
  assert.equal(healthOutput.proxy_pool_summary.healthy >= 0, true);

  const detail = await service.getProviderDetail("chatgpt-web");
  assert.equal(detail.account_pool.total_accounts, 2);
  assert.equal(detail.account_pool.available_accounts, 1);
  assert.equal(detail.proxy_pool.total_proxies, 2);
});

// ─── Phase 6: Worker smoke tests ─────────────────────────────────────────────────

test("Provider admin service health() returns runtime_contract aligned with provider-capability.schema.json", async () => {
  // Smoke test: verify the health output shape matches what control-workbench
  // and sub2api expect. This is the primary worker smoke entry point.
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"], {
    chat: true, images: true, streaming: true,
  }), { isDefault: true });

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({
      ok: true, browser: "Chrome/1.0", websocket_debugger_url: "ws://127.0.0.1/devtools/browser/test",
    }),
    inspectRuntimeStatus: async () => ({
      contract_version: "wcapi.browser_worker_runtime.v1",
      provider_id: "chatgpt-web",
      provider_type: "browser-session",
      status: "ok",
      service_alive: true,
      logged_in: true,
      cdp_ready: true,
      browser_connected: true,
      browserConnected: true,
      blocked_by: "none",
      queue: { supported: true, mode: "profile-serial", pending: 0, running: 0, locks_active: 0 },
      capabilities: { chat: true, images: true, streaming: true, files: true, vision: true },
    }),
    getQueueDepth: () => 0,
    getQueueStats: () => ({ pending: 0, running: 0, total: 0 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  const health = await service.health();

  // Critical fields for sub2api routing and control-workbench aggregation
  assert.equal(health.ok, true, "health.ok must be boolean");
  assert.equal(health.service, "gpt_web_api", "service name must be gpt_web_api");
  assert.equal(typeof health.provider_count, "number", "provider_count must be number");
  assert.equal(health.provider_count, 1, "provider_count must be 1 for single-provider setup");

  // runtime_contract is the primary smoke payload — must be present and well-structured
  assert.ok(health.runtime_contract, "runtime_contract must be present");
  assert.equal(health.runtime_contract.contract_version, "wcapi.browser_worker_runtime.v1");
  assert.equal(typeof health.runtime_contract.status, "string", "runtime_contract.status must be string");
  assert.equal(typeof health.runtime_contract.service_alive, "boolean", "runtime_contract.service_alive must be boolean");
  assert.equal(typeof health.runtime_contract.logged_in, "boolean", "runtime_contract.logged_in must be boolean");
  assert.equal(typeof health.runtime_contract.cdp_ready, "boolean", "runtime_contract.cdp_ready must be boolean");
  assert.equal(typeof health.runtime_contract.browser_connected, "boolean", "runtime_contract.browser_connected must be boolean");
  assert.equal(typeof health.runtime_contract.blocked_by, "string", "runtime_contract.blocked_by must be string");

  // providers descriptor list — used by control-workbench for capability reporting
  assert.ok(Array.isArray(health.providers), "providers must be array");
  assert.equal(health.providers[0].id, "chatgpt-web");
  assert.ok(Array.isArray(health.providers[0].models), "provider models must be array");
  assert.equal(health.providers[0].models[0], "chatgpt-web");

  // paths — used by ops_doctor diagnose.mjs for file-based checks
  assert.equal(health.jobs_path, "/tmp/jobs.json");
  assert.equal(health.image_output_dir, "/tmp/generated");

  // queue metrics
  assert.equal(typeof health.queue_depth, "number");
});

test("Provider admin service health() maps browser readiness failure to blocked status via runtime_contract", async () => {
  // When browser is disconnected, runtime_contract.service_alive should be false
  // and health status should reflect blocked.
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web"]), { isDefault: true });

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({ ok: false, error: "CDP unreachable" }),
    inspectRuntimeStatus: async () => ({
      contract_version: "wcapi.browser_worker_runtime.v1",
      provider_id: "chatgpt-web",
      status: "blocked",
      service_alive: false,
      logged_in: null,
      cdp_ready: false,
      browser_connected: false,
      browserConnected: false,
      blocked_by: "browser_session",
      queue: { supported: true, mode: "profile-serial", pending: 0, running: 0 },
    }),
    getQueueDepth: () => 0,
    getQueueStats: () => ({ pending: 0, running: 0, total: 0 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  const health = await service.health();

  // The worker should still return a response even when browser is down
  // (this is the smoke — it proves the worker process is alive)
  assert.equal(health.ok, true, "worker process is alive even when browser disconnected");
  assert.equal(health.runtime_contract.service_alive, false, "service_alive=false when browser disconnected");
  assert.equal(health.runtime_contract.blocked_by, "browser_session");
  assert.equal(health.runtime_contract.browser_connected, false);
});

test("Provider admin service getProviderDetail returns all models with capability metadata", async () => {
  // Smoke test: verify the provider detail includes model-level capability metadata
  // which is what sub2api uses for model-level routing decisions.
  const router = new ProviderRouter();
  router.register(createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"], {
    chat: true, images: true,
  }), { isDefault: true });

  const service = createProviderAdminService({
    providerRouter: router,
    inspectBrowserReadiness: async () => ({ ok: true }),
    inspectRuntimeStatus: async () => ({
      contract_version: "wcapi.browser_worker_runtime.v1",
      provider_id: "chatgpt-web",
      status: "ok",
      service_alive: true,
      logged_in: true,
      cdp_ready: true,
      browser_connected: true,
      browserConnected: true,
      blocked_by: "none",
      queue: { supported: true, mode: "profile-serial", pending: 0, running: 0 },
    }),
    getQueueDepth: () => 0,
    getQueueStats: () => ({ pending: 0, running: 0, total: 0 }),
    getSessionLockCount: () => 0,
    jobsPath: "/tmp/jobs.json",
    sessionAffinityPath: "/tmp/session_affinity.json",
    mediaPath: "/tmp/media.json",
    outputDir: "/tmp/generated",
    uploadDir: "/tmp/uploads",
    cdpHttp: "http://127.0.0.1:9222",
  });

  const detail = await service.getProviderDetail("chatgpt-web");

  // Model details must include id and owned_by for sub2api model routing
  assert.ok(Array.isArray(detail.model_details), "model_details must be array");
  const imageModel = detail.model_details.find((m) => m.id === "chatgpt-images");
  assert.ok(imageModel, "chatgpt-images must be in model_details");
  assert.equal(imageModel.owned_by, "chatgpt-web-owner");
  assert.equal(imageModel.provider, "chatgpt-web");

  // Capability metadata at provider level
  assert.ok(detail.capabilities, "provider capabilities must be present");
  assert.equal(detail.capabilities.images, true);
});
