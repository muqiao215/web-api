import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildArtifactRecord, createArtifactStore } from "../src/index.mjs";

test("buildArtifactRecord creates stable artifact metadata", () => {
  const record = buildArtifactRecord({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "glass apple",
    localPath: "/tmp/apple.png",
    publicUrl: "http://127.0.0.1:4242/generated/apple.png",
    metadata: { provider_profile_id: "chatgpt-main" },
  });

  assert.equal(record.object, "artifact");
  assert.equal(record.provider, "chatgpt-web");
  assert.equal(record.kind, "image");
  assert.equal(record.local_path, "/tmp/apple.png");
  assert.equal(record.metadata.provider_profile_id, "chatgpt-main");
});

test("createArtifactStore persists artifact records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcapi-artifacts-"));
  const store = createArtifactStore({
    indexPath: path.join(dir, "artifacts.json"),
    publicBaseUrl: "http://127.0.0.1:4242",
  });

  const record = await store.recordArtifact({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "glass apple",
    localPath: path.join(dir, "generated", "apple.png"),
    metadata: { provider_profile_id: "chatgpt-main" },
  });

  assert.equal(record.url, "http://127.0.0.1:4242/generated/apple.png");
  const listed = await store.listArtifacts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);
});
