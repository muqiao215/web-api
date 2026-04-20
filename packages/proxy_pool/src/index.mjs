/**
 * packages/proxy_pool — Proxy registry with health scoring.
 *
 * Model: aligned with packages/provider_contracts/schemas/proxy-pool.schema.json
 *
 * Design: factory pattern. createProxyPool() returns a pool object with query
 * and command methods. Proxy pool is optional — not all providers use proxies.
 *
 * Not todos:
 * - Does NOT store proxy credentials in plaintext beyond runtime memory.
 * - Does NOT perform health checks (caller drives that via recordSuccess/recordFailure).
 * - Does NOT auto-rotate credentials.
 */

import fs from "node:fs";
import path from "node:path";

export const PROXY_POOL_VERSION = "wcapi.proxy-pool.v1";

// ─── Proxy shape helpers ──────────────────────────────────────────────────

export function createProxy({
  id,
  url = "",
  protocol = "http",
  host = "",
  port,
  auth = null,
  bound_account_ids = [],
  geolocation = null,
  metadata = {},
} = {}) {
  return {
    id: String(id),
    enabled: true,
    url: String(url),
    protocol: String(protocol),
    host: String(host),
    port: Number(port) || 0,
    auth: auth ? { ...auth } : null,
    bound_account_ids: [...bound_account_ids],
    health: {
      score: 1.0,
      last_checked_at: null,
      failure_count: 0,
      cooldown_until: null,
      last_success_at: null,
      last_failure_at: null,
      status: "active", // active | degraded | cooldown | unavailable
    },
    geolocation: geolocation ? { ...geolocation } : null,
    metadata: { ...metadata },
  };
}

export function isProxyHealthy(proxy) {
  if (!proxy?.enabled) return false;
  const { status } = proxy.health || {};
  return status === "active" || status === "degraded";
}

export function isProxyCoolingDown(proxy) {
  if (!proxy?.health?.cooldown_until) return false;
  return new Date(proxy.health.cooldown_until) > new Date();
}

// ─── Pool factory ─────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.provider   - provider name
 * @param {string} [opts.dataPath] - optional path for file-backed persistence
 */
export function createProxyPool({ provider, dataPath = "" } = {}) {
  if (!provider) throw new Error("provider is required");

  const poolPolicy = {
    required_by_provider: false,
    health_check_interval_seconds: 120,
    failure_threshold: 3,
    cooldown_seconds: 300,
  };

  /** @type {Map<string, object>} */
  const proxies = new Map();

  // ─── Query methods ────────────────────────────────────────────────────

  function getPoolPolicy() {
    return { ...poolPolicy };
  }

  function getProvider() {
    return provider;
  }

  function setPoolPolicy(updates) {
    Object.assign(poolPolicy, updates);
  }

  function getProxy(id) {
    const proxy = proxies.get(String(id));
    return proxy ? deepClone(proxy) : null;
  }

  function listProxies({ enabledOnly = false } = {}) {
    return [...proxies.values()]
      .filter((p) => !enabledOnly || p.enabled)
      .map(deepClone)
      .sort((a, b) => b.health.score - a.health.score);
  }

  /**
   * Select the best available proxy — highest score, healthy, not cooling down.
   * Does NOT acquire a reservation; use recordSuccess/recordFailure to update scores.
   */
  function selectProxy() {
    const candidates = listProxies({ enabledOnly: true }).filter(
      (p) => isProxyHealthy(p) && !isProxyCoolingDown(p)
    );
    return candidates[0] || null;
  }

  /**
   * Return all healthy proxies.
   */
  function getHealthyProxies() {
    return listProxies({ enabledOnly: true }).filter((p) => isProxyHealthy(p) && !isProxyCoolingDown(p));
  }

  /**
   * Return proxies currently in cooldown.
   */
  function getCoolingDownProxies() {
    return listProxies().filter((p) => isProxyCoolingDown(p));
  }

  function toJSON() {
    return {
      contract_version: PROXY_POOL_VERSION,
      provider,
      pool_policy: { ...poolPolicy },
      proxies: listProxies(),
    };
  }

  // ─── Command methods ─────────────────────────────────────────────────

  /**
   * Add a proxy to the pool.
   */
  function addProxy(opts = {}) {
    const proxy = createProxy(opts);
    if (proxies.has(proxy.id)) {
      throw new Error(`Proxy ${proxy.id} already exists`);
    }
    proxies.set(proxy.id, proxy);
    persist();
    return deepClone(proxy);
  }

  /**
   * Remove a proxy by id.
   */
  function removeProxy(id) {
    if (!proxies.has(String(id))) {
      throw new Error(`Proxy ${id} not found`);
    }
    proxies.delete(String(id));
    persist();
  }

  /**
   * Update mutable fields on a proxy.
   */
  function updateProxy(id, updates = {}) {
    const proxy = proxies.get(String(id));
    if (!proxy) throw new Error(`Proxy ${id} not found`);
    if (updates.enabled !== undefined) proxy.enabled = updates.enabled;
    if (updates.url !== undefined) proxy.url = updates.url;
    if (updates.host !== undefined) proxy.host = updates.host;
    if (updates.port !== undefined) proxy.port = updates.port;
    if (updates.protocol !== undefined) proxy.protocol = updates.protocol;
    if (updates.bound_account_ids !== undefined) proxy.bound_account_ids = [...updates.bound_account_ids];
    if (updates.geolocation !== undefined) proxy.geolocation = updates.geolocation ? { ...updates.geolocation } : null;
    if (updates.metadata !== undefined) proxy.metadata = { ...updates.metadata };
    if (updates.health !== undefined) {
      proxy.health = { ...proxy.health, ...updates.health };
    }
    persist();
    return deepClone(proxy);
  }

  /**
   * Record a successful request through this proxy.
   * Improves health score, resets failure count, updates last_success_at.
   */
  function recordSuccess(id) {
    const proxy = proxies.get(String(id));
    if (!proxy) return;
    proxy.health.failure_count = 0;
    proxy.health.score = Math.min(1.0, proxy.health.score + 0.1);
    proxy.health.last_success_at = new Date().toISOString();
    proxy.health.last_checked_at = new Date().toISOString();
    if (proxy.health.status === "degraded") {
      proxy.health.status = "active";
    }
    persist();
  }

  /**
   * Record a failed request through this proxy.
   * Decrements health score, increments failure count, triggers cooldown at threshold.
   */
  function recordFailure(id, { reason = "" } = {}) {
    const proxy = proxies.get(String(id));
    if (!proxy) return;
    proxy.health.failure_count += 1;
    proxy.health.score = Math.max(0, proxy.health.score - 0.2);
    proxy.health.last_failure_at = new Date().toISOString();
    proxy.health.last_checked_at = new Date().toISOString();
    if (proxy.health.failure_count >= poolPolicy.failure_threshold) {
      proxy.health.status = "cooldown";
      proxy.health.cooldown_until = new Date(Date.now() + poolPolicy.cooldown_seconds * 1000).toISOString();
    } else if (proxy.health.failure_count > 0) {
      proxy.health.status = "degraded";
    }
    persist();
  }

  /**
   * Tick: expire stale cooldowns and reset degraded proxies on success.
   * Returns number of proxies cleaned up.
   */
  function tick() {
    let cleaned = 0;
    for (const proxy of proxies.values()) {
      if (
        proxy.health.cooldown_until &&
        new Date(proxy.health.cooldown_until) <= new Date() &&
        proxy.health.status === "cooldown"
      ) {
        proxy.health.status = "active";
        proxy.health.cooldown_until = null;
        proxy.health.failure_count = 0;
        cleaned++;
      }
    }
    if (cleaned > 0) persist();
    return cleaned;
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  function persist() {
    if (!dataPath) return;
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(toJSON(), null, 2));
  }

  function loadFromDisk() {
    if (!dataPath) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (raw.proxies) {
      for (const proxy of raw.proxies) {
        proxies.set(proxy.id, proxy);
      }
    }
    if (raw.pool_policy) {
      Object.assign(poolPolicy, raw.pool_policy);
    }
  }

  loadFromDisk();

  return {
    getPoolPolicy,
    getProvider,
    setPoolPolicy,
    getProxy,
    listProxies,
    selectProxy,
    getHealthyProxies,
    getCoolingDownProxies,
    toJSON,
    addProxy,
    removeProxy,
    updateProxy,
    recordSuccess,
    recordFailure,
    tick,
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
