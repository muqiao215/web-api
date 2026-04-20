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
