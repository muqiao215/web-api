import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createPrivateWorkerServer } from "../src/index.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("private worker exposes health and rejects unauthorized job execution", async () => {
  const server = createPrivateWorkerServer({
    workerId: "py-machine",
    sharedToken: "secret-token",
    capabilities: ["job.execute"],
    runtimeTier: "tier0_lightweight_text",
    integrationClass: "lightweight_text_boundary",
    executeJob: async () => ({ ok: true }),
  });

  const baseUrl = await listen(server);

  try {
    const healthResponse = await fetch(`${baseUrl}/internal/worker/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.worker_id, "py-machine");
    assert.equal(health.visibility, "private");
    assert.deepEqual(health.capabilities, ["job.execute"]);
    assert.equal(health.runtime_tier, "tier0_lightweight_text");
    assert.equal(health.integration_class, "lightweight_text_boundary");

    const providerHealthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(providerHealthResponse.status, 200);
    const providerHealth = await providerHealthResponse.json();
    assert.equal(providerHealth.object, "provider.health");
    assert.equal(providerHealth.provider_id, "py-machine");
    assert.deepEqual(providerHealth.capabilities, ["job.execute"]);

    const unauthorized = await fetch(`${baseUrl}/internal/worker/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "job.execute", capability: "job.execute", payload: {} }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await close(server);
  }
});

test("private worker executes an authorized job through the configured handler", async () => {
  const seen = [];
  const server = createPrivateWorkerServer({
    workerId: "py-machine",
    sharedToken: "secret-token",
    capabilities: ["job.execute"],
    executeJob: async (job) => {
      seen.push(job);
      return {
        object: "worker.job.result",
        worker_id: "py-machine",
        echoed: job.payload,
      };
    },
  });

  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/internal/worker/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wcapi-worker-token": "secret-token",
      },
      body: JSON.stringify({
        type: "job.execute",
        capability: "job.execute",
        payload: { prompt: "hello worker" },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.worker_id, "py-machine");
    assert.deepEqual(body.echoed, { prompt: "hello worker" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].capability, "job.execute");
  } finally {
    await close(server);
  }
});

test("private worker exposes provider-style chat.completions while keeping legacy internal jobs", async () => {
  const seen = [];
  const server = createPrivateWorkerServer({
    workerId: "py-machine",
    sharedToken: "secret-token",
    capabilities: ["chat.completion"],
    runtimeTier: "tier0_lightweight_text",
    integrationClass: "lightweight_text_boundary",
    executeJob: async (job) => {
      seen.push(job);
      return {
        id: "chatcmpl-provider",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "provider ok" },
            finish_reason: "stop",
          },
        ],
      };
    },
  });

  const baseUrl = await listen(server);

  try {
    const providerResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello provider" }],
      }),
    });

    assert.equal(providerResponse.status, 200);
    const providerBody = await providerResponse.json();
    assert.equal(providerBody.object, "chat.completion");
    assert.equal(providerBody.choices[0].message.content, "provider ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "chat.completion");
    assert.equal(seen[0].capability, "chat.completion");
    assert.equal(seen[0].payload.model, "qwen3.6-plus");

    const legacyResponse = await fetch(`${baseUrl}/internal/worker/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wcapi-worker-token": "secret-token",
      },
      body: JSON.stringify({
        type: "chat.completion",
        capability: "chat.completion",
        payload: {
          model: "qwen3.6-plus",
          messages: [{ role: "user", content: "hello legacy" }],
        },
      }),
    });

    assert.equal(legacyResponse.status, 200);
    const legacyBody = await legacyResponse.json();
    assert.equal(legacyBody.object, "chat.completion");
    assert.equal(seen.length, 2);
    assert.equal(seen[1].payload.messages[0].content, "hello legacy");
  } finally {
    await close(server);
  }
});
