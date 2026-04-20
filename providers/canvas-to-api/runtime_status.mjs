import { spawnSync } from "node:child_process";

const CONTRACT_VERSION = "wcapi.browser_worker_runtime.v1";
const CANVAS_HEALTH_URL = process.env.CANVAS_TO_API_HEALTH_URL || "http://127.0.0.1:7861/health";
const PROFILE_SPECS = [
  {
    id: "a",
    label: "Gemini Canvas profile A",
    userDataDir: "/root/.ductor/state/browser-profiles/gemini-a",
    cdpHttp: "http://127.0.0.1:9231",
    systemdUnit: "gemini-canvas-browser@a.service",
  },
  {
    id: "b",
    label: "Gemini Canvas profile B",
    userDataDir: "/root/.ductor/state/browser-profiles/gemini-b",
    cdpHttp: "http://127.0.0.1:9232",
    systemdUnit: "gemini-canvas-browser@b.service",
  },
];

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

function inferLoggedIn(pages) {
  const normalized = pages.map((page) => ({
    title: String(page.title || ""),
    url: String(page.url || ""),
  }));
  const signInPage = normalized.find((page) =>
    /accounts\.google\.com|signin|sign in|choose an account|log in/i.test(`${page.url} ${page.title}`)
  );
  if (signInPage) return false;
  const geminiPage = normalized.find((page) => /gemini\.google\.com/i.test(page.url));
  if (geminiPage) return true;
  return null;
}

async function inspectProfile(profile) {
  const unit = checkSystemd(profile.systemdUnit);
  try {
    const version = await fetchJson(`${profile.cdpHttp}/json/version`);
    const pages = await fetchJson(`${profile.cdpHttp}/json/list`);
    const loggedIn = inferLoggedIn(Array.isArray(pages) ? pages : []);
    return {
      id: profile.id,
      label: profile.label,
      user_data_dir: profile.userDataDir,
      cdp_http: profile.cdpHttp,
      cdp_ready: true,
      logged_in: loggedIn,
      browser_connected: unit.active,
      queue: {
        supported: true,
        mode: "profile-serial",
        pending: null,
        running: null,
        locks_active: null,
      },
      details: {
        browser: version.Browser || "",
        websocket_debugger_url: version.webSocketDebuggerUrl || "",
        systemd: unit,
        pages: (Array.isArray(pages) ? pages : [])
          .filter((page) => page.type === "page")
          .map((page) => ({
            id: page.id,
            title: page.title || "",
            url: page.url || "",
          }))
          .slice(0, 20),
      },
    };
  } catch (error) {
    return {
      id: profile.id,
      label: profile.label,
      user_data_dir: profile.userDataDir,
      cdp_http: profile.cdpHttp,
      cdp_ready: false,
      logged_in: null,
      browser_connected: unit.active,
      queue: {
        supported: true,
        mode: "profile-serial",
        pending: null,
        running: null,
        locks_active: null,
      },
      details: {
        systemd: unit,
        error: String(error?.message || error),
      },
    };
  }
}

function deriveTopLevel(profiles, upstreamHealth) {
  const cdpReady = profiles.some((profile) => profile.cdp_ready === true);
  const loggedInStates = profiles.map((profile) => profile.logged_in).filter((value) => value !== null);
  const loggedIn = loggedInStates.includes(true) ? true : loggedInStates.includes(false) ? false : null;
  const browserConnected = upstreamHealth?.browserConnected === true;
  let status = "ok";
  let blockedBy = "none";
  if (!upstreamHealth?.status) {
    status = "error";
    blockedBy = "upstream_unavailable";
  } else if (!browserConnected) {
    status = "blocked";
    blockedBy = "browser_session";
  } else if (loggedIn === false) {
    status = "blocked";
    blockedBy = "login_required";
  } else if (!cdpReady || loggedIn === null) {
    status = "degraded";
    blockedBy = "unknown";
  }
  return {
    cdpReady,
    loggedIn,
    browserConnected,
    status,
    blockedBy,
  };
}

async function main() {
  let upstreamHealth = null;
  try {
    upstreamHealth = await fetchJson(CANVAS_HEALTH_URL);
  } catch (error) {
    upstreamHealth = {
      status: null,
      browserConnected: false,
      error: String(error?.message || error),
    };
  }

  const profiles = await Promise.all(PROFILE_SPECS.map((profile) => inspectProfile(profile)));
  const derived = deriveTopLevel(profiles, upstreamHealth);

  const payload = {
    contract_version: CONTRACT_VERSION,
    provider_id: "gemini-canvas",
    provider_type: "browser-session",
    checked_at: new Date().toISOString(),
    status: derived.status,
    service_alive: upstreamHealth?.status === "ok",
    logged_in: derived.loggedIn,
    cdp_ready: derived.cdpReady,
    browser_connected: derived.browserConnected,
    browserConnected: derived.browserConnected,
    blocked_by: derived.blockedBy,
    queue: {
      supported: true,
      mode: "profile-serial",
      pending: null,
      running: null,
      locks_active: null,
    },
    lock_policy: {
      scope: "profile",
      implementation: "External profile-level lock required",
      note: "Each persistent Gemini Canvas browser profile must be treated as a single-flight worker until the upstream exposes queue counters.",
    },
    profiles,
    capabilities: {
      chat: false,
      images: true,
      files: false,
      vision: false,
    },
    details: {
      health_url: CANVAS_HEALTH_URL,
      upstream_health: upstreamHealth,
      systemd_units: [
        checkSystemd("canvas-to-api.service"),
        checkSystemd("gemini-canvas-xvfb.service"),
        checkSystemd("gemini-canvas-novnc.service"),
      ],
    },
  };

  console.log(JSON.stringify(payload, null, 2));
}

await main();
