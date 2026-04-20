import fs from "node:fs";
import path from "node:path";

export class JobQueue {
  constructor({ idPrefix = "job", maxJobs = 200, persistencePath = "" } = {}) {
    this.idPrefix = idPrefix;
    this.maxJobs = maxJobs;
    this.persistencePath = persistencePath;
    this.jobs = new Map();
    this.tail = Promise.resolve();
    this.load();
  }

  enqueue(type, work, metadata = {}) {
    const id = `${this.idPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const job = {
      id,
      object: "job",
      type,
      status: "queued",
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
      metadata,
      result: null,
      error: null,
    };

    this.jobs.set(id, job);
    this.prune();
    this.persist();

    const run = this.tail.then(async () => {
      job.status = "running";
      job.started_at = new Date().toISOString();
      job.updated_at = job.started_at;
      this.persist();
      try {
        const result = await work();
        job.status = "succeeded";
        job.result = result;
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        this.persist();
        return result;
      } catch (error) {
        job.status = "failed";
        job.error = {
          message: String(error?.message || error),
          name: error?.name || "Error",
        };
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        this.persist();
        throw error;
      }
    });

    job.promise = run;
    this.tail = run.catch(() => {});
    return this.serialize(job);
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.serialize(job) : null;
  }

  list() {
    return [...this.jobs.values()].map((job) => this.serialize(job)).reverse();
  }

  stats() {
    const counts = {
      total: this.jobs.size,
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        counts.pending += 1;
        continue;
      }
      if (Object.hasOwn(counts, job.status)) {
        counts[job.status] += 1;
      }
    }
    return counts;
  }

  async wait(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job_id: ${id}`);
    return job.promise;
  }

  serialize(job) {
    const { promise: _promise, ...plain } = job;
    return plain;
  }

  prune() {
    while (this.jobs.size > this.maxJobs) {
      const oldest = this.jobs.keys().next().value;
      this.jobs.delete(oldest);
    }
    this.persist();
  }

  load() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }

    const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8"));
    for (const persisted of raw.jobs || []) {
      const job = {
        ...persisted,
        promise: Promise.resolve(persisted.result ?? null),
      };
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = {
          message: "Server restarted while job was in progress",
          name: "InterruptedJobError",
        };
        job.finished_at = new Date().toISOString();
        job.updated_at = job.finished_at;
        job.promise = Promise.resolve(null);
      }
      this.jobs.set(job.id, job);
    }
  }

  persist() {
    if (!this.persistencePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
    const data = {
      jobs: [...this.jobs.values()].map((job) => this.serialize(job)),
    };
    fs.writeFileSync(this.persistencePath, JSON.stringify(data, null, 2));
  }
}
