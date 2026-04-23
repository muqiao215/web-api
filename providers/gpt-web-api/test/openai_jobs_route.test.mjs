import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createOpenAIRouteHandler } from "../routes/openai_routes.mjs";
import { sendJson } from "../services/http_utils.mjs";
import { JobQueue } from "../lib/job_queue.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("POST /v1/jobs creates an async center job and GET /v1/jobs/:id exposes the settled result", async () => {
  const jobQueue = new JobQueue({ idPrefix: "routejob" });
  const centerJobService = {
    async createJob(body) {
      return jobQueue.enqueue("job.execute", async () => ({
        execution: { path: "worker", worker_id: "py-machine" },
        request: body,
        output: { ok: true },
      }), {
        route_mode: "worker",
      });
    },
  };

  const handleOpenAIRoute = createOpenAIRouteHandler({
    providerRouter: {
      listModels: () => [],
      listProviderDescriptors: () => [],
      resolveProvider: () => {
        throw new Error("not used in /v1/jobs test");
      },
    },
    providerAdminService: {
      getModel: () => null,
      getProviderDetail: async () => {
        throw new Error("not used in /v1/jobs test");
      },
    },
    mediaStore: { list: async () => [] },
    sessionAffinity: { list: async () => [] },
    chatState: {
      listConversations: async () => [],
      listFiles: async () => [],
      extractFileIdsFromMessages: () => [],
    },
    jobQueue,
    enqueueProviderJob: () => {
      throw new Error("not used in /v1/jobs test");
    },
    serialize: async () => {
      throw new Error("not used in /v1/jobs test");
    },
    withTimeout: async () => {
      throw new Error("not used in /v1/jobs test");
    },
    publicBaseUrl: "http://127.0.0.1:0",
    supportedImageSize: "1024x1024",
    maxImageCount: 4,
    chatTimeoutMs: 1000,
    imageTimeoutMs: 1000,
    centerJobService,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (await handleOpenAIRoute(req, res, url)) return;
    sendJson(res, 404, { error: { message: "not found" } });
  });

  const baseUrl = await listen(server);

  try {
    const createResponse = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "job.execute",
        capability: "job.execute",
        payload: { prompt: "hello" },
      }),
    });

    assert.equal(createResponse.status, 202);
    const created = await createResponse.json();
    assert.match(created.id, /^routejob_/);
    assert.equal(created.status, "queued");

    await jobQueue.wait(created.id);

    const jobResponse = await fetch(`${baseUrl}/v1/jobs/${created.id}`);
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json();
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.execution.path, "worker");
    assert.equal(job.result.execution.worker_id, "py-machine");
  } finally {
    await close(server);
  }
});

test("POST /v1/images/generations uses provider default image model for gemini-web", async () => {
  const jobQueue = new JobQueue({ idPrefix: "routejob" });
  const imageCalls = [];
  const geminiProvider = {
    id: "gemini-web",
    models: () => [{ id: "gemini-3-flash", object: "model", owned_by: "google-web", provider: "gemini-web" }],
    defaultImageModel: () => "gemini-3-flash",
    async generateImage(prompt, options = {}) {
      imageCalls.push({ prompt, options });
      return {
        created: 123,
        output_path: "/tmp/gemini-route-image.png",
        image_url: null,
        artifact_id: "artifact_gemini_1",
        mime_type: "image/png",
        sha256: "abc123",
        admission: "experimental",
        admission_detail: {
          state: "experimental",
          degraded: true,
          timeout_mode: "bounded",
          operation: "images.generations",
        },
      };
    },
  };

  const handleOpenAIRoute = createOpenAIRouteHandler({
    providerRouter: {
      listModels: () => geminiProvider.models(),
      listProviderDescriptors: () => [],
      resolveProvider: ({ providerId }) => {
        assert.equal(providerId, "gemini-web");
        return geminiProvider;
      },
    },
    providerAdminService: {
      getModel: () => null,
      getProviderDetail: async () => {
        throw new Error("not used in image route test");
      },
    },
    mediaStore: {
      list: async () => [],
      recordGeneratedMedia: async () => ({ id: "artifact_gemini_1" }),
    },
    sessionAffinity: { list: async () => [] },
    chatState: {
      listConversations: async () => [],
      listFiles: async () => [],
      extractFileIdsFromMessages: () => [],
    },
    jobQueue,
    enqueueProviderJob: (type, work, metadata = {}) => {
      const job = jobQueue.enqueue(type, work, metadata);
      return { job, wait: () => jobQueue.wait(job.id) };
    },
    serialize: async () => {
      throw new Error("not used in image route test");
    },
    withTimeout: async (work) => work(),
    publicBaseUrl: "http://127.0.0.1:0",
    supportedImageSize: "1024x1024",
    maxImageCount: 4,
    chatTimeoutMs: 1000,
    imageTimeoutMs: 1000,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (await handleOpenAIRoute(req, res, url)) return;
    sendJson(res, 404, { error: { message: "not found" } });
  });

  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini-web",
        prompt: "draw a cat",
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.meta.provider, "gemini-web");
    assert.equal(payload.meta.model, "gemini-3-flash");
    assert.equal(payload.meta.provider_admission, "experimental");
    assert.equal(payload.meta.provider_admission_detail.degraded, true);
    assert.equal(payload.meta.provider_admission_detail.timeout_mode, "bounded");
    assert.equal(imageCalls.length, 1);
    assert.equal(imageCalls[0].options.model, "gemini-3-flash");
  } finally {
    await close(server);
  }
});

test("POST /v1/chat/completions stream=true uses single-event degraded SSE for gemini-web", async () => {
  const jobQueue = new JobQueue({ idPrefix: "routejob" });
  const geminiProvider = {
    id: "gemini-web",
    streaming_strategy: "single_event_degraded",
    models: () => [{ id: "gemini-3-flash", object: "model", owned_by: "google-web", provider: "gemini-web" }],
    async chatCompletionStream(_messages, _options, onDelta) {
      onDelta("OK");
      return {
        created: 123,
        model: "gemini-3-flash",
        content: "OK",
        conversation_id: null,
        conversation_url: null,
        streaming_strategy: "single_event_degraded",
        streaming_degraded: true,
      };
    },
  };

  const handleOpenAIRoute = createOpenAIRouteHandler({
    providerRouter: {
      listModels: () => geminiProvider.models(),
      listProviderDescriptors: () => [],
      resolveProvider: ({ providerId }) => {
        assert.equal(providerId, "gemini-web");
        return geminiProvider;
      },
    },
    providerAdminService: {
      getModel: () => null,
      getProviderDetail: async () => {
        throw new Error("not used in stream route test");
      },
    },
    mediaStore: { list: async () => [] },
    sessionAffinity: { list: async () => [] },
    chatState: {
      listConversations: async () => [],
      listFiles: async () => [],
      extractFileIdsFromMessages: () => [],
    },
    jobQueue,
    enqueueProviderJob: () => {
      throw new Error("not used in stream route test");
    },
    serialize: async (work) => work(),
    withTimeout: async (work) => work(),
    publicBaseUrl: "http://127.0.0.1:0",
    supportedImageSize: "1024x1024",
    maxImageCount: 4,
    chatTimeoutMs: 1000,
    imageTimeoutMs: 1000,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (await handleOpenAIRoute(req, res, url)) return;
    sendJson(res, 404, { error: { message: "not found" } });
  });

  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini-web",
        model: "gemini-3-flash",
        stream: true,
        messages: [{ role: "user", content: "reply with exactly OK" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);

    const body = await response.text();
    assert.match(body, /"content":"OK"/);
    assert.match(body, /"streaming_strategy":"single_event_degraded"/);
    assert.match(body, /"streaming_degraded":true/);
    assert.match(body, /\[DONE\]/);
  } finally {
    await close(server);
  }
});
