import {
  compareWorkersForJob,
  inferJobRoutingProfile,
  inferWorkerIntegrationClass,
  inferWorkerRuntimeTier,
  RUNTIME_TIERS,
} from "./runtime_tier_policy.mjs";

function readJsonResponse(response, fallbackMessage) {
  return response.text().then((text) => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {
        error: {
          message: fallbackMessage || text,
          raw: text,
        },
      };
    }
  });
}

function normalizeWorker(worker = {}) {
  return {
    id: String(worker.id || ""),
    label: String(worker.label || worker.id || ""),
    enabled: worker.enabled !== false,
    base_url: String(worker.base_url || "").replace(/\/+$/, ""),
    shared_token: typeof worker.shared_token === "string" ? worker.shared_token : "",
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities.filter((item) => typeof item === "string") : [],
    priority: Number.isFinite(worker.priority) ? Number(worker.priority) : 0,
    timeout_ms: Number.isFinite(worker.timeout_ms) ? Number(worker.timeout_ms) : null,
    metadata: worker.metadata && typeof worker.metadata === "object" ? { ...worker.metadata } : {},
    runtime_tier: inferWorkerRuntimeTier(worker),
    integration_class: inferWorkerIntegrationClass(worker),
  };
}

function normalizeRegistry(registry = {}) {
  const workers = Array.isArray(registry.workers) ? registry.workers.map(normalizeWorker).filter((worker) => worker.id && worker.base_url) : [];
  return { workers };
}

function workerSupportsCapability(worker, capability) {
  if (!capability) return true;
  return worker.capabilities.includes(capability) || worker.capabilities.includes("*");
}

function sortWorkers(workers, routingProfile = null) {
  return [...workers].sort((left, right) =>
    routingProfile ? compareWorkersForJob(left, right, routingProfile) : right.priority - left.priority
  );
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: String(error.message || error),
  };
}

function isChatCompletionJob(jobInput = {}) {
  return jobInput.type === "chat.completion" || jobInput.capability === "chat.completion";
}

function isProviderPathUnavailable(error) {
  return error?.status === 404 || error?.status === 405 || error?.status === 501;
}

function createDispatchError(worker, response, payload, fallbackMessage) {
  const error = new Error(payload?.error?.message || fallbackMessage || `Worker ${worker.id} returned ${response.status}`);
  error.status = response.status;
  error.payload = payload;
  return error;
}

export function createCenterJobService({
  jobQueue,
  registry = { workers: [] },
  localFallback = null,
  localNodeId = "bf2025-local",
  fetchImpl = globalThis.fetch,
  defaultTimeoutMs = 30000,
} = {}) {
  if (!jobQueue) {
    throw new Error("jobQueue is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }

  const workerRegistry = normalizeRegistry(registry);

  function listWorkers() {
    return sortWorkers(workerRegistry.workers).map((worker) => ({
      id: worker.id,
      label: worker.label,
      enabled: worker.enabled,
      base_url: worker.base_url,
      capabilities: [...worker.capabilities],
      priority: worker.priority,
      timeout_ms: worker.timeout_ms,
      runtime_tier: worker.runtime_tier,
      integration_class: worker.integration_class,
      metadata: { ...worker.metadata },
    }));
  }

  function selectWorker({ capability = "", worker_id = "" } = {}, routingProfile = null) {
    const candidates = workerRegistry.workers.filter((worker) => worker.enabled);
    if (worker_id) {
      const worker = candidates.find((candidate) => candidate.id === worker_id);
      if (!worker) {
        throw new Error(`Unknown worker: ${worker_id}`);
      }
      if (!workerSupportsCapability(worker, capability)) {
        throw new Error(`Worker ${worker_id} does not support capability: ${capability}`);
      }
      return worker;
    }
    return (
      sortWorkers(
        candidates.filter((worker) => workerSupportsCapability(worker, capability)),
        routingProfile
      )[0] || null
    );
  }

  async function dispatchToLegacyWorker(worker, jobInput) {
    const timeoutMs = worker.timeout_ms || defaultTimeoutMs;
    const response = await fetchImpl(`${worker.base_url}/internal/worker/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wcapi-worker-token": worker.shared_token,
      },
      body: JSON.stringify(jobInput),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = await readJsonResponse(response, "worker returned non-json response");
    if (!response.ok) {
      throw createDispatchError(worker, response, payload, `Worker ${worker.id} returned ${response.status}`);
    }
    return {
      payload,
      southbound_protocol: "legacy_internal_worker_jobs",
    };
  }

  async function dispatchToProviderChat(worker, jobInput) {
    const timeoutMs = worker.timeout_ms || defaultTimeoutMs;
    const payload = jobInput?.payload && typeof jobInput.payload === "object" ? jobInput.payload : {};
    const response = await fetchImpl(`${worker.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(worker.shared_token ? { Authorization: `Bearer ${worker.shared_token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responsePayload = await readJsonResponse(response, "provider returned non-json response");
    if (!response.ok) {
      throw createDispatchError(worker, response, responsePayload, `Provider ${worker.id} returned ${response.status}`);
    }
    return {
      payload: responsePayload,
      southbound_protocol: "provider_chat_completions",
    };
  }

  async function dispatchToWorkerDetailed(worker, jobInput) {
    if (!isChatCompletionJob(jobInput)) {
      return dispatchToLegacyWorker(worker, jobInput);
    }

    try {
      return await dispatchToProviderChat(worker, jobInput);
    } catch (error) {
      if (!isProviderPathUnavailable(error)) {
        throw error;
      }
      const legacyResult = await dispatchToLegacyWorker(worker, jobInput);
      return {
        ...legacyResult,
        provider_first_error: serializeError(error),
      };
    }
  }

  async function dispatchToWorker(worker, jobInput) {
    const result = await dispatchToWorkerDetailed(worker, jobInput);
    return result.payload;
  }

  async function runLocalFallback(jobInput, worker, cause = null, routingProfile = null) {
    if (typeof localFallback !== "function") {
      if (cause) throw cause;
      throw new Error(`No matching worker for capability: ${jobInput.capability || "(none)"}`);
    }
    const output = await localFallback(jobInput);
    return {
      execution: {
        path: "fallback_local",
        worker_id: worker?.id || null,
        fallback_node: localNodeId,
        fallback_runtime_tier: RUNTIME_TIERS.BROWSER_CAPABILITY,
        error: serializeError(cause),
        routing: {
          route_mode: typeof jobInput.route_mode === "string" ? jobInput.route_mode : "auto",
          route_family: routingProfile?.route_family || "generic",
          reason: routingProfile?.reason || "capability_default",
          requested_runtime_tier: routingProfile?.requested_runtime_tier || null,
          selected_runtime_tier: worker?.runtime_tier || null,
          selected_integration_class: worker?.integration_class || null,
          fallback_runtime_tier: RUNTIME_TIERS.BROWSER_CAPABILITY,
        },
      },
      request: {
        type: jobInput.type,
        capability: jobInput.capability || null,
      },
      output,
    };
  }

  async function execute(jobInput) {
    const routingProfile = inferJobRoutingProfile(jobInput);
    const selectedWorker = selectWorker(jobInput, routingProfile);
    if (!selectedWorker) {
      return runLocalFallback(jobInput, null, null, routingProfile);
    }

    try {
      const workerDispatch = await dispatchToWorkerDetailed(selectedWorker, jobInput);
      const workerResponse = workerDispatch.payload;
      return {
        execution: {
          path: "worker",
          worker_id: selectedWorker.id,
          worker_url: selectedWorker.base_url,
          southbound_protocol: workerDispatch.southbound_protocol,
          provider_first_error: workerDispatch.provider_first_error || null,
          routing: {
            route_mode: typeof jobInput.route_mode === "string" ? jobInput.route_mode : "auto",
            route_family: routingProfile.route_family,
            reason: routingProfile.reason,
            requested_runtime_tier: routingProfile.requested_runtime_tier,
            selected_runtime_tier: selectedWorker.runtime_tier,
            selected_integration_class: selectedWorker.integration_class,
          },
        },
        request: {
          type: jobInput.type,
          capability: jobInput.capability || null,
        },
        output:
          workerResponse && typeof workerResponse === "object" && workerResponse.output !== undefined
            ? workerResponse.output
            : workerResponse,
      };
    } catch (error) {
      return runLocalFallback(jobInput, selectedWorker, error, routingProfile);
    }
  }

  async function createJob(input = {}) {
    const type = typeof input.type === "string" ? input.type.trim() : "";
    if (!type) {
      throw new Error("type is required");
    }

    const capability =
      typeof input.capability === "string" && input.capability.trim()
        ? input.capability.trim()
        : type;

    const routingProfile = inferJobRoutingProfile({
      ...input,
      type,
      capability,
    });

    return jobQueue.enqueue(
      type,
      () =>
        execute({
          ...input,
          type,
          capability,
        }),
      {
        capability,
        route_mode: typeof input.route_mode === "string" ? input.route_mode : "auto",
        requested_worker_id: typeof input.worker_id === "string" ? input.worker_id : null,
        requested_runtime_tier: routingProfile.requested_runtime_tier,
        route_family: routingProfile.route_family,
        routing_reason: routingProfile.reason,
      }
    );
  }

  function getRoutingSummary() {
    return {
      enabled: true,
      default_route_mode: "auto",
      text_chat_preferred_tier: RUNTIME_TIERS.LIGHTWEIGHT_TEXT,
      browser_capability_tier: RUNTIME_TIERS.BROWSER_CAPABILITY,
      long_running_tier: RUNTIME_TIERS.LONG_RUNNING,
      workers: listWorkers(),
    };
  }

  return {
    createJob,
    listWorkers,
    getRoutingSummary,
    selectWorker,
    dispatchToWorker,
    dispatchToProviderChat,
    dispatchToLegacyWorker,
  };
}
