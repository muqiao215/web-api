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

  assert.equal(record.object, "media");
  assert.equal(record.provider, "chatgpt-web");
  assert.equal(record.kind, "image");
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
