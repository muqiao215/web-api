import path from "node:path";

import { createArtifactStore } from "../../../packages/provider_artifacts/src/index.mjs";

export class MediaStore {
  constructor({ dataDir, publicBaseUrl }) {
    this.dataDir = dataDir;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    this.indexPath = path.join(dataDir, "media.json");
    this.store = createArtifactStore({
      indexPath: this.indexPath,
      publicBaseUrl: this.publicBaseUrl,
      publicPathPrefix: "/generated",
    });
  }

  async recordGeneratedMedia({ provider, kind, model, prompt, outputPath, sourceUrl = "", metadata = {} }) {
    return this.store.recordArtifact({
      provider,
      kind,
      model,
      prompt,
      localPath: outputPath,
      sourceUrl,
      metadata,
      idPrefix: "artifact",
    });
  }

  async list() {
    return this.store.listArtifacts();
  }
}
