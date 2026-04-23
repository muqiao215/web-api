#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { renderImageModelIndex } from "./src/index.mjs";

const REPO_ROOT = import.meta.dirname.split("/").slice(0, -2).join("/");
const PROVIDERS_DIR = path.join(REPO_ROOT, "providers");
const OUTPUT_PATH = path.join(REPO_ROOT, "ops", "image-model-index.md");

async function discoverArtifactIndexPaths() {
  try {
    const providerNames = await fs.readdir(PROVIDERS_DIR);
    const paths = [];

    for (const providerName of providerNames) {
      const candidate = path.join(PROVIDERS_DIR, providerName, "data", "media.json");
      try {
        await fs.access(candidate);
        paths.push(path.relative(REPO_ROOT, candidate));
      } catch {
        // ignore providers without persisted artifact indexes
      }
    }

    return paths.sort();
  } catch {
    return [];
  }
}

async function loadArtifactRecords(indexPaths) {
  const records = [];

  for (const indexPath of indexPaths) {
    const absolutePath = path.join(REPO_ROOT, indexPath);
    const raw = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    for (const record of Object.values(raw)) {
      const localPath = String(record?.local_path || "");
      records.push({
        ...record,
        local_path: localPath.startsWith(`${REPO_ROOT}/`)
          ? path.relative(REPO_ROOT, localPath)
          : localPath,
      });
    }
  }

  return records;
}

async function main() {
  const indexPaths = await discoverArtifactIndexPaths();
  const records = await loadArtifactRecords(indexPaths);
  const markdown = renderImageModelIndex({
    records,
    sourcePaths: indexPaths,
  });

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, markdown);

  console.log(`Updated ${path.relative(REPO_ROOT, OUTPUT_PATH)} from ${indexPaths.length} artifact index file(s) with ${records.length} persisted artifact record(s).`);
}

await main();
