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

test("buildArtifactRecord uses explicit id when provided", () => {
  const explicitId = "art_explicit_xyz123";
  const record = buildArtifactRecord({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "glass apple",
    localPath: "/tmp/apple.png",
    metadata: {},
    id: explicitId,
  });
  assert.equal(record.id, explicitId);
});

test("buildArtifactRecord stores extra metadata fields (sha256, width, height)", () => {
  const record = buildArtifactRecord({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "test",
    localPath: "/tmp/test.png",
    metadata: { sha256: "abc123", width: 1024, height: 768 },
  });
  assert.equal(record.metadata.sha256, "abc123");
  assert.equal(record.metadata.width, 1024);
  assert.equal(record.metadata.height, 768);
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

test("createArtifactStore preserves enrichment fields for GPT image artifacts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wcapi-artifacts-"));
  const generatedDir = path.join(dir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  const localPath = path.join(generatedDir, "chatgpt-image-12345.png");
  // create a minimal 1x1 PNG so the file exists
  const png1x1 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xdd,
    0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  await fs.writeFile(localPath, png1x1);

  const store = createArtifactStore({
    indexPath: path.join(dir, "artifacts.json"),
    publicBaseUrl: "http://127.0.0.1:4242",
  });

  // Simulate the full openai_routes → mediaStore → artifactStore chain
  const artifactId = "art_1234567890_chatgpt";
  const mimeType = "image/png";
  const sha256 = "a4efd3cc0077223b43e4a288c48231bb7a0e16515eecf43256053723b1861d30";
  const width = 1;
  const height = 1;

  const record = await store.recordArtifact({
    provider: "chatgpt-web",
    kind: "image",
    model: "chatgpt-images",
    prompt: "a glass apple on a table",
    localPath,
    sourceUrl: "https://example.com/image.png",
    metadata: {
      conversation_url: "https://chatgpt.com/conversation/abc",
      alt: "a glass apple",
      sha256,
      width,
      height,
    },
    id: artifactId,
    mimeType,
  });

  // Verify all enrichment fields are preserved in the record
  assert.equal(record.id, artifactId, "explicit artifact_id should be used");
  assert.equal(record.mime_type, mimeType, "mime_type should be preserved");
  assert.equal(record.metadata.sha256, sha256, "sha256 in metadata should be preserved");
  assert.equal(record.metadata.width, width, "width in metadata should be preserved");
  assert.equal(record.metadata.height, height, "height in metadata should be preserved");
  assert.equal(record.object, "artifact");
  assert.equal(record.kind, "image");
  assert.equal(record.provider, "chatgpt-web");

  // Verify the record is correctly persisted and retrievable
  const listed = await store.listArtifacts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifactId);
  assert.equal(listed[0].mime_type, mimeType);
  assert.equal(listed[0].metadata.sha256, sha256);
  assert.equal(listed[0].metadata.width, width);
  assert.equal(listed[0].metadata.height, height);
});
