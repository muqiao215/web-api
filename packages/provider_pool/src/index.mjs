/**
 * packages/provider_pool — Account/profile registry for provider workers.
 *
 * Model: aligned with packages/provider_contracts/schemas/account-pool.schema.json
 *
 * Design: factory pattern. createProviderPool() returns a pool object with
 * query methods (list, get, select) and command methods (add, remove, lease,
 * release, health, usage). File-backed persistence is optional and opt-in.
 *
 * Not todos:
 * - Does NOT manage sub2api keys or external auth credentials.
 * - Does NOT perform health checks (caller drives that via updateHealth).
 * - Does NOT auto-expire leases — caller must call release() or run tick().
 */

import fs from "node:fs";
import path from "node:path";

export const PROVIDER_POOL_VERSION = "wcapi.provider-pool.v1";

// ─── Account shape helpers ─────────────────────────────────────────────────

export function createAccount({
  id,
  label,
  enabled = true,
  priority = 0,
  caps = {},
  upstream = {},
  metadata = {},
} = {}) {
  return {
    id: String(id),
    label: String(label),
    enabled: Boolean(enabled),
    priority: Number(priority),
    caps: { ...caps },
    lease: null,
    health: {
      status: "healthy", // healthy | degraded | cooldown | locked | unavailable
      last_checked_at: null,
      direct_worker_ok: null,
      sub2api_smoke_ok: null,
      failure_count: 0,
      cooldown_until: null,
      reason: null,
    },
    usage: {
      requests_count: 0,
      images_count: 0,
      last_used_at: null,
    },
    upstream: { ...upstream },
    metadata: { ...metadata },
  };
}

export function isAccountHealthy(account) {
  if (!account?.enabled) return false;
  const { status } = account.health || {};
  return status === "healthy" || status === "degraded";
}

export function isAccountCoolingDown(account) {
  if (!account?.health?.cooldown_until) return false;
  return new Date(account.health.cooldown_until) > new Date();
}

export function isLeaseValid(lease) {
  if (!lease) return false;
  if (!lease.expires_at) return false;
  return new Date(lease.expires_at) > new Date();
}

// ─── Pool factory ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.provider  - provider name (e.g. "chatgpt-web")
 * @param {string} [opts.dataPath] - optional path for file-backed persistence
 */
export function createProviderPool({ provider, dataPath = "" } = {}) {
  if (!provider) throw new Error("provider is required");

  const poolPolicy = {
    max_concurrent_leases: 1,
    lease_ttl_seconds: 300,
    cooldown_seconds: 0,
    health_check_interval_seconds: 60,
    require_sub2api_smoke: true,
  };

  /** @type {Map<string, object>} */
  const accounts = new Map();

  // ─── Query methods ─────────────────────────────────────────────────────

  function getPoolPolicy() {
    return { ...poolPolicy };
  }

  function getProvider() {
    return provider;
  }

  function setPoolPolicy(updates) {
    Object.assign(poolPolicy, updates);
  }

  function getAccount(id) {
    const account = accounts.get(String(id));
    if (!account) return null;
    return deepClone(account);
  }

  function listAccounts({ enabledOnly = false } = {}) {
    const list = [...accounts.values()];
    return list
      .filter((a) => !enabledOnly || a.enabled)
      .map(deepClone)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Select the best available account for a task — read-only.
   * Returns the top-priority enabled account that is healthy and not cooling down.
   * Does NOT acquire a lease. Use acquireLease() for that.
   */
  function selectAccount() {
    const candidates = listAccounts({ enabledOnly: true }).filter(
      (a) => isAccountHealthy(a) && !isLeaseValid(a.lease) && !isAccountCoolingDown(a)
    );
    return candidates[0] || null;
  }

  /**
   * Return all accounts that are currently usable (enabled + healthy + no valid lease).
   */
  function getAvailableAccounts() {
    return listAccounts({ enabledOnly: true }).filter(
      (a) => isAccountHealthy(a) && !isLeaseValid(a.lease) && !isAccountCoolingDown(a)
    );
  }

  /**
   * Return accounts with an active (non-expired) lease.
   */
  function getLeasedAccounts() {
    return listAccounts().filter((a) => isLeaseValid(a.lease));
  }

  function toJSON() {
    return {
      contract_version: PROVIDER_POOL_VERSION,
      provider,
      pool_policy: { ...poolPolicy },
      accounts: listAccounts(),
    };
  }

  // ─── Command methods ───────────────────────────────────────────────────

  /**
   * Add a new account to the pool. Throws if id already exists.
   */
  function addAccount(opts = {}) {
    const account = createAccount(opts);
    if (accounts.has(account.id)) {
      throw new Error(`Account ${account.id} already exists`);
    }
    accounts.set(account.id, account);
    persist();
    return deepClone(account);
  }

  /**
   * Remove an account by id. Throws if not found.
   */
  function removeAccount(id) {
    if (!accounts.has(String(id))) {
      throw new Error(`Account ${id} not found`);
    }
    accounts.delete(String(id));
    persist();
  }

  /**
   * Update mutable fields on an existing account. Shallow-merge for health/usage.
   * @param {string} id
   * @param {object} updates  — { label?, enabled?, priority?, caps?, health?, usage?, upstream?, metadata? }
   */
  function updateAccount(id, updates = {}) {
    const account = accounts.get(String(id));
    if (!account) throw new Error(`Account ${id} not found`);
    if (updates.label !== undefined) account.label = updates.label;
    if (updates.enabled !== undefined) account.enabled = updates.enabled;
    if (updates.priority !== undefined) account.priority = updates.priority;
    if (updates.caps !== undefined) account.caps = { ...updates.caps };
    if (updates.upstream !== undefined) account.upstream = { ...updates.upstream };
    if (updates.metadata !== undefined) account.metadata = { ...updates.metadata };
    if (updates.health !== undefined) {
      account.health = { ...account.health, ...updates.health };
    }
    if (updates.usage !== undefined) {
      account.usage = { ...account.usage, ...updates.usage };
    }
    persist();
    return deepClone(account);
  }

  /**
   * Acquire a lease on an account for a given task.
   * @param {string} accountId
   * @param {string} taskId
   * @param {string} leasedBy  - worker/agent identifier
   * @returns {{ account: object, lease: object }} or null if acquisition failed
   */
  function acquireLease(accountId, taskId, leasedBy) {
    const account = accounts.get(String(accountId));
    if (!account) throw new Error(`Account ${accountId} not found`);

    if (!account.enabled) return null;
    if (isAccountCoolingDown(account)) return null;
    if (isLeaseValid(account.lease)) return null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + poolPolicy.lease_ttl_seconds * 1000);
    account.lease = {
      task_id: String(taskId),
      leased_by: String(leasedBy),
      leased_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    persist();
    return { account: deepClone(account), lease: deepClone(account.lease) };
  }

  /**
   * Release the lease on an account. Idempotent — clearing an already-null lease is a no-op.
   */
  function releaseLease(accountId) {
    const account = accounts.get(String(accountId));
    if (!account) return;
    account.lease = null;
    persist();
  }

  /**
   * Record successful usage on an account. Increments counters and updates last_used_at.
   */
  function recordUsage(accountId, { requestsDelta = 0, imagesDelta = 0 } = {}) {
    const account = accounts.get(String(accountId));
    if (!account) return;
    account.usage.requests_count = Math.max(0, account.usage.requests_count + requestsDelta);
    account.usage.images_count = Math.max(0, account.usage.images_count + imagesDelta);
    account.usage.last_used_at = new Date().toISOString();
    persist();
  }

  /**
   * Update health status for an account.
   * @param {string} accountId
   * @param {object} healthUpdate  — partial Health object
   */
  function updateHealth(accountId, healthUpdate = {}) {
    const account = accounts.get(String(accountId));
    if (!account) return;
    account.health = { ...account.health, ...healthUpdate };
    if (healthUpdate.status) {
      // If health status is set to "cooldown" by caller, ensure cooldown_until is populated
      if (healthUpdate.status === "cooldown" && poolPolicy.cooldown_seconds > 0 && !account.health.cooldown_until) {
        account.health.cooldown_until = new Date(
          Date.now() + poolPolicy.cooldown_seconds * 1000
        ).toISOString();
      }
    }
    persist();
  }

  /**
   * Tick: expire stale leases and cooling-down accounts.
   * Returns the number of accounts cleaned up.
   */
  function tick() {
    let cleaned = 0;
    for (const account of accounts.values()) {
      // Expire stale leases
      if (account.lease && !isLeaseValid(account.lease)) {
        account.lease = null;
        cleaned++;
      }
      // Expire stale cooldown
      if (
        account.health?.cooldown_until &&
        new Date(account.health.cooldown_until) <= new Date() &&
        account.health.status === "cooldown"
      ) {
        account.health.status = "healthy";
        account.health.cooldown_until = null;
        cleaned++;
      }
    }
    if (cleaned > 0) persist();
    return cleaned;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  function persist() {
    if (!dataPath) return;
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(toJSON(), null, 2));
  }

  function loadFromDisk() {
    if (!dataPath) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (raw.accounts) {
      for (const account of raw.accounts) {
        accounts.set(account.id, account);
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
    getAccount,
    listAccounts,
    selectAccount,
    getAvailableAccounts,
    getLeasedAccounts,
    toJSON,
    addAccount,
    removeAccount,
    updateAccount,
    acquireLease,
    releaseLease,
    recordUsage,
    updateHealth,
    tick,
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
