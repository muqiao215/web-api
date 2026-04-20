#!/usr/bin/env node
/**
 * migrate_media_legacy_records.mjs
 *
 * One-time migration script: converts legacy media.json records
 * (object: "media", output_path) to ArtifactRecord shape
 * (object: "artifact", local_path, contract_version).
 *
 * Also computes sha256, width, height from the actual image file,
 * and infers mime_type from the file extension.
 *
 * Idempotent: re-running produces the same result (skips already-migrated records).
 *
 * Usage:
 *   node migrate_media_legacy_records.mjs
 *
 * Exit codes:
 *   0 — migrated successfully or nothing to migrate
 *   1 — file not found or parse error
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = path.join(__dirname, "../../providers/gpt-web-api/data");
const MEDIA_PATH = path.join(DATA_DIR, "media.json");

const CONTRACT_VERSION = "wcapi.artifact.v1";

function inferMimeType(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  switch (ext) {
    case ".png":  return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif":  return "image/gif";
    case ".webp": return "image/webp";
    case ".svg":  return "image/svg+xml";
    case ".bmp":  return "image/bmp";
    default:      return "application/octet-stream";
  }
}

async function sha256File(filepath) {
  const buffer = await fs.readFile(filepath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readImageDimensions(filepath) {
  const stat = await fs.stat(filepath);
  const mtime = Math.floor(stat.mtimeMs / 1000);
  const header = await fs.readFile(filepath, { length: 24 });
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    const width  = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return { width, height, mtime };
  }
  if (header[0] === 0xff && header[1] === 0xd8) {
    const full = await fs.readFile(filepath);
    for (let i = 2; i < full.length - 1; i++) {
      if (full[i] === 0xff && (full[i + 1] === 0xc0 || full[i + 1] === 0xc2)) {
        const height = full.readUInt16BE(i + 5);
        const width  = full.readUInt16BE(i + 7);
        return { width, height, mtime };
      }
    }
  }
  return { width: null, height: null, mtime };
}

async function migrate() {
  let raw;
  try {
    raw = await fs.readFile(MEDIA_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("media.json not found — nothing to migrate");
      process.exit(0);
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("media.json is not valid JSON");
    process.exit(1);
  }

  const entries = Object.entries(data);
  let migrated = 0;
  let skipped = 0;

  for (const [id, record] of entries) {
    // Skip already migrated records
    if (record.object === "artifact") {
      skipped++;
      continue;
    }

    if (record.object !== "media") {
      skipped++;
      continue;
    }

    const localPath = record.output_path || record.local_path;
    if (!localPath) {
      console.warn(`  [SKIP] ${id}: no output_path/local_path — cannot migrate`);
      skipped++;
      continue;
    }

    // Compute enrichment fields from the actual image file
    let sha256 = null;
    let width  = null;
    let height = null;

    try {
      sha256 = await sha256File(localPath);
      const dims = await readImageDimensions(localPath);
      width  = dims.width;
      height = dims.height;
    } catch (err) {
      console.warn(`  WARNING: could not compute sha256/dims for ${localPath}: ${err.message}`);
    }

    // Infer mime_type from file extension
    const mime_type = inferMimeType(localPath);

    // Build the migrated record — ArtifactRecord shape
    const migratedRecord = {
      contract_version: CONTRACT_VERSION,
      id:               record.id,
      object:           "artifact",
      provider:         record.provider,
      kind:             record.kind,
      model:            record.model,
      prompt:           record.prompt || "",
      mime_type,
      created_at:       record.created_at,
      local_path:       localPath,
      url:              record.url || "",
      source_url:       record.source_url || "",
      metadata: {
        ...(record.metadata || {}),
        width,
        height,
        sha256,
        _migrated_from_media_format: true,
      },
    };

    data[id] = migratedRecord;
    migrated++;
    console.log(`  [MIGRATED] ${id}: mime=${mime_type} w=${width} h=${height} sha256=${sha256?.slice(0, 12) || "null"}`);
  }

  if (migrated === 0) {
    console.log("No migration needed — all media records are already in artifact format.");
    process.exit(0);
  }

  await fs.writeFile(MEDIA_PATH, JSON.stringify(data, null, 2));
  console.log(`\nMigrated ${migrated} legacy media records to artifact format.`);
  console.log(`Skipped: ${skipped} (already artifact or skipped).`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
