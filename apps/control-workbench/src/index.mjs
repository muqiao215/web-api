/**
 * apps/control-workbench — Read-only control surface for provider/admin runtime state.
 *
 * Contract version: wcapi.control-workbench.v1
 *
 * Design: this package is intentionally read-only. It fetches from existing HTTP
 * health/status endpoints (GPT admin service, canvas-to-api, ops_doctor) and
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

export const CONTROL_WORKBENCH_VERSION = "wcapi.control-workbench.v1";

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
 * @property {boolean} [includeSub2api]          — whether to fetch sub2api health (default false)
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
 * @param {object} raw
 * @returns {ProviderSnapshot}
 */
export function normalizeGptHealth(raw) {
  const status = raw.ok === false ? "error" : raw.service_alive === false ? "blocked" : "ok";
  return {
    provider: "gpt-web-api",
    providerType: "browser-session",
    status,
    health: {
      cdp: raw.cdp ?? null,
      browserConnected: raw.browserConnected ?? null,
    },
    runtime: {
      queue_depth: raw.queue_depth ?? null,
      session_locks: raw.session_locks ?? null,
      account_id: raw.account_id ?? null,
      profile_lock: raw.profile_lock ?? null,
      lease: raw.lease ?? null,
    },
    accountPool: raw.account_pool_summary ?? null,
    proxyPool: raw.proxy_pool_summary ?? null,
    queueState: null, // requires dedicated queue-state endpoint (deferred)
  };
}

/**
 * Normalize canvas-to-api /health output → ProviderSnapshot
 * @param {object} raw
 * @returns {ProviderSnapshot}
 */
export function normalizeCanvasHealth(raw) {
  const status = raw.status === "ok" ? "ok" : raw.status === "degraded" ? "degraded" : raw.status === "blocked" ? "blocked" : "error";
  return {
    provider: raw.provider_id ?? "gemini-canvas",
    providerType: raw.provider_type ?? "browser-session",
    status,
    health: {
      logged_in: raw.logged_in ?? null,
      cdp_ready: raw.cdp_ready ?? null,
      browser_connected: raw.browser_connected ?? null,
    },
    runtime: {
      queue: raw.queue ?? null,
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
 * Normalize sub2api /health output → minimal snapshot
 * @param {object} raw
 * @returns {object}
 */
function normalizeSub2apiHealth(raw) {
  return {
    provider: "sub2api",
    providerType: "shim",
    status: raw.ok === false ? "error" : "ok",
    health: { ok: raw.ok ?? null },
  };
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
    includeSub2api = false,
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
      }
    } else if (gptResult.error) {
      snapshotErrors.push(`gpt-web-api: ${gptResult.error}`);
      providers.push({ provider: "gpt-web-api", providerType: "browser-session", status: "unreachable" });
    }

    if (canvasResult.data) {
      try {
        providers.push(normalizeCanvasHealth(canvasResult.data));
      } catch (err) {
        snapshotErrors.push(`gemini-canvas: normalize error — ${err}`);
      }
    } else if (canvasResult.error) {
      snapshotErrors.push(`gemini-canvas: ${canvasResult.error}`);
      providers.push({ provider: "gemini-canvas", providerType: "browser-session", status: "unreachable" });
    }

    if (includeSub2api && sub2apiResult.data) {
      try {
        providers.push(normalizeSub2apiHealth(sub2apiResult.data));
      } catch (err) {
        snapshotErrors.push(`sub2api: normalize error — ${err}`);
      }
    } else if (includeSub2api && sub2apiResult.error) {
      snapshotErrors.push(`sub2api: ${sub2apiResult.error}`);
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
 * CLI: node src/index.mjs [--json] [--include-sub2api] [--timeout=3000]
 */
export async function main(argv = process.argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const includeSub2api = args.includes("--include-sub2api");
  const timeoutArg = args.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) : 3000;

  const bench = createControlBench({ includeSub2api, timeoutMs });
  const report = await bench.buildReport();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }

  // Exit code: 0 = all ok, 1 = any errors or unreachable
  const hasErrors = report.errors.length > 0 || report.summary.counts.error > 0 || report.summary.counts.unreachable > 0;
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
      if (h.logged_in !== undefined && h.logged_in !== null) console.log(`    logged_in=${h.logged_in}`);
      if (h.browser_connected !== undefined && h.browser_connected !== null) console.log(`    browser_connected=${h.browser_connected}`);
      if (h.cdp_ready !== undefined && h.cdp_ready !== null) console.log(`    cdp_ready=${h.cdp_ready}`);
      if (h.cdp !== undefined && h.cdp !== null) console.log(`    cdp=${h.cdp}`);
    }
    if (p.runtime?.queue_depth !== undefined && p.runtime?.queue_depth !== null) console.log(`    queue_depth=${p.runtime.queue_depth}`);
    if (p.accountPool) console.log(`    account_pool: total=${p.accountPool.total} available=${p.accountPool.available} leased=${p.accountPool.leased}`);
    if (p.proxyPool) console.log(`    proxy_pool: total=${p.proxyPool.total} healthy=${p.proxyPool.healthy}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv);
}
