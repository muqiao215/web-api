export const RUNTIME_TIERS = {
  LIGHTWEIGHT_TEXT: "tier0_lightweight_text",
  BROWSER_CAPABILITY: "tier1_browser_capability",
  SESSION_MAINTENANCE: "tier2_session_maintenance",
  LONG_RUNNING: "tier3_long_running",
};

export const INTEGRATION_CLASSES = {
  REPO_NATIVE_RUNTIME: "repo_native_runtime",
  RUNTIME_STATUS_BRIDGE: "runtime_status_bridge",
  LIGHTWEIGHT_TEXT_BOUNDARY: "lightweight_text_boundary",
  EXTERNAL_WORKER_SHIM: "external_worker_plus_shim",
};

function normalizeTier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return Object.values(RUNTIME_TIERS).includes(normalized) ? normalized : null;
}

function normalizeIntegrationClass(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return Object.values(INTEGRATION_CLASSES).includes(normalized) ? normalized : null;
}

function hasRichMessageContent(messages = []) {
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const type = typeof item?.type === "string" ? item.type : "";
      if (type === "image_url" || type === "input_image" || type === "file" || type === "input_file") {
        return true;
      }
    }
  }
  return false;
}

function hasTooling(payload = {}) {
  return Array.isArray(payload.tools) && payload.tools.length > 0;
}

function hasFiles(payload = {}) {
  return Array.isArray(payload.file_ids) && payload.file_ids.some((item) => typeof item === "string" && item.trim());
}

function inferTierFromCapabilities(capabilities = []) {
  const set = new Set(capabilities.filter((item) => typeof item === "string"));
  if (set.has("*")) return null;
  if (set.has("chat.completion") && set.size === 1) {
    return RUNTIME_TIERS.LIGHTWEIGHT_TEXT;
  }
  if ([...set].some((item) => /image|vision|file|research/i.test(item))) {
    return RUNTIME_TIERS.BROWSER_CAPABILITY;
  }
  return null;
}

export function inferWorkerRuntimeTier(worker = {}) {
  return (
    normalizeTier(worker.runtime_tier) ||
    normalizeTier(worker?.metadata?.runtime_tier) ||
    inferTierFromCapabilities(worker.capabilities) ||
    RUNTIME_TIERS.BROWSER_CAPABILITY
  );
}

export function inferWorkerIntegrationClass(worker = {}) {
  return (
    normalizeIntegrationClass(worker.integration_class) ||
    normalizeIntegrationClass(worker?.metadata?.integration_class) ||
    (inferWorkerRuntimeTier(worker) === RUNTIME_TIERS.LIGHTWEIGHT_TEXT
      ? INTEGRATION_CLASSES.LIGHTWEIGHT_TEXT_BOUNDARY
      : INTEGRATION_CLASSES.EXTERNAL_WORKER_SHIM)
  );
}

export function inferJobRoutingProfile(jobInput = {}) {
  const type = typeof jobInput.type === "string" ? jobInput.type.trim() : "";
  const capability = typeof jobInput.capability === "string" ? jobInput.capability.trim() : "";
  const payload = jobInput?.payload && typeof jobInput.payload === "object" ? jobInput.payload : {};
  const routeKey = capability || type;

  if (/research/i.test(routeKey)) {
    return {
      route_family: "research",
      requested_runtime_tier: RUNTIME_TIERS.LONG_RUNNING,
      reason: "long_running_research",
    };
  }

  if (/image|vision|file/i.test(routeKey)) {
    return {
      route_family: "browser_capability",
      requested_runtime_tier: RUNTIME_TIERS.BROWSER_CAPABILITY,
      reason: "browser_bound_capability",
    };
  }

  if (routeKey === "chat.completion") {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const browserBound = hasFiles(payload) || hasTooling(payload) || hasRichMessageContent(messages);
    return browserBound
      ? {
          route_family: "browser_capability",
          requested_runtime_tier: RUNTIME_TIERS.BROWSER_CAPABILITY,
          reason: "browser_bound_chat",
        }
      : {
          route_family: "ordinary_text",
          requested_runtime_tier: RUNTIME_TIERS.LIGHTWEIGHT_TEXT,
          reason: "ordinary_text_chat",
        };
  }

  return {
    route_family: "generic",
    requested_runtime_tier: null,
    reason: "capability_default",
  };
}

function tierDistance(workerTier, requestedTier) {
  if (!requestedTier) return 0;
  if (workerTier === requestedTier) return 0;
  if (requestedTier === RUNTIME_TIERS.LIGHTWEIGHT_TEXT) {
    return workerTier === RUNTIME_TIERS.BROWSER_CAPABILITY ? 1 : 2;
  }
  if (requestedTier === RUNTIME_TIERS.BROWSER_CAPABILITY) {
    return workerTier === RUNTIME_TIERS.LIGHTWEIGHT_TEXT ? 1 : 2;
  }
  return 1;
}

export function compareWorkersForJob(left, right, routingProfile = {}) {
  const requestedTier = routingProfile?.requested_runtime_tier || null;
  const tierCompare = tierDistance(left.runtime_tier, requestedTier) - tierDistance(right.runtime_tier, requestedTier);
  if (tierCompare !== 0) return tierCompare;

  if (right.priority !== left.priority) {
    return right.priority - left.priority;
  }

  return String(left.id).localeCompare(String(right.id));
}
