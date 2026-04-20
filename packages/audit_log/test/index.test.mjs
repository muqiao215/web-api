import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAuditLogger, validateEvent, AUDIT_EVENT_TYPES } from "../src/index.mjs";

test("validateEvent accepts a valid minimal event", () => {
  const result = validateEvent({
    id: "evt_001",
    event_type: "task_completed",
    actor: { type: "worker" },
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateEvent rejects missing id", () => {
  const result = validateEvent({
    event_type: "task_completed",
    actor: { type: "worker" },
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("validateEvent rejects unknown event_type", () => {
  const result = validateEvent({
    id: "evt_001",
    event_type: "not_a_real_event",
    actor: { type: "worker" },
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("event_type")));
});

test("validateEvent rejects unknown actor.type", () => {
  const result = validateEvent({
    id: "evt_001",
    event_type: "task_completed",
    actor: { type: "unknown_actor" },
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("actor.type")));
});

test("createAuditLogger writes a JSON line to audit.jsonl", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  const { id, event } = logger.log({
    id: "evt_test_001",
    event_type: "task_completed",
    actor: { type: "worker", id: "w1" },
    task_id: "task_abc",
    success: true,
    duration_ms: 150,
  });
  assert.equal(id, "evt_test_001");
  assert.equal(event.event_type, "task_completed");
  assert.equal(event.actor.type, "worker");
  assert.equal(event.contract_version, "wcapi.audit-log.v1");
  // Verify file contents
  const lines = (await fs.promises.readFile(path.join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, "evt_test_001");
  assert.equal(parsed.event_type, "task_completed");
});

test("createAuditLogger auto-fills missing required fields", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  const { id, event } = logger.log({
    event_type: "health_check",
    actor: { type: "system" },
  });
  assert.ok(id.startsWith("audit_"));
  assert.equal(event.contract_version, "wcapi.audit-log.v1");
  assert.ok(event.timestamp);
});

test("createAuditLogger list() returns all events", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  logger.log({ id: "evt_a", event_type: "task_completed", actor: { type: "worker" } });
  logger.log({ id: "evt_b", event_type: "task_failed", actor: { type: "worker" } });
  const events = logger.list();
  assert.equal(events.length, 2);
  const ids = events.map((e) => e.id).sort();
  assert.deepEqual(ids, ["evt_a", "evt_b"]);
});

test("createAuditLogger query() filters by event_type", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  logger.log({ id: "evt_a", event_type: "task_completed", actor: { type: "worker" } });
  logger.log({ id: "evt_b", event_type: "task_failed", actor: { type: "worker" } });
  logger.log({ id: "evt_c", event_type: "task_completed", actor: { type: "scheduler" } });
  const completed = logger.query({ event_type: "task_completed" });
  assert.equal(completed.length, 2);
  const failed = logger.query({ event_type: "task_failed" });
  assert.equal(failed.length, 1);
});

test("createAuditLogger query() filters by actor_type", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  logger.log({ id: "evt_a", event_type: "task_completed", actor: { type: "worker" } });
  logger.log({ id: "evt_b", event_type: "task_completed", actor: { type: "scheduler" } });
  const workers = logger.query({ actor_type: "worker" });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].id, "evt_a");
});

test("createAuditLogger query() filters by since timestamp", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  const before = new Date(Date.now() - 10_000).toISOString();
  logger.log({ id: "evt_old", event_type: "task_completed", actor: { type: "worker" }, timestamp: before });
  // Log evt_new and capture its auto-filled timestamp so we can query for strictly newer events
  const { event: evt_new_full } = logger.log({
    id: "evt_new",
    event_type: "task_completed",
    actor: { type: "worker" },
  });
  // Query with evt_new's actual timestamp — only evt_new (timestamp=now) satisfies >= now
  const recent = logger.query({ since: evt_new_full.timestamp });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, "evt_new");
});

test("createAuditLogger throws on invalid event when validate=true", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  // enrich=false so validation runs on the raw partial event before any auto-fill
  const logger = createAuditLogger({ dataDir: dir, validate: true, enrich: false });
  assert.throws(
    () =>
      logger.log({
        // missing id, event_type, actor
        timestamp: new Date().toISOString(),
      }),
    /Invalid audit event/
  );
});

test("createAuditLogger throws on unknown event_type when validate=true", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir, validate: true });
  assert.throws(
    () =>
      logger.log({
        id: "evt_001",
        event_type: "not_real",
        actor: { type: "system" },
      }),
    /Invalid audit event/
  );
});

test("createAuditLogger auditPath() returns the file path", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wcapi-audit-"));
  const logger = createAuditLogger({ dataDir: dir });
  assert.equal(logger.auditPath(), path.join(dir, "audit.jsonl"));
});
