import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiError, normalizeApiError } from "../lib/api_error.mjs";
import { JobQueue } from "../lib/job_queue.mjs";
import { MediaStore } from "../lib/media_store.mjs";
import { SessionAffinityStore } from "../lib/session_affinity.mjs";
import { SessionLockRegistry } from "../lib/session_lock.mjs";
import { ChatGPTWebProvider } from "../providers/chatgpt_web_provider.mjs";
import { GeminiWebProvider } from "../providers/gemini_web_provider.mjs";

test("JobQueue serializes jobs and stores status transitions", async () => {
  const queue = new JobQueue({ idPrefix: "testjob" });
  const order = [];

  const first = queue.enqueue("first", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
    return { value: 1 };
  });
  const second = queue.enqueue("second", async () => {
    order.push("second:start");
    order.push("second:end");
    return { value: 2 };
  });

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");

  const firstResult = await queue.wait(first.id);
  const secondResult = await queue.wait(second.id);

  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.deepEqual(firstResult, { value: 1 });
  assert.deepEqual(secondResult, { value: 2 });
  assert.equal(queue.get(first.id).status, "succeeded");
  assert.equal(queue.get(second.id).status, "succeeded");
});

test("JobQueue records failed jobs without breaking later jobs", async () => {
  const queue = new JobQueue({ idPrefix: "testjob" });

  const failed = queue.enqueue("failed", async () => {
    throw new Error("boom");
  });
  const later = queue.enqueue("later", async () => "ok");

  await assert.rejects(() => queue.wait(failed.id), /boom/);
  assert.equal(await queue.wait(later.id), "ok");
  assert.equal(queue.get(failed.id).status, "failed");
  assert.match(queue.get(failed.id).error.message, /boom/);
  assert.equal(queue.get(later.id).status, "succeeded");
});

test("JobQueue persists completed job records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-api-jobs-"));
  const persistencePath = path.join(dir, "jobs.json");
  const queue = new JobQueue({ idPrefix: "testjob", persistencePath });
  const job = queue.enqueue("persisted", async () => ({ ok: true }));

  assert.deepEqual(await queue.wait(job.id), { ok: true });

  const restored = new JobQueue({ idPrefix: "testjob", persistencePath });
  assert.equal(restored.get(job.id).status, "succeeded");
  assert.deepEqual(restored.get(job.id).result, { ok: true });
});

test("JobQueue exposes queue statistics", async () => {
  const queue = new JobQueue({ idPrefix: "statsjob" });

  const first = queue.enqueue("first", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "first";
  });
  const second = queue.enqueue("second", async () => "second");

  const initial = queue.stats();
  assert.equal(initial.pending + initial.running, 2);
  assert.equal(initial.total, 2);

  await queue.wait(first.id);
  await queue.wait(second.id);

  const settled = queue.stats();
  assert.equal(settled.pending, 0);
  assert.equal(settled.running, 0);
  assert.equal(settled.total, 2);
  assert.equal(settled.succeeded, 2);
});

test("MediaStore persists generated media records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-api-media-"));
  const store = new MediaStore({ dataDir: dir, publicBaseUrl: "http://127.0.0.1:4242" });

  const record = await store.recordGeneratedMedia({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "A glass apple",
    outputPath: path.join(dir, "generated", "apple.png"),
    sourceUrl: "https://example.test/apple",
    metadata: { conversation_url: "https://chatgpt.com/c/test" },
  });

  assert.equal(record.object, "artifact");
  assert.equal(record.contract_version, "wcapi.artifact.v1");
  assert.equal(record.provider, "chatgpt-web");
  assert.equal(record.kind, "image");
  assert.equal(record.local_path, path.join(dir, "generated", "apple.png"));
  assert.equal(record.url, "http://127.0.0.1:4242/generated/apple.png");

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
});

test("SessionAffinityStore persists conversation bindings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-web-api-affinity-"));
  const store = new SessionAffinityStore({ filepath: path.join(dir, "session_affinity.json") });

  const saved = await store.set("conv_1", {
    provider_id: "chatgpt-web",
    model: "chatgpt-web",
    conversation_url: "https://chatgpt.com/c/test",
  });

  assert.equal(saved.conversation_id, "conv_1");
  assert.equal(saved.provider_id, "chatgpt-web");
  assert.equal((await store.get("conv_1")).conversation_url, "https://chatgpt.com/c/test");
  assert.equal((await store.list()).length, 1);
});

test("SessionLockRegistry serializes work for the same key only", async () => {
  const locks = new SessionLockRegistry();
  const order = [];

  const first = locks.run("conv_1", async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:end");
  });
  const second = locks.run("conv_1", async () => {
    order.push("second:start");
    order.push("second:end");
  });
  const other = locks.run("conv_2", async () => {
    order.push("other");
  });

  await Promise.all([first, second, other]);

  assert.deepEqual(order.filter((item) => item !== "other"), [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("normalizeApiError classifies common provider failures", () => {
  assert.equal(normalizeApiError(new ApiError("bad", { status: 400 })).status, 400);
  assert.equal(normalizeApiError(new Error("You're generating images too quickly")).status, 429);
  assert.equal(normalizeApiError(new Error("ChatGPT web is not logged in")).type, "authentication_error");
  assert.equal(normalizeApiError(new Error("send button not found")).code, "browser_dom_changed");
  const composerStale = normalizeApiError(new Error("Image composer stale-state: send button still disabled after fill"));
  assert.equal(composerStale.status, 502);
  assert.equal(composerStale.code, "browser_image_composer_stale");
  assert.equal(composerStale.meta?.operation, "images.generations");
  const composerInert = normalizeApiError(new Error("Image composer inert after synthetic input: send button still disabled"));
  assert.equal(composerInert.status, 502);
  assert.equal(composerInert.code, "browser_image_composer_inert");
  assert.equal(composerInert.meta?.retryable, false);
  const geminiTimeout = normalizeApiError(new Error("Gemini image generation timed out"));
  assert.equal(geminiTimeout.status, 504);
  assert.equal(geminiTimeout.type, "timeout_error");
  assert.equal(geminiTimeout.code, "gemini_image_generation_timeout");
  assert.equal(geminiTimeout.meta?.provider, "gemini-web");
});

test("ChatGPTWebProvider exposes provider-style metadata and delegates operations", async () => {
  const provider = new ChatGPTWebProvider({
    chatCompletion: async () => ({ content: "OK" }),
    chatCompletionStream: async () => ({ content: "OK" }),
    generateImage: async (prompt) => ({ prompt, output_path: "/tmp/out.png" }),
  });

  assert.equal(provider.id, "chatgpt-web");
  assert.deepEqual(
    provider.models().map((model) => model.id),
    ["chatgpt-web", "chatgpt-images"],
  );
  assert.equal(provider.capabilities.images, true);
  assert.deepEqual(await provider.generateImage("draw"), { prompt: "draw", output_path: "/tmp/out.png" });
});

test("GeminiWebProvider exposes canonical metadata and maps runtime HTTP responses", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });

    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        async json() {
          return {
            status: "ok",
            provider_id: "gemini-canvas",
            provider_id_canonical: "gemini-web",
            transport: {
              id: "gemini-web-runtime",
              type: "cookie-auth-web-runtime",
            },
          };
        },
      };
    }

    if (String(url).endsWith("/v1/chat/completions")) {
      return {
        ok: true,
        async json() {
          return {
            created: 123,
            model: "gemini-3-flash",
            choices: [{ message: { content: "GEMINI_WEB_RUNTIME_OK" } }],
            admission: "experimental",
          };
        },
      };
    }

    if (String(url).endsWith("/v1/images/generations")) {
      return {
        ok: true,
        async json() {
          return {
            created: 456,
            admission: "experimental",
            data: [
              {
                local_path: "/tmp/gemini-image.png",
                mime_type: "image/png",
                sha256: "abc123",
                source_url: "https://example.test/generated.png",
              },
            ],
          };
        },
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const provider = new GeminiWebProvider({
      runtimeBaseUrl: "http://127.0.0.1:7862",
      requestTimeoutMs: 5000,
    });

    assert.equal(provider.id, "gemini-web");
    assert.deepEqual(provider.aliases, ["gemini-canvas"]);
    assert.equal(provider.defaultImageModel(), "gemini-3-flash");
    assert.equal(provider.capabilities.streaming, false);
    assert.equal(provider.streaming_strategy, "single_event_degraded");
    assert.equal(provider.descriptor().route_meta["images.generations"].degraded, true);

    const chat = await provider.chatCompletion([{ role: "user", content: "hi" }], {
      model: "gemini-3-flash",
    });
    const streamed = await provider.chatCompletionStream([{ role: "user", content: "hi" }], {
      model: "gemini-3-flash",
    });
    const health = await provider.healthCheck();
    const image = await provider.generateImage("draw a cat", { model: "gemini-3-flash" });

    assert.equal(chat.content, "GEMINI_WEB_RUNTIME_OK");
    assert.equal(chat.streaming_strategy, "single_event_degraded");
    assert.equal(streamed.streaming_degraded, true);
    assert.equal(streamed.streaming_strategy, "single_event_degraded");
    assert.equal(chat.provider, "gemini-web");
    assert.equal(health.provider_id_canonical, "gemini-web");
    assert.equal(image.output_path, "/tmp/gemini-image.png");
    assert.equal(image.image_url, "https://example.test/generated.png");
    assert.equal(image.admission, "experimental");
    assert.equal(image.admission_detail.degraded, true);
    assert.equal(image.admission_detail.timeout_mode, "bounded");

    const imageRequest = calls.find((call) => String(call.url).endsWith("/v1/images/generations"));
    assert.ok(imageRequest, "image request must be issued");
    assert.match(String(imageRequest.options.body), /\"model\":\"gemini-3-flash\"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GeminiWebProvider preserves structured runtime image errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 504,
    async json() {
      return {
        detail: {
          message: "Gemini image generation timed out",
          type: "timeout_error",
          code: "gemini_image_generation_timeout",
          status: 504,
          meta: {
            provider: "gemini-web",
            operation: "images.generations",
            degraded: true,
          },
        },
      };
    },
  });

  try {
    const provider = new GeminiWebProvider();
    await assert.rejects(
      () => provider.generateImage("draw a cat", { model: "gemini-3-flash" }),
      (error) => {
        assert.equal(error.status, 504);
        assert.equal(error.type, "timeout_error");
        assert.equal(error.code, "gemini_image_generation_timeout");
        assert.equal(error.meta?.provider, "gemini-web");
        assert.equal(error.meta?.operation, "images.generations");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
