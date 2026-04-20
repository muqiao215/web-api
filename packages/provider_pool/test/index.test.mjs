import assert from "node:assert/strict";
import test from "node:test";
import { createProviderPool, createAccount, isLeaseValid } from "../src/index.mjs";

test("createProviderPool creates an empty pool", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  assert.equal(pool.listAccounts().length, 0);
  assert.equal(pool.getPoolPolicy().max_concurrent_leases, 1);
});

test("addAccount inserts and returns account", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  const account = pool.addAccount({ id: "acct1", label: "primary" });
  assert.equal(account.id, "acct1");
  assert.equal(account.label, "primary");
  assert.equal(account.enabled, true);
  assert.equal(pool.listAccounts().length, 1);
});

test("addAccount throws on duplicate id", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1", label: "first" });
  assert.throws(() => pool.addAccount({ id: "acct1", label: "second" }), /already exists/);
});

test("selectAccount returns highest-priority healthy unleased account", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "low", label: "low priority", priority: 1 });
  pool.addAccount({ id: "high", label: "high priority", priority: 10 });
  pool.addAccount({ id: "disabled", label: "disabled", priority: 100, enabled: false });
  const selected = pool.selectAccount();
  assert.equal(selected.id, "high");
});

test("acquireLease sets lease and returns it", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  const result = pool.acquireLease("acct1", "task_123", "worker-a");
  assert.ok(result);
  assert.equal(result.lease.task_id, "task_123");
  assert.equal(result.lease.leased_by, "worker-a");
  assert.ok(result.lease.expires_at);
});

test("acquireLease fails for already-leased account", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  const first = pool.acquireLease("acct1", "task_a", "worker-a");
  assert.ok(first);
  const second = pool.acquireLease("acct1", "task_b", "worker-b");
  assert.equal(second, null); // cannot double-lease
});

test("acquireLease fails for cooling-down account", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  pool.updateHealth("acct1", { status: "cooldown", cooldown_until: new Date(Date.now() + 60_000).toISOString() });
  const result = pool.acquireLease("acct1", "task_123", "worker-a");
  assert.equal(result, null);
});

test("releaseLease clears the lease", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  pool.acquireLease("acct1", "task_123", "worker-a");
  pool.releaseLease("acct1");
  const account = pool.getAccount("acct1");
  assert.equal(account.lease, null);
});

test("tick() returns number of cleaned accounts", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  // tick() should return 0 when nothing needs cleaning
  const cleaned = pool.tick();
  assert.equal(cleaned, 0);
});

test("selectAccount excludes accounts with expired leases", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1", priority: 10 });
  pool.addAccount({ id: "acct2", priority: 5 });
  // acct1 is selected first
  const first = pool.selectAccount();
  assert.equal(first.id, "acct1");
  // After acquiring lease on acct1, selectAccount should return acct2
  pool.acquireLease("acct1", "task_1", "worker-a");
  const second = pool.selectAccount();
  assert.equal(second.id, "acct2");
});

test("updateHealth sets health fields", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  pool.updateHealth("acct1", { status: "degraded", failure_count: 3, direct_worker_ok: true });
  const account = pool.getAccount("acct1");
  assert.equal(account.health.status, "degraded");
  assert.equal(account.health.failure_count, 3);
  assert.equal(account.health.direct_worker_ok, true);
});

test("recordUsage increments counters", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1" });
  pool.recordUsage("acct1", { requestsDelta: 5, imagesDelta: 2 });
  const account = pool.getAccount("acct1");
  assert.equal(account.usage.requests_count, 5);
  assert.equal(account.usage.images_count, 2);
  assert.ok(account.usage.last_used_at);
});

test("toJSON returns schema-aligned shape", () => {
  const pool = createProviderPool({ provider: "chatgpt-web" });
  pool.addAccount({ id: "acct1", label: "primary" });
  const json = pool.toJSON();
  assert.equal(json.contract_version, "wcapi.provider-pool.v1");
  assert.equal(json.provider, "chatgpt-web");
  assert.ok(Array.isArray(json.accounts));
  assert.equal(json.accounts[0].id, "acct1");
});
