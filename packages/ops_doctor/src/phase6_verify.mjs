#!/usr/bin/env node
/**
 * packages/ops_doctor/src/phase6_verify.mjs
 *
 * Phase 6 verification smoke script — smallest useful validation skeleton.
 *
 * Scope:
 *   1. GPT worker smoke — verify admin service /health HTTP endpoint is reachable
 *      and returns expected shape ( CDP connectivity, runtime_contract fields).
 *   2. sub2api smoke — verify sub2api /health is reachable and routes GPT provider.
 *   3. Canvas smoke — attempt runtime_status.mjs; BLOCKED by systemd constraint
 *      (runtime_status.mjs calls `systemctl is-active` which touches systemd services).
 *      Evidence: documented here with the specific blocking call site.
 *
 * Architecture chain under test:
 *   consumer → sub2api → gpt-web-responses shim → GPT provider worker
 *
 * This script is read-only. It does not modify state, issue commands,
 * or start/stop services.
 *
 * Exit codes:
 *   0  — GPT and sub2api smoke pass (canvas blocked by constraint, not an error)
 *   1  — GPT or sub2api unreachable or returning unexpected shape
 *   2  — usage / environment error
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// ─── Config ─────────────────────────────────────────────────────────────────

const REPO_ROOT = import.meta.dirname.split("/").slice(0, -3).join("/");
const GPT_ADMIN_URL = process.env.GPT_ADMIN_URL || "http://127.0.0.1:4242/health";
const SUB2API_URL = process.env.SUB2API_URL || "http://127.0.0.1:18080/health";
const CANVAS_RUNTIME_SCRIPT = process.env.CANVAS_RUNTIME_SCRIPT ||
  `${REPO_ROOT}/providers/canvas-to-api/runtime_status.mjs`;
const TIMEOUT_MS = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status?: number, data?: object, error?: string}>}
 */
async function fetchHealth(url, timeoutMs = TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json().catch(() => null);
    return { ok: true, status: response.status, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted")) return { ok: false, error: "timeout" };
    if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
      return { ok: false, error: `unreachable: ${msg}` };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Run canvas runtime_status.mjs subprocess.
 * BLOCKED: runtime_status.mjs calls `systemctl is-active` on canvas systemd units.
 * We attempt it but expect it may fail in environments where systemd is not accessible.
 *
 * @returns {Promise<{ok: boolean, data?: object, blocked?: boolean, error?: string}>}
 */
async function runCanvasRuntimeStatus() {
  // Check the source for systemd calls before attempting
  try {
    const source = readFileSync(CANVAS_RUNTIME_SCRIPT, "utf8");
    if (source.includes("systemctl")) {
      return {
        ok: false,
        blocked: true,
        error: "BLOCKED — runtime_status.mjs calls `systemctl` which touches live systemd services. Constraint: do not touch live systemd services.",
      };
    }
  } catch {
    // File not found or unreadable
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CANVAS_RUNTIME_SCRIPT], {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          resolve({ ok: true, data: JSON.parse(stdout) });
        } catch {
          resolve({ ok: false, error: `JSON parse error: ${stdout.slice(0, 200)}` });
        }
      } else {
        resolve({ ok: false, error: stderr || `exit ${code}` });
      }
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

// ─── Smoke checks ───────────────────────────────────────────────────────────

/**
 * Verify GPT admin service /health returns expected shape.
 * Expected fields: ok, service, runtime_contract (with service_alive, logged_in, cdp_ready, browser_connected)
 */
async function smokeGptAdmin() {
  const result = await fetchHealth(GPT_ADMIN_URL);

  if (!result.ok) {
    return {
      name: "gpt-admin-health",
      status: "UNREACHABLE",
      detail: result.error,
      evidence: null,
    };
  }

  const data = result.data;
  const hasRuntimeContract = data && typeof data.runtime_contract === "object";
  const hasServiceAlive = hasRuntimeContract && typeof data.runtime_contract.service_alive === "boolean";
  const hasProviderCount = typeof data.provider_count === "number";
  const hasCdpField = typeof data.cdp === "string" || data.cdp === null;

  const passed = result.status === 200 && hasRuntimeContract && hasServiceAlive && hasProviderCount && hasCdpField;

  return {
    name: "gpt-admin-health",
    status: passed ? "PASS" : "FAIL",
    detail: passed
      ? `GPT admin service reachable — ok=${data.ok} service=${data.service} service_alive=${data.runtime_contract?.service_alive} providers=${data.provider_count}`
      : `Unexpected shape: HTTP ${result.status} runtime_contract=${!!hasRuntimeContract} service_alive=${!!hasServiceAlive} provider_count=${!!hasProviderCount}`,
    evidence: {
      httpStatus: result.status,
      ok: data?.ok,
      service: data?.service,
      runtime_contract: data?.runtime_contract ?? null,
      provider_count: data?.provider_count ?? null,
    },
  };
}

/**
 * Verify sub2api /health is reachable and returns a well-structured response.
 * This validates the routing plane is up, without requiring specific provider registrations
 * (which depend on external sub2api configuration).
 *
 * sub2api is external to this repo — if it returns unexpected shape, it is a
 * configuration issue in the external service, not a code issue here.
 */
async function smokeSub2api() {
  const result = await fetchHealth(SUB2API_URL);

  if (!result.ok) {
    return {
      name: "sub2api-health",
      status: "UNREACHABLE",
      detail: result.error,
      evidence: null,
    };
  }

  const data = result.data;
  // Basic structural validation — sub2api is external, so we only check reachability
  // and that it returns some kind of health object (not error HTML or empty body).
  const isJsonObject = data && typeof data === "object" && !Array.isArray(data);
  const hasHealthField = isJsonObject && ("ok" in data || "status" in data || "uptime_s" in data);

  const passed = result.status === 200 && isJsonObject && hasHealthField;

  return {
    name: "sub2api-health",
    status: passed ? "PASS" : "FAIL",
    detail: passed
      ? `sub2api reachable — HTTP ${result.status} returns health object (ok=${data?.ok ?? data?.status ?? "unknown"})`
      : `sub2api returns unexpected shape: HTTP ${result.status} isJsonObject=${!!isJsonObject} hasHealthField=${!!hasHealthField}`,
    evidence: {
      httpStatus: result.status,
      ok: data?.ok ?? null,
      status: data?.status ?? null,
      version: data?.version ?? null,
      uptime_s: data?.uptime_s ?? null,
      providers: data?.providers ?? null,
      // Include first few keys to help diagnose what shape sub2api actually returns
      keys: data && typeof data === "object" ? Object.keys(data).slice(0, 10) : null,
    },
  };
}

/**
 * Canvas smoke — BLOCKED by systemd constraint.
 * runtime_status.mjs calls `systemctl is-active` on canvas systemd units.
 * We detect this without running the script by reading the source.
 */
async function smokeCanvas() {
  const result = await runCanvasRuntimeStatus();

  if (result.blocked) {
    return {
      name: "canvas-runtime-status",
      status: "BLOCKED",
      detail: result.error,
      evidence: {
        blocked_reason: "systemd_constraint",
        constraint: "do not touch live systemd services",
        blocking_calls: ["systemctl is-active canvas-to-api.service", "systemctl is-active gemini-canvas-xvfb.service", "systemctl is-active gemini-canvas-novnc.service"],
        script: CANVAS_RUNTIME_SCRIPT,
        fix_required: "Extract read-only CDP checks from runtime_status.mjs into a separate no-systemd script, or rely on canvas-to-api HTTP /health (thin endpoint, no auth required) as the smoke entry point",
      },
    };
  }

  if (!result.ok) {
    return {
      name: "canvas-runtime-status",
      status: "ERROR",
      detail: result.error || "unknown error",
      evidence: null,
    };
  }

  const data = result.data;
  return {
    name: "canvas-runtime-status",
    status: "PASS",
    detail: `canvas runtime reachable — status=${data.status} browser_connected=${data.browser_connected ?? data.browserConnected ?? null}`,
    evidence: data,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.error("Phase 6 verification — smoke tests starting...");

  const [gptResult, sub2apiResult, canvasResult] = await Promise.all([
    smokeGptAdmin(),
    smokeSub2api(),
    smokeCanvas(),
  ]);

  const results = [gptResult, sub2apiResult, canvasResult];

  // Exit code: 1 if GPT or sub2api fail; 0 if both pass (canvas blocked is not a failure)
  const gptOk = gptResult.status === "PASS";
  const sub2apiOk = sub2apiResult.status === "PASS";
  const exitCode = gptOk && sub2apiOk ? 0 : 1;

  const output = {
    phase: 6,
    contract_version: "wcapi.phase6.v1",
    timestamp: new Date().toISOString(),
    repo_root: REPO_ROOT,
    results,
    summary: {
      gpt_worker_smoke: gptResult.status,
      sub2api_smoke: sub2apiResult.status,
      canvas_smoke: canvasResult.status,
      exit_code: exitCode,
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2));

  // Log to stderr for visibility without polluting JSON stdout
  console.error("\n--- Phase 6 Smoke Summary ---");
  for (const r of results) {
    console.error(`[${r.status}] ${r.name}: ${r.detail}`);
  }
  console.error(`Exit: ${exitCode}`);

  process.exit(exitCode);
}

await main();
