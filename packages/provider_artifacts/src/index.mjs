import fs from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_CONTRACT_VERSION = "wcapi.artifact.v1";

function createArtifactId(prefix = "artifact") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeKind(kind = "") {
  const value = String(kind || "").trim().toLowerCase();
  if (["image", "audio", "video", "document", "binary"].includes(value)) {
    return value;
  }
  return "unknown";
}

export function buildArtifactRecord({
  provider,
  kind,
  model,
  prompt = "",
  localPath,
  publicUrl = "",
  sourceUrl = "",
  mimeType = "",
  metadata = {},
  idPrefix = "artifact",
  id = "",
}) {
  if (!provider) throw new Error("provider is required");
  if (!model) throw new Error("model is required");
  if (!localPath) throw new Error("localPath is required");

  return {
    contract_version: ARTIFACT_CONTRACT_VERSION,
    id: id || createArtifactId(idPrefix),
    object: "artifact",
    provider,
    kind: normalizeKind(kind),
    model,
    prompt,
    mime_type: mimeType,
    created_at: Math.floor(Date.now() / 1000),
    local_path: localPath,
    url: publicUrl,
    source_url: sourceUrl,
    metadata: { ...metadata },
  };
}

export function createArtifactStore({ indexPath, publicBaseUrl = "", publicPathPrefix = "/generated" }) {
  async function readIndex() {
    try {
      return JSON.parse(await fs.readFile(indexPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeIndex(index) {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  async function recordArtifact({
    provider,
    kind,
    model,
    prompt = "",
    localPath,
    sourceUrl = "",
    mimeType = "",
    metadata = {},
    idPrefix = "artifact",
    id = "",
  }) {
    const filename = path.basename(localPath);
    const base = String(publicBaseUrl || "").replace(/\/+$/, "");
    const prefix = String(publicPathPrefix || "/generated").replace(/\/+$/, "");
    const publicUrl = base ? `${base}${prefix}/${filename}` : "";
    const record = buildArtifactRecord({
      provider,
      kind,
      model,
      prompt,
      localPath,
      publicUrl,
      sourceUrl,
      mimeType,
      metadata,
      idPrefix,
      id,
    });
    const index = await readIndex();
    index[record.id] = record;
    await writeIndex(index);
    return record;
  }

  async function listArtifacts() {
    const index = await readIndex();
    return Object.values(index).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  return {
    readIndex,
    writeIndex,
    recordArtifact,
    listArtifacts,
  };
}
