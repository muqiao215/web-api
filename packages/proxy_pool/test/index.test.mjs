import assert from "node:assert/strict";
import test from "node:test";
import { createProxyPool, createProxy, isProxyHealthy } from "../src/index.mjs";

test("createProxyPool creates an empty pool", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  assert.equal(pool.listProxies().length, 0);
  assert.equal(pool.getPoolPolicy().failure_threshold, 3);
});

test("addProxy inserts and returns proxy", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  const proxy = pool.addProxy({ id: "px1", host: "1.2.3.4", port: 8080 });
  assert.equal(proxy.id, "px1");
  assert.equal(proxy.host, "1.2.3.4");
  assert.equal(proxy.port, 8080);
  assert.equal(proxy.enabled, true);
});

test("selectProxy returns highest-score healthy proxy", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "slow", host: "1.2.3.4", port: 80 });
  pool.updateProxy("slow", { health: { score: 0.3 } });
  pool.addProxy({ id: "fast", host: "5.6.7.8", port: 80 });
  pool.updateProxy("fast", { health: { score: 0.9 } });
  const selected = pool.selectProxy();
  assert.equal(selected.id, "fast");
});

test("recordSuccess improves score and resets failure_count", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "px1", host: "1.2.3.4", port: 80 });
  pool.updateProxy("px1", { health: { score: 0.4, failure_count: 2 } });
  pool.recordSuccess("px1");
  const proxy = pool.getProxy("px1");
  assert.equal(proxy.health.failure_count, 0);
  assert.ok(proxy.health.score > 0.4);
});

test("recordFailure decrements score and triggers cooldown at threshold", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "px1", host: "1.2.3.4", port: 80 });
  // failure_threshold is 3 by default
  pool.updateProxy("px1", { health: { score: 0.6, failure_count: 2 } });
  pool.recordFailure("px1");
  const proxy = pool.getProxy("px1");
  assert.equal(proxy.health.failure_count, 3);
  assert.equal(proxy.health.status, "cooldown");
  assert.ok(proxy.health.cooldown_until);
});

test("recordFailure with reason sets last_failure_at", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "px1", host: "1.2.3.4", port: 80 });
  pool.recordFailure("px1", { reason: "connection refused" });
  const proxy = pool.getProxy("px1");
  assert.ok(proxy.health.last_failure_at);
});

test("tick() expires cooldown and resets proxy to active", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "px1", host: "1.2.3.4", port: 80 });
  pool.updateProxy("px1", {
    health: {
      status: "cooldown",
      cooldown_until: new Date(Date.now() - 1_000).toISOString(), // expired 1s ago
      failure_count: 3,
    },
  });
  const cleaned = pool.tick();
  assert.ok(cleaned >= 1);
  const proxy = pool.getProxy("px1");
  assert.equal(proxy.health.status, "active");
  assert.equal(proxy.health.cooldown_until, null);
});

test("toJSON returns schema-aligned shape", () => {
  const pool = createProxyPool({ provider: "chatgpt-web" });
  pool.addProxy({ id: "px1", host: "1.2.3.4", port: 8080 });
  const json = pool.toJSON();
  assert.equal(json.contract_version, "wcapi.proxy-pool.v1");
  assert.equal(json.provider, "chatgpt-web");
  assert.ok(Array.isArray(json.proxies));
  assert.equal(json.proxies[0].id, "px1");
});
