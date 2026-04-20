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
