#!/usr/bin/env node
/**
 * migrate_jobs_image_results.mjs
 *
 * One-time migration script: adds artifact_id, width, height, sha256
 * to image-generation job results in providers/gpt-web-api/data/jobs.json.
 *
 * These fields are now returned by generateImage() in browser_runtime.mjs.
 * This script migrates existing historical records that lack them.
 *
 * Run once, then verify with validate_runtime.mjs.
 *
 * Usage:
 *   node migrate_jobs_image_results.mjs
 *
 * Exit codes:
 *   0 — migrated successfully
 *   1 — no migration needed or errors
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = path.join(__dirname, "../../providers/gpt-web-api/data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");

async function sha256File(filepath) {
  const buffer = await fs.readFile(filepath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readImageDimensions(filepath) {
  const stat = await fs.stat(filepath);
  // Use mtime-based artifact_id to keep IDs stable across re-runs
  const mtime = Math.floor(stat.mtimeMs / 1000);
  const header = await fs.readFile(filepath, { length: 24 });
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    return { width, height, mtime };
  }
  if (header[0] === 0xff && header[1] === 0xd8) {
    const full = await fs.readFile(filepath);
    for (let i = 2; i < full.length - 1; i++) {
      if (full[i] === 0xff && (full[i + 1] === 0xc0 || full[i + 1] === 0xc2)) {
        const height = full.readUInt16BE(i + 5);
        const width = full.readUInt16BE(i + 7);
        return { width, height, mtime };
      }
    }
  }
  return { width: null, height: null, mtime };
}

async function migrate() {
  let raw;
  try {
    raw = await fs.readFile(JOBS_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error("jobs.json not found — nothing to migrate");
      process.exit(0);
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("jobs.json is not valid JSON");
    process.exit(1);
  }

  const jobs = data.jobs || [];
  let migrated = 0;
  let skipped = 0;

  for (const job of jobs) {
    if (job.type !== "images.generations") {
      skipped++;
      continue;
    }

    if (!Array.isArray(job.result)) {
      skipped++;
      continue;
    }

    for (const item of job.result) {
      // If artifact_id already exists, skip (already migrated or new format)
      if (item.artifact_id) {
        skipped++;
        continue;
      }

      // Compute enrichment fields — artifact_id is deterministic from result.created and output_path
      // to ensure idempotent migration (running twice produces the same result).
      const createdTs = item.created || Math.floor(Date.now() / 1000);
      const pathHash = item.output_path.split("/").at(-1).replace(/[^a-z0-9]/gi, "").slice(0, 8);
      const artifact_id = `art_${createdTs}_${pathHash}`;
      let sha256 = null;
      let width = null;
      let height = null;

      try {
        sha256 = await sha256File(item.output_path);
        const dims = await readImageDimensions(item.output_path);
        width = dims.width;
        height = dims.height;
      } catch (err) {
        console.warn(`  WARNING: could not compute sha256/dims for ${item.output_path}: ${err.message}`);
      }

      // Update in place
      item.artifact_id = artifact_id;
      item.sha256 = sha256;
      item.width = width;
      item.height = height;
      migrated++;
      console.log(`  [MIGRATED] ${job.id}: artifact_id=${artifact_id} sha256=${sha256?.slice(0, 12) || "null"} w=${width} h=${height}`);
    }
  }

  if (migrated === 0) {
    console.log("No migration needed — all image-gen job results already have artifact_id.");
    process.exit(0);
  }

  // Write back
  await fs.writeFile(JOBS_PATH, JSON.stringify(data, null, 2));
  console.log(`\nMigrated ${migrated} image-gen result items in ${migrated} jobs.`);
  console.log(`Skipped: ${skipped} (not image-gen or already migrated).`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
