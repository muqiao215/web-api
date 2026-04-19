import fs from "node:fs/promises";
import path from "node:path";

export class SessionAffinityStore {
  constructor({ filepath }) {
    this.filepath = filepath;
  }

  async readAll() {
    try {
      return JSON.parse(await fs.readFile(this.filepath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async writeAll(records) {
    await fs.mkdir(path.dirname(this.filepath), { recursive: true });
    await fs.writeFile(this.filepath, JSON.stringify(records, null, 2));
  }

  async get(conversationId) {
    const records = await this.readAll();
    return records[conversationId] || null;
  }

  async set(conversationId, record) {
    const records = await this.readAll();
    records[conversationId] = {
      ...(records[conversationId] || {}),
      ...record,
      conversation_id: conversationId,
      updated_at: new Date().toISOString(),
    };
    await this.writeAll(records);
    return records[conversationId];
  }

  async list() {
    const records = await this.readAll();
    return Object.values(records).sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || ""))
    );
  }
}
