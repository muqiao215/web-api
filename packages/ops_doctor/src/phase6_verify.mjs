#!/usr/bin/env node
/**
 * packages/ops_doctor/src/phase6_verify.mjs
 *
 * Phase 6 verification smoke script — smallest useful validation skeleton.
 *
 * Scope:
 *   1. GPT worker smoke — verify admin service /health is reachable and returns
 *      the expected runtime_contract shape.
 *   2. sub2api smoke — verify the external control plane /health is reachable.
 *      Provider routing is only claimed when the endpoint exposes provider data.
 *   3. Gemini Web smoke — verify the canonical Gemini Web runtime /health.
 *
 * Architecture chain under test:
 *   consumer → sub2api → gpt-web-responses shim → GPT provider worker
 *
 * This script is read-only. It does not modify state, issue commands,
 * or start/stop services.
 *
 * Exit codes:
 *   0  — GPT, sub2api, and Gemini Web runtime smoke all pass
 *   1  — any provider path is unreachable / invalid / blocked
 *   2  — usage / environment error
 */

import { pathToFileURL } from "node:url";

const REPO_ROOT = import.meta.dirname.split("/").slice(0, -3).join("/");
const GPT_ADMIN_URL = process.env.GPT_ADMIN_URL || "http://127.0.0.1:4242/health";
const SUB2API_URL = process.env.SUB2API_URL || "http://127.0.0.1:18080/health";
const GEMINI_WEB_HEALTH_URL = process.env.GEMINI_WEB_RUNTIME_HEALTH_URL || "http://127.0.0.1:7862/health";
const TIMEOUT_MS = 5000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyFetchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("aborted")) return "timeout";
  if (
    normalized.includes("fetch failed") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("networkerror") ||
    normalized.includes("network error")
  ) {
    return `unreachable: ${message}`;
  }
  return message;
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: boolean, status?: number, data?: object, error?: string}>}
 */
export async function fetchHealth(url, timeoutMs = TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      error: classifyFetchError(error),
    };
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      error: `invalid_json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    status: response.status,
    data,
  };
}

/**
 * Verify GPT admin service /health returns expected shape.
 */
export async function smokeGptAdmin(url = GPT_ADMIN_URL, fetcher = fetchHealth) {
  const result = await fetcher(url);

  if (!result.ok) {
    return {
      name: "gpt-admin-health",
      status: "UNREACHABLE",
      detail: result.error || "unknown error",
      evidence: null,
    };
  }

  const data = result.data;
  const hasRuntimeContract = isPlainObject(data?.runtime_contract);
  const hasServiceAlive = typeof data?.runtime_contract?.service_alive === "boolean";
  const hasProviderCount = typeof data?.provider_count === "number";
  const hasCdpField = typeof data?.cdp === "string" || data?.cdp === null;
  const passed = result.status === 200 && hasRuntimeContract && hasServiceAlive && hasProviderCount && hasCdpField;

  return {
    name: "gpt-admin-health",
    status: passed ? "PASS" : "FAIL",
    detail: passed
      ? `GPT admin service reachable — ok=${data?.ok} service=${data?.service} service_alive=${data?.runtime_contract?.service_alive} providers=${data?.provider_count}`
      : `Unexpected shape: HTTP ${result.status} runtime_contract=${hasRuntimeContract} service_alive=${hasServiceAlive} provider_count=${hasProviderCount} cdp_field=${hasCdpField}`,
    evidence: {
      httpStatus: result.status,
      ok: data?.ok ?? null,
      service: data?.service ?? null,
      runtime_contract: data?.runtime_contract ?? null,
      provider_count: data?.provider_count ?? null,
    },
  };
}

function inferRoutingEvidence(data) {
  if (!Array.isArray(data?.providers)) {
    return { routingVerified: false, providerHints: [] };
  }

  const providerHints = data.providers.map((provider) => {
    if (typeof provider === "string") return provider;
    if (!isPlainObject(provider)) return String(provider);
    return [
      provider.id,
      provider.name,
      provider.provider,
      provider.model,
      provider.upstream,
    ].filter(Boolean).join(":");
  });

  const routingVerified = providerHints.some((hint) => /gpt|chatgpt/i.test(hint));
  return { routingVerified, providerHints };
}

/**
 * Verify sub2api /health is reachable and avoid over-claiming provider routing.
 */
export async function smokeSub2api(url = SUB2API_URL, fetcher = fetchHealth) {
  const result = await fetcher(url);

  if (!result.ok) {
    return {
      name: "sub2api-health",
      status: "UNREACHABLE",
      detail: result.error || "unknown error",
      evidence: null,
    };
  }

  const data = result.data;
  const isHealthyObject = isPlainObject(data);
  const healthValue = data?.ok === true ? "ok" : data?.status ?? null;
  const healthy = healthValue === "ok";
  const { routingVerified, providerHints } = inferRoutingEvidence(data);
  const passed = result.status === 200 && isHealthyObject && healthy;

  return {
    name: "sub2api-health",
    status: passed ? "PASS" : "FAIL",
    detail: passed
      ? routingVerified
        ? "sub2api /health reachable — control plane healthy and provider metadata suggests GPT routing is present"
        : "sub2api /health reachable — control plane healthy; GPT routing is not proven by this endpoint"
      : `sub2api returns unexpected shape: HTTP ${result.status} object=${isHealthyObject} health=${String(healthValue)}`,
    evidence: {
      httpStatus: result.status,
      ok: data?.ok ?? null,
      status: data?.status ?? null,
      version: data?.version ?? null,
      uptime_s: data?.uptime_s ?? null,
      providers: Array.isArray(data?.providers) ? data.providers : null,
      provider_hints: providerHints,
      routing_verified: routingVerified,
      limitation: routingVerified
        ? null
        : "/health only proves control-plane reachability unless provider metadata is exposed",
      keys: isHealthyObject ? Object.keys(data).slice(0, 10) : null,
    },
  };
}

/**
 * Verify Gemini Web runtime /health directly.
 */
export async function smokeCanvas(url = GEMINI_WEB_HEALTH_URL, fetcher = fetchHealth) {
  const result = await fetcher(url);

  if (!result.ok) {
    return {
      name: "gemini-web-health",
      status: "UNREACHABLE",
      detail: result.error || "unknown error",
      evidence: null,
    };
  }

  const data = result.data;
  const isHealthyObject = isPlainObject(data);
  const serviceStatus = data?.status ?? null;
  const serviceAlive = data?.service_alive;
  const providerCanonical = data?.provider_id_canonical ?? data?.provider_family ?? null;
  const hasExpectedShape =
    isHealthyObject &&
    typeof serviceStatus === "string" &&
    typeof serviceAlive === "boolean" &&
    typeof providerCanonical === "string";

  if (!hasExpectedShape) {
    return {
      name: "gemini-web-health",
      status: "FAIL",
      detail: `gemini-web /health returned unexpected shape: HTTP ${result.status} object=${isHealthyObject} status_type=${typeof serviceStatus} service_alive_type=${typeof serviceAlive} provider_type=${typeof providerCanonical}`,
      evidence: {
        httpStatus: result.status,
        payload: data,
      },
    };
  }

  if (result.status !== 200 || serviceStatus !== "ok") {
    return {
      name: "gemini-web-health",
      status: "FAIL",
      detail: `gemini-web /health reachable but unhealthy: HTTP ${result.status} status=${serviceStatus}`,
      evidence: {
        httpStatus: result.status,
        status: serviceStatus,
        service_alive: serviceAlive,
        provider_id_canonical: providerCanonical,
        blocked_by: data?.blocked_by ?? null,
      },
    };
  }

  return {
    name: "gemini-web-health",
    status: "PASS",
    detail: `gemini-web /health reachable — status=ok service_alive=${serviceAlive} provider=${providerCanonical}`,
    evidence: {
      httpStatus: result.status,
      status: serviceStatus,
      service_alive: serviceAlive,
      provider_id_canonical: providerCanonical,
      blocked_by: data?.blocked_by ?? null,
    },
  };
}

export async function runPhase6Verification(options = {}) {
  const {
    gptAdminUrl = GPT_ADMIN_URL,
    sub2apiUrl = SUB2API_URL,
    canvasHealthUrl = GEMINI_WEB_HEALTH_URL,
    fetcher = fetchHealth,
  } = options;

  const [gptResult, sub2apiResult, canvasResult] = await Promise.all([
    smokeGptAdmin(gptAdminUrl, fetcher),
    smokeSub2api(sub2apiUrl, fetcher),
    smokeCanvas(canvasHealthUrl, fetcher),
  ]);

  const results = [gptResult, sub2apiResult, canvasResult];
  const gptOk = gptResult.status === "PASS";
  const sub2apiOk = sub2apiResult.status === "PASS";
  const canvasOk = canvasResult.status === "PASS";
  const exitCode = gptOk && sub2apiOk && canvasOk ? 0 : 1;

  const output = {
    phase: 6,
    contract_version: "wcapi.phase6.v2",
    timestamp: new Date().toISOString(),
    repo_root: REPO_ROOT,
    results,
    summary: {
      gpt_worker_smoke: gptResult.status,
      sub2api_smoke: sub2apiResult.status,
      gemini_web_smoke: canvasResult.status,
      exit_code: exitCode,
    },
  };

  return { exitCode, output };
}

export async function main(options = {}) {
  const {
    emit = true,
    stderr = process.stderr,
    stdout = process.stdout,
  } = options;

  const { exitCode, output } = await runPhase6Verification(options);

  if (emit) {
    stderr.write("Phase 6 verification — smoke tests starting...\n");
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    stderr.write("\n--- Phase 6 Smoke Summary ---\n");
    for (const result of output.results) {
      stderr.write(`[${result.status}] ${result.name}: ${result.detail}\n`);
    }
    stderr.write(`Exit: ${exitCode}\n`);
  }

  return { exitCode, output };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const { exitCode } = await main();
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}
