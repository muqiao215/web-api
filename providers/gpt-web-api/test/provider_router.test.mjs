import assert from "node:assert/strict";
import test from "node:test";

import { ProviderRouter } from "../lib/provider_router.mjs";

function createProvider(id, models = [], aliases = []) {
  return {
    id,
    aliases,
    descriptor() {
      return {
        id,
        object: "provider",
        name: id,
        type: "test",
        capabilities: {},
        models,
        aliases,
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
  };
}

test("ProviderRouter exposes providers and flattened models", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-web", ["gemini-3-flash", "gemini-3-pro"], ["gemini-canvas"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.equal(router.count(), 2);
  assert.equal(router.defaultProvider().id, "chatgpt-web");
  assert.deepEqual(
    router.listProviders().map((provider) => provider.id),
    ["chatgpt-web", "gemini-web"],
  );
  assert.deepEqual(
    router.listProviderDescriptors().map((provider) => provider.id),
    ["chatgpt-web", "gemini-web"],
  );
  assert.deepEqual(
    router.listModels().map((model) => model.id),
    ["chatgpt-web", "chatgpt-images", "gemini-3-flash", "gemini-3-pro"],
  );
});

test("ProviderRouter resolves provider by explicit provider id or model id", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-web", ["gemini-3-flash", "gemini-3-pro"], ["gemini-canvas"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.equal(router.resolveProvider().id, "chatgpt-web");
  assert.equal(router.resolveProvider({ providerId: "gemini-web" }).id, "gemini-web");
  assert.equal(router.resolveProvider({ providerId: "gemini-canvas" }).id, "gemini-web");
  assert.equal(router.resolveProvider({ modelId: "gemini-3-pro" }).id, "gemini-web");
  assert.equal(router.resolveProvider({ modelId: "chatgpt-images" }).id, "chatgpt-web");
});

test("ProviderRouter returns model descriptors and owner provider details", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-web", ["gemini-3-flash", "gemini-3-pro"], ["gemini-canvas"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.deepEqual(router.getModel("gemini-3-pro"), {
    id: "gemini-3-pro",
    object: "model",
    owned_by: "gemini-web-owner",
    provider: "gemini-web",
  });
  assert.equal(router.getProviderByModel("gemini-3-pro").id, "gemini-web");
  assert.equal(router.getModel("missing-model"), null);
});

test("ProviderRouter rejects duplicate ids and unknown providers", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web"]);

  router.register(chatgpt, { isDefault: true });

  assert.throws(() => router.register(chatgpt), /already registered/);
  assert.throws(() => router.register(createProvider("gemini-web", ["gemini-3-flash"], ["chatgpt-web"])), /alias already registered/);
  assert.throws(() => router.getProvider("missing"), /Unknown provider/);
  assert.throws(() => router.resolveProvider({ providerId: "missing" }), /Unknown provider/);
  assert.throws(() => router.resolveProvider({ modelId: "missing-model" }), /Unknown model/);
});
