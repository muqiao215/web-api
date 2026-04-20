import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Use fileURLToPath + path.dirname — import.meta.dirname varies by CWD at invocation
const __TEST_DIR__ = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSE = path.join(__TEST_DIR__, "..", "src", "diagnose.mjs");
const REPO_ROOT = path.resolve(path.join(__TEST_DIR__, "..", "..", ".."));

function runDiagnose(args = []) {
  return new Promise((resolve) => {
    const proc = spawn("node", [DIAGNOSE, ...args], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runDiagnoseWithJobs(jobsData, extraArgs = []) {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnose-test-"));
    const jobsPath = path.join(tmpDir, "jobs.json");
    fs.writeFileSync(jobsPath, JSON.stringify(jobsData));
    const proc = spawn("node", [DIAGNOSE, "--jobs", jobsPath, ...extraArgs], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      // Clean up temp dir
      try {
        fs.unlinkSync(jobsPath);
        fs.rmdirSync(tmpDir);
      } catch (_) {}
      resolve({ code, stdout, stderr });
    });
  });
}

test("diagnose.mjs exits 0 with no failures", async () => {
  const result = await runDiagnose();
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.timestamp);
});

test("diagnose.mjs reports output_dir_writable", async () => {
  const result = await runDiagnose();
  const payload = JSON.parse(result.stdout);
  const outputCheck = payload.checks.find((c) => c.name === "output_dir_writable");
  assert.ok(outputCheck, "output_dir_writable check should be present");
  assert.ok(["OK", "WARN"].includes(outputCheck.status));
});

test("diagnose.mjs reports jobs_json", async () => {
  const result = await runDiagnose();
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  assert.ok(jobsCheck, "jobs_json check should be present");
  assert.ok(jobsCheck.detail.includes("total="));
});

test("diagnose.mjs reports media_json", async () => {
  const result = await runDiagnose();
  const payload = JSON.parse(result.stdout);
  const mediaCheck = payload.checks.find((c) => c.name === "media_json");
  assert.ok(mediaCheck, "media_json check should be present");
});

test("diagnose.mjs accepts --jobs override path", async () => {
  const result = await runDiagnose(["--jobs", "/nonexistent/jobs.json"]);
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  assert.equal(jobsCheck.status, "FAIL");
  assert.ok(jobsCheck.detail.includes("not found"));
});

test("diagnose.mjs returns JSON output only (no extra text)", async () => {
  const result = await runDiagnose();
  // stdout should be parseable as JSON with no non-JSON prefix
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checks);
});

test("diagnose.mjs output contains repo_root", async () => {
  const result = await runDiagnose();
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.repo_root);
  assert.ok(payload.repo_root.includes("web_capability_api"));
});

// ─── Historical vs Active Failure Classification ───────────────────────────

test("diagnose.mjs: historical failures do not trigger WARN", async () => {
  // 3 completed image jobs: 2 failed (historical), 1 succeeded — all have finished_at
  const jobs = {
    jobs: [
      { id: "j1", object: "job", type: "images.generations", status: "failed", created_at: "2026-04-19T10:00:00Z", updated_at: "2026-04-19T10:01:00Z", started_at: "2026-04-19T10:00:01Z", finished_at: "2026-04-19T10:01:00Z", metadata: {}, result: null, error: { message: "timeout" } },
      { id: "j2", object: "job", type: "images.generations", status: "failed", created_at: "2026-04-19T11:00:00Z", updated_at: "2026-04-19T11:01:00Z", started_at: "2026-04-19T11:00:01Z", finished_at: "2026-04-19T11:01:00Z", metadata: {}, result: null, error: { message: "timeout" } },
      { id: "j3", object: "job", type: "images.generations", status: "succeeded", created_at: "2026-04-19T12:00:00Z", updated_at: "2026-04-19T12:01:00Z", started_at: "2026-04-19T12:00:01Z", finished_at: "2026-04-19T12:01:00Z", metadata: {}, result: [{ created: 123, model: "test", prompt: "test" }], error: null },
    ],
  };
  const result = await runDiagnoseWithJobs(jobs);
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  // No active failures → OK, even though 2 historical failures exist
  assert.equal(jobsCheck.status, "OK", "Historical failures should not trigger WARN");
  assert.ok(jobsCheck.detail.includes("historical=3"), "Should report historical count");
  assert.ok(jobsCheck.detail.includes("image_historical=3"), "Should report historical image count");
  assert.ok(jobsCheck.detail.includes("active=0"), "Should report zero active jobs");
});

test("diagnose.mjs: active running job does not trigger WARN (no failure)", async () => {
  // Active running job, no failure status — should be OK even if error field is present
  const jobs = {
    jobs: [
      { id: "j1", object: "job", type: "images.generations", status: "running", created_at: "2026-04-20T10:00:00Z", updated_at: "2026-04-20T10:01:00Z", started_at: "2026-04-20T10:00:01Z", finished_at: null, metadata: {}, result: null, error: null },
    ],
  };
  const result = await runDiagnoseWithJobs(jobs);
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  assert.equal(jobsCheck.status, "OK", "Active running job without failure status should be OK");
  assert.ok(jobsCheck.detail.includes("active=1"), "Should report active count");
  assert.ok(jobsCheck.detail.includes("image_active=1"), "Should report active image count");
  assert.ok(jobsCheck.detail.includes("image_failed=0"), "Should report zero active failures");
});

test("diagnose.mjs: active queued job does not trigger WARN (no failure)", async () => {
  // Active pending job, no failures
  const jobs = {
    jobs: [
      { id: "j1", object: "job", type: "images.generations", status: "queued", created_at: "2026-04-20T10:00:00Z", updated_at: "2026-04-20T10:01:00Z", started_at: null, finished_at: null, metadata: {}, result: null, error: null },
    ],
  };
  const result = await runDiagnoseWithJobs(jobs);
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  assert.equal(jobsCheck.status, "OK", "Active queued job without failure should be OK");
  assert.ok(jobsCheck.detail.includes("active=1"), "Should report active count");
  assert.ok(jobsCheck.detail.includes("image_active=1"), "Should report active image count");
});

test("diagnose.mjs: mixed active and historical jobs — only active affects health", async () => {
  // 1 active (succeeded), 2 historical (failed) — health should be OK because no active failures
  const jobs = {
    jobs: [
      { id: "j1", object: "job", type: "images.generations", status: "succeeded", created_at: "2026-04-20T10:00:00Z", updated_at: "2026-04-20T10:01:00Z", started_at: "2026-04-20T10:00:01Z", finished_at: "2026-04-20T10:01:00Z", metadata: {}, result: [{ created: 123 }], error: null },
      { id: "j2", object: "job", type: "images.generations", status: "failed", created_at: "2026-04-19T10:00:00Z", updated_at: "2026-04-19T10:01:00Z", started_at: "2026-04-19T10:00:01Z", finished_at: "2026-04-19T10:01:00Z", metadata: {}, result: null, error: { message: "timeout" } },
      { id: "j3", object: "job", type: "images.generations", status: "failed", created_at: "2026-04-19T11:00:00Z", updated_at: "2026-04-19T11:01:00Z", started_at: "2026-04-19T11:00:01Z", finished_at: "2026-04-19T11:01:00Z", metadata: {}, result: null, error: { message: "timeout" } },
    ],
  };
  const result = await runDiagnoseWithJobs(jobs);
  const payload = JSON.parse(result.stdout);
  const jobsCheck = payload.checks.find((c) => c.name === "jobs_json");
  assert.equal(jobsCheck.status, "OK", "Active succeeded with historical failures should be OK");
  // The one succeeded job has finished_at so it's historical, not active
  assert.ok(jobsCheck.detail.includes("active=0"), "Should report 0 active jobs (succeeded job has finished_at)");
  assert.ok(jobsCheck.detail.includes("historical=3"), "Should report 3 historical jobs");
});
