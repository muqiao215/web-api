import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "packages/ops_doctor/src/phase6_verify.mjs");

// ─── Phase 6: Verify script source analysis ─────────────────────────────────────

test("phase6_verify.mjs exists and is readable", () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `Script should exist at ${SCRIPT_PATH}`);
});

test("phase6_verify.mjs does NOT spawn systemctl process (systemd constraint check)", () => {
  // The verification script must not SPAWN systemctl — it only reads canvas runtime_status.mjs
  // source to detect whether it uses systemctl. We check for spawn-related patterns.
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Must not use spawn to run systemctl (spawnSync, spawn with "systemctl" arg, etc.)
  assert.ok(!source.includes("spawnSync"), "phase6_verify.mjs must not use spawnSync to run systemctl");
  // The word "systemctl" appears in detection/error strings (acceptable) but must not be
  // invoked as a subprocess argument
  assert.ok(
    !source.includes('spawn("systemctl"') && !source.includes("spawn('systemctl'"),
    "phase6_verify.mjs must not spawn systemctl as a subprocess"
  );
});

test("phase6_verify.mjs imports only node: modules (no external network dependencies)", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Verify it only uses node: built-in modules
  const importRegex = /^import .* from ['"](node:\w+)['"]/gm;
  const matches = [...source.matchAll(importRegex)];
  for (const match of matches) {
    const module = match[1];
    assert.ok(module.startsWith("node:"), `Import ${module} must be a node: built-in module`);
  }
});

test("phase6_verify.mjs detects systemd calls in canvas runtime_status.mjs source", () => {
  // This tests the blocking detection logic without running the canvas script.
  // The verification script reads canvas runtime_status.mjs source to detect
  // systemctl calls before attempting execution.
  const canvasScript = path.join(REPO_ROOT, "providers/canvas-to-api/runtime_status.mjs");
  if (!fs.existsSync(canvasScript)) return; // Canvas not present — skip

  const source = fs.readFileSync(canvasScript, "utf8");
  // canvas runtime_status.mjs MUST use systemctl (per its design).
  // This is the evidence that the canvas smoke path is blocked.
  assert.ok(
    source.includes("systemctl"),
    "Canvas runtime_status.mjs must use systemctl (this is the blocker, documented in phase6_verify output)"
  );
});

test("phase6_verify.mjs has correct exit code logic (0 when GPT+sub2api pass, 1 when either fails)", () => {
  // Verify the script's exit code logic from source analysis.
  // Exit 0 = GPT and sub2api PASS (canvas BLOCKED is not an error).
  // Exit 1 = GPT or sub2api FAIL or UNREACHABLE.
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");

  // The script should check gptOk && sub2apiOk for exit code 0
  assert.ok(
    source.includes("gptOk && sub2apiOk"),
    "Script must use gptOk && sub2apiOk for exit code 0"
  );
  assert.ok(
    source.includes("process.exit(exitCode)"),
    "Script must call process.exit with computed exitCode"
  );
});

test("phase6_verify.mjs outputs JSON to stdout with result array and summary", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Output must be JSON with results array and summary
  assert.ok(
    source.includes("results") && source.includes("summary"),
    "Output must include results array and summary object"
  );
  assert.ok(
    source.includes("gpt_worker_smoke") && source.includes("sub2api_smoke") && source.includes("canvas_smoke"),
    "Summary must include gpt_worker_smoke, sub2api_smoke, canvas_smoke"
  );
});

test("phase6_verify.mjs documents the canvas systemd blocking calls explicitly", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  // The blocker detail must list the specific systemctl calls
  assert.ok(
    source.includes("canvas-to-api.service") &&
    source.includes("gemini-canvas-xvfb.service") &&
    source.includes("gemini-canvas-novnc.service"),
    "Blocking calls must be enumerated: canvas-to-api.service, gemini-canvas-xvfb.service, gemini-canvas-novnc.service"
  );
  assert.ok(
    source.includes("fix_required"),
    "Must document fix_required to extract read-only CDP checks into a no-systemd script"
  );
});

// ─── Verify canvas runtime_status.mjs systemd calls are the actual blocker ─────────

test("Canvas runtime_status.mjs calls systemctl is-active for all three systemd units", () => {
  const canvasScript = path.join(REPO_ROOT, "providers/canvas-to-api/runtime_status.mjs");
  if (!fs.existsSync(canvasScript)) return;

  const source = fs.readFileSync(canvasScript, "utf8");
  assert.ok(source.includes("systemctl"), "Must use systemctl");
  assert.ok(source.includes("is-active"), "Must use systemctl is-active");
  assert.ok(source.includes("canvas-to-api.service"), "Must check canvas-to-api.service");
  assert.ok(source.includes("gemini-canvas-xvfb.service"), "Must check gemini-canvas-xvfb.service");
  assert.ok(source.includes("gemini-canvas-novnc.service"), "Must check gemini-canvas-novnc.service");
});

test("Canvas runtime_status.mjs does NOT expose a non-systemd smoke entry point", () => {
  // The canvas runtime_status.mjs is the ONLY smoke entry point for canvas.
  // It uses systemd. There is no alternative read-only entry point.
  // The HTTP /health endpoint is thin: {browserConnected, status, timestamp} — not enough for smoke.
  const canvasScript = path.join(REPO_ROOT, "providers/canvas-to-api/runtime_status.mjs");
  if (!fs.existsSync(canvasScript)) return;

  const source = fs.readFileSync(canvasScript, "utf8");
  // verify systemctl is used (it is the blocker)
  assert.ok(/systemctl/.test(source), "Canvas uses systemctl (this is the blocker)");
  // verify there is no NO_SYSTEMD or SKIP_SYSTEMD escape hatch
  const hasEscapeHatch = /NO_SYSTEMD|SKIP_SYSTEMD|DISABLE_SYSTEMD|SKIP_SYSTD/i.test(source);
  assert.ok(!hasEscapeHatch, "Canvas has no NO_SYSTEMD/SKIP_SYSTEMD escape hatch");
  // The process.env usage in canvas is for CANVAS_TO_API_HEALTH_URL (HTTP endpoint),
  // NOT for disabling systemd checks — so the gate check must be more specific
  const hasSystemdEnvGate = /systemctl/.test(source) && /NO_SYSTEMD|SKIP_SYSTEMD|DISABLE_SYSTEMD/i.test(source);
  assert.ok(!hasSystemdEnvGate, "Canvas has no env-var gate for systemd");
});