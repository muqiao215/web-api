export class SessionLockRegistry {
  constructor() {
    this.locks = new Map();
  }

  async run(key, work) {
    if (!key) {
      return work();
    }

    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const nextTail = previous.catch(() => {}).then(() => current);
    this.locks.set(key, nextTail);

    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      queueMicrotask(() => {
        if (this.locks.get(key) === nextTail) {
          this.locks.delete(key);
        }
      });
    }
  }

  size() {
    return this.locks.size;
  }
}
