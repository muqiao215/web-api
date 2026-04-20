/**
 * apps/control-workbench — Read-only control surface for provider/admin runtime state.
 *
 * Contract version: wcapi.control-workbench.v2
 *
 * Design: this package is intentionally read-only. It fetches from existing HTTP
 * health/status endpoints (GPT admin service, canvas-to-api, sub2api) and
 * aggregates them into a unified machine-readable control view. It does NOT
 * modify state, issue commands, or start new services.
 *
 * Alignment:
 *   - Provider health shape    → provider-capability.schema.json
 *   - Queue state shape        → queue-state.schema.json
 *   - Account pool shape       → account-pool.schema.json (read-only summary)
 *   - Proxy pool shape        → proxy-pool.schema.json (read-only summary)
 *
 * Non-goals (deferred to Phase 5 full / Phase 6):
 *   - Issuing commands (pause/resume worker, force-lease-release)
 *   - Audit log persistence
 *   - Billing/subscription surface
 *   - Direct systemd control
 */

export const CONTROL_WORKBENCH_VERSION = "wcapi.control-workbench.v2";

// ─── Endpoint registry ────────────────────────────────────────────────────────

const DEFAULT_ENDPOINTS = {
  gptAdmin: "http://127.0.0.1:4242/health",
  canvasRuntime: "http://127.0.0.1:7861/health",
  sub2api: "http://127.0.0.1:18080/health",
};

/**
 * @typedef {object} ControlBenchOptions
 * @property {Record<string, string>} [endpoints]  — override default HTTP endpoints
 * @property {number} [timeoutMs]                — fetch timeout in ms (default 3000)
 * @property {string} [opsDoctorPath]            — path to diagnose.mjs (default: repo-relative)
 * @property {string} [canvasRuntimeScriptPath]  — path to canvas runtime_status.mjs (default: repo-relative)
 * @property {boolean} [includeSub2api]          — whether to fetch sub2api health (default true)
 */

/**
 * @typedef {object} ProviderSnapshot
 * @property {string} provider
 * @property {string} status            — "ok" | "degraded" | "blocked" | "error" | "unreachable"
 * @property {string} [providerType]
 * @property {object} [health]
 * @property {object} [runtime]
 * @property {object} [accountPool]
 * @property {object} [proxyPool]
 * @property {object} [queueState]
 */

/**
 * @typedef {object} ControlReport
 * @property {string} contract_version
 * @property {string} generated_at
 * @property {number} elapsed_ms
 * @property {string[]} errors             — endpoint errors encountered
 * @property {ProviderSnapshot[]} providers
 * @property {object} summary
 * @property {object|null} opsDoctor       — ops_doctor diagnostic checks (null if unavailable)
 */

/**
 * @typedef {object} OpsDoctorResult
 * @property {string} timestamp
 * @property {string} repo_root
 * @property {Array<{name: string, status: string, detail: string}>} checks
 */

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Fetch JSON from a URL with timeout.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ data: object | null, error: string | null }>}
 */
async function fetchJson(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { data: null, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    return { data, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted")) return { data: null, error: "timeout" };
    return { data: null, error: msg };
  }
}

// ─── Normalizers (exported for unit testing) ─────────────────────────────────

/**
 * Normalize GPT admin /health output → ProviderSnapshot
 *
 * The GPT /health endpoint returns a rich object with:
 *   - Top-level: cdp, provider_count, providers[], queue_depth, session_locks, paths
 *   - runtime_contract: status, service_alive, logged_in, cdp_ready, browser_connected,
 *     blocked_by, queue, profiles[], capabilities, details
 *
 * We preserve the most operationally relevant fields instead of discarding them.
 *
 * @param {object} raw
 * @returns {ProviderSnapshot}
 */
export function normalizeGptHealth(raw) {
  const rc = raw.runtime_contract ?? {};
  // service_alive lives in runtime_contract in the real GPT /health response,
  // but older test fixtures use a flat top-level field. Check both.
  const serviceAlive = rc.service_alive ?? raw.service_alive ?? null;
  const status =
    raw.ok === false
      ? "error"
      : serviceAlive === false
      ? "blocked"
      : "ok";
  return {
    provider: "gpt-web-api",
    providerType: "browser-session",
    status,
    health: {
      cdp: raw.cdp ?? null,
      browserConnected: rc.browser_connected ?? raw.browserConnected ?? null,
      service_alive: rc.service_alive ?? null,
      logged_in: rc.logged_in ?? null,
      cdp_ready: rc.cdp_ready ?? null,
      blocked_by: rc.blocked_by ?? null,
    },
    runtime: {
      queue_depth: raw.queue_depth ?? null,
      session_locks: raw.session_locks ?? null,
      account_id: raw.account_id ?? null,
      profile_lock: raw.profile_lock ?? null,
      lease: raw.lease ?? null,
      provider_count: raw.provider_count ?? null,
      providers: Array.isArray(raw.providers)
        ? raw.providers.map((p) => ({
            id: p.id ?? null,
            type: p.type ?? null,
            capabilities: p.capabilities ?? null,
            models: Array.isArray(p.models) ? p.models : null,
          }))
        : null,
      capabilities: rc.capabilities ?? null,
      jobs_path: raw.jobs_path ?? null,
      session_affinity_path: raw.session_affinity_path ?? null,
      image_output_dir: raw.image_output_dir ?? null,
      upload_dir: raw.upload_dir ?? null,
      media_index_path: raw.media_index_path ?? null,
    },
    accountPool: raw.account_pool_summary ?? null,
    proxyPool: raw.proxy_pool_summary ?? null,
    queueState: null, // requires dedicated queue-state endpoint (deferred)
  };
}

/**
 * Normalize canvas-to-api runtime_status output → ProviderSnapshot
 *
 * canvas-to-api exposes two data sources:
 *   - HTTP /health → thin {browserConnected, status, timestamp} (no auth required)
 *   - runtime_status.mjs script → rich {provider_id, profiles[], queue, capabilities, …}
 *
 * Both shapes are accepted; the normalizer auto-detects richness via contract_version.
 *
 * @param {object} raw
 * @returns {ProviderSnapshot}
 */
export function normalizeCanvasHealth(raw) {
  // Thin /health response: {browserConnected, status, timestamp}
  // Rich runtime_status response: {contract_version, provider_id, profiles[], …}
  const isRich = !!raw.contract_version;
  const status = raw.status === "ok" ? "ok" : raw.status === "degraded" ? "degraded" : raw.status === "blocked" ? "blocked" : "error";
  return {
    provider: raw.provider_id ?? "gemini-canvas",
    providerType: raw.provider_type ?? "browser-session",
    status,
    health: {
      logged_in: raw.logged_in ?? null,
      cdp_ready: raw.cdp_ready ?? null,
      browser_connected: raw.browser_connected ?? raw.browserConnected ?? null,
      service_alive: isRich ? (raw.service_alive ?? null) : null,
      blocked_by: isRich ? (raw.blocked_by ?? null) : null,
    },
    runtime: {
      queue: raw.queue ?? null,
      upstream_status: isRich ? (raw.upstream_health?.status ?? null) : null,
      upstream_browserConnected: isRich ? (raw.upstream_health?.browserConnected ?? null) : null,
    },
    accountPool: null, // canvas-to-api does not manage accounts
    proxyPool: null,
    queueState: raw.queue
      ? {
          contract_version: raw.contract_version ?? null,
          provider: raw.provider_id ?? null,
          queues: [
            {
              scope: "profile",
              scope_id: "default",
              mode: raw.queue.mode ?? "profile-serial",
              enabled: true,
              depth: {
                pending: raw.queue.depth?.pending ?? 0,
                running: raw.queue.depth?.running ?? 0,
                completed: raw.queue.depth?.completed ?? null,
                failed: raw.queue.depth?.failed ?? null,
              },
              leases: Array.isArray(raw.queue.leases) ? raw.queue.leases : [],
              lock_policy: raw.queue.lock_policy ?? null,
            },
          ],
        }
      : null,
  };
}

/**
 * Normalize sub2api /health output → ProviderSnapshot
 * @param {object} raw
 * @returns {ProviderSnapshot}
 */
export function normalizeSub2apiHealth(raw) {
  return {
    provider: "sub2api",
    providerType: "shim",
    status: raw.ok === false ? "error" : "ok",
    health: {
      ok: raw.ok ?? null,
      version: raw.version ?? null,
      uptime_s: raw.uptime_s ?? null,
    },
    runtime: {
      providers_count: raw.providers?.length ?? null,
      accounts_count: raw.accounts?.length ?? null,
    },
    accountPool: null,
    proxyPool: null,
    queueState: null,
  };
}

// ─── OpsDoctor integration ────────────────────────────────────────────────────

/**
 * Spawn the ops_doctor diagnose.mjs script and return parsed JSON.
 * @param {string} diagnosePath  — absolute path to diagnose.mjs
 * @param {string} [extraArg]   — optional extra argument (e.g. "--jobs <path>")
 * @returns {Promise<{data: OpsDoctorResult|null, error: string|null}>}
 */
async function runOpsDoctor(diagnosePath, extraArg = "") {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    // Build args: diagnosePath followed by optional --jobs override
    const args = extraArg ? [diagnosePath, ...extraArg.split(" ")] : [diagnosePath];
    const child = spawn(process.execPath, args, { signal: AbortSignal.timeout(8000) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        // code=1 means checks ran but some WARN/FAIL — still parse output
        try {
          const data = JSON.parse(stdout);
          resolve({ data, error: null });
        } catch {
          resolve({ data: null, error: `JSON parse error: ${stdout.slice(0, 200)}` });
        }
      } else {
        resolve({ data: null, error: stderr || `exit ${code}` });
      }
    });
    child.on("error", (err) => resolve({ data: null, error: err.message }));
  });
}

/**
 * Summarize ops_doctor checks into a one-line status per check name.
 * @param {OpsDoctorResult} data
 * @returns {object}
 */
export function normalizeOpsDoctor(data) {
  if (!data?.checks) return null;
  /** @type {Record<string, {status: string, detail: string}>} */
  const byName = {};
  for (const check of data.checks) {
    byName[check.name] = { status: check.status, detail: check.detail ?? "" };
  }
  return {
    timestamp: data.timestamp ?? null,
    repo_root: data.repo_root ?? null,
    checks: byName,
    // Overall: FAIL if any check FAIL, WARN if any WARN, else OK
    overall:
      data.checks.some((c) => c.status === "FAIL")
        ? "fail"
        : data.checks.some((c) => c.status === "WARN")
        ? "warn"
        : "ok",
  };
}

// ─── Canvas runtime_status script integration ─────────────────────────────────

/**
 * Spawn the canvas runtime_status.mjs script and return parsed JSON.
 * This mirrors the ops_doctor pattern: we call the local diagnostic script
 * rather than the auth-protected HTTP /runtime_status endpoint.
 *
 * @param {string} scriptPath  — absolute path to runtime_status.mjs
 * @returns {Promise<{data: object | null, error: string | null}>}
 */
async function runCanvasRuntimeStatus(scriptPath) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { signal: AbortSignal.timeout(8000) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout);
          resolve({ data, error: null });
        } catch {
          resolve({ data: null, error: `JSON parse error: ${stdout.slice(0, 200)}` });
        }
      } else {
        resolve({ data: null, error: stderr || `exit ${code}` });
      }
    });
    child.on("error", (err) => resolve({ data: null, error: err.message }));
  });
}

// ─── ControlBench factory ────────────────────────────────────────────────────

/**
 * Build a ControlBench instance.
 *
 * @param {ControlBenchOptions} [options]
 * @returns {{ buildReport: () => Promise<ControlReport> }}
 */
export function createControlBench(options = {}) {
  const {
    endpoints = {},
    timeoutMs = 3000,
    includeSub2api = true,
    opsDoctorPath = "",
    canvasRuntimeScriptPath = "",
  } = options;

  const eps = { ...DEFAULT_ENDPOINTS, ...endpoints };
  const errors = [];

  /**
   * Build a unified control report by reading all configured endpoints.
   * This is the primary read entry point.
   *
   * @returns {Promise<ControlReport>}
   */
  async function buildReport() {
    const t0 = Date.now();
    const snapshotErrors = [];

    // Fetch all endpoints in parallel
    const [gptResult, canvasResult, sub2apiResult] = await Promise.all([
      fetchJson(eps.gptAdmin, timeoutMs),
      fetchJson(eps.canvasRuntime, timeoutMs),
      includeSub2api ? fetchJson(eps.sub2api, timeoutMs) : Promise.resolve({ data: null, error: null }),
    ]);

    /** @type {ProviderSnapshot[]} */
    const providers = [];

    if (gptResult.data) {
      try {
        providers.push(normalizeGptHealth(gptResult.data));
      } catch (err) {
        snapshotErrors.push(`gpt-web-api: normalize error — ${err}`);
        providers.push({ provider: "gpt-web-api", providerType: "browser-session", status: "error" });
      }
    } else if (gptResult.error) {
      snapshotErrors.push(`gpt-web-api: ${gptResult.error}`);
      providers.push({ provider: "gpt-web-api", providerType: "browser-session", status: "unreachable" });
    }

    // canvas: prefer runtime_status.mjs script when available (richer than HTTP /health).
    // When canvasRuntimeScriptPath is set, spawn the script and skip the thin HTTP /health.
    // Otherwise fall back to the HTTP /health endpoint.
    let canvasNormalized = null;
    if (canvasRuntimeScriptPath) {
      const canvasScriptRes = await runCanvasRuntimeStatus(canvasRuntimeScriptPath);
      if (canvasScriptRes.data) {
        try {
          canvasNormalized = normalizeCanvasHealth(canvasScriptRes.data);
        } catch (err) {
          snapshotErrors.push(`gemini-canvas(script): normalize error — ${err}`);
        }
      } else {
        snapshotErrors.push(`gemini-canvas(script): ${canvasScriptRes.error ?? "no output"}`);
      }
    } else if (canvasResult.data) {
      try {
        canvasNormalized = normalizeCanvasHealth(canvasResult.data);
      } catch (err) {
        snapshotErrors.push(`gemini-canvas: normalize error — ${err}`);
      }
    } else if (canvasResult.error) {
      snapshotErrors.push(`gemini-canvas: ${canvasResult.error}`);
    }
    if (canvasNormalized) {
      providers.push(canvasNormalized);
    } else if (!canvasRuntimeScriptPath) {
      // Only push unreachable placeholder if we didn't have a script path to try
      providers.push({ provider: "gemini-canvas", providerType: "browser-session", status: "unreachable" });
    }

    // sub2api is now included by default and participates in summary counts
    if (includeSub2api) {
      if (sub2apiResult.data) {
        try {
          providers.push(normalizeSub2apiHealth(sub2apiResult.data));
        } catch (err) {
          snapshotErrors.push(`sub2api: normalize error — ${err}`);
          providers.push({ provider: "sub2api", providerType: "shim", status: "error" });
        }
      } else if (sub2apiResult.error) {
        snapshotErrors.push(`sub2api: ${sub2apiResult.error}`);
        providers.push({ provider: "sub2api", providerType: "shim", status: "unreachable" });
      }
    }

    // ops_doctor: run the diagnostic script if path is provided
    /** @type {object|null} */
    let opsDoctorResult = null;
    if (opsDoctorPath) {
      const doctorRes = await runOpsDoctor(opsDoctorPath);
      if (doctorRes.data) {
        opsDoctorResult = normalizeOpsDoctor(doctorRes.data);
      } else {
        snapshotErrors.push(`ops_doctor: ${doctorRes.error ?? "no output"}`);
        opsDoctorResult = { overall: "unavailable", error: doctorRes.error, checks: {} };
      }
    }

    const elapsed_ms = Date.now() - t0;

    // Build summary
    const summary = buildSummary(providers);

    return {
      contract_version: CONTROL_WORKBENCH_VERSION,
      generated_at: new Date().toISOString(),
      elapsed_ms,
      errors: snapshotErrors,
      providers,
      summary,
      opsDoctor: opsDoctorResult,
    };
  }

  return { buildReport };
}

/**
 * Build a human-readable summary from provider snapshots.
 * @param {ProviderSnapshot[]} providers
 * @returns {object}
 */
export function buildSummary(providers) {
  const counts = { ok: 0, degraded: 0, blocked: 0, error: 0, unreachable: 0 };
  for (const p of providers) {
    const s = String(p.status ?? "unknown");
    if (s in counts) counts[s]++;
    else counts.error++;
  }
  // Priority ordering: worst → best
  // unreachable > error > blocked > degraded > mixed > ok
  const overall =
    counts.unreachable === providers.length
      ? "all_unreachable"
      : counts.error > 0
      ? "error"
      : counts.blocked > 0
      ? "blocked"
      : counts.degraded > 0 && counts.ok === 0
      ? "degraded"
      : counts.degraded > 0 || counts.ok < providers.length
      ? "mixed"
      : "ok";
  return { overall, counts, total: providers.length };
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

/**
 * CLI: node src/index.mjs [--json] [--no-sub2api] [--ops-doctor-path=<path>]
 *         [--canvas-runtime-script-path=<path>] [--timeout=3000]
 */
export async function main(argv = process.argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const includeSub2api = !args.includes("--no-sub2api");
  const opsDoctorArg = args.find((a) => a.startsWith("--ops-doctor-path="));
  const opsDoctorPath = opsDoctorArg ? opsDoctorArg.split("=")[1] : "";
  const canvasScriptArg = args.find((a) => a.startsWith("--canvas-runtime-script-path="));
  const canvasRuntimeScriptPath = canvasScriptArg ? canvasScriptArg.split("=")[1] : "";
  const timeoutArg = args.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) : 3000;

  const bench = createControlBench({ includeSub2api, timeoutMs, opsDoctorPath, canvasRuntimeScriptPath });
  const report = await bench.buildReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }

  // Exit code: 0 = all ok, 1 = any errors or unreachable
  const hasErrors =
    report.errors.length > 0 ||
    report.summary.counts.error > 0 ||
    report.summary.counts.unreachable > 0 ||
    report.opsDoctor?.overall === "fail";
  process.exit(hasErrors ? 1 : 0);
}

function printText(report) {
  console.log(`Control Workbench — ${report.contract_version}`);
  console.log(`Generated: ${report.generated_at} (${report.elapsed_ms}ms)`);
  console.log(`Overall: ${report.summary.overall}  (${report.summary.counts.ok}/${report.summary.total} ok)`);
  if (report.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of report.errors) console.log(`  ! ${e}`);
  }
  console.log("\nProviders:");
  for (const p of report.providers) {
    const parts = [p.status];
    if (p.providerType) parts.push(p.providerType);
    console.log(`  [${parts.join("|")}] ${p.provider}`);
    if (p.health) {
      const h = p.health;
      if (h.service_alive !== undefined && h.service_alive !== null) console.log(`    service_alive=${h.service_alive}`);
      if (h.logged_in !== undefined && h.logged_in !== null) console.log(`    logged_in=${h.logged_in}`);
      if (h.cdp_ready !== undefined && h.cdp_ready !== null) console.log(`    cdp_ready=${h.cdp_ready}`);
      if (h.browser_connected !== undefined && h.browser_connected !== null) console.log(`    browser_connected=${h.browser_connected}`);
      if (h.cdp !== undefined && h.cdp !== null) console.log(`    cdp=${h.cdp}`);
      if (h.blocked_by !== undefined && h.blocked_by !== null) console.log(`    blocked_by=${h.blocked_by}`);
      if (h.ok !== undefined && h.ok !== null) console.log(`    ok=${h.ok}`);
      if (h.uptime_s !== undefined && h.uptime_s !== null) console.log(`    uptime_s=${h.uptime_s}`);
    }
    if (p.runtime) {
      const r = p.runtime;
      if (r.queue_depth !== undefined && r.queue_depth !== null) console.log(`    queue_depth=${r.queue_depth}`);
      if (r.session_locks !== undefined && r.session_locks !== null) console.log(`    session_locks=${r.session_locks}`);
      if (r.provider_count !== undefined && r.provider_count !== null) console.log(`    provider_count=${r.provider_count}`);
      if (r.providers_count !== undefined && r.providers_count !== null) console.log(`    providers=${r.providers_count}`);
      if (r.accounts_count !== undefined && r.accounts_count !== null) console.log(`    accounts=${r.accounts_count}`);
      if (r.capabilities !== undefined && r.capabilities !== null) {
        const caps = r.capabilities;
        const capList = Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k).join(",");
        console.log(`    capabilities=[${capList}]`);
      }
      if (r.providers !== undefined && r.providers !== null && r.providers.length > 0) {
        for (const prov of r.providers) {
          if (prov.models) console.log(`    provider=${prov.id} models=[${prov.models.join(",")}]`);
        }
      }
      if (r.upstream_status !== undefined && r.upstream_status !== null) console.log(`    upstream_status=${r.upstream_status}`);
      if (r.upstream_browserConnected !== undefined && r.upstream_browserConnected !== null) console.log(`    upstream_browserConnected=${r.upstream_browserConnected}`);
    }
    if (p.accountPool) console.log(`    account_pool: total=${p.accountPool.total} available=${p.accountPool.available} leased=${p.accountPool.leased}`);
    if (p.proxyPool) console.log(`    proxy_pool: total=${p.proxyPool.total} healthy=${p.proxyPool.healthy}`);
  }
  if (report.opsDoctor) {
    console.log(`\nOps Doctor: ${report.opsDoctor.overall}`);
    if (report.opsDoctor.error) console.log(`  error: ${report.opsDoctor.error}`);
    for (const [name, check] of Object.entries(report.opsDoctor.checks ?? {})) {
      console.log(`  [${check.status}] ${name}: ${check.detail}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv);
}
