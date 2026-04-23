import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createCenterJobService } from "../services/center_job_service.mjs";
import { JobQueue } from "../lib/job_queue.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function createWorkerServer({ token = "secret-token", failExecute = false } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/internal/worker/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          object: "worker.health",
          worker_id: "py-machine",
          visibility: "private",
          capabilities: ["job.execute"],
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/worker/jobs") {
      const auth = req.headers["x-wcapi-worker-token"];
      if (auth !== token) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "unauthorized worker request" } }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push(body);

      if (failExecute) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "upstream worker failure" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          object: "worker.job.result",
          worker_id: "py-machine",
          received_type: body.type,
          output: {
            echoed_payload: body.payload,
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}

async function createNamedWorkerServer(workerId, { token = "secret-token", failExecute = false } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/internal/worker/jobs") {
      const auth = req.headers["x-wcapi-worker-token"];
      if (auth !== token) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "unauthorized worker request" } }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push(body);

      if (failExecute) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "upstream worker failure" } }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          object: "worker.job.result",
          worker_id: workerId,
          output: {
            worker_id: workerId,
            echoed_payload: body.payload,
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}

async function createChatCapableWorkerServer({
  workerId = "chat-worker",
  token = "secret-token",
  providerStatus = 200,
  legacyStatus = 200,
} = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "unauthorized provider request" } }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ path: url.pathname, body });

      res.writeHead(providerStatus, { "Content-Type": "application/json; charset=utf-8" });
      if (providerStatus >= 400) {
        res.end(JSON.stringify({ error: { message: "provider path unavailable" } }));
        return;
      }
      res.end(
        JSON.stringify({
          id: "chatcmpl-provider",
          object: "chat.completion",
          worker_id: workerId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "provider route" },
              finish_reason: "stop",
            },
          ],
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/worker/jobs") {
      const auth = req.headers["x-wcapi-worker-token"];
      if (auth !== token) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: { message: "unauthorized worker request" } }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ path: url.pathname, body });

      res.writeHead(legacyStatus, { "Content-Type": "application/json; charset=utf-8" });
      if (legacyStatus >= 400) {
        res.end(JSON.stringify({ error: { message: "legacy path unavailable" } }));
        return;
      }
      res.end(
        JSON.stringify({
          ok: true,
          object: "worker.job.result",
          worker_id: workerId,
          output: {
            id: "chatcmpl-legacy",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "legacy route" },
                finish_reason: "stop",
              },
            ],
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  const baseUrl = await listen(server);
  return { server, baseUrl, seen };
}

test("center job service dispatches matching capability to remote worker", async () => {
  const worker = await createWorkerServer();
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "py-machine",
            enabled: true,
            base_url: worker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["job.execute"],
            priority: 100,
          },
        ],
      },
      localFallback: async () => {
        throw new Error("local fallback should not run in remote success path");
      },
    });

    const job = await service.createJob({
      type: "job.execute",
      capability: "job.execute",
      payload: { prompt: "hello remote" },
    });

    assert.equal(job.status, "queued");

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.path, "worker");
    assert.equal(result.execution.worker_id, "py-machine");
    assert.deepEqual(result.output.echoed_payload, { prompt: "hello remote" });
    assert.equal(worker.seen.length, 1);
    assert.equal(worker.seen[0].capability, "job.execute");
  } finally {
    await close(worker.server);
  }
});

test("center job service falls back to local execution when worker dispatch fails", async () => {
  const worker = await createWorkerServer({ failExecute: true });
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "py-machine",
            enabled: true,
            base_url: worker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["job.execute"],
            priority: 100,
          },
        ],
      },
      localFallback: async ({ type, payload }) => ({
        object: "local.fallback.result",
        type,
        payload,
        node: "bf2025-local",
      }),
    });

    const job = await service.createJob({
      type: "job.execute",
      capability: "job.execute",
      payload: { prompt: "fallback me" },
    });

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.path, "fallback_local");
    assert.equal(result.execution.worker_id, "py-machine");
    assert.equal(result.execution.fallback_node, "bf2025-local");
    assert.equal(result.output.node, "bf2025-local");

    const stored = jobQueue.get(job.id);
    assert.equal(stored.status, "succeeded");
  } finally {
    await close(worker.server);
  }
});

test("center job service prefers lightweight-text workers for ordinary chat jobs over browser workers", async () => {
  const qwenWorker = await createNamedWorkerServer("qwen-worker");
  const browserWorker = await createNamedWorkerServer("browser-worker");
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "browser-worker",
            enabled: true,
            base_url: browserWorker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 100,
            metadata: {
              runtime_tier: "tier1_browser_capability",
              integration_class: "repo_native_runtime",
            },
          },
          {
            id: "qwen-worker",
            enabled: true,
            base_url: qwenWorker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 10,
            metadata: {
              runtime_tier: "tier0_lightweight_text",
              integration_class: "lightweight_text_boundary",
            },
          },
        ],
      },
      localFallback: async () => {
        throw new Error("local fallback should not run");
      },
    });

    const job = await service.createJob({
      type: "chat.completion",
      capability: "chat.completion",
      payload: {
        messages: [{ role: "user", content: "hello" }],
      },
    });

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.worker_id, "qwen-worker");
    assert.equal(result.execution.routing.requested_runtime_tier, "tier0_lightweight_text");
    assert.equal(result.execution.routing.selected_runtime_tier, "tier0_lightweight_text");
    assert.equal(qwenWorker.seen.length, 1);
    assert.equal(browserWorker.seen.length, 0);
  } finally {
    await close(qwenWorker.server);
    await close(browserWorker.server);
  }
});

test("center job service prefers browser-capability workers when chat payload requires files", async () => {
  const qwenWorker = await createNamedWorkerServer("qwen-worker");
  const browserWorker = await createNamedWorkerServer("browser-worker");
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "qwen-worker",
            enabled: true,
            base_url: qwenWorker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 100,
            metadata: {
              runtime_tier: "tier0_lightweight_text",
              integration_class: "lightweight_text_boundary",
            },
          },
          {
            id: "browser-worker",
            enabled: true,
            base_url: browserWorker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 10,
            metadata: {
              runtime_tier: "tier1_browser_capability",
              integration_class: "repo_native_runtime",
            },
          },
        ],
      },
      localFallback: async () => {
        throw new Error("local fallback should not run");
      },
    });

    const job = await service.createJob({
      type: "chat.completion",
      capability: "chat.completion",
      payload: {
        file_ids: ["file_123"],
        messages: [{ role: "user", content: "check this file" }],
      },
    });

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.worker_id, "browser-worker");
    assert.equal(result.execution.routing.requested_runtime_tier, "tier1_browser_capability");
    assert.equal(result.execution.routing.selected_runtime_tier, "tier1_browser_capability");
    assert.equal(qwenWorker.seen.length, 0);
    assert.equal(browserWorker.seen.length, 1);
  } finally {
    await close(qwenWorker.server);
    await close(browserWorker.server);
  }
});

test("center job service prefers provider-style southbound for chat.completion", async () => {
  const worker = await createChatCapableWorkerServer({ workerId: "provider-first-worker" });
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "provider-first-worker",
            enabled: true,
            base_url: worker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 100,
            metadata: {
              runtime_tier: "tier0_lightweight_text",
              integration_class: "lightweight_text_boundary",
            },
          },
        ],
      },
      localFallback: async () => {
        throw new Error("local fallback should not run");
      },
    });

    const job = await service.createJob({
      type: "chat.completion",
      capability: "chat.completion",
      payload: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello provider-first" }],
      },
    });

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.path, "worker");
    assert.equal(result.output.object, "chat.completion");
    assert.equal(result.output.choices[0].message.content, "provider route");
    assert.equal(worker.seen.length, 1);
    assert.equal(worker.seen[0].path, "/v1/chat/completions");
    assert.equal(worker.seen[0].body.model, "qwen3.6-plus");
  } finally {
    await close(worker.server);
  }
});

test("center job service falls back to legacy worker southbound when provider-style chat path is unavailable", async () => {
  const worker = await createChatCapableWorkerServer({
    workerId: "legacy-fallback-worker",
    providerStatus: 404,
  });
  const jobQueue = new JobQueue({ idPrefix: "centerjob" });

  try {
    const service = createCenterJobService({
      jobQueue,
      registry: {
        workers: [
          {
            id: "legacy-fallback-worker",
            enabled: true,
            base_url: worker.baseUrl,
            shared_token: "secret-token",
            capabilities: ["chat.completion"],
            priority: 100,
            metadata: {
              runtime_tier: "tier0_lightweight_text",
              integration_class: "lightweight_text_boundary",
            },
          },
        ],
      },
      localFallback: async () => {
        throw new Error("local fallback should not run");
      },
    });

    const job = await service.createJob({
      type: "chat.completion",
      capability: "chat.completion",
      payload: {
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hello legacy fallback" }],
      },
    });

    const result = await jobQueue.wait(job.id);
    assert.equal(result.execution.path, "worker");
    assert.equal(result.output.object, "chat.completion");
    assert.equal(result.output.choices[0].message.content, "legacy route");
    assert.equal(worker.seen.length, 2);
    assert.equal(worker.seen[0].path, "/v1/chat/completions");
    assert.equal(worker.seen[1].path, "/internal/worker/jobs");
    assert.equal(worker.seen[1].body.type, "chat.completion");
  } finally {
    await close(worker.server);
  }
});
