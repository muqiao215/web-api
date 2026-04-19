import fs from "node:fs/promises";
import path from "node:path";

export class MediaStore {
  constructor({ dataDir, publicBaseUrl }) {
    this.dataDir = dataDir;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    this.indexPath = path.join(dataDir, "media.json");
  }

  async readIndex() {
    try {
      return JSON.parse(await fs.readFile(this.indexPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async writeIndex(index) {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  async recordGeneratedMedia({ provider, kind, model, prompt, outputPath, sourceUrl = "", metadata = {} }) {
    const id = `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const filename = path.basename(outputPath);
    const record = {
      id,
      object: "media",
      provider,
      kind,
      model,
      prompt,
      created_at: Math.floor(Date.now() / 1000),
      output_path: outputPath,
      url: `${this.publicBaseUrl}/generated/${filename}`,
      source_url: sourceUrl,
      metadata,
    };
    const index = await this.readIndex();
    index[id] = record;
    await this.writeIndex(index);
    return record;
  }

  async list() {
    const index = await this.readIndex();
    return Object.values(index).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }
}
