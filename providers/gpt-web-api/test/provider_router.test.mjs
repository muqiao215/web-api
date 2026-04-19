import assert from "node:assert/strict";
import test from "node:test";

import { ProviderRouter } from "../lib/provider_router.mjs";

function createProvider(id, models = []) {
  return {
    id,
    descriptor() {
      return {
        id,
        object: "provider",
        name: id,
        type: "test",
        capabilities: {},
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
  };
}

test("ProviderRouter exposes providers and flattened models", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-canvas", ["gemini-cli", "imagen-4.0"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.equal(router.count(), 2);
  assert.equal(router.defaultProvider().id, "chatgpt-web");
  assert.deepEqual(
    router.listProviders().map((provider) => provider.id),
    ["chatgpt-web", "gemini-canvas"],
  );
  assert.deepEqual(
    router.listProviderDescriptors().map((provider) => provider.id),
    ["chatgpt-web", "gemini-canvas"],
  );
  assert.deepEqual(
    router.listModels().map((model) => model.id),
    ["chatgpt-web", "chatgpt-images", "gemini-cli", "imagen-4.0"],
  );
});

test("ProviderRouter resolves provider by explicit provider id or model id", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-canvas", ["gemini-cli", "imagen-4.0"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.equal(router.resolveProvider().id, "chatgpt-web");
  assert.equal(router.resolveProvider({ providerId: "gemini-canvas" }).id, "gemini-canvas");
  assert.equal(router.resolveProvider({ modelId: "imagen-4.0" }).id, "gemini-canvas");
  assert.equal(router.resolveProvider({ modelId: "chatgpt-images" }).id, "chatgpt-web");
});

test("ProviderRouter returns model descriptors and owner provider details", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web", "chatgpt-images"]);
  const gemini = createProvider("gemini-canvas", ["gemini-cli", "imagen-4.0"]);

  router.register(chatgpt, { isDefault: true });
  router.register(gemini);

  assert.deepEqual(router.getModel("imagen-4.0"), {
    id: "imagen-4.0",
    object: "model",
    owned_by: "gemini-canvas-owner",
    provider: "gemini-canvas",
  });
  assert.equal(router.getProviderByModel("imagen-4.0").id, "gemini-canvas");
  assert.equal(router.getModel("missing-model"), null);
});

test("ProviderRouter rejects duplicate ids and unknown providers", () => {
  const router = new ProviderRouter();
  const chatgpt = createProvider("chatgpt-web", ["chatgpt-web"]);

  router.register(chatgpt, { isDefault: true });

  assert.throws(() => router.register(chatgpt), /already registered/);
  assert.throws(() => router.getProvider("missing"), /Unknown provider/);
  assert.throws(() => router.resolveProvider({ providerId: "missing" }), /Unknown provider/);
  assert.throws(() => router.resolveProvider({ modelId: "missing-model" }), /Unknown model/);
});
