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

  async recordGeneratedMedia({ provider, kind, model, prompt, outputPath, sourceUrl = "", metadata = {}, id = "", mimeType = "", sha256 = "", width = null, height = null }) {
    const extra = {};
    if (sha256) extra.sha256 = sha256;
    if (width !== null && width !== undefined) extra.width = width;
    if (height !== null && height !== undefined) extra.height = height;
    return this.store.recordArtifact({
      provider,
      kind,
      model,
      prompt,
      localPath: outputPath,
      sourceUrl,
      metadata: { ...metadata, ...extra },
      idPrefix: "artifact",
      id,
      mimeType,
    });
  }

  async list() {
    return this.store.listArtifacts();
  }
}
