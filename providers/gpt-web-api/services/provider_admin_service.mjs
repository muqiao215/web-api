export function createProviderAdminService({
  providerRouter,
  inspectBrowserReadiness,
  inspectRuntimeStatus,
  getQueueDepth,
  getQueueStats = () => ({ pending: null, running: null, total: null }),
  getSessionLockCount,
  jobsPath,
  sessionAffinityPath,
  mediaPath,
  outputDir,
  uploadDir,
  cdpHttp,
  // Phase 4: optional pool integrations — backward-compatible (null when not wired yet)
  providerPool = null,
  proxyPool = null,
  getCenterRoutingSummary = null,
  // Phase 5A: optional path check — receives a string path, returns { writable: bool, error?: string }
  checkPathWritability = null,
}) {
  function queueMetrics() {
    const stats = getQueueStats() || {};
    return {
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      pending: Number.isInteger(stats.pending) ? stats.pending : null,
      running: Number.isInteger(stats.running) ? stats.running : null,
      total: Number.isInteger(stats.total) ? stats.total : null,
      // Phase 4: account pool — these require provider_pool package
      account_id: null,
      profile_lock: null,
      lease: null,
    };
  }

  function getModel(modelId) {
    const model = providerRouter.getModel(modelId);
    if (!model) return null;
    const provider = providerRouter.getProviderByModel(modelId);
    const descriptor = provider.descriptor();
    return {
      ...model,
      provider_name: descriptor.name,
      provider_type: descriptor.type,
      runtime_tier: descriptor.runtime_tier ?? null,
      integration_class: descriptor.integration_class ?? null,
      capabilities: descriptor.capabilities,
    };
  }

  async function providerHealth(provider) {
    if (typeof provider.healthCheck === "function") {
      return provider.healthCheck();
    }
    return inspectBrowserReadiness();
  }

  async function providerRuntimeStatus(provider) {
    if (typeof provider.runtimeStatus === "function") {
      return provider.runtimeStatus();
    }
    return typeof inspectRuntimeStatus === "function" ? inspectRuntimeStatus() : null;
  }

  async function providerTransport(provider) {
    if (typeof provider.transportDetail === "function") {
      return provider.transportDetail();
    }
    return {
      cdp_http: cdpHttp,
    };
  }

  async function getProviderDetail(providerId) {
    const provider = providerRouter.getProvider(providerId);
    const descriptor = provider.descriptor();
    const health = await providerHealth(provider);
    const runtimeContract = await providerRuntimeStatus(provider);
    const detail = {
      ...descriptor,
      models: provider.models().map((model) => model.id),
      model_details: provider.models(),
      runtime_policy: {
        runtime_tier: descriptor.runtime_tier ?? null,
        integration_class: descriptor.integration_class ?? null,
      },
      health,
      runtime: queueMetrics(),
      runtime_contract: runtimeContract,
      paths: {
        jobs: jobsPath,
        session_affinity: sessionAffinityPath,
        media: mediaPath,
        output_dir: outputDir,
        upload_dir: uploadDir,
      },
      transport: await providerTransport(provider),
    };
    // Phase 4: attach pool status when pool packages are wired
    if (providerPool) {
      detail.account_pool = {
        provider: providerPool.getProvider?.() ?? null,
        total_accounts: providerPool.listAccounts?.()?.length ?? 0,
        available_accounts: providerPool.getAvailableAccounts?.()?.length ?? 0,
        leased_accounts: providerPool.getLeasedAccounts?.()?.length ?? 0,
      };
    }
    if (proxyPool) {
      detail.proxy_pool = {
        total_proxies: proxyPool.listProxies?.()?.length ?? 0,
        healthy_proxies: proxyPool.getHealthyProxies?.()?.length ?? 0,
      };
    }
    return detail;
  }

  async function listProviderDetails() {
    return {
      object: "list",
      data: await Promise.all(providerRouter.listProviders().map((provider) => getProviderDetail(provider.id))),
    };
  }

  async function readiness() {
    const browser = await inspectBrowserReadiness();
    const runtimeContract = typeof inspectRuntimeStatus === "function" ? await inspectRuntimeStatus() : null;
    return {
      ok: true,
      service: "gpt_web_api",
      provider_count: providerRouter.count(),
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      browser,
      runtime_contract: runtimeContract,
    };
  }

  async function health() {
    const runtimeContract = typeof inspectRuntimeStatus === "function" ? await inspectRuntimeStatus() : null;
    const result = {
      ok: true,
      service: "gpt_web_api",
      cdp: cdpHttp,
      provider_count: providerRouter.count(),
      providers: providerRouter.listProviderDescriptors().map((item) => ({
        id: item.id,
        type: item.type,
        runtime_tier: item.runtime_tier ?? null,
        integration_class: item.integration_class ?? null,
        capabilities: item.capabilities,
        models: item.models,
        admission: item.admission ?? null,
        route_meta: item.route_meta ?? null,
      })),
      queue_depth: getQueueDepth(),
      session_locks: getSessionLockCount(),
      account_id: null,
      profile_lock: null,
      lease: null,
      jobs_path: jobsPath,
      session_affinity_path: sessionAffinityPath,
      image_output_dir: outputDir,
      upload_dir: uploadDir,
      media_index_path: mediaPath,
      runtime_contract: runtimeContract,
      center_routing_summary: typeof getCenterRoutingSummary === "function" ? getCenterRoutingSummary() : null,
    };
    // Phase 4: attach read-only pool status when pool packages are wired
    if (providerPool) {
      result.account_pool_summary = {
        provider: providerPool.getProvider?.() ?? null,
        total: providerPool.listAccounts?.()?.length ?? 0,
        available: providerPool.getAvailableAccounts?.()?.length ?? 0,
        leased: providerPool.getLeasedAccounts?.()?.length ?? 0,
      };
    }
    if (proxyPool) {
      result.proxy_pool_summary = {
        total: proxyPool.listProxies?.()?.length ?? 0,
        healthy: proxyPool.getHealthyProxies?.()?.length ?? 0,
      };
    }
    // Phase 5A: path writability check
    if (outputDir && typeof checkPathWritability === "function") {
      result.path_checks = result.path_checks || {};
      result.path_checks.output_dir = checkPathWritability(outputDir);
    }
    if (uploadDir && typeof checkPathWritability === "function") {
      result.path_checks = result.path_checks || {};
      result.path_checks.upload_dir = checkPathWritability(uploadDir);
    }
    return result;
  }

  return {
    getModel,
    getProviderDetail,
    listProviderDetails,
    readiness,
    health,
  };
}
