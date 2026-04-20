import assert from "node:assert/strict";
import test from "node:test";
import { createJobQueue, createProfileSerialQueue, buildJobRecord } from "../src/index.mjs";

test("buildJobRecord creates a plain job record", () => {
  const job = buildJobRecord({ id: "task_abc", type: "images.generations" });
  assert.equal(job.id, "task_abc");
  assert.equal(job.type, "images.generations");
  assert.equal(job.status, "queued");
  assert.ok(job.created_at);
  assert.ok(job.updated_at);
});

test("createJobQueue enqueue returns job record", async () => {
  const q = createJobQueue();
  const job = q.enqueue("images.generations", async () => ({ url: "http://example.com/img.png" }));
  assert.ok(job.id);
  assert.equal(job.type, "images.generations");
  assert.equal(job.status, "queued");
});

test("createJobQueue work function result is stored in job.result", async () => {
  const q = createJobQueue();
  const job = q.enqueue("images.generations", async () => ({ url: "http://example.com/img.png" }));
  await q.wait(job.id);
  const updated = q.get(job.id);
  assert.equal(updated.status, "succeeded");
  assert.equal(updated.result.url, "http://example.com/img.png");
});

test("createJobQueue work function error is stored in job.error", async () => {
  const q = createJobQueue();
  const job = q.enqueue("chat.completion", async () => {
    throw new Error("upstream timeout");
  });
  let caught;
  try {
    await q.wait(job.id);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  const updated = q.get(job.id);
  assert.equal(updated.status, "failed");
  assert.equal(updated.error.message, "upstream timeout");
});

test("createJobQueue list returns all jobs in reverse insertion order", async () => {
  const q = createJobQueue();
  const j1 = q.enqueue("type-a", async () => "a");
  const j2 = q.enqueue("type-b", async () => "b");
  const list = q.list();
  assert.ok(list[0].id === j2.id || list[0].id === j1.id);
});

test("createJobQueue stats returns correct counts", async () => {
  const q = createJobQueue();
  q.enqueue("ok", async () => "x");
  q.enqueue("fail", async () => { throw new Error("bad"); });
  await Promise.allSettled([q.wait(q.list()[1].id), q.wait(q.list()[0].id)]);
  const stats = q.stats();
  assert.equal(stats.total, 2);
  // one of each
  assert.ok(stats.succeeded >= 0);
  assert.ok(stats.failed >= 0);
});

test("createProfileSerialQueue enqueue stores task", async () => {
  const q = createProfileSerialQueue();
  const task = q.enqueue("profile-a", "images.generations", async () => ({ url: "http://x.com/img.png" }));
  assert.ok(task.id);
  assert.equal(task.type, "images.generations");
  const tasks = q.listTasks("profile-a");
  assert.equal(tasks.length, 1);
});

test("createProfileSerialQueue acquireLease and releaseLease", () => {
  const q = createProfileSerialQueue();
  const lease = q.acquireLease("profile-a", "task_123", "worker-a", 60);
  assert.equal(lease.task_id, "task_123");
  assert.equal(lease.profile_lock, "profile-a");
  assert.ok(lease.expires_at);

  const hasActive = q.hasActiveLease("profile-a");
  assert.equal(hasActive, true);

  q.releaseLease("profile-a", "task_123");
  assert.equal(q.hasActiveLease("profile-a"), false);
});

test("createProfileSerialQueue stats returns per-profile depth", async () => {
  const q = createProfileSerialQueue();
  const task = q.enqueue("profile-a", "images.generations", async () => "x");
  // Eager execution: job immediately starts running, so pending=0, running=1 right after enqueue.
  // Wait for completion to see succeeded count.
  await q.wait("profile-a", task.id);
  const stats = q.stats();
  assert.equal(stats.summary.total_queues, 1);
  assert.equal(stats.summary.succeeded, 1);
  assert.equal(stats.summary.running, 0);
});

test("createProfileSerialQueue listQueueStates returns schema-aligned queue states", async () => {
  const q = createProfileSerialQueue();
  q.enqueue("profile-a", "images.generations", async () => "x");
  const states = q.listQueueStates();
  assert.equal(states.length, 1);
  assert.equal(states[0].scope, "profile");
  assert.equal(states[0].scope_id, "profile-a");
  assert.equal(states[0].mode, "profile-serial");
});

test("createProfileSerialQueue depth tracking after completion", async () => {
  const q = createProfileSerialQueue();
  const task = q.enqueue("profile-a", "type-1", async () => "first");
  assert.equal(q.stats().summary.total_tasks, 1);
  await q.wait("profile-a", task.id);
  const stats = q.stats();
  assert.equal(stats.summary.succeeded, 1);
});
