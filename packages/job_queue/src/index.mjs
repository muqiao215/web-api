/**
 * packages/job_queue — Async task queue primitives with lease-aware admission.
 *
 * Model: aligned with packages/provider_contracts/schemas/queue-state.schema.json
 *         and image-task.schema.json.
 *
 * Provides:
 * - createJobQueue(): general async task queue backed by a Map, file-persistent.
 * - createProfileSerialQueue(): profile-scoped serial queue — one task per profile
 *   at a time. The lease prevents concurrent mutations to the same browser identity.
 *
 * Design: factory pattern. Both queues expose enqueue/get/list/stats.
 * ProfileSerialQueue additionally exposes acquireLease/releaseLease.
 *
 * Not todos:
 * - Does NOT integrate with external job brokers (SQS, Redis, etc.).
 * - Does NOT auto-retry failed tasks — caller handles retries via enqueue.
 */

import fs from "node:fs";
import path from "node:path";

export const JOB_QUEUE_VERSION = "wcapi.job-queue.v1";

// ─── Shared job state machine ─────────────────────────────────────────────

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "partial", "cancelled"];

/**
 * Build a plain job record (without the internal promise field).
 * @param {object} opts
 */
export function buildJobRecord({
  id,
  type,
  status = "queued",
  metadata = {},
  result = null,
  error = null,
} = {}) {
  const now = new Date().toISOString();
  return {
    id: String(id),
    object: "job",
    type: String(type),
    status,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
    metadata: { ...metadata },
    result,
    error,
  };
}

// ─── Generic async job queue ─────────────────────────────────────────────

/**
 * General-purpose async job queue. Suitable for image generation, chat, etc.
 *
 * @param {object} opts
 * @param {string} [opts.idPrefix="job"]
 * @param {number} [opts.maxJobs=200]
 * @param {string} [opts.dataPath=""]  — optional file persistence path
 */
export function createJobQueue({ idPrefix = "job", maxJobs = 200, dataPath = "" } = {}) {
  /** @type {Map<string, { job: object, promise: Promise }>} */
  const entries = new Map();
  let tail = Promise.resolve();

  function newId() {
    return `${idPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function serialize(entry) {
    const { promise: _p, ...job } = entry.job;
    return job;
  }

  function persist() {
    if (!dataPath) return;
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    const data = { jobs: [...entries.values()].map(serialize) };
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  }

  function load() {
    if (!dataPath) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    for (const job of raw.jobs || []) {
      const entry = {
        job: { ...job, promise: Promise.resolve(job.result ?? null) },
        promise: null,
      };
      // Interrupt any jobs that were in-progress at shutdown
      if (entry.job.status === "queued" || entry.job.status === "running") {
        entry.job.status = "failed";
        entry.job.error = { message: "Server restarted while job was in progress", name: "InterruptedJobError" };
        entry.job.finished_at = new Date().toISOString();
        entry.job.updated_at = entry.job.finished_at;
        entry.job.promise = Promise.resolve(null);
      }
      entries.set(entry.job.id, entry);
    }
  }

  load();

  function prune() {
    while (entries.size > maxJobs) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  /**
   * Enqueue a new job. The work function is executed sequentially in insertion order.
   * @param {string} type  — e.g. "images.generations", "chat.completion"
   * @param {Function} work  — async function returning a result
   * @param {object} [metadata={}]
   * @returns {object} the job record (without promise)
   */
  function enqueue(type, work, metadata = {}) {
    const id = newId();
    const job = buildJobRecord({ id, type, metadata });
    const entry = { job, promise: null };
    entries.set(id, entry);

    const run = tail.then(async () => {
      job.status = "running";
      job.started_at = new Date().toISOString();
      job.updated_at = job.started_at;
      persist();
      try {
        const result = await work();
        job.status = "succeeded";
        job.result = result;
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        persist();
        return result;
      } catch (err) {
        job.status = "failed";
        job.error = { message: String(err?.message || err), name: err?.name || "Error" };
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        persist();
        throw err;
      }
    });

    entry.promise = run;
    tail = run.catch(() => {});
    prune();
    persist();
    return serialize(entry);
  }

  function get(id) {
    const entry = entries.get(String(id));
    return entry ? serialize(entry) : null;
  }

  function list() {
    return [...entries.values()].map(serialize).reverse();
  }

  function stats() {
    const counts = { total: entries.size, pending: 0, running: 0, succeeded: 0, failed: 0, partial: 0, cancelled: 0 };
    for (const { job } of entries.values()) {
      if (JOB_STATUSES.includes(job.status)) counts[job.status]++;
    }
    return counts;
  }

  /**
   * Wait for a job to complete and return its result.
   * @param {string} id
   */
  async function wait(id) {
    const entry = entries.get(String(id));
    if (!entry) throw new Error(`Unknown job_id: ${id}`);
    return entry.promise;
  }

  return { enqueue, get, list, stats, wait };
}

// ─── Profile-serial queue ────────────────────────────────────────────────

/**
 * Profile-scoped serial queue. Ensures only one task runs per profile at a time.
 * Lease semantics: each active task holds a named profile lock.
 *
 * @param {object} opts
 * @param {string} [opts.dataPath=""]  — optional file persistence path
 */
export function createProfileSerialQueue({ dataPath = "" } = {}) {
  /**
   * @type {Map<string, {
   *   queue: object,  // queue-state.json shape
   *   entries: Map<string, { job: object, promise: Promise }>,
   *   tail: Promise
   * }>}
   */
  const queues = new Map();

  function getOrCreateQueue(scopeId) {
    if (!queues.has(scopeId)) {
      queues.set(scopeId, {
        queue: {
          scope: "profile",
          scope_id: scopeId,
          mode: "profile-serial",
          enabled: true,
          depth: { pending: 0, running: 0, completed: 0, failed: 0 },
          capacity: { max_pending: 10, max_concurrent: 1 },
          leases: [],
          lock_policy: { scope: "profile", implementation: "job_queue.profile_serial" },
          cooldown: null,
          metadata: {},
        },
        entries: new Map(),
        tail: Promise.resolve(),
      });
    }
    return queues.get(scopeId);
  }

  function serializeQueue(q) {
    return {
      ...q.queue,
      depth: { ...q.queue.depth },
      leases: q.queue.leases.map((l) => ({ ...l })),
    };
  }

  function newId(prefix = "task") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function toJSON() {
    return {
      contract_version: JOB_QUEUE_VERSION,
      queues: [...queues.values()].map(serializeQueue),
    };
  }

  function persist() {
    if (!dataPath) return;
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(toJSON(), null, 2));
  }

  function load() {
    if (!dataPath) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    for (const q of raw.queues || []) {
      if (!q.scope_id) continue;
      const entry = getOrCreateQueue(q.scope_id);
      entry.queue = { ...q };
      // Reset running jobs to failed on restart
      for (const e of entry.entries.values()) {
        if (e.job.status === "running" || e.job.status === "queued") {
          e.job.status = "failed";
          e.job.error = { message: "Server restarted while task was in progress", name: "InterruptedJobError" };
        }
      }
    }
  }

  load();

  /**
   * Enqueue a task for a specific profile. Blocked if that profile already has a running task.
   * @param {string} profileId
   * @param {string} type
   * @param {Function} work  — async function
   * @param {object} [metadata={}]
   */
  function enqueue(profileId, type, work, metadata = {}) {
    const q = getOrCreateQueue(String(profileId));

    // Respect capacity
    if (q.entries.size >= q.queue.capacity.max_pending) {
      throw new Error(`Queue for profile ${profileId} is at max pending capacity (${q.queue.capacity.max_pending})`);
    }

    const id = newId("task");
    const job = buildJobRecord({ id, type, metadata });
    q.entries.set(id, { job, promise: null });

    const run = q.tail.then(async () => {
      job.status = "running";
      job.started_at = new Date().toISOString();
      job.updated_at = job.started_at;
      q.queue.depth.running++;
      persist();
      try {
        const result = await work();
        job.status = "succeeded";
        job.result = result;
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        q.queue.depth.running--;
        q.queue.depth.completed++;
        persist();
        return result;
      } catch (err) {
        job.status = "failed";
        job.error = { message: String(err?.message || err), name: err?.name || "Error" };
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        q.queue.depth.running--;
        q.queue.depth.failed++;
        persist();
        throw err;
      }
    });

    q.entries.get(id).promise = run;
    q.tail = run.catch(() => {});
    q.queue.depth.pending = q.entries.size;
    persist();
    return { ...job };
  }

  /**
   * Acquire a lease on a profile (marks the profile as "busy" with a specific task).
   * @param {string} profileId
   * @param {string} taskId
   * @param {string} leasedBy
   * @param {number} [ttlSeconds=300]
   */
  function acquireLease(profileId, taskId, leasedBy, ttlSeconds = 300) {
    const q = getOrCreateQueue(String(profileId));
    const now = new Date();
    const lease = {
      task_id: String(taskId),
      profile_lock: String(profileId),
      leased_by: String(leasedBy),
      leased_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
    q.queue.leases = q.queue.leases.filter((l) => !isLeaseExpired(l));
    q.queue.leases.push(lease);
    persist();
    return { ...lease };
  }

  /**
   * Release the lease held by a task on a profile.
   * @param {string} profileId
   * @param {string} taskId
   */
  function releaseLease(profileId, taskId) {
    const q = queues.get(String(profileId));
    if (!q) return;
    q.queue.leases = q.queue.leases.filter(
      (l) => !(l.task_id === String(taskId) && l.profile_lock === String(profileId))
    );
    persist();
  }

  /**
   * Check if a profile has an active (non-expired) lease.
   * @param {string} profileId
   */
  function hasActiveLease(profileId) {
    const q = queues.get(String(profileId));
    if (!q) return false;
    return q.queue.leases.some((l) => l.profile_lock === String(profileId) && !isLeaseExpired(l));
  }

  function get(profileId, taskId) {
    const q = queues.get(String(profileId));
    if (!q) return null;
    const entry = q.entries.get(String(taskId));
    if (!entry) return null;
    const { promise: _p, ...job } = entry.job;
    return job;
  }

  function listTasks(profileId) {
    const q = queues.get(String(profileId));
    if (!q) return [];
    return [...q.entries.values()].map((e) => {
      const { promise: _p, ...job } = e.job;
      return job;
    });
  }

  function listAllTasks() {
    const result = [];
    for (const [scopeId, q] of queues.entries()) {
      for (const e of q.entries.values()) {
        const { promise: _p, ...job } = e.job;
        result.push({ ...job, _scope_id: scopeId });
      }
    }
    return result;
  }

  /**
   * Summary stats across all profile queues.
   */
  function stats() {
    const summary = { total_queues: queues.size, total_tasks: 0, pending: 0, running: 0, succeeded: 0, failed: 0 };
    const byProfile = {};
    for (const [scopeId, q] of queues.entries()) {
      const depth = { pending: 0, running: 0, completed: 0, failed: 0 };
      for (const e of q.entries.values()) {
        summary.total_tasks++;
        if (depth[e.job.status] !== undefined) depth[e.job.status]++;
        if (summary[e.job.status] !== undefined) summary[e.job.status]++;
      }
      byProfile[scopeId] = { ...depth, leases: q.queue.leases.filter((l) => !isLeaseExpired(l)).length };
    }
    return { summary, byProfile };
  }

  function listQueueStates() {
    return [...queues.values()].map(serializeQueue);
  }

  async function wait(profileId, taskId) {
    const q = queues.get(String(profileId));
    if (!q) throw new Error(`Unknown profile_id: ${profileId}`);
    const entry = q.entries.get(String(taskId));
    if (!entry) throw new Error(`Unknown task_id: ${taskId}`);
    return entry.promise;
  }

  return {
    enqueue,
    get,
    listTasks,
    listAllTasks,
    stats,
    listQueueStates,
    acquireLease,
    releaseLease,
    hasActiveLease,
    wait,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isLeaseExpired(lease) {
  if (!lease?.expires_at) return false;
  return new Date(lease.expires_at) <= new Date();
}
