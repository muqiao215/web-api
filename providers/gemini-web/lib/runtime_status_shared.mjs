import { spawnSync } from "node:child_process";

export const CONTRACT_VERSION = "wcapi.browser_worker_runtime.v1";
export const GEMINI_WEB_PROVIDER_FAMILY = "gemini-web";
export const GEMINI_WEB_CANONICAL_PROVIDER_ID = GEMINI_WEB_PROVIDER_FAMILY;
export const GEMINI_WEB_COMPAT_PROVIDER_ID = "gemini-canvas";
export const GEMINI_WEB_PROVIDER_ALIASES = Object.freeze([
  GEMINI_WEB_COMPAT_PROVIDER_ID,
  GEMINI_WEB_CANONICAL_PROVIDER_ID,
]);
export const GEMINI_WEB_TRANSPORT_ID = "gemini-web-runtime";
export const GEMINI_WEB_COMPATIBILITY_PATH = "providers/canvas-to-api";
export const GEMINI_WEB_SURFACE_PATH = "providers/gemini-web";
export const GEMINI_WEB_UPSTREAM_PATH = "providers/gemini-web/upstream";
export const GEMINI_WEB_RUNTIME_HEALTH_URL =
  process.env.GEMINI_WEB_RUNTIME_HEALTH_URL || "http://127.0.0.1:7862/health";
export const CANVAS_HEALTH_URL =
  process.env.CANVAS_TO_API_HEALTH_URL || "http://127.0.0.1:7861/health";

export const RUNTIME_CONTRACT = {
  status_schema: "https://local.web-capability-api/schemas/provider-capability.schema.json",
  artifact_schema: "https://local.web-capability-api/schemas/artifact-record.schema.json",
  queue_scope: "none",
};

export const GEMINI_WEB_TRANSPORT = {
  id: GEMINI_WEB_TRANSPORT_ID,
  type: "cookie-auth-web-runtime",
  compatibility_path: GEMINI_WEB_COMPATIBILITY_PATH,
  provider_surface_path: GEMINI_WEB_SURFACE_PATH,
  canonical_launcher: `${GEMINI_WEB_SURFACE_PATH}/start.mjs`,
  legacy_launcher: `${GEMINI_WEB_COMPATIBILITY_PATH}/start.mjs`,
  canonical_runtime_status: `${GEMINI_WEB_SURFACE_PATH}/runtime_status.mjs`,
  legacy_runtime_status: `${GEMINI_WEB_COMPATIBILITY_PATH}/runtime_status.mjs`,
  startup_delegate_cwd: GEMINI_WEB_UPSTREAM_PATH,
  live_runtime_owner: GEMINI_WEB_UPSTREAM_PATH,
  health_url: GEMINI_WEB_RUNTIME_HEALTH_URL,
  notes: "Gemini Web-first cookie runtime. Chat is canonical; image admission is experimental.",
};

function checkSystemd(unit) {
  const proc = spawnSync("systemctl", ["is-active", unit], {
    encoding: "utf8",
  });
  const state = (proc.stdout || proc.stderr || "").trim() || "unknown";
  return {
    unit,
    active: state === "active",
    state,
  };
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function fallbackRuntimeStatus(error) {
  const message = String(error?.message || error);
  const blockedBy = /cookie|psid|login/i.test(message) ? "cookie_missing" : "runtime_unavailable";
  return {
    contract_version: CONTRACT_VERSION,
    provider_id: GEMINI_WEB_COMPAT_PROVIDER_ID,
    provider_id_canonical: GEMINI_WEB_CANONICAL_PROVIDER_ID,
    provider_id_legacy: GEMINI_WEB_COMPAT_PROVIDER_ID,
    provider_family: GEMINI_WEB_PROVIDER_FAMILY,
    provider_aliases: [...GEMINI_WEB_PROVIDER_ALIASES],
    provider_type: "local-api",
    checked_at: new Date().toISOString(),
    status: blockedBy === "cookie_missing" ? "blocked" : "error",
    service_alive: false,
    logged_in: false,
    cdp_ready: null,
    browser_connected: null,
    browserConnected: null,
    blocked_by: blockedBy,
    runtime_contract: RUNTIME_CONTRACT,
    transport: GEMINI_WEB_TRANSPORT,
    queue: {
      supported: false,
      mode: "none",
      depth: {
        pending: null,
        running: null,
        completed: null,
        failed: null,
      },
      leases: [],
      lock_policy: null,
    },
    profiles: [],
    capabilities: {
      chat: true,
      images: true,
      files: true,
      vision: true,
    },
    details: {
      health_url: GEMINI_WEB_RUNTIME_HEALTH_URL,
      admission: {
        chat: "ok",
        images: "experimental",
        files: "ok",
        vision: "ok",
      },
      error: message,
      legacy_bridge_health_url: CANVAS_HEALTH_URL,
      systemd_units: [
        checkSystemd("canvas-to-api.service"),
        checkSystemd("gemini-canvas-xvfb.service"),
        checkSystemd("gemini-canvas-novnc.service"),
      ],
    },
  };
}

function normalizeRuntimeStatus(payload) {
  return {
    ...payload,
    contract_version: payload.contract_version ?? CONTRACT_VERSION,
    provider_id: payload.provider_id ?? GEMINI_WEB_COMPAT_PROVIDER_ID,
    provider_id_canonical: payload.provider_id_canonical ?? GEMINI_WEB_CANONICAL_PROVIDER_ID,
    provider_id_legacy: payload.provider_id_legacy ?? GEMINI_WEB_COMPAT_PROVIDER_ID,
    provider_family: payload.provider_family ?? GEMINI_WEB_PROVIDER_FAMILY,
    provider_aliases: Array.isArray(payload.provider_aliases)
      ? payload.provider_aliases
      : [...GEMINI_WEB_PROVIDER_ALIASES],
    provider_type: payload.provider_type ?? "local-api",
    runtime_contract: payload.runtime_contract ?? RUNTIME_CONTRACT,
    transport: {
      ...GEMINI_WEB_TRANSPORT,
      ...(payload.transport ?? {}),
    },
    queue: payload.queue ?? {
      supported: false,
      mode: "none",
      depth: {
        pending: null,
        running: null,
        completed: null,
        failed: null,
      },
      leases: [],
      lock_policy: null,
    },
    profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
    capabilities: {
      chat: true,
      images: true,
      files: true,
      vision: true,
      ...(payload.capabilities ?? {}),
    },
    details: {
      health_url: GEMINI_WEB_RUNTIME_HEALTH_URL,
      admission: {
        chat: "ok",
        images: "experimental",
        files: "ok",
        vision: "ok",
        ...(payload.details?.admission ?? {}),
      },
      legacy_bridge_health_url: CANVAS_HEALTH_URL,
      systemd_units: [
        checkSystemd("canvas-to-api.service"),
        checkSystemd("gemini-canvas-xvfb.service"),
        checkSystemd("gemini-canvas-novnc.service"),
      ],
      ...(payload.details ?? {}),
    },
  };
}

export async function getGeminiWebRuntimeStatus() {
  try {
    const payload = await fetchJson(GEMINI_WEB_RUNTIME_HEALTH_URL);
    return normalizeRuntimeStatus(payload);
  } catch (error) {
    return fallbackRuntimeStatus(error);
  }
}

export async function getGeminiWebCanvasShareRuntimeStatus() {
  return getGeminiWebRuntimeStatus();
}

export async function emitGeminiWebRuntimeStatus() {
  const payload = await getGeminiWebRuntimeStatus();
  console.log(JSON.stringify(payload, null, 2));
}

export async function emitGeminiWebCanvasShareRuntimeStatus() {
  await emitGeminiWebRuntimeStatus();
}
