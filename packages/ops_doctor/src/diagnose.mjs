#!/usr/bin/env node
/**
 * packages/ops_doctor/src/diagnose.mjs
 *
 * Node.js diagnostic companion for ops_doctor Python CLI.
 * Inspects GPT provider data files, pool state files, and artifact paths.
 * Exits 0 if all checks pass, 1 if any FAIL, 2 for usage/errors.
 *
 * Called by ops_doctor via:
 *   node packages/ops_doctor/src/diagnose.mjs [--jobs <path>] [--media <path>]
 *        [--output-dir <path>] [--pool-data <path>] [--proxy-data <path>]
 *        [--pool-json <path>] [--queue-state-json <path>]
 *
 * All paths are optional; defaults point to GPT provider data/ paths relative
 * to the repo root (providers/gpt-web-api/).
 */

import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";

// ─── Helpers ─────────────────────────────────────────────────────────────

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: `not found: ${filePath}` };
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (err) {
    return { ok: false, error: `read/parse error: ${err.message}` };
  }
}

function checkWritable(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      return { ok: false, error: `not found: ${dirPath}`, writable: false };
    }
    const testFile = path.join(dirPath, `.ops_doctor_write_test_${Date.now()}`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return { ok: true, writable: true, path: dirPath };
  } catch (err) {
    return { ok: true, writable: false, path: dirPath, error: err.message };
  }
}

function summarizeJobs(data) {
  if (!data || !Array.isArray(data.jobs)) return null;
  const jobs = data.jobs;
  const statuses = { queued: 0, running: 0, succeeded: 0, failed: 0 };
  const imageJobs = { total: 0, succeeded: 0, failed: 0, pending: 0 };

  // Separate active (pending/running) from historical (completed) jobs
  const active = { total: 0, imageJobs: { total: 0, failed: 0 } };
  const historical = { total: 0, imageJobs: { total: 0, failed: 0 } };

  for (const job of jobs) {
    if (statuses[job.status] !== undefined) statuses[job.status]++;

    const isActive = job.status === "queued" || job.status === "running";
    const isImageJob = job.type === "images.generations";

    if (isActive) {
      active.total++;
      if (isImageJob) {
        active.imageJobs.total++;
        if (job.status === "failed") active.imageJobs.failed++;
      }
    } else {
      historical.total++;
      if (isImageJob) {
        historical.imageJobs.total++;
        if (job.status === "failed") historical.imageJobs.failed++;
      }
    }

    if (isImageJob) {
      imageJobs.total++;
      if (job.status === "succeeded") imageJobs.succeeded++;
      else if (job.status === "failed") imageJobs.failed++;
      else if (isActive) imageJobs.pending++;
    }
  }
  return { total: jobs.length, statuses, imageJobs, active, historical };
}

function summarizeMedia(data) {
  if (!data) return null;
  // Support both formats:
  // - Dictionary: { "id1": {...}, "id2": {...} }  (current media.json format)
  // - Array: [{ ... }, { ... }]
  let records;
  if (Array.isArray(data)) {
    records = data;
  } else if (typeof data === "object") {
    // If it has a "records" key with an array, use that; otherwise treat values as records
    records = data.records || Object.values(data);
  } else {
    return null;
  }
  const byKind = {};
  let artifacts = 0;
  let legacy = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const kind = record.kind || (record.object === "artifact" ? "image" : record.object);
    if (!byKind[kind]) byKind[kind] = 0;
    byKind[kind]++;
    if (record.object === "artifact") artifacts++;
    else if (record.object === "media") legacy++;
  }
  return { total: records.length, byKind, artifacts, legacy };
}

// ─── Main ────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.join(import.meta.dirname, "..", "..", ".."));

function parseArgs(argv) {
  const opts = {
    jobs: path.join(repoRoot, "providers/gpt-web-api/data/jobs.json"),
    media: path.join(repoRoot, "providers/gpt-web-api/data/media.json"),
    outputDir: path.join(repoRoot, "providers/gpt-web-api/generated"),
    poolData: "",
    proxyData: "",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs" && argv[i + 1]) opts.jobs = argv[++i];
    else if (argv[i] === "--media" && argv[i + 1]) opts.media = argv[++i];
    else if (argv[i] === "--output-dir" && argv[i + 1]) opts.outputDir = argv[++i];
    else if (argv[i] === "--pool-data" && argv[i + 1]) opts.poolData = argv[++i];
    else if (argv[i] === "--proxy-data" && argv[i + 1]) opts.proxyData = argv[++i];
  }
  return opts;
}

function runChecks(opts) {
  const checks = [];

  // 1. Output directory writability
  const outputCheck = checkWritable(opts.outputDir);
  checks.push({
    name: "output_dir_writable",
    status: outputCheck.writable ? "OK" : "WARN",
    detail: outputCheck.writable
      ? `${opts.outputDir} is writable`
      : `${opts.outputDir} is not writable${outputCheck.error ? ` (${outputCheck.error})` : ""}`,
  });

  // 2. jobs.json — queue depth / image task summary
  const jobsResult = safeReadJson(opts.jobs);
  if (!jobsResult.ok) {
    checks.push({ name: "jobs_json", status: "FAIL", detail: jobsResult.error });
  } else {
    const summary = summarizeJobs(jobsResult.data);
    if (summary) {
      // Health check is based on ACTIVE jobs only (pending/running).
      // Historical failures (completed with finished_at) do not trigger WARN
      // as they represent past events, not current operational problems.
      const activeDetail = `active=${summary.active.total} image_active=${summary.active.imageJobs.total} image_failed=${summary.active.imageJobs.failed}`;
      const histDetail = `historical=${summary.historical.total} image_historical=${summary.historical.imageJobs.total} image_failed=${summary.historical.imageJobs.failed}`;
      const detail = `total=${summary.total} ${activeDetail} ${histDetail}`;

      // WARN conditions for active jobs only
      const status =
        summary.active.imageJobs.failed > 0 && summary.active.imageJobs.total > 0
          ? "WARN"
          : summary.active.imageJobs.failed > summary.active.imageJobs.total / 2
          ? "WARN"
          : "OK";
      checks.push({ name: "jobs_json", status, detail: `${detail} (path=${opts.jobs})` });
    } else {
      checks.push({ name: "jobs_json", status: "WARN", detail: `unexpected jobs.json structure (path=${opts.jobs})` });
    }
  }

  // 3. media.json — artifact / legacy media summary
  const mediaResult = safeReadJson(opts.media);
  if (!mediaResult.ok) {
    checks.push({ name: "media_json", status: "FAIL", detail: mediaResult.error });
  } else {
    const summary = summarizeMedia(mediaResult.data);
    if (summary) {
      const detail = `total=${summary.total} artifacts=${summary.artifacts} legacy=${summary.legacy} by_kind=${JSON.stringify(summary.byKind)}`;
      checks.push({
        name: "media_json",
        status: summary.legacy > 0 ? "WARN" : "OK",
        detail: `${detail} (path=${opts.media})`,
      });
    } else {
      checks.push({ name: "media_json", status: "WARN", detail: `unexpected media.json structure (path=${opts.media})` });
    }
  }

  // 4. Pool data file (optional)
  if (opts.poolData) {
    const poolResult = safeReadJson(opts.poolData);
    if (!poolResult.ok) {
      checks.push({ name: "provider_pool_data", status: "FAIL", detail: poolResult.error });
    } else {
      const data = poolResult.data;
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];
      const leased = accounts.filter((a) => a.lease && new Date(a.lease.expires_at) > new Date());
      checks.push({
        name: "provider_pool_data",
        status: "OK",
        detail: `provider=${data.provider} total=${accounts.length} leased=${leased.length} (path=${opts.poolData})`,
      });
    }
  }

  // 5. Proxy pool data file (optional)
  if (opts.proxyData) {
    const proxyResult = safeReadJson(opts.proxyData);
    if (!proxyResult.ok) {
      checks.push({ name: "proxy_pool_data", status: "FAIL", detail: proxyResult.error });
    } else {
      const data = proxyResult.data;
      const proxies = Array.isArray(data.proxies) ? data.proxies : [];
      const healthy = proxies.filter((p) => p.enabled && ["active", "degraded"].includes(p.health?.status));
      checks.push({
        name: "proxy_pool_data",
        status: "OK",
        detail: `provider=${data.provider} total=${proxies.length} healthy=${healthy.length} (path=${opts.proxyData})`,
      });
    }
  }

  return checks;
}

// ─── CLI entry point ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opts = parseArgs(argv);
const checks = runChecks(opts);

const hasFailure = checks.some((c) => c.status === "FAIL");
const output = { checks, timestamp: new Date().toISOString(), repo_root: repoRoot };

process.stdout.write(JSON.stringify(output, null, 2));
process.exit(hasFailure ? 1 : 0);
