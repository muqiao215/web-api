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
